//! Linux process-group custody for one validated host execution request.

use std::io::{self, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use elpis_effects::ExecutionToken;
use thiserror::Error;

use crate::host_exec::{
    HostExecError, HostExecRequest, HostExecResult, HostExecTermination, MAX_HOST_EXEC_STREAM_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostExecStartDisposition {
    NotStarted,
    MayHaveExecuted,
}

#[derive(Debug)]
pub struct HostExecProcessStartFailure {
    token: ExecutionToken,
    error: HostExecProcessError,
    disposition: HostExecStartDisposition,
}

impl HostExecProcessStartFailure {
    pub fn disposition(&self) -> HostExecStartDisposition {
        self.disposition
    }

    pub fn error(&self) -> &HostExecProcessError {
        &self.error
    }

    pub fn into_parts(
        self,
    ) -> (
        ExecutionToken,
        HostExecProcessError,
        HostExecStartDisposition,
    ) {
        (self.token, self.error, self.disposition)
    }
}

impl std::fmt::Display for HostExecProcessStartFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "host execution start failed ({:?}): {}",
            self.disposition, self.error
        )
    }
}

impl std::error::Error for HostExecProcessStartFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

#[derive(Debug, Error)]
pub enum HostExecProcessError {
    #[error("host execution process custody requires Linux")]
    Unsupported,
    #[error("host execution could not be spawned")]
    Spawn(#[source] io::Error),
    #[error("host execution pipes could not be established")]
    Setup(#[source] io::Error),
    #[error("host execution state could not be observed")]
    Poll(#[source] io::Error),
    #[error("host execution process group could not be signalled")]
    Signal(#[source] io::Error),
    #[error("host execution leader could not be reaped")]
    Reap(#[source] io::Error),
    #[error("host execution stdin writer failed")]
    Stdin(#[source] io::Error),
    #[error("host execution stdout reader failed")]
    Stdout(#[source] io::Error),
    #[error("host execution stderr reader failed")]
    Stderr(#[source] io::Error),
    #[error("host execution I/O worker panicked")]
    WorkerPanicked,
    #[error("host execution stdout exceeded its bound")]
    StdoutTooLarge,
    #[error("host execution stderr exceeded its bound")]
    StderrTooLarge,
    #[error("host execution termination could not be represented")]
    InvalidTermination,
    #[error("host execution result could not be encoded")]
    Result(#[source] HostExecError),
}

#[derive(Debug)]
pub enum HostExecProcessOutcome {
    Completed {
        token: ExecutionToken,
        result: HostExecResult,
    },
    Cancelled {
        token: ExecutionToken,
    },
    Ambiguous {
        token: ExecutionToken,
        error: HostExecProcessError,
    },
}

#[derive(Debug)]
struct BoundedStream {
    bytes: Vec<u8>,
    overflowed: bool,
}

#[derive(Debug)]
struct ReapedResources {
    status: Option<ExitStatus>,
    stdout: Option<BoundedStream>,
    stderr: Option<BoundedStream>,
    error: Option<HostExecProcessError>,
}

pub struct HostExecProcess {
    token: Option<ExecutionToken>,
    child: Child,
    pgid: u32,
    stdin_writer: Option<JoinHandle<io::Result<()>>>,
    stdout_reader: Option<JoinHandle<io::Result<BoundedStream>>>,
    stderr_reader: Option<JoinHandle<io::Result<BoundedStream>>>,
    observed_terminal: bool,
    cancelled: bool,
    reaped: bool,
}

impl std::fmt::Debug for HostExecProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostExecProcess")
            .field("pgid", &self.pgid)
            .field("observed_terminal", &self.observed_terminal)
            .field("cancelled", &self.cancelled)
            .field("reaped", &self.reaped)
            .finish_non_exhaustive()
    }
}

impl HostExecProcess {
    pub fn start(
        token: ExecutionToken,
        request: &HostExecRequest,
    ) -> Result<Self, HostExecProcessStartFailure> {
        #[cfg(not(target_os = "linux"))]
        {
            return Err(HostExecProcessStartFailure {
                token,
                error: HostExecProcessError::Unsupported,
                disposition: HostExecStartDisposition::NotStarted,
            });
        }

        #[cfg(target_os = "linux")]
        {
            let argv = request.argv();
            let mut command = Command::new(&argv[0]);
            command
                .args(&argv[1..])
                .stdin(if request.stdin_bytes().is_empty() {
                    Stdio::null()
                } else {
                    Stdio::piped()
                })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0);
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    return Err(HostExecProcessStartFailure {
                        token,
                        error: HostExecProcessError::Spawn(error),
                        disposition: HostExecStartDisposition::NotStarted,
                    });
                }
            };
            let pgid = child.id();
            let mut process = Self {
                token: Some(token),
                child,
                pgid,
                stdin_writer: None,
                stdout_reader: None,
                stderr_reader: None,
                observed_terminal: false,
                cancelled: false,
                reaped: false,
            };

            let stdout = match process.child.stdout.take() {
                Some(stdout) => stdout,
                None => {
                    return Err(process.fail_started(HostExecProcessError::Setup(
                        io::Error::other("host execution stdout pipe is missing"),
                    )));
                }
            };
            let stderr = match process.child.stderr.take() {
                Some(stderr) => stderr,
                None => {
                    return Err(process.fail_started(HostExecProcessError::Setup(
                        io::Error::other("host execution stderr pipe is missing"),
                    )));
                }
            };
            process.stdout_reader = match thread::Builder::new()
                .name("elpis-host-exec-stdout".into())
                .spawn(move || read_bounded(stdout))
            {
                Ok(handle) => Some(handle),
                Err(error) => {
                    return Err(process.fail_started(HostExecProcessError::Setup(error)));
                }
            };
            process.stderr_reader = match thread::Builder::new()
                .name("elpis-host-exec-stderr".into())
                .spawn(move || read_bounded(stderr))
            {
                Ok(handle) => Some(handle),
                Err(error) => {
                    return Err(process.fail_started(HostExecProcessError::Setup(error)));
                }
            };

            if !request.stdin_bytes().is_empty() {
                let mut stdin = match process.child.stdin.take() {
                    Some(stdin) => stdin,
                    None => {
                        return Err(process.fail_started(HostExecProcessError::Setup(
                            io::Error::other("host execution stdin pipe is missing"),
                        )));
                    }
                };
                let bytes = request.stdin_bytes().to_vec();
                process.stdin_writer = match thread::Builder::new()
                    .name("elpis-host-exec-stdin".into())
                    .spawn(move || stdin.write_all(&bytes))
                {
                    Ok(handle) => Some(handle),
                    Err(error) => {
                        return Err(process.fail_started(HostExecProcessError::Setup(error)));
                    }
                };
            }
            Ok(process)
        }
    }

    pub fn leader_pid(&self) -> u32 {
        self.pgid
    }

    pub fn has_exited_unreaped(&mut self) -> Result<bool, HostExecProcessError> {
        if self.reaped || self.observed_terminal {
            return Ok(true);
        }
        let exited = has_exited_unreaped(self.pgid).map_err(HostExecProcessError::Poll)?;
        self.observed_terminal = exited;
        Ok(exited)
    }

    pub fn cancel(&mut self) -> Result<(), HostExecProcessError> {
        self.cancelled = true;
        signal_group(self.pgid, libc::SIGKILL).map_err(HostExecProcessError::Signal)
    }

    pub fn wait_reaped(mut self) -> HostExecProcessOutcome {
        if !self.observed_terminal && !self.cancelled {
            self.cancelled = true;
        }
        let resources = self.reap_resources();
        let token = self
            .token
            .take()
            .expect("host execution token is consumed exactly once");
        if let Some(error) = resources.error {
            return HostExecProcessOutcome::Ambiguous { token, error };
        }
        if self.cancelled {
            return HostExecProcessOutcome::Cancelled { token };
        }
        let Some(status) = resources.status else {
            return HostExecProcessOutcome::Ambiguous {
                token,
                error: HostExecProcessError::InvalidTermination,
            };
        };
        let Some(stdout) = resources.stdout else {
            return HostExecProcessOutcome::Ambiguous {
                token,
                error: HostExecProcessError::Stdout(io::Error::other(
                    "host execution stdout was not collected",
                )),
            };
        };
        let Some(stderr) = resources.stderr else {
            return HostExecProcessOutcome::Ambiguous {
                token,
                error: HostExecProcessError::Stderr(io::Error::other(
                    "host execution stderr was not collected",
                )),
            };
        };
        if stdout.overflowed {
            return HostExecProcessOutcome::Ambiguous {
                token,
                error: HostExecProcessError::StdoutTooLarge,
            };
        }
        if stderr.overflowed {
            return HostExecProcessOutcome::Ambiguous {
                token,
                error: HostExecProcessError::StderrTooLarge,
            };
        }
        let termination = if let Some(code) = status.code() {
            HostExecTermination::Exited(code)
        } else if let Some(signal) = status.signal() {
            HostExecTermination::Signaled(signal)
        } else {
            return HostExecProcessOutcome::Ambiguous {
                token,
                error: HostExecProcessError::InvalidTermination,
            };
        };
        match HostExecResult::new(termination, stdout.bytes, stderr.bytes) {
            Ok(result) => HostExecProcessOutcome::Completed { token, result },
            Err(error) => HostExecProcessOutcome::Ambiguous {
                token,
                error: HostExecProcessError::Result(error),
            },
        }
    }

    fn fail_started(mut self, error: HostExecProcessError) -> HostExecProcessStartFailure {
        self.cancelled = true;
        let _ = self.reap_resources();
        HostExecProcessStartFailure {
            token: self
                .token
                .take()
                .expect("host execution token is returned after failed setup"),
            error,
            disposition: HostExecStartDisposition::MayHaveExecuted,
        }
    }

    fn reap_resources(&mut self) -> ReapedResources {
        let mut first_error = None;
        if !self.reaped {
            if let Err(error) = signal_group(self.pgid, libc::SIGKILL) {
                set_first_error(&mut first_error, HostExecProcessError::Signal(error));
                if let Err(error) = self.child.kill()
                    && error.kind() != io::ErrorKind::InvalidInput
                {
                    set_first_error(&mut first_error, HostExecProcessError::Signal(error));
                }
            }
            match wait_child(&mut self.child) {
                Ok(status) => {
                    self.reaped = true;
                    if let Err(error) = wait_group_gone(self.pgid) {
                        set_first_error(&mut first_error, HostExecProcessError::Signal(error));
                    }
                    let stdin = join_io(self.stdin_writer.take());
                    if !self.cancelled
                        && let Err(error) = stdin
                    {
                        set_first_error(&mut first_error, HostExecProcessError::Stdin(error));
                    }
                    let stdout = match join_stream(self.stdout_reader.take()) {
                        Ok(stream) => stream,
                        Err(error) => {
                            set_first_error(&mut first_error, error);
                            None
                        }
                    };
                    let stderr = match join_stream(self.stderr_reader.take()) {
                        Ok(stream) => stream,
                        Err(error) => {
                            let error = match error {
                                HostExecProcessError::Stdout(source) => {
                                    HostExecProcessError::Stderr(source)
                                }
                                other => other,
                            };
                            set_first_error(&mut first_error, error);
                            None
                        }
                    };
                    return ReapedResources {
                        status: Some(status),
                        stdout,
                        stderr,
                        error: first_error,
                    };
                }
                Err(error) => {
                    set_first_error(&mut first_error, HostExecProcessError::Reap(error));
                }
            }
        }
        ReapedResources {
            status: None,
            stdout: None,
            stderr: None,
            error: first_error,
        }
    }
}

impl Drop for HostExecProcess {
    fn drop(&mut self) {
        if !self.reaped {
            self.cancelled = true;
            let _ = self.reap_resources();
        }
    }
}

fn set_first_error(slot: &mut Option<HostExecProcessError>, error: HostExecProcessError) {
    if slot.is_none() {
        *slot = Some(error);
    }
}

fn read_bounded(mut reader: impl Read) -> io::Result<BoundedStream> {
    let mut bytes = Vec::new();
    let mut overflowed = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut chunk) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if read == 0 {
            break;
        }
        let remaining = MAX_HOST_EXEC_STREAM_BYTES.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&chunk[..retained]);
        overflowed |= retained < read;
    }
    Ok(BoundedStream { bytes, overflowed })
}

fn join_io(handle: Option<JoinHandle<io::Result<()>>>) -> io::Result<()> {
    let Some(handle) = handle else {
        return Ok(());
    };
    handle
        .join()
        .map_err(|_| io::Error::other("host execution I/O worker panicked"))?
}

fn join_stream(
    handle: Option<JoinHandle<io::Result<BoundedStream>>>,
) -> Result<Option<BoundedStream>, HostExecProcessError> {
    let Some(handle) = handle else {
        return Ok(None);
    };
    match handle.join() {
        Ok(Ok(stream)) => Ok(Some(stream)),
        Ok(Err(error)) => Err(HostExecProcessError::Stdout(error)),
        Err(_) => Err(HostExecProcessError::WorkerPanicked),
    }
}

fn wait_child(child: &mut Child) -> io::Result<ExitStatus> {
    loop {
        match child.wait() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

fn signal_group(pgid: u32, signal: libc::c_int) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let pgid = libc::pid_t::try_from(pgid)
            .map_err(|_| io::Error::other("host execution process id is out of range"))?;
        // SAFETY: kill addresses only the dedicated child process group.
        let result = unsafe { libc::kill(-pgid, signal) };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pgid, signal);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "host execution process groups require Linux",
        ))
    }
}

