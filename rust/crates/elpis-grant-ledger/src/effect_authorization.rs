//! Total deterministic composition of canonical policy, profile, and request proofs.
//!
//! This module mints pure containment evidence. It does not bind a live session, reserve a durable
//! budget, invoke a classifier, inspect external bytes, or perform an effect.

use elpis_grants::{
    CanonicalSensitiveEffectRequest, CanonicalSensitivePolicy, CanonicalSensitiveProfileRegistry,
    SensitiveCapabilityRule, SensitiveEffectV1, SensitiveProfileProofError,
    ValidatedSensitiveProfileSubsetProof,
};
use thiserror::Error;

use crate::effect_proof::{
    KubernetesEffectProofError, OperationalEffectProofError, PathArtifactEffectProofError,
    SensitiveEffectProofDimensions, prove_kubernetes_effect, prove_operational_effect,
    prove_path_artifact_effect,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizedSensitiveEffectKind {
    ReadPath,
    EditTree,
    ServiceAction,
    PackageOperation,
    KubernetesNamespace,
    RemoteExecProfile,
    NetworkEndpoint,
    ArtifactExport,
}

/// Non-cloneable proof that one canonical request is contained by one exact canonical policy and
/// its complete exact profile registry.
#[derive(Debug)]
pub struct DeterministicSensitiveEffectAuthorization {
    policy_profile_id: String,
    policy_sha256: String,
    registry_sha256: String,
    capability_kind: AuthorizedSensitiveEffectKind,
    capability_index: u32,
    request_sha256: String,
    profile_id: String,
    profile_sha256: String,
    dimensions: SensitiveEffectProofDimensions,
}

impl DeterministicSensitiveEffectAuthorization {
    pub fn policy_profile_id(&self) -> &str {
        &self.policy_profile_id
    }

    pub fn policy_sha256(&self) -> &str {
        &self.policy_sha256
    }

    pub fn registry_sha256(&self) -> &str {
        &self.registry_sha256
    }

    pub fn capability_kind(&self) -> AuthorizedSensitiveEffectKind {
        self.capability_kind
    }

    pub fn capability_index(&self) -> u32 {
        self.capability_index
    }

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
}

#[derive(Debug, Error)]
pub enum DeterministicSensitiveEffectAuthorizationError {
    #[error(transparent)]
    Profile(#[from] SensitiveProfileProofError),
    #[error("no signed capability exactly matches the request family and profile")]
    MissingCapability,
    #[error("more than one signed capability matches the request family and profile")]
    AmbiguousCapability,
    #[error("validated policy/profile binding invariant failed")]
    BindingInvariant,
    #[error(transparent)]
    PathArtifact(#[from] PathArtifactEffectProofError),
    #[error(transparent)]
    Operational(#[from] OperationalEffectProofError),
    #[error(transparent)]
    Kubernetes(#[from] KubernetesEffectProofError),
}

/// Composes exact policy/profile subset proof with the matching request-family proof.
pub fn authorize_sensitive_effect(
    policy: &CanonicalSensitivePolicy,
    registry: &CanonicalSensitiveProfileRegistry,
    request: &CanonicalSensitiveEffectRequest,
) -> Result<DeterministicSensitiveEffectAuthorization, DeterministicSensitiveEffectAuthorizationError>
{
    let subset = ValidatedSensitiveProfileSubsetProof::prove(policy.policy(), registry)?;
    let (request_kind, request_profile_id) = request_kind_and_profile_id(&request.request().effect);

    let mut matches = policy
        .policy()
        .capabilities
        .iter()
        .enumerate()
        .filter(|(_, capability)| {
            capability_kind(capability) == request_kind
                && capability_profile_id(capability) == request_profile_id
        });
    let (capability_index, capability) = matches
        .next()
        .ok_or(DeterministicSensitiveEffectAuthorizationError::MissingCapability)?;
    if matches.next().is_some() {
        return Err(DeterministicSensitiveEffectAuthorizationError::AmbiguousCapability);
    }
    let capability_index = u32::try_from(capability_index)
        .map_err(|_| DeterministicSensitiveEffectAuthorizationError::BindingInvariant)?;

    let binding = subset
        .bindings()
        .bindings()
        .iter()
        .find(|binding| binding.requirement.profile_ref.id == request_profile_id)
        .ok_or(DeterministicSensitiveEffectAuthorizationError::BindingInvariant)?;

    let (proof_request_sha256, proof_profile_id, proof_profile_sha256, dimensions) =
        match request_kind {
            AuthorizedSensitiveEffectKind::ReadPath
            | AuthorizedSensitiveEffectKind::EditTree
            | AuthorizedSensitiveEffectKind::ArtifactExport => {
                let proof = prove_path_artifact_effect(capability, &binding.profile, request)?;
                (
                    proof.request_sha256().to_owned(),
                    proof.profile_id().to_owned(),
                    proof.profile_sha256().to_owned(),
                    proof.dimensions(),
                )
            }
            AuthorizedSensitiveEffectKind::ServiceAction
            | AuthorizedSensitiveEffectKind::PackageOperation
            | AuthorizedSensitiveEffectKind::RemoteExecProfile
            | AuthorizedSensitiveEffectKind::NetworkEndpoint => {
                let proof = prove_operational_effect(capability, &binding.profile, request)?;
                (
                    proof.request_sha256().to_owned(),
                    proof.profile_id().to_owned(),
                    proof.profile_sha256().to_owned(),
                    proof.dimensions(),
                )
            }
            AuthorizedSensitiveEffectKind::KubernetesNamespace => {
                let proof = prove_kubernetes_effect(capability, &binding.profile, request)?;
                (
                    proof.request_sha256().to_owned(),
                    proof.profile_id().to_owned(),
                    proof.profile_sha256().to_owned(),
                    proof.dimensions(),
                )
            }
        };

    if proof_request_sha256 != request.request_sha256()
        || proof_profile_id != binding.requirement.profile_ref.id
        || proof_profile_sha256 != binding.requirement.profile_ref.sha256
    {
        return Err(DeterministicSensitiveEffectAuthorizationError::BindingInvariant);
    }

    Ok(DeterministicSensitiveEffectAuthorization {
        policy_profile_id: policy.policy().profile_id.clone(),
        policy_sha256: policy.policy_sha256().to_owned(),
        registry_sha256: registry.registry_sha256().to_owned(),
        capability_kind: request_kind,
        capability_index,
        request_sha256: proof_request_sha256,
        profile_id: proof_profile_id,
        profile_sha256: proof_profile_sha256,
        dimensions,
    })
}

#[cfg(test)]
pub(crate) fn test_canonical_inputs(
    capability: SensitiveCapabilityRule,
    profile: elpis_grants::SensitiveLocalProfileV1,
) -> (CanonicalSensitivePolicy, CanonicalSensitiveProfileRegistry) {
    use elpis_grants::{
        GuestPersistence, SENSITIVE_POLICY_VERSION, SENSITIVE_PROFILE_REGISTRY_VERSION,
        SensitiveBudgets, SensitiveClassifierPolicy, SensitivePersistencePolicy, SensitivePolicyV1,
        SensitiveProfileRegistryEntryV1, SensitiveProfileRegistryV1,
    };

    let (max_artifacts, max_total_artifact_bytes) = match &capability {
        SensitiveCapabilityRule::ArtifactExport {
            max_artifact_bytes, ..
        } => (1, *max_artifact_bytes),
        _ => (0, 0),
    };
    let policy = SensitivePolicyV1 {
        version: SENSITIVE_POLICY_VERSION,
        profile_id: "effect-authorization-test".into(),
        capabilities: vec![capability],
        budgets: SensitiveBudgets {
            max_runs: 1,
            max_effects: 8,
            max_lease_s: 60,
            max_wall_ms: 60_000,
            max_cpu_ms: 60_000,
            max_rss_bytes: 1 << 30,
            max_io_read_bytes: 1 << 40,
            max_io_write_bytes: 1 << 40,
            max_scratch_bytes: 1 << 30,
        },
        classifier: SensitiveClassifierPolicy::Disabled,
        persistence: SensitivePersistencePolicy {
            guest_persistence: GuestPersistence::Disabled,
            max_artifacts,
            max_total_artifact_bytes,
        },
    };
    let policy_bytes = policy.canonical_bytes().unwrap();
    let policy = CanonicalSensitivePolicy::parse(&policy_bytes).unwrap();

    let registry = SensitiveProfileRegistryV1 {
        version: SENSITIVE_PROFILE_REGISTRY_VERSION,
        profiles: vec![SensitiveProfileRegistryEntryV1::from_profile(profile).unwrap()],
    };
    let registry_bytes = registry.canonical_bytes().unwrap();
    let registry = CanonicalSensitiveProfileRegistry::parse(&registry_bytes).unwrap();
    (policy, registry)
}

fn capability_kind(capability: &SensitiveCapabilityRule) -> AuthorizedSensitiveEffectKind {
    match capability {
        SensitiveCapabilityRule::ReadPath { .. } => AuthorizedSensitiveEffectKind::ReadPath,
        SensitiveCapabilityRule::EditTree { .. } => AuthorizedSensitiveEffectKind::EditTree,
        SensitiveCapabilityRule::ServiceAction { .. } => {
            AuthorizedSensitiveEffectKind::ServiceAction
        }
        SensitiveCapabilityRule::PackageOperation { .. } => {
            AuthorizedSensitiveEffectKind::PackageOperation
        }
        SensitiveCapabilityRule::KubernetesNamespace { .. } => {
            AuthorizedSensitiveEffectKind::KubernetesNamespace
        }
        SensitiveCapabilityRule::RemoteExecProfile { .. } => {
            AuthorizedSensitiveEffectKind::RemoteExecProfile
        }
        SensitiveCapabilityRule::NetworkEndpoint { .. } => {
            AuthorizedSensitiveEffectKind::NetworkEndpoint
        }
        SensitiveCapabilityRule::ArtifactExport { .. } => {
            AuthorizedSensitiveEffectKind::ArtifactExport
        }
    }
}

fn capability_profile_id(capability: &SensitiveCapabilityRule) -> &str {
    match capability {
        SensitiveCapabilityRule::ReadPath { root, .. } => &root.id,
        SensitiveCapabilityRule::EditTree { tree, .. } => &tree.id,
        SensitiveCapabilityRule::ServiceAction { profile, .. }
        | SensitiveCapabilityRule::PackageOperation { profile, .. }
        | SensitiveCapabilityRule::RemoteExecProfile { profile, .. } => &profile.id,
        SensitiveCapabilityRule::KubernetesNamespace {
            cluster_profile, ..
        } => &cluster_profile.id,
        SensitiveCapabilityRule::NetworkEndpoint {
            endpoint_profile, ..
        } => &endpoint_profile.id,
        SensitiveCapabilityRule::ArtifactExport {
            destination_profile,
            ..
        } => &destination_profile.id,
    }
}

fn request_kind_and_profile_id(
    effect: &SensitiveEffectV1,
) -> (AuthorizedSensitiveEffectKind, &str) {
    match effect {
        SensitiveEffectV1::ReadPath {
            root_profile_id, ..
        } => (AuthorizedSensitiveEffectKind::ReadPath, root_profile_id),
        SensitiveEffectV1::EditTree {
            tree_profile_id, ..
        } => (AuthorizedSensitiveEffectKind::EditTree, tree_profile_id),
        SensitiveEffectV1::ServiceAction {
            service_profile_id, ..
        } => (
            AuthorizedSensitiveEffectKind::ServiceAction,
            service_profile_id,
        ),
        SensitiveEffectV1::PackageOperation {
            package_profile_id, ..
        } => (
            AuthorizedSensitiveEffectKind::PackageOperation,
            package_profile_id,
        ),
        SensitiveEffectV1::KubernetesNamespace {
            cluster_profile_id, ..
        } => (
            AuthorizedSensitiveEffectKind::KubernetesNamespace,
            cluster_profile_id,
        ),
        SensitiveEffectV1::RemoteExecProfile {
            remote_profile_id, ..
        } => (
            AuthorizedSensitiveEffectKind::RemoteExecProfile,
            remote_profile_id,
        ),
        SensitiveEffectV1::NetworkEndpoint {
            endpoint_profile_id,
            ..
        } => (
            AuthorizedSensitiveEffectKind::NetworkEndpoint,
            endpoint_profile_id,
        ),
        SensitiveEffectV1::ArtifactExport {
            destination_profile_id,
            ..
        } => (
            AuthorizedSensitiveEffectKind::ArtifactExport,
            destination_profile_id,
        ),
    }
}
