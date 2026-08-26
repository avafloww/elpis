//! Private Linux x86_64 clone3/execveat leaf; intentionally unwired.
#![allow(dead_code)]

use std::arch::asm;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};

const CONTROL_FD: RawFd = 3;
const RECEIPT_FD: RawFd = 4;
const HELPER_FD: RawFd = 5;
const STATUS_FD: RawFd = 6;
const FIRST_CLOSED_FD: u32 = 7;
const CHILD_FAILURE_EXIT: i32 = 125;
const P_PIDFD: usize = 3;
const FRAME_SIZE: usize = 16;
const CLONE_FLAGS: u64 = libc::CLONE_NEWUSER as u64
    | libc::CLONE_NEWNS as u64
    | libc::CLONE_NEWPID as u64
    | libc::CLONE_NEWNET as u64
    | libc::CLONE_PIDFD as u64;
const SEQPACKET_TYPE: i32 = libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC;
const PIPE_FLAGS: i32 = libc::O_CLOEXEC;
static ARG0: &[u8] = b"elpis-sensitive-namespace-bootstrap\0";
static EMPTY_PATH: &[u8] = b"\0";

/// Boot verification mints this capability only after checking hash,
/// device/inode/mount identity, read-only state, owner, mode, and size. This
/// leaf consumes that result and intentionally has no pathname constructor.
pub(super) struct BootFrozenHelperFd {
    fd: OwnedFd,
}

// Deliberately no constructor. Future boot integration must add the narrowly
// scoped mint after its identity proof exists; this leaf can only consume it.

