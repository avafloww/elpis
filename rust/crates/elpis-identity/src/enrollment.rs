use std::fmt;
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ureq::http::Uri;
use ureq::tls::{Certificate, RootCerts, TlsConfig, TlsProvider};
use zeroize::Zeroizing;

use super::{
    CredentialMetadata, IdentityError, IdentityStore, IssuedCredentials, MAX_CERT_DER_BYTES,
    MAX_CHAIN_CERTIFICATES, MAX_CHAIN_DER_BYTES, MAX_CSR_DER_BYTES, RevocationEvidence,
};

const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_TOKEN_BYTES: usize = 4_096;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1_024;
const MAX_RESPONSE_HEADER_BYTES: usize = 16 * 1_024;
const MAX_RESPONSE_BODY_BYTES: usize = 1_024 * 1_024;
const GLOBAL_TIMEOUT: Duration = Duration::from_secs(60);
const STAGE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct EnrollmentToken(Zeroizing<String>);

impl EnrollmentToken {
    pub fn new(value: String) -> Result<Self, EnrollmentError> {
        let value = Zeroizing::new(value);
        if value.is_empty()
            || value.len() > MAX_TOKEN_BYTES
            || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Err(EnrollmentError::InvalidToken);
        }
        Ok(Self(value))
    }
}

impl fmt::Debug for EnrollmentToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EnrollmentToken([REDACTED])")
    }
}

pub struct EnrollmentClient {
    endpoint: String,
    server_name: String,
    root_sha256: String,
    agent: ureq::Agent,
}

