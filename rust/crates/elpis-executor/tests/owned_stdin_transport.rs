use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use elpis_effects::{EffectIdentity, EffectLedger, EffectLimits, PrepareOutcome};
use elpis_executor::host_exec::{
    HOST_EXEC_CAPABILITY, HostExecRequest, HostExecResult, HostExecTermination,
};
use elpis_protocol::v2::EffectAmbiguityReason;
use elpis_protocol::{PROTOCOL_VERSION, Request, Response};
use tempfile::TempDir;

const REQUEST_ID: &str = "request-1";
const CONTEXT_ID: &str = "context-1";
const RUN_ID: &str = "run-1";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

struct StdinExecutor {
    child: Child,
    input: Option<ChildStdin>,
    lines: mpsc::Receiver<Vec<u8>>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl StdinExecutor {
    fn start(state: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_elpis-executor"))
            .env("ELPIS_EXECUTOR_MODE", "stdin")
            .env("ELPIS_EXECUTOR_STATE_DIR", state)
            .env("ELPIS_EXECUTOR_CAPABILITY_PROFILE", "owned_permissive")
            .env_remove("ELPIS_EXECUTOR_LINK_ENDPOINT")
            .env_remove("ELPIS_EXECUTOR_TLS_SERVER_NAME")
            .env_remove("ELPIS_EXECUTOR_TLS_ROOT_FILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let error = child.stderr.take().unwrap();
        let (sender, lines) = mpsc::channel();
        let stdout_thread = thread::spawn(move || {
            for line in BufReader::new(output).split(b'\n') {
                let Ok(line) = line else { break };
                if !line.is_empty() && sender.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&stderr);
        let stderr_thread = thread::spawn(move || {
            let mut reader = error.take(64 * 1024);
            let _ = reader.read_to_end(&mut captured.lock().unwrap());
        });
        Self {
            child,
            input: Some(input),
            lines,
            stdout_thread: Some(stdout_thread),
            stderr_thread: Some(stderr_thread),
            stderr,
        }
    }

    fn request(&mut self, request: &Request) -> (Vec<u8>, Response) {
        let input = self.input.as_mut().unwrap();
        serde_json::to_writer(&mut *input, request).unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
        let line = self
            .lines
            .recv_timeout(RESPONSE_TIMEOUT)
            .unwrap_or_else(|_| {
                panic!(
                    "executor response timed out: {}",
                    String::from_utf8_lossy(&self.stderr.lock().unwrap())
                )
            });
        let response: Response = serde_json::from_slice(&line).unwrap();
        response.validate().unwrap();
        (line, response)
    }

    fn open(&mut self) {
        let (_, response) = self.request(&Request::Open {
            protocol: PROTOCOL_VERSION,
            request_id: "open-1".into(),
            context_id: CONTEXT_ID.into(),
            generation: 1,
        });
        assert!(response.ok, "{response:?}");
    }

    fn run(&mut self, source: String) -> (Vec<u8>, Response) {
        self.request(&Request::Run {
            protocol: PROTOCOL_VERSION,
            request_id: REQUEST_ID.into(),
            context_id: CONTEXT_ID.into(),
            generation: 1,
            run_id: RUN_ID.into(),
            source,
            preview_max_bytes: elpis_protocol::DEFAULT_PREVIEW_BYTES,
        })
    }

    fn finish(mut self) {
        drop(self.input.take());
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "executor failed: {}",
                    String::from_utf8_lossy(&self.stderr.lock().unwrap())
                );
                break;
            }
            assert!(Instant::now() < deadline, "executor did not exit after EOF");
            thread::sleep(Duration::from_millis(10));
        }
        self.stdout_thread.take().unwrap().join().unwrap();
        self.stderr_thread.take().unwrap().join().unwrap();
    }
}

impl Drop for StdinExecutor {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(handle) = self.stdout_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.stderr_thread.take() {
            let _ = handle.join();
        }
    }
}

fn private_state(temp: &TempDir) -> std::path::PathBuf {
    let state = temp.path().join("state");
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    state
}

fn request(argv: Vec<String>, stdin: &str) -> HostExecRequest {
    HostExecRequest::new(argv, stdin.into()).unwrap()
}

fn source(request: &HostExecRequest) -> String {
    format!(
        "host_call('elpis.host.exec',{}, {})",
        serde_json::to_string(request.argv()).unwrap(),
        serde_json::to_string(request.stdin()).unwrap()
    )
}

fn identity(request: &HostExecRequest) -> EffectIdentity {
    EffectIdentity::new(
        REQUEST_ID,
        CONTEXT_ID,
        1,
        RUN_ID,
        0,
        HOST_EXEC_CAPABILITY,
        request.canonical_bytes(),
    )
    .unwrap()
}

fn ledger(state: &Path) -> EffectLedger {
    EffectLedger::open_directory(state, EffectLimits::default()).unwrap()
}

