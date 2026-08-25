//! Local, non-exportable executor identity and mTLS credential storage.
//!
//! The only long-lived signing key is generated and consumed in this crate. Public
//! APIs expose its stable identifier and a PKCS#10 request, never PKCS#8 bytes.

#![forbid(unsafe_code)]

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair as RcgenKeyPair, PKCS_ED25519};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::WebPkiClientVerifier;
use rustls::{ClientConfig, RootCertStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroizing;

const KEY_FILE: &str = "identity-v1.pk8";
const LOCK_FILE: &str = ".identity.lock";
const MANIFEST_FILE: &str = "credential-v1.json";
const EXECUTOR_PREFIX: &str = "elpis-executor-v1-";
const CHAIN_MAGIC: &[u8] = b"ELPIS-CHAIN-V1\0";
pub const MAX_CSR_DER_BYTES: usize = 2_048;
pub const MAX_CERT_DER_BYTES: usize = 128 * 1024;
pub const MAX_CHAIN_DER_BYTES: usize = 512 * 1024;
pub const MAX_CHAIN_CERTIFICATES: usize = 8;
const MAX_SERVER_NAME_BYTES: usize = 253;
const MAX_CLOCK_SKEW: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("identity state I/O failed")]
    Io(#[from] std::io::Error),
    #[error("identity state permissions or file type are unsafe: {0}")]
    UnsafeState(&'static str),
    #[error("local Ed25519 key is invalid")]
    InvalidKey,
    #[error("certificate or CSR exceeds a local size limit")]
    TooLarge,
    #[error("certificate is not canonical DER: {0}")]
    InvalidDer(&'static str),
    #[error("certificate does not contain the local Ed25519 public key")]
    KeyMismatch,
    #[error("certificate is missing the clientAuth extended key usage")]
    MissingClientAuth,
    #[error("certificate validity is unacceptable")]
    InvalidValidity,
    #[error("credential chain is not trusted by the configured root")]
    UntrustedCredential,
    #[error("credential binding does not match local configuration")]
    BindingMismatch,
    #[error("credential revocation status is not current and good")]
    RevocationUncertain,
    #[error("credential store is corrupt or incomplete")]
    CorruptStore,
    #[error("configured TLS server name is invalid")]
    InvalidServerName,
    #[error("TLS client configuration could not be built")]
    TlsConfiguration,
    #[error("system clock precedes the Unix epoch")]
    InvalidClock,
}

/// Public facts derived from a local key. It intentionally has no key material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityMetadata {
    pub version: u32,
    pub executor_id: String,
    pub public_key_sha256: String,
}

/// A bounded, deterministic PKCS#10 request for the local identity.
#[derive(Clone, PartialEq, Eq)]
pub struct CertificateRequest {
    executor_id: String,
    der: Vec<u8>,
}

impl CertificateRequest {
    pub fn executor_id(&self) -> &str {
        &self.executor_id
    }
    pub fn as_der(&self) -> &[u8] {
        &self.der
    }
}

impl fmt::Debug for CertificateRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CertificateRequest")
            .field("executor_id", &self.executor_id)
            .field("der_len", &self.der.len())
            .finish()
    }
}

/// Trust and lifetime limits supplied by local configuration.
#[derive(Clone)]
pub struct CredentialPolicy {
    server_name: String,
    root_der: Vec<u8>,
    root_sha256: String,
    max_lifetime: Duration,
    clock_skew: Duration,
    max_revocation_age: Duration,
}

impl fmt::Debug for CredentialPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialPolicy")
            .field("server_name", &self.server_name)
            .field("root_sha256", &self.root_sha256)
            .field("max_lifetime", &self.max_lifetime)
            .field("clock_skew", &self.clock_skew)
            .field("max_revocation_age", &self.max_revocation_age)
            .finish()
    }
}

impl CredentialPolicy {
    pub fn new(
        server_name: impl Into<String>,
        root_der: Vec<u8>,
        max_lifetime: Duration,
    ) -> Result<Self, IdentityError> {
        let server_name = server_name.into();
        if server_name.len() > MAX_SERVER_NAME_BYTES
            || !matches!(
                ServerName::try_from(server_name.clone()),
                Ok(ServerName::DnsName(_))
            )
        {
            return Err(IdentityError::InvalidServerName);
        }
        if root_der.is_empty() || root_der.len() > MAX_CERT_DER_BYTES || max_lifetime.is_zero() {
            return Err(IdentityError::InvalidValidity);
        }
        parse_certificate(&root_der)?;
        let root_sha256 = sha256_hex(&root_der);
        Ok(Self {
            server_name,
            root_der,
            root_sha256,
            max_lifetime,
            clock_skew: Duration::from_secs(300),
            max_revocation_age: Duration::from_secs(24 * 60 * 60),
        })
    }