impl fmt::Debug for EnrollmentClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnrollmentClient")
            .field("endpoint", &"[REDACTED]")
            .field("server_name", &"[REDACTED]")
            .field("root_sha256", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl EnrollmentClient {
    pub fn new(endpoint: String, store: &IdentityStore) -> Result<Self, EnrollmentError> {
        validate_endpoint(&endpoint, &store.policy.server_name)?;

        let agent = enrollment_config(&store.policy.root_der).new_agent();

        Ok(Self {
            endpoint,
            server_name: store.policy.server_name.clone(),
            root_sha256: store.policy.root_sha256.clone(),
            agent,
        })
    }

    pub fn enroll(
        self,
        store: &IdentityStore,
        token: EnrollmentToken,
    ) -> Result<CredentialMetadata, EnrollmentError> {
        if self.server_name != store.policy.server_name
            || self.root_sha256 != store.policy.root_sha256
        {
            return Err(EnrollmentError::PolicyMismatch);
        }

        let csr = store.certificate_request()?;
        if csr.as_der().len() > MAX_CSR_DER_BYTES {
            return Err(EnrollmentError::RequestTooLarge);
        }
        let request = EnrollmentRequest {
            protocol: "elpis-enrollment-v1",
            executor_id: store.metadata().executor_id,
            csr_der_hex: hex::encode(csr.as_der()),
        };
        let body = serde_json::to_vec(&request).map_err(|_| EnrollmentError::RequestEncoding)?;
        if body.len() > MAX_REQUEST_BODY_BYTES {
            return Err(EnrollmentError::RequestTooLarge);
        }

        let mut authorization = Zeroizing::new(String::with_capacity(7 + token.0.len()));
        authorization.push_str("Bearer ");
        authorization.push_str(token.0.as_str());
        let mut response = self
            .agent
            .post(&self.endpoint)
            .header("authorization", authorization.as_str())
            .content_type("application/json")
            .send(body.as_slice())
            .map_err(|_| EnrollmentError::Transport)?;
        if response.status() != ureq::http::StatusCode::OK {
            return Err(EnrollmentError::Rejected);
        }
        if response
            .body()
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
        {
            return Err(EnrollmentError::ResponseTooLarge);
        }

        let mut bytes = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(MAX_RESPONSE_BODY_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| EnrollmentError::Transport)?;
        if bytes.len() > MAX_RESPONSE_BODY_BYTES {
            return Err(EnrollmentError::ResponseTooLarge);
        }
        let response: EnrollmentResponse =
            serde_json::from_slice(&bytes).map_err(|_| EnrollmentError::InvalidResponse)?;
        if response.protocol != "elpis-enrollment-v1"
            || response.intermediates_der_hex.len() > MAX_CHAIN_CERTIFICATES
        {
            return Err(EnrollmentError::InvalidResponse);
        }

        let leaf_der = decode_der(&response.leaf_der_hex, MAX_CERT_DER_BYTES)?;
        let mut intermediates_der = Vec::with_capacity(response.intermediates_der_hex.len());
        let mut chain_bytes = 0usize;
        for encoded in response.intermediates_der_hex {
            let der = decode_der(&encoded, MAX_CERT_DER_BYTES)?;
            chain_bytes = chain_bytes
                .checked_add(der.len())
                .ok_or(EnrollmentError::ResponseTooLarge)?;
            if chain_bytes > MAX_CHAIN_DER_BYTES {
                return Err(EnrollmentError::ResponseTooLarge);
            }
            intermediates_der.push(der);
        }
        let revocation = match response.revocation.status {
            RevocationStatus::Good => RevocationEvidence::Good {
                checked_at: unix_time(response.revocation.checked_at_unix)?,
                valid_until: unix_time(response.revocation.valid_until_unix)?,
            },
            RevocationStatus::Revoked => RevocationEvidence::Revoked,
            RevocationStatus::Unknown => RevocationEvidence::Unknown,
        };
        let issued = IssuedCredentials::new(
            leaf_der,
            intermediates_der,
            store.policy.server_name.clone(),
            store.policy.root_sha256.clone(),
            revocation,
        )?;
        store.install_credentials(issued).map_err(Into::into)
    }
}

#[derive(Serialize)]
struct EnrollmentRequest {
    protocol: &'static str,
    executor_id: String,
    csr_der_hex: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentResponse {
    protocol: String,
    leaf_der_hex: String,
    intermediates_der_hex: Vec<String>,
    revocation: EnrollmentRevocation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentRevocation {
    status: RevocationStatus,
    checked_at_unix: u64,
    valid_until_unix: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RevocationStatus {
    Good,
    Revoked,
    Unknown,
}

#[derive(Debug, Error)]
pub enum EnrollmentError {
    #[error("invalid enrollment configuration")]
    InvalidConfiguration,
    #[error("invalid enrollment token")]
    InvalidToken,
    #[error("enrollment policy mismatch")]
    PolicyMismatch,
    #[error("enrollment request encoding failed")]
    RequestEncoding,
    #[error("enrollment request is too large")]
    RequestTooLarge,
    #[error("enrollment transport failed")]
    Transport,
    #[error("enrollment request was rejected")]
    Rejected,
    #[error("enrollment response is too large")]
    ResponseTooLarge,
    #[error("invalid enrollment response")]
    InvalidResponse,
    #[error("enrollment credential validation failed")]
    Credential(#[from] IdentityError),
}

fn enrollment_config(root_der: &[u8]) -> ureq::config::Config {
    let root = Certificate::from_der(root_der).to_owned();
    let tls = TlsConfig::builder()
        .provider(TlsProvider::Rustls)
        .root_certs(RootCerts::Specific(Arc::new(vec![root])))
        .use_sni(true)
        .disable_verification(false)
        .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .build();
    ureq::Agent::config_builder()
        .https_only(true)
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .max_response_header_size(MAX_RESPONSE_HEADER_BYTES)
        .max_idle_connections(0)
        .max_idle_connections_per_host(0)
        .timeout_global(Some(GLOBAL_TIMEOUT))
        .timeout_per_call(Some(GLOBAL_TIMEOUT))
        .timeout_resolve(Some(STAGE_TIMEOUT))
        .timeout_connect(Some(STAGE_TIMEOUT))
        .timeout_send_request(Some(STAGE_TIMEOUT))
        .timeout_send_body(Some(STAGE_TIMEOUT))
        .timeout_recv_response(Some(STAGE_TIMEOUT))
        .timeout_recv_body(Some(STAGE_TIMEOUT))
        .tls_config(tls)
        .build()
}

fn validate_endpoint(endpoint: &str, server_name: &str) -> Result<(), EnrollmentError> {
    if endpoint.is_empty()
        || endpoint.len() > MAX_ENDPOINT_BYTES
        || endpoint.contains('#')
        || endpoint.contains('@')
    {
        return Err(EnrollmentError::InvalidConfiguration);
    }
    let uri: Uri = endpoint
        .parse()
        .map_err(|_| EnrollmentError::InvalidConfiguration)?;
    if uri.scheme_str() != Some("https")
        || !uri
            .host()
            .is_some_and(|host| host.eq_ignore_ascii_case(server_name))
        || uri.query().is_some()
    {
        return Err(EnrollmentError::InvalidConfiguration);
    }
    Ok(())
}

fn decode_der(encoded: &str, max_bytes: usize) -> Result<Vec<u8>, EnrollmentError> {
    if encoded.is_empty() || encoded.len() > max_bytes.saturating_mul(2) {
        return Err(EnrollmentError::ResponseTooLarge);
    }
    hex::decode(encoded).map_err(|_| EnrollmentError::InvalidResponse)
}

fn unix_time(seconds: u64) -> Result<SystemTime, EnrollmentError> {
    UNIX_EPOCH
        .checked_add(Duration::from_secs(seconds))
        .ok_or(EnrollmentError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};

    use rcgen::{
        BasicConstraints, CertificateParams, CertifiedIssuer, DistinguishedName, DnType,
        ExtendedKeyUsagePurpose, IsCa, KeyPair as RcgenKeyPair, KeyUsagePurpose, PKCS_ED25519,
        date_time_ymd,
    };
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::{ServerConfig, ServerConnection, StreamOwned};
    use serde_json::json;

    use super::*;
    use crate::{CredentialPolicy, IdentityError};

    fn test_ca(name: &str) -> CertifiedIssuer<'static, RcgenKeyPair> {
        let key = RcgenKeyPair::generate_for(&PKCS_ED25519).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        let mut distinguished_name = DistinguishedName::new();
        distinguished_name.push(DnType::CommonName, name);
        params.distinguished_name = distinguished_name;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = date_time_ymd(2025, 1, 1);
        params.not_after = date_time_ymd(2035, 1, 1);
        CertifiedIssuer::self_signed(params, key).unwrap()
    }

    fn store_for(path: &std::path::Path, ca: &CertifiedIssuer<'_, RcgenKeyPair>) -> IdentityStore {
        let policy = CredentialPolicy::new(
            "localhost",
            ca.der().to_vec(),
            Duration::from_secs(10 * 366 * 86_400),
        )
        .unwrap();
        IdentityStore::open(path, policy).unwrap()
    }

    fn server_config(
        ca: &CertifiedIssuer<'_, RcgenKeyPair>,
        server_name: &str,
    ) -> Arc<ServerConfig> {
        let key = RcgenKeyPair::generate_for(&PKCS_ED25519).unwrap();
        let mut params = CertificateParams::new(vec![server_name.to_owned()]).unwrap();
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.not_before = date_time_ymd(2025, 1, 1);
        params.not_after = date_time_ymd(2030, 1, 1);
        let certificate = params.signed_by(&key, ca).unwrap().der().to_vec();
        let private_key = PrivatePkcs8KeyDer::from(key.serialize_der());
        let config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(certificate)],
                    PrivateKeyDer::Pkcs8(private_key),
                )
                .unwrap();
        Arc::new(config)
    }

    fn serve_once(config: Arc<ServerConfig>, response: Vec<u8>) -> (String, JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let Ok((socket, _)) = listener.accept() else {
                return Vec::new();
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let Ok(connection) = ServerConnection::new(config) else {
                return Vec::new();
            };
            let mut stream = StreamOwned::new(connection, socket);
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let header_end = loop {
                let Ok(read) = stream.read(&mut buffer) else {
                    return request;
                };
                if read == 0 {
                    return request;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.len() > MAX_REQUEST_BODY_BYTES + MAX_RESPONSE_HEADER_BYTES {
                    return request;
                }
                if let Some(position) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let Ok(read) = stream.read(&mut buffer) else {
                    return request;
                };
                if read == 0 {
                    return request;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let _ = stream.write_all(&response);
            let _ = stream.flush();
            request
        });
        (format!("https://localhost:{port}/enroll"), handle)
    }

    fn http_response(status: &str, body: &[u8], extra_headers: &str) -> Vec<u8> {
        let head = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra_headers}\r\n",
            body.len()
        );
        [head.as_bytes(), body].concat()
    }

    enum ClientLeaf {
        Valid,
        Expired,
        MismatchedKey,
    }

    fn enrollment_body(
        store: &IdentityStore,
        ca: &CertifiedIssuer<'_, RcgenKeyPair>,
        leaf_kind: ClientLeaf,
    ) -> Vec<u8> {
        let key = match leaf_kind {
            ClientLeaf::MismatchedKey => RcgenKeyPair::generate_for(&PKCS_ED25519).unwrap(),
            ClientLeaf::Valid | ClientLeaf::Expired => {
                let private = PrivatePkcs8KeyDer::from(store.key.pkcs8.as_slice());
                RcgenKeyPair::from_pkcs8_der_and_sign_algo(&private, &PKCS_ED25519).unwrap()
            }
        };
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        match leaf_kind {
            ClientLeaf::Expired => {
                params.not_before = date_time_ymd(2020, 1, 1);
                params.not_after = date_time_ymd(2021, 1, 1);
            }
            ClientLeaf::Valid | ClientLeaf::MismatchedKey => {
                params.not_before = date_time_ymd(2025, 1, 1);
                params.not_after = date_time_ymd(2030, 1, 1);
            }
        }
        let leaf = params.signed_by(&key, ca).unwrap().der().to_vec();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        serde_json::to_vec(&json!({
            "protocol": "elpis-enrollment-v1",
            "leaf_der_hex": hex::encode(leaf),
            "intermediates_der_hex": [],
            "revocation": {
                "status": "good",
                "checked_at_unix": now,
                "valid_until_unix": now + 3600
            }
        }))
        .unwrap()
    }

    fn token() -> EnrollmentToken {
        EnrollmentToken::new("fixture-token".to_owned()).unwrap()
    }

    #[test]
    fn correct_root_name_and_token_install_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca("Enrollment Root");
        let store = store_for(&temp.path().join("identity"), &ca);
        let body = enrollment_body(&store, &ca, ClientLeaf::Valid);
        let (endpoint, server) = serve_once(
            server_config(&ca, "localhost"),
            http_response("200 OK", &body, ""),
        );
        let client = EnrollmentClient::new(endpoint, &store).unwrap();
        let metadata = client.enroll(&store, token()).unwrap();
        assert_eq!(store.credential_metadata().unwrap(), Some(metadata));

        let request = server.join().unwrap();
        let rendered = String::from_utf8_lossy(&request).to_ascii_lowercase();
        assert!(rendered.contains("authorization: bearer fixture-token\r\n"));
        assert!(rendered.contains("\"protocol\":\"elpis-enrollment-v1\""));
        assert!(rendered.contains(&store.metadata().executor_id));
        for entry in std::fs::read_dir(temp.path().join("identity")).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                assert!(
                    !std::fs::read(path)
                        .unwrap()
                        .windows(b"fixture-token".len())
                        .any(|window| window == b"fixture-token")
                );
            }
        }
    }

    #[test]
    fn wrong_root_and_server_name_fail_before_enrollment_response() {
        let temp = tempfile::tempdir().unwrap();
        let trusted = test_ca("Trusted Root");
        let other = test_ca("Other Root");
        let store = store_for(&temp.path().join("identity"), &trusted);

        let (endpoint, server) = serve_once(
            server_config(&other, "localhost"),
            http_response("200 OK", b"{}", ""),
        );
        assert!(matches!(
            EnrollmentClient::new(endpoint, &store)
                .unwrap()
                .enroll(&store, token()),
            Err(EnrollmentError::Transport)
        ));
        server.join().unwrap();

        let (endpoint, server) = serve_once(
            server_config(&trusted, "wrong.example"),
            http_response("200 OK", b"{}", ""),
        );
        assert!(matches!(
            EnrollmentClient::new(endpoint, &store)
                .unwrap()
                .enroll(&store, token()),
            Err(EnrollmentError::Transport)
        ));
        server.join().unwrap();
        assert_eq!(store.credential_metadata().unwrap(), None);
    }

    #[test]
    fn redirects_and_oversized_responses_are_not_followed_or_read() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca("Enrollment Root");
        let store = store_for(&temp.path().join("identity"), &ca);

        let (endpoint, server) = serve_once(
            server_config(&ca, "localhost"),
            http_response(
                "302 Found",
                b"",
                "location: https://localhost:1/elsewhere\r\n",
            ),
        );
        assert!(matches!(
            EnrollmentClient::new(endpoint, &store)
                .unwrap()
                .enroll(&store, token()),
            Err(EnrollmentError::Rejected)
        ));
        server.join().unwrap();

        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            MAX_RESPONSE_BODY_BYTES + 1
        )
        .into_bytes();
        let (endpoint, server) = serve_once(server_config(&ca, "localhost"), response);
        assert!(matches!(
            EnrollmentClient::new(endpoint, &store)
                .unwrap()
                .enroll(&store, token()),
            Err(EnrollmentError::ResponseTooLarge)
        ));
        server.join().unwrap();
        assert_eq!(store.credential_metadata().unwrap(), None);
    }

    #[test]
    fn expired_and_mismatched_client_certificates_never_activate() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca("Enrollment Root");
        for (index, leaf_kind, expected) in [
            (0, ClientLeaf::Expired, "expired"),
            (1, ClientLeaf::MismatchedKey, "key"),
        ] {
            let store = store_for(&temp.path().join(format!("identity-{index}")), &ca);
            let body = enrollment_body(&store, &ca, leaf_kind);
            let (endpoint, server) = serve_once(
                server_config(&ca, "localhost"),
                http_response("200 OK", &body, ""),
            );
            let error = EnrollmentClient::new(endpoint, &store)
                .unwrap()
                .enroll(&store, token())
                .unwrap_err();
            assert!(matches!(
                (expected, error),
                (
                    "expired",
                    EnrollmentError::Credential(IdentityError::InvalidValidity)
                ) | (
                    "key",
                    EnrollmentError::Credential(IdentityError::KeyMismatch)
                )
            ));
            server.join().unwrap();
            assert_eq!(store.credential_metadata().unwrap(), None);
        }
    }

    #[test]
    fn endpoint_token_and_store_policy_are_bound_and_redacted() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca("Enrollment Root");
        let store = store_for(&temp.path().join("identity"), &ca);
        let config = enrollment_config(&store.policy.root_der);
        assert!(config.https_only());
        assert!(config.proxy().is_none());
        assert_eq!(config.max_redirects(), 0);
        assert!(!config.http_status_as_error());
        assert_eq!(config.max_response_header_size(), MAX_RESPONSE_HEADER_BYTES);
        assert_eq!(config.max_idle_connections(), 0);
        assert_eq!(config.max_idle_connections_per_host(), 0);
        let timeouts = config.timeouts();
        assert_eq!(timeouts.global, Some(GLOBAL_TIMEOUT));
        assert_eq!(timeouts.per_call, Some(GLOBAL_TIMEOUT));
        assert_eq!(timeouts.resolve, Some(STAGE_TIMEOUT));
        assert_eq!(timeouts.connect, Some(STAGE_TIMEOUT));
        assert_eq!(timeouts.send_request, Some(STAGE_TIMEOUT));
        assert_eq!(timeouts.send_body, Some(STAGE_TIMEOUT));
        assert_eq!(timeouts.recv_response, Some(STAGE_TIMEOUT));
        assert_eq!(timeouts.recv_body, Some(STAGE_TIMEOUT));
        let tls = config.tls_config();
        assert_eq!(tls.provider(), TlsProvider::Rustls);
        assert!(tls.client_cert().is_none());
        assert!(tls.use_sni());
        assert!(!tls.disable_verification());
        assert!(matches!(tls.root_certs(), RootCerts::Specific(roots) if roots.len() == 1));

        for endpoint in [
            "http://localhost/enroll",
            "https://127.0.0.1/enroll",
            "https://localhost/enroll?next=1",
            "https://user@localhost/enroll",
        ] {
            assert!(matches!(
                EnrollmentClient::new(endpoint.to_owned(), &store),
                Err(EnrollmentError::InvalidConfiguration)
            ));
        }
        assert!(matches!(
            EnrollmentToken::new("has space".to_owned()),
            Err(EnrollmentError::InvalidToken)
        ));
        let secret = EnrollmentToken::new("do-not-render".to_owned()).unwrap();
        assert_eq!(format!("{secret:?}"), "EnrollmentToken([REDACTED])");

        let other = test_ca("Other Root");
        let other_store = store_for(&temp.path().join("other"), &other);
        let client =
            EnrollmentClient::new("https://localhost:1/enroll".to_owned(), &store).unwrap();
        assert!(matches!(
            client.enroll(&other_store, token()),
            Err(EnrollmentError::PolicyMismatch)
        ));
    }
}
