use elpis_protocol::{MAX_FRAME_BYTES, MAX_SOURCE_BYTES, validate_id};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use thiserror::Error;

mod actor;
pub use actor::{
    CancelOutcome, PythonContextActor, PythonRunControl, PythonRunHandle, RunState, RunTerminal,
};

const BOOTSTRAP: &str = include_str!("bootstrap.py");

/// Limits for the deliberately small, synchronous guest-to-host bridge. These
/// are below the child protocol frame limit so every valid value fits one frame.
pub const MAX_HOST_CALLS_PER_RUN: usize = 64;
pub const MAX_HOST_CAPABILITY_BYTES: usize = 120;
pub const MAX_HOST_ARGV_ITEMS: usize = 64;
pub const MAX_HOST_ARG_BYTES: usize = 4096;
pub const MAX_HOST_ARGV_BYTES: usize = 65_536;
pub const MAX_HOST_STDIN_BYTES: usize = 65_536;
pub const MAX_HOST_RESULT_BYTES: usize = 65_536;
pub const MAX_HOST_ERROR_BYTES: usize = 4096;

#[derive(Debug, Error)]
pub enum PythonError {
    #[error("python executable is unavailable: {0}")]
    Unavailable(#[source] std::io::Error),
    #[error("python protocol IO failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("python protocol returned EOF")]
    Eof,
    #[error("python protocol frame exceeds {MAX_FRAME_BYTES} bytes")]
    FrameTooLarge,
    #[error("python protocol frame is invalid: {0}")]
    InvalidFrame(#[from] serde_json::Error),
    #[error("python context binding mismatch")]
    Binding,
    #[error("run id was already used in this context")]
    DuplicateRun,
    #[error("source exceeds {MAX_SOURCE_BYTES} bytes")]
    SourceTooLarge,
    #[error("python syntax validation failed: {0}")]
    Syntax(String),
    #[error("python context already has an active run")]
    Busy,
    #[error("python context is invalid")]
    InvalidContext,
    #[error("python run was cancelled")]
    Cancelled,
    #[error("python context actor is closed")]
    ActorClosed,
    #[error("python host-call protocol is invalid: {0}")]
    InvalidHostCall(&'static str),
    #[error("python host-call service returned an invalid result: {0}")]
    InvalidHostResult(&'static str),
}

/// One validated request made by guest Python during a Run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostCall {
    pub call_index: u64,
    pub capability: String,
    pub argv: Vec<String>,
    pub stdin: String,
}

impl HostCall {
    pub fn validate(&self) -> Result<(), PythonError> {
        validate_id(
            "host capability",
            &self.capability,
            MAX_HOST_CAPABILITY_BYTES,
        )
        .map_err(|_| PythonError::InvalidHostCall("invalid capability"))?;
        if self.argv.len() > MAX_HOST_ARGV_ITEMS {
            return Err(PythonError::InvalidHostCall("too many argv items"));
        }
        let mut argv_bytes = 0usize;
        for argument in &self.argv {
            if argument.len() > MAX_HOST_ARG_BYTES {
                return Err(PythonError::InvalidHostCall("argv item is too large"));
            }
            if argument.as_bytes().contains(&0) {
                return Err(PythonError::InvalidHostCall("argv item contains NUL"));
            }
            argv_bytes = argv_bytes
                .checked_add(argument.len())
                .ok_or(PythonError::InvalidHostCall("argv is too large"))?;
        }
        if argv_bytes > MAX_HOST_ARGV_BYTES {
            return Err(PythonError::InvalidHostCall("argv is too large"));
        }
        if self.stdin.len() > MAX_HOST_STDIN_BYTES {
            return Err(PythonError::InvalidHostCall("stdin is too large"));
        }
        Ok(())
    }
}

/// The only value a host service can deliver back to guest Python.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostResult {
    pub ok: bool,
    #[serde(default)]
    pub result: String,
    pub error: Option<String>,
}

impl HostResult {
    pub fn accepted(result: impl Into<String>) -> Self {
        Self {
            ok: true,
            result: result.into(),
            error: None,
        }
    }

    pub fn rejected(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: String::new(),
            error: Some(error.into()),
        }
    }

    pub fn validate(&self) -> Result<(), PythonError> {
        if self.result.len() > MAX_HOST_RESULT_BYTES {
            return Err(PythonError::InvalidHostResult("result is too large"));
        }
        match (self.ok, self.error.as_deref()) {
            (true, None) => Ok(()),
            (false, Some(error))
                if self.result.is_empty()
                    && !error.is_empty()
                    && error.len() <= MAX_HOST_ERROR_BYTES =>
            {
                Ok(())
            }
            (false, Some(error)) if error.len() > MAX_HOST_ERROR_BYTES => {
                Err(PythonError::InvalidHostResult("error is too large"))
            }
            _ => Err(PythonError::InvalidHostResult("invalid result shape")),
        }
    }
}

/// The started portion of one host call.
///
/// Implementations that own a subprocess or another asynchronous service handle
/// must not report a result until that operation can be reaped.  The runtime
/// nevertheless calls [`ActiveHostCall::wait_reaped`] on every completion and cancellation path,
/// so run ownership is not released while a host child remains unreaped.
pub trait ActiveHostCall: Send {
    /// Poll without blocking.  A returned result is not sent to Python until
    /// [`ActiveHostCall::wait_reaped`] has succeeded.
    fn try_wait(&mut self) -> Result<Option<HostResult>, PythonError>;

