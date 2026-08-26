//! Deterministic request proof for filesystem and artifact capability families.
//!
//! A proof here only establishes containment of canonical request claims by one exact signed
//! capability and its content-addressed local profile. It does not inspect a filesystem, verify
//! external bodies, establish root identity, count current entries, or prevent TOCTOU races.

use elpis_grants::{
    CanonicalSensitiveEffectRequest, EditTreeOperation, EditTreeRequestOperationV1,
    SensitiveCapabilityRule, SensitiveEffectV1, SensitiveLocalProfileKindV1,
    SensitiveLocalProfileV1,
};
use thiserror::Error;

use super::sha256;

/// Maximum resources derived from one exact request before an effect may start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SensitiveEffectProofDimensions {
    pub request_bytes: u64,
    pub max_result_bytes: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
    pub artifact_count: u32,
    pub artifact_bytes: u64,
}

/// A non-cloneable witness for one path/artifact request tuple.
///
/// This is pure containment evidence, not effect authority. A later composer must bind session and
/// lifecycle proofs before an adapter may perform I/O.
#[derive(Debug)]
pub struct PathArtifactEffectProof {
    request_sha256: String,
    profile_id: String,
    profile_sha256: String,
    dimensions: SensitiveEffectProofDimensions,
}

impl PathArtifactEffectProof {
    pub fn request_sha256(&self) -> &str {
        &self.request_sha256
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn profile_sha256(&self) -> &str {
        &self.profile_sha256
    }

    pub fn dimensions(&self) -> SensitiveEffectProofDimensions {
        self.dimensions
    }

    pub fn request_bytes(&self) -> u64 {
        self.dimensions.request_bytes
    }

    pub fn max_result_bytes(&self) -> u64 {
        self.dimensions.max_result_bytes
    }

    pub fn io_read_bytes(&self) -> u64 {
        self.dimensions.io_read_bytes
    }

    pub fn io_write_bytes(&self) -> u64 {
        self.dimensions.io_write_bytes
    }

    pub fn artifact_count(&self) -> u32 {
        self.dimensions.artifact_count
    }

    pub fn artifact_bytes(&self) -> u64 {
        self.dimensions.artifact_bytes
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum PathArtifactEffectProofError {
    #[error("capability does not belong to the path/artifact family")]
    UnsupportedCapabilityFamily,
    #[error("request effect does not match the capability family")]
    EffectKindMismatch,
    #[error("local profile is invalid")]
    InvalidProfile,
    #[error("capability, request, and local profile are not exactly bound")]
    ProfileBindingMismatch,
    #[error("local profile kind does not match the capability family")]
    ProfileKindMismatch,
    #[error("canonical request exceeds the signed request-byte budget")]
    RequestBytesExceeded,
    #[error("requested result cap exceeds the signed result-byte budget")]
    ResultBytesExceeded,
    #[error("relative path is outside every signed prefix")]
    PathPrefixDenied,
    #[error("relative path exceeds local profile limits")]
    PathLimitExceeded,
    #[error("edit operation count exceeds a signed or local bound")]
    OperationCountExceeded,
    #[error("edit operation is absent from the local profile")]
    OperationDenied,
    #[error("destructive precondition conflicts with the bound root")]
    PreconditionRootMismatch,
    #[error("changed bytes exceed the signed bound")]
    ChangedBytesExceeded,
    #[error("artifact content must be nonempty")]
    EmptyArtifact,
    #[error("artifact content exceeds a signed or local bound")]
    ArtifactBytesExceeded,
    #[error("byte accounting overflowed")]
    ArithmeticOverflow,
}

/// Proves one canonical ReadPath, EditTree, or ArtifactExport request without performing I/O.
pub fn prove_path_artifact_effect(
    capability: &SensitiveCapabilityRule,
    profile: &SensitiveLocalProfileV1,
    request: &CanonicalSensitiveEffectRequest,
) -> Result<PathArtifactEffectProof, PathArtifactEffectProofError> {
    let profile_bytes = profile
        .canonical_bytes()
        .map_err(|_| PathArtifactEffectProofError::InvalidProfile)?;
    let request_bytes = request
        .request()
        .canonical_bytes()
        .map_err(|_| PathArtifactEffectProofError::ArithmeticOverflow)?;
    let request_bytes = u64::try_from(request_bytes.len())
        .map_err(|_| PathArtifactEffectProofError::ArithmeticOverflow)?;
    let profile_sha256 = sha256(&profile_bytes);

    match capability {
        SensitiveCapabilityRule::ReadPath {
            root,
            relative_prefixes,
            budget,
        } => {
            let SensitiveEffectV1::ReadPath {
                root_profile_id,
                relative_path,
                max_result_bytes,
            } = &request.request().effect
            else {
                return Err(PathArtifactEffectProofError::EffectKindMismatch);
            };
            bind_profile(root, root_profile_id, profile, &profile_sha256)?;
            check_budget(request_bytes, *max_result_bytes, budget)?;
            let SensitiveLocalProfileKindV1::FilesystemRoot {
                max_depth,
                max_relative_path_bytes,
                max_component_bytes,
                ..
            } = &profile.profile
            else {
                return Err(PathArtifactEffectProofError::ProfileKindMismatch);
            };
            check_path(
                relative_path,
                relative_prefixes,
                *max_depth,
                *max_relative_path_bytes,
                *max_component_bytes,
            )?;
            Ok(new_proof(
                request,
                profile,
                &root.sha256,
                SensitiveEffectProofDimensions {
                    request_bytes,
                    max_result_bytes: *max_result_bytes,
                    io_read_bytes: *max_result_bytes,
                    io_write_bytes: 0,
                    artifact_count: 0,
                    artifact_bytes: 0,
                },
            ))
        }
        SensitiveCapabilityRule::EditTree {
            tree,
            relative_prefixes,
            max_files,
            max_changed_bytes,
            budget,
        } => {
            let SensitiveEffectV1::EditTree {
                tree_profile_id,
                operations: requested_operations,
                max_result_bytes,
            } = &request.request().effect
            else {
                return Err(PathArtifactEffectProofError::EffectKindMismatch);
            };
            bind_profile(tree, tree_profile_id, profile, &profile_sha256)?;
            check_budget(request_bytes, *max_result_bytes, budget)?;
            let SensitiveLocalProfileKindV1::EditableTree {
                root,
                max_depth,
                max_relative_path_bytes,
                max_component_bytes,
                max_entries,
                operations: allowed_operations,
                ..
            } = &profile.profile
            else {
                return Err(PathArtifactEffectProofError::ProfileKindMismatch);
            };
            if requested_operations.len() > *max_files as usize
                || requested_operations.len() > *max_entries as usize
            {
                return Err(PathArtifactEffectProofError::OperationCountExceeded);
            }

            let mut changed_bytes = 0_u64;
            let mut io_read_bytes = 0_u64;
            let mut io_write_bytes = 0_u64;
            for operation in requested_operations {
                let (path, operation_kind, old_bytes, new_bytes, precondition) =
                    operation_accounting(operation);
                check_path(
                    path,
                    relative_prefixes,
                    *max_depth,
                    *max_relative_path_bytes,
                    *max_component_bytes,
                )?;
                if !allowed_operations.contains(&operation_kind) {
                    return Err(PathArtifactEffectProofError::OperationDenied);
                }
                if let Some((mount_id, device)) = precondition
                    && (mount_id != root.expected_mount_id || device != root.expected_device)
                {
                    return Err(PathArtifactEffectProofError::PreconditionRootMismatch);
                }
                let operation_changed = checked_add(old_bytes, new_bytes)?;
                changed_bytes = checked_add(changed_bytes, operation_changed)?;
                io_read_bytes = checked_add(io_read_bytes, old_bytes)?;
                io_write_bytes = checked_add(io_write_bytes, new_bytes)?;
            }
            if changed_bytes > *max_changed_bytes {
                return Err(PathArtifactEffectProofError::ChangedBytesExceeded);
            }
            Ok(new_proof(
                request,
                profile,
                &tree.sha256,
                SensitiveEffectProofDimensions {
                    request_bytes,
                    max_result_bytes: *max_result_bytes,
                    io_read_bytes,
                    io_write_bytes,
                    artifact_count: 0,
                    artifact_bytes: 0,
                },
            ))
        }
        SensitiveCapabilityRule::ArtifactExport {
            destination_profile,
            max_artifact_bytes,
            budget,
        } => {
            let SensitiveEffectV1::ArtifactExport {
                destination_profile_id,
                content_bytes,
                max_result_bytes,
                ..
            } = &request.request().effect
            else {
                return Err(PathArtifactEffectProofError::EffectKindMismatch);
            };
            bind_profile(
                destination_profile,
                destination_profile_id,
                profile,
                &profile_sha256,
            )?;
            check_budget(request_bytes, *max_result_bytes, budget)?;
            let SensitiveLocalProfileKindV1::ArtifactCustody {
                max_files,
                max_single_file_bytes,
                max_total_bytes,
                ..
            } = &profile.profile
            else {
                return Err(PathArtifactEffectProofError::ProfileKindMismatch);
            };
            if *content_bytes == 0 {
                // SensitiveEffectReservation intentionally cannot encode count=1, bytes=0.
                return Err(PathArtifactEffectProofError::EmptyArtifact);
            }
            if *max_files < 1
                || *content_bytes > *max_artifact_bytes
                || *content_bytes > *max_single_file_bytes
                || *content_bytes > *max_total_bytes
            {
                return Err(PathArtifactEffectProofError::ArtifactBytesExceeded);
            }
            Ok(new_proof(
                request,
                profile,
                &destination_profile.sha256,
                SensitiveEffectProofDimensions {
                    request_bytes,
                    max_result_bytes: *max_result_bytes,
                    io_read_bytes: 0,
                    io_write_bytes: *content_bytes,
                    artifact_count: 1,
                    artifact_bytes: *content_bytes,
                },
            ))
        }
        _ => Err(PathArtifactEffectProofError::UnsupportedCapabilityFamily),
    }
}

fn new_proof(
    request: &CanonicalSensitiveEffectRequest,
    profile: &SensitiveLocalProfileV1,
    profile_sha256: &str,
    dimensions: SensitiveEffectProofDimensions,
) -> PathArtifactEffectProof {
    PathArtifactEffectProof {
        request_sha256: request.request_sha256().to_owned(),
        profile_id: profile.id.clone(),
        profile_sha256: profile_sha256.to_owned(),
        dimensions,
    }
}

fn bind_profile(
    profile_ref: &elpis_grants::SensitiveProfileRef,
    request_profile_id: &str,
    profile: &SensitiveLocalProfileV1,
    profile_sha256: &[u8; 32],
) -> Result<(), PathArtifactEffectProofError> {
    if profile_ref.id != profile.id
        || request_profile_id != profile.id
        || !lower_hex_matches(&profile_ref.sha256, profile_sha256)
    {
        return Err(PathArtifactEffectProofError::ProfileBindingMismatch);
    }
    Ok(())
}

fn check_budget(
    request_bytes: u64,
    max_result_bytes: u64,
    budget: &elpis_grants::CapabilityBudget,
) -> Result<(), PathArtifactEffectProofError> {
    if request_bytes > budget.max_request_bytes {
        return Err(PathArtifactEffectProofError::RequestBytesExceeded);
    }
    if max_result_bytes > budget.max_result_bytes {
        return Err(PathArtifactEffectProofError::ResultBytesExceeded);
    }
    Ok(())
}

fn check_path(
    path: &str,
    prefixes: &[String],
    max_depth: u32,
    max_relative_path_bytes: u32,
    max_component_bytes: u32,
) -> Result<(), PathArtifactEffectProofError> {
    if !prefixes.iter().any(|prefix| path_is_within(path, prefix)) {
        return Err(PathArtifactEffectProofError::PathPrefixDenied);
    }
    let (depth, components_fit) = if path == "." {
        (0_usize, true)
    } else {
        let mut depth = 0_usize;
        let mut fit = true;
        for component in path.split('/') {
            depth = depth
                .checked_add(1)
                .ok_or(PathArtifactEffectProofError::ArithmeticOverflow)?;
            fit &= component.len() <= max_component_bytes as usize;
        }
        (depth, fit)
    };
    if path.len() > max_relative_path_bytes as usize
        || depth > max_depth as usize
        || !components_fit
    {
        return Err(PathArtifactEffectProofError::PathLimitExceeded);
    }
    Ok(())
}

fn path_is_within(path: &str, prefix: &str) -> bool {
    prefix == "."
        || path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

type OperationAccounting<'a> = (&'a str, EditTreeOperation, u64, u64, Option<(u64, u64)>);

fn operation_accounting(operation: &EditTreeRequestOperationV1) -> OperationAccounting<'_> {
    match operation {
        EditTreeRequestOperationV1::CreateDirectory { path } => {
            (path, EditTreeOperation::CreateDirectory, 0, 0, None)
        }
        EditTreeRequestOperationV1::CreateFile {
            path,
            content_bytes,
            ..
        } => (path, EditTreeOperation::CreateFile, 0, *content_bytes, None),
        EditTreeRequestOperationV1::DeleteFile { path, precondition } => (
            path,
            EditTreeOperation::DeleteFile,
            precondition.expected_bytes,
            0,
            Some((precondition.mount_id, precondition.device)),
        ),
        EditTreeRequestOperationV1::RemoveDirectory { path, .. } => {
            (path, EditTreeOperation::RemoveDirectory, 0, 0, None)
        }
        EditTreeRequestOperationV1::ReplaceFile {
            path,
            precondition,
            content_bytes,
            ..
        } => (
            path,
            EditTreeOperation::ReplaceFile,
            precondition.expected_bytes,
            *content_bytes,
            Some((precondition.mount_id, precondition.device)),
        ),
    }
}

fn checked_add(left: u64, right: u64) -> Result<u64, PathArtifactEffectProofError> {
    left.checked_add(right)
        .ok_or(PathArtifactEffectProofError::ArithmeticOverflow)
}

fn lower_hex_matches(value: &str, digest: &[u8; 32]) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return false;
    }
    digest.iter().enumerate().all(|(index, byte)| {
        let high = lower_hex_nibble(bytes[index * 2]);
        let low = lower_hex_nibble(bytes[index * 2 + 1]);
        high.is_some_and(|high| low.is_some_and(|low| ((high << 4) | low) == *byte))
    })
}

