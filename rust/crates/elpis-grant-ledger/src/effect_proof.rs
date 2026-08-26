//! Deterministic request proof for sensitive capability families.
//!
//! A proof here only establishes containment of canonical request claims by one exact signed
//! capability and its content-addressed local profile. It does not inspect a filesystem, verify
//! external bodies, establish root identity, count current entries, or prevent TOCTOU races.

use elpis_grants::{
    CanonicalSensitiveEffectRequest, EditTreeOperation, EditTreeRequestOperationV1,
    KubernetesDeletePrecondition, KubernetesQueryRule, KubernetesRequestOperationV1,
    KubernetesVerb, NetworkRequestBodyPolicy, NetworkRequestBodyV1, PackageDependencyPolicy,
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

/// A non-cloneable witness for one service, package, remote-action, or network request tuple.
///
/// This proof binds only canonical request claims to one exact signed rule and one exact local
/// profile. In particular, it does not resolve a service unit, inspect package archives or
/// dependency state, verify an executable or working directory, resolve an origin, construct
/// headers, open a socket, verify an external body, or perform any effect.
#[derive(Debug)]
pub struct OperationalEffectProof {
    request_sha256: String,
    profile_id: String,
    profile_sha256: String,
    dimensions: SensitiveEffectProofDimensions,
}

impl OperationalEffectProof {
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
pub enum OperationalEffectProofError {
    #[error("capability does not belong to the service/package/remote/network family")]
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
    #[error("requested service action is absent from the signed rule")]
    SignedServiceActionDenied,
    #[error("requested service unit is absent from the bound profile")]
    ServiceUnitDenied,
    #[error("requested service action is absent from the exact unit rule")]
    ProfileServiceActionDenied,
    #[error("requested package operation is absent from the signed rule")]
    SignedPackageOperationDenied,
    #[error("requested package operation is absent from the bound profile")]
    ProfilePackageOperationDenied,
    #[error("requested package name is absent from the signed rule")]
    SignedPackageDenied,
    #[error("package request is not the bound profile's exact complete package list")]
    PackageSelectionMismatch,
    #[error("bound package dependency policy is unsupported")]
    PackageDependencyPolicyMismatch,
    #[error("requested remote action is absent from the signed rule")]
    SignedRemoteActionDenied,
    #[error("requested remote action is absent from the bound profile")]
    RemoteActionDenied,
    #[error("requested remote output exceeds the exact action limits")]
    RemoteOutputExceeded,
    #[error("requested network method is absent from the signed rule")]
    SignedNetworkMethodDenied,
    #[error("no exact-method route contains the requested path")]
    NetworkRouteDenied,
    #[error("request body presence conflicts with the exact route")]
    NetworkBodyDenied,
    #[error("request content type is absent from the exact route")]
    NetworkContentTypeDenied,
    #[error("request body exceeds the bound endpoint request limit")]
    NetworkRequestBytesExceeded,
    #[error("response cap exceeds the bound endpoint response limit")]
    NetworkResponseBytesExceeded,
    #[error("byte accounting overflowed")]
    ArithmeticOverflow,
}

/// Proves one canonical ServiceAction, PackageOperation, RemoteExecProfile, or NetworkEndpoint
/// request without performing an effect.
pub fn prove_operational_effect(
    capability: &SensitiveCapabilityRule,
    profile: &SensitiveLocalProfileV1,
    request: &CanonicalSensitiveEffectRequest,
) -> Result<OperationalEffectProof, OperationalEffectProofError> {
    let profile_bytes = profile
        .canonical_bytes()
        .map_err(|_| OperationalEffectProofError::InvalidProfile)?;
    let request_bytes = request
        .request()
        .canonical_bytes()
        .map_err(|_| OperationalEffectProofError::ArithmeticOverflow)?;
    let request_bytes = u64::try_from(request_bytes.len())
        .map_err(|_| OperationalEffectProofError::ArithmeticOverflow)?;
    let profile_sha256 = sha256(&profile_bytes);

    match capability {
        SensitiveCapabilityRule::ServiceAction {
            profile: profile_ref,
            actions,
            budget,
        } => {
            let SensitiveEffectV1::ServiceAction {
                service_profile_id,
                unit,
                action,
                max_result_bytes,
            } = &request.request().effect
            else {
                return Err(OperationalEffectProofError::EffectKindMismatch);
            };
            bind_operational_profile(profile_ref, service_profile_id, profile, &profile_sha256)?;
            check_operational_budget(request_bytes, *max_result_bytes, budget)?;
            if !actions.contains(action) {
                return Err(OperationalEffectProofError::SignedServiceActionDenied);
            }
            let SensitiveLocalProfileKindV1::ServiceManager { units, .. } = &profile.profile else {
                return Err(OperationalEffectProofError::ProfileKindMismatch);
            };
            let unit_rule = units
                .iter()
                .find(|rule| rule.unit == *unit)
                .ok_or(OperationalEffectProofError::ServiceUnitDenied)?;
            if !unit_rule.actions.contains(action) {
                return Err(OperationalEffectProofError::ProfileServiceActionDenied);
            }
            Ok(new_operational_proof(
                request,
                profile,
                &profile_ref.sha256,
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
        SensitiveCapabilityRule::PackageOperation {
            profile: profile_ref,
            operations,
            packages: signed_packages,
            budget,
        } => {
            let SensitiveEffectV1::PackageOperation {
                package_profile_id,
                operation,
                selections,
                max_result_bytes,
            } = &request.request().effect
            else {
                return Err(OperationalEffectProofError::EffectKindMismatch);
            };
            bind_operational_profile(profile_ref, package_profile_id, profile, &profile_sha256)?;
            check_operational_budget(request_bytes, *max_result_bytes, budget)?;
            if !operations.contains(operation) {
                return Err(OperationalEffectProofError::SignedPackageOperationDenied);
            }
            if selections
                .iter()
                .any(|selection| !signed_packages.contains(&selection.name))
            {
                return Err(OperationalEffectProofError::SignedPackageDenied);
            }
            let SensitiveLocalProfileKindV1::PackageTransaction {
                operations: profile_operations,
                packages,
                dependencies,
                max_io_read_bytes,
                max_io_write_bytes,
                ..
            } = &profile.profile
            else {
                return Err(OperationalEffectProofError::ProfileKindMismatch);
            };
            if !profile_operations.contains(operation) {
                return Err(OperationalEffectProofError::ProfilePackageOperationDenied);
            }
            if !matches!(
                dependencies,
                PackageDependencyPolicy::ExactListedPackagesOnly
            ) {
                return Err(OperationalEffectProofError::PackageDependencyPolicyMismatch);
            }
            let selections_match = selections.len() == packages.len()
                && selections.iter().zip(packages).all(|(requested, exact)| {
                    requested.name == exact.name
                        && requested.version == exact.version
                        && requested.architecture == exact.architecture
                        && requested.archive_sha256 == exact.archive_sha256
                });
            if !selections_match {
                return Err(OperationalEffectProofError::PackageSelectionMismatch);
            }
            Ok(new_operational_proof(
                request,
                profile,
                &profile_ref.sha256,
                SensitiveEffectProofDimensions {
                    request_bytes,
                    max_result_bytes: *max_result_bytes,
                    io_read_bytes: *max_io_read_bytes,
                    io_write_bytes: *max_io_write_bytes,
                    artifact_count: 0,
                    artifact_bytes: 0,
                },
            ))
        }
        SensitiveCapabilityRule::RemoteExecProfile {
            profile: profile_ref,
            actions,
            budget,
        } => {
            let SensitiveEffectV1::RemoteExecProfile {
                remote_profile_id,
                action_id,
                max_stdout_bytes,
                max_stderr_bytes,
            } = &request.request().effect
            else {
                return Err(OperationalEffectProofError::EffectKindMismatch);
            };
            bind_operational_profile(profile_ref, remote_profile_id, profile, &profile_sha256)?;
            check_operational_request_budget(request_bytes, budget)?;
            if !actions.contains(action_id) {
                return Err(OperationalEffectProofError::SignedRemoteActionDenied);
            }
            let SensitiveLocalProfileKindV1::RemoteActions {
                actions: profile_actions,
            } = &profile.profile
            else {
                return Err(OperationalEffectProofError::ProfileKindMismatch);
            };
            let action = profile_actions
                .iter()
                .find(|action| action.id == *action_id)
                .ok_or(OperationalEffectProofError::RemoteActionDenied)?;
            if *max_stdout_bytes > action.max_stdout_bytes
                || *max_stderr_bytes > action.max_stderr_bytes
            {
                return Err(OperationalEffectProofError::RemoteOutputExceeded);
            }
            let max_result_bytes = checked_operational_add(*max_stdout_bytes, *max_stderr_bytes)?;
            if max_result_bytes > budget.max_result_bytes {
                return Err(OperationalEffectProofError::ResultBytesExceeded);
            }
            Ok(new_operational_proof(
                request,
                profile,
                &profile_ref.sha256,
                SensitiveEffectProofDimensions {
                    request_bytes,
                    max_result_bytes,
                    io_read_bytes: action.max_io_read_bytes,
                    io_write_bytes: action.max_io_write_bytes,
                    artifact_count: 0,
                    artifact_bytes: 0,
                },
            ))
        }
        SensitiveCapabilityRule::NetworkEndpoint {
            endpoint_profile,
            methods,
            budget,
        } => {
            let SensitiveEffectV1::NetworkEndpoint {
                endpoint_profile_id,
                method,
                path,
                body,
                max_response_bytes,
            } = &request.request().effect
            else {
                return Err(OperationalEffectProofError::EffectKindMismatch);
            };
            bind_operational_profile(
                endpoint_profile,
                endpoint_profile_id,
                profile,
                &profile_sha256,
            )?;
            check_operational_request_budget(request_bytes, budget)?;
            if !methods.contains(method) {
                return Err(OperationalEffectProofError::SignedNetworkMethodDenied);
            }
            let SensitiveLocalProfileKindV1::NetworkEndpoint {
                routes,
                max_request_bytes,
                max_response_bytes: profile_max_response_bytes,
                ..
            } = &profile.profile
            else {
                return Err(OperationalEffectProofError::ProfileKindMismatch);
            };
            let route = routes
                .iter()
                .find(|route| {
                    route.method == *method && network_path_is_within(path, &route.path_prefix)
                })
                .ok_or(OperationalEffectProofError::NetworkRouteDenied)?;
            let content_bytes = match (&route.request_body, body) {
                (NetworkRequestBodyPolicy::Forbidden, NetworkRequestBodyV1::Forbidden) => 0,
                (
                    NetworkRequestBodyPolicy::Allowed { content_types },
                    NetworkRequestBodyV1::Content {
                        content_type,
                        content_bytes,
                        ..
                    },
                ) => {
                    if !content_types.contains(content_type) {
                        return Err(OperationalEffectProofError::NetworkContentTypeDenied);
                    }
                    *content_bytes
                }
                _ => return Err(OperationalEffectProofError::NetworkBodyDenied),
            };
            if content_bytes > *max_request_bytes {
                return Err(OperationalEffectProofError::NetworkRequestBytesExceeded);
            }
            if *max_response_bytes > *profile_max_response_bytes {
                return Err(OperationalEffectProofError::NetworkResponseBytesExceeded);
            }
            if *max_response_bytes > budget.max_result_bytes {
                return Err(OperationalEffectProofError::ResultBytesExceeded);
            }
            Ok(new_operational_proof(
                request,
                profile,
                &endpoint_profile.sha256,
                SensitiveEffectProofDimensions {
                    request_bytes,
                    max_result_bytes: *max_response_bytes,
                    io_read_bytes: *max_response_bytes,
                    io_write_bytes: content_bytes,
                    artifact_count: 0,
                    artifact_bytes: 0,
                },
            ))
        }
        _ => Err(OperationalEffectProofError::UnsupportedCapabilityFamily),
    }
}

/// A non-cloneable witness for one namespaced Kubernetes query or delete tuple.
///
/// This proof binds canonical request claims to the exact signed cluster profile. The profile
/// hash consequently binds the API origin, TLS identity, credential reference, namespace, query
/// rules, and wire byte caps. It does not resolve credentials, contact Kubernetes, verify a
/// returned object, or perform any effect. Create, patch, update, and object-template authority
/// are deliberately outside this proof family.
#[derive(Debug)]
pub struct KubernetesEffectProof {
    request_sha256: String,
    profile_id: String,
    profile_sha256: String,
    dimensions: SensitiveEffectProofDimensions,
}

impl KubernetesEffectProof {
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
pub enum KubernetesEffectProofError {
    #[error("capability does not belong to the Kubernetes namespace family")]
    UnsupportedCapabilityFamily,
    #[error("request effect does not match the Kubernetes namespace family")]
    EffectKindMismatch,
    #[error("local profile is invalid")]
    InvalidProfile,
    #[error("capability, request, and cluster profile are not exactly bound")]
    ProfileBindingMismatch,
    #[error("local profile is not a Kubernetes cluster profile")]
    ProfileKindMismatch,
    #[error("signed, requested, and profile namespaces do not match")]
    NamespaceMismatch,
    #[error("requested Kubernetes verb is absent from the signed rule")]
    SignedVerbDenied,
    #[error("requested Kubernetes resource is absent from the signed rule")]
    SignedResourceDenied,
    #[error("bound cluster profile has no exact verb/resource rule")]
    ProfileRuleDenied,
    #[error("requested Kubernetes object name is absent from the exact profile rule")]
    ProfileNameDenied,
    #[error("requested Kubernetes selectors do not exactly match the profile rule")]
    ProfileSelectorsMismatch,
    #[error("delete is not protected by exact UID and resourceVersion preconditions")]
    DeletePreconditionMismatch,
    #[error("canonical request exceeds the signed request-byte budget")]
    RequestBytesExceeded,
    #[error("canonical request exceeds the cluster profile request-byte cap")]
    ProfileRequestBytesExceeded,
    #[error("requested response cap exceeds the signed result-byte budget")]
    ResultBytesExceeded,
    #[error("requested response cap exceeds the cluster profile response-byte cap")]
    ProfileResponseBytesExceeded,
    #[error("byte accounting overflowed")]
    ArithmeticOverflow,
}

/// Proves one canonical Kubernetes Get, List, Watch, or Delete request without performing I/O.
pub fn prove_kubernetes_effect(
    capability: &SensitiveCapabilityRule,
    profile: &SensitiveLocalProfileV1,
    request: &CanonicalSensitiveEffectRequest,
) -> Result<KubernetesEffectProof, KubernetesEffectProofError> {
    let SensitiveCapabilityRule::KubernetesNamespace {
        cluster_profile,
        namespace: signed_namespace,
        verbs,
        resources,
        budget,
    } = capability
    else {
        return Err(KubernetesEffectProofError::UnsupportedCapabilityFamily);
    };
    let SensitiveEffectV1::KubernetesNamespace {
        cluster_profile_id,
        namespace: request_namespace,
        operation,
        max_response_bytes,
    } = &request.request().effect
    else {
        return Err(KubernetesEffectProofError::EffectKindMismatch);
    };

    let profile_bytes = profile
        .canonical_bytes()
        .map_err(|_| KubernetesEffectProofError::InvalidProfile)?;
    let profile_digest = sha256(&profile_bytes);
    if cluster_profile.id != profile.id
        || cluster_profile_id != &profile.id
        || !lower_hex_matches(&cluster_profile.sha256, &profile_digest)
    {
        return Err(KubernetesEffectProofError::ProfileBindingMismatch);
    }

    let SensitiveLocalProfileKindV1::KubernetesCluster {
        namespace: profile_namespace,
        rules,
        max_request_bytes: profile_max_request_bytes,
        max_response_bytes: profile_max_response_bytes,
        ..
    } = &profile.profile
    else {
        // A hash-joined KubernetesObjectTemplates profile is not signed by this capability and
        // must never be treated as indirect write authority.
        return Err(KubernetesEffectProofError::ProfileKindMismatch);
    };
    if signed_namespace != request_namespace || request_namespace != profile_namespace {
        return Err(KubernetesEffectProofError::NamespaceMismatch);
    }

    let (verb, resource) = match operation {
        KubernetesRequestOperationV1::Get { resource, .. } => (KubernetesVerb::Get, resource),
        KubernetesRequestOperationV1::List { resource, .. } => (KubernetesVerb::List, resource),
        KubernetesRequestOperationV1::Watch { resource, .. } => (KubernetesVerb::Watch, resource),
        KubernetesRequestOperationV1::Delete { resource, .. } => (KubernetesVerb::Delete, resource),
    };
    if !verbs.contains(&verb) {
        return Err(KubernetesEffectProofError::SignedVerbDenied);
    }
    if !resources.contains(resource) {
        return Err(KubernetesEffectProofError::SignedResourceDenied);
    }

    let rule = rules
        .iter()
        .find(|rule| {
            matches!(
                (operation, rule),
                (
                    KubernetesRequestOperationV1::Get { resource, .. },
                    KubernetesQueryRule::Get { resource: allowed, .. }
                ) | (
                    KubernetesRequestOperationV1::List { resource, .. },
                    KubernetesQueryRule::List { resource: allowed, .. }
                ) | (
                    KubernetesRequestOperationV1::Watch { resource, .. },
                    KubernetesQueryRule::Watch { resource: allowed, .. }
                ) | (
                    KubernetesRequestOperationV1::Delete { resource, .. },
                    KubernetesQueryRule::Delete { resource: allowed, .. }
                ) if resource == allowed
            )
        })
        .ok_or(KubernetesEffectProofError::ProfileRuleDenied)?;

    match (operation, rule) {
        (
            KubernetesRequestOperationV1::Get { name, .. },
            KubernetesQueryRule::Get { names, .. },
        ) => {
            if !names.contains(name) {
                return Err(KubernetesEffectProofError::ProfileNameDenied);
            }
        }
        (
            KubernetesRequestOperationV1::List { selectors, .. },
            KubernetesQueryRule::List {
                selectors: allowed, ..
            },
        )
        | (
            KubernetesRequestOperationV1::Watch { selectors, .. },
            KubernetesQueryRule::Watch {
                selectors: allowed, ..
            },
        ) => {
            if selectors != allowed {
                return Err(KubernetesEffectProofError::ProfileSelectorsMismatch);
            }
        }
        (
            KubernetesRequestOperationV1::Delete { name, .. },
            KubernetesQueryRule::Delete {
                names,
                precondition,
                ..
            },
        ) => {
            if !names.contains(name) {
                return Err(KubernetesEffectProofError::ProfileNameDenied);
            }
            if !matches!(
                precondition,
                KubernetesDeletePrecondition::ExactUidAndResourceVersion
            ) {
                return Err(KubernetesEffectProofError::DeletePreconditionMismatch);
            }
            // Canonical request construction has already required concrete, validated UID and
            // resourceVersion values. Their values remain in the request hash for the adapter.
        }
        _ => return Err(KubernetesEffectProofError::ProfileRuleDenied),
    }

    let request_bytes = request
        .request()
        .canonical_bytes()
        .map_err(|_| KubernetesEffectProofError::ArithmeticOverflow)?;
    let request_bytes = u64::try_from(request_bytes.len())
        .map_err(|_| KubernetesEffectProofError::ArithmeticOverflow)?;
    if request_bytes > budget.max_request_bytes {
        return Err(KubernetesEffectProofError::RequestBytesExceeded);
    }
    if request_bytes > *profile_max_request_bytes {
        return Err(KubernetesEffectProofError::ProfileRequestBytesExceeded);
    }
    if *max_response_bytes > budget.max_result_bytes {
        return Err(KubernetesEffectProofError::ResultBytesExceeded);
    }
    if *max_response_bytes > *profile_max_response_bytes {
        return Err(KubernetesEffectProofError::ProfileResponseBytesExceeded);
    }

    Ok(KubernetesEffectProof {
        request_sha256: request.request_sha256().to_owned(),
        profile_id: profile.id.clone(),
        profile_sha256: cluster_profile.sha256.clone(),
        dimensions: SensitiveEffectProofDimensions {
            request_bytes,
            max_result_bytes: *max_response_bytes,
            io_read_bytes: *max_response_bytes,
            // Canonical metadata does not account for HTTP framing. Reserve the profile's full
            // signed request cap conservatively rather than undercounting adapter writes.
            io_write_bytes: *profile_max_request_bytes,
            artifact_count: 0,
            artifact_bytes: 0,
        },
    })
}

fn new_operational_proof(
    request: &CanonicalSensitiveEffectRequest,
    profile: &SensitiveLocalProfileV1,
    profile_sha256: &str,
    dimensions: SensitiveEffectProofDimensions,
) -> OperationalEffectProof {
    OperationalEffectProof {
        request_sha256: request.request_sha256().to_owned(),
        profile_id: profile.id.clone(),
        profile_sha256: profile_sha256.to_owned(),
        dimensions,
    }
}

fn bind_operational_profile(
    profile_ref: &elpis_grants::SensitiveProfileRef,
    request_profile_id: &str,
    profile: &SensitiveLocalProfileV1,
    profile_sha256: &[u8; 32],
) -> Result<(), OperationalEffectProofError> {
    if profile_ref.id != profile.id
        || request_profile_id != profile.id
        || !lower_hex_matches(&profile_ref.sha256, profile_sha256)
    {
        return Err(OperationalEffectProofError::ProfileBindingMismatch);
    }
    Ok(())
}

fn check_operational_request_budget(
    request_bytes: u64,
    budget: &elpis_grants::CapabilityBudget,
) -> Result<(), OperationalEffectProofError> {
    if request_bytes > budget.max_request_bytes {
        return Err(OperationalEffectProofError::RequestBytesExceeded);
    }
    Ok(())
}

fn check_operational_budget(
    request_bytes: u64,
    max_result_bytes: u64,
    budget: &elpis_grants::CapabilityBudget,
) -> Result<(), OperationalEffectProofError> {
    check_operational_request_budget(request_bytes, budget)?;
    if max_result_bytes > budget.max_result_bytes {
        return Err(OperationalEffectProofError::ResultBytesExceeded);
    }
    Ok(())
}

fn checked_operational_add(left: u64, right: u64) -> Result<u64, OperationalEffectProofError> {
    left.checked_add(right)
        .ok_or(OperationalEffectProofError::ArithmeticOverflow)
}

fn network_path_is_within(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|remainder| remainder.starts_with('/'))
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

    #[test]
    fn total_authorization_dispatches_all_path_and_artifact_families() {
        use crate::effect_authorization::{
            AuthorizedSensitiveEffectKind, authorize_sensitive_effect, test_canonical_inputs,
        };

        let profile = read_profile();
        let request = read_request(&profile.id, "docs/file.txt", 512);
        let (policy, registry) = test_canonical_inputs(read_capability(&profile), profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::ReadPath
        );
        assert_eq!(authorization.capability_index(), 0);
        assert_eq!(authorization.request_sha256(), request.request_sha256());
        assert_eq!(authorization.policy_sha256(), policy.policy_sha256());
        assert_eq!(authorization.registry_sha256(), registry.registry_sha256());
        assert_eq!(authorization.dimensions().max_result_bytes, 512);

        let profile = editable_profile();
        let request = edit_request(&profile.id, edit_operations());
        let (policy, registry) = test_canonical_inputs(edit_capability(&profile), profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::EditTree
        );
        assert_eq!(authorization.capability_index(), 0);
        assert_eq!(authorization.dimensions().io_write_bytes, 30);

        let profile = artifact_profile();
        let request = artifact_request(&profile.id, 100);
        let (policy, registry) = test_canonical_inputs(artifact_capability(&profile), profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::ArtifactExport
        );
        assert_eq!(authorization.capability_index(), 0);
        assert_eq!(authorization.dimensions().artifact_count, 1);
        assert_eq!(authorization.dimensions().artifact_bytes, 100);
    }

    #[test]
    fn total_authorization_proves_static_bindings_before_tuple_dispatch() {
        use crate::effect_authorization::{
            DeterministicSensitiveEffectAuthorizationError, authorize_sensitive_effect,
            test_canonical_inputs,
        };

        let profile = read_profile();
        let request = read_request(&profile.id, "docs/file.txt", 64);
        let (policy, registry) = test_canonical_inputs(read_capability(&profile), profile.clone());
        let first = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        let second = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(first.policy_profile_id(), "effect-authorization-test");
        assert_eq!(first.profile_id(), profile.id);
        assert_eq!(first.profile_sha256(), second.profile_sha256());
        assert_eq!(first.request_sha256(), second.request_sha256());
        assert_eq!(first.dimensions(), second.dimensions());

        let wrong_request = read_request("another-root", "docs/file.txt", 64);
        assert!(matches!(
            authorize_sensitive_effect(&policy, &registry, &wrong_request),
            Err(DeterministicSensitiveEffectAuthorizationError::MissingCapability)
        ));

        let mut wrong_hash = read_capability(&profile);
        let SensitiveCapabilityRule::ReadPath { root, .. } = &mut wrong_hash else {
            unreachable!()
        };
        root.sha256 = HASH.into();
        let (wrong_policy, exact_registry) = test_canonical_inputs(wrong_hash, profile);
        assert!(matches!(
            authorize_sensitive_effect(&wrong_policy, &exact_registry, &wrong_request),
            Err(DeterministicSensitiveEffectAuthorizationError::Profile(_))
        ));
    }
}

#[cfg(test)]
mod operational_tests {
    use elpis_grants::*;

    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn budget() -> CapabilityBudget {
        CapabilityBudget {
            max_calls: 4,
            max_request_bytes: 16_384,
            max_result_bytes: 4096,
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

    fn external_ref(id: &str) -> SensitiveProfileRef {
        SensitiveProfileRef {
            id: id.into(),
            sha256: HASH_A.into(),
        }
    }

    fn canonical(effect: SensitiveEffectV1) -> CanonicalSensitiveEffectRequest {
        let value = SensitiveEffectRequestV1 {
            version: SENSITIVE_EFFECT_REQUEST_VERSION,
            effect,
        };
        CanonicalSensitiveEffectRequest::parse(&value.canonical_bytes().unwrap()).unwrap()
    }

    fn service_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "services".into(),
            profile: SensitiveLocalProfileKindV1::ServiceManager {
                manager: ServiceManagerKind::SystemdDbus,
                scope: ServiceManagerScope::User { uid: 1000 },
                unit_resolution: ServiceUnitResolutionPolicy::ExactCanonicalNameNoAlias,
                units: vec![
                    ServiceUnitRule {
                        unit: "alpha.service".into(),
                        actions: vec![ServiceAction::Restart, ServiceAction::Status],
                    },
                    ServiceUnitRule {
                        unit: "beta.service".into(),
                        actions: vec![ServiceAction::Status],
                    },
                ],
            },
        }
    }

    fn service_capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::ServiceAction {
            profile: profile_ref(profile),
            actions: vec![ServiceAction::Restart, ServiceAction::Status],
            budget: budget(),
        }
    }

    fn service_request(
        profile: &SensitiveLocalProfileV1,
        unit: &str,
        action: ServiceAction,
        result: u64,
    ) -> CanonicalSensitiveEffectRequest {
        canonical(SensitiveEffectV1::ServiceAction {
            service_profile_id: profile.id.clone(),
            unit: unit.into(),
            action,
            max_result_bytes: result,
        })
    }

    fn package_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "packages".into(),
            profile: SensitiveLocalProfileKindV1::PackageTransaction {
                manager: PackageManagerKind::DebianAptDpkgOffline,
                target_root: external_ref("target-root"),
                repository_endpoint: SensitiveProfileRef {
                    id: "repository".into(),
                    sha256: HASH_B.into(),
                },
                repository_snapshot: PackageRepositorySnapshot {
                    metadata_sha256: HASH_A.into(),
                    signing_key_sha256: HASH_B.into(),
                },
                operations: vec![PackageOperation::Install, PackageOperation::Upgrade],
                packages: vec![
                    PackageSelection {
                        name: "alpha".into(),
                        version: "1:2.3-4".into(),
                        architecture: PackageArchitecture::Amd64,
                        archive_sha256: HASH_A.into(),
                    },
                    PackageSelection {
                        name: "beta".into(),
                        version: "5.0~rc1".into(),
                        architecture: PackageArchitecture::Arm64,
                        archive_sha256: HASH_B.into(),
                    },
                ],
                dependencies: PackageDependencyPolicy::ExactListedPackagesOnly,
                maintainer_scripts: PackageMaintainerScriptPolicy::Forbidden,
                configuration: PackageConfigurationPolicy::FailOnPromptOrConffileChange,
                max_io_read_bytes: 10_000,
                max_io_write_bytes: 20_000,
            },
        }
    }

    fn package_capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::PackageOperation {
            profile: profile_ref(profile),
            operations: vec![PackageOperation::Install, PackageOperation::Upgrade],
            packages: vec!["alpha".into(), "beta".into()],
            budget: budget(),
        }
    }

    fn package_selections(profile: &SensitiveLocalProfileV1) -> Vec<PackageRequestSelectionV1> {
        let SensitiveLocalProfileKindV1::PackageTransaction { packages, .. } = &profile.profile
        else {
            unreachable!()
        };
        packages
            .iter()
            .map(|package| PackageRequestSelectionV1 {
                name: package.name.clone(),
                version: package.version.clone(),
                architecture: package.architecture,
                archive_sha256: package.archive_sha256.clone(),
            })
            .collect()
    }

    fn package_request(
        profile: &SensitiveLocalProfileV1,
        operation: PackageOperation,
        selections: Vec<PackageRequestSelectionV1>,
    ) -> CanonicalSensitiveEffectRequest {
        canonical(SensitiveEffectV1::PackageOperation {
            package_profile_id: profile.id.clone(),
            operation,
            selections,
            max_result_bytes: 512,
        })
    }

    fn remote_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "remote".into(),
            profile: SensitiveLocalProfileKindV1::RemoteActions {
                actions: vec![RemoteActionRule {
                    id: "rotate".into(),
                    execution: RemoteExecutionMode::DirectNativeElfNoShellOrInterpreter,
                    executable_path: "/usr/bin/rotate-logs".into(),
                    executable_sha256: HASH_A.into(),
                    argv: vec!["/usr/bin/rotate-logs".into(), "--fixed".into()],
                    environment: RemoteEnvironmentPolicy {
                        mode: RemoteEnvironmentMode::ClearThenSetFixed,
                        locale: RemoteLocale::CUtf8,
                        timezone: RemoteTimezone::Utc,
                    },
                    cwd_profile: external_ref("remote-cwd"),
                    uid: 1000,
                    gid: 1000,
                    capabilities: vec![],
                    stdin: RemoteStdinPolicy::Closed,
                    no_new_privileges: RemoteNoNewPrivilegesPolicy::Required,
                    timeout_ms: 5000,
                    max_stdout_bytes: 1000,
                    max_stderr_bytes: 500,
                    max_io_read_bytes: 30_000,
                    max_io_write_bytes: 40_000,
                }],
            },
        }
    }

    fn remote_capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::RemoteExecProfile {
            profile: profile_ref(profile),
            actions: vec!["rotate".into()],
            budget: budget(),
        }
    }

    fn remote_request(
        profile: &SensitiveLocalProfileV1,
        action_id: &str,
        stdout: u64,
        stderr: u64,
    ) -> CanonicalSensitiveEffectRequest {
        canonical(SensitiveEffectV1::RemoteExecProfile {
            remote_profile_id: profile.id.clone(),
            action_id: action_id.into(),
            max_stdout_bytes: stdout,
            max_stderr_bytes: stderr,
        })
    }

    fn network_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "network".into(),
            profile: SensitiveLocalProfileKindV1::NetworkEndpoint {
                origin: NetworkHttpsOrigin {
                    protocol: NetworkProtocol::Https,
                    host: "api.example.test".into(),
                    port: 443,
                },
                address_policy: NetworkAddressPolicy {
                    mode: NetworkAddressMode::DirectConnectOnlyPinnedNoProxy,
                    addresses: vec!["198.51.100.10".into()],
                },
                tls: NetworkTlsPolicy {
                    server_name: "api.example.test".into(),
                    minimum_version: NetworkTlsVersion::Tls13,
                    verification:
                        NetworkTlsVerification::PinnedCaAndLeafSpkiWithHostnameAndValidity,
                    ca_certificate_sha256: vec![HASH_A.into()],
                    leaf_spki_sha256: vec![HASH_B.into()],
                },
                routes: vec![NetworkRouteRule {
                    path_prefix: "/v1/items".into(),
                    method: NetworkMethod::Post,
                    query: NetworkQueryPolicy::Forbidden,
                    request_body: NetworkRequestBodyPolicy::Allowed {
                        content_types: vec![NetworkContentType::ApplicationJson],
                    },
                    response_content_types: vec![NetworkContentType::ApplicationJson],
                }],
                request_headers: NetworkRequestHeaderPolicy::GeneratedHostAndAllowedContentTypeOnly,
                response_encoding: NetworkResponseEncodingPolicy::IdentityOnly,
                redirects: NetworkRedirectPolicy::Deny,
                max_request_bytes: 1000,
                max_response_bytes: 2000,
            },
        }
    }

    fn network_capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::NetworkEndpoint {
            endpoint_profile: profile_ref(profile),
            methods: vec![NetworkMethod::Post],
            budget: budget(),
        }
    }

    fn network_request(
        profile: &SensitiveLocalProfileV1,
        method: NetworkMethod,
        path: &str,
        body: NetworkRequestBodyV1,
        response: u64,
    ) -> CanonicalSensitiveEffectRequest {
        canonical(SensitiveEffectV1::NetworkEndpoint {
            endpoint_profile_id: profile.id.clone(),
            method,
            path: path.into(),
            body,
            max_response_bytes: response,
        })
    }

    fn json_body(bytes: u64) -> NetworkRequestBodyV1 {
        NetworkRequestBodyV1::Content {
            content_type: NetworkContentType::ApplicationJson,
            content_sha256: HASH_A.into(),
            content_bytes: bytes,
        }
    }

    #[test]
    fn operational_accounting_rejects_integer_overflow() {
        assert_eq!(
            checked_operational_add(u64::MAX, 1).unwrap_err(),
            OperationalEffectProofError::ArithmeticOverflow
        );
    }

    #[test]
    fn exact_operational_tuples_bind_hashes_and_reservation_dimensions() {
        let service = service_profile();
        let request = service_request(&service, "alpha.service", ServiceAction::Restart, 300);
        let proof =
            prove_operational_effect(&service_capability(&service), &service, &request).unwrap();
        assert_eq!(proof.request_sha256(), request.request_sha256());
        assert_eq!(proof.profile_id(), service.id);
        assert_eq!(proof.profile_sha256(), profile_ref(&service).sha256);
        assert_eq!(
            proof.dimensions(),
            SensitiveEffectProofDimensions {
                request_bytes: request.request().canonical_bytes().unwrap().len() as u64,
                max_result_bytes: 300,
                io_read_bytes: 300,
                io_write_bytes: 0,
                artifact_count: 0,
                artifact_bytes: 0,
            }
        );

        let packages = package_profile();
        let request = package_request(
            &packages,
            PackageOperation::Install,
            package_selections(&packages),
        );
        let proof =
            prove_operational_effect(&package_capability(&packages), &packages, &request).unwrap();
        assert_eq!(proof.max_result_bytes(), 512);
        assert_eq!(proof.io_read_bytes(), 10_000);
        assert_eq!(proof.io_write_bytes(), 20_000);

        let remote = remote_profile();
        let request = remote_request(&remote, "rotate", 700, 300);
        let proof =
            prove_operational_effect(&remote_capability(&remote), &remote, &request).unwrap();
        assert_eq!(proof.max_result_bytes(), 1000);
        assert_eq!(proof.io_read_bytes(), 30_000);
        assert_eq!(proof.io_write_bytes(), 40_000);

        let network = network_profile();
        let request = network_request(
            &network,
            NetworkMethod::Post,
            "/v1/items/current",
            json_body(123),
            1500,
        );
        let proof =
            prove_operational_effect(&network_capability(&network), &network, &request).unwrap();
        assert_eq!(proof.max_result_bytes(), 1500);
        assert_eq!(proof.io_read_bytes(), 1500);
        assert_eq!(proof.io_write_bytes(), 123);
        assert_eq!(proof.artifact_count(), 0);
        assert_eq!(proof.artifact_bytes(), 0);

        let different_body = network_request(
            &network,
            NetworkMethod::Post,
            "/v1/items/current",
            NetworkRequestBodyV1::Content {
                content_type: NetworkContentType::ApplicationJson,
                content_sha256: HASH_B.into(),
                content_bytes: 123,
            },
            1500,
        );
        let different_proof =
            prove_operational_effect(&network_capability(&network), &network, &different_body)
                .unwrap();
        assert_eq!(
            different_proof.request_sha256(),
            different_body.request_sha256()
        );
        assert_ne!(different_proof.request_sha256(), proof.request_sha256());

        let mut bodyless = network_profile();
        let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut bodyless.profile
        else {
            unreachable!()
        };
        routes[0].method = NetworkMethod::Get;
        routes[0].request_body = NetworkRequestBodyPolicy::Forbidden;
        let capability = SensitiveCapabilityRule::NetworkEndpoint {
            endpoint_profile: profile_ref(&bodyless),
            methods: vec![NetworkMethod::Get],
            budget: budget(),
        };
        let request = network_request(
            &bodyless,
            NetworkMethod::Get,
            "/v1/items",
            NetworkRequestBodyV1::Forbidden,
            100,
        );
        let proof = prove_operational_effect(&capability, &bodyless, &request).unwrap();
        assert_eq!(proof.io_write_bytes(), 0);
        assert_eq!(proof.io_read_bytes(), 100);
    }

    #[test]
    fn service_requires_signed_action_and_exact_unit_action() {
        let profile = service_profile();
        let mut capability = service_capability(&profile);
        let request = service_request(&profile, "alpha.service", ServiceAction::Restart, 300);
        let SensitiveCapabilityRule::ServiceAction { actions, .. } = &mut capability else {
            unreachable!()
        };
        *actions = vec![ServiceAction::Status];
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::SignedServiceActionDenied
        );

        let capability = service_capability(&profile);
        let request = service_request(&profile, "gamma.service", ServiceAction::Status, 300);
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::ServiceUnitDenied
        );
        let request = service_request(&profile, "beta.service", ServiceAction::Restart, 300);
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::ProfileServiceActionDenied
        );
    }

    #[test]
    fn package_requires_exact_operation_names_versions_archives_and_complete_closure() {
        let profile = package_profile();
        let selections = package_selections(&profile);
        let request = package_request(&profile, PackageOperation::Install, selections.clone());
        let mut capability = package_capability(&profile);
        let SensitiveCapabilityRule::PackageOperation { operations, .. } = &mut capability else {
            unreachable!()
        };
        *operations = vec![PackageOperation::Upgrade];
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::SignedPackageOperationDenied
        );

        let mut capability = package_capability(&profile);
        let SensitiveCapabilityRule::PackageOperation { packages, .. } = &mut capability else {
            unreachable!()
        };
        *packages = vec!["alpha".into()];
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::SignedPackageDenied
        );

        for changed in ["version", "architecture", "archive"] {
            let mut altered = selections.clone();
            match changed {
                "version" => altered[0].version = "9.9".into(),
                "architecture" => altered[0].architecture = PackageArchitecture::I386,
                "archive" => altered[0].archive_sha256 = HASH_B.into(),
                _ => unreachable!(),
            }
            let request = package_request(&profile, PackageOperation::Install, altered);
            assert_eq!(
                prove_operational_effect(&package_capability(&profile), &profile, &request)
                    .unwrap_err(),
                OperationalEffectProofError::PackageSelectionMismatch
            );
        }
        let request = package_request(
            &profile,
            PackageOperation::Install,
            vec![selections[0].clone()],
        );
        assert_eq!(
            prove_operational_effect(&package_capability(&profile), &profile, &request)
                .unwrap_err(),
            OperationalEffectProofError::PackageSelectionMismatch
        );

        let mut restricted = package_profile();
        let SensitiveLocalProfileKindV1::PackageTransaction { operations, .. } =
            &mut restricted.profile
        else {
            unreachable!()
        };
        *operations = vec![PackageOperation::Upgrade];
        let request = package_request(
            &restricted,
            PackageOperation::Install,
            package_selections(&restricted),
        );
        assert_eq!(
            prove_operational_effect(&package_capability(&restricted), &restricted, &request,)
                .unwrap_err(),
            OperationalEffectProofError::ProfilePackageOperationDenied
        );
    }

    #[test]
    fn remote_action_binds_fixed_profile_identity_and_all_output_limits() {
        let profile = remote_profile();
        let request = remote_request(&profile, "rotate", 700, 300);
        let mut capability = remote_capability(&profile);
        let SensitiveCapabilityRule::RemoteExecProfile { actions, .. } = &mut capability else {
            unreachable!()
        };
        *actions = vec!["other".into()];
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::SignedRemoteActionDenied
        );

        let request = remote_request(&profile, "other", 1, 1);
        let mut capability = remote_capability(&profile);
        let SensitiveCapabilityRule::RemoteExecProfile { actions, .. } = &mut capability else {
            unreachable!()
        };
        *actions = vec!["other".into()];
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::RemoteActionDenied
        );
        for (stdout, stderr) in [(1001, 1), (1, 501)] {
            let request = remote_request(&profile, "rotate", stdout, stderr);
            assert_eq!(
                prove_operational_effect(&remote_capability(&profile), &profile, &request)
                    .unwrap_err(),
                OperationalEffectProofError::RemoteOutputExceeded
            );
        }
        let mut capability = remote_capability(&profile);
        let SensitiveCapabilityRule::RemoteExecProfile { budget, .. } = &mut capability else {
            unreachable!()
        };
        budget.max_result_bytes = 999;
        assert_eq!(
            prove_operational_effect(
                &capability,
                &profile,
                &remote_request(&profile, "rotate", 700, 300),
            )
            .unwrap_err(),
            OperationalEffectProofError::ResultBytesExceeded
        );
    }

    #[test]
    fn network_requires_signed_method_segment_route_exact_body_and_both_response_caps() {
        let profile = network_profile();
        let request = network_request(
            &profile,
            NetworkMethod::Post,
            "/v1/items/current",
            json_body(100),
            1500,
        );
        let mut capability = network_capability(&profile);
        let SensitiveCapabilityRule::NetworkEndpoint { methods, .. } = &mut capability else {
            unreachable!()
        };
        *methods = vec![NetworkMethod::Get];
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request).unwrap_err(),
            OperationalEffectProofError::SignedNetworkMethodDenied
        );

        for path in ["/v1/item", "/v1/items-not-contained"] {
            let request =
                network_request(&profile, NetworkMethod::Post, path, json_body(100), 1500);
            assert_eq!(
                prove_operational_effect(&network_capability(&profile), &profile, &request)
                    .unwrap_err(),
                OperationalEffectProofError::NetworkRouteDenied
            );
        }
        let request = network_request(
            &profile,
            NetworkMethod::Post,
            "/v1/items",
            NetworkRequestBodyV1::Forbidden,
            1500,
        );
        assert_eq!(
            prove_operational_effect(&network_capability(&profile), &profile, &request)
                .unwrap_err(),
            OperationalEffectProofError::NetworkBodyDenied
        );
        let request = network_request(
            &profile,
            NetworkMethod::Post,
            "/v1/items",
            NetworkRequestBodyV1::Content {
                content_type: NetworkContentType::TextPlainUtf8,
                content_sha256: HASH_A.into(),
                content_bytes: 100,
            },
            1500,
        );
        assert_eq!(
            prove_operational_effect(&network_capability(&profile), &profile, &request)
                .unwrap_err(),
            OperationalEffectProofError::NetworkContentTypeDenied
        );
        let request = network_request(
            &profile,
            NetworkMethod::Post,
            "/v1/items",
            json_body(1001),
            1500,
        );
        assert_eq!(
            prove_operational_effect(&network_capability(&profile), &profile, &request)
                .unwrap_err(),
            OperationalEffectProofError::NetworkRequestBytesExceeded
        );
        let request = network_request(
            &profile,
            NetworkMethod::Post,
            "/v1/items",
            json_body(100),
            2001,
        );
        assert_eq!(
            prove_operational_effect(&network_capability(&profile), &profile, &request)
                .unwrap_err(),
            OperationalEffectProofError::NetworkResponseBytesExceeded
        );
        let mut capability = network_capability(&profile);
        let SensitiveCapabilityRule::NetworkEndpoint { budget, .. } = &mut capability else {
            unreachable!()
        };
        budget.max_result_bytes = 1499;
        assert_eq!(
            prove_operational_effect(&capability, &profile, &request_for_response(&profile, 1500))
                .unwrap_err(),
            OperationalEffectProofError::ResultBytesExceeded
        );
    }

    fn request_for_response(
        profile: &SensitiveLocalProfileV1,
        response: u64,
    ) -> CanonicalSensitiveEffectRequest {
        network_request(
            profile,
            NetworkMethod::Post,
            "/v1/items",
            json_body(100),
            response,
        )
    }

    #[test]
    fn exact_profile_hash_binds_units_archives_argv_identity_origin_routes_and_headers_policy() {
        let service = service_profile();
        let capability = service_capability(&service);
        let request = service_request(&service, "alpha.service", ServiceAction::Status, 1);
        let mut changed = service.clone();
        let SensitiveLocalProfileKindV1::ServiceManager { units, .. } = &mut changed.profile else {
            unreachable!()
        };
        units[0].unit = "aardvark.service".into();
        assert_eq!(
            prove_operational_effect(&capability, &changed, &request).unwrap_err(),
            OperationalEffectProofError::ProfileBindingMismatch
        );

        let packages = package_profile();
        let capability = package_capability(&packages);
        let request = package_request(
            &packages,
            PackageOperation::Install,
            package_selections(&packages),
        );
        let mut changed = packages.clone();
        let SensitiveLocalProfileKindV1::PackageTransaction {
            packages: exact_packages,
            ..
        } = &mut changed.profile
        else {
            unreachable!()
        };
        exact_packages[0].archive_sha256 = HASH_B.into();
        assert_eq!(
            prove_operational_effect(&capability, &changed, &request).unwrap_err(),
            OperationalEffectProofError::ProfileBindingMismatch
        );

        let remote = remote_profile();
        let capability = remote_capability(&remote);
        let request = remote_request(&remote, "rotate", 1, 1);
        for change in ["argv", "identity"] {
            let mut changed = remote.clone();
            let SensitiveLocalProfileKindV1::RemoteActions { actions } = &mut changed.profile
            else {
                unreachable!()
            };
            match change {
                "argv" => actions[0].argv[1] = "--different-fixed-value".into(),
                "identity" => actions[0].uid = 1001,
                _ => unreachable!(),
            }
            assert_eq!(
                prove_operational_effect(&capability, &changed, &request).unwrap_err(),
                OperationalEffectProofError::ProfileBindingMismatch
            );
        }

        let network = network_profile();
        let capability = network_capability(&network);
        let request = request_for_response(&network, 100);
        for change in ["origin", "route"] {
            let mut changed = network.clone();
            let SensitiveLocalProfileKindV1::NetworkEndpoint {
                origin,
                tls,
                routes,
                request_headers,
                ..
            } = &mut changed.profile
            else {
                unreachable!()
            };
            // The sole header policy is still hashed with all other adapter-facing facts. Request
            // grammar has no caller-controlled header field to widen it.
            assert!(matches!(
                request_headers,
                NetworkRequestHeaderPolicy::GeneratedHostAndAllowedContentTypeOnly
            ));
            match change {
                "origin" => {
                    origin.host = "other.example.test".into();
                    tls.server_name = "other.example.test".into();
                }
                "route" => routes[0].path_prefix = "/v2/items".into(),
                _ => unreachable!(),
            }
            assert_eq!(
                prove_operational_effect(&capability, &changed, &request).unwrap_err(),
                OperationalEffectProofError::ProfileBindingMismatch
            );
        }
    }

    #[test]
    fn operational_proof_rejects_family_binding_kind_and_metadata_budget_mismatches() {
        let service = service_profile();
        let request = service_request(&service, "alpha.service", ServiceAction::Status, 300);
        let mut capability = service_capability(&service);
        let SensitiveCapabilityRule::ServiceAction { profile, .. } = &mut capability else {
            unreachable!()
        };
        profile.sha256 = HASH_A.into();
        assert_eq!(
            prove_operational_effect(&capability, &service, &request).unwrap_err(),
            OperationalEffectProofError::ProfileBindingMismatch
        );

        let mut capability = service_capability(&service);
        if let SensitiveCapabilityRule::ServiceAction { budget, .. } = &mut capability {
            budget.max_request_bytes = 1;
        }
        assert_eq!(
            prove_operational_effect(&capability, &service, &request).unwrap_err(),
            OperationalEffectProofError::RequestBytesExceeded
        );
        if let SensitiveCapabilityRule::ServiceAction { budget, .. } = &mut capability {
            budget.max_request_bytes = 16_384;
            budget.max_result_bytes = 299;
        }
        assert_eq!(
            prove_operational_effect(&capability, &service, &request).unwrap_err(),
            OperationalEffectProofError::ResultBytesExceeded
        );

        let packages = package_profile();
        let wrong_kind_capability = service_capability(&packages);
        let request = service_request(&packages, "alpha.service", ServiceAction::Status, 1);
        assert_eq!(
            prove_operational_effect(&wrong_kind_capability, &packages, &request).unwrap_err(),
            OperationalEffectProofError::ProfileKindMismatch
        );
        let request = package_request(
            &service,
            PackageOperation::Install,
            package_selections(&packages),
        );
        assert_eq!(
            prove_operational_effect(&service_capability(&service), &service, &request)
                .unwrap_err(),
            OperationalEffectProofError::EffectKindMismatch
        );
        let unsupported = SensitiveCapabilityRule::ReadPath {
            root: profile_ref(&service),
            relative_prefixes: vec!["docs".into()],
            budget: budget(),
        };
        assert_eq!(
            prove_operational_effect(&unsupported, &service, &request).unwrap_err(),
            OperationalEffectProofError::UnsupportedCapabilityFamily
        );

        let mut invalid = service_profile();
        invalid.version = 999;
        assert_eq!(
            prove_operational_effect(
                &service_capability(&service),
                &invalid,
                &service_request(&service, "alpha.service", ServiceAction::Status, 1),
            )
            .unwrap_err(),
            OperationalEffectProofError::InvalidProfile
        );
    }

    #[test]
    fn total_authorization_dispatches_all_operational_families() {
        use crate::effect_authorization::{
            AuthorizedSensitiveEffectKind, authorize_sensitive_effect, test_canonical_inputs,
        };

        let profile = service_profile();
        let request = service_request(&profile, "alpha.service", ServiceAction::Restart, 300);
        let (policy, registry) = test_canonical_inputs(service_capability(&profile), profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::ServiceAction
        );
        assert_eq!(authorization.capability_index(), 0);
        assert_eq!(authorization.dimensions().max_result_bytes, 300);

        let profile = package_profile();
        let request = package_request(
            &profile,
            PackageOperation::Install,
            package_selections(&profile),
        );
        let (policy, registry) = test_canonical_inputs(package_capability(&profile), profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::PackageOperation
        );
        assert_eq!(authorization.dimensions().io_read_bytes, 10_000);
        assert_eq!(authorization.dimensions().io_write_bytes, 20_000);

        let profile = remote_profile();
        let request = remote_request(&profile, "rotate", 700, 300);
        let (policy, registry) = test_canonical_inputs(remote_capability(&profile), profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::RemoteExecProfile
        );
        assert_eq!(authorization.dimensions().max_result_bytes, 1000);

        let profile = network_profile();
        let request = network_request(
            &profile,
            NetworkMethod::Post,
            "/v1/items/current",
            json_body(100),
            1500,
        );
        let (policy, registry) = test_canonical_inputs(network_capability(&profile), profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::NetworkEndpoint
        );
        assert_eq!(authorization.dimensions().io_read_bytes, 1500);
        assert_eq!(authorization.dimensions().io_write_bytes, 100);
    }
}

