use std::collections::VecDeque;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use elpis_client::{ClientConfig, RemoteRunOwner, ResponseEvent, SettlementOutcome};
use elpis_coordinator::{
    CompletionGroup, Coordinator, CoordinatorConfig, RunBinding, RunEffectReporter,
};
use elpis_effects::{EffectIdentity, EffectLedger, EffectLimits, PrepareOutcome};
use elpis_executor::host_call_service::{HostExecLedgerOwner, OwnedHostExecService};
use elpis_executor::host_exec::{
    CapabilityProfile, HOST_EXEC_CAPABILITY, HostExecRequest, HostExecResult, HostExecTermination,
};
use elpis_identity::{CredentialPolicy, IdentityStore, IssuedCredentials, RevocationEvidence};
use elpis_journal::{Journal, JournalLimits};
use elpis_link::{DeferredDispatcher, DispatchGroup, LinkConfig, Session, SessionEvent};
use elpis_protocol::{PROTOCOL_VERSION, Request, Response};
use elpis_python::{HostCallService, PythonRuntime};
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
const CONNECTION: &str = "connection-owned-effect";
const REQUEST_ID: &str = "run-request";
const CONTEXT_ID: &str = "context-1";
const RUN_ID: &str = "run-1";

struct TestAuthority {
    issuer: CertifiedIssuer<'static, KeyPair>,
}

impl TestAuthority {
    fn new() -> Self {
        let key = KeyPair::generate_for(&PKCS_ED25519).unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "Owned Effect Root");
        params.distinguished_name = name;
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
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "owned-effect-executor");
    params.params.distinguished_name = name;
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

fn server_config(authority: &TestAuthority) -> Arc<ServerConfig> {
    let key = KeyPair::generate_for(&PKCS_ED25519).unwrap();
    let mut params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.not_before = date_time_ymd(2025, 1, 1);
    params.not_after = date_time_ymd(2030, 1, 1);
    let certificate = params
        .signed_by(&key, &authority.issuer)
        .unwrap()
        .der()
        .to_vec();
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(authority.der().to_vec()))
        .unwrap();
    let verifier = WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .unwrap();
    Arc::new(
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_client_cert_verifier(verifier)
            .with_single_cert(
                vec![CertificateDer::from(certificate)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap(),
    )
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

fn link_config(port: u16, store: &IdentityStore) -> LinkConfig {
    LinkConfig::new(
        format!("wss://localhost:{port}/link"),
        store,
        Duration::from_secs(5),
        Duration::from_millis(100),
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

fn frame(executor_id: &str, seq: u64, request: Request) -> ServerFrame {
    ServerFrame::Request {
        protocol: PROTOCOL_VERSION,
        executor_id: executor_id.to_owned(),
        boot_epoch: EPOCH.to_owned(),
        connection_id: CONNECTION.to_owned(),
        seq,
        request,
    }
}

fn open_request() -> Request {
    Request::Open {
        protocol: PROTOCOL_VERSION,
        request_id: "open-request".into(),
        context_id: CONTEXT_ID.into(),
        generation: 1,
    }
}

fn run_request(host: &HostExecRequest) -> Request {
    Request::Run {
        protocol: PROTOCOL_VERSION,
        request_id: REQUEST_ID.into(),
        context_id: CONTEXT_ID.into(),
        generation: 1,
        run_id: RUN_ID.into(),
        source: format!(
            "host_call('elpis.host.exec',{}, {})",
            serde_json::to_string(host.argv()).unwrap(),
            serde_json::to_string(host.stdin()).unwrap()
        ),
        preview_max_bytes: elpis_protocol::DEFAULT_PREVIEW_BYTES,
    }
}

fn identity(host: &HostExecRequest) -> EffectIdentity {
    EffectIdentity::new(
        REQUEST_ID,
        CONTEXT_ID,
        1,
        RUN_ID,
        0,
        HOST_EXEC_CAPABILITY,
        host.canonical_bytes(),
    )
    .unwrap()
}

struct OwnedDispatcher {
    coordinator: Coordinator,
    ready: VecDeque<DispatchGroup>,
    submissions: usize,
}

impl OwnedDispatcher {
    fn new(ledger: EffectLedger) -> Self {
        let owner = HostExecLedgerOwner::new(ledger);
        let coordinator = Coordinator::with_host_service_factory(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(1, 8).unwrap(),
            move |binding: &RunBinding, effects: RunEffectReporter| {
                Ok(Box::new(OwnedHostExecService::new(
                    binding,
                    effects,
                    CapabilityProfile::OwnedPermissive,
                    owner.clone(),
                )) as Box<dyn HostCallService>)
            },
        );
        Self {
            coordinator,
            ready: VecDeque::new(),
            submissions: 0,
        }
    }
}

impl DeferredDispatcher for OwnedDispatcher {
    fn submit(&mut self, request: Request) -> Option<DispatchGroup> {
        self.submissions += 1;
        self.coordinator.submit(request).map(dispatch_group)
    }

    fn poll(&mut self) -> Option<DispatchGroup> {
        if self.ready.is_empty() {
            self.ready
                .extend(self.coordinator.poll().into_iter().map(dispatch_group));
        }
        self.ready.pop_front()
    }

    fn has_pending(&self) -> bool {
        self.coordinator.active_run_count() > 0 || !self.ready.is_empty()
    }
}

fn dispatch_group(group: CompletionGroup) -> DispatchGroup {
    match group {
        CompletionGroup::Single(response) => DispatchGroup::Single(response),
        CompletionGroup::Pair(responses) => DispatchGroup::Pair(responses),
    }
}

fn first_server(
    listener: TcpListener,
    config: Arc<ServerConfig>,
    open: Request,
    run: Request,
) -> JoinHandle<(Vec<u8>, Vec<u8>)> {
    thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let stream = tls_stream(config, socket);
        let mut websocket = tungstenite::accept(stream).unwrap();
        let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
        assert_eq!(hello.boot_epoch(), EPOCH);
        websocket
            .send(Message::binary(welcome(&hello).to_json().unwrap()))
            .unwrap();
        websocket
            .send(Message::binary(
                frame(hello.executor_id(), 1, open).to_json().unwrap(),
            ))
            .unwrap();
        let opened = websocket.read().unwrap().into_data().to_vec();
        websocket
            .send(Message::binary(
                frame(hello.executor_id(), 2, run).to_json().unwrap(),
            ))
            .unwrap();
        let discarded = websocket.read().unwrap().into_data().to_vec();
        (opened, discarded)
    })
}

fn replay_server(
    listener: TcpListener,
    config: Arc<ServerConfig>,
    run: Request,
) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let stream = tls_stream(config, socket);
        let mut websocket = tungstenite::accept(stream).unwrap();
        let hello = ClientHello::from_json(&websocket.read().unwrap().into_data()).unwrap();
        assert_eq!(hello.last_committed_server_seq(), 2);
        websocket
            .send(Message::binary(welcome(&hello).to_json().unwrap()))
            .unwrap();
        websocket
            .send(Message::binary(
                frame(hello.executor_id(), 2, run).to_json().unwrap(),
            ))
            .unwrap();
        websocket.read().unwrap().into_data().to_vec()
    })
}

