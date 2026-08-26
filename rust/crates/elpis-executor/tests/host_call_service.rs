use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use elpis_coordinator::{
    CompletionGroup, Coordinator, CoordinatorConfig, RunBinding, RunEffectReporter,
};
use elpis_effects::{
    EffectIdentity, EffectLedger, EffectLimits, EffectStatus, ExecutionToken, PrepareOutcome,
    StoredReceipt,
};
use elpis_executor::host_call_service::{
    HostExecCompletionFailure, HostExecLedger, HostExecLedgerError, HostExecLedgerOwner,
    HostExecRunner, HostExecRunnerOutcome, HostExecService, OwnedHostExecService,
};
use elpis_executor::host_exec::{
    CapabilityProfile, HOST_EXEC_CAPABILITY, HostExecRequest, HostExecResult, HostExecTermination,
    MAX_HOST_EXEC_RECEIPT_BYTES,
};
use elpis_protocol::v2::{EffectAmbiguityReason, MAX_TOTAL_RECEIPT_BYTES};
use elpis_protocol::{DEFAULT_PREVIEW_BYTES, PROTOCOL_VERSION, Request, Response};
use elpis_python::{HostCallService, PythonRuntime};
use tempfile::TempDir;

#[derive(Clone)]
struct FakeRunner {
    calls: Arc<AtomicUsize>,
    result: HostExecResult,
}

impl HostExecRunner for FakeRunner {
    fn run(&mut self, token: ExecutionToken, _request: &HostExecRequest) -> HostExecRunnerOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        HostExecRunnerOutcome::Completed(token, self.result.clone())
    }
}

#[derive(Clone)]
struct AmbiguousRunner {
    calls: Arc<AtomicUsize>,
}

impl HostExecRunner for AmbiguousRunner {
    fn run(&mut self, token: ExecutionToken, _request: &HostExecRequest) -> HostExecRunnerOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        HostExecRunnerOutcome::Ambiguous(token)
    }
}

#[derive(Clone)]
struct SwapRunner {
    calls: Arc<AtomicUsize>,
    wrong_token: Arc<Mutex<Option<ExecutionToken>>>,
    result: HostExecResult,
}

impl HostExecRunner for SwapRunner {
    fn run(&mut self, _token: ExecutionToken, _request: &HostExecRequest) -> HostExecRunnerOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        HostExecRunnerOutcome::Completed(
            self.wrong_token.lock().unwrap().take().unwrap(),
            self.result.clone(),
        )
    }
}

struct RecordingLedger {
    inner: EffectLedger,
    complete_calls: Arc<AtomicUsize>,
    ambiguity_calls: Arc<AtomicUsize>,
}

impl HostExecLedger for RecordingLedger {
    fn prepare(
        &mut self,
        identity: &EffectIdentity,
    ) -> Result<PrepareOutcome, HostExecLedgerError> {
        <EffectLedger as HostExecLedger>::prepare(&mut self.inner, identity)
    }

    fn complete(
        &mut self,
        token: ExecutionToken,
        canonical_receipt_bytes: &[u8],
    ) -> Result<StoredReceipt, HostExecCompletionFailure> {
        self.complete_calls.fetch_add(1, Ordering::SeqCst);
        <EffectLedger as HostExecLedger>::complete(&mut self.inner, token, canonical_receipt_bytes)
    }

    fn mark_ambiguous(&mut self, token: ExecutionToken) -> Result<(), HostExecLedgerError> {
        self.ambiguity_calls.fetch_add(1, Ordering::SeqCst);
        <EffectLedger as HostExecLedger>::mark_ambiguous(&mut self.inner, token)
    }
}

fn coordinator_with_runner<R>(owner: HostExecLedgerOwner, runner: R) -> Coordinator
where
    R: HostExecRunner + Clone + 'static,
{
    Coordinator::with_host_service_factory(
        PythonRuntime::system("python3"),
        CoordinatorConfig::new(1, 8).unwrap(),
        move |binding: &RunBinding, effects: RunEffectReporter| {
            Ok(Box::new(HostExecService::new(
                binding,
                effects,
                CapabilityProfile::OwnedPermissive,
                runner.clone(),
                owner.clone(),
            )) as Box<dyn HostCallService>)
        },
    )
}