    pub fn with_clock_skew(mut self, skew: Duration) -> Result<Self, IdentityError> {
        if skew > MAX_CLOCK_SKEW {
            return Err(IdentityError::InvalidValidity);
        }
        self.clock_skew = skew;
        Ok(self)
    }
    pub fn with_max_revocation_age(mut self, age: Duration) -> Result<Self, IdentityError> {
        if age.is_zero() {
            return Err(IdentityError::RevocationUncertain);
        }
        self.max_revocation_age = age;
        Ok(self)
    }
    pub fn server_name(&self) -> &str {
        &self.server_name
    }
    pub fn root_sha256(&self) -> &str {
        &self.root_sha256
    }
}

/// Enrollment response metadata. Unknown/revoked/stale evidence is always rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevocationEvidence {
    Good {
        checked_at: SystemTime,
        valid_until: SystemTime,
    },
    Revoked,
    Unknown,
}

/// Certificates and authority binding received from an enrollment channel.
/// Certificate bytes are public material; no private-key input is supported.
pub struct IssuedCredentials {
    leaf_der: Vec<u8>,
    intermediates_der: Vec<Vec<u8>>,
    server_name: String,
    root_sha256: String,
    revocation: RevocationEvidence,
}

impl fmt::Debug for IssuedCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IssuedCredentials")
            .field("leaf_len", &self.leaf_der.len())
            .field("intermediate_count", &self.intermediates_der.len())
            .field("server_name", &self.server_name)
            .field("root_sha256", &self.root_sha256)
            .field("revocation", &self.revocation)
            .finish()
    }
}

impl IssuedCredentials {
    pub fn new(
        leaf_der: Vec<u8>,
        intermediates_der: Vec<Vec<u8>>,
        server_name: impl Into<String>,
        root_sha256: impl Into<String>,
        revocation: RevocationEvidence,
    ) -> Result<Self, IdentityError> {
        if leaf_der.len() > MAX_CERT_DER_BYTES
            || intermediates_der.len() > MAX_CHAIN_CERTIFICATES
            || intermediates_der
                .iter()
                .any(|c| c.len() > MAX_CERT_DER_BYTES)
            || intermediates_der.iter().map(Vec::len).sum::<usize>() > MAX_CHAIN_DER_BYTES
        {
            return Err(IdentityError::TooLarge);
        }
        let server_name = server_name.into();
        let root_sha256 = root_sha256.into();
        if server_name.len() > MAX_SERVER_NAME_BYTES
            || !matches!(
                ServerName::try_from(server_name.clone()),
                Ok(ServerName::DnsName(_))
            )
        {
            return Err(IdentityError::InvalidServerName);
        }
        if !valid_digest(&root_sha256) {
            return Err(IdentityError::BindingMismatch);
        }
        Ok(Self {
            leaf_der,
            intermediates_der,
            server_name,
            root_sha256,
            revocation,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialMetadata {
    pub version: u32,
    pub executor_id: String,
    pub server_name: String,
    pub root_sha256: String,
    pub leaf_sha256: String,
    pub chain_sha256: String,
    pub not_before: u64,
    pub not_after: u64,
    pub revocation_checked_at: u64,
    pub revocation_valid_until: u64,
}

struct LocalKey {
    pkcs8: Zeroizing<Vec<u8>>,
    pair: Ed25519KeyPair,
}

impl fmt::Debug for LocalKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LocalKey([REDACTED])")
    }
}

/// Exclusive handle to one private identity directory.
pub struct IdentityStore {
    dir: PathBuf,
    _lock: File,
    key: Arc<LocalKey>,
    identity: IdentityMetadata,
    policy: CredentialPolicy,
}

impl fmt::Debug for IdentityStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IdentityStore")
            .field("dir", &self.dir)
            .field("identity", &self.identity)
            .field("policy", &self.policy)
            .field("key", &"[REDACTED]")
            .finish()
    }
}

