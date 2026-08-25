use std::fs;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

use elpis_identity::{CredentialPolicy, IdentityStore, IssuedCredentials, RevocationEvidence};
use elpis_journal::{Journal, JournalLimits};
use elpis_link::{LinkConfig, LinkError, Session, SessionEvent};
use elpis_protocol::{MAX_FRAME_BYTES, PROTOCOL_VERSION, Request, Response};
use elpis_transport::{ClientFrame, ClientHello, ServerFrame, ServerWelcome};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateSigningRequestParams, CertifiedIssuer,
    DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose,
    PKCS_ED25519, date_time_ymd,
};
use rustls::pki_types::{
    CertificateDer, CertificateSigningRequestDer, PrivateKeyDer, PrivatePkcs8KeyDer,
};
use rustls::server::WebPkiClientVerifier;
use rustls::{RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use tempfile::TempDir;
use tungstenite::protocol::Message;

const EPOCH: &str = "00112233445566778899aabbccddeeff";
const CONNECTION: &str = "connection-1";

struct TestAuthority {
    issuer: CertifiedIssuer<'static, KeyPair>,
}

impl TestAuthority {
    fn new(name: &str) -> Self {
        let key = KeyPair::generate_for(&PKCS_ED25519).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        let mut distinguished_name = DistinguishedName::new();
        distinguished_name.push(DnType::CommonName, name);
        params.distinguished_name = distinguished_name;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = date_time_ymd(2025, 1, 1);
        params.not_after = date_time_ymd(2035, 1, 1);
        Self {
            issuer: CertifiedIssuer::self_signed(params, key).unwrap(),
        }
    }

    fn der(&self) -> &[u8] {
        self.issuer.der()
    }
}

fn installed_store(path: &Path, authority: &TestAuthority) -> IdentityStore {
    let policy = CredentialPolicy::new(
        "localhost",
        authority.der().to_vec(),
        Duration::from_secs(10 * 366 * 86_400),
    )
    .unwrap();
    let root_sha256 = policy.root_sha256().to_owned();
    let store = IdentityStore::open(path, policy).unwrap();
    let request = store.certificate_request().unwrap();
    let request_der = CertificateSigningRequestDer::from(request.as_der());
    let mut params = CertificateSigningRequestParams::from_der(&request_der).unwrap();
    params.params.is_ca = IsCa::ExplicitNoCa;
    params.params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    params.params.not_before = date_time_ymd(2025, 1, 1);
    params.params.not_after = date_time_ymd(2030, 1, 1);
    let leaf = params.signed_by(&authority.issuer).unwrap().der().to_vec();
    let now = SystemTime::now();
    store
        .install_credentials(
            IssuedCredentials::new(
                leaf,
                vec![],
                "localhost",
                root_sha256,
                RevocationEvidence::Good {
                    checked_at: now.checked_sub(Duration::from_secs(1)).unwrap(),
                    valid_until: now.checked_add(Duration::from_secs(3600)).unwrap(),
                },
            )
            .unwrap(),
        )
        .unwrap();
    store
}

fn uninstalled_store(path: &Path, authority: &TestAuthority) -> IdentityStore {
    let policy = CredentialPolicy::new(
        "localhost",
        authority.der().to_vec(),
        Duration::from_secs(10 * 366 * 86_400),
    )
    .unwrap();
    IdentityStore::open(path, policy).unwrap()
}

fn server_config(
    server_authority: &TestAuthority,
    server_name: &str,
    client_authority: &TestAuthority,
) -> Arc<ServerConfig> {
    let key = KeyPair::generate_for(&PKCS_ED25519).unwrap();
    let mut params = CertificateParams::new(vec![server_name.to_owned()]).unwrap();
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = date_time_ymd(2025, 1, 1);
    params.not_after = date_time_ymd(2030, 1, 1);
    let certificate = params
        .signed_by(&key, &server_authority.issuer)
        .unwrap()
        .der()
        .to_vec();
    let mut client_roots = RootCertStore::empty();
    client_roots
        .add(CertificateDer::from(client_authority.der().to_vec()))
        .unwrap();
    let verifier = WebPkiClientVerifier::builder(Arc::new(client_roots))
        .build()
        .unwrap();
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_client_cert_verifier(verifier)
            .with_single_cert(
                vec![CertificateDer::from(certificate)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
    Arc::new(config)
}

fn listener() -> (TcpListener, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

fn tls_stream(
    config: Arc<ServerConfig>,
    socket: TcpStream,
) -> StreamOwned<ServerConnection, TcpStream> {
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    StreamOwned::new(ServerConnection::new(config).unwrap(), socket)
}

fn journal(temp: &TempDir) -> Journal {
    use std::os::unix::fs::PermissionsExt;
    let state = temp.path().join("journal");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    Journal::open(state.join("link.sqlite"), JournalLimits::default()).unwrap()
}

fn link_config(port: u16, store: &IdentityStore) -> LinkConfig {
    LinkConfig::new(
        format!("wss://localhost:{port}/link"),
        store,
        Duration::from_secs(5),
        Duration::from_millis(500),
    )
    .unwrap()
}

fn welcome(hello: &ClientHello) -> ServerWelcome {
    ServerWelcome::Welcome {
        protocol: PROTOCOL_VERSION,
        executor_id: hello.executor_id().to_owned(),
        boot_epoch: hello.boot_epoch().to_owned(),
        connection_id: CONNECTION.to_owned(),
        next_server_seq: hello.last_committed_server_seq() + 1,
    }
}

fn request(executor_id: &str, seq: u64) -> ServerFrame {
    ServerFrame::Request {
        protocol: PROTOCOL_VERSION,
        executor_id: executor_id.to_owned(),
        boot_epoch: EPOCH.to_owned(),
        connection_id: CONNECTION.to_owned(),
        seq,
        request: Request::Validate {
            protocol: PROTOCOL_VERSION,
            request_id: format!("request-{seq}"),
            source: "40 + 2".to_owned(),
        },
    }
}

fn heartbeat(executor_id: &str, seq: u64) -> ServerFrame {
    ServerFrame::Heartbeat {
        protocol: PROTOCOL_VERSION,
        executor_id: executor_id.to_owned(),
        boot_epoch: EPOCH.to_owned(),
        connection_id: CONNECTION.to_owned(),
        seq,
    }
}

#[test]
fn request_heartbeats_and_exact_completed_resend_cross_real_mtls_websocket() {
    let temp = TempDir::new().unwrap();
    let authority = TestAuthority::new("Link Root");
    let store = installed_store(&temp.path().join("identity"), &authority);
    let metadata = store.metadata();
    let (listener, port) = listener();
    let config = server_config(&authority, "localhost", &authority);
    let server: JoinHandle<(Vec<u8>, Vec<u8>)> = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let stream = tls_stream(config, socket);
        let mut websocket = tungstenite::accept(stream).unwrap();
        let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
        websocket
            .send(Message::binary(welcome(&hello).to_json().unwrap()))
            .unwrap();
        let first = request(hello.executor_id(), 1);
        websocket
            .send(Message::binary(first.to_json().unwrap()))
            .unwrap();
        let response = websocket.read().unwrap().into_data().to_vec();
        let parsed = ClientFrame::from_json(&response).unwrap();
        assert!(matches!(
            parsed,
            ClientFrame::Response {
                seq: 1,
                request_seq: 1,
                ..
            }
        ));

        websocket
            .send(Message::binary(
                heartbeat(hello.executor_id(), 2).to_json().unwrap(),
            ))
            .unwrap();
        let client_heartbeat = websocket.read().unwrap().into_data().to_vec();
        let parsed = ClientFrame::from_json(&client_heartbeat).unwrap();
        assert!(matches!(
            parsed,
            ClientFrame::Heartbeat {
                seq: 2,
                observed_server_seq: 2,
                ..
            }
        ));

        websocket
            .send(Message::binary(first.to_json().unwrap()))
            .unwrap();
        let resent = websocket.read().unwrap().into_data().to_vec();
        websocket.close(None).unwrap();
        (response, resent)
    });

    let config = link_config(port, &store);
    let mut journal = journal(&temp);
    let mut session = Session::connect(&config, &store, &journal, EPOCH).unwrap();
    let mut dispatches = 0;
    let mut dispatcher = |request: Request| {
        dispatches += 1;
        Response::success(
            request.request_id().to_owned(),
            "validated",
            serde_json::json!({}),
        )
    };
    assert_eq!(
        session.step(&mut journal, &mut dispatcher).unwrap(),
        SessionEvent::RequestCompleted { server_seq: 1 }
    );
    assert_eq!(
        session.step(&mut journal, &mut dispatcher).unwrap(),
        SessionEvent::ServerHeartbeat { server_seq: 2 }
    );
    session.send_heartbeat(&mut journal).unwrap();
    assert_eq!(
        session.step(&mut journal, &mut dispatcher).unwrap(),
        SessionEvent::CompletedResponseResent { server_seq: 1 }
    );
    assert!(matches!(
        session.step(&mut journal, &mut dispatcher).unwrap(),
        SessionEvent::Closed
    ));
    assert_eq!(dispatches, 1);
    assert_eq!(metadata.executor_id, session.checkpoint().executor_id);
    let (response, resent) = server.join().unwrap();
    assert_eq!(response, resent);
}

fn handshake_server(config: Arc<ServerConfig>, listener: TcpListener) -> JoinHandle<()> {
    thread::spawn(move || {
        let Ok((socket, _)) = listener.accept() else {
            return;
        };
        let stream = tls_stream(config, socket);
        let _ = tungstenite::accept(stream);
    })
}

#[test]
fn wrong_server_ca_name_and_client_trust_fail_closed() {
    let temp = TempDir::new().unwrap();
    let trusted = TestAuthority::new("Trusted Root");
    let other = TestAuthority::new("Other Root");
    let store = installed_store(&temp.path().join("identity"), &trusted);

    for (index, server_authority, server_name, client_authority) in [
        (0, &other, "localhost", &trusted),
        (1, &trusted, "wrong.example", &trusted),
        (2, &trusted, "localhost", &other),
    ] {
        let (listener, port) = listener();
        let server = handshake_server(
            server_config(server_authority, server_name, client_authority),
            listener,
        );
        let journal_temp = TempDir::new().unwrap();
        let journal = journal(&journal_temp);
        assert!(
            matches!(
                Session::connect(&link_config(port, &store), &store, &journal, EPOCH),
                Err(LinkError::Handshake | LinkError::Transport)
            ),
            "case {index}"
        );
        server.join().unwrap();
    }
}

#[test]
fn absent_client_credentials_fail_before_any_network_connection() {
    let temp = TempDir::new().unwrap();
    let authority = TestAuthority::new("Link Root");
    let store = uninstalled_store(&temp.path().join("identity"), &authority);
    let journal = journal(&temp);
    assert!(matches!(
        Session::connect(&link_config(9, &store), &store, &journal, EPOCH),
        Err(LinkError::Identity)
    ));
}

#[test]
fn endpoint_and_journal_binding_preflight_fail_before_network() {
    let temp = TempDir::new().unwrap();
    let authority = TestAuthority::new("Link Root");
    let store = installed_store(&temp.path().join("identity"), &authority);
    for endpoint in [
        "ws://localhost:443/link",
        "wss://wrong.example:443/link",
        "wss://localhost:443/link?mode=broker",
        "wss://user@localhost:443/link",
    ] {
        assert!(matches!(
            LinkConfig::new(
                endpoint,
                &store,
                Duration::from_secs(1),
                Duration::from_secs(1)
            ),
            Err(LinkError::InvalidConfiguration)
        ));
    }
    let valid = LinkConfig::new(
        "wss://LOCALHOST:443/link",
        &store,
        Duration::from_secs(1),
        Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(valid.host(), "localhost");
    assert_eq!(valid.port(), 443);
    assert!(matches!(
        LinkConfig::new(
            "wss://localhost:443/link",
            &store,
            Duration::ZERO,
            Duration::from_secs(1)
        ),
        Err(LinkError::InvalidConfiguration)
    ));

    let mut journal = journal(&temp);
    let mut bound = request(&store.metadata().executor_id, 1);
    let ServerFrame::Request { boot_epoch, .. } = &mut bound else {
        unreachable!()
    };
    *boot_epoch = "ffeeddccbbaa99887766554433221100".to_owned();
    journal.prepare(&bound).unwrap();
    assert!(matches!(
        Session::connect(&link_config(9, &store), &store, &journal, EPOCH),
        Err(LinkError::Journal)
    ));
}

#[test]
fn sequence_gap_and_oversized_frame_never_dispatch_or_advance_journal() {
    for oversized in [false, true] {
        let temp = TempDir::new().unwrap();
        let authority = TestAuthority::new("Link Root");
        let store = installed_store(&temp.path().join("identity"), &authority);
        let (listener, port) = listener();
        let config = server_config(&authority, "localhost", &authority);
        let server = thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let stream = tls_stream(config, socket);
            let mut websocket = tungstenite::accept(stream).unwrap();
            let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
            websocket
                .send(Message::binary(welcome(&hello).to_json().unwrap()))
                .unwrap();
            if oversized {
                let _ = websocket.send(Message::binary(vec![0; MAX_FRAME_BYTES + 1]));
            } else {
                let _ = websocket.send(Message::binary(
                    request(hello.executor_id(), 2).to_json().unwrap(),
                ));
            }
        });
        let mut journal = journal(&temp);
        let mut session =
            Session::connect(&link_config(port, &store), &store, &journal, EPOCH).unwrap();
        let mut dispatches = 0;
        let mut dispatcher = |request: Request| {
            dispatches += 1;
            Response::success(request.request_id().to_owned(), "ok", serde_json::json!({}))
        };
        let result = session.step(&mut journal, &mut dispatcher);
        assert!(matches!(
            (oversized, result),
            (false, Err(LinkError::Fence)) | (true, Err(LinkError::Transport))
        ));
        assert_eq!(dispatches, 0);
        assert_eq!(journal.state().unwrap().last_committed_server_seq, 0);
        server.join().unwrap();
    }
}

#[test]
fn crash_after_prepare_reopens_ambiguous_and_never_reexecutes() {
    let temp = TempDir::new().unwrap();
    let authority = TestAuthority::new("Link Root");
    let store = installed_store(&temp.path().join("identity"), &authority);
    let (first_listener, port) = listener();
    let config = server_config(&authority, "localhost", &authority);
    let server = thread::spawn(move || {
        let (socket, _) = first_listener.accept().unwrap();
        let stream = tls_stream(config, socket);
        let mut websocket = tungstenite::accept(stream).unwrap();
        let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
        websocket
            .send(Message::binary(welcome(&hello).to_json().unwrap()))
            .unwrap();
        websocket
            .send(Message::binary(
                request(hello.executor_id(), 1).to_json().unwrap(),
            ))
            .unwrap();
        let _ = websocket.read();
    });
    let mut journal = journal(&temp);
    let journal_path = journal.path().to_owned();
    let mut session =
        Session::connect(&link_config(port, &store), &store, &journal, EPOCH).unwrap();
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let mut dispatcher = |_request: Request| -> Response { panic!("fixture crash") };
        let _ = session.step(&mut journal, &mut dispatcher);
    }));
    assert!(panic.is_err());
    assert_eq!(
        journal.request(1).unwrap().unwrap().status,
        elpis_journal::RequestStatus::Prepared
    );
    drop(session);
    drop(journal);
    server.join().unwrap();

    let mut reopened = Journal::open(journal_path, JournalLimits::default()).unwrap();
    assert_eq!(
        reopened.request(1).unwrap().unwrap().status,
        elpis_journal::RequestStatus::Ambiguous
    );
    let (listener, port) = listener();
    let config = server_config(&authority, "localhost", &authority);
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let stream = tls_stream(config, socket);
        let mut websocket = tungstenite::accept(stream).unwrap();
        let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
        websocket
            .send(Message::binary(welcome(&hello).to_json().unwrap()))
            .unwrap();
        websocket
            .send(Message::binary(
                request(hello.executor_id(), 1).to_json().unwrap(),
            ))
            .unwrap();
        let _ = websocket.read();
    });
    let mut session =
        Session::connect(&link_config(port, &store), &store, &reopened, EPOCH).unwrap();
    let mut dispatches = 0;
    let mut dispatcher = |request: Request| {
        dispatches += 1;
        Response::success(request.request_id().to_owned(), "ok", serde_json::json!({}))
    };
    assert!(matches!(
        session.step(&mut reopened, &mut dispatcher),
        Err(LinkError::UncertainRequest(1))
    ));
    assert_eq!(dispatches, 0);
    drop(session);
    server.join().unwrap();
}