#[test]
fn owned_stdin_without_state_fails_before_reading_a_request() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_elpis-executor"))
        .env("ELPIS_EXECUTOR_MODE", "stdin")
        .env("ELPIS_EXECUTOR_CAPABILITY_PROFILE", "owned_permissive")
        .env_remove("ELPIS_EXECUTOR_STATE_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
    let mut byte = [0_u8; 1];
    assert_eq!(child.stdout.take().unwrap().read(&mut byte).unwrap(), 0);
}

#[test]
fn completed_response_replays_exactly_across_executor_restart() {
    let temp = TempDir::new().unwrap();
    let state = private_state(&temp);
    let marker = temp.path().join("executions");
    let argv = vec![
        "/bin/sh".into(),
        "-c".into(),
        format!("cat; printf x >> {}", marker.display()),
    ];
    let host_request = request(argv, "stdin-crossed");

    let mut first = StdinExecutor::start(&state);
    first.open();
    let (first_bytes, first_response) = first.run(source(&host_request));
    assert!(first_response.ok, "{first_response:?}");
    assert_eq!(first_response.completed_effects.len(), 1);
    assert!(first_response.ambiguity.is_none());
    let completed = &first_response.completed_effects[0];
    assert_eq!(completed.binding.request_id, REQUEST_ID);
    assert_eq!(completed.binding.context_id, CONTEXT_ID);
    assert_eq!(completed.binding.generation, 1);
    assert_eq!(completed.binding.run_id, RUN_ID);
    assert_eq!(completed.binding.call_index, 0);
    assert_eq!(completed.binding.capability, HOST_EXEC_CAPABILITY);
    let expected_identity = identity(&host_request);
    assert_eq!(
        completed.binding.effect_id,
        expected_identity.effect_id().to_hex()
    );
    assert_eq!(
        completed.binding.request_sha256,
        hex::encode(expected_identity.canonical_request_sha256())
    );
    let result =
        HostExecResult::decode_canonical_receipt(&completed.receipt_bytes().unwrap()).unwrap();
    assert_eq!(result.termination(), HostExecTermination::Exited(0));
    assert_eq!(result.stdout(), b"stdin-crossed");
    assert!(result.stderr().is_empty());
    assert_eq!(fs::read(&marker).unwrap(), b"x");
    first.finish();

    let mut restarted = StdinExecutor::start(&state);
    restarted.open();
    let (replayed_bytes, replayed) = restarted.run(source(&host_request));
    assert!(replayed.ok, "{replayed:?}");
    assert_eq!(replayed_bytes, first_bytes);
    assert_eq!(replayed, first_response);
    assert_eq!(fs::read(&marker).unwrap(), b"x");
    restarted.finish();
}

#[test]
fn prepared_only_restart_returns_ambiguity_without_execution() {
    let temp = TempDir::new().unwrap();
    let state = private_state(&temp);
    let marker = temp.path().join("must-not-exist");
    let host_request = request(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("printf wrong > {}", marker.display()),
        ],
        "",
    );
    let expected_identity = identity(&host_request);
    let mut effects = ledger(&state);
    assert!(matches!(
        effects.prepare(&expected_identity).unwrap(),
        PrepareOutcome::New(_)
    ));
    drop(effects);

    let mut restarted = StdinExecutor::start(&state);
    restarted.open();
    let (_, response) = restarted.run(source(&host_request));
    assert!(!response.ok);
    assert_eq!(response.failure_kind.as_deref(), Some("effect_ambiguous"));
    assert!(response.completed_effects.is_empty());
    let ambiguity = response.ambiguity.as_ref().unwrap();
    assert_eq!(
        ambiguity.binding.effect_id,
        expected_identity.effect_id().to_hex()
    );
    assert_eq!(ambiguity.reason, EffectAmbiguityReason::ExecutorLost);
    assert!(ambiguity.may_have_occurred);
    assert!(ambiguity.context_invalidated);
    assert!(!marker.exists());
    restarted.finish();
}

#[test]
fn changed_request_under_same_logical_call_is_denied_without_second_effect() {
    let temp = TempDir::new().unwrap();
    let state = private_state(&temp);
    let first_marker = temp.path().join("first");
    let second_marker = temp.path().join("second");
    let first_request = request(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("printf first > {}", first_marker.display()),
        ],
        "",
    );
    let second_request = request(
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("printf second > {}", second_marker.display()),
        ],
        "",
    );

    let mut first = StdinExecutor::start(&state);
    first.open();
    let (_, completed) = first.run(source(&first_request));
    assert!(completed.ok, "{completed:?}");
    first.finish();
    assert_eq!(fs::read(&first_marker).unwrap(), b"first");

    let mut restarted = StdinExecutor::start(&state);
    restarted.open();
    let (_, conflict) = restarted.run(source(&second_request));
    assert!(!conflict.ok);
    assert_eq!(conflict.failure_kind.as_deref(), Some("runtime"));
    assert!(conflict.completed_effects.is_empty());
    assert!(conflict.ambiguity.is_none());
    assert!(!second_marker.exists());
    restarted.finish();

    let effects = ledger(&state);
    assert_eq!(effects.state().unwrap().effect_count, 1);
}