impl IdentityStore {
    pub fn open(path: impl AsRef<Path>, policy: CredentialPolicy) -> Result<Self, IdentityError> {
        let dir = path.as_ref().to_path_buf();
        ensure_private_dir(&dir)?;
        let lock = open_secure_file(&dir.join(LOCK_FILE), true)?;
        FileExt::lock_exclusive(&lock)?;
        verify_secure_file(&lock)?;

        let key_path = dir.join(KEY_FILE);
        let pkcs8 = Zeroizing::new(if key_path.exists() {
            read_secure_bounded(&key_path, 16 * 1024)?
        } else {
            let generated = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| IdentityError::InvalidKey)?;
            atomic_write(&dir, KEY_FILE, generated.as_ref())?;
            read_secure_bounded(&key_path, 16 * 1024)?
        });
        let pair = Ed25519KeyPair::from_pkcs8(&pkcs8).map_err(|_| IdentityError::InvalidKey)?;
        let digest = sha256_hex(pair.public_key().as_ref());
        let identity = IdentityMetadata {
            version: 1,
            executor_id: format!("{EXECUTOR_PREFIX}{digest}"),
            public_key_sha256: digest,
        };
        Ok(Self {
            dir,
            _lock: lock,
            key: Arc::new(LocalKey { pkcs8, pair }),
            identity,
            policy,
        })
    }

    pub fn metadata(&self) -> IdentityMetadata {
        self.identity.clone()
    }

    pub fn certificate_request(&self) -> Result<CertificateRequest, IdentityError> {
        let private = PrivatePkcs8KeyDer::from(self.key.pkcs8.as_slice());
        let key = RcgenKeyPair::from_pkcs8_der_and_sign_algo(&private, &PKCS_ED25519)
            .map_err(|_| IdentityError::InvalidKey)?;
        let mut params =
            CertificateParams::new(Vec::<String>::new()).map_err(|_| IdentityError::InvalidKey)?;
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, self.identity.public_key_sha256.clone());
        params.distinguished_name = name;
        let der = params
            .serialize_request(&key)
            .map_err(|_| IdentityError::InvalidKey)?
            .der()
            .to_vec();
        if der.len() > MAX_CSR_DER_BYTES {
            return Err(IdentityError::TooLarge);
        }
        Ok(CertificateRequest {
            executor_id: self.identity.executor_id.clone(),
            der,
        })
    }

    pub fn install_credentials(
        &self,
        issued: IssuedCredentials,
    ) -> Result<CredentialMetadata, IdentityError> {
        if issued.server_name != self.policy.server_name
            || issued.root_sha256 != self.policy.root_sha256
        {
            return Err(IdentityError::BindingMismatch);
        }
        let now = unix_now()?;
        let (checked_at, valid_until) = validate_revocation(
            issued.revocation,
            now,
            self.policy.clock_skew,
            self.policy.max_revocation_age,
        )?;
        let parsed =
            self.validate_certificates(&issued.leaf_der, &issued.intermediates_der, now)?;
        if valid_until > parsed.not_after {
            return Err(IdentityError::RevocationUncertain);
        }
        let chain_bytes = encode_chain(&issued.intermediates_der)?;
        let leaf_sha256 = sha256_hex(&issued.leaf_der);
        let chain_sha256 = sha256_hex(&chain_bytes);
        let leaf_name = format!("leaf-{leaf_sha256}.der");
        let chain_name = format!("chain-{chain_sha256}.der");
        write_immutable(&self.dir, &leaf_name, &issued.leaf_der)?;
        write_immutable(&self.dir, &chain_name, &chain_bytes)?;
        let metadata = CredentialMetadata {
            version: 1,
            executor_id: self.identity.executor_id.clone(),
            server_name: self.policy.server_name.clone(),
            root_sha256: self.policy.root_sha256.clone(),
            leaf_sha256,
            chain_sha256,
            not_before: parsed.not_before,
            not_after: parsed.not_after,
            revocation_checked_at: checked_at,
            revocation_valid_until: valid_until,
        };
        let manifest = serde_json::to_vec(&metadata).map_err(|_| IdentityError::CorruptStore)?;
        atomic_write(&self.dir, MANIFEST_FILE, &manifest)?;
        Ok(metadata)
    }

    pub fn invalidate_credentials(&self) -> Result<bool, IdentityError> {
        let path = self.dir.join(MANIFEST_FILE);
        let removed = match fs::remove_file(path) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        sync_directory(&self.dir)?;
        Ok(removed)
    }

    pub fn credential_metadata(&self) -> Result<Option<CredentialMetadata>, IdentityError> {
        let path = self.dir.join(MANIFEST_FILE);
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let now = unix_now()?;
        let loaded = self.load_credentials(now)?;
        let parsed = self.validate_certificates(&loaded.leaf, &loaded.intermediates, now)?;
        validate_manifest_facts(&loaded.metadata, &parsed)?;
        Ok(Some(loaded.metadata))
    }

    /// Revalidates disk, time, revocation freshness, key binding, and trust before
    /// allowing rustls to receive a private-key clone internally.
    pub fn client_config(&self) -> Result<Arc<ClientConfig>, IdentityError> {
        let now = unix_now()?;
        let loaded = self.load_credentials(now)?;
        let parsed = self.validate_certificates(&loaded.leaf, &loaded.intermediates, now)?;
        validate_manifest_facts(&loaded.metadata, &parsed)?;
        let roots = self.root_store()?;
        let mut chain = Vec::with_capacity(loaded.intermediates.len() + 1);
        chain.push(CertificateDer::from(loaded.leaf));
        chain.extend(loaded.intermediates.into_iter().map(CertificateDer::from));
        let private =
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.pkcs8.as_slice()).clone_key());
        let config = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_client_auth_cert(chain, private)
            .map_err(|_| IdentityError::TlsConfiguration)?;
        Ok(Arc::new(config))
    }

    fn load_credentials(&self, now: u64) -> Result<LoadedCredentials, IdentityError> {
        let raw = read_secure_bounded(&self.dir.join(MANIFEST_FILE), 16 * 1024)?;
        let metadata: CredentialMetadata =
            serde_json::from_slice(&raw).map_err(|_| IdentityError::CorruptStore)?;
        if metadata.version != 1
            || metadata.executor_id != self.identity.executor_id
            || metadata.server_name != self.policy.server_name
            || metadata.root_sha256 != self.policy.root_sha256
        {
            return Err(IdentityError::BindingMismatch);
        }
        if !valid_digest(&metadata.leaf_sha256) || !valid_digest(&metadata.chain_sha256) {
            return Err(IdentityError::CorruptStore);
        }
        if now > metadata.revocation_valid_until
            || metadata.revocation_checked_at > now.saturating_add(self.policy.clock_skew.as_secs())
            || metadata.revocation_valid_until < metadata.revocation_checked_at
            || metadata.revocation_valid_until - metadata.revocation_checked_at
                > self.policy.max_revocation_age.as_secs()
        {
            return Err(IdentityError::RevocationUncertain);
        }
        if now
            > metadata
                .not_after
                .saturating_add(self.policy.clock_skew.as_secs())
            || metadata.not_after < metadata.not_before
        {
            return Err(IdentityError::InvalidValidity);
        }
        let leaf = read_secure_bounded(
            &self.dir.join(format!("leaf-{}.der", metadata.leaf_sha256)),
            MAX_CERT_DER_BYTES,
        )?;
        let chain_raw = read_secure_bounded(
            &self
                .dir
                .join(format!("chain-{}.der", metadata.chain_sha256)),
            MAX_CHAIN_DER_BYTES + 1024,
        )?;
        if sha256_hex(&leaf) != metadata.leaf_sha256
            || sha256_hex(&chain_raw) != metadata.chain_sha256
        {
            return Err(IdentityError::CorruptStore);
        }
        let intermediates = decode_chain(&chain_raw)?;
        Ok(LoadedCredentials {
            metadata,
            leaf,
            intermediates,
        })
    }

    fn validate_certificates(
        &self,
        leaf: &[u8],
        intermediates: &[Vec<u8>],
        now: u64,
    ) -> Result<ParsedCertificate, IdentityError> {
        if leaf.len() > MAX_CERT_DER_BYTES || intermediates.len() > MAX_CHAIN_CERTIFICATES {
            return Err(IdentityError::TooLarge);
        }
        let parsed = parse_certificate(leaf)?;
        for cert in intermediates {
            parse_certificate(cert)?;
        }
        if !parsed.ed25519_spki || parsed.public_key != self.key.pair.public_key().as_ref() {
            return Err(IdentityError::KeyMismatch);
        }
        if !parsed.client_auth {
            return Err(IdentityError::MissingClientAuth);
        }
        let skew = self.policy.clock_skew.as_secs();
        if now.saturating_add(skew) < parsed.not_before
            || now > parsed.not_after.saturating_add(skew)
            || parsed.not_after < parsed.not_before
            || parsed.not_after - parsed.not_before > self.policy.max_lifetime.as_secs()
        {
            return Err(IdentityError::InvalidValidity);
        }

        let roots = self.root_store()?;
        let verifier = WebPkiClientVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|_| IdentityError::UntrustedCredential)?;
        let leaf_der = CertificateDer::from(leaf);
        let chain: Vec<CertificateDer<'_>> = intermediates
            .iter()
            .map(|v| CertificateDer::from(v.as_slice()))
            .collect();
        verifier
            .verify_client_cert(
                &leaf_der,
                &chain,
                UnixTime::since_unix_epoch(Duration::from_secs(now)),
            )
            .map_err(|_| IdentityError::UntrustedCredential)?;
        Ok(parsed)
    }

    fn root_store(&self) -> Result<RootCertStore, IdentityError> {
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(self.policy.root_der.clone()))
            .map_err(|_| IdentityError::UntrustedCredential)?;
        Ok(roots)
    }
}