fn coordinator(
    owner: HostExecLedgerOwner,
    calls: Arc<AtomicUsize>,
    result: HostExecResult,
) -> Coordinator {
    coordinator_with_runner(owner, FakeRunner { calls, result })
}

fn owned_coordinator(owner: HostExecLedgerOwner) -> Coordinator {
    Coordinator::with_host_service_factory(
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
    )
}

fn open(coordinator: &mut Coordinator) {
    let response = only(coordinator.submit(Request::Open {
        protocol: PROTOCOL_VERSION,
        request_id: "open-1".into(),
        context_id: "context-1".into(),
        generation: 1,
    }));
    assert!(response.ok, "{response:?}");
}

fn run(coordinator: &mut Coordinator, source: &str) -> Response {
    assert!(
        coordinator
            .submit(Request::Run {
                protocol: PROTOCOL_VERSION,
                request_id: "request-1".into(),
                context_id: "context-1".into(),
                generation: 1,
                run_id: "run-1".into(),
                source: source.into(),
                preview_max_bytes: DEFAULT_PREVIEW_BYTES,
            })
            .is_none()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut groups = coordinator.poll();
        if let Some(group) = groups.pop() {
            assert!(groups.is_empty());
            return match group {
                CompletionGroup::Single(response) => *response,
                CompletionGroup::Pair(_) => panic!("unexpected paired completion"),
            };
        }
        assert!(Instant::now() < deadline, "coordinator poll timed out");
        std::thread::yield_now();
    }
}

fn only(group: Option<CompletionGroup>) -> Response {
    match group.unwrap() {
        CompletionGroup::Single(response) => *response,
        CompletionGroup::Pair(_) => panic!("unexpected response pair"),
    }
}

fn db_path(temp: &TempDir) -> std::path::PathBuf {
    temp.path().join("private").join("effects.sqlite")
}

fn ledger(temp: &TempDir) -> EffectLedger {
    EffectLedger::open(db_path(temp), EffectLimits::default()).unwrap()
}

fn current_identity() -> EffectIdentity {
    identity_for(vec!["fake".into()], String::new())
}

fn identity_for(argv: Vec<String>, stdin: String) -> EffectIdentity {
    let request = HostExecRequest::new(argv, stdin).unwrap();
    EffectIdentity::new(
        "request-1",
        "context-1",
        1,
        "run-1",
        0,
        HOST_EXEC_CAPABILITY,
        request.canonical_bytes(),
    )
    .unwrap()
}

fn python_host_call(argv: &[String]) -> String {
    format!(
        "host_call('elpis.host.exec',{})",
        serde_json::to_string(argv).unwrap()
    )
}

