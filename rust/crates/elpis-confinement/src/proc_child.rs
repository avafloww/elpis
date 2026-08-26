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
    fn disarm_after_exact_reap(&mut self);
}
impl ChildCustody for NextChildCustody {
    fn pid(&self) -> libc::pid_t {
        self.child().pid()
    }
    fn pidfd(&self) -> Option<RawFd> {
        self.child().pidfd().map(|fd| fd.as_raw_fd())
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
        let target = self
            .kernel
            .pidfd_target(pidfd)
            .map_err(ExactError::Kernel)?;
        match target {
            PidfdTarget::Process(pid) if pid == self.start.outer_pid => {}
            PidfdTarget::NoTask if terminal_ok && state == PidfdState::Terminal => {}
            _ => return Err(ExactError::PidfdSubstitution),
        }
        if state == PidfdState::Terminal && !terminal_ok {
            return Err(ExactError::PidfdTerminal);
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
