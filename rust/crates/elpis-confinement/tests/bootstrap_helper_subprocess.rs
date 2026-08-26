#![cfg(target_os = "linux")]

use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

static FIXED_FD_TEST_LOCK: Mutex<()> = Mutex::new(());

const FRAME_LEN: usize = 48;

struct ChildProtocol {
    child: std::process::Child,
    control: libc::c_int,
    receipt: libc::c_int,
}
impl Drop for ChildProtocol {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.control);
            libc::close(self.receipt);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn pair() -> [libc::c_int; 2] {
    let mut fds = [-1; 2];
    assert_eq!(
        unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                0,
                fds.as_mut_ptr(),
            )
        },
        0
    );
    fds
}

fn spawn(extra_fd: bool, environment: bool) -> ChildProtocol {
    let control = pair();
    let receipt = pair();
    let child_control = unsafe { libc::fcntl(control[1], libc::F_DUPFD_CLOEXEC, 10) };
    let child_receipt = unsafe { libc::fcntl(receipt[1], libc::F_DUPFD_CLOEXEC, 10) };
    assert!(child_control >= 10 && child_receipt >= 10);

    let mut command = Command::new(env!("CARGO_BIN_EXE_elpis-sensitive-namespace-bootstrap"));
    command
        .arg0("elpis-sensitive-namespace-bootstrap")
        .env_clear();
    if environment {
        command.env("FORBIDDEN", "1");
    }
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(child_control, 3) != 3 || libc::dup2(child_receipt, 4) != 4 {
                return Err(std::io::Error::last_os_error());
            }
            if extra_fd && libc::dup2(child_control, 5) != 5 {
                return Err(std::io::Error::last_os_error());
            }
            libc::close(0);
            libc::close(1);
            libc::close(2);
            Ok(())
        });
    }
    let child = command.spawn().expect("spawn exact internal helper");
    for fd in [control[1], receipt[1], child_control, child_receipt] {
        unsafe {
            libc::close(fd);
        }
    }
    ChildProtocol {
        child,
        control: control[0],
        receipt: receipt[0],
    }
}

fn attempt_packet(fd: libc::c_int, packet: &[u8]) {
    let sent = unsafe { libc::send(fd, packet.as_ptr().cast(), packet.len(), libc::MSG_NOSIGNAL) };
    if sent < 0 {
        assert!(
            matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPIPE | libc::ECONNRESET)
            ),
            "unexpected packet-send failure"
        );
    } else {
        assert_eq!(sent, packet.len() as isize);
    }
}

fn assert_exits_without_receipt(mut process: ChildProtocol) {
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = process.child.try_wait().expect("wait helper") {
            break status;
        }
        assert!(Instant::now() < deadline, "bootstrap did not fail closed");
        thread::sleep(Duration::from_millis(10));
    };
    assert!(!status.success());
    let mut receipt = [0_u8; FRAME_LEN];
    assert_eq!(
        unsafe {
            libc::recv(
                process.receipt,
                receipt.as_mut_ptr().cast(),
                FRAME_LEN,
                libc::MSG_DONTWAIT,
            )
        },
        0,
        "unexpected Ready receipt"
    );
}

#[test]
fn malformed_packet_and_eof_fail_closed_without_ready() {
    let _guard = FIXED_FD_TEST_LOCK.lock().expect("fixed-fd test lock");
    let malformed = spawn(false, false);
    // The helper may reject an earlier process-image invariant before the
    // parent wins this scheduling race. Either full delivery or a closed
    // fail-closed channel is acceptable; unit tests isolate malformed parsing.
    attempt_packet(malformed.control, b"not an exact frame");
    assert_exits_without_receipt(malformed);

    let mut eof = spawn(false, false);
    unsafe {
        libc::close(eof.control);
    }
    eof.control = -1;
    assert_exits_without_receipt(eof);
}

#[test]
fn extra_descriptor_and_nonempty_environment_fail_closed() {
    let _guard = FIXED_FD_TEST_LOCK.lock().expect("fixed-fd test lock");
    assert_exits_without_receipt(spawn(true, false));
    assert_exits_without_receipt(spawn(false, true));
}
