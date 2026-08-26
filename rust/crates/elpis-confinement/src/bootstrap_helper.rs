//! Fixed, inert child-side sensitive namespace bootstrap.
//!
//! This accepts no launch inputs. Success ends at SIGSTOP; this leaf performs
//! no mount, credential, policy, cgroup, deployment, or guest operation.
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;

const CONTROL_FD: libc::c_int = 3;
const RECEIPT_FD: libc::c_int = 4;
const FIXED_ARGV0: &[u8] = b"elpis-sensitive-namespace-bootstrap";
const FRAME_LEN: usize = 48;
const NONCE_LEN: usize = 32;
const MAGIC: &[u8; 8] = b"ELPISNS\0";
const VERSION: u8 = 1;
const NS_GET_USERNS: libc::c_ulong = 0xb701;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Kind {
    BootNonce = 1,
    Ready = 2,
    ReleaseToMountAssembly = 3,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Nonce([u8; NONCE_LEN]);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    Eof,
    Io,
    Malformed,
    ExtraPacket,
    State,
}

trait PacketIo {
    fn receive(&mut self) -> Result<[u8; FRAME_LEN], Failure>;
    fn require_quiet(&mut self) -> Result<(), Failure>;
    fn send(&mut self, frame: &[u8; FRAME_LEN]) -> Result<(), Failure>;
}

fn encode(kind: Kind, nonce: Nonce) -> [u8; FRAME_LEN] {
    let mut out = [0; FRAME_LEN];
    out[..8].copy_from_slice(MAGIC);
    out[8] = VERSION;
    out[9] = kind as u8;
    out[16..].copy_from_slice(&nonce.0);
    out
}
fn decode(frame: &[u8; FRAME_LEN], kind: Kind) -> Result<Nonce, Failure> {
    if &frame[..8] != MAGIC
        || frame[8] != VERSION
        || frame[9] != kind as u8
        || frame[10..16].iter().any(|b| *b != 0)
    {
        return Err(Failure::Malformed);
    }
    let mut nonce = [0; NONCE_LEN];
    nonce.copy_from_slice(&frame[16..]);
    if nonce.iter().all(|b| *b == 0) {
        return Err(Failure::Malformed);
    }
    Ok(Nonce(nonce))
}
fn nonce_matches(a: Nonce, b: Nonce) -> bool {
    a.0.iter()
        .zip(b.0)
        .fold(0_u8, |different, (a, b)| different | (*a ^ b))
        == 0
}

// The nonce binds this one boot exchange; it is protocol authenticity, not authorization.
fn exchange<I: PacketIo>(
    io: &mut I,
    pre_map: impl FnOnce() -> bool,
    post_map: impl FnOnce() -> bool,
) -> Result<(), Failure> {
    let nonce = decode(&io.receive()?, Kind::BootNonce)?;
    // Release cannot be prequeued: Ready is the map synchronization point.
    io.require_quiet()?;
    if !pre_map() {
        return Err(Failure::State);
    }
    io.send(&encode(Kind::Ready, nonce))?;
    let released = decode(&io.receive()?, Kind::ReleaseToMountAssembly)?;
    if !nonce_matches(nonce, released) {
        return Err(Failure::Malformed);
    }
    // Reject an already queued duplicate. Closing fd 3 on success rejects later ones.
    io.require_quiet()?;
    if !post_map() {
        return Err(Failure::State);
    }
    Ok(())
}

struct FixedIo;
impl PacketIo for FixedIo {
    fn receive(&mut self) -> Result<[u8; FRAME_LEN], Failure> {
        let mut frame = [0; FRAME_LEN];
        let n = unsafe {
            libc::recv(
                CONTROL_FD,
                frame.as_mut_ptr().cast(),
                FRAME_LEN,
                libc::MSG_TRUNC | libc::MSG_CMSG_CLOEXEC,
            )
        };
        if n == 0 {
            Err(Failure::Eof)
        } else if n < 0 {
            Err(Failure::Io)
        } else if n as usize != FRAME_LEN {
            Err(Failure::Malformed)
        } else {
            Ok(frame)
        }
    }
    fn require_quiet(&mut self) -> Result<(), Failure> {
        let mut byte = 0_u8;
        let n = unsafe {
            libc::recv(
                CONTROL_FD,
                (&mut byte as *mut u8).cast(),
                1,
                libc::MSG_DONTWAIT | libc::MSG_PEEK | libc::MSG_TRUNC,
            )
        };
        if n > 0 {
            return Err(Failure::ExtraPacket);
        }
        if n == 0 {
            return Err(Failure::Eof);
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::EAGAIN) => Ok(()),
            _ => Err(Failure::Io),
        }
    }
    fn send(&mut self, frame: &[u8; FRAME_LEN]) -> Result<(), Failure> {
        let n = unsafe {
            libc::send(
                RECEIPT_FD,
                frame.as_ptr().cast(),
                FRAME_LEN,
                libc::MSG_NOSIGNAL,
            )
        };
        if n == FRAME_LEN as isize {
            Ok(())
        } else {
            Err(Failure::Io)
        }
    }
}