    /// Request cancellation or kill the underlying operation.  This method may
    /// be called after a racing natural completion and must be idempotent.
    fn cancel(&mut self) -> Result<(), PythonError>;

    /// Wait until every resource owned by this call has been reaped. An
    /// implementation may return an error only after satisfying that postcondition.
    fn wait_reaped(&mut self) -> Result<(), PythonError>;
}

/// The outcome of linearizing a host-call start.
pub enum HostCallStart {
    /// The service completed synchronously.  This is intended for bounded,
    /// non-subprocess services and for explicit rejection.
    Complete(HostResult),
    /// A call started and is now in actor custody.
    Active(Box<dyn ActiveHostCall>),
}

impl std::fmt::Debug for HostCallStart {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Complete(result) => formatter.debug_tuple("Complete").field(result).finish(),
            Self::Active(_) => formatter.write_str("Active(<host-call handle>)"),
        }
    }
}

/// A host implementation supplied for one Run.
///
/// Existing bounded synchronous services only need to implement
/// [`HostCallService::call`]. Services which can outlive the call to
/// [`HostCallService::start`] (in particular services backed by a subprocess)
/// must override it and return an [`ActiveHostCall`], giving the actor explicit
/// cancel/kill/reap custody. `start` itself must be bounded and must not wait for
/// the operation it starts. Returning an error means no live operation escaped;
/// once an operation may exist, `start` must return it in `HostCallStart::Active`.
pub trait HostCallService: Send {
    fn call(&mut self, call: &HostCall) -> HostResult;

    fn start(&mut self, call: &HostCall) -> Result<HostCallStart, PythonError> {
        Ok(HostCallStart::Complete(self.call(call)))
    }
}

impl<T: HostCallService + ?Sized> HostCallService for Box<T> {
    fn call(&mut self, call: &HostCall) -> HostResult {
        (**self).call(call)
    }

    fn start(&mut self, call: &HostCall) -> Result<HostCallStart, PythonError> {
        (**self).start(call)
    }
}

pub(crate) enum HostCallPoll {
    Pending,
    Complete(HostResult),
    Cancelled,
}

/// Internal synchronization seam used by the context actor.  Implementations
/// linearize start, completion, and cancellation while the RunEntry is locked.
pub(crate) trait HostCallCustody {
    fn start(
        &mut self,
        service: &mut dyn HostCallService,
        call: &HostCall,
    ) -> Result<HostCallStart, PythonError>;

    fn poll(&mut self, active: &mut dyn ActiveHostCall) -> Result<HostCallPoll, PythonError>;

    fn cancel_and_reap(&mut self, active: &mut dyn ActiveHostCall) -> Result<(), PythonError>;
}

struct DirectHostCallCustody;

impl HostCallCustody for DirectHostCallCustody {
    fn start(
        &mut self,
        service: &mut dyn HostCallService,
        call: &HostCall,
    ) -> Result<HostCallStart, PythonError> {
        service.start(call)
    }

    fn poll(&mut self, active: &mut dyn ActiveHostCall) -> Result<HostCallPoll, PythonError> {
        match active.try_wait()? {
            Some(result) => {
                active.wait_reaped()?;
                Ok(HostCallPoll::Complete(result))
            }
            None => Ok(HostCallPoll::Pending),
        }
    }

    fn cancel_and_reap(&mut self, active: &mut dyn ActiveHostCall) -> Result<(), PythonError> {
        let cancelled = active.cancel();
        let reaped = active.wait_reaped();
        cancelled.and(reaped)
    }
}