fn process_group_exists(pgid: i32) -> bool {
    // SAFETY: signal zero only checks the dedicated test process group.
    let result = unsafe { libc::kill(-pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[test]
fn new_calls_complete_sequentially_and_exact_replay_never_executes_again() {
    let temp = TempDir::new().unwrap();
    let owner = HostExecLedgerOwner::new(ledger(&temp));
    let calls = Arc::new(AtomicUsize::new(0));
    let result = HostExecResult::new(
        HostExecTermination::Exited(0),
        b"exact output".to_vec(),
        Vec::new(),
    )
    .unwrap();
    let source = concat!(
        "a=host_call('elpis.host.exec',['fake','one'])\n",
        "b=host_call('elpis.host.exec',['fake','two'])\n",
        "(a,b)",
    );

    let mut first = coordinator(owner.clone(), calls.clone(), result.clone());
    open(&mut first);
    let completed = run(&mut first, source);
    assert!(completed.ok, "{completed:?}");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(completed.completed_effects.len(), 2);
    assert_eq!(completed.completed_effects[0].binding.call_index, 0);
    assert_eq!(completed.completed_effects[1].binding.call_index, 1);
    let expected = result.canonical_receipt_bytes();
    for receipt in &completed.completed_effects {
        assert_eq!(
            URL_SAFE_NO_PAD.decode(receipt.receipt.as_bytes()).unwrap(),
            expected
        );
    }
    drop(first);

    let mut replay = coordinator(owner.clone(), calls.clone(), result);
    open(&mut replay);
    let replayed = run(&mut replay, source);
    assert!(replayed.ok, "{replayed:?}");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(replayed.completed_effects, completed.completed_effects);
    drop(replay);

    let mut conflict = coordinator(
        owner,
        calls.clone(),
        HostExecResult::new(HostExecTermination::Exited(0), b"unused".to_vec(), vec![]).unwrap(),
    );
    open(&mut conflict);
    let denied = run(&mut conflict, "host_call('elpis.host.exec',['changed'])");
    assert!(!denied.ok);
    assert_eq!(denied.failure_kind.as_deref(), Some("runtime"));
    assert!(denied.completed_effects.is_empty());
    assert!(denied.ambiguity.is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(conflict.context_count(), 1);
}

#[test]
fn recovered_and_live_ambiguous_admissions_use_generic_executor_lost() {
    let temp = TempDir::new().unwrap();
    let path = db_path(&temp);
    let identity = current_identity();
    {
        let mut ledger = EffectLedger::open(&path, EffectLimits::default()).unwrap();
        assert!(matches!(
            ledger.prepare(&identity).unwrap(),
            PrepareOutcome::New(_)
        ));
    }
    let reopened = EffectLedger::open(&path, EffectLimits::default()).unwrap();
    assert_eq!(
        reopened
            .effect(identity.effect_id())
            .unwrap()
            .unwrap()
            .status,
        EffectStatus::Ambiguous
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let mut service = coordinator(
        HostExecLedgerOwner::new(reopened),
        calls.clone(),
        HostExecResult::new(HostExecTermination::Exited(0), vec![], vec![]).unwrap(),
    );
    open(&mut service);
    let response = run(&mut service, "host_call('elpis.host.exec',['fake'])");
    assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
    assert_eq!(
        response.ambiguity.unwrap().reason,
        EffectAmbiguityReason::ExecutorLost
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(service.context_count(), 0);
}

#[derive(Clone, Copy)]
enum DeniedStatus {
    Prepared,
    Ambiguous,
}

struct DeniedStatusLedger(DeniedStatus);

impl HostExecLedger for DeniedStatusLedger {
    fn prepare(
        &mut self,
        _identity: &EffectIdentity,
    ) -> Result<PrepareOutcome, HostExecLedgerError> {
        Ok(match self.0 {
            DeniedStatus::Prepared => PrepareOutcome::Prepared,
            DeniedStatus::Ambiguous => PrepareOutcome::Ambiguous,
        })
    }

    fn complete(
        &mut self,
        _token: ExecutionToken,
        _bytes: &[u8],
    ) -> Result<StoredReceipt, HostExecCompletionFailure> {
        unreachable!()
    }

    fn mark_ambiguous(&mut self, _token: ExecutionToken) -> Result<(), HostExecLedgerError> {
        unreachable!()
    }
}

#[test]
fn prepared_and_ambiguous_admissions_never_reach_runner() {
    for status in [DeniedStatus::Prepared, DeniedStatus::Ambiguous] {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut service = coordinator(
            HostExecLedgerOwner::new(DeniedStatusLedger(status)),
            calls.clone(),
            HostExecResult::new(HostExecTermination::Exited(0), vec![], vec![]).unwrap(),
        );
        open(&mut service);
        let response = run(&mut service, "host_call('elpis.host.exec',['fake'])");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
        assert_eq!(
            response.ambiguity.unwrap().reason,
            EffectAmbiguityReason::ExecutorLost
        );
        assert_eq!(service.context_count(), 0);
    }
}

struct CorruptCompletedLedger {
    receipt: StoredReceipt,
}

impl HostExecLedger for CorruptCompletedLedger {
    fn prepare(
        &mut self,
        _identity: &EffectIdentity,
    ) -> Result<PrepareOutcome, HostExecLedgerError> {
        Ok(PrepareOutcome::Completed(self.receipt.clone()))
    }

    fn complete(
        &mut self,
        _token: ExecutionToken,
        _bytes: &[u8],
    ) -> Result<StoredReceipt, HostExecCompletionFailure> {
        unreachable!()
    }

    fn mark_ambiguous(&mut self, _token: ExecutionToken) -> Result<(), HostExecLedgerError> {
        unreachable!()
    }
}

#[test]
fn corrupt_completed_receipt_is_never_executed_and_reports_typed_ambiguity() {
    let calls = Arc::new(AtomicUsize::new(0));
    let valid_bytes =
        HostExecResult::new(HostExecTermination::Exited(0), b"stored".to_vec(), vec![])
            .unwrap()
            .canonical_receipt_bytes();
    let owner = HostExecLedgerOwner::new(CorruptCompletedLedger {
        receipt: StoredReceipt {
            bytes: valid_bytes,
            sha256: [0; 32],
        },
    });
    let mut service = coordinator(
        owner,
        calls.clone(),
        HostExecResult::new(HostExecTermination::Exited(0), vec![], vec![]).unwrap(),
    );
    open(&mut service);
    let response = run(&mut service, "host_call('elpis.host.exec',['fake'])");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
    assert_eq!(
        response.ambiguity.unwrap().reason,
        EffectAmbiguityReason::ReceiptIntegrityFailed
    );
    assert_eq!(service.context_count(), 0);
}

#[test]
fn real_completion_capacity_failure_marks_ledger_ambiguous_and_fences_context() {
    let temp = TempDir::new().unwrap();
    let path = db_path(&temp);
    let ledger = EffectLedger::open(
        &path,
        EffectLimits {
            max_effects: 8,
            max_bytes: 240,
        },
    )
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut service = coordinator(
        HostExecLedgerOwner::new(ledger),
        calls.clone(),
        HostExecResult::new(HostExecTermination::Exited(0), b"ran".to_vec(), vec![]).unwrap(),
    );
    open(&mut service);
    let response = run(&mut service, "host_call('elpis.host.exec',['fake'])");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
    assert_eq!(
        response.ambiguity.unwrap().reason,
        EffectAmbiguityReason::CompletionPersistenceFailed
    );
    assert_eq!(service.context_count(), 0);
    drop(service);

    let reopened = EffectLedger::open(
        path,
        EffectLimits {
            max_effects: 8,
            max_bytes: 240,
        },
    )
    .unwrap();
    let stored = reopened
        .effect(current_identity().effect_id())
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, EffectStatus::Ambiguous);
    assert!(stored.receipt.is_none());
}

#[test]
fn reporter_capacity_is_reserved_before_ledger_or_runner_effect() {
    let temp = TempDir::new().unwrap();
    let owner = HostExecLedgerOwner::new(ledger(&temp));
    let calls = Arc::new(AtomicUsize::new(0));
    let large =
        HostExecResult::new(HostExecTermination::Exited(0), vec![b'x'; 65_536], vec![]).unwrap();
    let actual_receipt_bytes = large.canonical_receipt_bytes().len();
    let mut expected = 0usize;
    let mut settled_bytes = 0usize;
    while settled_bytes + MAX_HOST_EXEC_RECEIPT_BYTES <= MAX_TOTAL_RECEIPT_BYTES {
        expected += 1;
        settled_bytes += actual_receipt_bytes;
    }
    assert!(expected > 0);
    let mut service = coordinator(owner, calls.clone(), large);
    open(&mut service);
    let source = (0..expected + 2)
        .map(|index| format!("host_call('elpis.host.exec',['fake','{index}'])"))
        .collect::<Vec<_>>()
        .join("\n");
    let response = run(&mut service, &source);
    assert!(!response.ok);
    assert_eq!(response.failure_kind.as_deref(), Some("runtime"));
    assert_eq!(response.completed_effects.len(), expected);
    assert_eq!(calls.load(Ordering::SeqCst), expected);
    assert!(response.ambiguity.is_none());
    assert_eq!(service.context_count(), 1);
}

#[test]
fn swapped_runner_token_never_reaches_ledger_settlement() {
    let temp = TempDir::new().unwrap();
    let path = db_path(&temp);
    let mut inner = EffectLedger::open(&path, EffectLimits::default()).unwrap();
    let wrong_request = HostExecRequest::new(vec!["wrong".into()], String::new()).unwrap();
    let wrong_identity = EffectIdentity::new(
        "wrong-request",
        "context-1",
        1,
        "wrong-run",
        0,
        HOST_EXEC_CAPABILITY,
        wrong_request.canonical_bytes(),
    )
    .unwrap();
    let wrong_token = match inner.prepare(&wrong_identity).unwrap() {
        PrepareOutcome::New(token) => token,
        other => panic!("expected wrong token, got {other:?}"),
    };
    let complete_calls = Arc::new(AtomicUsize::new(0));
    let ambiguity_calls = Arc::new(AtomicUsize::new(0));
    let owner = HostExecLedgerOwner::new(RecordingLedger {
        inner,
        complete_calls: complete_calls.clone(),
        ambiguity_calls: ambiguity_calls.clone(),
    });
    let runner_calls = Arc::new(AtomicUsize::new(0));
    let runner = SwapRunner {
        calls: runner_calls.clone(),
        wrong_token: Arc::new(Mutex::new(Some(wrong_token))),
        result: HostExecResult::new(
            HostExecTermination::Exited(0),
            b"must not settle".to_vec(),
            vec![],
        )
        .unwrap(),
    };
    let mut service = coordinator_with_runner(owner, runner);
    open(&mut service);
    let response = run(&mut service, "host_call('elpis.host.exec',['fake'])");
    assert_eq!(runner_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(ambiguity_calls.load(Ordering::SeqCst), 0);
    assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
    assert_eq!(
        response.ambiguity.unwrap().reason,
        EffectAmbiguityReason::ExecutorLost
    );
    assert_eq!(service.context_count(), 0);
}

#[test]
fn owned_active_completion_reaps_persists_and_replays_exactly() {
    let temp = TempDir::new().unwrap();
    let marker = temp.path().join("executions");
    let script = format!("printf x >> {}; printf owned", marker.display());
    let argv = vec!["/bin/sh".into(), "-c".into(), script];
    let source = python_host_call(&argv);
    let owner = HostExecLedgerOwner::new(ledger(&temp));

    let mut first = owned_coordinator(owner.clone());
    open(&mut first);
    let completed = run(&mut first, &source);
    assert!(completed.ok, "{completed:?}");
    assert_eq!(completed.completed_effects.len(), 1);
    let receipt = URL_SAFE_NO_PAD
        .decode(&completed.completed_effects[0].receipt)
        .unwrap();
    let result = HostExecResult::decode_canonical_receipt(&receipt).unwrap();
    assert_eq!(result.termination(), HostExecTermination::Exited(0));
    assert_eq!(result.stdout(), b"owned");
    assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    drop(first);

    let mut replay = owned_coordinator(owner);
    open(&mut replay);
    let replayed = run(&mut replay, &source);
    assert!(replayed.ok, "{replayed:?}");
    assert_eq!(replayed.completed_effects, completed.completed_effects);
    assert_eq!(std::fs::read(marker).unwrap(), b"x");
}

#[test]
fn owned_spawn_failure_executes_nothing_and_releases_reporter_claim() {
    let temp = TempDir::new().unwrap();
    let path = db_path(&temp);
    let argv = vec!["/definitely/not/an/elpis-program".into()];
    let identity = identity_for(argv.clone(), String::new());
    let mut service = owned_coordinator(HostExecLedgerOwner::new(ledger(&temp)));
    open(&mut service);
    let response = run(&mut service, &python_host_call(&argv));
    assert!(!response.ok);
    assert_eq!(response.failure_kind.as_deref(), Some("runtime"));
    assert!(response.ambiguity.is_none());
    assert!(response.completed_effects.is_empty());
    assert_eq!(service.context_count(), 1);
    drop(service);

    let reopened = EffectLedger::open(path, EffectLimits::default()).unwrap();
    let stored = reopened.effect(identity.effect_id()).unwrap().unwrap();
    assert_eq!(stored.status, EffectStatus::Ambiguous);
    assert!(stored.receipt.is_none());
}

#[test]
fn owned_output_overflow_reaps_then_fences_ledger_and_context() {
    let temp = TempDir::new().unwrap();
    let path = db_path(&temp);
    let argv = vec![
        "/usr/bin/head".into(),
        "-c".into(),
        "70000".into(),
        "/dev/zero".into(),
    ];
    let identity = identity_for(argv.clone(), String::new());
    let mut service = owned_coordinator(HostExecLedgerOwner::new(ledger(&temp)));
    open(&mut service);
    let response = run(&mut service, &python_host_call(&argv));
    assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
    assert_eq!(
        response.ambiguity.unwrap().reason,
        EffectAmbiguityReason::ExecutorLost
    );
    assert_eq!(service.context_count(), 0);
    drop(service);

    let reopened = EffectLedger::open(path, EffectLimits::default()).unwrap();
    let stored = reopened.effect(identity.effect_id()).unwrap().unwrap();
    assert_eq!(stored.status, EffectStatus::Ambiguous);
    assert!(stored.receipt.is_none());
}

#[test]
fn owned_active_cancel_reaps_group_and_settles_ambiguity_before_pair() {
    let temp = TempDir::new().unwrap();
    let path = db_path(&temp);
    let pidfile = temp.path().join("pgid");
    let script = format!("echo $$ > {}; sleep 30 & wait", pidfile.display());
    let argv = vec!["/bin/sh".into(), "-c".into(), script];
    let identity = identity_for(argv.clone(), String::new());
    let source = python_host_call(&argv);
    let mut service = owned_coordinator(HostExecLedgerOwner::new(ledger(&temp)));
    open(&mut service);
    assert!(
        service
            .submit(Request::Run {
                protocol: PROTOCOL_VERSION,
                request_id: "request-1".into(),
                context_id: "context-1".into(),
                generation: 1,
                run_id: "run-1".into(),
                source,
                preview_max_bytes: DEFAULT_PREVIEW_BYTES,
            })
            .is_none()
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    let pgid = loop {
        if let Ok(value) = std::fs::read_to_string(&pidfile)
            && let Ok(pgid) = value.trim().parse::<i32>()
        {
            break pgid;
        }
        assert!(Instant::now() < deadline, "host process did not start");
        std::thread::yield_now();
    };
    assert!(process_group_exists(pgid));

    let immediate = service.submit(Request::Cancel {
        protocol: PROTOCOL_VERSION,
        request_id: "cancel-1".into(),
        context_id: "context-1".into(),
        generation: 1,
        target_request_id: "request-1".into(),
        run_id: "run-1".into(),
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let group = match immediate {
        Some(group) => group,
        None => loop {
            if let Some(group) = service.poll().pop() {
                break group;
            }
            assert!(Instant::now() < deadline, "cancel pair did not complete");
            std::thread::yield_now();
        },
    };
    let responses = group.into_responses();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0].request_id.as_deref(), Some("request-1"));
    assert_eq!(
        responses[0].failure_kind.as_deref(),
        Some("effect_ambiguous")
    );
    assert_eq!(
        responses[0].ambiguity.as_ref().unwrap().reason,
        EffectAmbiguityReason::ExecutorLost
    );
    assert_eq!(responses[1].request_id.as_deref(), Some("cancel-1"));
    assert!(responses[1].ok, "{:?}", responses[1]);
    assert_eq!(service.active_run_count(), 0);
    assert_eq!(service.context_count(), 0);
    assert!(!process_group_exists(pgid));
    drop(service);

    let reopened = EffectLedger::open(path, EffectLimits::default()).unwrap();
    let stored = reopened.effect(identity.effect_id()).unwrap().unwrap();
    assert_eq!(stored.status, EffectStatus::Ambiguous);
    assert!(stored.receipt.is_none());
}

#[test]
fn explicit_runner_ambiguity_marks_exact_token_once() {
    let temp = TempDir::new().unwrap();
    let inner = ledger(&temp);
    let complete_calls = Arc::new(AtomicUsize::new(0));
    let ambiguity_calls = Arc::new(AtomicUsize::new(0));
    let owner = HostExecLedgerOwner::new(RecordingLedger {
        inner,
        complete_calls: complete_calls.clone(),
        ambiguity_calls: ambiguity_calls.clone(),
    });
    let runner_calls = Arc::new(AtomicUsize::new(0));
    let mut service = coordinator_with_runner(
        owner,
        AmbiguousRunner {
            calls: runner_calls.clone(),
        },
    );
    open(&mut service);
    let response = run(&mut service, "host_call('elpis.host.exec',['fake'])");
    assert_eq!(runner_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(ambiguity_calls.load(Ordering::SeqCst), 1);
    assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
    assert_eq!(
        response.ambiguity.unwrap().reason,
        EffectAmbiguityReason::ExecutorLost
    );
    assert_eq!(service.context_count(), 0);
}
