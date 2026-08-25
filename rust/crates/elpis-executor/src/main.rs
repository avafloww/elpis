#[cfg(all(not(feature = "embedded-python"), not(debug_assertions)))]
compile_error!("release builds require the embedded-python feature");

use elpis_identity::{CredentialPolicy, IdentityStore};
use elpis_journal::{Journal, JournalLimits};
use elpis_link::{
    BackoffPolicy, Dispatcher, DrainSignal, LinkConfig, Supervisor, SupervisorConfig,
    SupervisorExit,
};
use elpis_protocol::{MAX_FRAME_BYTES, Request, Response};
use elpis_python::{PythonContext, PythonError, PythonRuntime};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::json;
use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::{Handle as SignalHandle, Signals};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[cfg(feature = "embedded-python")]
include!(concat!(env!("OUT_DIR"), "/python_bundle.rs"));

const MAX_ROOT_DER_BYTES: u64 = 64 * 1024;
const MAX_CREDENTIAL_LIFETIME: Duration = Duration::from_secs(31 * 24 * 60 * 60);

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
        ModeConfig::Stdin => {
            run_stdin(&mut executor);
            Ok(())
        }
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
    runtime: ExecutorRuntime,
    contexts: HashMap<String, PythonContext>,
}

impl ExecutorDispatcher {
    fn new(runtime: ExecutorRuntime) -> Self {
        Self {
            runtime,
            contexts: HashMap::new(),
        }
    }

    fn handle_line(&mut self, line: &str) -> Response {
        handle(line, &mut self.contexts, &self.runtime.python)
    }

    fn close_all(&mut self) -> usize {
        let open_contexts = self.contexts.len();
        for context in self.contexts.values_mut() {
            let _ = context.close();
        }
        self.contexts.clear();
        open_contexts
    }
}

impl Dispatcher for ExecutorDispatcher {
    fn dispatch(&mut self, request: Request) -> Response {
        handle_request(request, &mut self.contexts, &self.runtime.python)
    }
}

fn run_stdin(executor: &mut ExecutorDispatcher) {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut stdout = io::stdout().lock();
    loop {
        let frame = match read_request_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) => {
                warn!(error = %error, "protocol transport failed");
                let response = Response::failure(None, "protocol", "transport", error.to_string());
                write_response(&mut stdout, &response);
                break;
            }
        };
        let response = match std::str::from_utf8(&frame) {
            Ok(line) => executor.handle_line(line),
            Err(error) => Response::failure(None, "protocol", "protocol", error.to_string()),
        };
        write_response(&mut stdout, &response);
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

fn handle(
    line: &str,
    contexts: &mut HashMap<String, PythonContext>,
    runtime: &PythonRuntime,
) -> Response {
    let request = match serde_json::from_str::<Request>(line) {
        Ok(request) => request,
        Err(error) => return Response::failure(None, "protocol", "protocol", error.to_string()),
    };
    handle_request(request, contexts, runtime)
}