/// Explicit rejecting service used by the ordinary, effect-free Run API.
#[derive(Debug, Default, Clone, Copy)]
pub struct RejectHostCalls;

impl HostCallService for RejectHostCalls {
    fn call(&mut self, _call: &HostCall) -> HostResult {
        HostResult::rejected("host calls are disabled for this run")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RunResult {
    pub ok: bool,
    pub kind: String,
    #[serde(default)]
    pub has_value: bool,
    pub saved_as: Option<String>,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub preview_bytes: usize,
    #[serde(default)]
    pub preview_truncated: bool,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stdout_bytes: usize,
    #[serde(default)]
    pub stdout_truncated: bool,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub stderr_bytes: usize,
    #[serde(default)]
    pub stderr_truncated: bool,
    pub failure_kind: Option<String>,
    pub error: Option<String>,
}

impl RunResult {
    fn validate_terminal(&self) -> Result<(), PythonError> {
        match (
            self.ok,
            self.kind.as_str(),
            self.failure_kind.as_deref(),
            self.error.as_deref(),
        ) {
            (true, "completed", None, None) => Ok(()),
            (false, "failed", Some("preparse"), Some(_))
            | (false, "failed", Some("runtime"), Some(_)) => Ok(()),
            _ => Err(PythonError::InvalidHostCall("unexpected terminal frame")),
        }
    }
}

#[derive(Serialize)]
struct ChildRun<'a> {
    op: &'static str,
    run_id: &'a str,
    source: &'a str,
    preview_max_bytes: usize,
}

#[derive(Serialize)]
struct ChildClose {
    op: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildHostCall {
    op: String,
    call_index: u64,
    capability: String,
    argv: Vec<String>,
    stdin: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ChildFrame {
    HostCall(ChildHostCall),
    Terminal(RunResult),
}

#[derive(Serialize)]
struct ChildHostResult<'a> {
    op: &'static str,
    call_index: u64,
    ok: bool,
    result: &'a str,
    error: Option<&'a str>,
}

#[derive(Debug, Clone)]
enum PythonExecutable {
    Path(PathBuf),
    Verified(Arc<File>),
}

#[derive(Debug, Clone)]
pub struct PythonRuntime {
    executable: PythonExecutable,
    isolated: bool,
}

impl PythonRuntime {
    pub fn system(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: PythonExecutable::Path(executable.into()),
            isolated: false,
        }
    }

    pub fn isolated(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: PythonExecutable::Path(executable.into()),
            isolated: true,
        }
    }

    pub fn isolated_verified(executable: File) -> Self {
        Self {
            executable: PythonExecutable::Verified(Arc::new(executable)),
            isolated: true,
        }
    }

    fn command(&self) -> Command {
        let mut command = match &self.executable {
            PythonExecutable::Path(path) => Command::new(path),
            PythonExecutable::Verified(file) => {
                Command::new(format!("/proc/self/fd/{}", file.as_raw_fd()))
            }
        };
        if self.isolated {
            command.args(["-I", "-B"]);
        }
        command
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONSTARTUP")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1");
        command
    }
}

pub(crate) struct RunInvocation<'a> {
    pub(crate) context_id: &'a str,
    pub(crate) generation: u64,
    pub(crate) run_id: &'a str,
    pub(crate) source: &'a str,
    pub(crate) preview_max_bytes: usize,
}

pub struct PythonContext {
    context_id: String,
    generation: u64,
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    seen_runs: HashSet<String>,
    closed: bool,
    reaped: bool,
}

