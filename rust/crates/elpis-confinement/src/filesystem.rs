//! Private, inert filesystem assembly contract for the sensitive guest.
//!
//! There is deliberately no public constructor in this module. The runtime
//! crate does not yet hand confinement hash-bound directory descriptors, so it
//! would be unsafe to turn a caller path (or caller-supplied mount id) into
//! mount authority here. These types make the eventual hand-off explicit and
//! test the complete state machine without changing a namespace.

#![allow(dead_code)]

use crate::{PROFILE_VERSION, profile_sha256};
use std::fmt;

const FILESYSTEM_PLAN_VERSION: u32 = 1;
const ROOT_TMPFS_BYTES: u64 = 8 * 1024 * 1024;
const SCRATCH_TMPFS_BYTES: u64 = 64 * 1024 * 1024;
const ROOT_MODE: u32 = 0o755;
const RUNTIME_MODE: u32 = 0o555;
const SCRATCH_MODE: u32 = 0o700;
const PROC_MODE: u32 = 0o555;
const OLD_ROOT_MODE: u32 = 0o700;
const PROC_OPTIONS: &str = "hidepid=2,subset=pid";

/// Exact openat2(2) resolution policy for every artifact/new-root lookup.
const ARTIFACT_RESOLVE: ResolvePolicy = ResolvePolicy {
    beneath: true,
    no_symlinks: true,
    no_magic_links: true,
    no_mount_crossing: true,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResolvePolicy {
    beneath: bool,
    no_symlinks: bool,
    no_magic_links: bool,
    no_mount_crossing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MountRestrictions {
    read_only: bool,
    no_suid: bool,
    no_dev: bool,
    no_exec: bool,
}

const ROOT_RESTRICTIONS: MountRestrictions = MountRestrictions {
    read_only: false,
    no_suid: true,
    no_dev: true,
    no_exec: true,
};
const SEALED_ROOT_RESTRICTIONS: MountRestrictions = MountRestrictions {
    read_only: true,
    no_suid: true,
    no_dev: true,
    no_exec: true,
};
const RUNTIME_RESTRICTIONS: MountRestrictions = MountRestrictions {
    read_only: true,
    no_suid: true,
    no_dev: true,
    no_exec: false,
};
const SCRATCH_RESTRICTIONS: MountRestrictions = MountRestrictions {
    read_only: false,
    no_suid: true,
    no_dev: true,
    no_exec: true,
};
const PROC_RESTRICTIONS: MountRestrictions = MountRestrictions {
    read_only: true,
    no_suid: true,
    no_dev: true,
    no_exec: true,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactRole {
    Runtime,
}

/// Complete identity of an already verified directory artifact. A pathname is
/// intentionally not part of the identity; this digest is the canonical tree
/// digest, not an archive label or filename.
#[derive(Clone, Copy, PartialEq, Eq)]
struct ExactArtifactIdentity {
    tree_sha256: [u8; 32],
    device: u64,
    inode: u64,
    mount_id: u64,
    mount_read_only: bool,
    uid: u32,
    gid: u32,
    /// Includes directory file-type bits as returned by statx/fstat.
    mode: u32,
}

impl fmt::Debug for ExactArtifactIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExactArtifactIdentity")
            .field("tree_sha256", &hex::encode(self.tree_sha256))
            .field("device", &self.device)
            .field("inode", &self.inode)
            .field("mount_id", &self.mount_id)
            .field("mount_read_only", &self.mount_read_only)
            .field("uid", &self.uid)
            .field("gid", &self.gid)
            .field("mode", &format_args!("{:#o}", self.mode))
            .finish()
    }
}

/// Minted only by boot integration owning O_PATH descriptors and verified tree
/// digests. It is neither Clone nor Serialize. Private fields prevent request
/// data from fabricating an artifact identity.
struct BootFrozenArtifacts<C> {
    runtime: ExactArtifactIdentity,
    custody: C,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Node {
    Runtime,
    Scratch,
    Proc,
    OldRoot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TmpfsSpec {
    bytes: u64,
    mode: u32,
    restrictions: MountRestrictions,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirectorySpec {
    node: Node,
    mode: u32,
}

const DIRECTORIES: [DirectorySpec; 4] = [
    DirectorySpec {
        node: Node::Runtime,
        mode: RUNTIME_MODE,
    },
    DirectorySpec {
        node: Node::Scratch,
        mode: SCRATCH_MODE,
    },
    DirectorySpec {
        node: Node::Proc,
        mode: PROC_MODE,
    },
    DirectorySpec {
        node: Node::OldRoot,
        mode: OLD_ROOT_MODE,
    },
];

/// Non-configurable plan bound to the canonical launcher profile and one
/// boot-frozen read-only runtime identity. It contains no host pathname.
struct InertFilesystemPlan {
    version: u32,
    launcher_profile_version: u32,
    launcher_profile_sha256: [u8; 32],
    runtime: ExactArtifactIdentity,
    root: TmpfsSpec,
    scratch_tmpfs: TmpfsSpec,
}

impl InertFilesystemPlan {
    fn from_boot<C>(artifacts: &BootFrozenArtifacts<C>) -> Self {
        let mut digest = [0_u8; 32];
        hex::decode_to_slice(profile_sha256(), &mut digest)
            .expect("canonical profile digest is always 32 bytes");
        Self {
            version: FILESYSTEM_PLAN_VERSION,
            launcher_profile_version: PROFILE_VERSION,
            launcher_profile_sha256: digest,
            runtime: artifacts.runtime,
            root: TmpfsSpec {
                bytes: ROOT_TMPFS_BYTES,
                mode: ROOT_MODE,
                restrictions: ROOT_RESTRICTIONS,
            },
            scratch_tmpfs: TmpfsSpec {
                bytes: SCRATCH_TMPFS_BYTES,
                mode: SCRATCH_MODE,
                restrictions: SCRATCH_RESTRICTIONS,
            },
        }
    }
}

/// Dirfd/mount operations only. A production implementation must translate
/// these to unshare, openat2/statx, open_tree/mount_setattr/move_mount,
/// fsopen/fsconfig/fsmount, pivot_root, and umount2. It must not execute a
/// process or alter credentials or non-mount host policy.
trait MountPrimitives {
    type Error;
    type InertHandle;
    fn verify_artifact(
        &mut self,
        role: ArtifactRole,
        expected: ExactArtifactIdentity,
        resolution: ResolvePolicy,
    ) -> Result<(), Self::Error>;
    fn unshare_mount_namespace(&mut self) -> Result<(), Self::Error>;
    fn make_root_recursive_private(&mut self) -> Result<(), Self::Error>;
    fn clone_runtime_tree(&mut self, recursive: bool) -> Result<(), Self::Error>;
    fn create_root_tmpfs(&mut self, spec: TmpfsSpec) -> Result<(), Self::Error>;
    fn create_directory_at(
        &mut self,
        directory: DirectorySpec,
        resolution: ResolvePolicy,
    ) -> Result<(), Self::Error>;
    fn create_scratch_tmpfs(&mut self, spec: TmpfsSpec) -> Result<(), Self::Error>;
    fn attach_runtime(
        &mut self,
        restrictions: MountRestrictions,
        recursive: bool,
    ) -> Result<(), Self::Error>;
    fn mount_proc(
        &mut self,
        options: &'static str,
        restrictions: MountRestrictions,
    ) -> Result<(), Self::Error>;
    fn seal_root(&mut self, restrictions: MountRestrictions) -> Result<(), Self::Error>;
    fn verify_exact_tree(&mut self) -> Result<(), Self::Error>;
    fn pivot_root(&mut self) -> Result<(), Self::Error>;
    fn detach_old_root(&mut self) -> Result<(), Self::Error>;
    fn remove_old_root_directory(&mut self, resolution: ResolvePolicy) -> Result<(), Self::Error>;
    fn verify_no_unplanned_mounts(&mut self) -> Result<(), Self::Error>;
    fn finish(self) -> Result<Self::InertHandle, (Self, Self::Error)>
    where
        Self: Sized;
    fn cleanup(&mut self) -> Result<(), Self::Error>;
}

/// Owns the only authority capable of dismantling a partial tree. Drop always
/// attempts cleanup when a mount primitive's completion is uncertain.
struct CleanupAuthority<P: MountPrimitives> {
    primitives: Option<P>,
}
impl<P: MountPrimitives> Drop for CleanupAuthority<P> {
    fn drop(&mut self) {
        if let Some(primitives) = self.primitives.as_mut() {
            let _ = primitives.cleanup();
        }
    }
}
struct AssemblyFailure<P: MountPrimitives> {
    cause: P::Error,
    cleanup: CleanupAuthority<P>,
}

/// Inert mount-tree handle. It grants no process, execution, credential,
/// policy, cgroup, or broker authority. Its backend owns namespace cleanup.
struct InertFilesystem<H> {
    plan: InertFilesystemPlan,
    handle: H,
}

fn assemble<C, P>(
    artifacts: BootFrozenArtifacts<C>,
    primitives: P,
) -> Result<InertFilesystem<P::InertHandle>, AssemblyFailure<P>>
where
    P: MountPrimitives,
{
    let plan = InertFilesystemPlan::from_boot(&artifacts);
    // Matching scalar fields alone never confer mount authority.
    let BootFrozenArtifacts { custody, .. } = artifacts;
    let _custody = custody;
    let mut p = primitives;
    macro_rules! step {
        ($operation:expr) => {
            if let Err(cause) = $operation {
                return Err(AssemblyFailure {
                    cause,
                    cleanup: CleanupAuthority {
                        primitives: Some(p),
                    },
                });
            }
        };
    }

    step!(p.verify_artifact(ArtifactRole::Runtime, plan.runtime, ARTIFACT_RESOLVE));
    step!(p.unshare_mount_namespace());
    step!(p.make_root_recursive_private());
    step!(p.clone_runtime_tree(true));
    // Close the race between boot freeze and open_tree(CLONE) custody.
    step!(p.verify_artifact(ArtifactRole::Runtime, plan.runtime, ARTIFACT_RESOLVE));
    step!(p.create_root_tmpfs(plan.root));
    for directory in DIRECTORIES {
        step!(p.create_directory_at(directory, ARTIFACT_RESOLVE));
    }
    step!(p.create_scratch_tmpfs(plan.scratch_tmpfs));
    step!(p.attach_runtime(RUNTIME_RESTRICTIONS, true));
    step!(p.mount_proc(PROC_OPTIONS, PROC_RESTRICTIONS));
    step!(p.seal_root(SEALED_ROOT_RESTRICTIONS));
    step!(p.verify_exact_tree());
    step!(p.pivot_root());
    step!(p.detach_old_root());
    step!(p.remove_old_root_directory(ARTIFACT_RESOLVE));
    // Post-detachment mountinfo may contain only /, /runtime, /scratch, /proc:
    // never host /dev, /sys, /run, /home, config, credentials, or cgroup.
    step!(p.verify_no_unplanned_mounts());
    match p.finish() {
        Ok(handle) => Ok(InertFilesystem { plan, handle }),
        Err((p, cause)) => Err(AssemblyFailure {
            cause,
            cleanup: CleanupAuthority {
                primitives: Some(p),
            },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Call {
        Verify(ArtifactRole),
        Unshare,
        Private,
        CloneRuntime,
        Root(TmpfsSpec),
        Directory(DirectorySpec),
        Scratch(TmpfsSpec),
        AttachRuntime(MountRestrictions),
        Proc,
        SealRoot(MountRestrictions),
        VerifyTree,
        Pivot,
        Detach,
        RemoveOldRoot,
        VerifyMounts,
        Finish,
        Cleanup,
    }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct FakeError(Call);
    struct FakePrimitives {
        calls: Vec<Call>,
        fail_at: Option<Call>,
        cleaned: std::rc::Rc<std::cell::Cell<bool>>,
    }
    impl FakePrimitives {
        fn call(&mut self, call: Call) -> Result<(), FakeError> {
            self.calls.push(call);
            if self.fail_at == Some(call) {
                Err(FakeError(call))
            } else {
                Ok(())
            }
        }
    }
    impl MountPrimitives for FakePrimitives {
        type Error = FakeError;
        type InertHandle = Vec<Call>;
        fn verify_artifact(
            &mut self,
            role: ArtifactRole,
            _: ExactArtifactIdentity,
            policy: ResolvePolicy,
        ) -> Result<(), Self::Error> {
            assert_eq!(policy, ARTIFACT_RESOLVE);
            self.call(Call::Verify(role))
        }
        fn unshare_mount_namespace(&mut self) -> Result<(), Self::Error> {
            self.call(Call::Unshare)
        }
        fn make_root_recursive_private(&mut self) -> Result<(), Self::Error> {
            self.call(Call::Private)
        }
        fn clone_runtime_tree(&mut self, recursive: bool) -> Result<(), Self::Error> {
            assert!(recursive);
            self.call(Call::CloneRuntime)
        }
        fn create_root_tmpfs(&mut self, spec: TmpfsSpec) -> Result<(), Self::Error> {
            self.call(Call::Root(spec))
        }
        fn create_directory_at(
            &mut self,
            spec: DirectorySpec,
            policy: ResolvePolicy,
        ) -> Result<(), Self::Error> {
            assert_eq!(policy, ARTIFACT_RESOLVE);
            self.call(Call::Directory(spec))
        }
        fn create_scratch_tmpfs(&mut self, spec: TmpfsSpec) -> Result<(), Self::Error> {
            self.call(Call::Scratch(spec))
        }
        fn attach_runtime(
            &mut self,
            flags: MountRestrictions,
            recursive: bool,
        ) -> Result<(), Self::Error> {
            assert!(recursive);
            self.call(Call::AttachRuntime(flags))
        }
        fn mount_proc(
            &mut self,
            options: &'static str,
            flags: MountRestrictions,
        ) -> Result<(), Self::Error> {
            assert_eq!(options, PROC_OPTIONS);
            assert_eq!(flags, PROC_RESTRICTIONS);
            self.call(Call::Proc)
        }
        fn seal_root(&mut self, restrictions: MountRestrictions) -> Result<(), Self::Error> {
            self.call(Call::SealRoot(restrictions))
        }
        fn verify_exact_tree(&mut self) -> Result<(), Self::Error> {
            self.call(Call::VerifyTree)
        }
        fn pivot_root(&mut self) -> Result<(), Self::Error> {
            self.call(Call::Pivot)
        }
        fn detach_old_root(&mut self) -> Result<(), Self::Error> {
            self.call(Call::Detach)
        }
        fn remove_old_root_directory(&mut self, policy: ResolvePolicy) -> Result<(), Self::Error> {
            assert_eq!(policy, ARTIFACT_RESOLVE);
            self.call(Call::RemoveOldRoot)
        }
        fn verify_no_unplanned_mounts(&mut self) -> Result<(), Self::Error> {
            self.call(Call::VerifyMounts)
        }
        fn finish(mut self) -> Result<Self::InertHandle, (Self, Self::Error)> {
            if let Err(error) = self.call(Call::Finish) {
                Err((self, error))
            } else {
                Ok(self.calls)
            }
        }
        fn cleanup(&mut self) -> Result<(), Self::Error> {
            self.cleaned.set(true);
            self.calls.push(Call::Cleanup);
            Ok(())
        }
    }
    fn identity(seed: u8) -> ExactArtifactIdentity {
        ExactArtifactIdentity {
            tree_sha256: [seed; 32],
            device: seed as u64 + 10,
            inode: seed as u64 + 20,
            mount_id: seed as u64 + 30,
            mount_read_only: true,
            uid: 1001,
            gid: 1001,
            mode: libc::S_IFDIR | 0o555,
        }
    }
    fn artifacts() -> BootFrozenArtifacts<()> {
        BootFrozenArtifacts {
            runtime: identity(1),
            custody: (),
        }
    }
    fn fake(fail_at: Option<Call>, cleaned: std::rc::Rc<std::cell::Cell<bool>>) -> FakePrimitives {
        FakePrimitives {
            calls: Vec::new(),
            fail_at,
            cleaned,
        }
    }

    #[test]
    fn exact_tree_is_inert_and_has_no_host_mounts() {
        let cleaned = std::rc::Rc::new(std::cell::Cell::new(false));
        let filesystem = assemble(artifacts(), fake(None, cleaned.clone()))
            .unwrap_or_else(|_| panic!("assembly failed"));
        assert_eq!(filesystem.plan.version, 1);
        assert_eq!(filesystem.plan.launcher_profile_version, PROFILE_VERSION);
        assert_eq!(
            hex::encode(filesystem.plan.launcher_profile_sha256),
            profile_sha256()
        );
        assert_eq!(
            filesystem.plan.root,
            TmpfsSpec {
                bytes: 8 * 1024 * 1024,
                mode: 0o755,
                restrictions: ROOT_RESTRICTIONS
            }
        );
        assert_eq!(
            filesystem.plan.scratch_tmpfs,
            TmpfsSpec {
                bytes: 64 * 1024 * 1024,
                mode: 0o700,
                restrictions: SCRATCH_RESTRICTIONS
            }
        );
        assert_eq!(
            filesystem.handle,
            vec![
                Call::Verify(ArtifactRole::Runtime),
                Call::Unshare,
                Call::Private,
                Call::CloneRuntime,
                Call::Verify(ArtifactRole::Runtime),
                Call::Root(TmpfsSpec {
                    bytes: ROOT_TMPFS_BYTES,
                    mode: ROOT_MODE,
                    restrictions: ROOT_RESTRICTIONS
                }),
                Call::Directory(DIRECTORIES[0]),
                Call::Directory(DIRECTORIES[1]),
                Call::Directory(DIRECTORIES[2]),
                Call::Directory(DIRECTORIES[3]),
                Call::Scratch(TmpfsSpec {
                    bytes: SCRATCH_TMPFS_BYTES,
                    mode: SCRATCH_MODE,
                    restrictions: SCRATCH_RESTRICTIONS
                }),
                Call::AttachRuntime(RUNTIME_RESTRICTIONS),
                Call::Proc,
                Call::SealRoot(SEALED_ROOT_RESTRICTIONS),
                Call::VerifyTree,
                Call::Pivot,
                Call::Detach,
                Call::RemoveOldRoot,
                Call::VerifyMounts,
                Call::Finish,
            ]
        );
        assert!(!cleaned.get());
    }

    #[test]
    fn runtime_source_is_rechecked_and_scratch_is_fresh() {
        let filesystem = assemble(artifacts(), fake(None, Default::default()))
            .unwrap_or_else(|_| panic!("assembly failed"));
        assert_eq!(
            filesystem
                .handle
                .iter()
                .filter(|c| **c == Call::Verify(ArtifactRole::Runtime))
                .count(),
            2
        );
        assert!(filesystem.plan.runtime.mount_read_only);
        assert_ne!(filesystem.plan.runtime.mount_id, 0);
        assert_eq!(
            filesystem
                .handle
                .iter()
                .filter(|c| matches!(c, Call::Scratch(_)))
                .count(),
            1
        );
        assert_eq!(
            ARTIFACT_RESOLVE,
            ResolvePolicy {
                beneath: true,
                no_symlinks: true,
                no_magic_links: true,
                no_mount_crossing: true
            }
        );
    }

    #[test]
    fn every_post_mutation_failure_retains_cleanup_authority() {
        for failed in [
            Call::Private,
            Call::CloneRuntime,
            Call::Root(TmpfsSpec {
                bytes: ROOT_TMPFS_BYTES,
                mode: ROOT_MODE,
                restrictions: ROOT_RESTRICTIONS,
            }),
            Call::SealRoot(SEALED_ROOT_RESTRICTIONS),
            Call::Pivot,
            Call::Detach,
            Call::RemoveOldRoot,
            Call::VerifyMounts,
            Call::Finish,
        ] {
            let cleaned = std::rc::Rc::new(std::cell::Cell::new(false));
            let failure = match assemble(artifacts(), fake(Some(failed), cleaned.clone())) {
                Ok(_) => panic!("failure accepted"),
                Err(failure) => failure,
            };
            assert_eq!(failure.cause, FakeError(failed));
            assert!(!cleaned.get());
            drop(failure);
            assert!(cleaned.get(), "cleanup not retained for {failed:?}");
        }
    }

    #[test]
    fn only_exact_private_topology_can_be_created() {
        assert_eq!(
            DIRECTORIES,
            [
                DirectorySpec {
                    node: Node::Runtime,
                    mode: 0o555
                },
                DirectorySpec {
                    node: Node::Scratch,
                    mode: 0o700
                },
                DirectorySpec {
                    node: Node::Proc,
                    mode: 0o555
                },
                DirectorySpec {
                    node: Node::OldRoot,
                    mode: 0o700
                }
            ]
        );
        assert_eq!(PROC_OPTIONS, "hidepid=2,subset=pid");
        assert_eq!(
            SEALED_ROOT_RESTRICTIONS,
            MountRestrictions {
                read_only: true,
                no_suid: true,
                no_dev: true,
                no_exec: true
            }
        );
        assert_eq!(
            RUNTIME_RESTRICTIONS,
            MountRestrictions {
                read_only: true,
                no_suid: true,
                no_dev: true,
                no_exec: false
            }
        );
        assert_eq!(
            SCRATCH_RESTRICTIONS,
            MountRestrictions {
                read_only: false,
                no_suid: true,
                no_dev: true,
                no_exec: true
            }
        );
    }
}
