#[cfg(all(not(feature = "embedded-python"), not(debug_assertions)))]
compile_error!("release builds require the embedded-python feature");

use elpis_coordinator::{CompletionGroup, Coordinator, CoordinatorConfig};
use elpis_identity::{CredentialPolicy, IdentityStore};
use elpis_journal::{Journal, JournalLimits};
use elpis_link::{
    BackoffPolicy, DeferredDispatcher, DispatchGroup, DrainSignal, LinkConfig, Supervisor,
    SupervisorConfig, SupervisorExit,
};
use elpis_protocol::{MAX_FRAME_BYTES, Request, Response};
use elpis_python::PythonRuntime;
use ring::rand::{SecureRandom, SystemRandom};
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::{Handle as SignalHandle, Signals};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[cfg(feature = "embedded-python")]
include!(concat!(env!("OUT_DIR"), "/python_bundle.rs"));

const MAX_ROOT_DER_BYTES: u64 = 64 * 1024;
const MAX_CREDENTIAL_LIFETIME: Duration = Duration::from_secs(31 * 24 * 60 * 60);
const STDIN_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, PartialEq, Eq)]
enum ModeConfig {
    Stdin,
    Outbound(OutboundConfig),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OutboundConfig {
    endpoint: String,
    server_name: String,
    root_file: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StartupConfig {
    state_dir: Option<PathBuf>,
    mode: ModeConfig,
}

impl StartupConfig {
    fn from_environment() -> Result<Self, String> {
        Self::from_lookup(|name| std::env::var_os(name))
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Result<Self, String> {
        let mode = required_utf8(&mut lookup, "ELPIS_EXECUTOR_MODE")?;
        let state_dir = lookup("ELPIS_EXECUTOR_STATE_DIR").map(PathBuf::from);
        if state_dir.as_ref().is_some_and(|path| !path.is_absolute()) {
            return Err("ELPIS_EXECUTOR_STATE_DIR must be absolute".into());
        }
        #[cfg(feature = "embedded-python")]
        if state_dir.is_none() {
            return Err("ELPIS_EXECUTOR_STATE_DIR is required".into());
        }
        let mode = match mode.as_str() {
            "stdin" => {
                if [
                    "ELPIS_EXECUTOR_LINK_ENDPOINT",
                    "ELPIS_EXECUTOR_TLS_SERVER_NAME",
                    "ELPIS_EXECUTOR_TLS_ROOT_FILE",
                ]
                .into_iter()
                .any(|name| lookup(name).is_some())
                {
                    return Err("outbound settings are not allowed in stdin mode".into());
                }
                ModeConfig::Stdin
            }
            "outbound" => {
                if state_dir.is_none() {
                    return Err("ELPIS_EXECUTOR_STATE_DIR is required in outbound mode".into());
                }
                let endpoint = required_utf8(&mut lookup, "ELPIS_EXECUTOR_LINK_ENDPOINT")?;
                let server_name = required_utf8(&mut lookup, "ELPIS_EXECUTOR_TLS_SERVER_NAME")?;
                let root_file = required_path(&mut lookup, "ELPIS_EXECUTOR_TLS_ROOT_FILE")?;
                if !root_file.is_absolute() {
                    return Err("ELPIS_EXECUTOR_TLS_ROOT_FILE must be absolute".into());
                }
                ModeConfig::Outbound(OutboundConfig {
                    endpoint,
                    server_name,
                    root_file,
                })
            }
            _ => return Err("ELPIS_EXECUTOR_MODE must be stdin or outbound".into()),
        };
        Ok(Self { state_dir, mode })
    }
}

fn required_utf8(
    lookup: &mut impl FnMut(&str) -> Option<OsString>,
    name: &str,
) -> Result<String, String> {
    let value = lookup(name).ok_or_else(|| format!("{name} is required"))?;
    let value = value
        .into_string()
        .map_err(|_| format!("{name} must be valid UTF-8"))?;
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    Ok(value)
}

fn required_path(
    lookup: &mut impl FnMut(&str) -> Option<OsString>,
    name: &str,
) -> Result<PathBuf, String> {
    lookup(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

struct ExecutorRuntime {
    python: PythonRuntime,
    #[cfg(feature = "embedded-python")]
    _generation: elpis_runtime::RuntimeHandle,
}

#[cfg(not(feature = "embedded-python"))]
fn load_runtime(_state: Option<&Path>) -> Result<ExecutorRuntime, String> {
    Ok(ExecutorRuntime {
        python: PythonRuntime::system("python3"),
    })
}

#[cfg(feature = "embedded-python")]
fn load_runtime(state: Option<&Path>) -> Result<ExecutorRuntime, String> {
    let state = state.ok_or_else(|| "ELPIS_EXECUTOR_STATE_DIR is required".to_string())?;
    let payload = elpis_runtime::RuntimePayload::new(PYTHON_ARCHIVE, PYTHON_MANIFEST)
        .map_err(|error| error.to_string())?;
    let generation = payload
        .ensure(&state.join("python-runtime"))
        .map_err(|error| error.to_string())?;
    if generation.payload_sha256 != PYTHON_ARCHIVE_SHA256 {
        return Err("embedded runtime generation hash mismatch".into());
    }
    let executable = generation
        .open_verified_executable()
        .map_err(|error| error.to_string())?;
    let python = PythonRuntime::isolated_verified(executable);
    Ok(ExecutorRuntime {
        python,
        _generation: generation,
    })
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("elpis_executor=info,elpis_python=info,elpis_runtime=info")
    });
    tracing_subscriber::fmt()
        .json()
        .with_ansi(false)
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .init();
}

fn main() {
    init_logging();
    let config = match StartupConfig::from_environment() {
        Ok(config) => config,
        Err(error) => {
            error!(error = %error, "executor configuration rejected");
            std::process::exit(1);
        }
    };
    info!(
        embedded_python = cfg!(feature = "embedded-python"),
        mode = match &config.mode {
            ModeConfig::Stdin => "stdin",
            ModeConfig::Outbound(_) => "outbound",
        },
        "executor starting"
    );
    let runtime = match load_runtime(config.state_dir.as_deref()) {
        Ok(runtime) => runtime,
        Err(error) => {
            error!(error = %error, "runtime startup failed");
            std::process::exit(1);
        }
    };
    #[cfg(feature = "embedded-python")]
    info!(
        archive_sha256 = PYTHON_ARCHIVE_SHA256,
        manifest_sha256 = PYTHON_MANIFEST_SHA256,
        "executor runtime ready"
    );
    #[cfg(not(feature = "embedded-python"))]
    info!("executor runtime ready");
    let mut executor = ExecutorDispatcher::new(runtime);
    let outcome = match &config.mode {
        ModeConfig::Stdin => run_stdin(&mut executor),
        ModeConfig::Outbound(outbound) => match config.state_dir.as_deref() {
            Some(state_dir) => run_outbound(&mut executor, state_dir, outbound),
            None => Err("validated outbound state is unavailable".into()),
        },
    };
    let open_contexts = executor.close_all();
    info!(open_contexts, "executor stopped");
    if let Err(error) = outcome {
        error!(error = %error, "executor failed closed");
        std::process::exit(1);
    }
}

struct ExecutorDispatcher {
    _runtime: Option<ExecutorRuntime>,
    coordinator: Coordinator,
    ready: VecDeque<DispatchGroup>,
}

impl ExecutorDispatcher {
    fn new(runtime: ExecutorRuntime) -> Self {
        let coordinator = Coordinator::new(runtime.python.clone(), CoordinatorConfig::default());
        Self {
            _runtime: Some(runtime),
            coordinator,
            ready: VecDeque::new(),
        }
    }

    #[cfg(test)]
    fn for_test(runtime: PythonRuntime) -> Self {
        Self {
            _runtime: None,
            coordinator: Coordinator::new(runtime, CoordinatorConfig::default()),
            ready: VecDeque::new(),
        }
    }

    fn close_all(&mut self) -> usize {
        self.ready.clear();
        self.coordinator.close_all()
    }
}

impl DeferredDispatcher for ExecutorDispatcher {
    fn submit(&mut self, request: Request) -> Option<DispatchGroup> {
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

enum StdinInput {
    Frame(Vec<u8>),
    Transport(String),
    Eof,
}

fn run_stdin(executor: &mut ExecutorDispatcher) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = thread::Builder::new()
        .name("elpis-executor-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut input = stdin.lock();
            loop {
                let message = match read_request_frame(&mut input) {
                    Ok(Some(frame)) => StdinInput::Frame(frame),
                    Ok(None) => StdinInput::Eof,
                    Err(error) => StdinInput::Transport(error.to_string()),
                };
                let terminal = !matches!(message, StdinInput::Frame(_));
                if sender.send(message).is_err() || terminal {
                    break;
                }
            }
        })
        .map_err(|_| "stdin reader thread could not start".to_string())?;
    let mut stdout = io::stdout().lock();
    pump_stdin(executor, &receiver, &mut stdout);
    reader
        .join()
        .map_err(|_| "stdin reader thread failed".to_string())?;
    Ok(())
}

fn pump_stdin(
    executor: &mut ExecutorDispatcher,
    receiver: &Receiver<StdinInput>,
    output: &mut impl Write,
) {
    loop {
        while let Some(group) = executor.poll() {
            write_group(output, &group);
        }
        match receiver.recv_timeout(STDIN_POLL_INTERVAL) {
            Ok(StdinInput::Frame(frame)) => match decode_request(&frame) {
                Ok(request) => {
                    if let Some(group) = executor.submit(request) {
                        write_group(output, &group);
                    }
                }
                Err(response) => write_response(output, &response),
            },
            Ok(StdinInput::Transport(error)) => {
                warn!(error, "protocol transport failed");
                write_response(
                    output,
                    &Response::failure(None, "protocol", "transport", error),
                );
                break;
            }
            Ok(StdinInput::Eof) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn decode_request(frame: &[u8]) -> Result<Request, Box<Response>> {
    let line = std::str::from_utf8(frame).map_err(|error| {
        Box::new(Response::failure(
            None,
            "protocol",
            "protocol",
            error.to_string(),
        ))
    })?;
    serde_json::from_str(line).map_err(|error| {
        Box::new(Response::failure(
            None,
            "protocol",
            "protocol",
            error.to_string(),
        ))
    })
}

fn write_group(output: &mut impl Write, group: &DispatchGroup) {
    match group {
        DispatchGroup::Single(response) => write_response(output, response),
        DispatchGroup::Pair(responses) => {
            for response in responses.as_ref() {
                write_response(output, response);
            }
        }
    }
}

fn run_outbound(
    executor: &mut ExecutorDispatcher,
    state_dir: &Path,
    outbound: &OutboundConfig,
) -> Result<(), String> {
    ensure_private_state_root(state_dir)?;
    let root_der = read_root_der(&outbound.root_file)?;
    let policy = CredentialPolicy::new(
        outbound.server_name.clone(),
        root_der,
        MAX_CREDENTIAL_LIFETIME,
    )
    .map_err(|_| "TLS trust policy is invalid".to_string())?;
    let identity = IdentityStore::open(state_dir.join("identity"), policy)
        .map_err(|_| "executor identity is unavailable".to_string())?;
    let mut journal = Journal::open(
        state_dir.join("link").join("journal.sqlite"),
        JournalLimits::default(),
    )
    .map_err(|_| "executor journal is unavailable".to_string())?;
    let link = LinkConfig::new(
        outbound.endpoint.clone(),
        &identity,
        Duration::from_secs(30),
        Duration::from_secs(1),
    )
    .map_err(|_| "outbound link configuration is invalid".to_string())?;
    let backoff = BackoffPolicy::new(Duration::from_secs(1), Duration::from_secs(60), 20)
        .map_err(|_| "outbound retry configuration is invalid".to_string())?;
    let supervisor_config = SupervisorConfig::new(
        link,
        Duration::from_secs(15),
        Duration::from_secs(60),
        Duration::from_secs(5),
        Duration::from_secs(60),
        backoff,
    )
    .map_err(|_| "outbound supervisor configuration is invalid".to_string())?;
    let boot_epoch = durable_boot_epoch(&journal)?;
    let drain = DrainSignal::new();
    let supervisor = Supervisor::new(supervisor_config, boot_epoch, drain.clone())
        .map_err(|_| "outbound supervisor configuration is invalid".to_string())?;
    let (signal_handle, signal_thread) = install_signal_drain(drain)?;
    let result = supervisor.run(&identity, &mut journal, executor);
    signal_handle.close();
    let _ = signal_thread.join();
    match result {
        Ok(SupervisorExit::Drained) => Ok(()),
        Err(_) => Err("outbound supervisor stopped fail-closed".into()),
    }
}

fn durable_boot_epoch(journal: &Journal) -> Result<String, String> {
    let boot_epoch = journal
        .state()
        .map_err(|_| "executor journal state is unavailable".to_string())?
        .boot_epoch;
    select_boot_epoch(boot_epoch)
}

fn select_boot_epoch(existing: Option<String>) -> Result<String, String> {
    existing.map_or_else(generate_boot_epoch, Ok)
}

fn generate_boot_epoch() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "secure boot epoch generation failed".to_string())?;
    Ok(hex::encode(bytes))
}

fn install_signal_drain(drain: DrainSignal) -> Result<(SignalHandle, JoinHandle<()>), String> {
    let mut signals = Signals::new([SIGINT, SIGTERM])
        .map_err(|_| "signal drain registration failed".to_string())?;
    let handle = signals.handle();
    let thread = thread::Builder::new()
        .name("elpis-executor-signals".into())
        .spawn(move || {
            if signals.forever().next().is_some() {
                drain.request();
            }
        })
        .map_err(|_| "signal drain thread failed".to_string())?;
    Ok((handle, thread))
}

fn ensure_private_state_root(path: &Path) -> Result<(), String> {
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        builder
            .mode(0o700)
            .recursive(true)
            .create(path)
            .map_err(|_| "executor state directory could not be created".to_string())?;
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "executor state directory is unavailable".to_string())?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o7777 != 0o700
        || metadata.uid() != rustix::process::geteuid().as_raw()
    {
        return Err("executor state directory must be owned, mode 0700, and not a symlink".into());
    }
    Ok(())
}

fn read_root_der(path: &Path) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options
        .open(path)
        .map_err(|_| "TLS root file is unavailable".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "TLS root file is unavailable".to_string())?;
    let effective_uid = rustix::process::geteuid().as_raw();
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_ROOT_DER_BYTES
        || metadata.permissions().mode() & 0o022 != 0
        || (metadata.uid() != effective_uid && metadata.uid() != 0)
    {
        return Err(
            "TLS root file must be a bounded, trusted, non-writable regular DER file".into(),
        );
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_ROOT_DER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "TLS root file could not be read".to_string())?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > MAX_ROOT_DER_BYTES {
        return Err("TLS root file changed while reading".into());
    }
    Ok(bytes)
}

fn read_request_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Ok(Some(output))
            };
        }
        if let Some(end) = available.iter().position(|byte| *byte == b'\n') {
            if output.len() + end > MAX_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "request frame is too large",
                ));
            }
            output.extend_from_slice(&available[..end]);
            reader.consume(end + 1);
            return Ok(Some(output));
        }
        if output.len() + available.len() > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request frame is too large",
            ));
        }
        let length = available.len();
        output.extend_from_slice(available);
        reader.consume(length);
    }
}