impl PythonContext {
    pub fn validate_source(runtime: &PythonRuntime, source: &str) -> Result<(), PythonError> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(PythonError::SourceTooLarge);
        }
        let mut child = runtime
            .command()
            .args([
                "-c",
                "import ast,sys; ast.parse(sys.stdin.read(), '<elpis-python>', 'exec')",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(PythonError::Unavailable)?;
        child
            .stdin
            .take()
            .ok_or_else(|| PythonError::Io(io::Error::other("python stdin pipe is missing")))?
            .write_all(source.as_bytes())?;
        let output = child.wait_with_output()?;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(PythonError::Syntax(detail.chars().take(4096).collect()))
    }

    pub fn open(
        runtime: &PythonRuntime,
        context_id: String,
        generation: u64,
    ) -> Result<Self, PythonError> {
        validate_id("context_id", &context_id, 120).map_err(|_| PythonError::Binding)?;
        if generation == 0 {
            return Err(PythonError::Binding);
        }
        let mut command = runtime.command();
        command
            .args(["-u", "-c", BOOTSTRAP])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "linux")]
        // SAFETY: this closure only invokes the async-signal-safe setpgid syscall.
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(PythonError::Unavailable)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| PythonError::Io(io::Error::other("python stdin pipe is missing")))?;
        let output =
            BufReader::new(child.stdout.take().ok_or_else(|| {
                PythonError::Io(io::Error::other("python stdout pipe is missing"))
            })?);
        Ok(Self {
            context_id,
            generation,
            child,
            input,
            output,
            seen_runs: HashSet::new(),
            closed: false,
            reaped: false,
        })
    }

    pub fn binding(&self) -> (&str, u64) {
        (&self.context_id, self.generation)
    }

    pub fn run(
        &mut self,
        context_id: &str,
        generation: u64,
        run_id: &str,
        source: &str,
        preview_max_bytes: usize,
    ) -> Result<RunResult, PythonError> {
        let mut service = RejectHostCalls;
        self.run_with_host_service(
            context_id,
            generation,
            run_id,
            source,
            preview_max_bytes,
            &mut service,
        )
    }

    /// Run guest code while synchronously servicing its bounded host calls.
    /// The service is borrowed only for this Run and is never retained by the
    /// context. Calls are serialized in exact call_index order.
    pub fn run_with_host_service(
        &mut self,
        context_id: &str,
        generation: u64,
        run_id: &str,
        source: &str,
        preview_max_bytes: usize,
        service: &mut dyn HostCallService,
    ) -> Result<RunResult, PythonError> {
        let mut custody = DirectHostCallCustody;
        self.run_with_host_service_in_custody(
            RunInvocation {
                context_id,
                generation,
                run_id,
                source,
                preview_max_bytes,
            },
            service,
            &mut custody,
        )
    }

    pub(crate) fn run_with_host_service_in_custody(
        &mut self,
        invocation: RunInvocation<'_>,
        service: &mut dyn HostCallService,
        custody: &mut dyn HostCallCustody,
    ) -> Result<RunResult, PythonError> {
        let RunInvocation {
            context_id,
            generation,
            run_id,
            source,
            preview_max_bytes,
        } = invocation;
        if self.closed || context_id != self.context_id || generation != self.generation {
            return Err(PythonError::Binding);
        }
        validate_id("run_id", run_id, 120).map_err(|_| PythonError::Binding)?;
        if source.len() > MAX_SOURCE_BYTES {
            return Err(PythonError::SourceTooLarge);
        }
        if !self.seen_runs.insert(run_id.to_string()) {
            return Err(PythonError::DuplicateRun);
        }
        if !self.output.buffer().is_empty() {
            self.fail_closed();
            return Err(PythonError::InvalidHostCall("unexpected pending frame"));
        }
        self.write_frame(&ChildRun {
            op: "run",
            run_id,
            source,
            preview_max_bytes,
        })?;
        self.run_host_frame_loop(service, custody)
    }

    fn run_host_frame_loop(
        &mut self,
        service: &mut dyn HostCallService,
        custody: &mut dyn HostCallCustody,
    ) -> Result<RunResult, PythonError> {
        let result = self.host_frame_loop(service, custody);
        if result.is_err() {
            // A malformed frame, failed service, or cancellation can leave the
            // child blocked waiting for a reply.  Fail the protocol closed.
            self.fail_closed();
        }
        result
    }

    fn fail_closed(&mut self) {
        self.closed = true;
        // Process groups are the Linux containment boundary. Killing the leader
        // as well guarantees EOF on platforms where group signalling is not
        // available, so a blocked bridge read cannot deadlock close/drop.
        let _ = self.signal_group(libc::SIGKILL);
        let _ = self.child.kill();
    }

    fn host_frame_loop(
        &mut self,
        service: &mut dyn HostCallService,
        custody: &mut dyn HostCallCustody,
    ) -> Result<RunResult, PythonError> {
        let mut expected_index = 0u64;
        loop {
            match self.read_frame::<ChildFrame>()? {
                ChildFrame::Terminal(result) => {
                    result.validate_terminal()?;
                    return Ok(result);
                }
                ChildFrame::HostCall(frame) => {
                    if frame.op != "host_call" {
                        return Err(PythonError::InvalidHostCall("unexpected frame operation"));
                    }
                    if frame.call_index != expected_index {
                        return Err(PythonError::InvalidHostCall(
                            "call_index is not the next index",
                        ));
                    }
                    if usize::try_from(expected_index)
                        .map_or(true, |index| index >= MAX_HOST_CALLS_PER_RUN)
                    {
                        return Err(PythonError::InvalidHostCall("too many calls in one run"));
                    }
                    let call = HostCall {
                        call_index: frame.call_index,
                        capability: frame.capability,
                        argv: frame.argv,
                        stdin: frame.stdin,
                    };
                    call.validate()?;
                    let host_result = match custody.start(service, &call)? {
                        HostCallStart::Complete(result) => result,
                        HostCallStart::Active(mut active) => loop {
                            match custody.poll(active.as_mut()) {
                                Ok(HostCallPoll::Complete(result)) => break result,
                                Ok(HostCallPoll::Cancelled) => {
                                    return Err(PythonError::Cancelled);
                                }
                                Ok(HostCallPoll::Pending) => {
                                    if self.has_exited_unreaped()? {
                                        // Recheck cancellation/completion after observing
                                        // the Python exit, then reap the host operation on
                                        // every still-active path.
                                        match custody.poll(active.as_mut()) {
                                            Ok(HostCallPoll::Complete(_)) => {}
                                            Ok(HostCallPoll::Cancelled) => {
                                                return Err(PythonError::Cancelled);
                                            }
                                            Ok(HostCallPoll::Pending) | Err(_) => {
                                                custody.cancel_and_reap(active.as_mut())?;
                                            }
                                        }
                                        return Err(PythonError::Eof);
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(2));
                                }
                                Err(error) => {
                                    let cleanup = custody.cancel_and_reap(active.as_mut());
                                    return cleanup.map_or_else(Err, |_| Err(error));
                                }
                            }
                        },
                    };
                    host_result.validate()?;
                    self.write_frame(&ChildHostResult {
                        op: "host_result",
                        call_index: expected_index,
                        ok: host_result.ok,
                        result: &host_result.result,
                        error: host_result.error.as_deref(),
                    })?;
                    expected_index = expected_index
                        .checked_add(1)
                        .ok_or(PythonError::InvalidHostCall("call_index overflow"))?;
                }
            }
        }
    }

    pub fn close(&mut self) -> Result<(), PythonError> {
        if self.closed && self.reaped {
            return Ok(());
        }
        self.closed = true;

        // A graceful close gives the interpreter a chance to emit its final frame.  We
        // still terminate the group before reaping the leader: guest code may have left
        // descendants behind, and a pgid is safe to address only while our leader is an
        // unreaped child.
        if !self.reaped {
            let _ = self.write_frame(&ChildClose { op: "close" });
            let _ = self.read_frame::<RunResult>();
            let _ = self.signal_group(libc::SIGKILL);
            self.wait_reaped()?;
        }
        Ok(())
    }

    pub(crate) fn leader_pid(&self) -> u32 {
        self.child.id()
    }

    pub(crate) fn signal_group(&self, signal: libc::c_int) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            let pid = libc::pid_t::try_from(self.child.id())
                .map_err(|_| io::Error::other("python child pid is out of range"))?;
            // SAFETY: kill is called with the dedicated child process group's negative id.
            let result = unsafe { libc::kill(-pid, signal) };
            if result == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "python context cancellation requires Linux process groups",
            ));
        }
        Ok(())
    }

    pub(crate) fn wait_reaped(&mut self) -> io::Result<std::process::ExitStatus> {
        if self.reaped {
            return Err(io::Error::other("python child was already reaped"));
        }
        let status = loop {
            match self.child.wait() {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => break result?,
            }
        };
        self.reaped = true;
        self.closed = true;
        Ok(status)
    }

    pub(crate) fn was_reaped(&self) -> bool {
        self.reaped
    }

    pub(crate) fn has_exited_unreaped(&self) -> io::Result<bool> {
        if self.reaped {
            return Ok(true);
        }
        #[cfg(target_os = "linux")]
        {
            let pid = libc::id_t::try_from(self.child.id())
                .map_err(|_| io::Error::other("python child pid is out of range"))?;
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: waitid writes one siginfo_t and WNOWAIT preserves the child as unreaped.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == -1 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: successful waitid initialized the zeroed siginfo_t.
            let info = unsafe { info.assume_init() };
            Ok(unsafe { info.si_pid() } != 0)
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "python context exit polling requires Linux waitid",
            ))
        }
    }

    fn write_frame<T: Serialize>(&mut self, value: &T) -> Result<(), PythonError> {
        let frame = serde_json::to_vec(value)?;
        if frame.len() > MAX_FRAME_BYTES {
            return Err(PythonError::FrameTooLarge);
        }
        self.input.write_all(&frame)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        Ok(())
    }

    fn read_frame<T: for<'de> Deserialize<'de>>(&mut self) -> Result<T, PythonError> {
        let bytes = read_line_bounded(&mut self.output, MAX_FRAME_BYTES)?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

impl Drop for PythonContext {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn read_line_bounded<R: BufRead>(reader: &mut R, maximum: usize) -> Result<Vec<u8>, PythonError> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(PythonError::Eof);
        }
        if let Some(end) = available.iter().position(|byte| *byte == b'\n') {
            if output.len() + end > maximum {
                return Err(PythonError::FrameTooLarge);
            }
            output.extend_from_slice(&available[..end]);
            reader.consume(end + 1);
            return Ok(output);
        }
        if output.len() + available.len() > maximum {
            return Err(PythonError::FrameTooLarge);
        }
        let length = available.len();
        output.extend_from_slice(available);
        reader.consume(length);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> PythonRuntime {
        PythonRuntime::system("python3")
    }

    #[test]
    fn syntax_validation_executes_nothing() {
        assert!(PythonContext::validate_source(&runtime(), "x =").is_err());
    }

    #[test]
    fn state_and_trailing_values_persist() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let first = context.run("ctx-1", 1, "run-1", "x = 41", 1024).unwrap();
        assert!(first.ok);
        assert!(!first.has_value);
        let second = context.run("ctx-1", 1, "run-2", "x + 1", 1024).unwrap();
        assert_eq!(second.preview, "42");
        assert!(second.has_value);
        let none = context.run("ctx-1", 1, "run-3", "None", 1024).unwrap();
        assert_eq!(none.preview, "None");
        assert!(none.has_value);
        let no_value = context.run("ctx-1", 1, "run-4", "y = 7", 1024).unwrap();
        assert!(!no_value.has_value);
        let prior = context.run("ctx-1", 1, "run-5", "_", 1024).unwrap();
        assert_eq!(prior.preview, "None");
    }

    #[test]
    fn captures_stdout_without_corrupting_protocol() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let result = context
            .run("ctx-1", 1, "run-1", "print('hello')\n6 * 7", 1024)
            .unwrap();
        assert_eq!(result.stdout, "hello\n");
        assert_eq!(result.preview, "42");
    }

    #[test]
    fn rejects_stale_and_duplicate_runs() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 2).unwrap();
        assert!(matches!(
            context.run("ctx-1", 1, "run-1", "1", 1024),
            Err(PythonError::Binding)
        ));
        context.run("ctx-1", 2, "run-1", "1", 1024).unwrap();
        assert!(matches!(
            context.run("ctx-1", 2, "run-1", "1", 1024),
            Err(PythonError::DuplicateRun)
        ));
    }

    #[test]
    fn syntax_failure_does_not_mutate_context() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        context.run("ctx-1", 1, "run-1", "x = 9", 1024).unwrap();
        let failed = context.run("ctx-1", 1, "run-2", "x =", 1024).unwrap();
        assert!(!failed.ok);
        assert_eq!(failed.failure_kind.as_deref(), Some("preparse"));
        let value = context.run("ctx-1", 1, "run-3", "x", 1024).unwrap();
        assert_eq!(value.preview, "9");
    }

    #[test]
    fn runtime_failure_and_close_are_explicit() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let failed = context
            .run("ctx-1", 1, "run-1", "raise RuntimeError('nope')", 1024)
            .unwrap();
        assert!(!failed.ok);
        assert_eq!(failed.failure_kind.as_deref(), Some("runtime"));
        assert!(failed.error.unwrap().contains("RuntimeError: nope"));
        context.close().unwrap();
        context.close().unwrap();
    }

    #[test]
    fn preview_is_utf8_safe_and_original_stdout_cannot_poison_protocol() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let result = context
            .run(
                "ctx-1",
                1,
                "run-1",
                "import sys\nsys.__stdout__.write('poison')\n'🐇' * 20",
                11,
            )
            .unwrap();
        assert!(result.ok);
        assert!(result.preview_truncated);
        assert!(result.preview.len() <= 11);
        assert!(!result.preview.contains('�'));
    }

    #[derive(Default)]
    struct FakeService {
        calls: Vec<HostCall>,
    }

    impl HostCallService for FakeService {
        fn call(&mut self, call: &HostCall) -> HostResult {
            self.calls.push(call.clone());
            HostResult::accepted(format!("{}:{}", call.call_index, call.stdin))
        }
    }

    #[test]
    fn host_call_and_result_bounds_reject_invalid_values() {
        let valid = HostCall {
            call_index: 0,
            capability: "test.echo".into(),
            argv: vec!["arg".into()],
            stdin: "input".into(),
        };
        valid.validate().unwrap();

        let mut invalid_capability = valid.clone();
        invalid_capability.capability.clear();
        assert!(invalid_capability.validate().is_err());

        let mut too_many_items = valid.clone();
        too_many_items.argv = vec![String::new(); MAX_HOST_ARGV_ITEMS + 1];
        assert!(too_many_items.validate().is_err());

        let mut oversized_item = valid.clone();
        oversized_item.argv = vec!["x".repeat(MAX_HOST_ARG_BYTES + 1)];
        assert!(oversized_item.validate().is_err());

        let mut oversized_aggregate = valid.clone();
        oversized_aggregate.argv = vec!["x".repeat(MAX_HOST_ARG_BYTES); MAX_HOST_ARGV_ITEMS];
        assert!(oversized_aggregate.validate().is_err());

        let mut nul_argument = valid.clone();
        nul_argument.argv = vec!["a\0b".into()];
        assert!(nul_argument.validate().is_err());

        let mut oversized_stdin = valid;
        oversized_stdin.stdin = "x".repeat(MAX_HOST_STDIN_BYTES + 1);
        assert!(oversized_stdin.validate().is_err());

        HostResult::accepted("x".repeat(MAX_HOST_RESULT_BYTES))
            .validate()
            .unwrap();
        assert!(
            HostResult::accepted("x".repeat(MAX_HOST_RESULT_BYTES + 1))
                .validate()
                .is_err()
        );
        assert!(HostResult::rejected("").validate().is_err());
        assert!(
            HostResult {
                ok: true,
                result: String::new(),
                error: Some("contradiction".into()),
            }
            .validate()
            .is_err()
        );

        let escaped = "\u{1}";
        let worst_argv =
            vec![escaped.repeat(MAX_HOST_ARG_BYTES); MAX_HOST_ARGV_BYTES / MAX_HOST_ARG_BYTES];
        let worst_call = HostCall {
            call_index: u64::MAX,
            capability: "test.escape".into(),
            argv: worst_argv,
            stdin: escaped.repeat(MAX_HOST_STDIN_BYTES),
        };
        worst_call.validate().unwrap();
        let call_frame = serde_json::to_vec(&serde_json::json!({
            "op": "host_call",
            "call_index": worst_call.call_index,
            "capability": worst_call.capability,
            "argv": worst_call.argv,
            "stdin": worst_call.stdin,
        }))
        .unwrap();
        assert!(call_frame.len() <= MAX_FRAME_BYTES);

        let worst_result = HostResult::accepted(escaped.repeat(MAX_HOST_RESULT_BYTES));
        worst_result.validate().unwrap();
        let result_frame = serde_json::to_vec(&ChildHostResult {
            op: "host_result",
            call_index: u64::MAX,
            ok: worst_result.ok,
            result: &worst_result.result,
            error: worst_result.error.as_deref(),
        })
        .unwrap();
        assert!(result_frame.len() <= MAX_FRAME_BYTES);
    }

    #[test]
    fn services_multiple_ordered_calls_and_reuses_context() {
        let mut context = PythonContext::open(&runtime(), "host-ctx".into(), 1).unwrap();
        let mut service = FakeService::default();
        let result = context
            .run_with_host_service(
                "host-ctx",
                1,
                "host-run-1",
                concat!(
                    "a = host_call('test.echo', ['one'], 'a')\n",
                    "b = host_call('test.echo', ['two'], 'b')\n",
                    "a + '|' + b"
                ),
                1024,
                &mut service,
            )
            .unwrap();
        assert_eq!(result.preview, "'0:a|1:b'");
        assert_eq!(service.calls.len(), 2);
        assert_eq!(service.calls[0].call_index, 0);
        assert_eq!(service.calls[1].call_index, 1);
        assert_eq!(service.calls[1].argv, ["two"]);

        let reused = context
            .run_with_host_service(
                "host-ctx",
                1,
                "host-run-2",
                "host_call('test.echo', [], 'again')",
                1024,
                &mut service,
            )
            .unwrap();
        assert_eq!(reused.preview, "'0:again'");
        assert_eq!(service.calls[2].call_index, 0);
    }

    #[test]
    fn ordinary_run_explicitly_rejects_host_calls_and_remains_reusable() {
        let mut context = PythonContext::open(&runtime(), "no-host".into(), 1).unwrap();
        let rejected = context
            .run(
                "no-host",
                1,
                "no-host-1",
                "host_call('test.echo', [], '')",
                1024,
            )
            .unwrap();
        assert!(!rejected.ok);
        assert!(rejected.error.unwrap().contains("host calls are disabled"));
        let ordinary = context
            .run("no-host", 1, "no-host-2", "6 * 7", 1024)
            .unwrap();
        assert_eq!(ordinary.preview, "42");
    }

    #[test]
    fn bridge_restores_hidden_standard_stream_bindings_each_run() {
        let mut context = PythonContext::open(&runtime(), "hidden".into(), 1).unwrap();
        let mutated = context
            .run(
                "hidden",
                1,
                "hidden-1",
                concat!(
                    "import sys\n",
                    "sys.stdin = sys.__stdin__ = 'poison'\n",
                    "sys.stdout = sys.__stdout__ = 'poison'\n",
                    "sys.stderr = sys.__stderr__ = 'poison'\n",
                    "host_call = 'poison'\n",
                    "1"
                ),
                1024,
            )
            .unwrap();
        assert_eq!(mutated.preview, "1");

        let restored = context
            .run(
                "hidden",
                1,
                "hidden-2",
                concat!(
                    "import sys\n",
                    "(sys.stdin is sys.__stdin__, sys.stdin.read(), ",
                    "type(sys.stdin).__name__, callable(host_call), ",
                    "hasattr(host_call, 'wire'), hasattr(host_call, 'fileno'))"
                ),
                1024,
            )
            .unwrap();
        assert_eq!(
            restored.preview,
            "(True, '', 'StringIO', True, False, False)"
        );
    }

    #[test]
    fn oversized_call_never_reaches_service_and_fails_closed() {
        let mut context = PythonContext::open(&runtime(), "bounded".into(), 1).unwrap();
        let mut service = FakeService::default();
        let source = format!(
            "host_call('test.echo', [], '{}')",
            "x".repeat(MAX_HOST_STDIN_BYTES + 1)
        );
        let error = context
            .run_with_host_service("bounded", 1, "bounded-1", &source, 1024, &mut service)
            .unwrap_err();
        assert!(matches!(error, PythonError::InvalidHostCall(_)));
        assert!(service.calls.is_empty());
        assert!(matches!(
            context.run("bounded", 1, "bounded-2", "1", 1024),
            Err(PythonError::Binding)
        ));
    }

    #[test]
    fn too_many_calls_stop_before_the_service_and_reap_the_child() {
        let mut context = PythonContext::open(&runtime(), "many-calls".into(), 1).unwrap();
        let mut service = FakeService::default();
        let source = format!(
            "for _index in range({}):\n    host_call('test.echo', [], '')",
            MAX_HOST_CALLS_PER_RUN + 1
        );
        let error = context
            .run_with_host_service("many-calls", 1, "many-calls-1", &source, 1024, &mut service)
            .unwrap_err();
        assert!(matches!(error, PythonError::InvalidHostCall(_)));
        assert_eq!(service.calls.len(), MAX_HOST_CALLS_PER_RUN);
        assert!(matches!(
            context.run("many-calls", 1, "many-calls-2", "1", 1024),
            Err(PythonError::Binding)
        ));
    }

    #[test]
    fn invalid_service_result_is_not_delivered() {
        struct OversizedResult;
        impl HostCallService for OversizedResult {
            fn call(&mut self, _call: &HostCall) -> HostResult {
                HostResult::accepted("x".repeat(MAX_HOST_RESULT_BYTES + 1))
            }
        }
        let mut context = PythonContext::open(&runtime(), "bad-result".into(), 1).unwrap();
        let error = context
            .run_with_host_service(
                "bad-result",
                1,
                "bad-result-1",
                "host_call('test.echo', [], '')",
                1024,
                &mut OversizedResult,
            )
            .unwrap_err();
        assert!(matches!(error, PythonError::InvalidHostResult(_)));
        assert!(matches!(
            context.run("bad-result", 1, "bad-result-2", "1", 1024),
            Err(PythonError::Binding)
        ));
    }

    #[test]
    fn child_death_is_reported_without_replay() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        context.child.kill().unwrap();
        context.child.wait().unwrap();
        assert!(context.run("ctx-1", 1, "run-1", "40 + 2", 1024).is_err());
    }
}