fn exact_process_image() -> bool {
    let mut args = std::env::args_os();
    args.next().as_deref().map(OsStr::as_bytes) == Some(FIXED_ARGV0)
        && args.next().is_none()
        && std::env::vars_os().next().is_none()
}
fn arm_parent_death() -> bool {
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
        return false;
    }
    let mut signal = 0;
    (unsafe { libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal, 0, 0, 0) }) == 0
        && signal == libc::SIGKILL
}
fn socket_identity(fd: libc::c_int) -> Option<(libc::dev_t, libc::ino_t)> {
    if unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC != 0 {
        return None;
    }
    let mut ty = 0;
    let mut len = std::mem::size_of_val(&ty) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut ty as *mut libc::c_int).cast(),
            &mut len,
        )
    } != 0
        || ty != libc::SOCK_SEQPACKET
    {
        return None;
    }
    let mut peer: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    let mut peer_len = std::mem::size_of_val(&peer) as libc::socklen_t;
    if unsafe {
        libc::getpeername(
            fd,
            (&mut peer as *mut libc::sockaddr_storage).cast::<libc::sockaddr>(),
            &mut peer_len,
        )
    } != 0
        || peer.ss_family as libc::c_int != libc::AF_UNIX
    {
        return None;
    }
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 || stat.st_mode & libc::S_IFMT != libc::S_IFSOCK {
        None
    } else {
        Some((stat.st_dev, stat.st_ino))
    }
}
fn decimal(bytes: &[u8]) -> Option<libc::c_int> {
    let mut value = 0_i32;
    if bytes.is_empty() {
        return None;
    }
    for b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((*b - b'0') as i32)?;
    }
    Some(value)
}
fn null_descriptor(fd: libc::c_int, access: libc::c_int) -> bool {
    let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    let status_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    descriptor_flags == 0
        && status_flags >= 0
        && status_flags & libc::O_ACCMODE == access
        && unsafe { libc::fstat(fd, &mut stat) } == 0
        && stat.st_mode & libc::S_IFMT == libc::S_IFCHR
        && stat.st_rdev == libc::makedev(1, 3)
}