fn drive_completion(
    session: &mut Session,
    journal: &mut Journal,
    dispatcher: &mut OwnedDispatcher,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match session.step(journal, dispatcher).unwrap() {
            SessionEvent::RequestCompleted { server_seq: 2, .. } => return,
            SessionEvent::Idle | SessionEvent::RequestAccepted { server_seq: 2 } => {}
            event => panic!("unexpected completion event {event:?}"),
        }
        assert!(
            Instant::now() < deadline,
            "owned effect completion timed out"
        );
    }
}

fn response(bytes: &[u8]) -> Response {
    match ClientFrame::from_json(bytes).unwrap() {
        ClientFrame::Response { response, .. } => *response,
        ClientFrame::Heartbeat { .. } => panic!("effect response was a heartbeat"),
    }
}

#[derive(Clone, Copy)]
enum Expected {
    Completed,
    Ambiguous,
}

fn run_resend_case(expected: Expected) {
    let temp = TempDir::new().unwrap();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let marker = temp.path().join("effect-marker");
    let host = HostExecRequest::new(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("cat; printf x >> {}", marker.display()),
        ],
        "wire-crossed".into(),
    )
    .unwrap();
    let effects_dir = temp.path().join("effects");
    fs::create_dir(&effects_dir).unwrap();
    fs::set_permissions(&effects_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let effects_path = effects_dir.join("effects.sqlite");
    if matches!(expected, Expected::Ambiguous) {
        let mut effects = EffectLedger::open(&effects_path, EffectLimits::default()).unwrap();
        assert!(matches!(
            effects.prepare(&identity(&host)).unwrap(),
            PrepareOutcome::New(_)
        ));
    }
    let effects = EffectLedger::open(&effects_path, EffectLimits::default()).unwrap();
    let mut dispatcher = OwnedDispatcher::new(effects);

    let journal_dir = temp.path().join("journal");
    fs::create_dir(&journal_dir).unwrap();
    fs::set_permissions(&journal_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let mut journal =
        Journal::open(journal_dir.join("link.sqlite"), JournalLimits::default()).unwrap();
    let authority = TestAuthority::new();
    let store = installed_store(&temp.path().join("identity"), &authority);
    let executor_id = store.metadata().executor_id;
    let run = run_request(&host);
    let mut owner = RemoteRunOwner::new(executor_id, ClientConfig::new(4, 8, 8).unwrap()).unwrap();
    owner.register_run(&run).unwrap();
    owner.detach(REQUEST_ID, "future-1").unwrap();
    assert!(owner.future("future-1").is_some());

    let (first_listener, port) = listener();
    let server = first_server(
        first_listener,
        server_config(&authority),
        open_request(),
        run.clone(),
    );
    let mut session =
        Session::connect(&link_config(port, &store), &store, &journal, EPOCH).unwrap();
    assert_eq!(
        session.step(&mut journal, &mut dispatcher).unwrap(),
        SessionEvent::RequestCompleted {
            server_seq: 1,
            accepted_server_request: true,
        }
    );
    let accepted = session.step(&mut journal, &mut dispatcher).unwrap();
    if accepted
        != (SessionEvent::RequestCompleted {
            server_seq: 2,
            accepted_server_request: true,
        })
    {
        assert_eq!(accepted, SessionEvent::RequestAccepted { server_seq: 2 });
        drive_completion(&mut session, &mut journal, &mut dispatcher);
    }
    let (_, discarded) = server.join().unwrap();
    let stored = journal.request(2).unwrap().unwrap().response.unwrap().bytes;
    assert_eq!(discarded, stored);
    assert_eq!(dispatcher.submissions, 2);
    drop(session);

    let (replay_listener, port) = listener();
    let server = replay_server(replay_listener, server_config(&authority), run.clone());
    let mut session =
        Session::connect(&link_config(port, &store), &store, &journal, EPOCH).unwrap();
    assert_eq!(
        session.step(&mut journal, &mut dispatcher).unwrap(),
        SessionEvent::CompletedResponseResent { server_seq: 2 }
    );
    let replayed = server.join().unwrap();
    assert_eq!(replayed, discarded);
    assert_eq!(dispatcher.submissions, 2);

    let replayed_response = response(&replayed);
    let settlement = match owner.accept_response(replayed_response.clone()).unwrap() {
        ResponseEvent::Settled(settlement) => settlement,
        event => panic!("expected settlement, got {event:?}"),
    };
    assert_eq!(settlement.future_id.as_deref(), Some("future-1"));
    assert!(owner.future("future-1").is_none());
    match expected {
        Expected::Completed => {
            assert!(!settlement.context_fenced);
            let SettlementOutcome::Exact {
                response,
                cancel_response: None,
            } = settlement.outcome
            else {
                panic!("completed effect did not settle exactly")
            };
            assert_eq!(response.completed_effects.len(), 1);
            let completed = &response.completed_effects[0];
            assert_eq!(
                completed.binding.effect_id,
                identity(&host).effect_id().to_hex()
            );
            assert_eq!(completed.binding.capability, HOST_EXEC_CAPABILITY);
            let result =
                HostExecResult::decode_canonical_receipt(&completed.receipt_bytes().unwrap())
                    .unwrap();
            assert_eq!(result.termination(), HostExecTermination::Exited(0));
            assert_eq!(result.stdout(), b"wire-crossed");
            assert_eq!(fs::read(&marker).unwrap(), b"x");
        }
        Expected::Ambiguous => {
            assert!(settlement.context_fenced);
            let SettlementOutcome::EffectAmbiguous { response, .. } = settlement.outcome else {
                panic!("ambiguous effect did not settle as ambiguity")
            };
            let ambiguity = response.ambiguity.unwrap();
            assert_eq!(
                ambiguity.binding.effect_id,
                identity(&host).effect_id().to_hex()
            );
            assert_eq!(ambiguity.binding.capability, HOST_EXEC_CAPABILITY);
            assert_eq!(
                ambiguity.reason,
                elpis_protocol::v2::EffectAmbiguityReason::ExecutorLost
            );
            assert!(ambiguity.may_have_occurred);
            assert!(ambiguity.context_invalidated);
            assert!(!marker.exists());
        }
    }
    assert_eq!(
        owner.accept_response(replayed_response).unwrap(),
        ResponseEvent::Duplicate
    );
}

#[test]
fn completed_owned_effect_resends_exactly_over_mtls_and_settles_once() {
    run_resend_case(Expected::Completed);
}

#[test]
fn ambiguous_owned_effect_resends_exactly_over_mtls_and_fences_once() {
    run_resend_case(Expected::Ambiguous);
}