fn lower_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use elpis_grants::{
        ArtifactNamePolicy, ArtifactWriteMode, CapabilityBudget, CreatePolicy,
        DestructiveFilePreconditionV1, DestructivePrecondition, EditTreeOperation,
        EditTreeRequestOperationV1, EntryOwnershipPolicy, EntryWritePolicy, FilesystemRootBinding,
        HardLinkPolicy, MountCrossingPolicy, RemoveDirectoryPreconditionV1,
        SENSITIVE_EFFECT_REQUEST_VERSION, SENSITIVE_LOCAL_PROFILE_VERSION, SensitiveCapabilityRule,
        SensitiveEffectRequestV1, SensitiveEffectV1, SensitiveLocalProfileKindV1,
        SensitiveLocalProfileV1, SensitiveProfileRef, SpecialFilePolicy, SymlinkPolicy,
        WriteCommitPolicy,
    };

    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ARTIFACT_NAME: &str = "123e4567-e89b-12d3-a456-426614174000";

    fn budget() -> CapabilityBudget {
        CapabilityBudget {
            max_calls: 4,
            max_request_bytes: 16_384,
            max_result_bytes: 4096,
        }
    }

    fn root(permissions: u32) -> FilesystemRootBinding {
        FilesystemRootBinding {
            canonical_root: "/srv/elpis-test".into(),
            expected_mount_id: 7,
            expected_device: 8,
            expected_inode: 9,
            expected_owner_uid: 1000,
            expected_owner_gid: 1000,
            expected_permissions: permissions,
            entry_ownership: EntryOwnershipPolicy::RootOwnerOnly,
            entry_writes: EntryWritePolicy::OwnerOnly,
            symlinks: SymlinkPolicy::Deny,
            hard_links: HardLinkPolicy::DenyMultipleLinks,
            mount_crossing: MountCrossingPolicy::Deny,
            special_files: SpecialFilePolicy::RegularFilesAndDirectoriesOnly,
        }
    }

    fn read_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "read-root".into(),
            profile: SensitiveLocalProfileKindV1::FilesystemRoot {
                root: root(0o750),
                max_depth: 8,
                max_relative_path_bytes: 128,
                max_component_bytes: 32,
                max_entries: 100,
            },
        }
    }

    fn editable_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "edit-root".into(),
            profile: SensitiveLocalProfileKindV1::EditableTree {
                root: root(0o750),
                max_depth: 8,
                max_relative_path_bytes: 128,
                max_component_bytes: 32,
                max_entries: 100,
                operations: vec![
                    EditTreeOperation::CreateDirectory,
                    EditTreeOperation::CreateFile,
                    EditTreeOperation::DeleteFile,
                    EditTreeOperation::RemoveDirectory,
                    EditTreeOperation::ReplaceFile,
                ],
                create_policy: CreatePolicy::Exclusive,
                replace_policy: DestructivePrecondition::ExactIdentityAndSha256,
                delete_policy: DestructivePrecondition::ExactIdentityAndSha256,
                commit_policy: WriteCommitPolicy::FsyncFileRenameFsyncDirectory,
                created_file_mode: 0o640,
                created_directory_mode: 0o750,
            },
        }
    }

    fn artifact_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "artifact-root".into(),
            profile: SensitiveLocalProfileKindV1::ArtifactCustody {
                root: root(0o700),
                write_mode: ArtifactWriteMode::CreateOnly,
                name_policy: ArtifactNamePolicy::OpaqueUuid,
                created_file_mode: 0o600,
                max_files: 20,
                max_single_file_bytes: 1000,
                max_total_bytes: 10_000,
            },
        }
    }

    fn profile_ref(profile: &SensitiveLocalProfileV1) -> SensitiveProfileRef {
        let digest = sha256(&profile.canonical_bytes().unwrap());
        let mut encoded = String::with_capacity(64);
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for byte in digest {
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
        SensitiveProfileRef {
            id: profile.id.clone(),
            sha256: encoded,
        }
    }

    fn canonical(effect: SensitiveEffectV1) -> CanonicalSensitiveEffectRequest {
        let value = SensitiveEffectRequestV1 {
            version: SENSITIVE_EFFECT_REQUEST_VERSION,
            effect,
        };
        CanonicalSensitiveEffectRequest::parse(&value.canonical_bytes().unwrap()).unwrap()
    }

    fn read_capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::ReadPath {
            root: profile_ref(profile),
            relative_prefixes: vec!["docs".into()],
            budget: budget(),
        }
    }

    fn read_request(profile_id: &str, path: &str, result: u64) -> CanonicalSensitiveEffectRequest {
        canonical(SensitiveEffectV1::ReadPath {
            root_profile_id: profile_id.into(),
            relative_path: path.into(),
            max_result_bytes: result,
        })
    }

    fn precondition(bytes: u64) -> DestructiveFilePreconditionV1 {
        DestructiveFilePreconditionV1 {
            mount_id: 7,
            device: 8,
            inode: 21,
            expected_bytes: bytes,
            sha256: HASH.into(),
        }
    }

    fn edit_operations() -> Vec<EditTreeRequestOperationV1> {
        vec![
            EditTreeRequestOperationV1::CreateDirectory {
                path: "work/new-dir".into(),
            },
            EditTreeRequestOperationV1::CreateFile {
                path: "work/new-file".into(),
                content_sha256: HASH.into(),
                content_bytes: 10,
            },
            EditTreeRequestOperationV1::DeleteFile {
                path: "work/old-file".into(),
                precondition: precondition(11),
            },
            EditTreeRequestOperationV1::RemoveDirectory {
                path: "work/old-dir".into(),
                precondition: RemoveDirectoryPreconditionV1::EmptyDirectory,
            },
            EditTreeRequestOperationV1::ReplaceFile {
                path: "work/replaced".into(),
                precondition: precondition(11),
                content_sha256: HASH.into(),
                content_bytes: 20,
            },
        ]
    }

    fn edit_capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::EditTree {
            tree: profile_ref(profile),
            relative_prefixes: vec!["work".into()],
            max_files: 5,
            max_changed_bytes: 52,
            budget: budget(),
        }
    }

    fn edit_request(
        profile_id: &str,
        operations: Vec<EditTreeRequestOperationV1>,
    ) -> CanonicalSensitiveEffectRequest {
        canonical(SensitiveEffectV1::EditTree {
            tree_profile_id: profile_id.into(),
            operations,
            max_result_bytes: 64,
        })
    }

    fn artifact_capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::ArtifactExport {
            destination_profile: profile_ref(profile),
            max_artifact_bytes: 1000,
            budget: budget(),
        }
    }

    fn artifact_request(profile_id: &str, bytes: u64) -> CanonicalSensitiveEffectRequest {
        canonical(SensitiveEffectV1::ArtifactExport {
            destination_profile_id: profile_id.into(),
            artifact_name: ARTIFACT_NAME.into(),
            content_sha256: HASH.into(),
            content_bytes: bytes,
            max_result_bytes: 32,
        })
    }

    #[test]
    fn exact_read_edit_and_artifact_dimensions_are_bound() {
        let read_profile = read_profile();
        let read_request = read_request(&read_profile.id, "docs/file.txt", 512);
        let proof = prove_path_artifact_effect(
            &read_capability(&read_profile),
            &read_profile,
            &read_request,
        )
        .unwrap();
        assert_eq!(proof.request_sha256(), read_request.request_sha256());
        assert_eq!(proof.profile_id(), "read-root");
        assert_eq!(proof.profile_sha256(), profile_ref(&read_profile).sha256);
        assert_eq!(
            proof.request_bytes(),
            read_request.request().canonical_bytes().unwrap().len() as u64
        );
        assert_eq!(proof.max_result_bytes(), 512);
        assert_eq!(proof.io_read_bytes(), 512);
        assert_eq!(proof.io_write_bytes(), 0);
        assert_eq!(proof.artifact_count(), 0);
        assert_eq!(proof.artifact_bytes(), 0);

        let edit_profile = editable_profile();
        let edit_request = edit_request(&edit_profile.id, edit_operations());
        let proof = prove_path_artifact_effect(
            &edit_capability(&edit_profile),
            &edit_profile,
            &edit_request,
        )
        .unwrap();
        assert_eq!(proof.max_result_bytes(), 64);
        assert_eq!(proof.io_read_bytes(), 22);
        assert_eq!(proof.io_write_bytes(), 30);
        assert_eq!(proof.artifact_count(), 0);
        assert_eq!(proof.artifact_bytes(), 0);

        let artifact_profile = artifact_profile();
        let artifact_request = artifact_request(&artifact_profile.id, 100);
        let proof = prove_path_artifact_effect(
            &artifact_capability(&artifact_profile),
            &artifact_profile,
            &artifact_request,
        )
        .unwrap();
        assert_eq!(proof.max_result_bytes(), 32);
        assert_eq!(proof.io_read_bytes(), 0);
        assert_eq!(proof.io_write_bytes(), 100);
        assert_eq!(proof.artifact_count(), 1);
        assert_eq!(proof.artifact_bytes(), 100);
    }

    #[test]
    fn capability_effect_profile_kind_id_and_hash_must_match_exactly() {
        let profile = read_profile();
        let request = read_request(&profile.id, "docs/file", 10);
        let unsupported = SensitiveCapabilityRule::ServiceAction {
            profile: profile_ref(&profile),
            actions: vec![],
            budget: budget(),
        };
        assert_eq!(
            prove_path_artifact_effect(&unsupported, &profile, &request).unwrap_err(),
            PathArtifactEffectProofError::UnsupportedCapabilityFamily
        );

        let wrong_effect = artifact_request("read-root", 1);
        assert_eq!(
            prove_path_artifact_effect(&read_capability(&profile), &profile, &wrong_effect)
                .unwrap_err(),
            PathArtifactEffectProofError::EffectKindMismatch
        );

        let artifact = artifact_profile();
        let artifact_bound_read = SensitiveCapabilityRule::ReadPath {
            root: profile_ref(&artifact),
            relative_prefixes: vec!["docs".into()],
            budget: budget(),
        };
        let artifact_id_read = read_request(&artifact.id, "docs/file", 10);
        assert_eq!(
            prove_path_artifact_effect(&artifact_bound_read, &artifact, &artifact_id_read)
                .unwrap_err(),
            PathArtifactEffectProofError::ProfileKindMismatch
        );

        let wrong_id = read_request("other-root", "docs/file", 10);
        assert_eq!(
            prove_path_artifact_effect(&read_capability(&profile), &profile, &wrong_id)
                .unwrap_err(),
            PathArtifactEffectProofError::ProfileBindingMismatch
        );
        let mut wrong_hash = read_capability(&profile);
        if let SensitiveCapabilityRule::ReadPath { root, .. } = &mut wrong_hash {
            root.sha256 = HASH.into();
        }
        assert_eq!(
            prove_path_artifact_effect(&wrong_hash, &profile, &request).unwrap_err(),
            PathArtifactEffectProofError::ProfileBindingMismatch
        );
    }

    #[test]
    fn signed_prefix_boundaries_and_profile_path_limits_are_enforced() {
        let profile = read_profile();
        let capability = read_capability(&profile);
        assert_eq!(
            prove_path_artifact_effect(
                &capability,
                &profile,
                &read_request(&profile.id, "doc/file", 10),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::PathPrefixDenied
        );
        assert!(
            prove_path_artifact_effect(
                &capability,
                &profile,
                &read_request(&profile.id, "docs", 10),
            )
            .is_ok()
        );

        let mut shallow = profile.clone();
        if let SensitiveLocalProfileKindV1::FilesystemRoot { max_depth, .. } = &mut shallow.profile
        {
            *max_depth = 1;
        }
        assert_eq!(
            prove_path_artifact_effect(
                &read_capability(&shallow),
                &shallow,
                &read_request(&shallow.id, "docs/file", 10),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::PathLimitExceeded
        );

        let mut narrow_component = profile;
        if let SensitiveLocalProfileKindV1::FilesystemRoot {
            max_component_bytes,
            ..
        } = &mut narrow_component.profile
        {
            *max_component_bytes = 3;
        }
        assert_eq!(
            prove_path_artifact_effect(
                &read_capability(&narrow_component),
                &narrow_component,
                &read_request(&narrow_component.id, "docs/file", 10),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::PathLimitExceeded
        );

        let mut narrow_path = narrow_component.clone();
        if let SensitiveLocalProfileKindV1::FilesystemRoot {
            max_relative_path_bytes,
            max_component_bytes,
            ..
        } = &mut narrow_path.profile
        {
            *max_relative_path_bytes = 8;
            *max_component_bytes = 32;
        }
        assert_eq!(
            prove_path_artifact_effect(
                &read_capability(&narrow_path),
                &narrow_path,
                &read_request(&narrow_path.id, "docs/file", 10),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::PathLimitExceeded
        );
    }

    #[test]
    fn edit_count_operation_churn_and_root_preconditions_fail_closed() {
        let profile = editable_profile();
        let request = edit_request(&profile.id, edit_operations());

        let mut outside_prefix = edit_operations();
        if let EditTreeRequestOperationV1::CreateDirectory { path } = &mut outside_prefix[0] {
            *path = "workspace/new-dir".into();
        }
        assert_eq!(
            prove_path_artifact_effect(
                &edit_capability(&profile),
                &profile,
                &edit_request(&profile.id, outside_prefix),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::PathPrefixDenied
        );

        let mut too_few_files = edit_capability(&profile);
        if let SensitiveCapabilityRule::EditTree { max_files, .. } = &mut too_few_files {
            *max_files = 4;
        }
        assert_eq!(
            prove_path_artifact_effect(&too_few_files, &profile, &request).unwrap_err(),
            PathArtifactEffectProofError::OperationCountExceeded
        );

        let mut too_few_entries = profile.clone();
        if let SensitiveLocalProfileKindV1::EditableTree { max_entries, .. } =
            &mut too_few_entries.profile
        {
            *max_entries = 4;
        }
        assert_eq!(
            prove_path_artifact_effect(
                &edit_capability(&too_few_entries),
                &too_few_entries,
                &edit_request(&too_few_entries.id, edit_operations()),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::OperationCountExceeded
        );

        let mut operation_denied = profile.clone();
        if let SensitiveLocalProfileKindV1::EditableTree { operations, .. } =
            &mut operation_denied.profile
        {
            operations.pop();
        }
        assert_eq!(
            prove_path_artifact_effect(
                &edit_capability(&operation_denied),
                &operation_denied,
                &edit_request(&operation_denied.id, edit_operations()),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::OperationDenied
        );

        let mut low_churn = edit_capability(&profile);
        if let SensitiveCapabilityRule::EditTree {
            max_changed_bytes, ..
        } = &mut low_churn
        {
            *max_changed_bytes = 51;
        }
        assert_eq!(
            prove_path_artifact_effect(&low_churn, &profile, &request).unwrap_err(),
            PathArtifactEffectProofError::ChangedBytesExceeded
        );

        let mut wrong_identity = edit_operations();
        if let EditTreeRequestOperationV1::DeleteFile { precondition, .. } = &mut wrong_identity[2]
        {
            precondition.mount_id = 99;
        }
        assert_eq!(
            prove_path_artifact_effect(
                &edit_capability(&profile),
                &profile,
                &edit_request(&profile.id, wrong_identity),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::PreconditionRootMismatch
        );
    }

    #[test]
    fn request_and_result_budgets_are_checked_before_reservation() {
        let profile = read_profile();
        let request = read_request(&profile.id, "docs/file", 64);
        let request_len = request.request().canonical_bytes().unwrap().len() as u64;
        let mut small_request = read_capability(&profile);
        if let SensitiveCapabilityRule::ReadPath { budget, .. } = &mut small_request {
            budget.max_request_bytes = request_len - 1;
        }
        assert_eq!(
            prove_path_artifact_effect(&small_request, &profile, &request).unwrap_err(),
            PathArtifactEffectProofError::RequestBytesExceeded
        );
        let mut small_result = read_capability(&profile);
        if let SensitiveCapabilityRule::ReadPath { budget, .. } = &mut small_result {
            budget.max_result_bytes = 63;
        }
        assert_eq!(
            prove_path_artifact_effect(&small_result, &profile, &request).unwrap_err(),
            PathArtifactEffectProofError::ResultBytesExceeded
        );
    }

    #[test]
    fn artifacts_are_nonempty_and_fit_signed_single_and_total_caps() {
        let profile = artifact_profile();
        assert_eq!(
            prove_path_artifact_effect(
                &artifact_capability(&profile),
                &profile,
                &artifact_request(&profile.id, 0),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::EmptyArtifact
        );

        let request = artifact_request(&profile.id, 100);
        let mut signed_small = artifact_capability(&profile);
        if let SensitiveCapabilityRule::ArtifactExport {
            max_artifact_bytes, ..
        } = &mut signed_small
        {
            *max_artifact_bytes = 99;
        }
        assert_eq!(
            prove_path_artifact_effect(&signed_small, &profile, &request).unwrap_err(),
            PathArtifactEffectProofError::ArtifactBytesExceeded
        );

        for single_limit in [true, false] {
            let mut local_small = profile.clone();
            if let SensitiveLocalProfileKindV1::ArtifactCustody {
                max_single_file_bytes,
                max_total_bytes,
                ..
            } = &mut local_small.profile
            {
                if single_limit {
                    *max_single_file_bytes = 99;
                } else {
                    *max_single_file_bytes = 99;
                    *max_total_bytes = 99;
                }
            }
            assert_eq!(
                prove_path_artifact_effect(
                    &artifact_capability(&local_small),
                    &local_small,
                    &artifact_request(&local_small.id, 100),
                )
                .unwrap_err(),
                PathArtifactEffectProofError::ArtifactBytesExceeded
            );
        }
    }

    #[test]
    fn invalid_profiles_and_accounting_overflow_are_typed_denials() {
        let mut invalid = read_profile();
        if let SensitiveLocalProfileKindV1::FilesystemRoot { root, .. } = &mut invalid.profile {
            root.expected_mount_id = 0;
        }
        let capability = SensitiveCapabilityRule::ReadPath {
            root: SensitiveProfileRef {
                id: invalid.id.clone(),
                sha256: HASH.into(),
            },
            relative_prefixes: vec!["docs".into()],
            budget: budget(),
        };
        assert_eq!(
            prove_path_artifact_effect(
                &capability,
                &invalid,
                &read_request(&invalid.id, "docs/file", 10),
            )
            .unwrap_err(),
            PathArtifactEffectProofError::InvalidProfile
        );
        assert_eq!(
            checked_add(u64::MAX, 1),
            Err(PathArtifactEffectProofError::ArithmeticOverflow)
        );
    }
}