// Rust's startup runtime safely replenishes closed standard descriptors with
// /dev/null before main. Verify those exact descriptors rather than treating
// runtime-created fds as ambient authority. getdents64 avoids hiding the scan
// descriptor inside a higher-level iterator.
fn only_fixed_fds() -> bool {
    let scan = unsafe {
        libc::open(
            c"/proc/self/fd".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if scan < 0 {
        return false;
    }
    let mut good = true;
    let mut buf = [0_u8; 4096];
    loop {
        let n = unsafe { libc::syscall(libc::SYS_getdents64, scan, buf.as_mut_ptr(), buf.len()) };
        if n < 0 {
            good = false;
            break;
        }
        if n == 0 {
            break;
        }
        let mut at = 0;
        while at < n as usize {
            if at + 19 > n as usize {
                good = false;
                break;
            }
            let reclen = u16::from_ne_bytes([buf[at + 16], buf[at + 17]]) as usize;
            if reclen < 20 || at + reclen > n as usize {
                good = false;
                break;
            }
            let field = &buf[at + 19..at + reclen];
            let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
            let name = &field[..end];
            if name != b"."
                && name != b".."
                && !matches!(
                    decimal(name),
                    Some(fd) if (0..=2).contains(&fd)
                        || fd == CONTROL_FD
                        || fd == RECEIPT_FD
                        || fd == scan
                )
            {
                good = false;
            }
            at += reclen;
        }
        if !good {
            break;
        }
    }
    unsafe { libc::close(scan) };
    good
}
fn exact_descriptors() -> bool {
    null_descriptor(0, libc::O_RDWR)
        && null_descriptor(1, libc::O_RDWR)
        && null_descriptor(2, libc::O_RDWR)
        && matches!((socket_identity(CONTROL_FD), socket_identity(RECEIPT_FD)),
            (Some(a), Some(b)) if a != b)
        && only_fixed_fds()
}
fn read_file(path: &std::ffi::CStr, out: &mut [u8]) -> Option<usize> {
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return None;
    }
    let n = unsafe { libc::read(fd, out.as_mut_ptr().cast(), out.len()) };
    let mut extra = 0_u8;
    let more = if n >= 0 {
        unsafe { libc::read(fd, (&mut extra as *mut u8).cast(), 1) }
    } else {
        -1
    };
    unsafe { libc::close(fd) };
    (n >= 0 && more == 0).then_some(n as usize)
}
fn ns_fd(path: &std::ffi::CStr) -> Option<libc::c_int> {
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    (fd >= 0).then_some(fd)
}
fn fd_identity(fd: libc::c_int) -> Option<(libc::dev_t, libc::ino_t)> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::fstat(fd, &mut stat) } == 0 && stat.st_ino != 0)
        .then_some((stat.st_dev, stat.st_ino))
}
fn owned_by(fd: libc::c_int, user: (libc::dev_t, libc::ino_t)) -> bool {
    let owner = unsafe { libc::ioctl(fd, NS_GET_USERNS) };
    if owner < 0 {
        return false;
    }
    let identity = fd_identity(owner);
    unsafe { libc::close(owner) };
    identity == Some(user)
}
fn namespace_state() -> bool {
    if unsafe { libc::getpid() } != 1 || unsafe { libc::getppid() } != 0 {
        return false;
    }
    let Some(user) = ns_fd(c"/proc/self/ns/user") else {
        return false;
    };
    let Some(mount) = ns_fd(c"/proc/self/ns/mnt") else {
        unsafe { libc::close(user) };
        return false;
    };
    let Some(pid) = ns_fd(c"/proc/self/ns/pid") else {
        unsafe {
            libc::close(user);
            libc::close(mount)
        };
        return false;
    };
    let Some(net) = ns_fd(c"/proc/self/ns/net") else {
        unsafe {
            libc::close(user);
            libc::close(mount);
            libc::close(pid)
        };
        return false;
    };
    let fds = [user, mount, pid, net];
    let identities: Option<Vec<_>> = fds.iter().map(|fd| fd_identity(*fd)).collect();
    let good = identities.is_some_and(|ids| {
        ids.iter()
            .enumerate()
            .all(|(i, id)| !ids[i + 1..].contains(id))
            && owned_by(mount, ids[0])
            && owned_by(pid, ids[0])
            && owned_by(net, ids[0])
    });
    for fd in fds {
        unsafe { libc::close(fd) };
    }
    good
}
fn nested_pid_init() -> bool {
    let mut status = [0_u8; 8192];
    let Some(n) = read_file(c"/proc/self/status", &mut status) else {
        return false;
    };
    status[..n].split(|b| *b == b'\n').any(|line| {
        let Some(rest) = line.strip_prefix(b"NSpid:") else {
            return false;
        };
        let fields: Vec<_> = rest
            .split(|b| b.is_ascii_whitespace())
            .filter(|f| !f.is_empty())
            .collect();
        fields.len() >= 2 && fields.last().copied() == Some(b"1".as_slice())
    })
}
fn file_equals(path: &std::ffi::CStr, expected: &[u8]) -> bool {
    let mut bytes = [0_u8; 128];
    matches!(read_file(path, &mut bytes), Some(n) if &bytes[..n] == expected)
}
fn single_map_bytes(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let fields: Vec<_> = text.split_ascii_whitespace().collect();
    if fields.len() != 3 {
        return false;
    }
    let (Ok(inside), Ok(outside), Ok(length)) = (
        fields[0].parse::<u32>(),
        fields[1].parse::<u32>(),
        fields[2].parse::<u32>(),
    ) else {
        return false;
    };
    inside == 0 && outside != 0 && length == 1
}
fn single_map(path: &std::ffi::CStr) -> bool {
    let mut bytes = [0_u8; 128];
    let Some(n) = read_file(path, &mut bytes) else {
        return false;
    };
    single_map_bytes(&bytes[..n])
}
fn before_maps() -> bool {
    namespace_state()
        && nested_pid_init()
        && file_equals(c"/proc/self/uid_map", b"")
        && file_equals(c"/proc/self/gid_map", b"")
        && file_equals(c"/proc/self/setgroups", b"allow\n")
}
fn after_maps() -> bool {
    namespace_state()
        && nested_pid_init()
        && single_map(c"/proc/self/uid_map")
        && single_map(c"/proc/self/gid_map")
        && file_equals(c"/proc/self/setgroups", b"deny\n")
}
fn abort() -> ! {
    unsafe { libc::_exit(125) }
}

