//! Private stopped-child bootstrap and namespace-mapping contract.
//!
//! This module is intentionally inert. It models the only acceptable clone3,
//! bootstrap, mapping, verification, release, and abort sequence behind an
//! abstract kernel interface. It never clones, executes, opens procfs, changes
//! credentials, or assembles a filesystem.

#![allow(dead_code)]

use std::fmt;

const CLONE3_FLAGS: u64 = libc::CLONE_NEWUSER as u64
    | libc::CLONE_NEWNS as u64
    | libc::CLONE_NEWPID as u64
    | libc::CLONE_NEWNET as u64
    | libc::CLONE_PIDFD as u64;
const SETGROUPS_DENY: &[u8] = b"deny\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Clone3Contract {
    flags: u64,
    exit_signal: i32,
    pidfd_required: bool,
}

const CLONE3_CONTRACT: Clone3Contract = Clone3Contract {
    flags: CLONE3_FLAGS,
    exit_signal: libc::SIGCHLD,
    pidfd_required: true,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EofAction {
    SelfAbort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BootstrapMessage {
    ReleaseToMountAssembly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildAction {
    ExecFrozenBootstrapThenWait,
}

/// The child branch has no selectable program or continuation. It performs one
/// AT_EMPTY_PATH execveat of the inherited boot-frozen descriptor, then waits
/// for one message. Closing the parent end is an instruction to self-abort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChildBootstrapContract {
    action: ChildAction,
    execveat_empty_path: bool,
    only_bootstrap_and_protocol_inherited: bool,
    argv_and_environment_boot_frozen: bool,
    one_shot_protocol: bool,
    only_message: BootstrapMessage,
    eof_action: EofAction,
}

const CHILD_BOOTSTRAP_CONTRACT: ChildBootstrapContract = ChildBootstrapContract {
    action: ChildAction::ExecFrozenBootstrapThenWait,
    execveat_empty_path: true,
    only_bootstrap_and_protocol_inherited: true,
    argv_and_environment_boot_frozen: true,
    one_shot_protocol: true,
    only_message: BootstrapMessage::ReleaseToMountAssembly,
    eof_action: EofAction::SelfAbort,
};

#[derive(Clone, Copy, PartialEq, Eq)]
struct BootstrapIdentity {
    sha256: [u8; 32],
    device: u64,
    inode: u64,
    mount_id: u64,
    mount_read_only: bool,
    uid: u32,
    gid: u32,
    mode: u32,
    size: u64,
}

impl fmt::Debug for BootstrapIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BootstrapIdentity")
            .field("sha256", &hex::encode(self.sha256))
            .field("device", &self.device)
            .field("inode", &self.inode)
            .field("mount_id", &self.mount_id)
            .field("mount_read_only", &self.mount_read_only)
            .field("uid", &self.uid)
            .field("gid", &self.gid)
            .field("mode", &format_args!("{:#o}", self.mode))
            .field("size", &self.size)
            .finish()
    }
}

