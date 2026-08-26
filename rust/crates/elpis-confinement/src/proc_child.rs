//! Exact pidfd plus fixed-proc-dir child custody backend.
//! Private and unwired: consumes raw_clone custody and never invokes clone3.
#![allow(dead_code)]

use super::raw_clone::NextChildCustody;
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

const MAX_STAT: usize = 16 * 1024;
const MAX_STATUS: usize = 64 * 1024;
const MAX_MAP: usize = 16 * 1024;
const MAX_SETGROUPS: usize = 64;
const MAX_FDINFO: usize = 4096;
const P_PIDFD: libc::idtype_t = 3;
const PROC_SUPER_MAGIC: libc::c_long = 0x9fa0;
const PROC_RESOLVE: u64 = 0x01 | 0x02 | 0x04 | 0x08; // NO_XDEV|NO_MAGICLINKS|NO_SYMLINKS|BENEATH

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ObjectIdentity {
    device: u64,
    inode: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChildStartIdentity {
    outer_pid: u32,
    pidfd: ObjectIdentity,
    proc_dir: ObjectIdentity,
    start_time_ticks: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NamespaceIdentity {
    device: u64,
    inode: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NamespaceIdentities {
    user: NamespaceIdentity,
    mount: NamespaceIdentity,
    pid: NamespaceIdentity,
    network: NamespaceIdentity,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IdMapExtent {
    inside: u32,
    outside: u32,
    length: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PidfdState {
    Alive,
    Terminal,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PidfdTarget {
    Process(u32),
    NoTask,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalDisposition {
    Delivered,
    AlreadyTerminated,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalDisposition {
    Exited(i32),
    Signaled(i32),
    Dumped(i32),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReleaseState {
    Stopped,
    Terminal(TerminalDisposition),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TerminalReceipt {
    start: ChildStartIdentity,
    disposition: TerminalDisposition,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    Write,
}

#[derive(Debug, PartialEq, Eq)]
enum ExactError<E> {
    Kernel(E),
    MissingPidfd,
    InvalidOutsideId,
    InvalidPid,
    PidfdTerminal,
    PidfdSubstitution,
    ProcDirSubstitution,
    StartTimeDrift,
    MalformedStat,
    MalformedStatus,
    MalformedMap,
    MalformedNamespace,
    OversizedFile { limit: usize },
    ShortWrite { expected: usize, written: usize },
    UnexpectedIoCount,
}

trait ChildCustody: Sized {
    fn pid(&self) -> libc::pid_t;
    fn pidfd(&self) -> Option<RawFd>;
    fn close_protocol(&mut self);
    fn disarm_after_exact_reap(&mut self);
}
impl ChildCustody for NextChildCustody {
    fn pid(&self) -> libc::pid_t {
        self.child().pid()
    }
    fn pidfd(&self) -> Option<RawFd> {
        self.child().pidfd().map(|fd| fd.as_raw_fd())
    }
    fn close_protocol(&mut self) {
        NextChildCustody::close_protocol(self)
    }
    fn disarm_after_exact_reap(&mut self) {
        NextChildCustody::disarm_after_exact_reap(self)
    }
}

trait ProcKernel: Sized {
    type Error;
    type ProcDir;
    type File;
    fn is_errno(error: &Self::Error, errno: i32) -> bool;
    fn pidfd_identity(&mut self, pidfd: RawFd) -> Result<ObjectIdentity, Self::Error>;
    fn pidfd_state(&mut self, pidfd: RawFd) -> Result<PidfdState, Self::Error>;
    /// `/proc/<self>/fdinfo/<pidfd>` target in this procfs PID namespace.
    /// This remains load-bearing on pre-pidfs kernels where all pidfds shared
    /// one anonymous inode and fstat alone could not detect substitution.
    fn pidfd_target(&mut self, pidfd: RawFd) -> Result<PidfdTarget, Self::Error>;
    /// O_PATH|O_DIRECTORY|O_CLOEXEC, once, while direct-child custody is held.
    fn open_proc_dir(&mut self, pid: u32) -> Result<Self::ProcDir, Self::Error>;
    fn proc_dir_identity(&mut self, dir: &Self::ProcDir) -> Result<ObjectIdentity, Self::Error>;
    /// openat2 with BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV; no fallback.
    fn open_proc_file(
        &mut self,
        dir: &Self::ProcDir,
        name: &'static str,
        access: Access,
    ) -> Result<Self::File, Self::Error>;
    fn read(&mut self, file: &mut Self::File, out: &mut [u8]) -> Result<usize, Self::Error>;
    fn write(&mut self, file: &mut Self::File, input: &[u8]) -> Result<usize, Self::Error>;
    /// Namespace entries are proc magic links, so NO_MAGICLINKS cannot be used.
    /// This sole exception follows a fixed ns/{user,mnt,pid,net} name beneath
    /// the bound dirfd with fstatat and retains both resulting dev and inode.
    fn namespace_identity(
        &mut self,
        dir: &Self::ProcDir,
        name: &'static str,
    ) -> Result<NamespaceIdentity, Self::Error>;
    fn pidfd_send_signal(&mut self, pidfd: RawFd, signal: i32) -> Result<(), Self::Error>;
    fn waitid_pidfd(&mut self, pidfd: RawFd) -> Result<TerminalDisposition, Self::Error>;
    /// Waits without consuming for either the helper's exact SIGSTOP handoff
    /// or a terminal disposition that still requires an exact reap.
    fn waitid_release_state(&mut self, pidfd: RawFd) -> Result<ReleaseState, Self::Error>;
}

struct ExactChild<K: ProcKernel, C: ChildCustody> {
    kernel: K,
    custody: C,
    proc_dir: K::ProcDir,
    start: ChildStartIdentity,
}
struct UncertainCustody<K: ProcKernel, C: ChildCustody> {
    child: ExactChild<K, C>,
    kill_error: Option<K::Error>,
    wait_error: Option<K::Error>,
}
struct UnboundCustody<K: ProcKernel, C: ChildCustody> {
    kernel: K,
    custody: C,
    kill_error: Option<K::Error>,
    wait_error: Option<K::Error>,
    // Present when initial binding succeeded but its mandatory second proof failed.
    // Thus uncertainty never discards the stable proc dirfd/start authority.
    bound_proc_dir: Option<K::ProcDir>,
    start: Option<ChildStartIdentity>,
}
enum BindFailure<K: ProcKernel, C: ChildCustody> {
    Reaped {
        cause: ExactError<K::Error>,
        disposition: TerminalDisposition,
    },
    Uncertain {
        cause: ExactError<K::Error>,
        custody: UnboundCustody<K, C>,
    },
}
enum WaitFailure<K: ProcKernel, C: ChildCustody> {
    Uncertain(UncertainCustody<K, C>),
}

impl<K: ProcKernel, C: ChildCustody> ExactChild<K, C> {
    fn identity(&mut self) -> Result<ChildStartIdentity, ExactError<K::Error>> {
        self.revalidate(false)?;
        Ok(self.start)
    }

    /// Every operation first proves stable pidfd object, pidfd liveness, bound
    /// proc-directory dev/inode, and exact stat field 22 starttime.
    fn revalidate(&mut self, terminal_ok: bool) -> Result<PidfdState, ExactError<K::Error>> {
        let pidfd = self.custody.pidfd().ok_or(ExactError::MissingPidfd)?;
        if self
            .kernel
            .pidfd_identity(pidfd)
            .map_err(ExactError::Kernel)?
            != self.start.pidfd
        {
            return Err(ExactError::PidfdSubstitution);
        }
        let state = self.kernel.pidfd_state(pidfd).map_err(ExactError::Kernel)?;
        if state == PidfdState::Terminal && !terminal_ok {
            return Err(ExactError::PidfdTerminal);
        }
        let target = self
            .kernel
            .pidfd_target(pidfd)
            .map_err(ExactError::Kernel)?;
        match target {
            PidfdTarget::Process(pid) if pid == self.start.outer_pid => {}
            PidfdTarget::NoTask if terminal_ok && state == PidfdState::Terminal => {}
            _ => return Err(ExactError::PidfdSubstitution),
        }
        if self
            .kernel
            .proc_dir_identity(&self.proc_dir)
            .map_err(ExactError::Kernel)?
            != self.start.proc_dir
        {
            return Err(ExactError::ProcDirSubstitution);
        }
        let stat = read_named(&mut self.kernel, &self.proc_dir, "stat", MAX_STAT)?;
        let observed =
            parse_start_time(&stat, self.start.outer_pid).ok_or(ExactError::MalformedStat)?;
        if observed != self.start.start_time_ticks {
            return Err(ExactError::StartTimeDrift);
        }
        Ok(state)
    }

    fn read_setgroups(&mut self) -> Result<Vec<u8>, ExactError<K::Error>> {
        self.revalidate(false)?;
        read_named(&mut self.kernel, &self.proc_dir, "setgroups", MAX_SETGROUPS)
    }
    fn write_setgroups_deny(&mut self) -> Result<(), ExactError<K::Error>> {
        self.write_exact("setgroups", b"deny\n")
    }
    fn write_uid_map(&mut self, outside: u32) -> Result<(), ExactError<K::Error>> {
        if outside == 0 {
            return Err(ExactError::InvalidOutsideId);
        }
        self.write_exact("uid_map", format!("0 {outside} 1\n").as_bytes())
    }
    fn write_gid_map(&mut self, outside: u32) -> Result<(), ExactError<K::Error>> {
        if outside == 0 {
            return Err(ExactError::InvalidOutsideId);
        }
        self.write_exact("gid_map", format!("0 {outside} 1\n").as_bytes())
    }
    fn write_exact(
        &mut self,
        name: &'static str,
        bytes: &[u8],
    ) -> Result<(), ExactError<K::Error>> {
        self.revalidate(false)?;
        let mut file = self
            .kernel
            .open_proc_file(&self.proc_dir, name, Access::Write)
            .map_err(ExactError::Kernel)?;
        // One write only. A partial map write may have changed kernel state;
        // retrying either suffix or whole line is not safe.
        let n = self
            .kernel
            .write(&mut file, bytes)
            .map_err(ExactError::Kernel)?;
        if n > bytes.len() {
            Err(ExactError::UnexpectedIoCount)
        } else if n != bytes.len() {
            Err(ExactError::ShortWrite {
                expected: bytes.len(),
                written: n,
            })
        } else {
            Ok(())
        }
    }
    fn read_uid_map(&mut self) -> Result<IdMapExtent, ExactError<K::Error>> {
        self.read_one_map("uid_map")
    }
    fn read_gid_map(&mut self) -> Result<IdMapExtent, ExactError<K::Error>> {
        self.read_one_map("gid_map")
    }
    fn read_one_map(&mut self, name: &'static str) -> Result<IdMapExtent, ExactError<K::Error>> {
        self.revalidate(false)?;
        let bytes = read_named(&mut self.kernel, &self.proc_dir, name, MAX_MAP)?;
        parse_one_map(&bytes).ok_or(ExactError::MalformedMap)
    }
    fn read_nspid(&mut self) -> Result<Vec<u32>, ExactError<K::Error>> {
        self.revalidate(false)?;
        let bytes = read_named(&mut self.kernel, &self.proc_dir, "status", MAX_STATUS)?;
        parse_nspid(&bytes).ok_or(ExactError::MalformedStatus)
    }
    fn read_namespaces(&mut self) -> Result<NamespaceIdentities, ExactError<K::Error>> {
        let user = self.ns("ns/user")?;
        let mount = self.ns("ns/mnt")?;
        let pid = self.ns("ns/pid")?;
        let network = self.ns("ns/net")?;
        let values = [user, mount, pid, network];
        if values.iter().any(|v| v.device == 0 || v.inode == 0)
            || values
                .iter()
                .enumerate()
                .any(|(i, v)| values[i + 1..].contains(v))
        {
            return Err(ExactError::MalformedNamespace);
        }
        Ok(NamespaceIdentities {
            user,
            mount,
            pid,
            network,
        })
    }
    fn ns(&mut self, name: &'static str) -> Result<NamespaceIdentity, ExactError<K::Error>> {
        self.revalidate(false)?;
        self.kernel
            .namespace_identity(&self.proc_dir, name)
            .map_err(ExactError::Kernel)
    }
    fn send_signal(&mut self, signal: i32) -> Result<SignalDisposition, ExactError<K::Error>> {
        if self.revalidate(true)? == PidfdState::Terminal {
            return Ok(SignalDisposition::AlreadyTerminated);
        }
        let fd = self.custody.pidfd().ok_or(ExactError::MissingPidfd)?;
        match self.kernel.pidfd_send_signal(fd, signal) {
            Ok(()) => Ok(SignalDisposition::Delivered),
            Err(e) if K::is_errno(&e, libc::ESRCH) => Ok(SignalDisposition::AlreadyTerminated),
            Err(e) => Err(ExactError::Kernel(e)),
        }
    }
    fn wait_release_state(&mut self) -> Result<ReleaseState, ExactError<K::Error>> {
        self.revalidate(false)?;
        let pidfd = self.custody.pidfd().ok_or(ExactError::MissingPidfd)?;
        let state = self
            .kernel
            .waitid_release_state(pidfd)
            .map_err(ExactError::Kernel)?;
        if state == ReleaseState::Stopped {
            self.revalidate(false)?;
        }
        Ok(state)
    }

    fn wait(mut self) -> Result<TerminalReceipt, WaitFailure<K, C>> {
        let Some(fd) = self.custody.pidfd() else {
            return Err(WaitFailure::Uncertain(UncertainCustody {
                child: self,
                kill_error: None,
                wait_error: None,
            }));
        };
        if self.revalidate(true).is_err() {
            return Err(WaitFailure::Uncertain(UncertainCustody {
                child: self,
                kill_error: None,
                wait_error: None,
            }));
        }
        match self.kernel.waitid_pidfd(fd) {
            Ok(disposition) => {
                self.custody.disarm_after_exact_reap();
                Ok(TerminalReceipt {
                    start: self.start,
                    disposition,
                })
            }
            // Includes ECHILD: no prior boot evidence proves auto-reap, so it is uncertain.
            Err(e) => Err(WaitFailure::Uncertain(UncertainCustody {
                child: self,
                kill_error: None,
                wait_error: Some(e),
            })),
        }
    }
}

fn bind_with<K: ProcKernel, C: ChildCustody>(
    mut kernel: K,
    mut custody: C,
) -> Result<ExactChild<K, C>, BindFailure<K, C>> {
    match bind_identity(&mut kernel, &custody) {
        Ok((proc_dir, start)) => {
            let mut child = ExactChild {
                kernel,
                custody,
                proc_dir,
                start,
            };
            if let Err(cause) = child.revalidate(false) {
                return Err(abort_bound(child, cause));
            }
            Ok(child)
        }
        Err(cause) => {
            custody.close_protocol();
            let Some(fd) = custody.pidfd() else {
                return Err(BindFailure::Uncertain {
                    cause,
                    custody: UnboundCustody {
                        kernel,
                        custody,
                        kill_error: None,
                        wait_error: None,
                        bound_proc_dir: None,
                        start: None,
                    },
                });
            };
            let kill_error = match kernel.pidfd_send_signal(fd, libc::SIGKILL) {
                Ok(()) => None,
                Err(error) if K::is_errno(&error, libc::ESRCH) => Some(error),
                Err(error) => {
                    return Err(BindFailure::Uncertain {
                        cause,
                        custody: UnboundCustody {
                            kernel,
                            custody,
                            kill_error: Some(error),
                            wait_error: None,
                            bound_proc_dir: None,
                            start: None,
                        },
                    });
                }
            };
            match kernel.waitid_pidfd(fd) {
                Ok(disposition) => {
                    custody.disarm_after_exact_reap();
                    Err(BindFailure::Reaped { cause, disposition })
                }
                Err(error) => Err(BindFailure::Uncertain {
                    cause,
                    custody: UnboundCustody {
                        kernel,
                        custody,
                        kill_error,
                        wait_error: Some(error),
                        bound_proc_dir: None,
                        start: None,
                    },
                }),
            }
        }
    }
}

fn bind_identity<K: ProcKernel, C: ChildCustody>(
    kernel: &mut K,
    custody: &C,
) -> Result<(K::ProcDir, ChildStartIdentity), ExactError<K::Error>> {
    let pid = u32::try_from(custody.pid()).map_err(|_| ExactError::InvalidPid)?;
    if pid == 0 {
        return Err(ExactError::InvalidPid);
    }
    let fd = custody.pidfd().ok_or(ExactError::MissingPidfd)?;
    let pidfd = kernel.pidfd_identity(fd).map_err(ExactError::Kernel)?;
    if kernel.pidfd_state(fd).map_err(ExactError::Kernel)? != PidfdState::Alive {
        return Err(ExactError::PidfdTerminal);
    }
    if kernel.pidfd_target(fd).map_err(ExactError::Kernel)? != PidfdTarget::Process(pid) {
        return Err(ExactError::PidfdSubstitution);
    }
    let dir = kernel.open_proc_dir(pid).map_err(ExactError::Kernel)?;
    let proc_dir = kernel.proc_dir_identity(&dir).map_err(ExactError::Kernel)?;
    if proc_dir.device == 0 || proc_dir.inode == 0 {
        return Err(ExactError::ProcDirSubstitution);
    }
    let stat = read_named(kernel, &dir, "stat", MAX_STAT)?;
    let start_time_ticks = parse_start_time(&stat, pid).ok_or(ExactError::MalformedStat)?;
    if start_time_ticks == 0 {
        return Err(ExactError::MalformedStat);
    }
    Ok((
        dir,
        ChildStartIdentity {
            outer_pid: pid,
            pidfd,
            proc_dir,
            start_time_ticks,
        },
    ))
}

fn abort_bound<K: ProcKernel, C: ChildCustody>(
    mut child: ExactChild<K, C>,
    cause: ExactError<K::Error>,
) -> BindFailure<K, C> {
    child.custody.close_protocol();
    let Some(fd) = child.custody.pidfd() else {
        let ExactChild {
            kernel,
            custody,
            proc_dir,
            start,
        } = child;
        return BindFailure::Uncertain {
            cause,
            custody: UnboundCustody {
                kernel,
                custody,
                kill_error: None,
                wait_error: None,
                bound_proc_dir: Some(proc_dir),
                start: Some(start),
            },
        };
    };
    let kill_error = match child.kernel.pidfd_send_signal(fd, libc::SIGKILL) {
        Ok(()) => None,
        Err(error) if K::is_errno(&error, libc::ESRCH) => Some(error),
        Err(error) => {
            return uncertain_bound(child, cause, Some(error), None);
        }
    };
    match child.kernel.waitid_pidfd(fd) {
        Ok(disposition) => {
            child.custody.disarm_after_exact_reap();
            BindFailure::Reaped { cause, disposition }
        }
        Err(error) => uncertain_bound(child, cause, kill_error, Some(error)),
    }
}

fn uncertain_bound<K: ProcKernel, C: ChildCustody>(
    child: ExactChild<K, C>,
    cause: ExactError<K::Error>,
    kill_error: Option<K::Error>,
    wait_error: Option<K::Error>,
) -> BindFailure<K, C> {
    let ExactChild {
        kernel,
        custody,
        proc_dir,
        start,
    } = child;
    BindFailure::Uncertain {
        cause,
        custody: UnboundCustody {
            kernel,
            custody,
            kill_error,
            wait_error,
            bound_proc_dir: Some(proc_dir),
            start: Some(start),
        },
    }
}

fn read_named<K: ProcKernel>(
    kernel: &mut K,
    dir: &K::ProcDir,
    name: &'static str,
    limit: usize,
) -> Result<Vec<u8>, ExactError<K::Error>> {
    let mut file = kernel
        .open_proc_file(dir, name, Access::Read)
        .map_err(ExactError::Kernel)?;
    let mut result = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        // Probe one byte beyond the limit, allowing exact-limit only after EOF.
        let request = chunk
            .len()
            .min(limit.saturating_add(1).saturating_sub(result.len()));
        if request == 0 {
            return Err(ExactError::OversizedFile { limit });
        }
        let n = kernel
            .read(&mut file, &mut chunk[..request])
            .map_err(ExactError::Kernel)?;
        if n > request {
            return Err(ExactError::UnexpectedIoCount);
        }
        if n == 0 {
            return Ok(result);
        }
        result.extend_from_slice(&chunk[..n]);
        if result.len() > limit {
            return Err(ExactError::OversizedFile { limit });
        }
    }
}

fn parse_start_time(bytes: &[u8], expected_pid: u32) -> Option<u64> {
    if bytes.contains(&0) || bytes.last() != Some(&b'\n') {
        return None;
    }
    let line = &bytes[..bytes.len() - 1];
    let open = line.iter().position(|b| *b == b'(')?;
    if open < 2 || line[open - 1] != b' ' || parse_u64(&line[..open - 1])? != expected_pid as u64 {
        return None;
    }
    // After comm, fields contain no ')'; rposition therefore handles arbitrary
    // spaces and parentheses, including a comm ending in ')'.
    let close = line.iter().rposition(|b| *b == b')')?;
    if close <= open || line.get(close + 1) != Some(&b' ') {
        return None;
    }
    let fields: Vec<&[u8]> = line[close + 2..].split(|b| *b == b' ').collect();
    // field 3 is fields[0], and field 22 is fields[19].
    if fields.len() < 20 || fields.iter().any(|f| f.is_empty()) || fields[0].len() != 1 {
        return None;
    }
    parse_u64(fields[19])
}

fn parse_one_map(bytes: &[u8]) -> Option<IdMapExtent> {
    if bytes.contains(&0) || bytes.last() != Some(&b'\n') {
        return None;
    }
    let body = &bytes[..bytes.len() - 1];
    if body.contains(&b'\n') {
        return None;
    }
    let f: Vec<&[u8]> = body
        .split(|b| b.is_ascii_whitespace())
        .filter(|f| !f.is_empty())
        .collect();
    if f.len() != 3 {
        return None;
    }
    let extent = IdMapExtent {
        inside: u32::try_from(parse_u64(f[0])?).ok()?,
        outside: u32::try_from(parse_u64(f[1])?).ok()?,
        length: u32::try_from(parse_u64(f[2])?).ok()?,
    };
    (extent.length != 0).then_some(extent)
}

fn parse_nspid(bytes: &[u8]) -> Option<Vec<u32>> {
    if bytes.contains(&0) || bytes.last() != Some(&b'\n') {
        return None;
    }
    let mut found = None;
    for line in bytes[..bytes.len() - 1].split(|b| *b == b'\n') {
        if let Some(rest) = line.strip_prefix(b"NSpid:") {
            if found.is_some() {
                return None;
            }
            let fields: Vec<&[u8]> = rest
                .split(|b| b.is_ascii_whitespace())
                .filter(|f| !f.is_empty())
                .collect();
            if fields.is_empty() {
                return None;
            }
            let mut pids = Vec::with_capacity(fields.len());
            for field in fields {
                let pid = u32::try_from(parse_u64(field)?).ok()?;
                if pid == 0 {
                    return None;
                }
                pids.push(pid);
            }
            found = Some(pids);
        }
    }
    found
}

fn parse_u64(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || bytes.iter().any(|b| !b.is_ascii_digit()) {
        return None;
    }
    bytes.iter().try_fold(0u64, |v, b| {
        v.checked_mul(10)?.checked_add((b - b'0') as u64)
    })
}

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
struct LinuxKernel;

impl ProcKernel for LinuxKernel {
    type Error = std::io::Error;
    type ProcDir = OwnedFd;
    type File = OwnedFd;
    fn is_errno(e: &Self::Error, errno: i32) -> bool {
        e.raw_os_error() == Some(errno)
    }
    fn pidfd_identity(&mut self, fd: RawFd) -> Result<ObjectIdentity, Self::Error> {
        fstat_identity(fd)
    }
    fn pidfd_state(&mut self, fd: RawFd) -> Result<PidfdState, Self::Error> {
        let mut p = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let n = unsafe { libc::poll(&mut p, 1, 0) };
        if n < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if n == 0 {
            Ok(PidfdState::Alive)
        } else if p.revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            Ok(PidfdState::Terminal)
        } else {
            Err(std::io::Error::from_raw_os_error(libc::EIO))
        }
    }
    fn pidfd_target(&mut self, fd: RawFd) -> Result<PidfdTarget, Self::Error> {
        read_pidfd_target(fd)
    }
    fn open_proc_dir(&mut self, pid: u32) -> Result<Self::ProcDir, Self::Error> {
        let path = CString::new("/proc").unwrap();
        let root = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if root < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let root = unsafe { OwnedFd::from_raw_fd(root) };
        let mut statfs = std::mem::MaybeUninit::<libc::statfs>::zeroed();
        if unsafe { libc::fstatfs(root.as_raw_fd(), statfs.as_mut_ptr()) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let statfs = unsafe { statfs.assume_init() };
        if statfs.f_type as libc::c_long != PROC_SUPER_MAGIC {
            return Err(std::io::Error::from_raw_os_error(libc::EXDEV));
        }
        openat2_fd(
            root.as_raw_fd(),
            &pid.to_string(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    }
    fn proc_dir_identity(&mut self, dir: &Self::ProcDir) -> Result<ObjectIdentity, Self::Error> {
        fstat_identity(dir.as_raw_fd())
    }
    fn open_proc_file(
        &mut self,
        dir: &Self::ProcDir,
        name: &'static str,
        access: Access,
    ) -> Result<Self::File, Self::Error> {
        let access = match access {
            Access::Read => libc::O_RDONLY,
            Access::Write => libc::O_WRONLY,
        };
        openat2_fd(
            dir.as_raw_fd(),
            name,
            access | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    }
    fn read(&mut self, file: &mut Self::File, out: &mut [u8]) -> Result<usize, Self::Error> {
        let n = unsafe { libc::read(file.as_raw_fd(), out.as_mut_ptr().cast(), out.len()) };
        if n < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
    fn write(&mut self, file: &mut Self::File, input: &[u8]) -> Result<usize, Self::Error> {
        let n = unsafe { libc::write(file.as_raw_fd(), input.as_ptr().cast(), input.len()) };
        if n < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
    fn namespace_identity(
        &mut self,
        dir: &Self::ProcDir,
        name: &'static str,
    ) -> Result<NamespaceIdentity, Self::Error> {
        let name = CString::new(name).unwrap();
        let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
        let n = unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), 0) };
        if n < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let stat = unsafe { stat.assume_init() };
        Ok(NamespaceIdentity {
            device: stat.st_dev,
            inode: stat.st_ino,
        })
    }
    fn pidfd_send_signal(&mut self, fd: RawFd, signal: i32) -> Result<(), Self::Error> {
        let n = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd,
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if n < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn waitid_pidfd(&mut self, fd: RawFd) -> Result<TerminalDisposition, Self::Error> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        let n =
            unsafe { libc::waitid(P_PIDFD, fd as libc::id_t, info.as_mut_ptr(), libc::WEXITED) };
        if n < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        let status = unsafe { info.si_status() };
        match info.si_code {
            libc::CLD_EXITED => Ok(TerminalDisposition::Exited(status)),
            libc::CLD_KILLED => Ok(TerminalDisposition::Signaled(status)),
            libc::CLD_DUMPED => Ok(TerminalDisposition::Dumped(status)),
            _ => Err(std::io::Error::from_raw_os_error(libc::EIO)),
        }
    }
    fn waitid_release_state(&mut self, fd: RawFd) -> Result<ReleaseState, Self::Error> {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        let options = libc::WSTOPPED | libc::WEXITED | libc::WNOWAIT;
        let n = unsafe { libc::waitid(P_PIDFD, fd as libc::id_t, info.as_mut_ptr(), options) };
        if n < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        let status = unsafe { info.si_status() };
        match info.si_code {
            libc::CLD_STOPPED if status == libc::SIGSTOP => Ok(ReleaseState::Stopped),
            libc::CLD_EXITED => Ok(ReleaseState::Terminal(TerminalDisposition::Exited(status))),
            libc::CLD_KILLED => Ok(ReleaseState::Terminal(TerminalDisposition::Signaled(
                status,
            ))),
            libc::CLD_DUMPED => Ok(ReleaseState::Terminal(TerminalDisposition::Dumped(status))),
            _ => Err(std::io::Error::from_raw_os_error(libc::EIO)),
        }
    }
}

fn read_pidfd_target(fd: RawFd) -> Result<PidfdTarget, std::io::Error> {
    if fd < 0 {
        return Err(std::io::Error::from_raw_os_error(libc::EBADF));
    }
    let path = CString::new("/proc").expect("fixed proc path");
    let root_fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let root = unsafe { OwnedFd::from_raw_fd(root_fd) };
    let mut statfs = std::mem::MaybeUninit::<libc::statfs>::zeroed();
    if unsafe { libc::fstatfs(root.as_raw_fd(), statfs.as_mut_ptr()) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { statfs.assume_init() }.f_type as libc::c_long != PROC_SUPER_MAGIC {
        return Err(std::io::Error::from_raw_os_error(libc::EXDEV));
    }
    let own_pid = unsafe { libc::getpid() };
    if own_pid <= 0 {
        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
    }
    let own_dir = openat2_fd(
        root.as_raw_fd(),
        &own_pid.to_string(),
        libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
    )?;
    let fdinfo_dir = openat2_fd(
        own_dir.as_raw_fd(),
        "fdinfo",
        libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
    )?;
    let info = openat2_fd(
        fdinfo_dir.as_raw_fd(),
        &fd.to_string(),
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
    )?;
    let bytes = read_bounded_fd(info.as_raw_fd(), MAX_FDINFO)?;
    parse_pidfd_target(&bytes).ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))
}

fn read_bounded_fd(fd: RawFd, limit: usize) -> Result<Vec<u8>, std::io::Error> {
    let mut result = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let request = chunk
            .len()
            .min(limit.saturating_add(1).saturating_sub(result.len()));
        if request == 0 {
            return Err(std::io::Error::from_raw_os_error(libc::EFBIG));
        }
        let count = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), request) };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        let count =
            usize::try_from(count).map_err(|_| std::io::Error::from_raw_os_error(libc::EIO))?;
        if count == 0 {
            return Ok(result);
        }
        if count > request {
            return Err(std::io::Error::from_raw_os_error(libc::EIO));
        }
        result.extend_from_slice(&chunk[..count]);
        if result.len() > limit {
            return Err(std::io::Error::from_raw_os_error(libc::EFBIG));
        }
    }
}

fn parse_pidfd_target(bytes: &[u8]) -> Option<PidfdTarget> {
    if bytes.contains(&0) || bytes.last() != Some(&b'\n') {
        return None;
    }
    let mut found = None;
    for line in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        let Some(value) = line.strip_prefix(b"Pid:\t") else {
            continue;
        };
        if found.is_some() {
            return None;
        }
        found = Some(if value == b"-1" {
            PidfdTarget::NoTask
        } else {
            let pid = u32::try_from(parse_u64(value)?).ok()?;
            if pid == 0 {
                return None;
            }
            PidfdTarget::Process(pid)
        });
    }
    found
}

fn openat2_fd(dir: RawFd, name: &str, flags: i32) -> Result<OwnedFd, std::io::Error> {
    let name = CString::new(name).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let how = OpenHow {
        flags: flags as u64,
        mode: 0,
        resolve: PROC_RESOLVE,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dir,
            name.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        ) as i32
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}
fn fstat_identity(fd: RawFd) -> Result<ObjectIdentity, std::io::Error> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    let n = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if n < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stat = unsafe { stat.assume_init() };
    Ok(ObjectIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
    })
}

/// Private production entry, intentionally not connected to launch/release.
fn bind(
    custody: NextChildCustody,
) -> Result<
    ExactChild<LinuxKernel, NextChildCustody>,
    Box<BindFailure<LinuxKernel, NextChildCustody>>,
> {
    bind_with(LinuxKernel, custody).map_err(Box::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::rc::Rc;

    #[derive(Clone)]
    struct FakeCustody {
        pid: i32,
        pidfd: Option<i32>,
        armed: Rc<Cell<bool>>,
    }
    impl ChildCustody for FakeCustody {
        fn pid(&self) -> libc::pid_t {
            self.pid
        }
        fn pidfd(&self) -> Option<RawFd> {
            self.pidfd
        }
        fn close_protocol(&mut self) {}
        fn disarm_after_exact_reap(&mut self) {
            self.armed.set(false);
        }
    }
    struct FakeFile {
        name: &'static str,
        bytes: Vec<u8>,
        offset: usize,
        write: bool,
    }
    type RecordedWrites = Rc<RefCell<Vec<(&'static str, Vec<u8>)>>>;

    struct FakeKernel {
        pidfd_identity: ObjectIdentity,
        state: PidfdState,
        pidfd_target: PidfdTarget,
        proc_identity: ObjectIdentity,
        start: u64,
        files: BTreeMap<&'static str, Vec<u8>>,
        namespaces: BTreeMap<&'static str, NamespaceIdentity>,
        max_read: usize,
        write_result: Option<Result<usize, i32>>,
        writes: RecordedWrites,
        signal: Result<(), i32>,
        wait: Result<TerminalDisposition, i32>,
        release_state: Result<ReleaseState, i32>,
        wait_calls: Rc<Cell<usize>>,
        opens: Rc<RefCell<Vec<(&'static str, Access)>>>,
    }
    impl FakeKernel {
        fn good() -> Self {
            let mut files = BTreeMap::new();
            files.insert("setgroups", b"deny\n".to_vec());
            files.insert("uid_map", b"         0       1000          1\n".to_vec());
            files.insert("gid_map", b"0 1001 1\n".to_vec());
            files.insert("status", b"Name:\todd child\nNSpid:\t4242\t1\n".to_vec());
            let namespaces = ["ns/user", "ns/mnt", "ns/pid", "ns/net"]
                .into_iter()
                .enumerate()
                .map(|(i, n)| {
                    (
                        n,
                        NamespaceIdentity {
                            device: 7,
                            inode: 100 + i as u64,
                        },
                    )
                })
                .collect();
            Self {
                pidfd_identity: ObjectIdentity {
                    device: 9,
                    inode: 90,
                },
                state: PidfdState::Alive,
                pidfd_target: PidfdTarget::Process(4242),
                proc_identity: ObjectIdentity {
                    device: 3,
                    inode: 30,
                },
                start: 777,
                files,
                namespaces,
                max_read: usize::MAX,
                write_result: None,
                writes: Rc::new(RefCell::new(Vec::new())),
                signal: Ok(()),
                wait: Ok(TerminalDisposition::Signaled(libc::SIGKILL)),
                release_state: Ok(ReleaseState::Stopped),
                wait_calls: Rc::new(Cell::new(0)),
                opens: Rc::new(RefCell::new(Vec::new())),
            }
        }
        fn stat(&self) -> Vec<u8> {
            stat_line(4242, self.start)
        }
    }
    impl ProcKernel for FakeKernel {
        type Error = i32;
        type ProcDir = u64;
        type File = FakeFile;
        fn is_errno(e: &i32, errno: i32) -> bool {
            *e == errno
        }
        fn pidfd_identity(&mut self, _fd: RawFd) -> Result<ObjectIdentity, i32> {
            Ok(self.pidfd_identity)
        }
        fn pidfd_state(&mut self, _fd: RawFd) -> Result<PidfdState, i32> {
            Ok(self.state)
        }
        fn pidfd_target(&mut self, _fd: RawFd) -> Result<PidfdTarget, i32> {
            Ok(self.pidfd_target)
        }
        fn open_proc_dir(&mut self, pid: u32) -> Result<u64, i32> {
            if pid == 4242 {
                Ok(1)
            } else {
                Err(libc::ENOENT)
            }
        }
        fn proc_dir_identity(&mut self, dir: &u64) -> Result<ObjectIdentity, i32> {
            if *dir == 1 {
                Ok(self.proc_identity)
            } else {
                Err(libc::EBADF)
            }
        }
        fn open_proc_file(
            &mut self,
            dir: &u64,
            name: &'static str,
            access: Access,
        ) -> Result<FakeFile, i32> {
            if *dir != 1 {
                return Err(libc::EBADF);
            }
            self.opens.borrow_mut().push((name, access));
            let bytes = if name == "stat" {
                self.stat()
            } else {
                self.files.get(name).cloned().ok_or(libc::ENOENT)?
            };
            Ok(FakeFile {
                name,
                bytes,
                offset: 0,
                write: access == Access::Write,
            })
        }
        fn read(&mut self, f: &mut FakeFile, out: &mut [u8]) -> Result<usize, i32> {
            if f.write {
                return Err(libc::EBADF);
            }
            let n = out
                .len()
                .min(self.max_read)
                .min(f.bytes.len().saturating_sub(f.offset));
            out[..n].copy_from_slice(&f.bytes[f.offset..f.offset + n]);
            f.offset += n;
            Ok(n)
        }
        fn write(&mut self, f: &mut FakeFile, input: &[u8]) -> Result<usize, i32> {
            if !f.write {
                return Err(libc::EBADF);
            }
            self.writes.borrow_mut().push((f.name, input.to_vec()));
            self.write_result.take().unwrap_or(Ok(input.len()))
        }
        fn namespace_identity(
            &mut self,
            dir: &u64,
            name: &'static str,
        ) -> Result<NamespaceIdentity, i32> {
            if *dir != 1 {
                return Err(libc::EBADF);
            }
            self.namespaces.get(name).copied().ok_or(libc::ENOENT)
        }
        fn pidfd_send_signal(&mut self, _fd: RawFd, _signal: i32) -> Result<(), i32> {
            self.signal
        }
        fn waitid_pidfd(&mut self, _fd: RawFd) -> Result<TerminalDisposition, i32> {
            self.wait_calls.set(self.wait_calls.get() + 1);
            self.wait
        }
        fn waitid_release_state(&mut self, _fd: RawFd) -> Result<ReleaseState, i32> {
            self.release_state
        }
    }

    fn stat_line(pid: u32, start: u64) -> Vec<u8> {
        let mut s = format!("{pid} (comm with spaces ) and (parens)) S");
        for n in 1..=18 {
            s.push_str(&format!(" {n}"));
        }
        s.push_str(&format!(" {start} 23 24 25\n"));
        s.into_bytes()
    }
    fn custody() -> (FakeCustody, Rc<Cell<bool>>) {
        let armed = Rc::new(Cell::new(true));
        (
            FakeCustody {
                pid: 4242,
                pidfd: Some(8),
                armed: armed.clone(),
            },
            armed,
        )
    }
    fn bound() -> ExactChild<FakeKernel, FakeCustody> {
        let (c, _) = custody();
        match bind_with(FakeKernel::good(), c) {
            Ok(v) => v,
            Err(_) => panic!("bind failed"),
        }
    }

    #[test]
    fn pidfd_fdinfo_parser_requires_one_exact_target() {
        assert_eq!(
            parse_pidfd_target(b"pos:\t0\nflags:\t02000002\nPid:\t4242\nNSpid:\t4242\t1\n"),
            Some(PidfdTarget::Process(4242))
        );
        assert_eq!(
            parse_pidfd_target(b"Pid:\t-1\nNSpid:\t-1\n"),
            Some(PidfdTarget::NoTask)
        );
        for malformed in [
            b"Pid:\t0\n".as_slice(),
            b"Pid:\t-2\n",
            b"Pid:\t4\nPid:\t4\n",
            b"Pid:\tx\n",
            b"Pid:\t4",
            b"NSpid:\t4\n",
        ] {
            assert_eq!(parse_pidfd_target(malformed), None);
        }
    }

    #[test]
    fn stat_field_22_parser_handles_spaces_and_parentheses() {
        assert_eq!(
            parse_start_time(&stat_line(4242, 987654), 4242),
            Some(987654)
        );
        assert_eq!(parse_start_time(&stat_line(4242, 1), 7), None);
        assert_eq!(parse_start_time(b"42 (unterminated S 1 2\n", 42), None);
        let mut no_newline = stat_line(4242, 4);
        no_newline.pop();
        assert_eq!(parse_start_time(&no_newline, 4242), None);
    }

    #[test]
    fn pid_reuse_start_drift_and_proc_or_pidfd_substitution_fail_closed() {
        let mut child = bound();
        child.kernel.start += 1;
        assert!(matches!(
            child.read_nspid(),
            Err(ExactError::StartTimeDrift)
        ));
        child.kernel.start -= 1;
        child.kernel.proc_identity.inode += 1;
        assert!(matches!(
            child.read_uid_map(),
            Err(ExactError::ProcDirSubstitution)
        ));
        child.kernel.proc_identity.inode -= 1;
        child.kernel.pidfd_identity.inode += 1;
        assert!(matches!(
            child.read_gid_map(),
            Err(ExactError::PidfdSubstitution)
        ));
        child.kernel.pidfd_identity.inode -= 1;
        child.kernel.pidfd_target = PidfdTarget::Process(9999);
        assert!(matches!(
            child.read_gid_map(),
            Err(ExactError::PidfdSubstitution)
        ));
    }

    #[test]
    fn short_reads_are_completed_and_oversized_files_are_rejected() {
        let mut child = bound();
        child.kernel.max_read = 2;
        assert_eq!(child.read_nspid().unwrap(), vec![4242, 1]);
        child.kernel.max_read = usize::MAX;
        child
            .kernel
            .files
            .insert("status", vec![b'x'; MAX_STATUS + 1]);
        assert_eq!(
            child.read_nspid(),
            Err(ExactError::OversizedFile { limit: MAX_STATUS })
        );
    }

    #[test]
    fn exact_single_extent_maps_and_malformed_inputs() {
        assert_eq!(
            parse_one_map(b" 0 1000 1\n"),
            Some(IdMapExtent {
                inside: 0,
                outside: 1000,
                length: 1
            })
        );
        for bad in [
            b"0 1 1\n1 2 1\n".as_slice(),
            b"0 1 0\n",
            b"0 x 1\n",
            b"0 1 1",
            b"0 1 1 2\n",
        ] {
            assert_eq!(parse_one_map(bad), None);
        }
        let mut child = bound();
        child
            .kernel
            .files
            .insert("uid_map", b"0 1 1\n1 2 1\n".to_vec());
        assert_eq!(child.read_uid_map(), Err(ExactError::MalformedMap));
    }

    #[test]
    fn malformed_or_duplicate_nspid_is_rejected() {
        for bad in [
            b"NSpid:\n".as_slice(),
            b"NSpid:\t0\n",
            b"NSpid:\tx\n",
            b"NSpid:\t1\nNSpid:\t1\n",
            b"NSpid:\t1",
        ] {
            assert_eq!(parse_nspid(bad), None);
        }
    }

    #[test]
    fn mapping_writes_are_one_exact_write_and_never_retry_partial() {
        let mut child = bound();
        assert_eq!(child.write_uid_map(0), Err(ExactError::InvalidOutsideId));
        assert_eq!(child.write_gid_map(0), Err(ExactError::InvalidOutsideId));
        assert!(child.kernel.writes.borrow().is_empty());
        child.kernel.write_result = Some(Ok(3));
        assert_eq!(
            child.write_uid_map(2000),
            Err(ExactError::ShortWrite {
                expected: 9,
                written: 3
            })
        );
        assert_eq!(child.kernel.writes.borrow().len(), 1);
        child.kernel.write_result = Some(Err(libc::EINTR));
        assert_eq!(
            child.write_gid_map(2001),
            Err(ExactError::Kernel(libc::EINTR))
        );
        assert_eq!(child.kernel.writes.borrow().len(), 2);
        child.write_setgroups_deny().unwrap();
        assert_eq!(
            child.kernel.writes.borrow().last().unwrap().1.as_slice(),
            b"deny\n"
        );
    }

    #[test]
    fn namespace_magic_link_seam_retains_dev_inode_and_revalidates_each() {
        let mut child = bound();
        let n = child.read_namespaces().unwrap();
        assert_eq!(
            n.user,
            NamespaceIdentity {
                device: 7,
                inode: 100
            }
        );
        let stat_opens = child
            .kernel
            .opens
            .borrow()
            .iter()
            .filter(|(n, _)| *n == "stat")
            .count();
        assert_eq!(stat_opens, 6); // bind initial + bind recheck + one before each namespace
        child.kernel.namespaces.insert(
            "ns/net",
            NamespaceIdentity {
                device: 7,
                inode: 100,
            },
        );
        assert_eq!(child.read_namespaces(), Err(ExactError::MalformedNamespace));
    }

    #[test]
    fn pidfd_signal_has_exact_dispositions_and_errors() {
        let mut child = bound();
        assert_eq!(
            child.send_signal(libc::SIGKILL),
            Ok(SignalDisposition::Delivered)
        );
        child.kernel.signal = Err(libc::ESRCH);
        assert_eq!(
            child.send_signal(libc::SIGKILL),
            Ok(SignalDisposition::AlreadyTerminated)
        );
        child.kernel.signal = Err(libc::EPERM);
        assert_eq!(
            child.send_signal(libc::SIGKILL),
            Err(ExactError::Kernel(libc::EPERM))
        );
        child.kernel.state = PidfdState::Terminal;
        child.kernel.pidfd_target = PidfdTarget::NoTask;
        assert_eq!(
            child.send_signal(libc::SIGKILL),
            Ok(SignalDisposition::AlreadyTerminated)
        );
    }

    #[test]
    fn release_state_requires_exact_stop_or_preserves_terminal_for_reap() {
        let mut stopped = bound();
        assert_eq!(stopped.wait_release_state(), Ok(ReleaseState::Stopped));

        let mut terminal = bound();
        terminal.kernel.state = PidfdState::Terminal;
        terminal.kernel.pidfd_target = PidfdTarget::NoTask;
        terminal.kernel.release_state =
            Ok(ReleaseState::Terminal(TerminalDisposition::Exited(125)));
        assert_eq!(
            terminal.wait_release_state(),
            Err(ExactError::PidfdTerminal)
        );

        let mut failed = bound();
        failed.kernel.release_state = Err(libc::EIO);
        assert_eq!(
            failed.wait_release_state(),
            Err(ExactError::Kernel(libc::EIO))
        );
    }

    #[test]
    fn waitid_pidfd_exactly_disarms_only_on_terminal_receipt() {
        let (c, armed) = custody();
        let mut child = match bind_with(FakeKernel::good(), c) {
            Ok(v) => v,
            Err(_) => panic!(),
        };
        child.kernel.state = PidfdState::Terminal;
        let receipt = match child.wait() {
            Ok(v) => v,
            Err(_) => panic!(),
        };
        assert_eq!(
            receipt.disposition,
            TerminalDisposition::Signaled(libc::SIGKILL)
        );
        assert!(!armed.get());

        let (c, armed) = custody();
        let mut child = match bind_with(FakeKernel::good(), c) {
            Ok(v) => v,
            Err(_) => panic!(),
        };
        child.kernel.state = PidfdState::Terminal;
        child.kernel.wait = Err(libc::ECHILD);
        match child.wait() {
            Err(WaitFailure::Uncertain(u)) => {
                assert_eq!(u.wait_error, Some(libc::ECHILD));
                assert!(u.child.custody.armed.get());
            }
            _ => panic!("ECHILD must remain uncertain"),
        }
        assert!(armed.get());
    }

    #[test]
    fn missing_required_pidfd_returns_armed_uncertain_custody() {
        let (mut c, armed) = custody();
        c.pidfd = None;
        match bind_with(FakeKernel::good(), c) {
            Err(BindFailure::Uncertain {
                cause: ExactError::MissingPidfd,
                custody: u,
            }) => {
                assert!(u.custody.armed.get());
                assert!(u.bound_proc_dir.is_none());
            }
            _ => panic!("pidfd is mandatory"),
        }
        assert!(armed.get());
    }

    #[test]
    fn post_child_bind_failure_reaps_or_returns_armed_uncertainty() {
        let (c, armed) = custody();
        let mut k = FakeKernel::good();
        k.start = 0;
        match bind_with(k, c) {
            Err(BindFailure::Reaped {
                cause: ExactError::MalformedStat,
                ..
            }) => {}
            _ => panic!("expected exact reap"),
        }
        assert!(!armed.get());

        let (c, armed) = custody();
        let mut k = FakeKernel::good();
        k.start = 0;
        k.wait = Err(libc::EIO);
        k.signal = Err(libc::EPERM);
        match bind_with(k, c) {
            Err(BindFailure::Uncertain { custody: u, .. }) => {
                assert_eq!(u.kill_error, Some(libc::EPERM));
                assert_eq!(u.wait_error, None);
                assert_eq!(u.kernel.wait_calls.get(), 0);
                assert!(u.custody.armed.get());
            }
            _ => panic!("expected uncertain custody"),
        }
        assert!(armed.get());
    }
}

// The namespace_child module is the frozen policy typestate.  This private
// composition is the concrete custody implementation beneath the future boot
// integration boundary; it deliberately is not wired to a public entrypoint.
mod stopped_child_composition {
    use super::*;
    use crate::raw_clone::{
        BootFrozenHelperFd, CloneExecError, NextChildCustody, RawChild, clone_exec_fixed,
    };
    use std::io;
    use std::os::fd::RawFd;

    const FRAME_LEN: usize = 48;
    const NONCE_LEN: usize = 32;
    const MAGIC: &[u8; 8] = b"ELPISNS\0";
    const VERSION: u8 = 1;
    const BOOT: u8 = 1;
    const READY: u8 = 2;
    const RELEASE: u8 = 3;
    const SETGROUPS_ALLOW: &[u8] = b"allow\n";
    const SETGROUPS_DENY: &[u8] = b"deny\n";
    const CHILD_ERROR_LEN: usize = 16;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct FrozenIds {
        uid: u32,
        gid: u32,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    struct BootNonce([u8; NONCE_LEN]);

    impl BootNonce {
        fn valid(self) -> bool {
            self.0.iter().any(|byte| *byte != 0)
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct StartIdentity {
        outer_pid: u32,
        pidfd_device: u64,
        pidfd_inode: u64,
        proc_device: u64,
        proc_inode: u64,
        start_time_ticks: u64,
    }

    impl From<ChildStartIdentity> for StartIdentity {
        fn from(value: ChildStartIdentity) -> Self {
            Self {
                outer_pid: value.outer_pid,
                pidfd_device: value.pidfd.device,
                pidfd_inode: value.pidfd.inode,
                proc_device: value.proc_dir.device,
                proc_inode: value.proc_dir.inode,
                start_time_ticks: value.start_time_ticks,
            }
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct NamespaceSet {
        user: (u64, u64),
        mount: (u64, u64),
        pid: (u64, u64),
        network: (u64, u64),
    }

    impl NamespaceSet {
        fn exact(values: NamespaceIdentities) -> Self {
            let pair = |value: NamespaceIdentity| (value.device, value.inode);
            Self {
                user: pair(values.user),
                mount: pair(values.mount),
                pid: pair(values.pid),
                network: pair(values.network),
            }
        }

        fn valid(self) -> bool {
            let values = [self.user, self.mount, self.pid, self.network];
            values
                .iter()
                .all(|(device, inode)| *device != 0 && *inode != 0)
                && values
                    .iter()
                    .enumerate()
                    .all(|(index, value)| !values[index + 1..].contains(value))
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Step {
        FrozenInputs,
        Clone3,
        ProcBind,
        ExecStatus,
        BootNonce,
        Ready,
        ReadyQuiet,
        ReadSetgroupsCurrent,
        WriteSetgroupsDeny,
        ReadSetgroupsDeny,
        WriteUidMap,
        WriteGidMap,
        ReadUidMap,
        ReadGidMap,
        StartIdentity,
        Nspid,
        Namespaces,
        ReleaseToMountAssembly,
        ReleaseEof,
        StopChild,
        StoppedHandoff,
    }

    #[derive(Debug, PartialEq, Eq)]
    enum FailureCause<E> {
        Kernel { step: Step, error: E },
        Evidence { step: Step },
    }

    enum CloneAttempt<E> {
        /// This is the only result classified as NoChild: clone3 returned negative.
        NoChild(E),
        /// Descriptor preparation failed before clone3 was attempted.
        NotStarted(E),
    }

    enum ComposedBindFailure<E, U, R> {
        Reaped { cause: E, receipt: R },
        Uncertain { cause: E, custody: U },
    }

    type ProcBindResult<E, C, U, R> = Result<(C, StartIdentity), ComposedBindFailure<E, U, R>>;

    trait StoppedBackend: Sized {
        type Error;
        type Raw;
        type Child;
        type BindUncertain;
        type ReapUncertain;
        type Receipt;

        fn frozen_ids(&self) -> FrozenIds;
        fn nonce(&self) -> BootNonce;
        fn raw_clone(&mut self) -> Result<Self::Raw, CloneAttempt<Self::Error>>;
        fn proc_bind(
            &mut self,
            raw: Self::Raw,
        ) -> ProcBindResult<Self::Error, Self::Child, Self::BindUncertain, Self::Receipt>;
        fn exec_succeeded(child: &mut Self::Child) -> Result<(), Self::Error>;
        /// Exactly one SOCK_SEQPACKET send; callers never retry short writes.
        fn send_control(
            child: &mut Self::Child,
            frame: &[u8; FRAME_LEN],
        ) -> Result<usize, Self::Error>;
        /// Exactly one canonical packet. EOF, truncation, and oversize are errors.
        fn receive_receipt(child: &mut Self::Child) -> Result<[u8; FRAME_LEN], Self::Error>;
        /// Peeks without consuming. false means a duplicate packet is queued.
        fn receipt_is_quiet(child: &mut Self::Child) -> Result<bool, Self::Error>;
        /// Blocks until the helper closes its receipt endpoint after validating
        /// post-map state; any additional packet is malformed.
        fn release_receipt_eof(child: &mut Self::Child) -> Result<(), Self::Error>;
        fn send_stop(child: &mut Self::Child) -> Result<(), Self::Error>;
        fn release_state(child: &mut Self::Child) -> Result<ReleaseState, Self::Error>;
        fn read_setgroups(child: &mut Self::Child) -> Result<Vec<u8>, Self::Error>;
        fn write_setgroups_deny(child: &mut Self::Child) -> Result<(), Self::Error>;
        fn write_uid_map(child: &mut Self::Child, outside: u32) -> Result<(), Self::Error>;
        fn write_gid_map(child: &mut Self::Child, outside: u32) -> Result<(), Self::Error>;
        fn read_uid_map(child: &mut Self::Child) -> Result<IdMapExtent, Self::Error>;
        fn read_gid_map(child: &mut Self::Child) -> Result<IdMapExtent, Self::Error>;
        fn identity(child: &mut Self::Child) -> Result<StartIdentity, Self::Error>;
        fn nspid(child: &mut Self::Child) -> Result<Vec<u32>, Self::Error>;
        fn namespaces(child: &mut Self::Child) -> Result<NamespaceSet, Self::Error>;
        /// Infallible ownership operation: both protocol directions and exec status close.
        fn close_protocol(child: &mut Self::Child);
        fn send_sigkill(child: &mut Self::Child) -> Result<(), Self::Error>;
        fn exact_reap(child: Self::Child) -> Result<Self::Receipt, Self::ReapUncertain>;
    }

    struct ArmedStoppedChild<K: StoppedBackend> {
        kernel: K,
        child: K::Child,
        start: StartIdentity,
        namespaces: NamespaceSet,
    }

    struct ComposedUncertainCustody<K: StoppedBackend> {
        kernel: K,
        custody: K::ReapUncertain,
        kill_error: Option<K::Error>,
    }

    enum LaunchFailure<K: StoppedBackend> {
        NotStarted {
            cause: FailureCause<K::Error>,
            kernel: K,
        },
        NoChild {
            cause: FailureCause<K::Error>,
            kernel: K,
        },
        BindReaped {
            cause: FailureCause<K::Error>,
            receipt: K::Receipt,
        },
        BindUncertain {
            cause: FailureCause<K::Error>,
            custody: K::BindUncertain,
        },
        Reaped {
            cause: FailureCause<K::Error>,
            receipt: K::Receipt,
        },
        Uncertain {
            cause: FailureCause<K::Error>,
            custody: ComposedUncertainCustody<K>,
        },
    }

    fn frame(kind: u8, nonce: BootNonce) -> [u8; FRAME_LEN] {
        let mut frame = [0u8; FRAME_LEN];
        frame[..8].copy_from_slice(MAGIC);
        frame[8] = VERSION;
        frame[9] = kind;
        frame[16..].copy_from_slice(&nonce.0);
        frame
    }

    fn canonical(frame: &[u8; FRAME_LEN], kind: u8, nonce: BootNonce) -> bool {
        frame[..8] == MAGIC[..]
            && frame[8] == VERSION
            && frame[9] == kind
            && frame[10..16].iter().all(|byte| *byte == 0)
            && frame[16..] == nonce.0[..]
    }

    fn exact_extent(extent: IdMapExtent, outside: u32) -> bool {
        extent
            == IdMapExtent {
                inside: 0,
                outside,
                length: 1,
            }
    }

    fn abort<K: StoppedBackend>(
        kernel: K,
        mut child: K::Child,
        cause: FailureCause<K::Error>,
    ) -> LaunchFailure<K> {
        // EOF is established before signalling. Even a signal error therefore
        // cannot leave the fixed helper able to pass the one-shot protocol.
        K::close_protocol(&mut child);
        let kill_error = K::send_sigkill(&mut child).err();
        match K::exact_reap(child) {
            Ok(receipt) => LaunchFailure::Reaped { cause, receipt },
            Err(custody) => LaunchFailure::Uncertain {
                cause,
                custody: ComposedUncertainCustody {
                    kernel,
                    custody,
                    kill_error,
                },
            },
        }
    }

    fn reap_without_signal<K: StoppedBackend>(
        kernel: K,
        mut child: K::Child,
        cause: FailureCause<K::Error>,
    ) -> LaunchFailure<K> {
        K::close_protocol(&mut child);
        match K::exact_reap(child) {
            Ok(receipt) => LaunchFailure::Reaped { cause, receipt },
            Err(custody) => LaunchFailure::Uncertain {
                cause,
                custody: ComposedUncertainCustody {
                    kernel,
                    custody,
                    kill_error: None,
                },
            },
        }
    }

    fn launch<K: StoppedBackend>(mut kernel: K) -> Result<ArmedStoppedChild<K>, LaunchFailure<K>> {
        let ids = kernel.frozen_ids();
        let nonce = kernel.nonce();
        if ids.uid == 0 || ids.gid == 0 || !nonce.valid() {
            return Err(LaunchFailure::NotStarted {
                cause: FailureCause::Evidence {
                    step: Step::FrozenInputs,
                },
                kernel,
            });
        }

        let raw = match kernel.raw_clone() {
            Ok(raw) => raw,
            Err(CloneAttempt::NoChild(error)) => {
                return Err(LaunchFailure::NoChild {
                    cause: FailureCause::Kernel {
                        step: Step::Clone3,
                        error,
                    },
                    kernel,
                });
            }
            Err(CloneAttempt::NotStarted(error)) => {
                return Err(LaunchFailure::NotStarted {
                    cause: FailureCause::Kernel {
                        step: Step::Clone3,
                        error,
                    },
                    kernel,
                });
            }
        };
        let (mut child, start) = match kernel.proc_bind(raw) {
            Ok(bound) => bound,
            Err(ComposedBindFailure::Reaped { cause, receipt }) => {
                return Err(LaunchFailure::BindReaped {
                    cause: FailureCause::Kernel {
                        step: Step::ProcBind,
                        error: cause,
                    },
                    receipt,
                });
            }
            Err(ComposedBindFailure::Uncertain { cause, custody }) => {
                return Err(LaunchFailure::BindUncertain {
                    cause: FailureCause::Kernel {
                        step: Step::ProcBind,
                        error: cause,
                    },
                    custody,
                });
            }
        };

        macro_rules! operation {
            ($step:expr, $operation:expr) => {
                match $operation {
                    Ok(value) => value,
                    Err(error) => {
                        return Err(abort(
                            kernel,
                            child,
                            FailureCause::Kernel { step: $step, error },
                        ));
                    }
                }
            };
        }
        macro_rules! evidence {
            ($step:expr, $condition:expr) => {
                if !$condition {
                    return Err(abort(kernel, child, FailureCause::Evidence { step: $step }));
                }
            };
        }

        operation!(Step::ExecStatus, K::exec_succeeded(&mut child));
        let boot = frame(BOOT, nonce);
        let sent = operation!(Step::BootNonce, K::send_control(&mut child, &boot));
        evidence!(Step::BootNonce, sent == FRAME_LEN);
        let ready = operation!(Step::Ready, K::receive_receipt(&mut child));
        evidence!(Step::Ready, canonical(&ready, READY, nonce));
        let quiet = operation!(Step::ReadyQuiet, K::receipt_is_quiet(&mut child));
        evidence!(Step::ReadyQuiet, quiet);

        let current = operation!(Step::ReadSetgroupsCurrent, K::read_setgroups(&mut child));
        evidence!(
            Step::ReadSetgroupsCurrent,
            current.as_slice() == SETGROUPS_ALLOW
        );
        operation!(
            Step::WriteSetgroupsDeny,
            K::write_setgroups_deny(&mut child)
        );
        let denied = operation!(Step::ReadSetgroupsDeny, K::read_setgroups(&mut child));
        evidence!(Step::ReadSetgroupsDeny, denied.as_slice() == SETGROUPS_DENY);

        operation!(Step::WriteUidMap, K::write_uid_map(&mut child, ids.uid));
        operation!(Step::WriteGidMap, K::write_gid_map(&mut child, ids.gid));
        let uid = operation!(Step::ReadUidMap, K::read_uid_map(&mut child));
        evidence!(Step::ReadUidMap, exact_extent(uid, ids.uid));
        let gid = operation!(Step::ReadGidMap, K::read_gid_map(&mut child));
        evidence!(Step::ReadGidMap, exact_extent(gid, ids.gid));

        let observed_start = operation!(Step::StartIdentity, K::identity(&mut child));
        evidence!(Step::StartIdentity, observed_start == start);
        let nspid = operation!(Step::Nspid, K::nspid(&mut child));
        evidence!(Step::Nspid, nspid.as_slice() == [start.outer_pid, 1]);
        let namespaces = operation!(Step::Namespaces, K::namespaces(&mut child));
        evidence!(Step::Namespaces, namespaces.valid());

        let release = frame(RELEASE, nonce);
        let sent = operation!(
            Step::ReleaseToMountAssembly,
            K::send_control(&mut child, &release)
        );
        evidence!(Step::ReleaseToMountAssembly, sent == FRAME_LEN);
        operation!(Step::ReleaseEof, K::release_receipt_eof(&mut child));
        operation!(Step::StopChild, K::send_stop(&mut child));
        let release_state = operation!(Step::StoppedHandoff, K::release_state(&mut child));
        if matches!(release_state, ReleaseState::Terminal(_)) {
            return Err(reap_without_signal(
                kernel,
                child,
                FailureCause::Evidence {
                    step: Step::StoppedHandoff,
                },
            ));
        }
        K::close_protocol(&mut child);

        Ok(ArmedStoppedChild {
            kernel,
            child,
            start,
            namespaces,
        })
    }

    #[derive(Debug)]
    enum ProtocolError {
        Io(io::Error),
        Eof,
        MalformedExecStatus,
        MalformedPacket,
        ChildExecFailure([u8; CHILD_ERROR_LEN]),
        UnexpectedReleasePacket,
    }

    #[derive(Debug)]
    enum LinuxStoppedError {
        ClonePreparation(io::Error),
        Clone3(io::Error),
        Proc(ExactError<io::Error>),
        Protocol(ProtocolError),
        ConsumedHelper,
    }

    enum LinuxReceipt {
        Bound(TerminalReceipt),
        DuringBind(TerminalDisposition),
    }

    /// Private and unconstructible from paths. Future boot integration can only
    /// supply the already verified BootFrozenHelperFd capability. There is no
    /// path opener, fd-number constructor, or public launch function here.
    struct StoppedChildKernel {
        helper: Option<BootFrozenHelperFd>,
        nonce: BootNonce,
        ids: FrozenIds,
    }

    type LinuxChild = ExactChild<LinuxKernel, NextChildCustody>;
    type LinuxBindUncertain = UnboundCustody<LinuxKernel, NextChildCustody>;
    type LinuxReapUncertain = super::UncertainCustody<LinuxKernel, NextChildCustody>;

    impl StoppedBackend for StoppedChildKernel {
        type Error = LinuxStoppedError;
        type Raw = RawChild;
        type Child = LinuxChild;
        type BindUncertain = LinuxBindUncertain;
        type ReapUncertain = LinuxReapUncertain;
        type Receipt = LinuxReceipt;

        fn frozen_ids(&self) -> FrozenIds {
            self.ids
        }
        fn nonce(&self) -> BootNonce {
            self.nonce
        }
        fn raw_clone(&mut self) -> Result<Self::Raw, CloneAttempt<Self::Error>> {
            let Some(helper) = self.helper.take() else {
                return Err(CloneAttempt::NotStarted(LinuxStoppedError::ConsumedHelper));
            };
            match clone_exec_fixed(helper) {
                Ok(child) => Ok(child),
                Err(CloneExecError::Preparation(error)) => Err(CloneAttempt::NotStarted(
                    LinuxStoppedError::ClonePreparation(error),
                )),
                Err(CloneExecError::NoChild(error)) => {
                    Err(CloneAttempt::NoChild(LinuxStoppedError::Clone3(error)))
                }
            }
        }
        fn proc_bind(
            &mut self,
            raw: Self::Raw,
        ) -> ProcBindResult<Self::Error, Self::Child, Self::BindUncertain, Self::Receipt> {
            match bind_with(LinuxKernel, raw.into_next_custody()) {
                Ok(child) => {
                    let start = StartIdentity::from(child.start);
                    Ok((child, start))
                }
                Err(BindFailure::Reaped { cause, disposition }) => {
                    Err(ComposedBindFailure::Reaped {
                        cause: LinuxStoppedError::Proc(cause),
                        receipt: LinuxReceipt::DuringBind(disposition),
                    })
                }
                Err(BindFailure::Uncertain { cause, custody }) => {
                    Err(ComposedBindFailure::Uncertain {
                        cause: LinuxStoppedError::Proc(cause),
                        custody,
                    })
                }
            }
        }
        fn exec_succeeded(child: &mut Self::Child) -> Result<(), Self::Error> {
            read_exec_status(child.custody.exec_status_fd()).map_err(LinuxStoppedError::Protocol)
        }
        fn send_control(
            child: &mut Self::Child,
            frame: &[u8; FRAME_LEN],
        ) -> Result<usize, Self::Error> {
            let n = unsafe {
                libc::send(
                    child.custody.control_fd(),
                    frame.as_ptr().cast(),
                    frame.len(),
                    libc::MSG_NOSIGNAL,
                )
            };
            if n < 0 {
                Err(LinuxStoppedError::Protocol(ProtocolError::Io(
                    io::Error::last_os_error(),
                )))
            } else {
                Ok(n as usize)
            }
        }
        fn receive_receipt(child: &mut Self::Child) -> Result<[u8; FRAME_LEN], Self::Error> {
            let mut frame = [0u8; FRAME_LEN];
            let n = unsafe {
                libc::recv(
                    child.custody.receipt_fd(),
                    frame.as_mut_ptr().cast(),
                    frame.len(),
                    libc::MSG_TRUNC | libc::MSG_CMSG_CLOEXEC,
                )
            };
            if n == 0 {
                Err(LinuxStoppedError::Protocol(ProtocolError::Eof))
            } else if n < 0 {
                Err(LinuxStoppedError::Protocol(ProtocolError::Io(
                    io::Error::last_os_error(),
                )))
            } else if n as usize != FRAME_LEN {
                Err(LinuxStoppedError::Protocol(ProtocolError::MalformedPacket))
            } else {
                Ok(frame)
            }
        }
        fn receipt_is_quiet(child: &mut Self::Child) -> Result<bool, Self::Error> {
            let mut byte = 0u8;
            let n = unsafe {
                libc::recv(
                    child.custody.receipt_fd(),
                    (&mut byte as *mut u8).cast(),
                    1,
                    libc::MSG_DONTWAIT | libc::MSG_PEEK | libc::MSG_TRUNC,
                )
            };
            if n > 0 {
                Ok(false)
            } else if n == 0 {
                Err(LinuxStoppedError::Protocol(ProtocolError::Eof))
            } else {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EAGAIN) {
                    Ok(true)
                } else {
                    Err(LinuxStoppedError::Protocol(ProtocolError::Io(error)))
                }
            }
        }
        fn release_receipt_eof(child: &mut Self::Child) -> Result<(), Self::Error> {
            let mut byte = 0u8;
            loop {
                let count = unsafe {
                    libc::recv(
                        child.custody.receipt_fd(),
                        (&mut byte as *mut u8).cast(),
                        1,
                        0,
                    )
                };
                if count == 0 {
                    return Ok(());
                }
                if count > 0 {
                    return Err(LinuxStoppedError::Protocol(
                        ProtocolError::UnexpectedReleasePacket,
                    ));
                }
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINTR) {
                    return Err(LinuxStoppedError::Protocol(ProtocolError::Io(error)));
                }
            }
        }
        fn send_stop(child: &mut Self::Child) -> Result<(), Self::Error> {
            child
                .send_signal(libc::SIGSTOP)
                .map(|_| ())
                .map_err(LinuxStoppedError::Proc)
        }
        fn release_state(child: &mut Self::Child) -> Result<ReleaseState, Self::Error> {
            child.wait_release_state().map_err(LinuxStoppedError::Proc)
        }
        fn read_setgroups(child: &mut Self::Child) -> Result<Vec<u8>, Self::Error> {
            child.read_setgroups().map_err(LinuxStoppedError::Proc)
        }
        fn write_setgroups_deny(child: &mut Self::Child) -> Result<(), Self::Error> {
            child
                .write_setgroups_deny()
                .map_err(LinuxStoppedError::Proc)
        }
        fn write_uid_map(child: &mut Self::Child, outside: u32) -> Result<(), Self::Error> {
            child
                .write_uid_map(outside)
                .map_err(LinuxStoppedError::Proc)
        }
        fn write_gid_map(child: &mut Self::Child, outside: u32) -> Result<(), Self::Error> {
            child
                .write_gid_map(outside)
                .map_err(LinuxStoppedError::Proc)
        }
        fn read_uid_map(child: &mut Self::Child) -> Result<IdMapExtent, Self::Error> {
            child.read_uid_map().map_err(LinuxStoppedError::Proc)
        }
        fn read_gid_map(child: &mut Self::Child) -> Result<IdMapExtent, Self::Error> {
            child.read_gid_map().map_err(LinuxStoppedError::Proc)
        }
        fn identity(child: &mut Self::Child) -> Result<StartIdentity, Self::Error> {
            child
                .identity()
                .map(StartIdentity::from)
                .map_err(LinuxStoppedError::Proc)
        }
        fn nspid(child: &mut Self::Child) -> Result<Vec<u32>, Self::Error> {
            child.read_nspid().map_err(LinuxStoppedError::Proc)
        }
        fn namespaces(child: &mut Self::Child) -> Result<NamespaceSet, Self::Error> {
            child
                .read_namespaces()
                .map(NamespaceSet::exact)
                .map_err(LinuxStoppedError::Proc)
        }
        fn close_protocol(child: &mut Self::Child) {
            child.custody.close_protocol();
        }
        fn send_sigkill(child: &mut Self::Child) -> Result<(), Self::Error> {
            child
                .send_signal(libc::SIGKILL)
                .map(|_| ())
                .map_err(LinuxStoppedError::Proc)
        }
        fn exact_reap(child: Self::Child) -> Result<Self::Receipt, Self::ReapUncertain> {
            match child.wait() {
                Ok(receipt) => Ok(LinuxReceipt::Bound(receipt)),
                Err(WaitFailure::Uncertain(custody)) => Err(custody),
            }
        }
    }

    fn read_exec_status(fd: RawFd) -> Result<(), ProtocolError> {
        let mut frame = [0u8; CHILD_ERROR_LEN];
        let mut used = 0usize;
        loop {
            let n = unsafe {
                libc::read(
                    fd,
                    frame[used..].as_mut_ptr().cast(),
                    CHILD_ERROR_LEN - used,
                )
            };
            if n == 0 {
                return if used == 0 {
                    Ok(())
                } else {
                    Err(ProtocolError::MalformedExecStatus)
                };
            }
            if n < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(ProtocolError::Io(error));
            }
            used += n as usize;
            if used == CHILD_ERROR_LEN {
                return Err(ProtocolError::ChildExecFailure(frame));
            }
        }
    }

    // Kept private and unused until a verified boot integration can construct
    // StoppedChildKernel. This is intentionally not a real integration launch.
    fn launch_linux(
        kernel: StoppedChildKernel,
    ) -> Result<ArmedStoppedChild<StoppedChildKernel>, Box<LaunchFailure<StoppedChildKernel>>> {
        launch(kernel).map_err(Box::new)
    }

    #[cfg(test)]
    pub(super) fn test_only_real_launch(uid: u32, gid: u32) -> Result<(), String> {
        if uid == 0 || gid == 0 {
            return Err("real launch fixture ids must be nonzero".into());
        }
        let helper = crate::raw_clone::test_only_mint_verified_helper()
            .map_err(|error| format!("verified helper mint: {error}"))?;
        let kernel = StoppedChildKernel {
            helper: Some(helper),
            nonce: BootNonce([0x66; NONCE_LEN]),
            ids: FrozenIds { uid, gid },
        };
        let armed = launch_linux(kernel).map_err(|_| "composed real launch failed".to_string())?;
        if !armed.namespaces.valid()
            || armed.start.outer_pid == 0
            || !armed.child.custody.protocol_closed()
        {
            return Err("composed launch returned incomplete stopped custody".into());
        }
        let ArmedStoppedChild {
            mut child, start, ..
        } = armed;
        child
            .send_signal(libc::SIGKILL)
            .map_err(|error| format!("composed child SIGKILL: {error:?}"))?;
        let receipt = child
            .wait()
            .map_err(|_| "composed child exact reap became uncertain".to_string())?;
        if StartIdentity::from(receipt.start) != start
            || receipt.disposition != TerminalDisposition::Signaled(libc::SIGKILL)
        {
            return Err(format!(
                "composed child wrong terminal receipt: {receipt:?}"
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;
        use std::rc::Rc;

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        enum Call {
            Clone,
            Bind,
            Exec,
            Boot,
            Ready,
            ReadyQuiet,
            ReadSetgroups,
            DenySetgroups,
            WriteUid,
            WriteGid,
            ReadUid,
            ReadGid,
            Identity,
            Nspid,
            Namespaces,
            Release,
            ReleaseEof,
            Stop,
            AwaitStopped,
            CloseProtocol,
            Kill,
            Reap,
        }

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        struct FakeError(Call);

        struct RawCustody;
        struct BindUnknown;
        struct ReapUnknown;

        struct FakeState {
            calls: Vec<Call>,
            fail: Option<Call>,
            short: Option<Call>,
            drift_identity: bool,
            bad_nspid: bool,
            malformed_ready: bool,
            duplicate_ready: bool,
            bind_pid_reuse: bool,
            reap_fails: bool,
            terminal_after_release: bool,
            read_setgroups_count: usize,
        }

        struct ChildCustody {
            state: Rc<RefCell<FakeState>>,
        }

        struct Fake {
            state: Rc<RefCell<FakeState>>,
        }

        const IDS: FrozenIds = FrozenIds {
            uid: 62001,
            gid: 62002,
        };
        const NONCE: BootNonce = BootNonce([7; NONCE_LEN]);
        const START: StartIdentity = StartIdentity {
            outer_pid: 4242,
            pidfd_device: 1,
            pidfd_inode: 2,
            proc_device: 3,
            proc_inode: 4,
            start_time_ticks: 5,
        };
        const NAMESPACES: NamespaceSet = NamespaceSet {
            user: (10, 11),
            mount: (10, 12),
            pid: (10, 13),
            network: (10, 14),
        };

        impl Fake {
            fn new() -> Self {
                Self {
                    state: Rc::new(RefCell::new(FakeState {
                        calls: Vec::new(),
                        fail: None,
                        short: None,
                        drift_identity: false,
                        bad_nspid: false,
                        malformed_ready: false,
                        duplicate_ready: false,
                        bind_pid_reuse: false,
                        reap_fails: false,
                        terminal_after_release: false,
                        read_setgroups_count: 0,
                    })),
                }
            }

            fn calls(&self) -> Vec<Call> {
                self.state.borrow().calls.clone()
            }
        }

        fn child_call(child: &ChildCustody, call: Call) -> Result<(), FakeError> {
            let mut state = child.state.borrow_mut();
            state.calls.push(call);
            if state.fail == Some(call)
                || (state.short == Some(call) && matches!(call, Call::WriteUid | Call::WriteGid))
            {
                Err(FakeError(call))
            } else {
                Ok(())
            }
        }

        impl StoppedBackend for Fake {
            type Error = FakeError;
            type Raw = RawCustody;
            type Child = ChildCustody;
            type BindUncertain = BindUnknown;
            type ReapUncertain = ReapUnknown;
            type Receipt = ();

            fn frozen_ids(&self) -> FrozenIds {
                IDS
            }
            fn nonce(&self) -> BootNonce {
                NONCE
            }
            fn raw_clone(&mut self) -> Result<Self::Raw, CloneAttempt<Self::Error>> {
                let mut state = self.state.borrow_mut();
                state.calls.push(Call::Clone);
                if state.fail == Some(Call::Clone) {
                    Err(CloneAttempt::NoChild(FakeError(Call::Clone)))
                } else {
                    Ok(RawCustody)
                }
            }
            fn proc_bind(
                &mut self,
                _: Self::Raw,
            ) -> ProcBindResult<Self::Error, Self::Child, Self::BindUncertain, Self::Receipt>
            {
                let mut state = self.state.borrow_mut();
                state.calls.push(Call::Bind);
                if state.bind_pid_reuse {
                    Err(ComposedBindFailure::Uncertain {
                        cause: FakeError(Call::Bind),
                        custody: BindUnknown,
                    })
                } else if state.fail == Some(Call::Bind) {
                    Err(ComposedBindFailure::Reaped {
                        cause: FakeError(Call::Bind),
                        receipt: (),
                    })
                } else {
                    drop(state);
                    Ok((
                        ChildCustody {
                            state: self.state.clone(),
                        },
                        START,
                    ))
                }
            }
            fn exec_succeeded(child: &mut Self::Child) -> Result<(), Self::Error> {
                child_call(child, Call::Exec)
            }
            fn send_control(
                child: &mut Self::Child,
                bytes: &[u8; FRAME_LEN],
            ) -> Result<usize, Self::Error> {
                let call = if bytes[9] == BOOT {
                    Call::Boot
                } else {
                    Call::Release
                };
                assert!(canonical(bytes, bytes[9], NONCE));
                child_call(child, call)?;
                Ok(if child.state.borrow().short == Some(call) {
                    FRAME_LEN - 1
                } else {
                    FRAME_LEN
                })
            }
            fn receive_receipt(child: &mut Self::Child) -> Result<[u8; FRAME_LEN], Self::Error> {
                child_call(child, Call::Ready)?;
                let mut value = frame(READY, NONCE);
                if child.state.borrow().malformed_ready {
                    value[10] = 1;
                }
                Ok(value)
            }
            fn receipt_is_quiet(child: &mut Self::Child) -> Result<bool, Self::Error> {
                child_call(child, Call::ReadyQuiet)?;
                Ok(!child.state.borrow().duplicate_ready)
            }
            fn release_receipt_eof(child: &mut Self::Child) -> Result<(), Self::Error> {
                child_call(child, Call::ReleaseEof)
            }
            fn send_stop(child: &mut Self::Child) -> Result<(), Self::Error> {
                child_call(child, Call::Stop)
            }
            fn release_state(child: &mut Self::Child) -> Result<ReleaseState, Self::Error> {
                child_call(child, Call::AwaitStopped)?;
                Ok(if child.state.borrow().terminal_after_release {
                    ReleaseState::Terminal(TerminalDisposition::Exited(125))
                } else {
                    ReleaseState::Stopped
                })
            }
            fn read_setgroups(child: &mut Self::Child) -> Result<Vec<u8>, Self::Error> {
                child_call(child, Call::ReadSetgroups)?;
                let mut state = child.state.borrow_mut();
                let value = if state.read_setgroups_count == 0 {
                    SETGROUPS_ALLOW
                } else {
                    SETGROUPS_DENY
                };
                state.read_setgroups_count += 1;
                Ok(value.to_vec())
            }
            fn write_setgroups_deny(child: &mut Self::Child) -> Result<(), Self::Error> {
                child_call(child, Call::DenySetgroups)
            }
            fn write_uid_map(child: &mut Self::Child, outside: u32) -> Result<(), Self::Error> {
                assert_eq!(outside, IDS.uid);
                child_call(child, Call::WriteUid)
            }
            fn write_gid_map(child: &mut Self::Child, outside: u32) -> Result<(), Self::Error> {
                assert_eq!(outside, IDS.gid);
                child_call(child, Call::WriteGid)
            }
            fn read_uid_map(child: &mut Self::Child) -> Result<IdMapExtent, Self::Error> {
                child_call(child, Call::ReadUid)?;
                Ok(IdMapExtent {
                    inside: 0,
                    outside: IDS.uid,
                    length: 1,
                })
            }
            fn read_gid_map(child: &mut Self::Child) -> Result<IdMapExtent, Self::Error> {
                child_call(child, Call::ReadGid)?;
                Ok(IdMapExtent {
                    inside: 0,
                    outside: IDS.gid,
                    length: 1,
                })
            }
            fn identity(child: &mut Self::Child) -> Result<StartIdentity, Self::Error> {
                child_call(child, Call::Identity)?;
                Ok(if child.state.borrow().drift_identity {
                    StartIdentity {
                        start_time_ticks: 999,
                        ..START
                    }
                } else {
                    START
                })
            }
            fn nspid(child: &mut Self::Child) -> Result<Vec<u32>, Self::Error> {
                child_call(child, Call::Nspid)?;
                Ok(if child.state.borrow().bad_nspid {
                    vec![4243, 1]
                } else {
                    vec![4242, 1]
                })
            }
            fn namespaces(child: &mut Self::Child) -> Result<NamespaceSet, Self::Error> {
                child_call(child, Call::Namespaces)?;
                Ok(NAMESPACES)
            }
            fn close_protocol(child: &mut Self::Child) {
                child.state.borrow_mut().calls.push(Call::CloseProtocol);
            }
            fn send_sigkill(child: &mut Self::Child) -> Result<(), Self::Error> {
                child_call(child, Call::Kill)
            }
            fn exact_reap(child: Self::Child) -> Result<Self::Receipt, Self::ReapUncertain> {
                let mut state = child.state.borrow_mut();
                state.calls.push(Call::Reap);
                if state.reap_fails {
                    Err(ReapUnknown)
                } else {
                    Ok(())
                }
            }
        }

        const SUCCESS_ORDER: &[Call] = &[
            Call::Clone,
            Call::Bind,
            Call::Exec,
            Call::Boot,
            Call::Ready,
            Call::ReadyQuiet,
            Call::ReadSetgroups,
            Call::DenySetgroups,
            Call::ReadSetgroups,
            Call::WriteUid,
            Call::WriteGid,
            Call::ReadUid,
            Call::ReadGid,
            Call::Identity,
            Call::Nspid,
            Call::Namespaces,
            Call::Release,
            Call::ReleaseEof,
            Call::Stop,
            Call::AwaitStopped,
            Call::CloseProtocol,
        ];

        #[test]
        fn full_order_hands_off_armed_exact_custody() {
            let fake = Fake::new();
            let state = fake.state.clone();
            let armed = match launch(fake) {
                Ok(armed) => armed,
                Err(_) => panic!("valid launch failed"),
            };
            assert_eq!(state.borrow().calls, SUCCESS_ORDER);
            assert_eq!(armed.start, START);
            assert_eq!(armed.namespaces, NAMESPACES);
            assert_eq!(armed.kernel.calls(), SUCCESS_ORDER);
            let _still_armed = armed.child;
        }

        fn assert_reaped_after(fake: Fake, failure: Call) -> Vec<Call> {
            fake.state.borrow_mut().fail = Some(failure);
            let state = fake.state.clone();
            assert!(matches!(launch(fake), Err(LaunchFailure::Reaped { .. })));
            let calls = state.borrow().calls.clone();
            assert!(calls.ends_with(&[Call::CloseProtocol, Call::Kill, Call::Reap]));
            calls
        }

        #[test]
        fn partial_map_write_closes_protocol_kills_and_exact_reaps() {
            let fake = Fake::new();
            fake.state.borrow_mut().short = Some(Call::WriteUid);
            let state = fake.state.clone();
            assert!(matches!(launch(fake), Err(LaunchFailure::Reaped { .. })));
            let calls = state.borrow().calls.clone();
            assert!(calls.ends_with(&[
                Call::WriteUid,
                Call::CloseProtocol,
                Call::Kill,
                Call::Reap,
            ]));
            assert!(!calls.contains(&Call::WriteGid));
        }

        #[test]
        fn every_composed_kernel_error_seam_closes_before_kill_and_reap() {
            for failure in [
                Call::Exec,
                Call::Boot,
                Call::Ready,
                Call::ReadyQuiet,
                Call::ReadSetgroups,
                Call::DenySetgroups,
                Call::WriteUid,
                Call::WriteGid,
                Call::ReadUid,
                Call::ReadGid,
                Call::Identity,
                Call::Nspid,
                Call::Namespaces,
                Call::Release,
                Call::ReleaseEof,
                Call::Stop,
                Call::AwaitStopped,
            ] {
                let calls = assert_reaped_after(Fake::new(), failure);
                assert!(calls.ends_with(&[Call::CloseProtocol, Call::Kill, Call::Reap,]));
                assert_eq!(calls[calls.len() - 4], failure);
            }
        }

        #[test]
        fn short_boot_or_release_packet_is_never_retried() {
            for at in [Call::Boot, Call::Release] {
                let fake = Fake::new();
                fake.state.borrow_mut().short = Some(at);
                let state = fake.state.clone();
                assert!(matches!(launch(fake), Err(LaunchFailure::Reaped { .. })));
                let calls = state.borrow().calls.clone();
                assert_eq!(calls.iter().filter(|call| **call == at).count(), 1);
                assert!(calls.ends_with(&[Call::CloseProtocol, Call::Kill, Call::Reap,]));
            }
        }

        #[test]
        fn exec_failure_is_post_clone_and_never_no_child() {
            let calls = assert_reaped_after(Fake::new(), Call::Exec);
            assert_eq!(&calls[..3], &[Call::Clone, Call::Bind, Call::Exec]);
        }

        #[test]
        fn identity_drift_fails_closed_before_nspid_or_release() {
            let fake = Fake::new();
            fake.state.borrow_mut().drift_identity = true;
            let state = fake.state.clone();
            assert!(matches!(launch(fake), Err(LaunchFailure::Reaped { .. })));
            let state = state.borrow();
            assert!(state.calls.contains(&Call::Identity));
            assert!(!state.calls.contains(&Call::Nspid));
            assert!(!state.calls.contains(&Call::Release));
        }

        #[test]
        fn pid_reuse_during_proc_bind_returns_owned_uncertain_not_no_child() {
            let fake = Fake::new();
            fake.state.borrow_mut().bind_pid_reuse = true;
            let state = fake.state.clone();
            assert!(matches!(
                launch(fake),
                Err(LaunchFailure::BindUncertain {
                    custody: BindUnknown,
                    ..
                })
            ));
            assert_eq!(state.borrow().calls, &[Call::Clone, Call::Bind]);
        }

        #[test]
        fn malformed_or_duplicate_ready_closes_before_signal() {
            let malformed = Fake::new();
            malformed.state.borrow_mut().malformed_ready = true;
            let malformed_state = malformed.state.clone();
            assert!(matches!(
                launch(malformed),
                Err(LaunchFailure::Reaped { .. })
            ));
            assert!(malformed_state.borrow().calls.ends_with(&[
                Call::Ready,
                Call::CloseProtocol,
                Call::Kill,
                Call::Reap
            ]));

            let duplicate = Fake::new();
            duplicate.state.borrow_mut().duplicate_ready = true;
            let duplicate_state = duplicate.state.clone();
            assert!(matches!(
                launch(duplicate),
                Err(LaunchFailure::Reaped { .. })
            ));
            assert!(duplicate_state.borrow().calls.ends_with(&[
                Call::ReadyQuiet,
                Call::CloseProtocol,
                Call::Kill,
                Call::Reap
            ]));
        }

        #[test]
        fn release_error_never_hands_off_live_child() {
            let calls = assert_reaped_after(Fake::new(), Call::Release);
            assert_eq!(calls[..calls.len() - 3].last(), Some(&Call::Release));
        }

        #[test]
        fn post_release_terminal_child_is_reaped_without_signalling() {
            let fake = Fake::new();
            fake.state.borrow_mut().terminal_after_release = true;
            let state = fake.state.clone();
            assert!(matches!(launch(fake), Err(LaunchFailure::Reaped { .. })));
            let calls = state.borrow().calls.clone();
            assert!(calls.ends_with(&[Call::AwaitStopped, Call::CloseProtocol, Call::Reap,]));
            assert!(!calls.contains(&Call::Kill));
        }

        #[test]
        fn signal_and_reap_errors_preserve_owned_uncertain_custody() {
            let kill = Fake::new();
            {
                let mut state = kill.state.borrow_mut();
                state.malformed_ready = true;
                state.fail = Some(Call::Kill);
            }
            let kill_state = kill.state.clone();
            assert!(matches!(launch(kill), Err(LaunchFailure::Reaped { .. })));
            assert!(kill_state.borrow().calls.ends_with(&[
                Call::CloseProtocol,
                Call::Kill,
                Call::Reap
            ]));

            let both = Fake::new();
            {
                let mut state = both.state.borrow_mut();
                state.malformed_ready = true;
                state.fail = Some(Call::Kill);
                state.reap_fails = true;
            }
            let both_state = both.state.clone();
            match launch(both) {
                Err(LaunchFailure::Uncertain { custody, .. }) => {
                    assert_eq!(custody.kill_error, Some(FakeError(Call::Kill)));
                    let _owned = custody.custody;
                    let _kernel = custody.kernel;
                }
                _ => panic!("unknown terminality was discarded"),
            }
            assert!(both_state.borrow().calls.ends_with(&[
                Call::CloseProtocol,
                Call::Kill,
                Call::Reap
            ]));
        }

        #[test]
        fn only_negative_clone_attempt_is_no_child() {
            let fake = Fake::new();
            fake.state.borrow_mut().fail = Some(Call::Clone);
            assert!(matches!(launch(fake), Err(LaunchFailure::NoChild { .. })));

            let exec = Fake::new();
            exec.state.borrow_mut().fail = Some(Call::Exec);
            assert!(!matches!(launch(exec), Err(LaunchFailure::NoChild { .. })));
        }
    }
}

#[cfg(test)]
pub(super) mod real_e2e {
    use super::*;
    use crate::raw_clone::{
        CloneExecError, NextChildCustody, RawChild, clone_exec_fixed,
        test_only_mint_exec_failure_fixture, test_only_mint_verified_helper,
    };
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::time::{Duration, Instant};

    const FRAME_LEN: usize = 48;
    const MAGIC: &[u8; 8] = b"ELPISNS\0";
    const NS_GET_USERNS: libc::c_ulong = 0xb701;

    #[derive(Debug)]
    pub(crate) enum Outcome {
        Passed,
        Unavailable(String),
        Failed(String),
    }

    fn frame(kind: u8, nonce: u8) -> [u8; FRAME_LEN] {
        let mut bytes = [0_u8; FRAME_LEN];
        bytes[..8].copy_from_slice(MAGIC);
        bytes[8] = 1;
        bytes[9] = kind;
        bytes[16..].fill(nonce);
        bytes
    }

    fn poll(fd: RawFd, events: i16, timeout: Duration) -> Result<i16, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let millis = i32::try_from(remaining.as_millis().max(1)).unwrap_or(i32::MAX);
            let mut item = libc::pollfd {
                fd,
                events,
                revents: 0,
            };
            let n = unsafe { libc::poll(&mut item, 1, millis) };
            if n > 0 {
                return Ok(item.revents);
            }
            if n == 0 || Instant::now() >= deadline {
                return Err(format!("timeout polling fd {fd} for {events:#x}"));
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EINTR) {
                return Err(format!("poll fd {fd}: {error}"));
            }
        }
    }

    fn send_packet(fd: RawFd, bytes: &[u8]) -> Result<(), String> {
        let n = unsafe { libc::send(fd, bytes.as_ptr().cast(), bytes.len(), libc::MSG_NOSIGNAL) };
        if n == bytes.len() as isize {
            Ok(())
        } else if n < 0 {
            Err(format!(
                "send protocol packet: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Err(format!("short protocol packet: {n}/{}", bytes.len()))
        }
    }

    fn recv_packet(fd: RawFd) -> Result<[u8; FRAME_LEN], String> {
        poll(fd, libc::POLLIN | libc::POLLHUP, Duration::from_secs(3))?;
        let mut bytes = [0_u8; FRAME_LEN];
        let n = unsafe { libc::recv(fd, bytes.as_mut_ptr().cast(), bytes.len(), libc::MSG_TRUNC) };
        if n == FRAME_LEN as isize {
            Ok(bytes)
        } else if n == 0 {
            Err("protocol receipt reached EOF before frame".into())
        } else if n < 0 {
            Err(format!(
                "receive protocol packet: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Err(format!("noncanonical protocol packet length {n}"))
        }
    }

    fn require_no_packet(fd: RawFd) -> Result<(), String> {
        let mut item = libc::pollfd {
            fd,
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        let n = unsafe { libc::poll(&mut item, 1, 100) };
        if n == 0 {
            Ok(())
        } else if n < 0 {
            Err(format!(
                "poll no-packet: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Err(format!(
                "child emitted/closed receipt early: revents={:#x}",
                item.revents
            ))
        }
    }

    fn require_exec_success(fd: RawFd) -> Result<(), String> {
        poll(fd, libc::POLLIN | libc::POLLHUP, Duration::from_secs(3))?;
        let mut byte = 0_u8;
        let n = unsafe { libc::read(fd, (&mut byte as *mut u8).cast(), 1) };
        if n == 0 {
            Ok(())
        } else if n < 0 {
            Err(format!(
                "read exec status: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Err("child reported a setup/exec failure frame".into())
        }
    }

    fn parent_namespaces() -> Result<NamespaceIdentities, String> {
        fn one(name: &str) -> Result<NamespaceIdentity, String> {
            let metadata = std::fs::metadata(format!("/proc/self/ns/{name}"))
                .map_err(|e| format!("stat parent namespace {name}: {e}"))?;
            use std::os::unix::fs::MetadataExt;
            if metadata.dev() == 0 || metadata.ino() == 0 {
                return Err(format!("zero identity for parent namespace {name}"));
            }
            Ok(NamespaceIdentity {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        Ok(NamespaceIdentities {
            user: one("user")?,
            mount: one("mnt")?,
            pid: one("pid")?,
            network: one("net")?,
        })
    }

    fn open_ns(dir: RawFd, name: &str) -> Result<OwnedFd, String> {
        let name = CString::new(format!("ns/{name}")).expect("fixed namespace name");
        let fd = unsafe { libc::openat(dir, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
        if fd < 0 {
            Err(format!(
                "open child namespace: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }

    fn identity(fd: RawFd) -> Result<NamespaceIdentity, String> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return Err(format!(
                "fstat namespace: {}",
                std::io::Error::last_os_error()
            ));
        }
        let stat = unsafe { stat.assume_init() };
        Ok(NamespaceIdentity {
            device: stat.st_dev,
            inode: stat.st_ino,
        })
    }

    fn require_namespace_owners(
        child: &ExactChild<LinuxKernel, NextChildCustody>,
        expected_user: NamespaceIdentity,
    ) -> Result<(), String> {
        for name in ["mnt", "pid", "net"] {
            let namespace = open_ns(child.proc_dir.as_raw_fd(), name)?;
            let owner = unsafe { libc::ioctl(namespace.as_raw_fd(), NS_GET_USERNS) };
            if owner < 0 {
                return Err(format!(
                    "NS_GET_USERNS for {name}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let owner = unsafe { OwnedFd::from_raw_fd(owner) };
            if identity(owner.as_raw_fd())? != expected_user {
                return Err(format!(
                    "{name} namespace is not owned by child user namespace"
                ));
            }
        }
        Ok(())
    }

    fn clone_bound() -> Result<ExactChild<LinuxKernel, NextChildCustody>, Outcome> {
        let helper = test_only_mint_verified_helper()
            .map_err(|e| Outcome::Failed(format!("verified helper mint: {e}")))?;
        let raw = match clone_exec_fixed(helper) {
            Ok(raw) => raw,
            Err(CloneExecError::NoChild(error))
                if matches!(error.raw_os_error(), Some(libc::EPERM | libc::EACCES)) =>
            {
                return Err(Outcome::Unavailable(format!(
                    "clone3 NEWUSER|NEWNS|NEWPID|NEWNET denied with errno {} ({error})",
                    error.raw_os_error().unwrap_or_default()
                )));
            }
            Err(error) => return Err(Outcome::Failed(format!("clone3 fixed child: {error:?}"))),
        };
        let custody = raw.into_next_custody();
        require_exec_success(custody.exec_status_fd()).map_err(Outcome::Failed)?;
        bind(custody).map_err(|_| {
            Outcome::Failed("exact pidfd/proc/start binding aborted and reaped child".into())
        })
    }

    fn raw_map(
        child: &mut ExactChild<LinuxKernel, NextChildCustody>,
        name: &'static str,
    ) -> Result<Vec<u8>, String> {
        read_named(&mut child.kernel, &child.proc_dir, name, MAX_MAP)
            .map_err(|e| format!("read {name}: {e:?}"))
    }

    fn require_parent_unchanged(before: NamespaceIdentities) -> Result<(), String> {
        let after = parent_namespaces()?;
        if before == after {
            Ok(())
        } else {
            Err(format!(
                "parent namespaces changed: {before:?} -> {after:?}"
            ))
        }
    }

    fn wait_terminal(
        child: ExactChild<LinuxKernel, NextChildCustody>,
    ) -> Result<TerminalReceipt, String> {
        let fd = child
            .custody
            .pidfd()
            .ok_or_else(|| "bound child lost pidfd".to_string())?;
        poll(fd, libc::POLLIN | libc::POLLHUP, Duration::from_secs(3))?;
        child
            .wait()
            .map_err(|_| "exact pidfd wait/reap became uncertain".into())
    }

    fn abort_exact(
        mut child: ExactChild<LinuxKernel, NextChildCustody>,
    ) -> Result<TerminalReceipt, String> {
        child.custody.close_protocol();
        child
            .send_signal(libc::SIGKILL)
            .map_err(|e| format!("pidfd SIGKILL: {e:?}"))?;
        wait_terminal(child)
    }

    fn require_receipt_eof(fd: RawFd) -> Result<(), String> {
        poll(fd, libc::POLLIN | libc::POLLHUP, Duration::from_secs(3))?;
        let mut byte = 0_u8;
        let n = unsafe { libc::recv(fd, (&mut byte as *mut u8).cast(), 1, 0) };
        if n == 0 {
            Ok(())
        } else {
            Err(format!("expected receipt EOF before SIGSTOP, got {n}"))
        }
    }

    fn run_success() -> Result<(), Outcome> {
        let parent = parent_namespaces().map_err(Outcome::Failed)?;
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        if uid == 0 || gid == 0 {
            return Err(Outcome::Failed(format!(
                "fixture must be nonroot, observed uid={uid} gid={gid}"
            )));
        }
        let mut child = clone_bound()?;
        let start = child
            .identity()
            .map_err(|e| Outcome::Failed(format!("start identity: {e:?}")))?;
        let pidfd_target = child
            .kernel
            .pidfd_target(child.custody.pidfd().unwrap())
            .map_err(|e| Outcome::Failed(format!("pidfd fdinfo: {e}")))?;
        if pidfd_target != PidfdTarget::Process(start.outer_pid) {
            return Err(Outcome::Failed(format!(
                "pidfd fdinfo target mismatch: {pidfd_target:?} vs {start:?}"
            )));
        }
        if let Err(error) = require_no_packet(child.custody.receipt_fd()) {
            let receipt = wait_terminal(child)
                .map_err(|wait| Outcome::Failed(format!("{error}; terminal wait: {wait}")))?;
            return Err(Outcome::Failed(format!(
                "{error}; helper terminal disposition: {:?}",
                receipt.disposition
            )));
        }
        if !raw_map(&mut child, "uid_map")
            .map_err(Outcome::Failed)?
            .is_empty()
            || !raw_map(&mut child, "gid_map")
                .map_err(Outcome::Failed)?
                .is_empty()
        {
            return Err(Outcome::Failed(
                "child was mapped before Ready synchronization".into(),
            ));
        }
        let child_ns = child
            .read_namespaces()
            .map_err(|e| Outcome::Failed(format!("child namespaces: {e:?}")))?;
        if child_ns.user == parent.user
            || child_ns.mount == parent.mount
            || child_ns.pid == parent.pid
            || child_ns.network == parent.network
        {
            return Err(Outcome::Failed(format!(
                "clone did not create all four namespaces: parent={parent:?} child={child_ns:?}"
            )));
        }
        require_namespace_owners(&child, child_ns.user).map_err(Outcome::Failed)?;

        let nonce = 0x5a;
        send_packet(child.custody.control_fd(), &frame(1, nonce)).map_err(Outcome::Failed)?;
        let ready = recv_packet(child.custody.receipt_fd()).map_err(Outcome::Failed)?;
        if ready != frame(2, nonce) {
            return Err(Outcome::Failed(
                "Ready receipt was not exact or nonce-bound".into(),
            ));
        }
        require_no_packet(child.custody.receipt_fd()).map_err(Outcome::Failed)?;
        child
            .write_setgroups_deny()
            .map_err(|e| Outcome::Failed(format!("setgroups deny: {e:?}")))?;
        child
            .write_uid_map(uid)
            .map_err(|e| Outcome::Failed(format!("uid_map: {e:?}")))?;
        child
            .write_gid_map(gid)
            .map_err(|e| Outcome::Failed(format!("gid_map: {e:?}")))?;
        if child
            .read_setgroups()
            .map_err(|e| Outcome::Failed(format!("read setgroups: {e:?}")))?
            != b"deny\n"
            || child
                .read_uid_map()
                .map_err(|e| Outcome::Failed(format!("read uid_map: {e:?}")))?
                != (IdMapExtent {
                    inside: 0,
                    outside: uid,
                    length: 1,
                })
            || child
                .read_gid_map()
                .map_err(|e| Outcome::Failed(format!("read gid_map: {e:?}")))?
                != (IdMapExtent {
                    inside: 0,
                    outside: gid,
                    length: 1,
                })
        {
            return Err(Outcome::Failed(
                "exact nonzero map readback mismatch".into(),
            ));
        }
        if child
            .read_nspid()
            .map_err(|e| Outcome::Failed(format!("NSpid: {e:?}")))?
            != [start.outer_pid, 1]
        {
            return Err(Outcome::Failed("NSpid was not [outer, 1]".into()));
        }
        if child
            .read_namespaces()
            .map_err(|e| Outcome::Failed(format!("namespace recheck: {e:?}")))?
            != child_ns
        {
            return Err(Outcome::Failed(
                "child namespace identity drifted across mapping".into(),
            ));
        }
        require_parent_unchanged(parent).map_err(Outcome::Failed)?;

        send_packet(child.custody.control_fd(), &frame(3, nonce)).map_err(Outcome::Failed)?;
        require_receipt_eof(child.custody.receipt_fd()).map_err(Outcome::Failed)?;
        child
            .send_signal(libc::SIGSTOP)
            .map_err(|e| Outcome::Failed(format!("pidfd SIGSTOP: {e:?}")))?;
        let release_state = child
            .wait_release_state()
            .map_err(|e| Outcome::Failed(format!("SIGSTOP wait: {e:?}")))?;
        if release_state != ReleaseState::Stopped {
            return Err(Outcome::Failed(format!(
                "release did not end at exact SIGSTOP: {release_state:?}"
            )));
        }
        let old_pidfd =
            unsafe { libc::fcntl(child.custody.pidfd().unwrap(), libc::F_DUPFD_CLOEXEC, 7) };
        if old_pidfd < 0 {
            return Err(Outcome::Failed(format!(
                "duplicate pidfd: {}",
                std::io::Error::last_os_error()
            )));
        }
        let old_pidfd = unsafe { OwnedFd::from_raw_fd(old_pidfd) };
        let receipt = abort_exact(child).map_err(Outcome::Failed)?;
        if receipt.start != start
            || receipt.disposition != TerminalDisposition::Signaled(libc::SIGKILL)
        {
            return Err(Outcome::Failed(format!(
                "wrong exact reap receipt: {receipt:?}"
            )));
        }
        let replacement = unsafe { libc::fork() };
        if replacement < 0 {
            return Err(Outcome::Failed(format!(
                "fork later identity: {}",
                std::io::Error::last_os_error()
            )));
        }
        if replacement == 0 {
            unsafe {
                libc::pause();
                libc::_exit(0);
            }
        }
        let signal = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                old_pidfd.as_raw_fd(),
                libc::SIGKILL,
                0,
                0,
            )
        };
        let old_error = std::io::Error::last_os_error().raw_os_error();
        let replacement_alive = unsafe { libc::kill(replacement, 0) } == 0;
        unsafe { libc::kill(replacement, libc::SIGKILL) };
        let mut replacement_status = 0;
        let replacement_reaped =
            unsafe { libc::waitpid(replacement, &mut replacement_status, 0) } == replacement;
        if signal == 0
            || old_error != Some(libc::ESRCH)
            || !replacement_alive
            || !replacement_reaped
        {
            return Err(Outcome::Failed(format!(
                "terminal pidfd did not remain bound away from later process identity: signal={signal} errno={old_error:?} alive={replacement_alive} reaped={replacement_reaped}"
            )));
        }
        require_parent_unchanged(parent).map_err(Outcome::Failed)
    }

    fn run_protocol(case: &str) -> Result<(), Outcome> {
        let parent = parent_namespaces().map_err(Outcome::Failed)?;
        let mut child = clone_bound()?;
        let start = child
            .identity()
            .map_err(|e| Outcome::Failed(format!("identity: {e:?}")))?;
        let receipt_watch = if case == "parent_eof" {
            None
        } else {
            let fd = unsafe { libc::fcntl(child.custody.receipt_fd(), libc::F_DUPFD_CLOEXEC, 7) };
            if fd < 0 {
                return Err(Outcome::Failed(format!(
                    "duplicate receipt witness: {}",
                    std::io::Error::last_os_error()
                )));
            }
            Some(unsafe { OwnedFd::from_raw_fd(fd) })
        };
        match case {
            "malformed" => {
                send_packet(child.custody.control_fd(), b"malformed").map_err(Outcome::Failed)?
            }
            "duplicate" => {
                child
                    .send_signal(libc::SIGSTOP)
                    .map_err(|e| Outcome::Failed(format!("freeze before duplicate: {e:?}")))?;
                if child
                    .wait_release_state()
                    .map_err(|e| Outcome::Failed(format!("wait duplicate freeze: {e:?}")))?
                    != ReleaseState::Stopped
                {
                    return Err(Outcome::Failed("duplicate fixture did not stop".into()));
                }
                send_packet(child.custody.control_fd(), &frame(1, 0x31))
                    .map_err(Outcome::Failed)?;
                send_packet(child.custody.control_fd(), &frame(3, 0x31))
                    .map_err(Outcome::Failed)?;
                child
                    .send_signal(libc::SIGCONT)
                    .map_err(|e| Outcome::Failed(format!("resume duplicate fixture: {e:?}")))?;
            }
            "parent_eof" => child.custody.close_protocol(),
            _ => unreachable!(),
        }
        let receipt = wait_terminal(child).map_err(Outcome::Failed)?;
        if receipt.start != start || receipt.disposition != TerminalDisposition::Exited(125) {
            return Err(Outcome::Failed(format!(
                "{case} did not fail closed/reap exact child: {receipt:?}"
            )));
        }
        if let Some(watch) = receipt_watch {
            let mut unexpected = [0_u8; FRAME_LEN];
            let count = unsafe {
                libc::recv(
                    watch.as_raw_fd(),
                    unexpected.as_mut_ptr().cast(),
                    unexpected.len(),
                    libc::MSG_DONTWAIT,
                )
            };
            if count != 0 {
                return Err(Outcome::Failed(format!(
                    "{case} emitted an unexpected Ready receipt: count={count}"
                )));
            }
        }
        require_parent_unchanged(parent).map_err(Outcome::Failed)
    }

    fn run_map_abort(partial: bool) -> Result<(), Outcome> {
        let parent = parent_namespaces().map_err(Outcome::Failed)?;
        let uid = unsafe { libc::geteuid() };
        let mut child = clone_bound()?;
        send_packet(child.custody.control_fd(), &frame(1, 0x42)).map_err(Outcome::Failed)?;
        if recv_packet(child.custody.receipt_fd()).map_err(Outcome::Failed)? != frame(2, 0x42) {
            return Err(Outcome::Failed("map-abort case lacked exact Ready".into()));
        }
        child
            .write_setgroups_deny()
            .map_err(|e| Outcome::Failed(format!("setgroups: {e:?}")))?;
        if partial {
            child
                .write_uid_map(uid)
                .map_err(|e| Outcome::Failed(format!("partial uid map: {e:?}")))?;
            if child
                .read_uid_map()
                .map_err(|e| Outcome::Failed(format!("partial uid readback: {e:?}")))?
                != (IdMapExtent {
                    inside: 0,
                    outside: uid,
                    length: 1,
                })
                || !raw_map(&mut child, "gid_map")
                    .map_err(Outcome::Failed)?
                    .is_empty()
            {
                return Err(Outcome::Failed(
                    "partial-map fixture did not contain exactly uid-only mapping".into(),
                ));
            }
        } else {
            let wrong = uid
                .checked_add(1)
                .ok_or_else(|| Outcome::Failed("uid overflow".into()))?;
            match child.write_uid_map(wrong) {
                Err(ExactError::Kernel(error))
                    if matches!(
                        error.raw_os_error(),
                        Some(libc::EPERM | libc::EACCES | libc::EINVAL)
                    ) =>
                {
                    if !raw_map(&mut child, "uid_map")
                        .map_err(Outcome::Failed)?
                        .is_empty()
                    {
                        return Err(Outcome::Failed(
                            "rejected wrong uid map changed kernel state".into(),
                        ));
                    }
                }
                Ok(()) => {
                    return Err(Outcome::Failed(format!(
                        "kernel accepted wrong outside uid {wrong} for fixture uid {uid}"
                    )));
                }
                Err(error) => {
                    return Err(Outcome::Failed(format!(
                        "wrong uid map failed for a non-policy reason: {error:?}"
                    )));
                }
            }
        }
        send_packet(child.custody.control_fd(), &frame(3, 0x42)).map_err(Outcome::Failed)?;
        let receipt = wait_terminal(child).map_err(Outcome::Failed)?;
        if receipt.disposition != TerminalDisposition::Exited(125) {
            return Err(Outcome::Failed(format!(
                "wrong or partial map did not fail child post-map validation: {receipt:?}"
            )));
        }
        require_parent_unchanged(parent).map_err(Outcome::Failed)
    }

    fn run_post_map_bad_release() -> Result<(), Outcome> {
        let parent = parent_namespaces().map_err(Outcome::Failed)?;
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let mut child = clone_bound()?;
        send_packet(child.custody.control_fd(), &frame(1, 0x51)).map_err(Outcome::Failed)?;
        if recv_packet(child.custody.receipt_fd()).map_err(Outcome::Failed)? != frame(2, 0x51) {
            return Err(Outcome::Failed("post-map case lacked Ready".into()));
        }
        child
            .write_setgroups_deny()
            .map_err(|e| Outcome::Failed(format!("setgroups: {e:?}")))?;
        child
            .write_uid_map(uid)
            .map_err(|e| Outcome::Failed(format!("uid map: {e:?}")))?;
        child
            .write_gid_map(gid)
            .map_err(|e| Outcome::Failed(format!("gid map: {e:?}")))?;
        send_packet(child.custody.control_fd(), &frame(3, 0x52)).map_err(Outcome::Failed)?;
        let receipt = wait_terminal(child).map_err(Outcome::Failed)?;
        if receipt.disposition != TerminalDisposition::Exited(125) {
            return Err(Outcome::Failed(format!(
                "wrong-nonce release did not abort: {receipt:?}"
            )));
        }
        require_parent_unchanged(parent).map_err(Outcome::Failed)
    }

    fn run_exec_failure() -> Result<(), Outcome> {
        let parent = parent_namespaces().map_err(Outcome::Failed)?;
        let helper = test_only_mint_exec_failure_fixture()
            .map_err(|e| Outcome::Failed(format!("exec-failure fixture: {e}")))?;
        let raw: RawChild = match clone_exec_fixed(helper) {
            Ok(raw) => raw,
            Err(CloneExecError::NoChild(error))
                if matches!(error.raw_os_error(), Some(libc::EPERM | libc::EACCES)) =>
            {
                return Err(Outcome::Unavailable(format!(
                    "clone3 denied in exec-failure case: {error}"
                )));
            }
            Err(error) => return Err(Outcome::Failed(format!("exec-failure clone: {error:?}"))),
        };
        poll(
            raw.exec_status().as_raw_fd(),
            libc::POLLIN | libc::POLLHUP,
            Duration::from_secs(3),
        )
        .map_err(Outcome::Failed)?;
        let mut status = [0_u8; 16];
        let n = unsafe {
            libc::read(
                raw.exec_status().as_raw_fd(),
                status.as_mut_ptr().cast(),
                status.len(),
            )
        };
        if n != status.len() as isize
            || &status[..4] != b"ELPX"
            || u16::from_ne_bytes([status[6], status[7]]) != 9
            || i32::from_ne_bytes([status[8], status[9], status[10], status[11]]) != libc::ENOEXEC
        {
            return Err(Outcome::Failed(format!(
                "wrong execveat failure frame: n={n} bytes={status:?}"
            )));
        }
        raw.abort_and_reap()
            .map_err(|e| Outcome::Failed(format!("exec-failure reap: {e:?}")))?;
        require_parent_unchanged(parent).map_err(Outcome::Failed)
    }

    pub(crate) fn run(case: &str) -> Outcome {
        let result = match case {
            "success" => run_success(),
            "composed" => super::stopped_child_composition::test_only_real_launch(
                unsafe { libc::geteuid() },
                unsafe { libc::getegid() },
            )
            .map_err(Outcome::Failed),
            "malformed" | "duplicate" | "parent_eof" => run_protocol(case),
            "wrong_map" => run_map_abort(false),
            "partial_map" => run_map_abort(true),
            "post_map_bad_release" => run_post_map_bad_release(),
            "exec_failure" => run_exec_failure(),
            other => Err(Outcome::Failed(format!("unknown real e2e case {other}"))),
        };
        match result {
            Ok(()) => Outcome::Passed,
            Err(outcome) => outcome,
        }
    }
}
