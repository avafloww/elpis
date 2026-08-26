#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "../src/proc_child.rs"]
mod proc_child;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "../src/raw_clone.rs"]
mod raw_clone;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux {
    use crate::proc_child;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, ExitStatus, Output, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    const CASES: &[&str] = &[
        "success",
        "composed",
        "malformed",
        "duplicate",
        "wrong_map",
        "partial_map",
        "post_map_bad_release",
        "exec_failure",
        "parent_eof",
    ];

    fn worker(case: &str) -> ! {
        let outcome = std::panic::catch_unwind(|| proc_child::real_e2e::run(case));
        match outcome {
            Ok(proc_child::real_e2e::Outcome::Passed) => {
                eprintln!("PASS namespace-bootstrap-e2e case={case}");
                std::process::exit(0);
            }
            Ok(proc_child::real_e2e::Outcome::Unavailable(evidence)) => {
                eprintln!("UNAVAILABLE namespace-bootstrap-e2e case={case}: {evidence}");
                std::process::exit(77);
            }
            Ok(proc_child::real_e2e::Outcome::Failed(error)) => {
                eprintln!("FAIL namespace-bootstrap-e2e case={case}: {error}");
                std::process::exit(1);
            }
            Err(_) => {
                eprintln!(
                    "FAIL namespace-bootstrap-e2e case={case}: worker panicked (child custody drop completed during unwind)"
                );
                std::process::exit(101);
            }
        }
    }

    fn run_supervised(case: &str) -> Result<Output, String> {
        let executable =
            std::env::current_exe().map_err(|e| format!("current test executable: {e}"))?;
        let mut command = Command::new(executable);
        command
            .arg("namespace_bootstrap_e2e")
            .arg("--exact")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env("ELPIS_NAMESPACE_E2E_WORKER", case)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() == 1 {
                    return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("spawn disposable worker {case}: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(12);
        let status: ExitStatus = loop {
            match child
                .try_wait()
                .map_err(|e| format!("wait worker {case}: {e}"))?
            {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let cleanup_deadline = Instant::now() + Duration::from_secs(3);
                    loop {
                        let mut adopted_status = 0;
                        let adopted =
                            unsafe { libc::waitpid(-1, &mut adopted_status, libc::WNOHANG) };
                        if adopted < 0
                            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD)
                        {
                            break;
                        }
                        if adopted == 0 && Instant::now() < cleanup_deadline {
                            thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        if adopted <= 0 {
                            return Err(format!(
                                "disposable worker {case} timed out and an adopted child did not terminate"
                            ));
                        }
                    }
                    return Err(format!(
                        "disposable worker {case} exceeded 12 second timeout"
                    ));
                }
            }
        };
        let output = child
            .wait_with_output()
            .map_err(|e| format!("collect worker {case} output: {e}"))?;
        if output.status != status {
            return Err(format!("worker {case} wait status changed"));
        }
        Ok(output)
    }

    fn print_output(output: &Output) {
        if !output.stdout.is_empty() {
            eprint!("{}", String::from_utf8_lossy(&output.stdout));
        }
        if !output.stderr.is_empty() {
            eprint!("{}", String::from_utf8_lossy(&output.stderr));
        }
    }

    pub(super) fn run_test() {
        if let Ok(case) = std::env::var("ELPIS_NAMESPACE_E2E_WORKER") {
            worker(&case);
        }

        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            panic!(
                "arm disposable worker subreaper: {}",
                std::io::Error::last_os_error()
            );
        }

        for (index, case) in CASES.iter().enumerate() {
            let output = run_supervised(case).unwrap_or_else(|error| panic!("{error}"));
            print_output(&output);
            if output.status.code() == Some(77) {
                assert_eq!(
                    index, 0,
                    "kernel availability changed after the first real clone case"
                );
                eprintln!(
                    "SKIP namespace-bootstrap-e2e: real user namespace creation unavailable; evidence above is an exact clone3 errno"
                );
                return;
            }
            assert!(
                output.status.success(),
                "namespace bootstrap case {case} failed with {:?}",
                output.status
            );
        }
        eprintln!(
            "PASS namespace-bootstrap-e2e: all fixed helper/parent authority cases completed in reaped disposable workers"
        );
    }
}

#[test]
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn namespace_bootstrap_e2e() {
    linux::run_test();
}

#[test]
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
fn namespace_bootstrap_e2e() {
    panic!("namespace-bootstrap-e2e requires the Linux x86_64 raw clone backend");
}