#[cfg(test)]
pub(super) fn test_only_mint_verified_helper() -> Result<BootFrozenHelperFd, io::Error> {
    use sha2::{Digest, Sha256};
    use std::ffi::CString;
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let path =
        option_env!("CARGO_BIN_EXE_elpis-sensitive-namespace-bootstrap").ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "fixed test helper identity unavailable",
            )
        })?;
    let open = || {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path)
    };
    let mut first = open()?;
    let mut second = open()?;
    let before_first = first.metadata()?;
    let before_second = second.metadata()?;

    let name = CString::new("elpis-verified-test-helper").expect("fixed memfd name");
    let fd = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        ) as RawFd
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut sealed = File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let mut first_hash = Sha256::new();
    let mut bytes = [0_u8; 16 * 1024];
    loop {
        let count = first.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        first_hash.update(&bytes[..count]);
        sealed.write_all(&bytes[..count])?;
    }
    let first_digest: [u8; 32] = first_hash.finalize().into();

    let mut second_hash = Sha256::new();
    loop {
        let count = second.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        second_hash.update(&bytes[..count]);
    }
    let second_digest: [u8; 32] = second_hash.finalize().into();
    let after_first = first.metadata()?;
    let after_second = second.metadata()?;
    let identity = |metadata: &std::fs::Metadata| {
        (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.uid(),
            metadata.gid(),
            metadata.mode(),
        )
    };
    let current_uid = unsafe { libc::geteuid() };
    let current_gid = unsafe { libc::getegid() };
    let acceptable = before_first.is_file()
        && before_first.dev() != 0
        && before_first.ino() != 0
        && before_first.len() != 0
        && (before_first.uid() == 0 || before_first.uid() == current_uid)
        && before_first.mode() & 0o111 != 0
        && before_first.mode() & 0o002 == 0
        && (before_first.mode() & 0o020 == 0 || before_first.gid() == current_gid)
        && first_digest.iter().any(|byte| *byte != 0)
        && first_digest == second_digest
        && identity(&before_first) == identity(&before_second)
        && identity(&before_first) == identity(&after_first)
        && identity(&before_first) == identity(&after_second);
    if !acceptable {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "fixed test helper identity changed or violated source invariants",
        ));
    }
    if unsafe { libc::fchmod(sealed.as_raw_fd(), 0o500) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(sealed.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(BootFrozenHelperFd { fd: sealed.into() })
}
#[cfg(test)]
pub(super) fn test_only_mint_exec_failure_fixture() -> Result<BootFrozenHelperFd, io::Error> {
    use std::ffi::CString;

    // First require the same verified fixed helper identity as the success
    // path. The malformed executable is an anonymous, sealed derivative used
    // only to exercise the real post-clone execveat failure path.
    drop(test_only_mint_verified_helper()?);
    let name = CString::new("elpis-exec-failure-fixture").expect("fixed memfd name");
    let fd = unsafe {
        libc::syscall(
            libc::SYS_memfd_create,
            name.as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        ) as RawFd
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let bytes = b"ELPIS deliberately invalid executable\n";
    let written = unsafe { libc::write(fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
    if written != bytes.len() as isize {
        return Err(if written < 0 {
            io::Error::last_os_error()
        } else {
            io::Error::from_raw_os_error(libc::EIO)
        });
    }
    if unsafe { libc::fchmod(fd.as_raw_fd(), 0o500) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(BootFrozenHelperFd { fd })
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CloneArgs {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}
const _: () = assert!(std::mem::size_of::<CloneArgs>() == 88);

#[repr(u16)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChildStage {
    SetParentDeathSignal = 1,
    ReadParentDeathSignal = 2,
    ParentDeathSignalMismatch = 3,
    DupControl = 4,
    DupReceipt = 5,
    DupHelper = 6,
    DupStatus = 7,
    CloseRange = 8,
    Execveat = 9,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct ChildErrorFrame {
    magic: [u8; 4],
    version: u16,
    stage: u16,
    errno: i32,
    reserved: u32,
}
const _: () = assert!(std::mem::size_of::<ChildErrorFrame>() == FRAME_SIZE);

impl ChildErrorFrame {
    fn new(stage: ChildStage, errno: i32) -> Self {
        Self {
            magic: *b"ELPX",
            version: 1,
            stage: stage as u16,
            errno,
            reserved: 0,
        }
    }
}

#[derive(Clone, Copy)]
struct ChildInputs {
    control_source: RawFd,
    receipt_source: RawFd,
    helper_source: RawFd,
    status_source: RawFd,
    argv: [*const libc::c_char; 2],
    envp: [*const libc::c_char; 1],
}

impl ChildInputs {
    fn new(fds: &PreparedFds) -> Self {
        Self {
            control_source: fds.control_child.as_raw_fd(),
            receipt_source: fds.receipt_child.as_raw_fd(),
            helper_source: fds.helper.as_raw_fd(),
            status_source: fds.status_write.as_raw_fd(),
            argv: [ARG0.as_ptr().cast(), std::ptr::null()],
            envp: [std::ptr::null()],
        }
    }
}

/// DirectChildSyscalls implements every method as one raw syscall instruction.
/// The trait is only a seam for pure tests of the child branch.
///
/// # Safety
/// Implementations must not allocate, unwind, access thread-local state, acquire
/// locks, invoke destructors, or call anything except the represented raw
/// async-signal-safe syscall. Returned errors use the kernel's negative errno
/// convention, not libc's `-1` plus thread-local `errno`.
unsafe trait ChildSyscalls {
    unsafe fn prctl(&mut self, option: usize, arg2: usize) -> i64;
    unsafe fn dup3(&mut self, old: RawFd, new: RawFd, flags: i32) -> i64;
    unsafe fn close_range(&mut self, first: u32, last: u32, flags: u32) -> i64;
    unsafe fn close(&mut self, fd: RawFd) -> i64;
    unsafe fn execveat(
        &mut self,
        fd: RawFd,
        path: *const libc::c_char,
        argv: *const *const libc::c_char,
        envp: *const *const libc::c_char,
        flags: i32,
    ) -> i64;
    unsafe fn write(&mut self, fd: RawFd, bytes: *const u8, len: usize) -> i64;
    unsafe fn exit(&mut self, status: i32) -> !;
}

struct DirectChildSyscalls;
unsafe impl ChildSyscalls for DirectChildSyscalls {
    unsafe fn prctl(&mut self, option: usize, arg2: usize) -> i64 {
        unsafe { raw_syscall5(libc::SYS_prctl, option, arg2, 0, 0, 0) }
    }
    unsafe fn dup3(&mut self, old: RawFd, new: RawFd, flags: i32) -> i64 {
        unsafe { raw_syscall3(libc::SYS_dup3, old as usize, new as usize, flags as usize) }
    }
    unsafe fn close_range(&mut self, first: u32, last: u32, flags: u32) -> i64 {
        unsafe {
            raw_syscall3(
                libc::SYS_close_range,
                first as usize,
                last as usize,
                flags as usize,
            )
        }
    }
    unsafe fn close(&mut self, fd: RawFd) -> i64 {
        unsafe { raw_syscall1(libc::SYS_close, fd as usize) }
    }
    unsafe fn execveat(
        &mut self,
        fd: RawFd,
        path: *const libc::c_char,
        argv: *const *const libc::c_char,
        envp: *const *const libc::c_char,
        flags: i32,
    ) -> i64 {
        unsafe {
            raw_syscall5(
                libc::SYS_execveat,
                fd as usize,
                path as usize,
                argv as usize,
                envp as usize,
                flags as usize,
            )
        }
    }
    unsafe fn write(&mut self, fd: RawFd, bytes: *const u8, len: usize) -> i64 {
        unsafe { raw_syscall3(libc::SYS_write, fd as usize, bytes as usize, len) }
    }
    unsafe fn exit(&mut self, status: i32) -> ! {
        unsafe {
            let _ = raw_syscall1(libc::SYS_exit, status as usize);
            asm!("ud2", options(noreturn, nostack));
        }
    }
}

#[inline]
fn syscall_errno(result: i64) -> i32 {
    if (-4095..=-1).contains(&result) {
        (-result) as i32
    } else {
        libc::EIO
    }
}

/// Audited child-only body. Do not add allocation, std I/O, formatting, TLS,
/// locks, unwinding, or values with destructors. All pointers and fds were
/// prepared before clone3.
unsafe fn child_only<S: ChildSyscalls>(sys: &mut S, input: *const ChildInputs) -> ! {
    unsafe {
        let input = &*input;
        let mut report_fd = input.status_source;

        let r = sys.prctl(libc::PR_SET_PDEATHSIG as usize, libc::SIGKILL as usize);
        if r < 0 {
            report_and_exit(
                sys,
                report_fd,
                ChildStage::SetParentDeathSignal,
                syscall_errno(r),
            );
        }

        let mut observed = 0i32;
        let r = sys.prctl(
            libc::PR_GET_PDEATHSIG as usize,
            (&mut observed as *mut i32) as usize,
        );
        if r < 0 {
            report_and_exit(
                sys,
                report_fd,
                ChildStage::ReadParentDeathSignal,
                syscall_errno(r),
            );
        }
        if observed != libc::SIGKILL {
            report_and_exit(
                sys,
                report_fd,
                ChildStage::ParentDeathSignalMismatch,
                libc::EIO,
            );
        }

        let r = sys.dup3(input.control_source, CONTROL_FD, 0);
        if r < 0 {
            report_and_exit(sys, report_fd, ChildStage::DupControl, syscall_errno(r));
        }
        let r = sys.dup3(input.receipt_source, RECEIPT_FD, 0);
        if r < 0 {
            report_and_exit(sys, report_fd, ChildStage::DupReceipt, syscall_errno(r));
        }
        let r = sys.dup3(input.helper_source, HELPER_FD, libc::O_CLOEXEC);
        if r < 0 {
            report_and_exit(sys, report_fd, ChildStage::DupHelper, syscall_errno(r));
        }
        let r = sys.dup3(input.status_source, STATUS_FD, libc::O_CLOEXEC);
        if r < 0 {
            report_and_exit(sys, report_fd, ChildStage::DupStatus, syscall_errno(r));
        }
        report_fd = STATUS_FD;

        let r = sys.close_range(FIRST_CLOSED_FD, u32::MAX, 0);
        if r < 0 {
            report_and_exit(sys, report_fd, ChildStage::CloseRange, syscall_errno(r));
        }
        // Linux closes an fd even when close reports EINTR; retrying is unsafe.
        let _ = sys.close(0);
        let _ = sys.close(1);
        let _ = sys.close(2);

        let r = sys.execveat(
            HELPER_FD,
            EMPTY_PATH.as_ptr().cast(),
            input.argv.as_ptr(),
            input.envp.as_ptr(),
            libc::AT_EMPTY_PATH,
        );
        report_and_exit(sys, report_fd, ChildStage::Execveat, syscall_errno(r));
    }
}

unsafe fn report_and_exit<S: ChildSyscalls>(
    sys: &mut S,
    fd: RawFd,
    stage: ChildStage,
    errno: i32,
) -> ! {
    unsafe {
        let frame = ChildErrorFrame::new(stage, errno);
        let bytes = (&frame as *const ChildErrorFrame).cast::<u8>();
        let mut written = 0usize;
        while written < FRAME_SIZE {
            let r = sys.write(fd, bytes.add(written), FRAME_SIZE - written);
            if r > 0 {
                let count = r as usize;
                if count > FRAME_SIZE - written {
                    break;
                }
                written += count;
            } else if r == -(libc::EINTR as i64) {
                continue;
            } else {
                break;
            }
        }
        sys.exit(CHILD_FAILURE_EXIT)
    }
}

struct PreparedFds {
    control_parent: OwnedFd,
    control_child: OwnedFd,
    receipt_parent: OwnedFd,
    receipt_child: OwnedFd,
    helper: OwnedFd,
    status_read: OwnedFd,
    status_write: OwnedFd,
}

impl PreparedFds {
    fn new(helper: BootFrozenHelperFd) -> Result<Self, i32> {
        let (control_parent, control_child) = seqpacket_pair()?;
        let (receipt_parent, receipt_child) = seqpacket_pair()?;
        let (status_read, status_write) = cloexec_pipe()?;
        // Normalize every related fd above 6. Thus no dup3 source is clobbered,
        // and one bounded close_range removes sources, parent ends and ambient fds.
        Ok(Self {
            control_parent: normalize_source(control_parent)?,
            control_child: normalize_source(control_child)?,
            receipt_parent: normalize_source(receipt_parent)?,
            receipt_child: normalize_source(receipt_child)?,
            helper: normalize_source(helper.fd)?,
            status_read: normalize_source(status_read)?,
            status_write: normalize_source(status_write)?,
        })
    }
}

#[derive(Debug)]
pub(super) enum CloneExecError {
    Preparation(io::Error),
    /// Produced only by a negative clone3 return.
    NoChild(io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloneReturn {
    NoChild(i32),
    ChildBranch,
    ParentChild {
        pid: libc::pid_t,
        pidfd: Option<RawFd>,
    },
}
fn classify_clone_return(result: i64, slot: RawFd) -> CloneReturn {
    if result < 0 {
        CloneReturn::NoChild(syscall_errno(result))
    } else if result == 0 {
        CloneReturn::ChildBranch
    } else {
        CloneReturn::ParentChild {
            pid: result as libc::pid_t,
            pidfd: (slot >= 0).then_some(slot),
        }
    }
}

enum ProcessCustody {
    Pidfd(OwnedFd),
    DirectChildFallback,
}

/// Owns protocol/status descriptors and fail-closed process custody.
#[must_use = "dropping raw child custody aborts and reaps the child"]
pub(super) struct RawChild {
    pid: libc::pid_t,
    custody: Option<ProcessCustody>,
    control: Option<OwnedFd>,
    receipt: Option<OwnedFd>,
    exec_status: Option<OwnedFd>,
}

impl RawChild {
    pub(super) fn pid(&self) -> libc::pid_t {
        self.pid
    }
    pub(super) fn pidfd(&self) -> Option<BorrowedFd<'_>> {
        match self.custody.as_ref() {
            Some(ProcessCustody::Pidfd(fd)) => Some(fd.as_fd()),
            _ => None,
        }
    }
    pub(super) fn control(&self) -> BorrowedFd<'_> {
        self.control.as_ref().expect("armed child").as_fd()
    }
    pub(super) fn receipt(&self) -> BorrowedFd<'_> {
        self.receipt.as_ref().expect("armed child").as_fd()
    }
    pub(super) fn exec_status(&self) -> BorrowedFd<'_> {
        self.exec_status.as_ref().expect("armed child").as_fd()
    }
    /// Establish protocol EOF before any post-clone failure is signalled.
    pub(super) fn close_protocol(&mut self) {
        drop(self.control.take());
        drop(self.receipt.take());
        drop(self.exec_status.take());
    }
    pub(super) fn abort_and_reap(mut self) -> Result<(), AbortError> {
        self.abort_inner()
    }
    /// Only consuming handoff; the next private custody remains armed.
    pub(super) fn into_next_custody(self) -> NextChildCustody {
        NextChildCustody { child: self }
    }
    fn abort_inner(&mut self) -> Result<(), AbortError> {
        // Protocol EOF is the witness for the parent-death-before-prctl race.
        drop(self.control.take());
        drop(self.receipt.take());
        drop(self.exec_status.take());
        let result = match self.custody.as_ref() {
            Some(ProcessCustody::Pidfd(fd)) => abort_reap_pidfd(fd.as_raw_fd()),
            Some(ProcessCustody::DirectChildFallback) => abort_reap_pid(self.pid),
            None => return Ok(()),
        };
        if result.is_ok() {
            self.custody.take();
        }
        result
    }
}
impl Drop for RawChild {
    fn drop(&mut self) {
        if self.abort_inner().is_err() {
            // Losing the sole authority while this process continues would
            // strand a child. Process abort triggers PDEATHSIG and protocol EOF;
            // it is the final fail-closed action when the kernel cannot reap.
            std::process::abort();
        }
    }
}

#[must_use = "dropping next custody aborts and reaps the child"]
pub(super) struct NextChildCustody {
    child: RawChild,
}
impl NextChildCustody {
    pub(super) fn child(&self) -> &RawChild {
        &self.child
    }
    pub(super) fn control_fd(&self) -> RawFd {
        self.child.control().as_raw_fd()
    }
    pub(super) fn receipt_fd(&self) -> RawFd {
        self.child.receipt().as_raw_fd()
    }
    pub(super) fn exec_status_fd(&self) -> RawFd {
        self.child.exec_status().as_raw_fd()
    }
    pub(super) fn close_protocol(&mut self) {
        self.child.close_protocol();
    }
    #[cfg(test)]
    pub(super) fn protocol_closed(&self) -> bool {
        self.child.control.is_none()
            && self.child.receipt.is_none()
            && self.child.exec_status.is_none()
    }

    /// Called only after waitid(P_PIDFD) returned an exact terminal disposition.
    /// This prevents RawChild::drop from attempting a second reap.
    pub(super) fn disarm_after_exact_reap(&mut self) {
        self.child.custody.take();
        self.child.control.take();
        self.child.receipt.take();
        self.child.exec_status.take();
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AbortError {
    errno: i32,
}

/// Private and unwired. A positive clone return always becomes armed custody,
/// including child setup/exec failure and a kernel that left pidfd invalid.
pub(super) fn clone_exec_fixed(helper: BootFrozenHelperFd) -> Result<RawChild, CloneExecError> {
    let prepared = PreparedFds::new(helper)
        .map_err(|e| CloneExecError::Preparation(io::Error::from_raw_os_error(e)))?;
    let inputs = ChildInputs::new(&prepared);
    let mut pidfd_slot: RawFd = -1;
    let args = CloneArgs {
        flags: CLONE_FLAGS,
        pidfd: (&mut pidfd_slot as *mut RawFd) as u64,
        child_tid: 0,
        parent_tid: 0,
        exit_signal: libc::SIGCHLD as u64,
        stack: 0,
        stack_size: 0,
        tls: 0,
        set_tid: 0,
        set_tid_size: 0,
        cgroup: 0,
    };
    let result = unsafe {
        raw_syscall2(
            libc::SYS_clone3,
            (&args as *const CloneArgs) as usize,
            std::mem::size_of::<CloneArgs>(),
        )
    };
    if result == 0 {
        // No Rust work occurs in the child between clone3 and this audited body.
        unsafe {
            let mut syscalls = DirectChildSyscalls;
            child_only(&mut syscalls, &inputs)
        }
    }

    match classify_clone_return(result, pidfd_slot) {
        CloneReturn::NoChild(errno) => {
            Err(CloneExecError::NoChild(io::Error::from_raw_os_error(errno)))
        }
        CloneReturn::ChildBranch => std::process::abort(),
        CloneReturn::ParentChild { pid, pidfd } => {
            let PreparedFds {
                control_parent,
                control_child,
                receipt_parent,
                receipt_child,
                helper,
                status_read,
                status_write,
            } = prepared;
            drop(control_child);
            drop(receipt_child);
            drop(helper);
            drop(status_write);
            let custody = match pidfd {
                Some(fd) => ProcessCustody::Pidfd(unsafe { OwnedFd::from_raw_fd(fd) }),
                None => ProcessCustody::DirectChildFallback,
            };
            Ok(RawChild {
                pid,
                custody: Some(custody),
                control: Some(control_parent),
                receipt: Some(receipt_parent),
                exec_status: Some(status_read),
            })
        }
    }
}

fn seqpacket_pair() -> Result<(OwnedFd, OwnedFd), i32> {
    let mut fds = [-1i32; 2];
    let r = unsafe {
        raw_syscall4(
            libc::SYS_socketpair,
            libc::AF_UNIX as usize,
            SEQPACKET_TYPE as usize,
            0,
            fds.as_mut_ptr() as usize,
        )
    };
    if r < 0 {
        close_if_valid(fds[0]);
        close_if_valid(fds[1]);
        return Err(syscall_errno(r));
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn cloexec_pipe() -> Result<(OwnedFd, OwnedFd), i32> {
    let mut fds = [-1i32; 2];
    let r = unsafe {
        raw_syscall2(
            libc::SYS_pipe2,
            fds.as_mut_ptr() as usize,
            PIPE_FLAGS as usize,
        )
    };
    if r < 0 {
        close_if_valid(fds[0]);
        close_if_valid(fds[1]);
        return Err(syscall_errno(r));
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn normalize_source(fd: OwnedFd) -> Result<OwnedFd, i32> {
    let r = unsafe {
        raw_syscall3(
            libc::SYS_fcntl,
            fd.as_raw_fd() as usize,
            libc::F_DUPFD_CLOEXEC as usize,
            FIRST_CLOSED_FD as usize,
        )
    };
    if r < 0 {
        return Err(syscall_errno(r));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(r as RawFd) })
}

fn close_if_valid(fd: RawFd) {
    if fd >= 0 {
        unsafe {
            let _ = raw_syscall1(libc::SYS_close, fd as usize);
        }
    }
}

fn abort_reap_pidfd(pidfd: RawFd) -> Result<(), AbortError> {
    loop {
        let r = unsafe {
            raw_syscall4(
                libc::SYS_pidfd_send_signal,
                pidfd as usize,
                libc::SIGKILL as usize,
                0,
                0,
            )
        };
        if r >= 0 || syscall_errno(r) == libc::ESRCH {
            break;
        }
        if syscall_errno(r) != libc::EINTR {
            // Protocol EOF was established first. Still wait: returning from
            // Drop while the fixed helper can remain alive is not acceptable.
            break;
        }
    }
    loop {
        let mut info = MaybeUninit::<libc::siginfo_t>::uninit();
        let r = unsafe {
            raw_syscall5(
                libc::SYS_waitid,
                P_PIDFD,
                pidfd as usize,
                info.as_mut_ptr() as usize,
                libc::WEXITED as usize,
                0,
            )
        };
        if r >= 0 {
            return Ok(());
        }
        // ECHILD is not terminal evidence without an earlier exact proof that
        // SIGCHLD disposition auto-reaps; raw custody has no such proof.
        if syscall_errno(r) != libc::EINTR {
            return Err(AbortError {
                errno: syscall_errno(r),
            });
        }
    }
}

/// PID fallback is used only when clone3 returned a child but did not populate
/// the CLONE_PIDFD output slot.
fn abort_reap_pid(pid: libc::pid_t) -> Result<(), AbortError> {
    loop {
        let r = unsafe { raw_syscall2(libc::SYS_kill, pid as usize, libc::SIGKILL as usize) };
        if r >= 0 || syscall_errno(r) == libc::ESRCH {
            break;
        }
        if syscall_errno(r) != libc::EINTR {
            // As above, EOF makes waiting safer than silently detaching.
            break;
        }
    }
    loop {
        let mut status = 0i32;
        let r = unsafe {
            raw_syscall4(
                libc::SYS_wait4,
                pid as usize,
                (&mut status as *mut i32) as usize,
                0,
                0,
            )
        };
        if r == pid as i64 {
            return Ok(());
        }
        // As with P_PIDFD, ECHILD alone cannot prove this exact start reaped.
        if r < 0 && syscall_errno(r) == libc::EINTR {
            continue;
        }
        return Err(AbortError {
            errno: syscall_errno(r),
        });
    }
}

#[inline(always)]
unsafe fn raw_syscall1(n: libc::c_long, a1: usize) -> i64 {
    unsafe {
        let r: i64;
        asm!("syscall", inlateout("rax") n => r, in("rdi") a1,
        lateout("rcx") _, lateout("r11") _, options(nostack));
        r
    }
}
#[inline(always)]
unsafe fn raw_syscall2(n: libc::c_long, a1: usize, a2: usize) -> i64 {
    unsafe {
        let r: i64;
        asm!("syscall", inlateout("rax") n => r, in("rdi") a1, in("rsi") a2,
        lateout("rcx") _, lateout("r11") _, options(nostack));
        r
    }
}
#[inline(always)]
unsafe fn raw_syscall3(n: libc::c_long, a1: usize, a2: usize, a3: usize) -> i64 {
    unsafe {
        let r: i64;
        asm!("syscall", inlateout("rax") n => r, in("rdi") a1, in("rsi") a2,
        in("rdx") a3, lateout("rcx") _, lateout("r11") _, options(nostack));
        r
    }
}
#[inline(always)]
unsafe fn raw_syscall4(n: libc::c_long, a1: usize, a2: usize, a3: usize, a4: usize) -> i64 {
    unsafe {
        let r: i64;
        asm!("syscall", inlateout("rax") n => r, in("rdi") a1, in("rsi") a2,
        in("rdx") a3, in("r10") a4, lateout("rcx") _, lateout("r11") _,
        options(nostack));
        r
    }
}
#[inline(always)]
unsafe fn raw_syscall5(
    n: libc::c_long,
    a1: usize,
    a2: usize,
    a3: usize,
    a4: usize,
    a5: usize,
) -> i64 {
    unsafe {
        let r: i64;
        asm!("syscall", inlateout("rax") n => r, in("rdi") a1, in("rsi") a2,
        in("rdx") a3, in("r10") a4, in("r8") a5, lateout("rcx") _,
        lateout("r11") _, options(nostack));
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::ffi::CStr;
    use std::panic::{AssertUnwindSafe, catch_unwind, panic_any};

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Call {
        SetPdeath,
        GetPdeath,
        Dup3(RawFd, RawFd, i32),
        CloseRange(u32, u32, u32),
        Close(RawFd),
        Execveat,
        Write(RawFd, usize),
        Exit(i32),
    }

    #[derive(Default)]
    struct Fake {
        calls: Vec<Call>,
        observed: i32,
        get_pdeath_override: Option<i32>,
        close_range_errno: Option<i32>,
        fail_dup_target: Option<RawFd>,
        exec_errno: i32,
        writes: VecDeque<i64>,
        bytes: Vec<u8>,
    }
    #[derive(Debug)]
    struct Exited;

    unsafe impl ChildSyscalls for Fake {
        unsafe fn prctl(&mut self, option: usize, arg2: usize) -> i64 {
            unsafe {
                if option == libc::PR_SET_PDEATHSIG as usize {
                    self.calls.push(Call::SetPdeath);
                    self.observed = arg2 as i32;
                } else {
                    self.calls.push(Call::GetPdeath);
                    *(arg2 as *mut i32) = self.get_pdeath_override.unwrap_or(self.observed);
                }
                0
            }
        }
        unsafe fn dup3(&mut self, old: RawFd, new: RawFd, flags: i32) -> i64 {
            self.calls.push(Call::Dup3(old, new, flags));
            if self.fail_dup_target == Some(new) {
                -(libc::EBADF as i64)
            } else {
                new as i64
            }
        }
        unsafe fn close_range(&mut self, first: u32, last: u32, flags: u32) -> i64 {
            self.calls.push(Call::CloseRange(first, last, flags));
            self.close_range_errno.map_or(0, |e| -(e as i64))
        }
        unsafe fn close(&mut self, fd: RawFd) -> i64 {
            self.calls.push(Call::Close(fd));
            0
        }
        unsafe fn execveat(
            &mut self,
            fd: RawFd,
            path: *const libc::c_char,
            argv: *const *const libc::c_char,
            envp: *const *const libc::c_char,
            flags: i32,
        ) -> i64 {
            unsafe {
                self.calls.push(Call::Execveat);
                assert_eq!(fd, HELPER_FD);
                assert_eq!(CStr::from_ptr(path).to_bytes(), b"");
                assert_eq!(
                    CStr::from_ptr(*argv).to_bytes(),
                    b"elpis-sensitive-namespace-bootstrap"
                );
                assert!((*argv.add(1)).is_null());
                assert!((*envp).is_null());
                assert_eq!(flags, libc::AT_EMPTY_PATH);
                -(self.exec_errno as i64)
            }
        }
        unsafe fn write(&mut self, fd: RawFd, bytes: *const u8, len: usize) -> i64 {
            unsafe {
                self.calls.push(Call::Write(fd, len));
                let r = self.writes.pop_front().unwrap_or(len as i64);
                if r > 0 {
                    let count = usize::min(r as usize, len);
                    self.bytes
                        .extend_from_slice(std::slice::from_raw_parts(bytes, count));
                }
                r
            }
        }
        unsafe fn exit(&mut self, status: i32) -> ! {
            self.calls.push(Call::Exit(status));
            panic_any(Exited)
        }
    }

    fn inputs() -> ChildInputs {
        ChildInputs {
            control_source: 10,
            receipt_source: 11,
            helper_source: 12,
            status_source: 13,
            argv: [ARG0.as_ptr().cast(), std::ptr::null()],
            envp: [std::ptr::null()],
        }
    }
    fn run(fake: &mut Fake) {
        let input = inputs();
        assert!(catch_unwind(AssertUnwindSafe(|| unsafe { child_only(fake, &input) })).is_err());
    }
    fn frame_stage(bytes: &[u8]) -> u16 {
        u16::from_le_bytes([bytes[6], bytes[7]])
    }
    fn frame_errno(bytes: &[u8]) -> i32 {
        i32::from_le_bytes(bytes[8..12].try_into().unwrap())
    }

    #[test]
    fn exact_child_order_fixed_argv_and_empty_env() {
        let mut fake = Fake {
            exec_errno: libc::ENOENT,
            ..Default::default()
        };
        run(&mut fake);
        assert_eq!(
            fake.calls,
            vec![
                Call::SetPdeath,
                Call::GetPdeath,
                Call::Dup3(10, 3, 0),
                Call::Dup3(11, 4, 0),
                Call::Dup3(12, 5, libc::O_CLOEXEC),
                Call::Dup3(13, 6, libc::O_CLOEXEC),
                Call::CloseRange(7, u32::MAX, 0),
                Call::Close(0),
                Call::Close(1),
                Call::Close(2),
                Call::Execveat,
                Call::Write(6, FRAME_SIZE),
                Call::Exit(125),
            ]
        );
        assert_eq!(&fake.bytes[0..4], b"ELPX");
        assert_eq!(u16::from_le_bytes([fake.bytes[4], fake.bytes[5]]), 1);
        assert_eq!(frame_stage(&fake.bytes), ChildStage::Execveat as u16);
        assert_eq!(frame_errno(&fake.bytes), libc::ENOENT);
        assert_eq!(fake.bytes.len(), FRAME_SIZE);
    }

    #[test]
    fn status_frame_handles_eintr_and_partial_writes() {
        let mut fake = Fake {
            exec_errno: libc::EACCES,
            writes: VecDeque::from(vec![-(libc::EINTR as i64), 3, 5, 8]),
            ..Default::default()
        };
        run(&mut fake);
        let writes: Vec<_> = fake
            .calls
            .iter()
            .filter_map(|c| match c {
                Call::Write(fd, len) => Some((*fd, *len)),
                _ => None,
            })
            .collect();
        assert_eq!(writes, vec![(6, 16), (6, 16), (6, 13), (6, 8)]);
        assert_eq!(fake.bytes.len(), 16);
        assert_eq!(frame_errno(&fake.bytes), libc::EACCES);
    }

    #[test]
    fn parent_death_signal_is_read_back_and_mismatch_aborts() {
        let mut fake = Fake {
            get_pdeath_override: Some(0),
            ..Default::default()
        };
        run(&mut fake);
        assert_eq!(
            &fake.calls[..3],
            &[
                Call::SetPdeath,
                Call::GetPdeath,
                Call::Write(13, FRAME_SIZE)
            ]
        );
        assert_eq!(
            frame_stage(&fake.bytes),
            ChildStage::ParentDeathSignalMismatch as u16
        );
        assert_eq!(frame_errno(&fake.bytes), libc::EIO);
    }

    #[test]
    fn pre_status_dup_failure_reports_on_preopened_status_source() {
        let mut fake = Fake {
            fail_dup_target: Some(CONTROL_FD),
            ..Default::default()
        };
        run(&mut fake);
        assert!(fake.calls.contains(&Call::Write(13, FRAME_SIZE)));
        assert!(!fake.calls.contains(&Call::Dup3(11, RECEIPT_FD, 0)));
        assert_eq!(frame_stage(&fake.bytes), ChildStage::DupControl as u16);
        assert_eq!(frame_errno(&fake.bytes), libc::EBADF);
    }

    #[test]
    fn close_range_failure_reports_on_fd_six_without_exec() {
        let mut fake = Fake {
            close_range_errno: Some(libc::ENOSYS),
            ..Default::default()
        };
        run(&mut fake);
        assert!(!fake.calls.contains(&Call::Close(0)));
        assert!(!fake.calls.contains(&Call::Execveat));
        assert!(fake.calls.contains(&Call::Write(6, 16)));
        assert_eq!(frame_stage(&fake.bytes), ChildStage::CloseRange as u16);
        assert_eq!(frame_errno(&fake.bytes), libc::ENOSYS);
    }

    #[test]
    fn only_negative_clone3_is_no_child() {
        assert_eq!(
            classify_clone_return(-(libc::EPERM as i64), -1),
            CloneReturn::NoChild(libc::EPERM)
        );
        assert_eq!(classify_clone_return(0, -1), CloneReturn::ChildBranch);
        assert_eq!(
            classify_clone_return(44, 20),
            CloneReturn::ParentChild {
                pid: 44,
                pidfd: Some(20)
            }
        );
    }

    #[test]
    fn invalid_pidfd_after_positive_clone_is_still_child_owned() {
        assert_eq!(
            classify_clone_return(44, -1),
            CloneReturn::ParentChild {
                pid: 44,
                pidfd: None
            }
        );
    }

    #[test]
    fn exact_creation_and_clone_constants() {
        assert_eq!(std::mem::size_of::<CloneArgs>(), 88);
        assert_eq!(SEQPACKET_TYPE, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC);
        assert_eq!(PIPE_FLAGS, libc::O_CLOEXEC);
        assert_eq!(
            CLONE_FLAGS,
            libc::CLONE_NEWUSER as u64
                | libc::CLONE_NEWNS as u64
                | libc::CLONE_NEWPID as u64
                | libc::CLONE_NEWNET as u64
                | libc::CLONE_PIDFD as u64
        );
        assert_eq!(FIRST_CLOSED_FD, 7);
    }
}