fn write_response(output: &mut impl Write, response: &Response) {
    let Ok(mut bytes) = serde_json::to_vec(response) else {
        return;
    };
    bytes.push(b'\n');
    let _ = output.write_all(&bytes);
    let _ = output.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpis_protocol::PROTOCOL_VERSION;

    fn executor() -> ExecutorDispatcher {
        ExecutorDispatcher::for_test(PythonRuntime::system("python3"))
    }

    fn only(group: Option<DispatchGroup>) -> Response {
        match group.expect("request returned no immediate response") {
            DispatchGroup::Single(response) => *response,
            DispatchGroup::Pair(_) => panic!("request returned an unexpected response pair"),
        }
    }

    fn submit_json(
        executor: &mut ExecutorDispatcher,
        value: serde_json::Value,
    ) -> Option<DispatchGroup> {
        match decode_request(value.to_string().as_bytes()) {
            Ok(request) => executor.submit(request),
            Err(response) => Some(DispatchGroup::Single(response)),
        }
    }

    fn wait_group(executor: &mut ExecutorDispatcher) -> DispatchGroup {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(group) = executor.poll() {
                return group;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "executor completion timed out"
            );
            thread::yield_now();
        }
    }

    struct CaptureWriter {
        bytes: Vec<u8>,
        lines: mpsc::Sender<()>,
    }

    impl Write for CaptureWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            for _ in bytes.iter().filter(|byte| **byte == b'\n') {
                let _ = self.lines.send(());
            }
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl CaptureWriter {
        fn responses(&self) -> Vec<Response> {
            self.bytes
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .map(|line| serde_json::from_slice(line).unwrap())
                .collect()
        }
    }

    fn frame(value: serde_json::Value) -> StdinInput {
        StdinInput::Frame(serde_json::to_vec(&value).unwrap())
    }

    fn wait_for_line(receiver: &mpsc::Receiver<()>) {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("stdin pump response timed out");
    }

    #[test]
    fn stdin_pump_emits_natural_completion_without_later_input() {
        let mut executor = executor();
        let (input_sender, input_receiver) = mpsc::sync_channel(1);
        let (line_sender, line_receiver) = mpsc::channel();
        let sender = thread::spawn(move || {
            input_sender
                .send(frame(serde_json::json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"open-1","context_id":"context-1","generation":1})))
                .unwrap();
            wait_for_line(&line_receiver);
            input_sender
                .send(frame(serde_json::json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"run-1","context_id":"context-1","generation":1,"run_id":"run-a","source":"import time; time.sleep(0.05); 42"})))
                .unwrap();
            wait_for_line(&line_receiver);
            input_sender.send(StdinInput::Eof).unwrap();
        });
        let mut output = CaptureWriter {
            bytes: Vec::new(),
            lines: line_sender,
        };
        pump_stdin(&mut executor, &input_receiver, &mut output);
        sender.join().unwrap();
        let responses = output.responses();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].request_id.as_deref(), Some("open-1"));
        assert_eq!(responses[1].request_id.as_deref(), Some("run-1"));
        assert_eq!(responses[1].result.as_ref().unwrap()["preview"], "42");
        assert!(!executor.has_pending());
        assert_eq!(executor.close_all(), 1);
    }

    #[test]
    fn stdin_pump_keeps_cancel_readable_and_writes_ordered_pair() {
        let mut executor = executor();
        let (input_sender, input_receiver) = mpsc::sync_channel(1);
        let (line_sender, line_receiver) = mpsc::channel();
        let sender = thread::spawn(move || {
            input_sender
                .send(frame(serde_json::json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"open-1","context_id":"context-1","generation":1})))
                .unwrap();
            wait_for_line(&line_receiver);
            input_sender
                .send(frame(serde_json::json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"run-1","context_id":"context-1","generation":1,"run_id":"run-a","source":"import time; time.sleep(30)"})))
                .unwrap();
            input_sender
                .send(frame(serde_json::json!({"op":"cancel","protocol":PROTOCOL_VERSION,"request_id":"cancel-1","context_id":"context-1","generation":1,"target_request_id":"run-1","run_id":"run-a"})))
                .unwrap();
            wait_for_line(&line_receiver);
            wait_for_line(&line_receiver);
            input_sender.send(StdinInput::Eof).unwrap();
        });
        let mut output = CaptureWriter {
            bytes: Vec::new(),
            lines: line_sender,
        };
        pump_stdin(&mut executor, &input_receiver, &mut output);
        sender.join().unwrap();
        let responses = output.responses();
        assert_eq!(responses.len(), 3);
        assert_eq!(responses[1].request_id.as_deref(), Some("run-1"));
        assert_eq!(responses[1].failure_kind.as_deref(), Some("cancelled"));
        assert_eq!(responses[2].request_id.as_deref(), Some("cancel-1"));
        assert!(responses[2].ok);
        assert!(!executor.has_pending());
        let contexts = executor.coordinator.context_count();
        assert!(contexts <= 1);
        assert_eq!(executor.close_all(), contexts);
    }

    #[test]
    fn stdin_eof_cancels_and_reaps_without_fake_completion() {
        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("python.pid");
        let python_path = serde_json::to_string(pid_file.to_str().unwrap()).unwrap();
        let source = format!(
            "import os,time; open({python_path}, 'w').write(str(os.getpid())); time.sleep(30)"
        );
        let mut executor = executor();
        let (input_sender, input_receiver) = mpsc::sync_channel(1);
        let (line_sender, line_receiver) = mpsc::channel();
        let sender_pid_file = pid_file.clone();
        let sender = thread::spawn(move || {
            input_sender
                .send(frame(serde_json::json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"open-1","context_id":"context-1","generation":1})))
                .unwrap();
            wait_for_line(&line_receiver);
            input_sender
                .send(frame(serde_json::json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"run-1","context_id":"context-1","generation":1,"run_id":"run-a","source":source})))
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while fs::read_to_string(&sender_pid_file)
                .ok()
                .and_then(|value| value.parse::<u32>().ok())
                .is_none()
            {
                assert!(
                    std::time::Instant::now() < deadline,
                    "python PID witness timed out"
                );
                thread::yield_now();
            }
            input_sender.send(StdinInput::Eof).unwrap();
        });
        let mut output = CaptureWriter {
            bytes: Vec::new(),
            lines: line_sender,
        };
        pump_stdin(&mut executor, &input_receiver, &mut output);
        sender.join().unwrap();
        let responses = output.responses();
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].request_id.as_deref(), Some("open-1"));
        assert!(executor.has_pending());
        let pid: u32 = fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        assert_eq!(executor.close_all(), 1);
        assert!(!executor.has_pending());
        assert!(!Path::new("/proc").join(pid.to_string()).exists());
    }

    #[test]
    fn opens_runs_and_closes_persistent_context() {
        let mut executor = executor();
        let opened = only(submit_json(
            &mut executor,
            serde_json::json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"r1","context_id":"c1","generation":1}),
        ));
        assert!(opened.ok);
        assert!(
            submit_json(
                &mut executor,
                serde_json::json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"r2","context_id":"c1","generation":1,"run_id":"run-1","source":"x = 21"}),
            )
            .is_none()
        );
        assert!(only(Some(wait_group(&mut executor))).ok);
        assert!(
            submit_json(
                &mut executor,
                serde_json::json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"r3","context_id":"c1","generation":1,"run_id":"run-2","source":"x * 2"}),
            )
            .is_none()
        );
        let value = only(Some(wait_group(&mut executor)));
        assert_eq!(value.result.unwrap()["preview"], "42");
        let closed = only(submit_json(
            &mut executor,
            serde_json::json!({"op":"close","protocol":PROTOCOL_VERSION,"request_id":"r4","context_id":"c1","generation":1}),
        ));
        assert!(closed.ok);
    }

    #[test]
    fn cancel_is_active_and_returns_run_then_cancel_pair() {
        let mut executor = executor();
        assert!(only(submit_json(
            &mut executor,
            serde_json::json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"open-1","context_id":"context-1","generation":1}),
        )).ok);
        assert!(submit_json(
            &mut executor,
            serde_json::json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"request-1","context_id":"context-1","generation":1,"run_id":"run-1","source":"import time; time.sleep(30)"}),
        ).is_none());
        let immediate = submit_json(
            &mut executor,
            serde_json::json!({"op":"cancel","protocol":PROTOCOL_VERSION,"request_id":"cancel-1","context_id":"context-1","generation":1,"target_request_id":"request-1","run_id":"run-1"}),
        );
        let group = immediate.unwrap_or_else(|| wait_group(&mut executor));
        let DispatchGroup::Pair(responses) = group else {
            panic!("cancellation did not return an ordered pair");
        };
        let [run, cancel] = *responses;
        assert_eq!(run.request_id.as_deref(), Some("request-1"));
        assert_eq!(run.failure_kind.as_deref(), Some("cancelled"));
        assert_eq!(cancel.request_id.as_deref(), Some("cancel-1"));
        assert!(cancel.ok);
    }

    #[test]
    fn rejects_unknown_fields_before_effect() {
        let mut executor = executor();
        let response = only(submit_json(
            &mut executor,
            serde_json::json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"r1","context_id":"c1","generation":1,"unexpected":true}),
        ));
        assert!(!response.ok);
        assert_eq!(executor.coordinator.context_count(), 0);
    }

    #[test]
    fn frame_reader_rejects_oversized_input_without_unbounded_growth() {
        let bytes = vec![b'x'; MAX_FRAME_BYTES + 1];
        let mut reader = std::io::BufReader::new(bytes.as_slice());
        let error = read_request_frame(&mut reader).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    fn startup(values: &[(&str, &str)]) -> Result<StartupConfig, String> {
        StartupConfig::from_lookup(|name| {
            values
                .iter()
                .find_map(|(key, value)| (*key == name).then(|| OsString::from(value)))
        })
    }

    #[test]
    fn mode_is_explicit_and_outbound_configuration_cannot_bleed_into_stdin() {
        assert!(startup(&[]).is_err());
        assert!(startup(&[("ELPIS_EXECUTOR_MODE", "unknown")]).is_err());
        assert!(
            startup(&[
                ("ELPIS_EXECUTOR_MODE", "stdin"),
                ("ELPIS_EXECUTOR_STATE_DIR", "/tmp/elpis-executor-state"),
                (
                    "ELPIS_EXECUTOR_LINK_ENDPOINT",
                    "wss://executor.example/link"
                ),
            ])
            .is_err()
        );
        let stdin = startup(&[
            ("ELPIS_EXECUTOR_MODE", "stdin"),
            ("ELPIS_EXECUTOR_STATE_DIR", "/tmp/elpis-executor-state"),
        ])
        .unwrap();
        assert_eq!(stdin.mode, ModeConfig::Stdin);
    }

    #[test]
    fn outbound_configuration_requires_every_absolute_nonsecret_binding() {
        let valid = [
            ("ELPIS_EXECUTOR_MODE", "outbound"),
            ("ELPIS_EXECUTOR_STATE_DIR", "/tmp/elpis-executor-state"),
            (
                "ELPIS_EXECUTOR_LINK_ENDPOINT",
                "wss://executor.example/link",
            ),
            ("ELPIS_EXECUTOR_TLS_SERVER_NAME", "executor.example"),
            ("ELPIS_EXECUTOR_TLS_ROOT_FILE", "/tmp/root.der"),
        ];
        let parsed = startup(&valid).unwrap();
        assert!(matches!(parsed.mode, ModeConfig::Outbound(_)));
        for index in 0..valid.len() {
            let missing = valid
                .iter()
                .enumerate()
                .filter_map(|(candidate, value)| (candidate != index).then_some(*value))
                .collect::<Vec<_>>();
            assert!(startup(&missing).is_err(), "missing {}", valid[index].0);
        }
        let mut relative_state = valid;
        relative_state[1].1 = "relative";
        assert!(startup(&relative_state).is_err());
        let mut relative_root = valid;
        relative_root[4].1 = "root.der";
        assert!(startup(&relative_root).is_err());
    }

    #[test]
    fn parsed_stdin_and_link_dispatch_paths_have_identical_semantics() {
        let request = Request::Validate {
            protocol: PROTOCOL_VERSION,
            request_id: "same-request".into(),
            source: "40 + 2".into(),
        };
        let mut parsed = executor();
        let parsed_request = decode_request(&serde_json::to_vec(&request).unwrap()).unwrap();
        let parsed = parsed.submit(parsed_request);
        let mut linked = executor();
        let linked = linked.submit(request);
        assert_eq!(parsed, linked);
    }

    #[test]
    fn state_root_and_trust_anchor_loading_fail_closed() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("state");
        ensure_private_state_root(&state).unwrap();
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        fs::set_permissions(&state, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_private_state_root(&state).is_err());

        let root = temp.path().join("root.der");
        fs::write(&root, [1_u8, 2, 3]).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_root_der(&root).unwrap(), vec![1, 2, 3]);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(read_root_der(&root).is_err());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o644)).unwrap();
        let linked = temp.path().join("linked.der");
        symlink(&root, &linked).unwrap();
        assert!(read_root_der(&linked).is_err());
        let oversized = temp.path().join("oversized.der");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_ROOT_DER_BYTES + 1)
            .unwrap();
        assert!(read_root_der(&oversized).is_err());
    }

    #[test]
    fn durable_boot_epoch_reuses_bound_value_and_generates_valid_unbound_value() {
        let bound = "00112233445566778899aabbccddeeff".to_string();
        assert_eq!(select_boot_epoch(Some(bound.clone())).unwrap(), bound);
        let generated = select_boot_epoch(None).unwrap();
        assert_eq!(generated.len(), 32);
        assert!(
            generated
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
    }
}