#[test]
fn completed_send_uncertainty_reconnects_and_resends_exact_bytes_without_effect() {
    let temp = TempDir::new().unwrap();
    let authority = TestAuthority::new("Link Root");
    let store = installed_store(&temp.path().join("identity"), &authority);
    let (first_listener, port) = listener();
    let config = server_config(&authority, "localhost", &authority);
    let first_server = thread::spawn(move || {
        let (socket, _) = first_listener.accept().unwrap();
        let stream = tls_stream(config, socket);
        let mut websocket = tungstenite::accept(stream).unwrap();
        let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
        websocket
            .send(Message::binary(welcome(&hello).to_json().unwrap()))
            .unwrap();
        websocket
            .send(Message::binary(
                request(hello.executor_id(), 1).to_json().unwrap(),
            ))
            .unwrap();
        let socket = websocket.into_inner().sock;
        let _ = socket.shutdown(Shutdown::Both);
    });
    let mut journal = journal(&temp);
    let mut session =
        Session::connect(&link_config(port, &store), &store, &journal, EPOCH).unwrap();
    let dispatches = std::cell::Cell::new(0);
    let mut dispatcher = |request: Request| {
        dispatches.set(dispatches.get() + 1);
        Response::success(request.request_id().to_owned(), "ok", serde_json::json!({}))
    };
    let _ = session.step(&mut journal, &mut dispatcher);
    first_server.join().unwrap();
    assert_eq!(dispatches.get(), 1);
    let stored = journal.request(1).unwrap().unwrap().response.unwrap().bytes;
    drop(session);

    let (listener, port) = listener();
    let config = server_config(&authority, "localhost", &authority);
    let second_server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let stream = tls_stream(config, socket);
        let mut websocket = tungstenite::accept(stream).unwrap();
        let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
        websocket
            .send(Message::binary(welcome(&hello).to_json().unwrap()))
            .unwrap();
        websocket
            .send(Message::binary(
                request(hello.executor_id(), 1).to_json().unwrap(),
            ))
            .unwrap();
        websocket.read().unwrap().into_data().to_vec()
    });
    let mut session =
        Session::connect(&link_config(port, &store), &store, &journal, EPOCH).unwrap();
    let event = session.step(&mut journal, &mut dispatcher).unwrap();
    assert_eq!(
        event,
        SessionEvent::CompletedResponseResent { server_seq: 1 }
    );
    assert_eq!(dispatches.get(), 1);
    assert_eq!(second_server.join().unwrap(), stored);
}