/// Exact internal entrypoint for the boot-frozen namespace child executable.
/// It has no request parameters; inherited process state is the entire contract.
#[doc(hidden)]
pub fn sensitive_namespace_bootstrap_main() -> ! {
    if !exact_process_image() || !arm_parent_death() || !exact_descriptors() {
        abort();
    }
    if exchange(&mut FixedIo, before_maps, after_maps).is_err() {
        abort();
    }
    unsafe {
        libc::close(CONTROL_FD);
        libc::close(RECEIPT_FD);
    }
    // PID-namespace init ignores a self-generated default SIGSTOP. Wait for
    // the owning parent to stop us through the exact pidfd after it observes
    // protocol EOF; PDEATHSIG still kills us if that parent disappears.
    loop {
        unsafe { libc::pause() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    struct Fake {
        input: VecDeque<Result<[u8; FRAME_LEN], Failure>>,
        pending: VecDeque<bool>,
        sent: Vec<[u8; FRAME_LEN]>,
    }
    impl Fake {
        fn valid(nonce: Nonce) -> Self {
            Self {
                input: [
                    Ok(encode(Kind::BootNonce, nonce)),
                    Ok(encode(Kind::ReleaseToMountAssembly, nonce)),
                ]
                .into(),
                pending: [false, false].into(),
                sent: vec![],
            }
        }
    }
    impl PacketIo for Fake {
        fn receive(&mut self) -> Result<[u8; FRAME_LEN], Failure> {
            self.input.pop_front().unwrap_or(Err(Failure::Eof))
        }
        fn require_quiet(&mut self) -> Result<(), Failure> {
            if self.pending.pop_front().unwrap_or(false) {
                Err(Failure::ExtraPacket)
            } else {
                Ok(())
            }
        }
        fn send(&mut self, frame: &[u8; FRAME_LEN]) -> Result<(), Failure> {
            self.sent.push(*frame);
            Ok(())
        }
    }
    fn nonce(n: u8) -> Nonce {
        Nonce([n; NONCE_LEN])
    }

    #[test]
    fn sends_exactly_one_ready_after_checks() {
        let n = nonce(7);
        let mut io = Fake::valid(n);
        assert_eq!(exchange(&mut io, || true, || true), Ok(()));
        assert_eq!(io.sent, vec![encode(Kind::Ready, n)]);
        let mut bad_state = Fake::valid(n);
        assert_eq!(
            exchange(&mut bad_state, || false, || true),
            Err(Failure::State)
        );
        assert!(bad_state.sent.is_empty());
    }
    #[test]
    fn malformed_eof_duplicate_and_replay_fail_closed() {
        for failure in [Failure::Eof, Failure::Io] {
            let mut io = Fake::valid(nonce(7));
            io.input[1] = Err(failure);
            assert!(exchange(&mut io, || true, || true).is_err());
            assert_eq!(io.sent.len(), 1);
        }
        let mut malformed = Fake::valid(nonce(7));
        malformed.input[1].as_mut().unwrap()[10] = 1;
        assert_eq!(
            exchange(&mut malformed, || true, || true),
            Err(Failure::Malformed)
        );
        let mut replay = Fake::valid(nonce(7));
        replay.input[1] = Ok(encode(Kind::ReleaseToMountAssembly, nonce(8)));
        assert_eq!(
            exchange(&mut replay, || true, || true),
            Err(Failure::Malformed)
        );
        let mut duplicate = Fake::valid(nonce(7));
        duplicate.pending = [false, true].into();
        assert_eq!(
            exchange(&mut duplicate, || true, || true),
            Err(Failure::ExtraPacket)
        );
    }
    #[test]
    fn early_and_noncanonical_boot_frames_emit_no_ready() {
        let mut early = Fake::valid(nonce(7));
        early.pending = [true].into();
        assert_eq!(
            exchange(&mut early, || true, || true),
            Err(Failure::ExtraPacket)
        );
        assert!(early.sent.is_empty());
        for index in [0, 8, 9, 10, 15] {
            let mut io = Fake::valid(nonce(7));
            io.input[0].as_mut().unwrap()[index] ^= 0xff;
            assert_eq!(exchange(&mut io, || true, || true), Err(Failure::Malformed));
            assert!(io.sent.is_empty());
        }
        let mut zero = Fake::valid(nonce(7));
        zero.input[0] = Ok(encode(Kind::BootNonce, Nonce([0; NONCE_LEN])));
        assert_eq!(
            exchange(&mut zero, || true, || true),
            Err(Failure::Malformed)
        );
    }
    #[test]
    fn mapping_shape_is_exact() {
        assert!(single_map_bytes(b"         0      62001          1\n"));
        assert!(!single_map_bytes(b"0 0 1\n"));
        assert!(!single_map_bytes(b"0 62001 2\n"));
        assert!(!single_map_bytes(b"0 62001 1\n1 62002 1\n"));
        assert!(!single_map_bytes(b"garbage\n"));
    }
}