fn validate_manifest_facts(
    metadata: &CredentialMetadata,
    parsed: &ParsedCertificate,
) -> Result<(), IdentityError> {
    if metadata.not_before != parsed.not_before
        || metadata.not_after != parsed.not_after
        || metadata.revocation_valid_until > parsed.not_after
    {
        return Err(IdentityError::CorruptStore);
    }
    Ok(())
}

fn validate_revocation(
    value: RevocationEvidence,
    now: u64,
    skew: Duration,
    max_age: Duration,
) -> Result<(u64, u64), IdentityError> {
    let RevocationEvidence::Good {
        checked_at,
        valid_until,
    } = value
    else {
        return Err(IdentityError::RevocationUncertain);
    };
    let checked = unix_time(checked_at)?;
    let until = unix_time(valid_until)?;
    if checked > now.saturating_add(skew.as_secs())
        || until < now
        || until < checked
        || until - checked > max_age.as_secs()
    {
        return Err(IdentityError::RevocationUncertain);
    }
    Ok((checked, until))
}

fn ensure_private_dir(path: &Path) -> Result<(), IdentityError> {
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).recursive(true).create(path)?;
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_dir()
        || meta.file_type().is_symlink()
        || meta.mode() & 0o7777 != 0o700
        || meta.uid() != effective_uid()
    {
        return Err(IdentityError::UnsafeState(
            "state directory must be owned, mode 0700, and not a symlink",
        ));
    }
    Ok(())
}

fn effective_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

fn open_secure_file(path: &Path, create: bool) -> Result<File, IdentityError> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    if create {
        options.create(true).mode(0o600);
    }
    let file = options.open(path)?;
    verify_secure_file(&file)?;
    Ok(file)
}