fn has_exited_unreaped(pgid: u32) -> io::Result<bool> {
    #[cfg(target_os = "linux")]
    {
        let pid = libc::id_t::try_from(pgid)
            .map_err(|_| io::Error::other("host execution process id is out of range"))?;
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: waitid initializes one siginfo_t and WNOWAIT preserves the child.
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
        let _ = pgid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "host execution exit polling requires Linux",
        ))
    }
}

fn wait_group_gone(pgid: u32) -> io::Result<()> {
    while process_group_exists(pgid)? {
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

fn process_group_exists(pgid: u32) -> io::Result<bool> {
    #[cfg(target_os = "linux")]
    {
        let pgid = libc::pid_t::try_from(pgid)
            .map_err(|_| io::Error::other("host execution process id is out of range"))?;
        // SAFETY: signal zero performs an existence check without affecting the group.
        let result = unsafe { libc::kill(-pgid, 0) };
        if result == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(false),
            Some(libc::EPERM) => Ok(true),
            _ => Err(error),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pgid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "host execution process groups require Linux",
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use elpis_effects::{EffectIdentity, EffectLedger, EffectLimits, PrepareOutcome};
    use tempfile::TempDir;

    use super::*;

    fn token(temp: &TempDir, index: u64) -> ExecutionToken {
        let path = temp.path().join(format!("private-{index}/effects.sqlite"));
        let mut ledger = EffectLedger::open(path, EffectLimits::default()).unwrap();
        let identity = EffectIdentity::new(
            format!("request-{index}"),
            "context",
            1,
            format!("run-{index}"),
            0,
            "elpis.host.exec",
            format!("request-{index}").into_bytes(),
        )
        .unwrap();
        match ledger.prepare(&identity).unwrap() {
            PrepareOutcome::New(token) => token,
            other => panic!("expected new token, got {other:?}"),
        }
    }

    fn request(argv: &[&str], stdin: &[u8]) -> HostExecRequest {
        HostExecRequest::new(
            argv.iter().map(|value| (*value).to_owned()).collect(),
            String::from_utf8(stdin.to_vec()).unwrap(),
        )
        .unwrap()
    }

    fn wait_terminal(process: &mut HostExecProcess) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !process.has_exited_unreaped().unwrap() {
            assert!(Instant::now() < deadline, "host process did not exit");
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn completed(outcome: HostExecProcessOutcome) -> (ExecutionToken, HostExecResult) {
        match outcome {
            HostExecProcessOutcome::Completed { token, result } => (token, result),
            other => panic!("expected completed process, got {other:?}"),
        }
    }

    #[test]
    fn exit_stdin_and_binary_streams_are_exact_after_reap() {
        let temp = TempDir::new().unwrap();
        let token = token(&temp, 1);
        let expected = token.effect_id();
        let request = request(
            &[
                "/bin/sh",
                "-c",
                "cat; printf '\\000\\377A'; printf '\\001B' >&2",
            ],
            b"stdin-bytes",
        );
        let mut process = HostExecProcess::start(token, &request).unwrap();
        wait_terminal(&mut process);
        let (returned, result) = completed(process.wait_reaped());
        assert_eq!(returned.effect_id(), expected);
        assert_eq!(result.termination(), HostExecTermination::Exited(0));
        assert_eq!(result.stdout(), b"stdin-bytes\0\xffA");
        assert_eq!(result.stderr(), b"\x01B");
    }

    #[test]
    fn nonzero_exit_and_signal_are_completed_receipts() {
        let temp = TempDir::new().unwrap();
        let cases = [
            (
                vec!["/bin/sh", "-c", "exit 7"],
                HostExecTermination::Exited(7),
            ),
            (
                vec!["/bin/sh", "-c", "kill -TERM $$"],
                HostExecTermination::Signaled(libc::SIGTERM),
            ),
        ];
        for (index, (argv, expected)) in cases.into_iter().enumerate() {
            let mut process =
                HostExecProcess::start(token(&temp, 10 + index as u64), &request(&argv, b""))
                    .unwrap();
            wait_terminal(&mut process);
            let (_, result) = completed(process.wait_reaped());
            assert_eq!(result.termination(), expected);
        }
    }

    #[test]
    fn simultaneous_large_streams_drain_without_deadlock() {
        let temp = TempDir::new().unwrap();
        let mut process = HostExecProcess::start(
            token(&temp, 15),
            &request(
                &[
                    "/bin/sh",
                    "-c",
                    "head -c 60000 /dev/zero & head -c 60000 /dev/zero >&2 & wait",
                ],
                b"",
            ),
        )
        .unwrap();
        wait_terminal(&mut process);
        let (_, result) = completed(process.wait_reaped());
        assert_eq!(result.termination(), HostExecTermination::Exited(0));
        assert_eq!(result.stdout().len(), 60_000);
        assert_eq!(result.stderr().len(), 60_000);
        assert!(result.stdout().iter().all(|byte| *byte == 0));
        assert!(result.stderr().iter().all(|byte| *byte == 0));
    }

    #[test]
    fn output_overflow_is_bounded_and_returns_token_as_ambiguous() {
        let temp = TempDir::new().unwrap();
        let token = token(&temp, 20);
        let expected = token.effect_id();
        let mut process = HostExecProcess::start(
            token,
            &request(&["/usr/bin/head", "-c", "70000", "/dev/zero"], b""),
        )
        .unwrap();
        wait_terminal(&mut process);
        match process.wait_reaped() {
            HostExecProcessOutcome::Ambiguous { token, error } => {
                assert_eq!(token.effect_id(), expected);
                assert!(matches!(error, HostExecProcessError::StdoutTooLarge));
            }
            other => panic!("expected bounded ambiguity, got {other:?}"),
        }
    }

    #[test]
    fn spawn_failure_returns_unspent_token() {
        let temp = TempDir::new().unwrap();
        let token = token(&temp, 30);
        let expected = token.effect_id();
        let failure =
            HostExecProcess::start(token, &request(&["/definitely/not/an/elpis-program"], b""))
                .unwrap_err();
        let (returned, error, disposition) = failure.into_parts();
        assert_eq!(returned.effect_id(), expected);
        assert!(matches!(error, HostExecProcessError::Spawn(_)));
        assert_eq!(disposition, HostExecStartDisposition::NotStarted);
    }

    #[test]
    fn repeated_cancel_kills_and_reaps_the_whole_group() {
        let temp = TempDir::new().unwrap();
        let token = token(&temp, 40);
        let expected = token.effect_id();
        let mut process =
            HostExecProcess::start(token, &request(&["/bin/sh", "-c", "sleep 30 & wait"], b""))
                .unwrap();
        let pgid = process.leader_pid();
        assert!(process_group_exists(pgid).unwrap());
        process.cancel().unwrap();
        process.cancel().unwrap();
        match process.wait_reaped() {
            HostExecProcessOutcome::Cancelled { token } => {
                assert_eq!(token.effect_id(), expected);
            }
            other => panic!("expected cancellation, got {other:?}"),
        }
        assert!(!process_group_exists(pgid).unwrap());
    }

    #[test]
    fn drop_kills_reaps_and_removes_the_process_group() {
        let temp = TempDir::new().unwrap();
        let process = HostExecProcess::start(
            token(&temp, 45),
            &request(&["/bin/sh", "-c", "sleep 30 & wait"], b""),
        )
        .unwrap();
        let pgid = process.leader_pid();
        assert!(process_group_exists(pgid).unwrap());
        drop(process);
        assert!(!process_group_exists(pgid).unwrap());
    }

    #[test]
    fn natural_leader_exit_still_removes_background_descendants() {
        let temp = TempDir::new().unwrap();
        let mut process = HostExecProcess::start(
            token(&temp, 50),
            &request(&["/bin/sh", "-c", "sleep 30 & exit 0"], b""),
        )
        .unwrap();
        let pgid = process.leader_pid();
        wait_terminal(&mut process);
        let (_, result) = completed(process.wait_reaped());
        assert_eq!(result.termination(), HostExecTermination::Exited(0));
        assert!(!process_group_exists(pgid).unwrap());
    }
}