fn handle_request(
    request: Request,
    contexts: &mut HashMap<String, PythonContext>,
    runtime: &PythonRuntime,
) -> Response {
    let request_id = request.request_id().to_string();
    if let Err(error) = request.validate() {
        return Response::failure(Some(request_id), "protocol", "protocol", error.to_string());
    }
    match request {
        Request::Validate { source, .. } => {
            match PythonContext::validate_source(runtime, &source) {
                Ok(()) => Response::success(request_id, "validated", json!({})),
                Err(PythonError::Syntax(error)) => {
                    Response::failure(Some(request_id), "failed", "preparse", error)
                }
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
        Request::Open {
            context_id,
            generation,
            ..
        } => {
            if contexts.contains_key(&context_id) {
                return Response::failure(
                    Some(request_id),
                    "failed",
                    "conflict",
                    "context is already open",
                );
            }
            match PythonContext::open(runtime, context_id.clone(), generation) {
                Ok(context) => {
                    contexts.insert(context_id.clone(), context);
                    Response::success(
                        request_id,
                        "opened",
                        json!({"context_id": context_id, "generation": generation}),
                    )
                }
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
        Request::Run {
            context_id,
            generation,
            run_id,
            source,
            preview_max_bytes,
            ..
        } => {
            let Some(context) = contexts.get_mut(&context_id) else {
                return Response::failure(
                    Some(request_id),
                    "failed",
                    "not_found",
                    "context is not open",
                );
            };
            match context.run(&context_id, generation, &run_id, &source, preview_max_bytes) {
                Ok(result) if result.ok => match serde_json::to_value(result) {
                    Ok(value) => Response::success(request_id, "completed", value),
                    Err(error) => Response::failure(
                        Some(request_id),
                        "failed",
                        "serialization",
                        error.to_string(),
                    ),
                },
                Ok(result) => Response::failure(
                    Some(request_id),
                    result.kind,
                    result.failure_kind.unwrap_or_else(|| "runtime".into()),
                    result.error.unwrap_or_else(|| "python run failed".into()),
                ),
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
        Request::Cancel { .. } => Response::failure(
            Some(request_id),
            "failed",
            "unsupported",
            "cancellation coordinator is not active",
        ),
        Request::Close {
            context_id,
            generation,
            ..
        } => {
            let Some(mut context) = contexts.remove(&context_id) else {
                return Response::success(request_id, "closed", json!({"already_closed": true}));
            };
            if context.binding() != (context_id.as_str(), generation) {
                contexts.insert(context_id, context);
                return Response::failure(
                    Some(request_id),
                    "failed",
                    "binding",
                    "context generation mismatch",
                );
            }
            match context.close() {
                Ok(()) => Response::success(request_id, "closed", json!({"already_closed": false})),
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
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

    fn request(
        value: serde_json::Value,
        contexts: &mut HashMap<String, PythonContext>,
    ) -> Response {
        handle(
            &value.to_string(),
            contexts,
            &PythonRuntime::system("python3"),
        )
    }

    #[test]
    fn opens_runs_and_closes_persistent_context() {
        let mut contexts = HashMap::new();
        let opened = request(
            json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"r1","context_id":"c1","generation":1}),
            &mut contexts,
        );
        assert!(opened.ok);
        let assigned = request(
            json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"r2","context_id":"c1","generation":1,"run_id":"run-1","source":"x = 21"}),
            &mut contexts,
        );
        assert!(assigned.ok);
        let value = request(
            json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"r3","context_id":"c1","generation":1,"run_id":"run-2","source":"x * 2"}),
            &mut contexts,
        );
        assert_eq!(value.result.unwrap()["preview"], "42");
        let closed = request(
            json!({"op":"close","protocol":PROTOCOL_VERSION,"request_id":"r4","context_id":"c1","generation":1}),
            &mut contexts,
        );
        assert!(closed.ok);
    }

    #[test]
    fn cancel_is_explicitly_unsupported_until_coordinator_is_active() {
        let mut contexts = HashMap::new();
        let response = request(
            json!({
                "op": "cancel",
                "protocol": PROTOCOL_VERSION,
                "request_id": "cancel-1",
                "context_id": "context-1",
                "generation": 1,
                "target_request_id": "request-1",
                "run_id": "run-1"
            }),
            &mut contexts,
        );
        assert!(!response.ok);
        assert_eq!(response.kind, "failed");
        assert_eq!(response.failure_kind.as_deref(), Some("unsupported"));
        assert!(contexts.is_empty());
    }

    #[test]
    fn rejects_unknown_fields_before_effect() {
        let mut contexts = HashMap::new();
        let response = handle(
            r#"{"op":"open","protocol":1,"request_id":"r1","context_id":"c1","generation":1,"unexpected":true}"#,
            &mut contexts,
            &PythonRuntime::system("python3"),
        );
        assert!(!response.ok);
        assert!(contexts.is_empty());
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
        let runtime = PythonRuntime::system("python3");
        let mut parsed_contexts = HashMap::new();
        let parsed = handle(
            &serde_json::to_string(&request).unwrap(),
            &mut parsed_contexts,
            &runtime,
        );
        let mut linked_contexts = HashMap::new();
        let linked = handle_request(request, &mut linked_contexts, &runtime);
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            serde_json::to_value(linked).unwrap()
        );
        assert!(parsed_contexts.is_empty());
        assert!(linked_contexts.is_empty());
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