fn verify_secure_file(file: &File) -> Result<(), IdentityError> {
    let meta = file.metadata()?;
    if !meta.file_type().is_file()
        || meta.mode() & 0o7777 != 0o600
        || meta.uid() != effective_uid()
        || meta.nlink() != 1
    {
        return Err(IdentityError::UnsafeState(
            "state file must be owned, regular, mode 0600, and singly linked",
        ));
    }
    Ok(())
}

fn read_secure_bounded(path: &Path, max: usize) -> Result<Vec<u8>, IdentityError> {
    let file = open_secure_file(path, false)?;
    if file.metadata()?.len() > max as u64 {
        return Err(IdentityError::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(IdentityError::TooLarge);
    }
    Ok(bytes)
}

fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), IdentityError> {
    if name.contains('/') || name == "." || name == ".." {
        return Err(IdentityError::UnsafeState("invalid state filename"));
    }
    let destination = dir.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(meta) => {
            if !meta.file_type().is_file() || meta.file_type().is_symlink() {
                return Err(IdentityError::UnsafeState(
                    "refusing to replace a non-regular state file",
                ));
            }
            drop(open_secure_file(&destination, false)?);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut temp = None;
    for nonce in 0..128u32 {
        let candidate = dir.join(format!(".tmp-{}-{nonce}", std::process::id()));
        let opened = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&candidate);
        match opened {
            Ok(file) => {
                temp = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    let (temp_path, mut file) = temp.ok_or(IdentityError::UnsafeState(
        "could not allocate atomic state file",
    ))?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        verify_secure_file(&file)?;
        drop(file);
        fs::rename(&temp_path, dir.join(name))?;
        sync_directory(dir)?;
        Ok::<_, IdentityError>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn sync_directory(dir: &Path) -> Result<(), IdentityError> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir)?;
    directory.sync_all()?;
    Ok(())
}

fn write_immutable(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), IdentityError> {
    let path = dir.join(name);
    if path.exists() {
        if read_secure_bounded(&path, bytes.len())? != bytes {
            return Err(IdentityError::CorruptStore);
        }
        return Ok(());
    }
    atomic_write(dir, name, bytes)
}

fn unix_now() -> Result<u64, IdentityError> {
    unix_time(SystemTime::now())
}
fn unix_time(value: SystemTime) -> Result<u64, IdentityError> {
    value
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| IdentityError::InvalidClock)
}
fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn encode_chain(chain: &[Vec<u8>]) -> Result<Vec<u8>, IdentityError> {
    if chain.len() > MAX_CHAIN_CERTIFICATES {
        return Err(IdentityError::TooLarge);
    }
    let mut out = CHAIN_MAGIC.to_vec();
    out.extend_from_slice(&(chain.len() as u32).to_be_bytes());
    for cert in chain {
        if cert.len() > MAX_CERT_DER_BYTES {
            return Err(IdentityError::TooLarge);
        }
        out.extend_from_slice(&(cert.len() as u32).to_be_bytes());
        out.extend_from_slice(cert);
    }
    if out.len() > MAX_CHAIN_DER_BYTES {
        return Err(IdentityError::TooLarge);
    }
    Ok(out)
}
fn decode_chain(raw: &[u8]) -> Result<Vec<Vec<u8>>, IdentityError> {
    if raw.len() < CHAIN_MAGIC.len() + 4 || &raw[..CHAIN_MAGIC.len()] != CHAIN_MAGIC {
        return Err(IdentityError::CorruptStore);
    }
    let mut at = CHAIN_MAGIC.len();
    let count = read_u32(raw, &mut at)? as usize;
    if count > MAX_CHAIN_CERTIFICATES {
        return Err(IdentityError::TooLarge);
    }
    let mut chain = Vec::with_capacity(count);
    for _ in 0..count {
        let len = read_u32(raw, &mut at)? as usize;
        if len > MAX_CERT_DER_BYTES
            || at
                .checked_add(len)
                .filter(|end| *end <= raw.len())
                .is_none()
        {
            return Err(IdentityError::CorruptStore);
        }
        chain.push(raw[at..at + len].to_vec());
        at += len;
    }
    if at != raw.len() {
        return Err(IdentityError::CorruptStore);
    }
    Ok(chain)
}
fn read_u32(raw: &[u8], at: &mut usize) -> Result<u32, IdentityError> {
    let end = at.checked_add(4).ok_or(IdentityError::CorruptStore)?;
    let bytes: [u8; 4] = raw
        .get(*at..end)
        .ok_or(IdentityError::CorruptStore)?
        .try_into()
        .unwrap();
    *at = end;
    Ok(u32::from_be_bytes(bytes))
}

struct LoadedCredentials {
    metadata: CredentialMetadata,
    leaf: Vec<u8>,
    intermediates: Vec<Vec<u8>>,
}

#[derive(Debug)]
struct ParsedCertificate {
    public_key: Vec<u8>,
    ed25519_spki: bool,
    not_before: u64,
    not_after: u64,
    client_auth: bool,
}

fn parse_certificate(der: &[u8]) -> Result<ParsedCertificate, IdentityError> {
    use x509_parser::{oid_registry::OID_SIG_ED25519, prelude::*};

    if der.is_empty() || der.len() > MAX_CERT_DER_BYTES {
        return Err(IdentityError::TooLarge);
    }
    let (remaining, certificate) =
        parse_x509_certificate(der).map_err(|_| IdentityError::InvalidDer("X.509 parse failed"))?;
    if !remaining.is_empty()
        || certificate.as_raw() != der
        || certificate.version() != X509Version::V3
    {
        return Err(IdentityError::InvalidDer("invalid X.509 certificate"));
    }
    let not_before = u64::try_from(certificate.validity().not_before.timestamp())
        .map_err(|_| IdentityError::InvalidValidity)?;
    let not_after = u64::try_from(certificate.validity().not_after.timestamp())
        .map_err(|_| IdentityError::InvalidValidity)?;
    let extended = certificate
        .extended_key_usage()
        .map_err(|_| IdentityError::InvalidDer("invalid extended key usage"))?;
    let client_auth = extended.is_some_and(|usage| usage.value.client_auth);
    Ok(ParsedCertificate {
        public_key: certificate.public_key().subject_public_key.data.to_vec(),
        ed25519_spki: certificate.public_key().algorithm.algorithm == OID_SIG_ED25519,
        not_before,
        not_after,
        client_auth,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    use rcgen::{
        BasicConstraints, CertifiedIssuer, ExtendedKeyUsagePurpose, IsCa, KeyUsagePurpose,
        PKCS_ECDSA_P256_SHA256, date_time_ymd,
    };

    fn test_ca() -> CertifiedIssuer<'static, RcgenKeyPair> {
        let key = RcgenKeyPair::generate_for(&PKCS_ED25519).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "Elpis Local Test Root");
        params.distinguished_name = name;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = date_time_ymd(2025, 1, 1);
        params.not_after = date_time_ymd(2035, 1, 1);
        CertifiedIssuer::self_signed(params, key).unwrap()
    }

    fn policy(root: &[u8]) -> CredentialPolicy {
        CredentialPolicy::new(
            "executor.example.com",
            root.to_vec(),
            Duration::from_secs(10 * 366 * 86_400),
        )
        .unwrap()
    }

    fn leaf_for(
        store: &IdentityStore,
        issuer: &CertifiedIssuer<'static, RcgenKeyPair>,
        use_local_key: bool,
        include_client_auth: bool,
    ) -> Vec<u8> {
        let key = if use_local_key {
            let private = PrivatePkcs8KeyDer::from(store.key.pkcs8.as_slice());
            RcgenKeyPair::from_pkcs8_der_and_sign_algo(&private, &PKCS_ED25519).unwrap()
        } else {
            RcgenKeyPair::generate_for(&PKCS_ED25519).unwrap()
        };
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "Elpis Local Executor");
        params.distinguished_name = name;
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        if include_client_auth {
            params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        }
        params.not_before = date_time_ymd(2025, 1, 1);
        params.not_after = date_time_ymd(2030, 1, 1);
        params.signed_by(&key, issuer).unwrap().der().to_vec()
    }

    fn issued(
        store: &IdentityStore,
        issuer: &CertifiedIssuer<'static, RcgenKeyPair>,
    ) -> IssuedCredentials {
        let now = SystemTime::now();
        IssuedCredentials::new(
            leaf_for(store, issuer, true, true),
            vec![],
            "executor.example.com",
            store.policy.root_sha256().to_owned(),
            RevocationEvidence::Good {
                checked_at: now.checked_sub(Duration::from_secs(1)).unwrap(),
                valid_until: now.checked_add(Duration::from_secs(3600)).unwrap(),
            },
        )
        .unwrap()
    }

    #[test]
    fn key_csr_and_executor_id_are_stable_without_exporting_private_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca();
        let state = temp.path().join("identity");
        let (first_metadata, first_csr, private) = {
            let store = IdentityStore::open(&state, policy(ca.der())).unwrap();
            let csr = store.certificate_request().unwrap();
            assert_eq!(csr, store.certificate_request().unwrap());
            assert!(csr.as_der().len() <= MAX_CSR_DER_BYTES);
            assert!(
                !csr.as_der()
                    .windows(store.key.pkcs8.len())
                    .any(|window| window == store.key.pkcs8.as_slice())
            );
            (
                store.metadata(),
                csr.as_der().to_vec(),
                store.key.pkcs8.to_vec(),
            )
        };
        let store = IdentityStore::open(&state, policy(ca.der())).unwrap();
        assert_eq!(store.metadata(), first_metadata);
        assert_eq!(store.certificate_request().unwrap().as_der(), first_csr);
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(state.join(KEY_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fs::read(state.join(KEY_FILE)).unwrap(), private);
        let debug = format!("{store:?}");
        assert!(!debug.contains(&hex::encode(private)));
    }

    #[test]
    fn symlinked_key_is_never_followed() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("identity");
        fs::create_dir(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        let target = temp.path().join("target");
        fs::write(&target, b"not a key").unwrap();
        symlink(&target, state.join(KEY_FILE)).unwrap();
        let ca = test_ca();
        assert!(IdentityStore::open(&state, policy(ca.der())).is_err());
        assert_eq!(fs::read(target).unwrap(), b"not a key");
    }

    #[test]
    fn credentials_are_bound_persisted_revalidated_and_build_rustls() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca();
        let store = IdentityStore::open(temp.path().join("identity"), policy(ca.der())).unwrap();
        let installed = store.install_credentials(issued(&store, &ca)).unwrap();
        assert_eq!(
            store.credential_metadata().unwrap(),
            Some(installed.clone())
        );
        for name in [
            MANIFEST_FILE.to_owned(),
            format!("leaf-{}.der", installed.leaf_sha256),
            format!("chain-{}.der", installed.chain_sha256),
        ] {
            assert_eq!(
                fs::metadata(store.dir.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
            );
        }
        assert!(Arc::strong_count(&store.client_config().unwrap()) >= 1);
    }

    #[test]
    fn mismatched_key_missing_client_auth_and_unknown_revocation_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca();
        let store = IdentityStore::open(temp.path().join("identity"), policy(ca.der())).unwrap();
        let now = SystemTime::now();
        for (leaf, expected) in [
            (leaf_for(&store, &ca, false, true), "key"),
            (leaf_for(&store, &ca, true, false), "eku"),
        ] {
            let credentials = IssuedCredentials::new(
                leaf,
                vec![],
                "executor.example.com",
                store.policy.root_sha256().to_owned(),
                RevocationEvidence::Good {
                    checked_at: now,
                    valid_until: now.checked_add(Duration::from_secs(60)).unwrap(),
                },
            )
            .unwrap();
            let error = store.install_credentials(credentials).unwrap_err();
            assert!(matches!(
                (expected, error),
                ("key", IdentityError::KeyMismatch) | ("eku", IdentityError::MissingClientAuth)
            ));
        }
        let uncertain = IssuedCredentials::new(
            leaf_for(&store, &ca, true, true),
            vec![],
            "executor.example.com",
            store.policy.root_sha256().to_owned(),
            RevocationEvidence::Unknown,
        )
        .unwrap();
        assert!(matches!(
            store.install_credentials(uncertain),
            Err(IdentityError::RevocationUncertain)
        ));
    }

    #[test]
    fn spki_algorithm_and_clock_skew_are_fail_closed() {
        let ca = test_ca();
        let key = RcgenKeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        params.not_before = date_time_ymd(2025, 1, 1);
        params.not_after = date_time_ymd(2030, 1, 1);
        let der = params.signed_by(&key, &ca).unwrap().der().to_vec();
        assert!(!parse_certificate(&der).unwrap().ed25519_spki);

        assert!(policy(ca.der()).with_clock_skew(MAX_CLOCK_SKEW).is_ok());
        assert!(matches!(
            policy(ca.der()).with_clock_skew(MAX_CLOCK_SKEW + Duration::from_secs(1)),
            Err(IdentityError::InvalidValidity)
        ));
    }

    #[test]
    fn chain_encoding_and_manifest_hashes_detect_corruption() {
        let input = vec![vec![1, 2, 3], vec![4, 5]];
        let encoded = encode_chain(&input).unwrap();
        assert_eq!(decode_chain(&encoded).unwrap(), input);
        let mut trailing = encoded;
        trailing.push(0);
        assert!(decode_chain(&trailing).is_err());

        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca();
        let store = IdentityStore::open(temp.path().join("identity"), policy(ca.der())).unwrap();
        let metadata = store.install_credentials(issued(&store, &ca)).unwrap();
        fs::write(
            store.dir.join(format!("leaf-{}.der", metadata.leaf_sha256)),
            b"tampered",
        )
        .unwrap();
        assert!(matches!(
            store.client_config(),
            Err(IdentityError::CorruptStore | IdentityError::UnsafeState(_))
        ));
    }

    #[test]
    fn orphaned_blobs_are_inert_and_hardlinks_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca();
        let state = temp.path().join("identity");
        let store = IdentityStore::open(&state, policy(ca.der())).unwrap();
        let identity = store.metadata();
        let pending = issued(&store, &ca);
        let chain = encode_chain(&pending.intermediates_der).unwrap();
        let leaf_name = format!("leaf-{}.der", sha256_hex(&pending.leaf_der));
        let chain_name = format!("chain-{}.der", sha256_hex(&chain));
        write_immutable(&state, &leaf_name, &pending.leaf_der).unwrap();
        write_immutable(&state, &chain_name, &chain).unwrap();
        assert_eq!(store.credential_metadata().unwrap(), None);
        assert!(store.client_config().is_err());
        drop(store);

        let key_alias = temp.path().join("key-alias");
        fs::hard_link(state.join(KEY_FILE), &key_alias).unwrap();
        assert!(matches!(
            IdentityStore::open(&state, policy(ca.der())),
            Err(IdentityError::UnsafeState(_))
        ));
        fs::remove_file(key_alias).unwrap();

        let store = IdentityStore::open(&state, policy(ca.der())).unwrap();
        assert_eq!(store.metadata(), identity);
        store.install_credentials(pending).unwrap();
        let manifest_alias = temp.path().join("manifest-alias");
        fs::hard_link(state.join(MANIFEST_FILE), &manifest_alias).unwrap();
        assert!(matches!(
            store.credential_metadata(),
            Err(IdentityError::UnsafeState(_))
        ));
    }

    #[test]
    fn invalidation_disables_credentials_without_rotating_identity() {
        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca();
        let state = temp.path().join("identity");
        let store = IdentityStore::open(&state, policy(ca.der())).unwrap();
        let identity = store.metadata();
        store.install_credentials(issued(&store, &ca)).unwrap();
        assert!(store.invalidate_credentials().unwrap());
        assert!(!store.invalidate_credentials().unwrap());
        assert_eq!(store.credential_metadata().unwrap(), None);
        assert!(store.client_config().is_err());
        drop(store);
        assert_eq!(
            IdentityStore::open(&state, policy(ca.der()))
                .unwrap()
                .metadata(),
            identity
        );
    }

    #[test]
    fn unsafe_state_and_dangling_manifest_are_rejected_without_repair() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let ca = test_ca();
        let unsafe_dir = temp.path().join("unsafe");
        fs::create_dir(&unsafe_dir).unwrap();
        fs::set_permissions(&unsafe_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            IdentityStore::open(&unsafe_dir, policy(ca.der())),
            Err(IdentityError::UnsafeState(_))
        ));
        assert_eq!(
            fs::metadata(&unsafe_dir).unwrap().permissions().mode() & 0o777,
            0o755
        );

        let state = temp.path().join("identity");
        {
            let store = IdentityStore::open(&state, policy(ca.der())).unwrap();
            symlink("missing-manifest", state.join(MANIFEST_FILE)).unwrap();
            assert!(store.credential_metadata().is_err());
        }
        fs::remove_file(state.join(MANIFEST_FILE)).unwrap();
        fs::set_permissions(state.join(KEY_FILE), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            IdentityStore::open(&state, policy(ca.der())),
            Err(IdentityError::UnsafeState(_))
        ));
        assert_eq!(
            fs::metadata(state.join(KEY_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );

        let secure_state = temp.path().join("secure");
        let store = IdentityStore::open(&secure_state, policy(ca.der())).unwrap();
        store.install_credentials(issued(&store, &ca)).unwrap();
        let manifest = secure_state.join(MANIFEST_FILE);
        fs::set_permissions(&manifest, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            store.install_credentials(issued(&store, &ca)),
            Err(IdentityError::UnsafeState(_))
        ));
        assert_eq!(
            fs::metadata(manifest).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn dns_hash_trust_and_validity_bindings_fail_closed() {
        let ca = test_ca();
        assert!(matches!(
            CredentialPolicy::new("127.0.0.1", ca.der().to_vec(), Duration::from_secs(60)),
            Err(IdentityError::InvalidServerName)
        ));
        assert!(matches!(
            IssuedCredentials::new(
                vec![1],
                vec![],
                "executor.example.com",
                "not-a-hash",
                RevocationEvidence::Unknown,
            ),
            Err(IdentityError::BindingMismatch)
        ));

        let temp = tempfile::tempdir().unwrap();
        let store = IdentityStore::open(temp.path().join("identity"), policy(ca.der())).unwrap();
        let other_ca = test_ca();
        let wrong_root = IssuedCredentials::new(
            leaf_for(&store, &other_ca, true, true),
            vec![],
            "executor.example.com",
            store.policy.root_sha256().to_owned(),
            RevocationEvidence::Good {
                checked_at: SystemTime::now(),
                valid_until: SystemTime::now()
                    .checked_add(Duration::from_secs(60))
                    .unwrap(),
            },
        )
        .unwrap();
        assert!(matches!(
            store.install_credentials(wrong_root),
            Err(IdentityError::UntrustedCredential)
        ));

        let private = PrivatePkcs8KeyDer::from(store.key.pkcs8.as_slice());
        let key = RcgenKeyPair::from_pkcs8_der_and_sign_algo(&private, &PKCS_ED25519).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        params.not_before = date_time_ymd(2020, 1, 1);
        params.not_after = date_time_ymd(2021, 1, 1);
        let expired = IssuedCredentials::new(
            params.signed_by(&key, &ca).unwrap().der().to_vec(),
            vec![],
            "executor.example.com",
            store.policy.root_sha256().to_owned(),
            RevocationEvidence::Good {
                checked_at: SystemTime::now(),
                valid_until: SystemTime::now()
                    .checked_add(Duration::from_secs(60))
                    .unwrap(),
            },
        )
        .unwrap();
        assert!(matches!(
            store.install_credentials(expired),
            Err(IdentityError::InvalidValidity)
        ));
    }

    #[test]
    fn local_key_debug_is_redacted_and_zeroizing_storage_is_used() {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let key = LocalKey {
            pkcs8: Zeroizing::new(pkcs8.as_ref().to_vec()),
            pair,
        };
        let debug = format!("{key:?}");
        assert_eq!(debug, "LocalKey([REDACTED])");
        assert!(!debug.contains(&hex::encode(key.pkcs8.as_slice())));
    }
}