#[cfg(test)]
mod kubernetes_tests {
    use elpis_grants::*;

    use super::*;

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

    fn selector(key: &str, value: &str) -> KubernetesLabelSelector {
        KubernetesLabelSelector {
            key: key.into(),
            value: value.into(),
        }
    }

    fn cluster_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "worker-cluster".into(),
            profile: SensitiveLocalProfileKindV1::KubernetesCluster {
                api_server: KubernetesApiServer {
                    host: "api.cluster.example".into(),
                    port: 6443,
                    tls_server_name: "api.cluster.example".into(),
                    ca_sha256: "a".repeat(64),
                    redirects: KubernetesRedirectPolicy::Deny,
                },
                credential_profile: SensitiveProfileRef {
                    id: "worker-cluster-credential".into(),
                    sha256: "b".repeat(64),
                },
                namespace: "workers".into(),
                rules: vec![
                    KubernetesQueryRule::Delete {
                        resource: KubernetesResource::ConfigMap,
                        names: vec!["worker-lock".into()],
                        precondition: KubernetesDeletePrecondition::ExactUidAndResourceVersion,
                    },
                    KubernetesQueryRule::Get {
                        resource: KubernetesResource::Pod,
                        names: vec!["worker-a".into(), "worker-b".into()],
                    },
                    KubernetesQueryRule::List {
                        resource: KubernetesResource::Pod,
                        selectors: vec![
                            selector("app", "worker"),
                            selector("elpis.dev/mind", "elm-test"),
                        ],
                    },
                    KubernetesQueryRule::Watch {
                        resource: KubernetesResource::Service,
                        selectors: vec![selector("app", "worker")],
                    },
                ],
                max_request_bytes: 4096,
                max_response_bytes: 8192,
            },
        }
    }

    fn capability(profile: &SensitiveLocalProfileV1) -> SensitiveCapabilityRule {
        SensitiveCapabilityRule::KubernetesNamespace {
            cluster_profile: profile_ref(profile),
            namespace: "workers".into(),
            verbs: vec![
                KubernetesVerb::Delete,
                KubernetesVerb::Get,
                KubernetesVerb::List,
                KubernetesVerb::Watch,
            ],
            resources: vec![
                KubernetesResource::ConfigMap,
                KubernetesResource::Pod,
                KubernetesResource::Service,
            ],
            budget: CapabilityBudget {
                max_calls: 8,
                max_request_bytes: 4096,
                max_result_bytes: 8192,
            },
        }
    }

    fn request(
        profile_id: &str,
        operation: KubernetesRequestOperationV1,
        max_response_bytes: u64,
    ) -> CanonicalSensitiveEffectRequest {
        let value = SensitiveEffectRequestV1 {
            version: SENSITIVE_EFFECT_REQUEST_VERSION,
            effect: SensitiveEffectV1::KubernetesNamespace {
                cluster_profile_id: profile_id.into(),
                namespace: "workers".into(),
                operation,
                max_response_bytes,
            },
        };
        CanonicalSensitiveEffectRequest::parse(&value.canonical_bytes().unwrap()).unwrap()
    }

    fn get(profile: &SensitiveLocalProfileV1, name: &str) -> CanonicalSensitiveEffectRequest {
        request(
            &profile.id,
            KubernetesRequestOperationV1::Get {
                resource: KubernetesResource::Pod,
                name: name.into(),
            },
            2048,
        )
    }

    fn delete(profile: &SensitiveLocalProfileV1) -> CanonicalSensitiveEffectRequest {
        request(
            &profile.id,
            KubernetesRequestOperationV1::Delete {
                resource: KubernetesResource::ConfigMap,
                name: "worker-lock".into(),
                precondition: KubernetesDeletePreconditionV1 {
                    uid: "123e4567-e89b-12d3-a456-426614174000".into(),
                    resource_version: "184467".into(),
                },
            },
            1024,
        )
    }

    #[test]
    fn get_list_watch_and_delete_bind_exact_hashes_and_dimensions() {
        let profile = cluster_profile();
        let requests = [
            get(&profile, "worker-a"),
            request(
                &profile.id,
                KubernetesRequestOperationV1::List {
                    resource: KubernetesResource::Pod,
                    selectors: vec![
                        selector("app", "worker"),
                        selector("elpis.dev/mind", "elm-test"),
                    ],
                },
                3072,
            ),
            request(
                &profile.id,
                KubernetesRequestOperationV1::Watch {
                    resource: KubernetesResource::Service,
                    selectors: vec![selector("app", "worker")],
                },
                4096,
            ),
            delete(&profile),
        ];

        for request in requests {
            let proof = prove_kubernetes_effect(&capability(&profile), &profile, &request).unwrap();
            let canonical_len = request.request().canonical_bytes().unwrap().len() as u64;
            assert_eq!(proof.request_sha256(), request.request_sha256());
            assert_eq!(proof.profile_id(), profile.id);
            assert_eq!(proof.profile_sha256(), profile_ref(&profile).sha256);
            assert_eq!(proof.request_bytes(), canonical_len);
            let response_cap = match &request.request().effect {
                SensitiveEffectV1::KubernetesNamespace {
                    max_response_bytes, ..
                } => *max_response_bytes,
                _ => unreachable!(),
            };
            assert_eq!(proof.max_result_bytes(), response_cap);
            assert_eq!(proof.io_read_bytes(), response_cap);
            assert_eq!(proof.io_write_bytes(), 4096);
            assert_eq!(proof.artifact_count(), 0);
            assert_eq!(proof.artifact_bytes(), 0);
        }

        let first = delete(&profile);
        let mut second_value = first.request().clone();
        let SensitiveEffectV1::KubernetesNamespace { operation, .. } = &mut second_value.effect
        else {
            unreachable!()
        };
        let KubernetesRequestOperationV1::Delete { precondition, .. } = operation else {
            unreachable!()
        };
        precondition.resource_version = "184468".into();
        let second =
            CanonicalSensitiveEffectRequest::parse(&second_value.canonical_bytes().unwrap())
                .unwrap();
        let first_proof = prove_kubernetes_effect(&capability(&profile), &profile, &first).unwrap();
        let second_proof =
            prove_kubernetes_effect(&capability(&profile), &profile, &second).unwrap();
        assert_ne!(first_proof.request_sha256(), second_proof.request_sha256());
    }

    #[test]
    fn signed_namespace_verb_resource_and_exact_profile_rule_are_all_required() {
        let profile = cluster_profile();
        let base_request = get(&profile, "worker-a");

        let mut signed = capability(&profile);
        let SensitiveCapabilityRule::KubernetesNamespace { namespace, .. } = &mut signed else {
            unreachable!()
        };
        *namespace = "other".into();
        assert_eq!(
            prove_kubernetes_effect(&signed, &profile, &base_request).unwrap_err(),
            KubernetesEffectProofError::NamespaceMismatch
        );

        let mut signed = capability(&profile);
        let SensitiveCapabilityRule::KubernetesNamespace { verbs, .. } = &mut signed else {
            unreachable!()
        };
        verbs.retain(|verb| *verb != KubernetesVerb::Get);
        assert_eq!(
            prove_kubernetes_effect(&signed, &profile, &base_request).unwrap_err(),
            KubernetesEffectProofError::SignedVerbDenied
        );

        let mut signed = capability(&profile);
        let SensitiveCapabilityRule::KubernetesNamespace { resources, .. } = &mut signed else {
            unreachable!()
        };
        resources.retain(|resource| *resource != KubernetesResource::Pod);
        assert_eq!(
            prove_kubernetes_effect(&signed, &profile, &base_request).unwrap_err(),
            KubernetesEffectProofError::SignedResourceDenied
        );

        let service_get = request(
            &profile.id,
            KubernetesRequestOperationV1::Get {
                resource: KubernetesResource::Service,
                name: "worker-api".into(),
            },
            1,
        );
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &service_get).unwrap_err(),
            KubernetesEffectProofError::ProfileRuleDenied
        );
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &get(&profile, "worker-c"))
                .unwrap_err(),
            KubernetesEffectProofError::ProfileNameDenied
        );

        let mut wrong_request_value = base_request.request().clone();
        let SensitiveEffectV1::KubernetesNamespace { namespace, .. } =
            &mut wrong_request_value.effect
        else {
            unreachable!()
        };
        *namespace = "other".into();
        let wrong_request =
            CanonicalSensitiveEffectRequest::parse(&wrong_request_value.canonical_bytes().unwrap())
                .unwrap();
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &wrong_request).unwrap_err(),
            KubernetesEffectProofError::NamespaceMismatch
        );
    }

    #[test]
    fn list_and_watch_selectors_must_equal_the_exact_rule() {
        let profile = cluster_profile();
        let omitted = request(
            &profile.id,
            KubernetesRequestOperationV1::List {
                resource: KubernetesResource::Pod,
                selectors: vec![selector("app", "worker")],
            },
            1,
        );
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &omitted).unwrap_err(),
            KubernetesEffectProofError::ProfileSelectorsMismatch
        );

        let added = request(
            &profile.id,
            KubernetesRequestOperationV1::List {
                resource: KubernetesResource::Pod,
                selectors: vec![
                    selector("app", "worker"),
                    selector("elpis.dev/mind", "elm-test"),
                    selector("extra", "not-signed"),
                ],
            },
            1,
        );
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &added).unwrap_err(),
            KubernetesEffectProofError::ProfileSelectorsMismatch
        );

        let wrong_watch = request(
            &profile.id,
            KubernetesRequestOperationV1::Watch {
                resource: KubernetesResource::Service,
                selectors: vec![selector("app", "other")],
            },
            1,
        );
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &wrong_watch).unwrap_err(),
            KubernetesEffectProofError::ProfileSelectorsMismatch
        );
    }

    #[test]
    fn cluster_hash_binds_api_tls_credential_rules_and_caps() {
        let profile = cluster_profile();
        let signed = capability(&profile);
        let request = get(&profile, "worker-a");

        for field in 0..6 {
            let mut changed = profile.clone();
            let SensitiveLocalProfileKindV1::KubernetesCluster {
                api_server,
                credential_profile,
                rules,
                max_response_bytes,
                ..
            } = &mut changed.profile
            else {
                unreachable!()
            };
            match field {
                0 => api_server.host = "api-2.cluster.example".into(),
                1 => api_server.tls_server_name = "api-2.cluster.example".into(),
                2 => api_server.ca_sha256 = "c".repeat(64),
                3 => credential_profile.sha256 = "d".repeat(64),
                4 => {
                    let KubernetesQueryRule::Get { names, .. } = &mut rules[1] else {
                        unreachable!()
                    };
                    names[0] = "worker-0".into();
                }
                5 => *max_response_bytes -= 1,
                _ => unreachable!(),
            }
            assert_eq!(
                prove_kubernetes_effect(&signed, &changed, &request).unwrap_err(),
                KubernetesEffectProofError::ProfileBindingMismatch
            );
        }
    }

    #[test]
    fn profile_id_hash_kind_and_object_templates_fail_closed() {
        let profile = cluster_profile();
        let request = get(&profile, "worker-a");
        let mut signed = capability(&profile);
        let SensitiveCapabilityRule::KubernetesNamespace {
            cluster_profile, ..
        } = &mut signed
        else {
            unreachable!()
        };
        cluster_profile.sha256 = "f".repeat(64);
        assert_eq!(
            prove_kubernetes_effect(&signed, &profile, &request).unwrap_err(),
            KubernetesEffectProofError::ProfileBindingMismatch
        );

        let mut template_profile = SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "worker-templates".into(),
            profile: SensitiveLocalProfileKindV1::KubernetesObjectTemplates {
                cluster_profile: profile_ref(&profile),
                templates: vec![KubernetesWriteTemplate::CreateConfigMap {
                    precondition: KubernetesCreatePrecondition::Exclusive,
                    name: "worker-config".into(),
                    labels: vec![],
                    immutable: KubernetesImmutablePolicy::Required,
                    data: vec![],
                }],
            },
        };
        template_profile.validate().unwrap();
        let template_request = get(&template_profile, "worker-a");
        assert_eq!(
            prove_kubernetes_effect(
                &capability(&template_profile),
                &template_profile,
                &template_request,
            )
            .unwrap_err(),
            KubernetesEffectProofError::ProfileKindMismatch
        );

        template_profile.version = 999;
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &template_profile, &template_request,)
                .unwrap_err(),
            KubernetesEffectProofError::InvalidProfile
        );
    }

    #[test]
    fn signed_and_profile_request_and_response_caps_are_independent() {
        let profile = cluster_profile();
        let base_request = get(&profile, "worker-a");

        let mut signed = capability(&profile);
        let SensitiveCapabilityRule::KubernetesNamespace { budget, .. } = &mut signed else {
            unreachable!()
        };
        budget.max_request_bytes = 1;
        assert_eq!(
            prove_kubernetes_effect(&signed, &profile, &base_request).unwrap_err(),
            KubernetesEffectProofError::RequestBytesExceeded
        );

        let mut capped_profile = profile.clone();
        let SensitiveLocalProfileKindV1::KubernetesCluster {
            max_request_bytes, ..
        } = &mut capped_profile.profile
        else {
            unreachable!()
        };
        *max_request_bytes = 1;
        assert_eq!(
            prove_kubernetes_effect(&capability(&capped_profile), &capped_profile, &base_request)
                .unwrap_err(),
            KubernetesEffectProofError::ProfileRequestBytesExceeded
        );

        let large_response = request(
            &profile.id,
            KubernetesRequestOperationV1::Get {
                resource: KubernetesResource::Pod,
                name: "worker-a".into(),
            },
            8193,
        );
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &large_response).unwrap_err(),
            KubernetesEffectProofError::ResultBytesExceeded
        );

        let mut response_profile = profile.clone();
        let SensitiveLocalProfileKindV1::KubernetesCluster {
            max_response_bytes, ..
        } = &mut response_profile.profile
        else {
            unreachable!()
        };
        *max_response_bytes = 1024;
        let response_request = get(&response_profile, "worker-a");
        assert_eq!(
            prove_kubernetes_effect(
                &capability(&response_profile),
                &response_profile,
                &response_request,
            )
            .unwrap_err(),
            KubernetesEffectProofError::ProfileResponseBytesExceeded
        );
    }

    #[test]
    fn family_and_effect_mismatches_are_typed_denials() {
        let profile = cluster_profile();
        let request = get(&profile, "worker-a");
        let unsupported = SensitiveCapabilityRule::ReadPath {
            root: profile_ref(&profile),
            relative_prefixes: vec![".".into()],
            budget: CapabilityBudget {
                max_calls: 1,
                max_request_bytes: 4096,
                max_result_bytes: 4096,
            },
        };
        assert_eq!(
            prove_kubernetes_effect(&unsupported, &profile, &request).unwrap_err(),
            KubernetesEffectProofError::UnsupportedCapabilityFamily
        );

        let other_request_value = SensitiveEffectRequestV1 {
            version: SENSITIVE_EFFECT_REQUEST_VERSION,
            effect: SensitiveEffectV1::ReadPath {
                root_profile_id: profile.id.clone(),
                relative_path: ".".into(),
                max_result_bytes: 1,
            },
        };
        let other_request =
            CanonicalSensitiveEffectRequest::parse(&other_request_value.canonical_bytes().unwrap())
                .unwrap();
        assert_eq!(
            prove_kubernetes_effect(&capability(&profile), &profile, &other_request).unwrap_err(),
            KubernetesEffectProofError::EffectKindMismatch
        );
    }

    #[test]
    fn total_authorization_dispatches_kubernetes_family() {
        use crate::effect_authorization::{
            AuthorizedSensitiveEffectKind, authorize_sensitive_effect, test_canonical_inputs,
        };

        let profile = cluster_profile();
        let request = get(&profile, "worker-a");
        let mut signed = capability(&profile);
        let SensitiveCapabilityRule::KubernetesNamespace {
            verbs, resources, ..
        } = &mut signed
        else {
            unreachable!()
        };
        *verbs = vec![KubernetesVerb::Get];
        *resources = vec![KubernetesResource::Pod];
        let (policy, registry) = test_canonical_inputs(signed, profile);
        let authorization = authorize_sensitive_effect(&policy, &registry, &request).unwrap();
        assert_eq!(
            authorization.capability_kind(),
            AuthorizedSensitiveEffectKind::KubernetesNamespace
        );
        assert_eq!(authorization.capability_index(), 0);
        assert_eq!(authorization.dimensions().max_result_bytes, 2048);
        assert_eq!(authorization.dimensions().io_read_bytes, 2048);
        assert_eq!(authorization.dimensions().io_write_bytes, 4096);
    }
}