/// Minted by boot integration while it owns the verified executable descriptor.
/// It is private, non-Clone, non-Serialize, and contains no pathname or raw fd.
struct BootFrozenBootstrap<C> {
    identity: BootstrapIdentity,
    custody: C,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DedicatedSandboxIds {
    uid: u32,
    gid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NamespaceInodes {
    user: u64,
    mount: u64,
    pid: u64,
    network: u64,
}

/// All launch inputs are boot-minted. There is no public constructor accepting
/// caller PIDs, descriptors, clone flags, or numeric IDs.
struct BootFrozenLaunch<C> {
    bootstrap: BootFrozenBootstrap<C>,
    sandbox_ids: DedicatedSandboxIds,
    parent_namespaces: NamespaceInodes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChildStartIdentity {
    outer_pid: u32,
    proc_device: u64,
    proc_inode: u64,
    start_time_ticks: u64,
}

/// One noncloneable pidfd/proc identity authority. The backend handle and the
/// start identity always move together; scalar identity observations alone do
/// not confer child authority.
struct ParentAuthority<H> {
    handle: H,
    start: ChildStartIdentity,
}

struct FreshChild<H> {
    authority: ParentAuthority<H>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SingleIdMap {
    outside: u32,
}

impl SingleIdMap {
    fn line(self) -> String {
        format!("0 {} 1\n", self.outside)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IdMapExtent {
    inside: u32,
    outside: u32,
    length: u32,
}

impl SingleIdMap {
    fn extent(self) -> IdMapExtent {
        IdMapExtent {
            inside: 0,
            outside: self.outside,
            length: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    VerifyBootstrapIdentity,
    VerifyParentAccount,
    VerifyParentNamespaces,
    Clone3,
    VerifyStartIdentity,
    VerifyBootstrapWait,
    WriteSetgroupsDeny,
    WriteUidMap,
    WriteGidMap,
    ReadSetgroups,
    ReadUidMap,
    ReadGidMap,
    VerifyChildNamespaces,
    VerifyNspid,
    ReleaseProtocol,
}

#[derive(Debug, PartialEq, Eq)]
enum FailureCause<E> {
    Kernel { step: Step, error: E },
    Evidence { step: Step },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalDisposition {
    Exited(i32),
    Signaled(i32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReapEvidence {
    start: ChildStartIdentity,
    disposition: TerminalDisposition,
}

/// A terminal receipt exists only after wait/reap evidence proves that this
/// exact start identity terminated. SIGKILL is requested, but an exact child
/// that exited first is still terminal rather than uncertain.
struct TerminalReceipt {
    start: ChildStartIdentity,
    disposition: TerminalDisposition,
}

struct AbortProblems<E> {
    kill_error: Option<E>,
    reap_error: Option<E>,
    terminal_evidence_invalid: bool,
}

/// Neither Drop nor an error conversion discards this state. If terminality
/// cannot be proven, the sole parent authority and backend remain owned here.
struct UncertainCustody<K: StoppedChildKernel> {
    kernel: K,
    authority: ParentAuthority<K::Handle>,
    abort: AbortProblems<K::Error>,
}

/// Successful release still leaves the outside parent holding the sole pidfd /
/// proc identity authority. The child can proceed only to mount assembly.
struct MountAssemblyCustody<K: StoppedChildKernel> {
    kernel: K,
    authority: ParentAuthority<K::Handle>,
}

enum LaunchFailure<K: StoppedChildKernel> {
    /// The backend contract proves clone3 created no child.
    NoChild {
        cause: FailureCause<K::Error>,
        kernel: K,
    },
    Reaped {
        cause: FailureCause<K::Error>,
        receipt: TerminalReceipt,
    },
    Uncertain {
        cause: FailureCause<K::Error>,
        custody: UncertainCustody<K>,
    },
}

/// Fakeable semantic kernel boundary. A production implementation would keep
/// raw descriptors and procfs details entirely behind this private trait.
trait StoppedChildKernel: Sized {
    type Error;
    type Handle;

    /// Err means no child was created. Every created child must be returned with
    /// its sole parent authority, including post-clone setup errors.
    fn clone3_exec_bootstrap<C>(
        &mut self,
        clone: Clone3Contract,
        child: ChildBootstrapContract,
        bootstrap: BootFrozenBootstrap<C>,
    ) -> Result<FreshChild<Self::Handle>, Self::Error>;
    fn parent_is_dedicated_account(
        &mut self,
        ids: DedicatedSandboxIds,
    ) -> Result<bool, Self::Error>;
    fn read_parent_namespaces(&mut self) -> Result<NamespaceInodes, Self::Error>;
    fn read_start_identity(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<ChildStartIdentity, Self::Error>;
    fn child_is_in_bootstrap_wait(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<bool, Self::Error>;
    fn write_setgroups(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
        exact: &'static [u8],
    ) -> Result<(), Self::Error>;
    fn write_uid_map(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
        exact_line: &str,
    ) -> Result<(), Self::Error>;
    fn write_gid_map(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
        exact_line: &str,
    ) -> Result<(), Self::Error>;
    fn read_setgroups(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<Vec<u8>, Self::Error>;
    fn read_uid_map(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<Vec<IdMapExtent>, Self::Error>;
    fn read_gid_map(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<Vec<IdMapExtent>, Self::Error>;
    fn read_child_namespaces(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<NamespaceInodes, Self::Error>;
    fn read_nspid(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<Vec<u32>, Self::Error>;
    fn release_to_mount_assembly(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
        message: BootstrapMessage,
    ) -> Result<(), Self::Error>;
    fn send_sigkill(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<(), Self::Error>;
    fn reap(
        &mut self,
        authority: &ParentAuthority<Self::Handle>,
    ) -> Result<ReapEvidence, Self::Error>;
}

fn namespace_inodes_are_valid(namespaces: NamespaceInodes) -> bool {
    let values = [
        namespaces.user,
        namespaces.mount,
        namespaces.pid,
        namespaces.network,
    ];
    values.iter().all(|inode| *inode != 0)
        && values
            .iter()
            .enumerate()
            .all(|(index, inode)| !values[index + 1..].contains(inode))
}

fn namespaces_are_new(child: NamespaceInodes, parent: NamespaceInodes) -> bool {
    namespace_inodes_are_valid(child)
        && namespace_inodes_are_valid(parent)
        && child.user != parent.user
        && child.mount != parent.mount
        && child.pid != parent.pid
        && child.network != parent.network
}

fn bootstrap_identity_is_valid(identity: BootstrapIdentity) -> bool {
    identity.sha256.iter().any(|byte| *byte != 0)
        && identity.device != 0
        && identity.inode != 0
        && identity.mount_id != 0
        && identity.mount_read_only
        && identity.size != 0
        && identity.mode & libc::S_IFMT == libc::S_IFREG
        && identity.mode & 0o022 == 0
        && identity.mode & 0o111 != 0
}

fn start_identity_is_valid(start: ChildStartIdentity) -> bool {
    start.outer_pid != 0
        && start.proc_device != 0
        && start.proc_inode != 0
        && start.start_time_ticks != 0
}

fn abort<K: StoppedChildKernel>(
    mut kernel: K,
    authority: ParentAuthority<K::Handle>,
    cause: FailureCause<K::Error>,
) -> LaunchFailure<K> {
    let kill_error = kernel.send_sigkill(&authority).err();
    let (reap_error, terminal_evidence_invalid, terminal) = match kernel.reap(&authority) {
        Ok(evidence) if evidence.start == authority.start => (None, false, Some(evidence)),
        Ok(_) => (None, true, None),
        Err(error) => (Some(error), false, None),
    };
    if let Some(evidence) = terminal {
        LaunchFailure::Reaped {
            cause,
            receipt: TerminalReceipt {
                start: authority.start,
                disposition: evidence.disposition,
            },
        }
    } else {
        LaunchFailure::Uncertain {
            cause,
            custody: UncertainCustody {
                kernel,
                authority,
                abort: AbortProblems {
                    kill_error,
                    reap_error,
                    terminal_evidence_invalid,
                },
            },
        }
    }
}

fn launch<C, K>(
    boot: BootFrozenLaunch<C>,
    mut kernel: K,
) -> Result<MountAssemblyCustody<K>, LaunchFailure<K>>
where
    K: StoppedChildKernel,
{
    let BootFrozenLaunch {
        bootstrap,
        sandbox_ids,
        parent_namespaces,
    } = boot;

    if !bootstrap_identity_is_valid(bootstrap.identity) {
        return Err(LaunchFailure::NoChild {
            cause: FailureCause::Evidence {
                step: Step::VerifyBootstrapIdentity,
            },
            kernel,
        });
    }
    if sandbox_ids.uid == 0 || sandbox_ids.gid == 0 {
        return Err(LaunchFailure::NoChild {
            cause: FailureCause::Evidence {
                step: Step::VerifyParentAccount,
            },
            kernel,
        });
    }
    if !namespace_inodes_are_valid(parent_namespaces) {
        return Err(LaunchFailure::NoChild {
            cause: FailureCause::Evidence {
                step: Step::VerifyParentNamespaces,
            },
            kernel,
        });
    }

    match kernel.parent_is_dedicated_account(sandbox_ids) {
        Ok(true) => {}
        Ok(false) => {
            return Err(LaunchFailure::NoChild {
                cause: FailureCause::Evidence {
                    step: Step::VerifyParentAccount,
                },
                kernel,
            });
        }
        Err(error) => {
            return Err(LaunchFailure::NoChild {
                cause: FailureCause::Kernel {
                    step: Step::VerifyParentAccount,
                    error,
                },
                kernel,
            });
        }
    }
    match kernel.read_parent_namespaces() {
        Ok(observed) if observed == parent_namespaces => {}
        Ok(_) => {
            return Err(LaunchFailure::NoChild {
                cause: FailureCause::Evidence {
                    step: Step::VerifyParentNamespaces,
                },
                kernel,
            });
        }
        Err(error) => {
            return Err(LaunchFailure::NoChild {
                cause: FailureCause::Kernel {
                    step: Step::VerifyParentNamespaces,
                    error,
                },
                kernel,
            });
        }
    }

    let FreshChild { authority } =
        match kernel.clone3_exec_bootstrap(CLONE3_CONTRACT, CHILD_BOOTSTRAP_CONTRACT, bootstrap) {
            Ok(child) => child,
            Err(error) => {
                return Err(LaunchFailure::NoChild {
                    cause: FailureCause::Kernel {
                        step: Step::Clone3,
                        error,
                    },
                    kernel,
                });
            }
        };

    macro_rules! kernel_step {
        ($step:expr, $operation:expr) => {
            match $operation {
                Ok(value) => value,
                Err(error) => {
                    return Err(abort(
                        kernel,
                        authority,
                        FailureCause::Kernel { step: $step, error },
                    ));
                }
            }
        };
    }
    macro_rules! require {
        ($step:expr, $condition:expr) => {
            if !$condition {
                return Err(abort(
                    kernel,
                    authority,
                    FailureCause::Evidence { step: $step },
                ));
            }
        };
    }

    let start = kernel_step!(
        Step::VerifyStartIdentity,
        kernel.read_start_identity(&authority)
    );
    require!(
        Step::VerifyStartIdentity,
        start == authority.start && start_identity_is_valid(start)
    );
    let waiting = kernel_step!(
        Step::VerifyBootstrapWait,
        kernel.child_is_in_bootstrap_wait(&authority)
    );
    require!(Step::VerifyBootstrapWait, waiting);
    let parent = kernel_step!(
        Step::VerifyParentNamespaces,
        kernel.read_parent_namespaces()
    );
    require!(Step::VerifyParentNamespaces, parent == parent_namespaces);
    let initial_child_namespaces = kernel_step!(
        Step::VerifyChildNamespaces,
        kernel.read_child_namespaces(&authority)
    );
    require!(
        Step::VerifyChildNamespaces,
        namespaces_are_new(initial_child_namespaces, parent_namespaces)
    );

    // user_namespaces(7) requires "deny" before an unprivileged gid_map write.
    // Linux does not require uid_map to precede gid_map; this protocol freezes
    // uid first so there is exactly one tested sequence: deny, uid, then gid.
    kernel_step!(
        Step::WriteSetgroupsDeny,
        kernel.write_setgroups(&authority, SETGROUPS_DENY)
    );
    let uid_map = SingleIdMap {
        outside: sandbox_ids.uid,
    };
    let gid_map = SingleIdMap {
        outside: sandbox_ids.gid,
    };
    let uid_map_line = uid_map.line();
    let gid_map_line = gid_map.line();
    kernel_step!(
        Step::WriteUidMap,
        kernel.write_uid_map(&authority, &uid_map_line)
    );
    kernel_step!(
        Step::WriteGidMap,
        kernel.write_gid_map(&authority, &gid_map_line)
    );

    let start = kernel_step!(
        Step::VerifyStartIdentity,
        kernel.read_start_identity(&authority)
    );
    require!(Step::VerifyStartIdentity, start == authority.start);
    let setgroups = kernel_step!(Step::ReadSetgroups, kernel.read_setgroups(&authority));
    require!(Step::ReadSetgroups, setgroups.as_slice() == SETGROUPS_DENY);
    let observed_uid = kernel_step!(Step::ReadUidMap, kernel.read_uid_map(&authority));
    require!(
        Step::ReadUidMap,
        observed_uid.as_slice() == [uid_map.extent()]
    );
    let observed_gid = kernel_step!(Step::ReadGidMap, kernel.read_gid_map(&authority));
    require!(
        Step::ReadGidMap,
        observed_gid.as_slice() == [gid_map.extent()]
    );
    let child_namespaces = kernel_step!(
        Step::VerifyChildNamespaces,
        kernel.read_child_namespaces(&authority)
    );
    require!(
        Step::VerifyChildNamespaces,
        child_namespaces == initial_child_namespaces
            && namespaces_are_new(child_namespaces, parent_namespaces)
    );
    let nspid = kernel_step!(Step::VerifyNspid, kernel.read_nspid(&authority));
    require!(
        Step::VerifyNspid,
        nspid.as_slice() == [authority.start.outer_pid, 1]
    );
    let parent = kernel_step!(
        Step::VerifyParentNamespaces,
        kernel.read_parent_namespaces()
    );
    require!(Step::VerifyParentNamespaces, parent == parent_namespaces);
    let waiting = kernel_step!(
        Step::VerifyBootstrapWait,
        kernel.child_is_in_bootstrap_wait(&authority)
    );
    require!(Step::VerifyBootstrapWait, waiting);
    kernel_step!(
        Step::ReleaseProtocol,
        kernel.release_to_mount_assembly(&authority, BootstrapMessage::ReleaseToMountAssembly,)
    );

    Ok(MountAssemblyCustody { kernel, authority })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Call {
        Account,
        ParentNamespaces,
        Clone3,
        Start,
        Wait,
        Setgroups,
        UidMap,
        GidMap,
        ReadSetgroups,
        ReadUidMap,
        ReadGidMap,
        ChildNamespaces,
        Nspid,
        Release,
        Kill,
        Reap,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct FakeError(Call);

    struct FakeHandle(u8);
    struct FakeBootstrapFd(u8);

    struct FakeKernel {
        calls: Rc<RefCell<Vec<Call>>>,
        fail_at: Option<Call>,
        bad_evidence_at: Option<Call>,
        kill_fails: bool,
        reap_fails: bool,
        invalid_reap: bool,
        reap_disposition: TerminalDisposition,
    }

    const IDS: DedicatedSandboxIds = DedicatedSandboxIds {
        uid: 62001,
        gid: 62002,
    };
    const PARENT_NS: NamespaceInodes = NamespaceInodes {
        user: 10,
        mount: 11,
        pid: 12,
        network: 13,
    };
    const CHILD_NS: NamespaceInodes = NamespaceInodes {
        user: 20,
        mount: 21,
        pid: 22,
        network: 23,
    };
    const START: ChildStartIdentity = ChildStartIdentity {
        outer_pid: 4242,
        proc_device: 30,
        proc_inode: 31,
        start_time_ticks: 32,
    };

    impl FakeKernel {
        fn record(&mut self, call: Call) -> Result<(), FakeError> {
            self.calls.borrow_mut().push(call);
            if self.fail_at == Some(call) {
                Err(FakeError(call))
            } else {
                Ok(())
            }
        }

        fn bad(&self, call: Call) -> bool {
            self.bad_evidence_at == Some(call)
        }
    }

    impl StoppedChildKernel for FakeKernel {
        type Error = FakeError;
        type Handle = FakeHandle;

        fn clone3_exec_bootstrap<C>(
            &mut self,
            clone: Clone3Contract,
            child: ChildBootstrapContract,
            bootstrap: BootFrozenBootstrap<C>,
        ) -> Result<FreshChild<Self::Handle>, Self::Error> {
            assert_eq!(clone, CLONE3_CONTRACT);
            assert_eq!(child, CHILD_BOOTSTRAP_CONTRACT);
            assert_eq!(bootstrap.identity, bootstrap_identity());
            let BootFrozenBootstrap { custody, .. } = bootstrap;
            let _ = custody;
            self.record(Call::Clone3)?;
            Ok(FreshChild {
                authority: ParentAuthority {
                    handle: FakeHandle(7),
                    start: START,
                },
            })
        }

        fn parent_is_dedicated_account(
            &mut self,
            ids: DedicatedSandboxIds,
        ) -> Result<bool, Self::Error> {
            assert_eq!(ids, IDS);
            self.record(Call::Account)?;
            Ok(!self.bad(Call::Account))
        }

        fn read_parent_namespaces(&mut self) -> Result<NamespaceInodes, Self::Error> {
            self.record(Call::ParentNamespaces)?;
            Ok(if self.bad(Call::ParentNamespaces) {
                NamespaceInodes {
                    user: 99,
                    ..PARENT_NS
                }
            } else {
                PARENT_NS
            })
        }

        fn read_start_identity(
            &mut self,
            authority: &ParentAuthority<Self::Handle>,
        ) -> Result<ChildStartIdentity, Self::Error> {
            assert_eq!(authority.handle.0, 7);
            self.record(Call::Start)?;
            Ok(if self.bad(Call::Start) {
                ChildStartIdentity {
                    proc_inode: 999,
                    ..START
                }
            } else {
                START
            })
        }

        fn child_is_in_bootstrap_wait(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
        ) -> Result<bool, Self::Error> {
            self.record(Call::Wait)?;
            Ok(!self.bad(Call::Wait))
        }

        fn write_setgroups(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
            exact: &'static [u8],
        ) -> Result<(), Self::Error> {
            assert_eq!(exact, b"deny\n");
            self.record(Call::Setgroups)
        }

        fn write_uid_map(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
            exact_line: &str,
        ) -> Result<(), Self::Error> {
            assert_eq!(exact_line, "0 62001 1\n");
            self.record(Call::UidMap)
        }

        fn write_gid_map(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
            exact_line: &str,
        ) -> Result<(), Self::Error> {
            assert_eq!(exact_line, "0 62002 1\n");
            self.record(Call::GidMap)
        }

        fn read_setgroups(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
        ) -> Result<Vec<u8>, Self::Error> {
            self.record(Call::ReadSetgroups)?;
            Ok(if self.bad(Call::ReadSetgroups) {
                b"allow\n".to_vec()
            } else {
                SETGROUPS_DENY.to_vec()
            })
        }

        fn read_uid_map(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
        ) -> Result<Vec<IdMapExtent>, Self::Error> {
            self.record(Call::ReadUidMap)?;
            Ok(vec![if self.bad(Call::ReadUidMap) {
                IdMapExtent {
                    inside: 0,
                    outside: 1,
                    length: 1,
                }
            } else {
                SingleIdMap { outside: IDS.uid }.extent()
            }])
        }

        fn read_gid_map(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
        ) -> Result<Vec<IdMapExtent>, Self::Error> {
            self.record(Call::ReadGidMap)?;
            Ok(vec![if self.bad(Call::ReadGidMap) {
                IdMapExtent {
                    inside: 0,
                    outside: 1,
                    length: 1,
                }
            } else {
                SingleIdMap { outside: IDS.gid }.extent()
            }])
        }

        fn read_child_namespaces(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
        ) -> Result<NamespaceInodes, Self::Error> {
            self.record(Call::ChildNamespaces)?;
            Ok(if self.bad(Call::ChildNamespaces) {
                NamespaceInodes {
                    user: PARENT_NS.user,
                    ..CHILD_NS
                }
            } else {
                CHILD_NS
            })
        }

        fn read_nspid(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
        ) -> Result<Vec<u32>, Self::Error> {
            self.record(Call::Nspid)?;
            Ok(if self.bad(Call::Nspid) {
                vec![START.outer_pid, 2]
            } else {
                vec![START.outer_pid, 1]
            })
        }

        fn release_to_mount_assembly(
            &mut self,
            _: &ParentAuthority<Self::Handle>,
            message: BootstrapMessage,
        ) -> Result<(), Self::Error> {
            assert_eq!(message, BootstrapMessage::ReleaseToMountAssembly);
            self.record(Call::Release)
        }

        fn send_sigkill(&mut self, _: &ParentAuthority<Self::Handle>) -> Result<(), Self::Error> {
            self.calls.borrow_mut().push(Call::Kill);
            if self.kill_fails {
                Err(FakeError(Call::Kill))
            } else {
                Ok(())
            }
        }

        fn reap(&mut self, _: &ParentAuthority<Self::Handle>) -> Result<ReapEvidence, Self::Error> {
            self.calls.borrow_mut().push(Call::Reap);
            if self.reap_fails {
                Err(FakeError(Call::Reap))
            } else {
                Ok(ReapEvidence {
                    start: if self.invalid_reap {
                        ChildStartIdentity {
                            proc_inode: 999,
                            ..START
                        }
                    } else {
                        START
                    },
                    disposition: self.reap_disposition,
                })
            }
        }
    }

    fn bootstrap_identity() -> BootstrapIdentity {
        BootstrapIdentity {
            sha256: [3; 32],
            device: 4,
            inode: 5,
            mount_id: 6,
            mount_read_only: true,
            uid: 0,
            gid: 0,
            mode: libc::S_IFREG | 0o555,
            size: 7,
        }
    }

    fn boot() -> BootFrozenLaunch<FakeBootstrapFd> {
        BootFrozenLaunch {
            bootstrap: BootFrozenBootstrap {
                identity: bootstrap_identity(),
                custody: FakeBootstrapFd(9),
            },
            sandbox_ids: IDS,
            parent_namespaces: PARENT_NS,
        }
    }

    fn fake(calls: Rc<RefCell<Vec<Call>>>) -> FakeKernel {
        FakeKernel {
            calls,
            fail_at: None,
            bad_evidence_at: None,
            kill_fails: false,
            reap_fails: false,
            invalid_reap: false,
            reap_disposition: TerminalDisposition::Signaled(libc::SIGKILL),
        }
    }

    #[test]
    fn exact_clone_bootstrap_mapping_and_release_order_is_frozen() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let custody =
            launch(boot(), fake(calls.clone())).unwrap_or_else(|_| panic!("launch failed"));
        assert_eq!(custody.authority.start, START);
        assert_eq!(custody.authority.handle.0, 7);
        assert!(Rc::ptr_eq(&custody.kernel.calls, &calls));
        assert_eq!(
            *calls.borrow(),
            vec![
                Call::Account,
                Call::ParentNamespaces,
                Call::Clone3,
                Call::Start,
                Call::Wait,
                Call::ParentNamespaces,
                Call::ChildNamespaces,
                Call::Setgroups,
                Call::UidMap,
                Call::GidMap,
                Call::Start,
                Call::ReadSetgroups,
                Call::ReadUidMap,
                Call::ReadGidMap,
                Call::ChildNamespaces,
                Call::Nspid,
                Call::ParentNamespaces,
                Call::Wait,
                Call::Release,
            ]
        );
        assert_eq!(
            CLONE3_CONTRACT.flags,
            libc::CLONE_NEWUSER as u64
                | libc::CLONE_NEWNS as u64
                | libc::CLONE_NEWPID as u64
                | libc::CLONE_NEWNET as u64
                | libc::CLONE_PIDFD as u64
        );
        assert_eq!(CHILD_BOOTSTRAP_CONTRACT.eof_action, EofAction::SelfAbort);
        assert_eq!(
            CHILD_BOOTSTRAP_CONTRACT.action,
            ChildAction::ExecFrozenBootstrapThenWait
        );
        assert_eq!(
            (
                CHILD_BOOTSTRAP_CONTRACT.only_bootstrap_and_protocol_inherited,
                CHILD_BOOTSTRAP_CONTRACT.argv_and_environment_boot_frozen,
                CHILD_BOOTSTRAP_CONTRACT.one_shot_protocol,
            ),
            (true, true, true)
        );
        assert_eq!(FakeBootstrapFd(9).0, 9);
    }

    #[test]
    fn every_post_clone_failure_kills_and_reaps_before_returning() {
        for failed in [
            Call::Start,
            Call::Wait,
            Call::Setgroups,
            Call::UidMap,
            Call::GidMap,
            Call::ReadSetgroups,
            Call::ReadUidMap,
            Call::ReadGidMap,
            Call::ChildNamespaces,
            Call::Nspid,
            Call::Release,
        ] {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let mut kernel = fake(calls.clone());
            kernel.fail_at = Some(failed);
            let failure = launch(boot(), kernel).err().expect("failure accepted");
            match failure {
                LaunchFailure::Reaped { cause, receipt } => {
                    assert_eq!(
                        cause,
                        FailureCause::Kernel {
                            step: match failed {
                                Call::Start => Step::VerifyStartIdentity,
                                Call::Wait => Step::VerifyBootstrapWait,
                                Call::Setgroups => Step::WriteSetgroupsDeny,
                                Call::UidMap => Step::WriteUidMap,
                                Call::GidMap => Step::WriteGidMap,
                                Call::ReadSetgroups => Step::ReadSetgroups,
                                Call::ReadUidMap => Step::ReadUidMap,
                                Call::ReadGidMap => Step::ReadGidMap,
                                Call::ChildNamespaces => Step::VerifyChildNamespaces,
                                Call::Nspid => Step::VerifyNspid,
                                Call::Release => Step::ReleaseProtocol,
                                _ => unreachable!(),
                            },
                            error: FakeError(failed),
                        }
                    );
                    assert_eq!(receipt.start, START);
                    assert_eq!(
                        receipt.disposition,
                        TerminalDisposition::Signaled(libc::SIGKILL)
                    );
                }
                _ => panic!("terminal child did not yield a reaped receipt"),
            }
            let calls = calls.borrow();
            assert_eq!(&calls[calls.len() - 2..], &[Call::Kill, Call::Reap]);
            assert!(!calls.contains(&Call::Release) || failed == Call::Release);
        }
    }

    #[test]
    fn false_readback_and_identity_evidence_also_abort() {
        for failed in [
            Call::Start,
            Call::Wait,
            Call::ReadSetgroups,
            Call::ReadUidMap,
            Call::ReadGidMap,
            Call::ChildNamespaces,
            Call::Nspid,
            Call::ParentNamespaces,
        ] {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let mut kernel = fake(calls.clone());
            kernel.bad_evidence_at = Some(failed);
            let failure = launch(boot(), kernel).err().expect("evidence accepted");
            if failed == Call::ParentNamespaces || failed == Call::Account {
                // Parent evidence is checked before clone; there is no child to kill.
                assert!(matches!(failure, LaunchFailure::NoChild { .. }));
            } else {
                assert!(matches!(failure, LaunchFailure::Reaped { .. }));
                let calls = calls.borrow();
                assert_eq!(&calls[calls.len() - 2..], &[Call::Kill, Call::Reap]);
            }
        }
    }

    #[test]
    fn exact_child_that_exited_before_sigkill_is_still_terminal() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut kernel = fake(calls);
        kernel.fail_at = Some(Call::UidMap);
        kernel.kill_fails = true;
        kernel.reap_disposition = TerminalDisposition::Exited(125);
        let failure = launch(boot(), kernel).err().expect("failure accepted");
        match failure {
            LaunchFailure::Reaped { receipt, .. } => {
                assert_eq!(receipt.start, START);
                assert_eq!(receipt.disposition, TerminalDisposition::Exited(125));
            }
            _ => panic!("exact reaped child represented as live uncertainty"),
        }
    }

    #[test]
    fn unproven_terminality_returns_owned_uncertain_custody() {
        for (reap_fails, invalid_reap) in [(true, false), (false, true)] {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let mut kernel = fake(calls.clone());
            kernel.fail_at = Some(Call::UidMap);
            kernel.kill_fails = true;
            kernel.reap_fails = reap_fails;
            kernel.invalid_reap = invalid_reap;
            let failure = launch(boot(), kernel).err().expect("failure accepted");
            match failure {
                LaunchFailure::Uncertain { cause, custody } => {
                    assert_eq!(
                        cause,
                        FailureCause::Kernel {
                            step: Step::WriteUidMap,
                            error: FakeError(Call::UidMap),
                        }
                    );
                    assert_eq!(custody.authority.start, START);
                    assert_eq!(custody.authority.handle.0, 7);
                    assert_eq!(custody.abort.kill_error, Some(FakeError(Call::Kill)));
                    assert_eq!(custody.abort.reap_error.is_some(), reap_fails);
                    assert_eq!(custody.abort.terminal_evidence_invalid, invalid_reap);
                    assert!(Rc::ptr_eq(&custody.kernel.calls, &calls));
                }
                _ => panic!("uncertain child was represented as terminal"),
            }
            let observed = calls.borrow();
            assert_eq!(&observed[observed.len() - 2..], &[Call::Kill, Call::Reap]);
        }
    }

    #[test]
    fn malformed_boot_inputs_fail_before_any_kernel_call() {
        let mut cases = Vec::new();
        let mut invalid_bootstrap = boot();
        invalid_bootstrap.bootstrap.identity.mount_read_only = false;
        cases.push((invalid_bootstrap, Step::VerifyBootstrapIdentity));
        let mut root_ids = boot();
        root_ids.sandbox_ids.uid = 0;
        cases.push((root_ids, Step::VerifyParentAccount));
        let mut zero_namespace = boot();
        zero_namespace.parent_namespaces.mount = 0;
        cases.push((zero_namespace, Step::VerifyParentNamespaces));

        for (boot, step) in cases {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let failure = launch(boot, fake(calls.clone()))
                .err()
                .expect("malformed boot input accepted");
            match failure {
                LaunchFailure::NoChild { cause, .. } => {
                    assert_eq!(cause, FailureCause::Evidence { step });
                }
                _ => panic!("pre-clone input failure claimed a child"),
            }
            assert!(calls.borrow().is_empty());
        }
    }

    #[test]
    fn preclone_failure_never_claims_child_custody_or_calls_clone() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut kernel = fake(calls.clone());
        kernel.bad_evidence_at = Some(Call::Account);
        let failure = launch(boot(), kernel).err().expect("account accepted");
        match failure {
            LaunchFailure::NoChild { cause, kernel } => {
                assert_eq!(
                    cause,
                    FailureCause::Evidence {
                        step: Step::VerifyParentAccount,
                    }
                );
                assert_eq!(kernel.calls, calls);
            }
            _ => panic!("pre-clone failure claimed a child"),
        }
        assert_eq!(*calls.borrow(), vec![Call::Account]);
    }
}
