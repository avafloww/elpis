//! Canonical custody for exact local sensitive-profile bytes.
//!
//! This module does not derive requirements from policy, evaluate a capability, or prove
//! confinement. It only validates and indexes inert profile artifacts.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    KubernetesQueryRule, KubernetesVerb, SensitiveCapabilityRule, SensitiveLocalProfileKindV1,
    SensitiveLocalProfileV1, SensitivePolicyV1, SensitiveProfileRef, sha256_hex,
};

pub const SENSITIVE_PROFILE_REGISTRY_VERSION: u32 = 1;
pub const MAX_SENSITIVE_PROFILE_REGISTRY_BYTES: usize = 1024 * 1024;
pub const MAX_SENSITIVE_PROFILE_REGISTRY_ENTRIES: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveLocalProfileKind {
    ArtifactCustody,
    EditableTree,
    FilesystemRoot,
    KubernetesCluster,
    KubernetesObjectTemplates,
    NetworkEndpoint,
    PackageTransaction,
    RemoteActions,
    ServiceManager,
}

impl SensitiveLocalProfileKindV1 {
    pub(crate) fn registry_kind(&self) -> SensitiveLocalProfileKind {
        match self {
            Self::ArtifactCustody { .. } => SensitiveLocalProfileKind::ArtifactCustody,
            Self::EditableTree { .. } => SensitiveLocalProfileKind::EditableTree,
            Self::FilesystemRoot { .. } => SensitiveLocalProfileKind::FilesystemRoot,
            Self::KubernetesCluster { .. } => SensitiveLocalProfileKind::KubernetesCluster,
            Self::KubernetesObjectTemplates { .. } => {
                SensitiveLocalProfileKind::KubernetesObjectTemplates
            }
            Self::NetworkEndpoint { .. } => SensitiveLocalProfileKind::NetworkEndpoint,
            Self::PackageTransaction { .. } => SensitiveLocalProfileKind::PackageTransaction,
            Self::RemoteActions { .. } => SensitiveLocalProfileKind::RemoteActions,
            Self::ServiceManager { .. } => SensitiveLocalProfileKind::ServiceManager,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitiveProfileRegistryEntryV1 {
    pub kind: SensitiveLocalProfileKind,
    pub profile_sha256: String,
    pub profile: SensitiveLocalProfileV1,
}

impl SensitiveProfileRegistryEntryV1 {
    pub fn from_profile(
        profile: SensitiveLocalProfileV1,
    ) -> Result<Self, SensitiveProfileRegistryError> {
        let bytes = profile
            .canonical_bytes()
            .map_err(|_| SensitiveProfileRegistryError::InvalidProfile)?;
        Ok(Self {
            kind: profile.profile.registry_kind(),
            profile_sha256: sha256_hex(&bytes),
            profile,
        })
    }

    fn validate(&self) -> Result<(), SensitiveProfileRegistryError> {
        let bytes = self
            .profile
            .canonical_bytes()
            .map_err(|_| SensitiveProfileRegistryError::InvalidProfile)?;
        if self.kind != self.profile.profile.registry_kind() {
            return Err(SensitiveProfileRegistryError::KindMismatch);
        }
        if self.profile_sha256 != sha256_hex(&bytes) {
            return Err(SensitiveProfileRegistryError::HashMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitiveProfileRegistryV1 {
    pub version: u32,
    pub profiles: Vec<SensitiveProfileRegistryEntryV1>,
}

impl SensitiveProfileRegistryV1 {
    pub fn validate(&self) -> Result<(), SensitiveProfileRegistryError> {
        if self.version != SENSITIVE_PROFILE_REGISTRY_VERSION {
            return Err(SensitiveProfileRegistryError::Version);
        }
        if self.profiles.is_empty() {
            return Err(SensitiveProfileRegistryError::Empty);
        }
        if self.profiles.len() > MAX_SENSITIVE_PROFILE_REGISTRY_ENTRIES {
            return Err(SensitiveProfileRegistryError::TooManyProfiles);
        }
        for entry in &self.profiles {
            entry.validate()?;
        }
        for pair in self.profiles.windows(2) {
            if pair[0].profile.id == pair[1].profile.id {
                return Err(SensitiveProfileRegistryError::DuplicateProfileId);
            }
            let left = (&pair[0].profile.id, pair[0].kind);
            let right = (&pair[1].profile.id, pair[1].kind);
            if left >= right {
                return Err(SensitiveProfileRegistryError::NonCanonicalList);
            }
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, SensitiveProfileRegistryError> {
        self.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| SensitiveProfileRegistryError::InvalidEncoding)?;
        if bytes.len() > MAX_SENSITIVE_PROFILE_REGISTRY_BYTES {
            return Err(SensitiveProfileRegistryError::PayloadTooLarge);
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalSensitiveProfileRegistry {
    registry: SensitiveProfileRegistryV1,
    registry_sha256: String,
}

impl CanonicalSensitiveProfileRegistry {
    pub fn parse(bytes: &[u8]) -> Result<Self, SensitiveProfileRegistryError> {
        if bytes.is_empty() || bytes.len() > MAX_SENSITIVE_PROFILE_REGISTRY_BYTES {
            return Err(SensitiveProfileRegistryError::PayloadTooLarge);
        }
        let registry: SensitiveProfileRegistryV1 = serde_json::from_slice(bytes)
            .map_err(|_| SensitiveProfileRegistryError::InvalidEncoding)?;
        let canonical = registry.canonical_bytes()?;
        if canonical != bytes {
            return Err(SensitiveProfileRegistryError::NonCanonical);
        }
        Ok(Self {
            registry,
            registry_sha256: sha256_hex(bytes),
        })
    }

    pub fn registry(&self) -> &SensitiveProfileRegistryV1 {
        &self.registry
    }

    pub fn registry_sha256(&self) -> &str {
        &self.registry_sha256
    }

    pub fn lookup_exact(
        &self,
        profile_ref: &SensitiveProfileRef,
        expected_kind: SensitiveLocalProfileKind,
    ) -> Result<&SensitiveLocalProfileV1, SensitiveProfileRegistryError> {
        let entry = self
            .registry
            .profiles
            .binary_search_by(|entry| entry.profile.id.as_str().cmp(profile_ref.id.as_str()))
            .ok()
            .and_then(|index| self.registry.profiles.get(index))
            .ok_or(SensitiveProfileRegistryError::MissingProfile)?;
        if entry.profile_sha256 != profile_ref.sha256 {
            return Err(SensitiveProfileRegistryError::HashMismatch);
        }
        if entry.kind != expected_kind {
            return Err(SensitiveProfileRegistryError::KindMismatch);
        }
        Ok(&entry.profile)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SensitiveProfileRequirement {
    pub profile_ref: SensitiveProfileRef,
    pub expected_kind: SensitiveLocalProfileKind,
}

impl SensitiveProfileRequirement {
    fn from_capability(capability: &SensitiveCapabilityRule) -> Self {
        let (profile_ref, expected_kind) = match capability {
            SensitiveCapabilityRule::ReadPath { root, .. } => {
                (root, SensitiveLocalProfileKind::FilesystemRoot)
            }
            SensitiveCapabilityRule::EditTree { tree, .. } => {
                (tree, SensitiveLocalProfileKind::EditableTree)
            }
            SensitiveCapabilityRule::ServiceAction { profile, .. } => {
                (profile, SensitiveLocalProfileKind::ServiceManager)
            }
            SensitiveCapabilityRule::PackageOperation { profile, .. } => {
                (profile, SensitiveLocalProfileKind::PackageTransaction)
            }
            SensitiveCapabilityRule::KubernetesNamespace {
                cluster_profile, ..
            } => (
                cluster_profile,
                SensitiveLocalProfileKind::KubernetesCluster,
            ),
            SensitiveCapabilityRule::RemoteExecProfile { profile, .. } => {
                (profile, SensitiveLocalProfileKind::RemoteActions)
            }
            SensitiveCapabilityRule::NetworkEndpoint {
                endpoint_profile, ..
            } => (endpoint_profile, SensitiveLocalProfileKind::NetworkEndpoint),
            SensitiveCapabilityRule::ArtifactExport {
                destination_profile,
                ..
            } => (
                destination_profile,
                SensitiveLocalProfileKind::ArtifactCustody,
            ),
        };
        Self {
            profile_ref: profile_ref.clone(),
            expected_kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedSensitiveProfileBinding {
    pub requirement: SensitiveProfileRequirement,
    pub profile: SensitiveLocalProfileV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedSensitiveProfileBindings {
    bindings: Vec<ValidatedSensitiveProfileBinding>,
}

impl ValidatedSensitiveProfileBindings {
    pub fn bind_exact(
        policy: &SensitivePolicyV1,
        registry: &CanonicalSensitiveProfileRegistry,
    ) -> Result<Self, SensitiveProfileBindingError> {
        policy
            .validate()
            .map_err(|_| SensitiveProfileBindingError::InvalidPolicy)?;
        let mut requirements: Vec<_> = policy
            .capabilities
            .iter()
            .map(SensitiveProfileRequirement::from_capability)
            .collect();
        requirements.sort_by(|left, right| left.profile_ref.id.cmp(&right.profile_ref.id));
        if requirements
            .windows(2)
            .any(|pair| pair[0].profile_ref.id == pair[1].profile_ref.id)
        {
            return Err(SensitiveProfileBindingError::DuplicateRequirementId);
        }
        let entries = &registry.registry().profiles;
        if entries.len() < requirements.len() {
            return Err(SensitiveProfileBindingError::MissingProfile);
        }
        if entries.len() > requirements.len() {
            return Err(SensitiveProfileBindingError::ExtraProfile);
        }
        let mut bindings = Vec::with_capacity(requirements.len());
        for (requirement, entry) in requirements.into_iter().zip(entries) {
            if entry.profile.id != requirement.profile_ref.id {
                return Err(SensitiveProfileBindingError::MissingProfile);
            }
            let profile = registry
                .lookup_exact(&requirement.profile_ref, requirement.expected_kind)
                .map_err(|error| match error {
                    SensitiveProfileRegistryError::HashMismatch => {
                        SensitiveProfileBindingError::HashMismatch
                    }
                    SensitiveProfileRegistryError::KindMismatch => {
                        SensitiveProfileBindingError::KindMismatch
                    }
                    _ => SensitiveProfileBindingError::MissingProfile,
                })?;
            bindings.push(ValidatedSensitiveProfileBinding {
                requirement,
                profile: profile.clone(),
            });
        }
        Ok(Self { bindings })
    }

    pub fn bindings(&self) -> &[ValidatedSensitiveProfileBinding] {
        &self.bindings
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedSensitiveProfileSubsetProof {
    policy: SensitivePolicyV1,
    bindings: ValidatedSensitiveProfileBindings,
}

impl ValidatedSensitiveProfileSubsetProof {
    /// Binds every signed profile reference exactly, then proves all representable signed
    /// constraints are contained by the matched immutable local profiles.
    pub fn prove(
        policy: &SensitivePolicyV1,
        registry: &CanonicalSensitiveProfileRegistry,
    ) -> Result<Self, SensitiveProfileProofError> {
        let bindings = ValidatedSensitiveProfileBindings::bind_exact(policy, registry)?;
        for capability in &policy.capabilities {
            let requirement = SensitiveProfileRequirement::from_capability(capability);
            let binding = bindings
                .bindings()
                .iter()
                .find(|binding| binding.requirement.profile_ref.id == requirement.profile_ref.id)
                .ok_or(SensitiveProfileProofError::BindingInvariant)?;
            let result = match capability {
                SensitiveCapabilityRule::ReadPath { .. }
                | SensitiveCapabilityRule::EditTree { .. }
                | SensitiveCapabilityRule::ArtifactExport { .. } => {
                    prove_path_artifact_profile_subset(capability, &binding.profile)
                }
                SensitiveCapabilityRule::KubernetesNamespace { .. } => {
                    prove_kubernetes_profile_subset(capability, &binding.profile)
                }
                SensitiveCapabilityRule::ServiceAction { .. }
                | SensitiveCapabilityRule::PackageOperation { .. }
                | SensitiveCapabilityRule::RemoteExecProfile { .. }
                | SensitiveCapabilityRule::NetworkEndpoint { .. } => {
                    prove_finite_profile_subset(capability, &binding.profile)
                }
            };
            result?;
        }
        Ok(Self {
            policy: policy.clone(),
            bindings,
        })
    }

    pub fn policy(&self) -> &SensitivePolicyV1 {
        &self.policy
    }

    pub fn bindings(&self) -> &ValidatedSensitiveProfileBindings {
        &self.bindings
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveProfileProofError {
    #[error(transparent)]
    Binding(#[from] SensitiveProfileBindingError),
    #[error(transparent)]
    Subset(#[from] SensitiveProfileSubsetError),
    #[error("validated profile binding invariant failed")]
    BindingInvariant,
}

/// Proves signed relative-prefix and artifact-size bounds against one exact local profile.
///
/// This validates profile containment only; it does not resolve paths, inspect files, or prevent
/// time-of-check/time-of-use races.
pub fn prove_path_artifact_profile_subset(
    capability: &SensitiveCapabilityRule,
    profile: &SensitiveLocalProfileV1,
) -> Result<(), SensitiveProfileSubsetError> {
    let prefixes_fit =
        |prefixes: &[String], max_depth: u32, max_relative: u32, max_component: u32| {
            prefixes.iter().all(|prefix| {
                let components: Vec<_> = prefix.split('/').collect();
                !prefix.is_empty()
                    && !prefix.starts_with('/')
                    && !prefix.ends_with('/')
                    && prefix.len() <= max_relative as usize
                    && components.len() <= max_depth as usize
                    && components.iter().all(|component| {
                        !component.is_empty()
                            && *component != "."
                            && *component != ".."
                            && component.len() <= max_component as usize
                    })
            })
        };
    match (capability, &profile.profile) {
        (
            SensitiveCapabilityRule::ReadPath {
                relative_prefixes, ..
            },
            SensitiveLocalProfileKindV1::FilesystemRoot {
                max_depth,
                max_relative_path_bytes,
                max_component_bytes,
                ..
            },
        ) => {
            if prefixes_fit(
                relative_prefixes,
                *max_depth,
                *max_relative_path_bytes,
                *max_component_bytes,
            ) {
                Ok(())
            } else {
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            }
        }
        (
            SensitiveCapabilityRule::EditTree {
                relative_prefixes,
                max_files,
                ..
            },
            SensitiveLocalProfileKindV1::EditableTree {
                max_depth,
                max_relative_path_bytes,
                max_component_bytes,
                max_entries,
                ..
            },
        ) => {
            if *max_files <= *max_entries
                && prefixes_fit(
                    relative_prefixes,
                    *max_depth,
                    *max_relative_path_bytes,
                    *max_component_bytes,
                )
            {
                Ok(())
            } else {
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            }
        }
        (
            SensitiveCapabilityRule::ArtifactExport {
                max_artifact_bytes, ..
            },
            SensitiveLocalProfileKindV1::ArtifactCustody {
                max_single_file_bytes,
                max_total_bytes,
                ..
            },
        ) => {
            if max_artifact_bytes <= max_single_file_bytes && max_artifact_bytes <= max_total_bytes
            {
                Ok(())
            } else {
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            }
        }
        (
            SensitiveCapabilityRule::ReadPath { .. }
            | SensitiveCapabilityRule::EditTree { .. }
            | SensitiveCapabilityRule::ArtifactExport { .. },
            _,
        ) => Err(SensitiveProfileSubsetError::ProfileKindMismatch),
        _ => Err(SensitiveProfileSubsetError::UnsupportedCapabilityFamily),
    }
}

/// Proves namespace equality and full signed verb-by-resource query coverage.
///
/// Create, patch, and update are unrepresentable in a cluster query profile and fail closed.
pub fn prove_kubernetes_profile_subset(
    capability: &SensitiveCapabilityRule,
    profile: &SensitiveLocalProfileV1,
) -> Result<(), SensitiveProfileSubsetError> {
    match (capability, &profile.profile) {
        (
            SensitiveCapabilityRule::KubernetesNamespace {
                namespace,
                verbs,
                resources,
                ..
            },
            SensitiveLocalProfileKindV1::KubernetesCluster {
                namespace: profile_namespace,
                rules,
                ..
            },
        ) => {
            if namespace != profile_namespace {
                return Err(SensitiveProfileSubsetError::ConstraintNotContained);
            }
            for verb in verbs {
                if matches!(
                    verb,
                    KubernetesVerb::Create | KubernetesVerb::Patch | KubernetesVerb::Update
                ) {
                    return Err(SensitiveProfileSubsetError::ConstraintNotContained);
                }
                for resource in resources {
                    let covered = rules.iter().any(|rule| match (verb, rule) {
                        (
                            KubernetesVerb::Delete,
                            KubernetesQueryRule::Delete {
                                resource: profile_resource,
                                ..
                            },
                        )
                        | (
                            KubernetesVerb::Get,
                            KubernetesQueryRule::Get {
                                resource: profile_resource,
                                ..
                            },
                        )
                        | (
                            KubernetesVerb::List,
                            KubernetesQueryRule::List {
                                resource: profile_resource,
                                ..
                            },
                        )
                        | (
                            KubernetesVerb::Watch,
                            KubernetesQueryRule::Watch {
                                resource: profile_resource,
                                ..
                            },
                        ) => resource == profile_resource,
                        _ => false,
                    });
                    if !covered {
                        return Err(SensitiveProfileSubsetError::ConstraintNotContained);
                    }
                }
            }
            Ok(())
        }
        (SensitiveCapabilityRule::KubernetesNamespace { .. }, _) => {
            Err(SensitiveProfileSubsetError::ProfileKindMismatch)
        }
        _ => Err(SensitiveProfileSubsetError::UnsupportedCapabilityFamily),
    }
}

/// Proves static membership of signed finite constraints in one exact local profile.
///
/// This does not evaluate a runtime effect or prove a unit/action, route/body, or process tuple.
pub fn prove_finite_profile_subset(
    capability: &SensitiveCapabilityRule,
    profile: &SensitiveLocalProfileV1,
) -> Result<(), SensitiveProfileSubsetError> {
    match (capability, &profile.profile) {
        (
            SensitiveCapabilityRule::ServiceAction { actions, .. },
            SensitiveLocalProfileKindV1::ServiceManager { units, .. },
        ) => {
            if actions
                .iter()
                .all(|action| units.iter().any(|unit| unit.actions.contains(action)))
            {
                Ok(())
            } else {
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            }
        }
        (
            SensitiveCapabilityRule::PackageOperation {
                operations,
                packages,
                ..
            },
            SensitiveLocalProfileKindV1::PackageTransaction {
                operations: profile_operations,
                packages: profile_packages,
                ..
            },
        ) => {
            if operations
                .iter()
                .all(|operation| profile_operations.contains(operation))
                && packages.iter().all(|package| {
                    profile_packages
                        .iter()
                        .any(|selection| selection.name == *package)
                })
            {
                Ok(())
            } else {
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            }
        }
        (
            SensitiveCapabilityRule::RemoteExecProfile { actions, .. },
            SensitiveLocalProfileKindV1::RemoteActions {
                actions: profile_actions,
            },
        ) => {
            if actions.iter().all(|action| {
                profile_actions
                    .iter()
                    .any(|profile_action| profile_action.id == *action)
            }) {
                Ok(())
            } else {
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            }
        }
        (
            SensitiveCapabilityRule::NetworkEndpoint { methods, .. },
            SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. },
        ) => {
            if methods
                .iter()
                .all(|method| routes.iter().any(|route| route.method == *method))
            {
                Ok(())
            } else {
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            }
        }
        (
            SensitiveCapabilityRule::ServiceAction { .. }
            | SensitiveCapabilityRule::PackageOperation { .. }
            | SensitiveCapabilityRule::RemoteExecProfile { .. }
            | SensitiveCapabilityRule::NetworkEndpoint { .. },
            _,
        ) => Err(SensitiveProfileSubsetError::ProfileKindMismatch),
        _ => Err(SensitiveProfileSubsetError::UnsupportedCapabilityFamily),
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveProfileSubsetError {
    #[error("signed capability does not match the local profile kind")]
    ProfileKindMismatch,
    #[error("signed capability constraint is not contained by the local profile")]
    ConstraintNotContained,
    #[error("signed capability belongs to another subset proof family")]
    UnsupportedCapabilityFamily,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveProfileBindingError {
    #[error("sensitive policy is invalid")]
    InvalidPolicy,
    #[error("sensitive policy reuses one profile id across capabilities")]
    DuplicateRequirementId,
    #[error("required sensitive profile is missing")]
    MissingProfile,
    #[error("sensitive profile registry contains an unrequested profile")]
    ExtraProfile,
    #[error("sensitive profile hash does not match signed policy")]
    HashMismatch,
    #[error("sensitive profile kind does not match signed capability")]
    KindMismatch,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveProfileRegistryError {
    #[error("unsupported sensitive profile registry version")]
    Version,
    #[error("sensitive profile registry must not be empty")]
    Empty,
    #[error("sensitive profile registry has too many profiles")]
    TooManyProfiles,
    #[error("sensitive profile registry contains an invalid profile")]
    InvalidProfile,
    #[error("sensitive profile registry contains a duplicate profile id")]
    DuplicateProfileId,
    #[error("sensitive profile registry list is not canonical")]
    NonCanonicalList,
    #[error("sensitive profile registry kind does not match profile bytes")]
    KindMismatch,
    #[error("sensitive profile registry hash does not match profile bytes")]
    HashMismatch,
    #[error("required sensitive profile is missing")]
    MissingProfile,
    #[error("sensitive profile registry encoding is invalid")]
    InvalidEncoding,
    #[error("sensitive profile registry encoding is not canonical")]
    NonCanonical,
    #[error("sensitive profile registry payload is too large")]
    PayloadTooLarge,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVICE_JSON: &str = r#"{"version":1,"id":"resident-services","profile":{"kind":"service_manager","manager":"systemd_dbus","scope":{"mode":"system"},"unit_resolution":"exact_canonical_name_no_alias","units":[{"unit":"elpis-harness.service","actions":["restart","status"]},{"unit":"nginx.service","actions":["reload","restart","status"]}]}}"#;
    const REMOTE_JSON: &str = r#"{"version":1,"id":"resident-actions","profile":{"kind":"remote_actions","actions":[{"id":"check-state","execution":"direct_native_elf_no_shell_or_interpreter","executable_path":"/usr/libexec/elpis/check-state","executable_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","argv":["/usr/libexec/elpis/check-state","--format","json"],"environment":{"mode":"clear_then_set_fixed","locale":"C.UTF-8","timezone":"UTC"},"cwd_profile":{"id":"work-root","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"uid":10001,"gid":10001,"capabilities":[],"stdin":"closed","no_new_privileges":"required","timeout_ms":30000,"max_stdout_bytes":65536,"max_stderr_bytes":65536,"max_io_read_bytes":8388608,"max_io_write_bytes":4194304}]}}"#;
    const NETWORK_JSON: &str = r#"{"version":1,"id":"package-index-endpoint","profile":{"kind":"network_endpoint","origin":{"protocol":"https","host":"api.example.test","port":443},"address_policy":{"mode":"direct_connect_only_pinned_no_proxy","addresses":["198.51.100.10","2001:db8::10"]},"tls":{"server_name":"api.example.test","minimum_version":"tls13","verification":"pinned_ca_and_leaf_spki_with_hostname_and_validity","ca_certificate_sha256":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"leaf_spki_sha256":["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]},"routes":[{"path_prefix":"/v1/artifacts","method":"get","query":"forbidden","request_body":{"mode":"forbidden"},"response_content_types":["application/octet-stream"]},{"path_prefix":"/v1/artifacts","method":"post","query":"forbidden","request_body":{"mode":"allowed","content_types":["application/json"]},"response_content_types":["application/json"]},{"path_prefix":"/v1/status","method":"get","query":"forbidden","request_body":{"mode":"forbidden"},"response_content_types":["application/json"]}],"request_headers":"generated_host_and_allowed_content_type_only","response_encoding":"identity_only","redirects":"deny","max_request_bytes":65536,"max_response_bytes":1048576}}"#;
    const PACKAGE_JSON: &str = r#"{"version":1,"id":"debian-tools","profile":{"kind":"package_transaction","manager":"debian_apt_dpkg_offline","target_root":{"id":"debian-root","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"repository_endpoint":{"id":"debian-snapshot","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"repository_snapshot":{"metadata_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","signing_key_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"operations":["install","upgrade"],"packages":[{"name":"curl","version":"7.88.1-10+deb12u12","architecture":"amd64","archive_sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},{"name":"jq","version":"1.6-2.1+deb12u1","architecture":"amd64","archive_sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}],"dependencies":"exact_listed_packages_only","maintainer_scripts":"forbidden","configuration":"fail_on_prompt_or_conffile_change","max_io_read_bytes":1073741824,"max_io_write_bytes":2147483648}}"#;
    const KUBERNETES_JSON: &str = r#"{"version":1,"id":"cluster-query","profile":{"kind":"kubernetes_cluster","api_server":{"host":"api.cluster.example","port":6443,"tls_server_name":"api.cluster.example","ca_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","redirects":"deny"},"credential_profile":{"id":"cluster-credential","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"namespace":"elpis-workers","rules":[{"verb":"delete","resource":"config_map","names":["worker-lock"],"precondition":"exact_uid_and_resource_version"},{"verb":"get","resource":"pod","names":["worker-a","worker-b"]},{"verb":"list","resource":"pod","selectors":[{"key":"app.kubernetes.io/name","value":"elpis-worker"},{"key":"elpis.dev/mind","value":"elm-34v9m41b"}]},{"verb":"watch","resource":"service","selectors":[{"key":"app","value":"elpis"}]}],"max_request_bytes":65536,"max_response_bytes":1048576}}"#;
    const READ_JSON: &str = r#"{"version":1,"id":"project-read","profile":{"kind":"filesystem_root","root":{"canonical_root":"/srv/elpis/project","expected_mount_id":11,"expected_device":22,"expected_inode":33,"expected_owner_uid":1000,"expected_owner_gid":1000,"expected_permissions":488,"entry_ownership":"root_owner_only","entry_writes":"owner_only","symlinks":"deny","hard_links":"deny_multiple_links","mount_crossing":"deny","special_files":"regular_files_and_directories_only"},"max_depth":16,"max_relative_path_bytes":512,"max_component_bytes":120,"max_entries":10000}}"#;
    const EDIT_JSON: &str = r#"{"version":1,"id":"project-edit","profile":{"kind":"editable_tree","root":{"canonical_root":"/srv/elpis/project","expected_mount_id":11,"expected_device":22,"expected_inode":33,"expected_owner_uid":1000,"expected_owner_gid":1000,"expected_permissions":488,"entry_ownership":"root_owner_only","entry_writes":"owner_only","symlinks":"deny","hard_links":"deny_multiple_links","mount_crossing":"deny","special_files":"regular_files_and_directories_only"},"max_depth":16,"max_relative_path_bytes":512,"max_component_bytes":120,"max_entries":10000,"operations":["create_file","replace_file"],"create_policy":"exclusive","replace_policy":"exact_identity_and_sha256","delete_policy":"exact_identity_and_sha256","commit_policy":"fsync_file_rename_fsync_directory","created_file_mode":384,"created_directory_mode":448}}"#;
    const ARTIFACT_JSON: &str = r#"{"version":1,"id":"review-artifacts","profile":{"kind":"artifact_custody","root":{"canonical_root":"/srv/elpis/project","expected_mount_id":11,"expected_device":22,"expected_inode":33,"expected_owner_uid":1000,"expected_owner_gid":1000,"expected_permissions":448,"entry_ownership":"root_owner_only","entry_writes":"owner_only","symlinks":"deny","hard_links":"deny_multiple_links","mount_crossing":"deny","special_files":"regular_files_and_directories_only"},"write_mode":"create_only","name_policy":"opaque_uuid","created_file_mode":384,"max_files":4,"max_single_file_bytes":1024,"max_total_bytes":4096}}"#;

    fn service_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(SERVICE_JSON).unwrap()
    }

    fn remote_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(REMOTE_JSON).unwrap()
    }

    fn network_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(NETWORK_JSON).unwrap()
    }

    fn package_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(PACKAGE_JSON).unwrap()
    }

    fn kubernetes_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(KUBERNETES_JSON).unwrap()
    }

    fn read_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(READ_JSON).unwrap()
    }

    fn edit_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(EDIT_JSON).unwrap()
    }

    fn artifact_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(ARTIFACT_JSON).unwrap()
    }

    fn registry() -> SensitiveProfileRegistryV1 {
        SensitiveProfileRegistryV1 {
            version: SENSITIVE_PROFILE_REGISTRY_VERSION,
            profiles: vec![
                SensitiveProfileRegistryEntryV1::from_profile(remote_profile()).unwrap(),
                SensitiveProfileRegistryEntryV1::from_profile(service_profile()).unwrap(),
            ],
        }
    }

    #[test]
    fn multi_kind_registry_canonical_bytes_and_hash_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"profiles":[{"kind":"remote_actions","profile_sha256":"38a372a64ace0b1df1589f2f57752a180f0431c6a6f16861369bf1c6f4b6a0d5","profile":{"version":1,"id":"resident-actions","profile":{"kind":"remote_actions","actions":[{"id":"check-state","execution":"direct_native_elf_no_shell_or_interpreter","executable_path":"/usr/libexec/elpis/check-state","executable_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","argv":["/usr/libexec/elpis/check-state","--format","json"],"environment":{"mode":"clear_then_set_fixed","locale":"C.UTF-8","timezone":"UTC"},"cwd_profile":{"id":"work-root","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"uid":10001,"gid":10001,"capabilities":[],"stdin":"closed","no_new_privileges":"required","timeout_ms":30000,"max_stdout_bytes":65536,"max_stderr_bytes":65536,"max_io_read_bytes":8388608,"max_io_write_bytes":4194304}]}}},{"kind":"service_manager","profile_sha256":"2e63e14a85c5a09b324e494ccd23af19c967c3702e4b3407b07f5086ebb625fe","profile":{"version":1,"id":"resident-services","profile":{"kind":"service_manager","manager":"systemd_dbus","scope":{"mode":"system"},"unit_resolution":"exact_canonical_name_no_alias","units":[{"unit":"elpis-harness.service","actions":["restart","status"]},{"unit":"nginx.service","actions":["reload","restart","status"]}]}}}]}"#;
        const GOLDEN_SHA256: &str =
            "09aeb3177482446c46486eb5ddc2861078f2d60ffb77a12799127105c85f6a3f";

        let bytes = registry().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveProfileRegistry::parse(&bytes).unwrap();
        assert_eq!(parsed.registry(), &registry());
        assert_eq!(parsed.registry_sha256(), GOLDEN_SHA256);
        assert_eq!(sha256_hex(&bytes), GOLDEN_SHA256);
    }

    #[test]
    fn registry_rejects_empty_oversized_reordered_and_duplicate_ids_across_kinds() {
        let empty = SensitiveProfileRegistryV1 {
            version: SENSITIVE_PROFILE_REGISTRY_VERSION,
            profiles: vec![],
        };
        assert_eq!(empty.validate(), Err(SensitiveProfileRegistryError::Empty));

        let mut oversized = registry();
        oversized.profiles = (0..=MAX_SENSITIVE_PROFILE_REGISTRY_ENTRIES)
            .map(|index| {
                let mut profile = service_profile();
                profile.id = format!("profile-{index:02}");
                SensitiveProfileRegistryEntryV1::from_profile(profile).unwrap()
            })
            .collect();
        assert_eq!(
            oversized.validate(),
            Err(SensitiveProfileRegistryError::TooManyProfiles)
        );

        let mut reordered = registry();
        reordered.profiles.reverse();
        assert_eq!(
            reordered.validate(),
            Err(SensitiveProfileRegistryError::NonCanonicalList)
        );

        let mut duplicate = service_profile();
        duplicate.id = "resident-actions".into();
        let duplicate = SensitiveProfileRegistryV1 {
            version: SENSITIVE_PROFILE_REGISTRY_VERSION,
            profiles: vec![
                SensitiveProfileRegistryEntryV1::from_profile(remote_profile()).unwrap(),
                SensitiveProfileRegistryEntryV1::from_profile(duplicate).unwrap(),
            ],
        };
        assert_eq!(
            duplicate.validate(),
            Err(SensitiveProfileRegistryError::DuplicateProfileId)
        );
    }

    #[test]
    fn registry_rejects_nested_profile_hash_and_kind_substitution() {
        let mut invalid = registry();
        invalid.profiles[0].profile.version = 2;
        assert_eq!(
            invalid.validate(),
            Err(SensitiveProfileRegistryError::InvalidProfile)
        );

        let mut hash = registry();
        hash.profiles[0].profile_sha256 = "0".repeat(64);
        assert_eq!(
            hash.validate(),
            Err(SensitiveProfileRegistryError::HashMismatch)
        );

        let mut kind = registry();
        kind.profiles[0].kind = SensitiveLocalProfileKind::ServiceManager;
        assert_eq!(
            kind.validate(),
            Err(SensitiveProfileRegistryError::KindMismatch)
        );
    }

    #[test]
    fn registry_parse_rejects_unknown_noncanonical_and_oversized_bytes() {
        let bytes = registry().canonical_bytes().unwrap();
        let mut unknown: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        unknown["profiles"][0]["extra"] = serde_json::json!(true);
        assert_eq!(
            CanonicalSensitiveProfileRegistry::parse(&serde_json::to_vec(&unknown).unwrap()),
            Err(SensitiveProfileRegistryError::InvalidEncoding)
        );

        let mut spaced = bytes.clone();
        spaced.push(b' ');
        assert_eq!(
            CanonicalSensitiveProfileRegistry::parse(&spaced),
            Err(SensitiveProfileRegistryError::NonCanonical)
        );
        assert_eq!(
            CanonicalSensitiveProfileRegistry::parse(&vec![
                b'x';
                MAX_SENSITIVE_PROFILE_REGISTRY_BYTES + 1
            ]),
            Err(SensitiveProfileRegistryError::PayloadTooLarge)
        );
    }

    #[test]
    fn registry_lookup_requires_exact_id_hash_and_kind() {
        let bytes = registry().canonical_bytes().unwrap();
        let parsed = CanonicalSensitiveProfileRegistry::parse(&bytes).unwrap();
        let reference = SensitiveProfileRef {
            id: "resident-actions".into(),
            sha256: "38a372a64ace0b1df1589f2f57752a180f0431c6a6f16861369bf1c6f4b6a0d5".into(),
        };
        let profile = parsed
            .lookup_exact(&reference, SensitiveLocalProfileKind::RemoteActions)
            .unwrap();
        assert_eq!(profile, &remote_profile());

        let mut changed = reference.clone();
        changed.sha256 = "0".repeat(64);
        assert_eq!(
            parsed.lookup_exact(&changed, SensitiveLocalProfileKind::RemoteActions),
            Err(SensitiveProfileRegistryError::HashMismatch)
        );
        assert_eq!(
            parsed.lookup_exact(&reference, SensitiveLocalProfileKind::ServiceManager),
            Err(SensitiveProfileRegistryError::KindMismatch)
        );
        let missing = SensitiveProfileRef {
            id: "missing".into(),
            sha256: "0".repeat(64),
        };
        assert_eq!(
            parsed.lookup_exact(&missing, SensitiveLocalProfileKind::RemoteActions),
            Err(SensitiveProfileRegistryError::MissingProfile)
        );
    }
    fn binding_budget() -> crate::CapabilityBudget {
        crate::CapabilityBudget {
            max_calls: 4,
            max_request_bytes: 4096,
            max_result_bytes: 8192,
        }
    }

    fn binding_policy() -> SensitivePolicyV1 {
        SensitivePolicyV1 {
            version: crate::SENSITIVE_POLICY_VERSION,
            profile_id: "binding-test".into(),
            capabilities: vec![
                SensitiveCapabilityRule::RemoteExecProfile {
                    profile: SensitiveProfileRef {
                        id: "resident-actions".into(),
                        sha256: "38a372a64ace0b1df1589f2f57752a180f0431c6a6f16861369bf1c6f4b6a0d5"
                            .into(),
                    },
                    actions: vec!["check-state".into()],
                    budget: binding_budget(),
                },
                SensitiveCapabilityRule::ServiceAction {
                    profile: SensitiveProfileRef {
                        id: "resident-services".into(),
                        sha256: "2e63e14a85c5a09b324e494ccd23af19c967c3702e4b3407b07f5086ebb625fe"
                            .into(),
                    },
                    actions: vec![crate::ServiceAction::Status],
                    budget: binding_budget(),
                },
            ],
            budgets: crate::SensitiveBudgets {
                max_runs: 2,
                max_effects: 8,
                max_lease_s: 300,
                max_wall_ms: 60_000,
                max_cpu_ms: 30_000,
                max_rss_bytes: 536_870_912,
                max_io_read_bytes: 16_777_216,
                max_io_write_bytes: 16_777_216,
                max_scratch_bytes: 67_108_864,
            },
            classifier: crate::SensitiveClassifierPolicy::Required {
                trust_domain: crate::ClassifierTrustDomain::LocalOnly,
                profile_id: "source-v1".into(),
                model_ref: "local/classifier-v1".into(),
                policy_sha256: "a".repeat(64),
                timeout_ms: 5000,
                max_source_bytes: 65_536,
                max_effect_bytes: 16_384,
            },
            persistence: crate::SensitivePersistencePolicy {
                guest_persistence: crate::GuestPersistence::Disabled,
                max_artifacts: 0,
                max_total_artifact_bytes: 0,
            },
        }
    }

    fn canonical_registry(value: SensitiveProfileRegistryV1) -> CanonicalSensitiveProfileRegistry {
        CanonicalSensitiveProfileRegistry::parse(&value.canonical_bytes().unwrap()).unwrap()
    }

    fn exact_ref(profile: &SensitiveLocalProfileV1) -> SensitiveProfileRef {
        let bytes = profile.canonical_bytes().unwrap();
        SensitiveProfileRef {
            id: profile.id.clone(),
            sha256: sha256_hex(&bytes),
        }
    }

    fn total_registry() -> CanonicalSensitiveProfileRegistry {
        let mut profiles = vec![
            read_profile(),
            edit_profile(),
            service_profile(),
            package_profile(),
            kubernetes_profile(),
            remote_profile(),
            network_profile(),
            artifact_profile(),
        ]
        .into_iter()
        .map(|profile| SensitiveProfileRegistryEntryV1::from_profile(profile).unwrap())
        .collect::<Vec<_>>();
        profiles.sort_by(|left, right| left.profile.id.cmp(&right.profile.id));
        canonical_registry(SensitiveProfileRegistryV1 {
            version: SENSITIVE_PROFILE_REGISTRY_VERSION,
            profiles,
        })
    }

    fn total_policy() -> SensitivePolicyV1 {
        let read = exact_ref(&read_profile());
        let edit = exact_ref(&edit_profile());
        let service = exact_ref(&service_profile());
        let package = exact_ref(&package_profile());
        let kubernetes = exact_ref(&kubernetes_profile());
        let remote = exact_ref(&remote_profile());
        let network = exact_ref(&network_profile());
        let artifact = exact_ref(&artifact_profile());
        let mut policy = binding_policy();
        policy.capabilities = vec![
            SensitiveCapabilityRule::ArtifactExport {
                destination_profile: artifact,
                max_artifact_bytes: 1024,
                budget: binding_budget(),
            },
            SensitiveCapabilityRule::EditTree {
                tree: edit,
                relative_prefixes: vec!["src".into()],
                max_files: 4096,
                max_changed_bytes: 1024,
                budget: binding_budget(),
            },
            SensitiveCapabilityRule::KubernetesNamespace {
                cluster_profile: kubernetes,
                namespace: "elpis-workers".into(),
                verbs: vec![crate::KubernetesVerb::Get],
                resources: vec![crate::KubernetesResource::Pod],
                budget: binding_budget(),
            },
            SensitiveCapabilityRule::NetworkEndpoint {
                endpoint_profile: network,
                methods: vec![crate::NetworkMethod::Get],
                budget: binding_budget(),
            },
            SensitiveCapabilityRule::PackageOperation {
                profile: package,
                operations: vec![crate::PackageOperation::Install],
                packages: vec!["curl".into()],
                budget: binding_budget(),
            },
            SensitiveCapabilityRule::ReadPath {
                root: read,
                relative_prefixes: vec!["src".into()],
                budget: binding_budget(),
            },
            SensitiveCapabilityRule::RemoteExecProfile {
                profile: remote,
                actions: vec!["check-state".into()],
                budget: binding_budget(),
            },
            SensitiveCapabilityRule::ServiceAction {
                profile: service,
                actions: vec![crate::ServiceAction::Status],
                budget: binding_budget(),
            },
        ];
        policy.persistence.max_artifacts = 1;
        policy.persistence.max_total_artifact_bytes = 1024;
        policy.validate().unwrap();
        policy
    }

    #[test]
    fn all_capability_variants_derive_fixed_profile_kinds() {
        let reference = |id: &str| SensitiveProfileRef {
            id: id.into(),
            sha256: "a".repeat(64),
        };
        let cases = vec![
            (
                SensitiveCapabilityRule::ReadPath {
                    root: reference("read"),
                    relative_prefixes: vec!["src".into()],
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::FilesystemRoot,
            ),
            (
                SensitiveCapabilityRule::EditTree {
                    tree: reference("edit"),
                    relative_prefixes: vec!["src".into()],
                    max_files: 1,
                    max_changed_bytes: 1,
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::EditableTree,
            ),
            (
                SensitiveCapabilityRule::ServiceAction {
                    profile: reference("service"),
                    actions: vec![crate::ServiceAction::Status],
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::ServiceManager,
            ),
            (
                SensitiveCapabilityRule::PackageOperation {
                    profile: reference("package"),
                    operations: vec![crate::PackageOperation::Install],
                    packages: vec!["curl".into()],
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::PackageTransaction,
            ),
            (
                SensitiveCapabilityRule::KubernetesNamespace {
                    cluster_profile: reference("kube"),
                    namespace: "default".into(),
                    verbs: vec![crate::KubernetesVerb::Get],
                    resources: vec![crate::KubernetesResource::Pod],
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::KubernetesCluster,
            ),
            (
                SensitiveCapabilityRule::RemoteExecProfile {
                    profile: reference("remote"),
                    actions: vec!["check".into()],
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::RemoteActions,
            ),
            (
                SensitiveCapabilityRule::NetworkEndpoint {
                    endpoint_profile: reference("network"),
                    methods: vec![crate::NetworkMethod::Get],
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::NetworkEndpoint,
            ),
            (
                SensitiveCapabilityRule::ArtifactExport {
                    destination_profile: reference("artifact"),
                    max_artifact_bytes: 1,
                    budget: binding_budget(),
                },
                SensitiveLocalProfileKind::ArtifactCustody,
            ),
        ];
        for (capability, expected_kind) in cases {
            assert_eq!(
                SensitiveProfileRequirement::from_capability(&capability).expected_kind,
                expected_kind
            );
        }
    }

    #[test]
    fn exact_binding_accepts_only_one_to_one_policy_and_registry() {
        let policy = binding_policy();
        let registry = canonical_registry(registry());
        let bound = ValidatedSensitiveProfileBindings::bind_exact(&policy, &registry).unwrap();
        assert_eq!(bound.bindings().len(), 2);
        assert_eq!(
            bound.bindings()[0].requirement.profile_ref.id,
            "resident-actions"
        );
        assert_eq!(
            bound.bindings()[1].requirement.profile_ref.id,
            "resident-services"
        );
    }

    #[test]
    fn exact_binding_rejects_invalid_duplicate_missing_extra_hash_and_kind() {
        let registry = canonical_registry(registry());
        let mut invalid = binding_policy();
        invalid.version = 2;
        assert_eq!(
            ValidatedSensitiveProfileBindings::bind_exact(&invalid, &registry),
            Err(SensitiveProfileBindingError::InvalidPolicy)
        );

        let mut duplicate = binding_policy();
        let shared = match &duplicate.capabilities[0] {
            SensitiveCapabilityRule::RemoteExecProfile { profile, .. } => profile.clone(),
            _ => unreachable!(),
        };
        if let SensitiveCapabilityRule::ServiceAction { profile, .. } =
            &mut duplicate.capabilities[1]
        {
            *profile = shared;
        }
        assert_eq!(
            ValidatedSensitiveProfileBindings::bind_exact(&duplicate, &registry),
            Err(SensitiveProfileBindingError::DuplicateRequirementId)
        );

        let missing = canonical_registry(SensitiveProfileRegistryV1 {
            version: SENSITIVE_PROFILE_REGISTRY_VERSION,
            profiles: vec![
                SensitiveProfileRegistryEntryV1::from_profile(remote_profile()).unwrap(),
            ],
        });
        assert_eq!(
            ValidatedSensitiveProfileBindings::bind_exact(&binding_policy(), &missing),
            Err(SensitiveProfileBindingError::MissingProfile)
        );

        let mut one = binding_policy();
        one.capabilities.truncate(1);
        assert_eq!(
            ValidatedSensitiveProfileBindings::bind_exact(&one, &registry),
            Err(SensitiveProfileBindingError::ExtraProfile)
        );

        let mut bad_hash = binding_policy();
        if let SensitiveCapabilityRule::RemoteExecProfile { profile, .. } =
            &mut bad_hash.capabilities[0]
        {
            profile.sha256 = "0".repeat(64);
        }
        assert_eq!(
            ValidatedSensitiveProfileBindings::bind_exact(&bad_hash, &registry),
            Err(SensitiveProfileBindingError::HashMismatch)
        );

        let mut wrong_kind = binding_policy();
        wrong_kind.capabilities[0] = SensitiveCapabilityRule::ServiceAction {
            profile: SensitiveProfileRef {
                id: "resident-actions".into(),
                sha256: "38a372a64ace0b1df1589f2f57752a180f0431c6a6f16861369bf1c6f4b6a0d5".into(),
            },
            actions: vec![crate::ServiceAction::Status],
            budget: binding_budget(),
        };
        assert_eq!(
            ValidatedSensitiveProfileBindings::bind_exact(&wrong_kind, &registry),
            Err(SensitiveProfileBindingError::KindMismatch)
        );
    }
    #[test]
    fn finite_profile_subsets_accept_contained_and_reject_widened_constraints() {
        let reference = |id: &str| SensitiveProfileRef {
            id: id.into(),
            sha256: "a".repeat(64),
        };
        let cases = [
            (
                SensitiveCapabilityRule::ServiceAction {
                    profile: reference("service"),
                    actions: vec![crate::ServiceAction::Reload, crate::ServiceAction::Status],
                    budget: binding_budget(),
                },
                service_profile(),
            ),
            (
                SensitiveCapabilityRule::PackageOperation {
                    profile: reference("package"),
                    operations: vec![crate::PackageOperation::Install],
                    packages: vec!["curl".into()],
                    budget: binding_budget(),
                },
                package_profile(),
            ),
            (
                SensitiveCapabilityRule::RemoteExecProfile {
                    profile: reference("remote"),
                    actions: vec!["check-state".into()],
                    budget: binding_budget(),
                },
                remote_profile(),
            ),
            (
                SensitiveCapabilityRule::NetworkEndpoint {
                    endpoint_profile: reference("network"),
                    methods: vec![crate::NetworkMethod::Get, crate::NetworkMethod::Post],
                    budget: binding_budget(),
                },
                network_profile(),
            ),
        ];
        for (capability, profile) in cases {
            assert_eq!(prove_finite_profile_subset(&capability, &profile), Ok(()));
        }

        let widened = [
            (
                SensitiveCapabilityRule::ServiceAction {
                    profile: reference("service"),
                    actions: vec![crate::ServiceAction::Stop],
                    budget: binding_budget(),
                },
                service_profile(),
            ),
            (
                SensitiveCapabilityRule::PackageOperation {
                    profile: reference("package"),
                    operations: vec![crate::PackageOperation::Remove],
                    packages: vec!["curl".into()],
                    budget: binding_budget(),
                },
                package_profile(),
            ),
            (
                SensitiveCapabilityRule::RemoteExecProfile {
                    profile: reference("remote"),
                    actions: vec!["shell".into()],
                    budget: binding_budget(),
                },
                remote_profile(),
            ),
            (
                SensitiveCapabilityRule::NetworkEndpoint {
                    endpoint_profile: reference("network"),
                    methods: vec![crate::NetworkMethod::Delete],
                    budget: binding_budget(),
                },
                network_profile(),
            ),
        ];
        for (capability, profile) in widened {
            assert_eq!(
                prove_finite_profile_subset(&capability, &profile),
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            );
        }
    }

    #[test]
    fn finite_profile_subsets_reject_wrong_kind_and_other_families() {
        let reference = SensitiveProfileRef {
            id: "x".into(),
            sha256: "a".repeat(64),
        };
        let service = SensitiveCapabilityRule::ServiceAction {
            profile: reference.clone(),
            actions: vec![crate::ServiceAction::Status],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_finite_profile_subset(&service, &remote_profile()),
            Err(SensitiveProfileSubsetError::ProfileKindMismatch)
        );
        let read = SensitiveCapabilityRule::ReadPath {
            root: reference,
            relative_prefixes: vec!["src".into()],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_finite_profile_subset(&read, &service_profile()),
            Err(SensitiveProfileSubsetError::UnsupportedCapabilityFamily)
        );
    }
    #[test]
    fn kubernetes_subset_requires_namespace_and_full_query_cross_product() {
        let reference = SensitiveProfileRef {
            id: "cluster-query".into(),
            sha256: "a".repeat(64),
        };
        for (verbs, resources) in [
            (
                vec![crate::KubernetesVerb::Delete],
                vec![crate::KubernetesResource::ConfigMap],
            ),
            (
                vec![crate::KubernetesVerb::Get, crate::KubernetesVerb::List],
                vec![crate::KubernetesResource::Pod],
            ),
            (
                vec![crate::KubernetesVerb::Watch],
                vec![crate::KubernetesResource::Service],
            ),
        ] {
            let capability = SensitiveCapabilityRule::KubernetesNamespace {
                cluster_profile: reference.clone(),
                namespace: "elpis-workers".into(),
                verbs,
                resources,
                budget: binding_budget(),
            };
            assert_eq!(
                prove_kubernetes_profile_subset(&capability, &kubernetes_profile()),
                Ok(())
            );
        }
        let widened = SensitiveCapabilityRule::KubernetesNamespace {
            cluster_profile: reference.clone(),
            namespace: "elpis-workers".into(),
            verbs: vec![crate::KubernetesVerb::Get, crate::KubernetesVerb::List],
            resources: vec![
                crate::KubernetesResource::Pod,
                crate::KubernetesResource::Service,
            ],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_kubernetes_profile_subset(&widened, &kubernetes_profile()),
            Err(SensitiveProfileSubsetError::ConstraintNotContained)
        );
        let wrong_namespace = SensitiveCapabilityRule::KubernetesNamespace {
            cluster_profile: reference,
            namespace: "default".into(),
            verbs: vec![crate::KubernetesVerb::Get],
            resources: vec![crate::KubernetesResource::Pod],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_kubernetes_profile_subset(&wrong_namespace, &kubernetes_profile()),
            Err(SensitiveProfileSubsetError::ConstraintNotContained)
        );
    }

    #[test]
    fn kubernetes_subset_fails_closed_for_writes_wrong_kind_and_other_families() {
        let reference = SensitiveProfileRef {
            id: "cluster-query".into(),
            sha256: "a".repeat(64),
        };
        for verb in [
            crate::KubernetesVerb::Create,
            crate::KubernetesVerb::Patch,
            crate::KubernetesVerb::Update,
        ] {
            let capability = SensitiveCapabilityRule::KubernetesNamespace {
                cluster_profile: reference.clone(),
                namespace: "elpis-workers".into(),
                verbs: vec![verb],
                resources: vec![crate::KubernetesResource::ConfigMap],
                budget: binding_budget(),
            };
            assert_eq!(
                prove_kubernetes_profile_subset(&capability, &kubernetes_profile()),
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            );
            assert_eq!(
                prove_kubernetes_profile_subset(&capability, &remote_profile()),
                Err(SensitiveProfileSubsetError::ProfileKindMismatch)
            );
        }
        let read = SensitiveCapabilityRule::ReadPath {
            root: reference,
            relative_prefixes: vec!["src".into()],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_kubernetes_profile_subset(&read, &kubernetes_profile()),
            Err(SensitiveProfileSubsetError::UnsupportedCapabilityFamily)
        );
    }
    #[test]
    fn path_and_artifact_subsets_accept_exact_bounds() {
        let reference = |id: &str| SensitiveProfileRef {
            id: id.into(),
            sha256: "a".repeat(64),
        };
        let read = SensitiveCapabilityRule::ReadPath {
            root: reference("read"),
            relative_prefixes: vec!["docs".into(), "src/lib".into()],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_path_artifact_profile_subset(&read, &read_profile()),
            Ok(())
        );
        let edit = SensitiveCapabilityRule::EditTree {
            tree: reference("edit"),
            relative_prefixes: vec!["src/lib".into()],
            max_files: 10_000,
            max_changed_bytes: 1,
            budget: binding_budget(),
        };
        assert_eq!(
            prove_path_artifact_profile_subset(&edit, &edit_profile()),
            Ok(())
        );
        let artifact = SensitiveCapabilityRule::ArtifactExport {
            destination_profile: reference("artifact"),
            max_artifact_bytes: 1024,
            budget: binding_budget(),
        };
        assert_eq!(
            prove_path_artifact_profile_subset(&artifact, &artifact_profile()),
            Ok(())
        );
    }

    #[test]
    fn path_and_artifact_subsets_reject_each_widened_dimension() {
        let reference = |id: &str| SensitiveProfileRef {
            id: id.into(),
            sha256: "a".repeat(64),
        };
        let too_deep = (0..17).map(|_| "a").collect::<Vec<_>>().join("/");
        let too_long = "a".repeat(513);
        let long_component = "a".repeat(121);
        for prefix in [
            too_deep,
            too_long,
            long_component,
            "a//b".into(),
            "../escape".into(),
        ] {
            let read = SensitiveCapabilityRule::ReadPath {
                root: reference("read"),
                relative_prefixes: vec![prefix],
                budget: binding_budget(),
            };
            assert_eq!(
                prove_path_artifact_profile_subset(&read, &read_profile()),
                Err(SensitiveProfileSubsetError::ConstraintNotContained)
            );
        }
        let edit = SensitiveCapabilityRule::EditTree {
            tree: reference("edit"),
            relative_prefixes: vec!["src".into()],
            max_files: 10_001,
            max_changed_bytes: 1,
            budget: binding_budget(),
        };
        assert_eq!(
            prove_path_artifact_profile_subset(&edit, &edit_profile()),
            Err(SensitiveProfileSubsetError::ConstraintNotContained)
        );
        let artifact = SensitiveCapabilityRule::ArtifactExport {
            destination_profile: reference("artifact"),
            max_artifact_bytes: 1025,
            budget: binding_budget(),
        };
        assert_eq!(
            prove_path_artifact_profile_subset(&artifact, &artifact_profile()),
            Err(SensitiveProfileSubsetError::ConstraintNotContained)
        );
    }

    #[test]
    fn path_and_artifact_subsets_reject_wrong_kind_and_other_families() {
        let reference = SensitiveProfileRef {
            id: "x".into(),
            sha256: "a".repeat(64),
        };
        let read = SensitiveCapabilityRule::ReadPath {
            root: reference.clone(),
            relative_prefixes: vec!["src".into()],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_path_artifact_profile_subset(&read, &edit_profile()),
            Err(SensitiveProfileSubsetError::ProfileKindMismatch)
        );
        let service = SensitiveCapabilityRule::ServiceAction {
            profile: reference,
            actions: vec![crate::ServiceAction::Status],
            budget: binding_budget(),
        };
        assert_eq!(
            prove_path_artifact_profile_subset(&service, &read_profile()),
            Err(SensitiveProfileSubsetError::UnsupportedCapabilityFamily)
        );
    }
    #[test]
    fn total_subset_proof_owns_validated_policy_and_all_exact_bindings() {
        let policy = total_policy();
        let proof =
            ValidatedSensitiveProfileSubsetProof::prove(&policy, &total_registry()).unwrap();
        assert_eq!(proof.policy(), &policy);
        assert_eq!(proof.bindings().bindings().len(), 8);
    }

    #[test]
    fn total_subset_proof_fails_closed_across_all_three_proof_families() {
        let registry = total_registry();
        let mut path = total_policy();
        for capability in &mut path.capabilities {
            if let SensitiveCapabilityRule::ReadPath {
                relative_prefixes, ..
            } = capability
            {
                *relative_prefixes = vec!["a".repeat(121)];
            }
        }
        path.validate().unwrap();
        assert_eq!(
            ValidatedSensitiveProfileSubsetProof::prove(&path, &registry),
            Err(SensitiveProfileProofError::Subset(
                SensitiveProfileSubsetError::ConstraintNotContained
            ))
        );

        let mut kubernetes = total_policy();
        for capability in &mut kubernetes.capabilities {
            if let SensitiveCapabilityRule::KubernetesNamespace {
                verbs, resources, ..
            } = capability
            {
                *verbs = vec![crate::KubernetesVerb::Create];
                *resources = vec![crate::KubernetesResource::ConfigMap];
            }
        }
        kubernetes.validate().unwrap();
        assert_eq!(
            ValidatedSensitiveProfileSubsetProof::prove(&kubernetes, &registry),
            Err(SensitiveProfileProofError::Subset(
                SensitiveProfileSubsetError::ConstraintNotContained
            ))
        );

        let mut finite = total_policy();
        for capability in &mut finite.capabilities {
            if let SensitiveCapabilityRule::ServiceAction { actions, .. } = capability {
                *actions = vec![crate::ServiceAction::Stop];
            }
        }
        finite.validate().unwrap();
        assert_eq!(
            ValidatedSensitiveProfileSubsetProof::prove(&finite, &registry),
            Err(SensitiveProfileProofError::Subset(
                SensitiveProfileSubsetError::ConstraintNotContained
            ))
        );
    }

    #[test]
    fn total_subset_proof_requires_exact_binding_before_containment() {
        let mut policy = total_policy();
        if let SensitiveCapabilityRule::ReadPath { root, .. } = &mut policy.capabilities[5] {
            root.sha256 = "0".repeat(64);
        }
        policy.validate().unwrap();
        assert_eq!(
            ValidatedSensitiveProfileSubsetProof::prove(&policy, &total_registry()),
            Err(SensitiveProfileProofError::Binding(
                SensitiveProfileBindingError::HashMismatch
            ))
        );
    }
}
