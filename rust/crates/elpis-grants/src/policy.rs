//! Canonical sensitive-policy syntax and immutable references.
//!
//! This module does not interpret local capability profiles or prove confinement. A profile
//! reference binds exact bytes; a later kind-specific validator must prove what those bytes mean.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{sha256_hex, validate_id, validate_lower_hex_64};

pub const SENSITIVE_POLICY_VERSION: u32 = 1;
pub const MAX_SENSITIVE_POLICY_BYTES: usize = 32 * 1024;
pub const MAX_SENSITIVE_CAPABILITIES: usize = 32;
const MAX_LIST_ITEMS: usize = 64;
const MAX_RELATIVE_PATH_BYTES: usize = 512;
const MAX_REFERENCE_BYTES: usize = 200;
const MAX_CALLS: u32 = 4096;
const MAX_REQUEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RESULT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RUNS: u32 = 64;
const MAX_EFFECTS: u32 = 4096;
const MAX_LEASE_S: u64 = 3600;
const MAX_DURATION_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_RSS_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_IO_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_SCRATCH_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_ARTIFACTS: u32 = 1024;
const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_CLASSIFIER_TIMEOUT_MS: u64 = 120_000;
const MAX_CLASSIFIER_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitivePolicyV1 {
    pub version: u32,
    pub profile_id: String,
    pub capabilities: Vec<SensitiveCapabilityRule>,
    pub budgets: SensitiveBudgets,
    pub classifier: SensitiveClassifierPolicy,
    pub persistence: SensitivePersistencePolicy,
}

impl SensitivePolicyV1 {
    pub fn validate(&self) -> Result<(), SensitivePolicyError> {
        if self.version != SENSITIVE_POLICY_VERSION {
            return Err(SensitivePolicyError::Version);
        }
        validate_id(&self.profile_id).map_err(|_| SensitivePolicyError::InvalidField)?;
        validate_sorted_unique_capabilities(&self.capabilities)?;
        self.budgets.validate()?;
        self.classifier.validate()?;
        self.persistence.validate()?;
        if self.capabilities.is_empty() != (self.budgets.max_effects == 0) {
            return Err(SensitivePolicyError::InvalidField);
        }
        let mut has_artifact_export = false;
        for capability in &self.capabilities {
            capability.validate()?;
            if let SensitiveCapabilityRule::ArtifactExport {
                max_artifact_bytes, ..
            } = capability
            {
                has_artifact_export = true;
                if self.persistence.max_artifacts == 0
                    || *max_artifact_bytes > self.persistence.max_total_artifact_bytes
                {
                    return Err(SensitivePolicyError::InvalidField);
                }
            }
        }
        if has_artifact_export != (self.persistence.max_artifacts > 0) {
            return Err(SensitivePolicyError::InvalidField);
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, SensitivePolicyError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| SensitivePolicyError::InvalidEncoding)?;
        if bytes.len() > MAX_SENSITIVE_POLICY_BYTES {
            return Err(SensitivePolicyError::PayloadTooLarge);
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalSensitivePolicy {
    policy: SensitivePolicyV1,
    policy_sha256: String,
}

impl CanonicalSensitivePolicy {
    pub fn parse(bytes: &[u8]) -> Result<Self, SensitivePolicyError> {
        if bytes.is_empty() || bytes.len() > MAX_SENSITIVE_POLICY_BYTES {
            return Err(SensitivePolicyError::PayloadTooLarge);
        }
        let policy: SensitivePolicyV1 =
            serde_json::from_slice(bytes).map_err(|_| SensitivePolicyError::InvalidEncoding)?;
        let canonical = policy.canonical_bytes()?;
        if canonical != bytes {
            return Err(SensitivePolicyError::NonCanonical);
        }
        Ok(Self {
            policy,
            policy_sha256: sha256_hex(bytes),
        })
    }

    pub fn policy(&self) -> &SensitivePolicyV1 {
        &self.policy
    }

    pub fn policy_sha256(&self) -> &str {
        &self.policy_sha256
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CapabilityBudget {
    pub max_calls: u32,
    pub max_request_bytes: u64,
    pub max_result_bytes: u64,
}

impl CapabilityBudget {
    fn validate(&self) -> Result<(), SensitivePolicyError> {
        if self.max_calls == 0
            || self.max_calls > MAX_CALLS
            || self.max_request_bytes == 0
            || self.max_request_bytes > MAX_REQUEST_BYTES
            || self.max_result_bytes == 0
            || self.max_result_bytes > MAX_RESULT_BYTES
        {
            return Err(SensitivePolicyError::InvalidField);
        }
        Ok(())
    }
}

/// Immutable identity for local profile bytes, not proof that those bytes are safe or narrow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitiveProfileRef {
    pub id: String,
    pub sha256: String,
}

impl SensitiveProfileRef {
    pub(crate) fn validate(&self) -> Result<(), SensitivePolicyError> {
        validate_profile_id(&self.id)?;
        validate_lower_hex_64(&self.sha256).map_err(|_| SensitivePolicyError::InvalidField)
    }
}

/// Signed intent constraints. Enforcement must also validate the referenced profile kind and hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SensitiveCapabilityRule {
    ReadPath {
        root: SensitiveProfileRef,
        relative_prefixes: Vec<String>,
        budget: CapabilityBudget,
    },
    EditTree {
        tree: SensitiveProfileRef,
        relative_prefixes: Vec<String>,
        max_files: u32,
        max_changed_bytes: u64,
        budget: CapabilityBudget,
    },
    ServiceAction {
        profile: SensitiveProfileRef,
        actions: Vec<ServiceAction>,
        budget: CapabilityBudget,
    },
    PackageOperation {
        profile: SensitiveProfileRef,
        operations: Vec<PackageOperation>,
        packages: Vec<String>,
        budget: CapabilityBudget,
    },
    KubernetesNamespace {
        cluster_profile: SensitiveProfileRef,
        namespace: String,
        verbs: Vec<KubernetesVerb>,
        resources: Vec<KubernetesResource>,
        budget: CapabilityBudget,
    },
    RemoteExecProfile {
        profile: SensitiveProfileRef,
        actions: Vec<String>,
        budget: CapabilityBudget,
    },
    NetworkEndpoint {
        endpoint_profile: SensitiveProfileRef,
        methods: Vec<NetworkMethod>,
        budget: CapabilityBudget,
    },
    ArtifactExport {
        destination_profile: SensitiveProfileRef,
        max_artifact_bytes: u64,
        budget: CapabilityBudget,
    },
}

impl SensitiveCapabilityRule {
    fn key(&self) -> String {
        let (kind, id) = match self {
            Self::ReadPath { root, .. } => ("read_path", &root.id),
            Self::EditTree { tree, .. } => ("edit_tree", &tree.id),
            Self::ServiceAction { profile, .. } => ("service_action", &profile.id),
            Self::PackageOperation { profile, .. } => ("package_operation", &profile.id),
            Self::KubernetesNamespace {
                cluster_profile,
                namespace,
                ..
            } => {
                return format!("kubernetes_namespace:{}:{namespace}", cluster_profile.id);
            }
            Self::RemoteExecProfile { profile, .. } => ("remote_exec_profile", &profile.id),
            Self::NetworkEndpoint {
                endpoint_profile, ..
            } => ("network_endpoint", &endpoint_profile.id),
            Self::ArtifactExport {
                destination_profile,
                ..
            } => ("artifact_export", &destination_profile.id),
        };
        format!("{kind}:{id}")
    }

    fn validate(&self) -> Result<(), SensitivePolicyError> {
        match self {
            Self::ReadPath {
                root,
                relative_prefixes,
                budget,
            } => {
                root.validate()?;
                validate_relative_paths(relative_prefixes)?;
                budget.validate()
            }
            Self::EditTree {
                tree,
                relative_prefixes,
                max_files,
                max_changed_bytes,
                budget,
            } => {
                tree.validate()?;
                validate_relative_paths(relative_prefixes)?;
                if *max_files == 0
                    || *max_files > 4096
                    || *max_changed_bytes == 0
                    || *max_changed_bytes > MAX_IO_BYTES
                {
                    return Err(SensitivePolicyError::InvalidField);
                }
                budget.validate()
            }
            Self::ServiceAction {
                profile,
                actions,
                budget,
            } => {
                profile.validate()?;
                validate_sorted_unique(actions)?;
                budget.validate()
            }
            Self::PackageOperation {
                profile,
                operations,
                packages,
                budget,
            } => {
                profile.validate()?;
                validate_sorted_unique(operations)?;
                validate_sorted_unique_strings(packages, validate_profile_id)?;
                budget.validate()
            }
            Self::KubernetesNamespace {
                cluster_profile,
                namespace,
                verbs,
                resources,
                budget,
            } => {
                cluster_profile.validate()?;
                validate_kubernetes_namespace(namespace)?;
                validate_sorted_unique(verbs)?;
                validate_sorted_unique(resources)?;
                budget.validate()
            }
            Self::RemoteExecProfile {
                profile,
                actions,
                budget,
            } => {
                profile.validate()?;
                validate_sorted_unique_strings(actions, validate_profile_id)?;
                budget.validate()
            }
            Self::NetworkEndpoint {
                endpoint_profile,
                methods,
                budget,
            } => {
                endpoint_profile.validate()?;
                validate_sorted_unique(methods)?;
                budget.validate()
            }
            Self::ArtifactExport {
                destination_profile,
                max_artifact_bytes,
                budget,
            } => {
                destination_profile.validate()?;
                if *max_artifact_bytes == 0 || *max_artifact_bytes > MAX_ARTIFACT_BYTES {
                    return Err(SensitivePolicyError::InvalidField);
                }
                budget.validate()
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ServiceAction {
    Reload,
    Restart,
    Start,
    Status,
    Stop,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PackageOperation {
    Install,
    Remove,
    Upgrade,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesVerb {
    Create,
    Delete,
    Get,
    List,
    Patch,
    Update,
    Watch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesResource {
    ConfigMap,
    Deployment,
    Job,
    Pod,
    Service,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMethod {
    Delete,
    Get,
    Head,
    Post,
    Put,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitiveBudgets {
    pub max_runs: u32,
    pub max_effects: u32,
    pub max_lease_s: u64,
    pub max_wall_ms: u64,
    pub max_cpu_ms: u64,
    pub max_rss_bytes: u64,
    pub max_io_read_bytes: u64,
    pub max_io_write_bytes: u64,
    pub max_scratch_bytes: u64,
}

impl SensitiveBudgets {
    fn validate(&self) -> Result<(), SensitivePolicyError> {
        if self.max_runs == 0
            || self.max_runs > MAX_RUNS
            || self.max_effects > MAX_EFFECTS
            || self.max_lease_s == 0
            || self.max_lease_s > MAX_LEASE_S
            || self.max_wall_ms == 0
            || self.max_wall_ms > MAX_DURATION_MS
            || self.max_cpu_ms == 0
            || self.max_cpu_ms > MAX_DURATION_MS
            || self.max_rss_bytes == 0
            || self.max_rss_bytes > MAX_RSS_BYTES
            || self.max_io_read_bytes == 0
            || self.max_io_read_bytes > MAX_IO_BYTES
            || self.max_io_write_bytes == 0
            || self.max_io_write_bytes > MAX_IO_BYTES
            || self.max_scratch_bytes == 0
            || self.max_scratch_bytes > MAX_SCRATCH_BYTES
        {
            return Err(SensitivePolicyError::InvalidField);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum SensitiveClassifierPolicy {
    Disabled,
    Required {
        trust_domain: ClassifierTrustDomain,
        profile_id: String,
        model_ref: String,
        policy_sha256: String,
        timeout_ms: u64,
        max_source_bytes: u64,
        max_effect_bytes: u64,
    },
}

impl SensitiveClassifierPolicy {
    fn validate(&self) -> Result<(), SensitivePolicyError> {
        match self {
            Self::Disabled => Ok(()),
            Self::Required {
                profile_id,
                model_ref,
                policy_sha256,
                timeout_ms,
                max_source_bytes,
                max_effect_bytes,
                ..
            } => {
                validate_profile_id(profile_id)?;
                validate_model_ref(model_ref)?;
                validate_lower_hex_64(policy_sha256)
                    .map_err(|_| SensitivePolicyError::InvalidField)?;
                if *timeout_ms == 0
                    || *timeout_ms > MAX_CLASSIFIER_TIMEOUT_MS
                    || *max_source_bytes == 0
                    || *max_source_bytes > MAX_CLASSIFIER_BYTES
                    || *max_effect_bytes == 0
                    || *max_effect_bytes > MAX_CLASSIFIER_BYTES
                {
                    return Err(SensitivePolicyError::InvalidField);
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClassifierTrustDomain {
    ApprovedProvider,
    LocalOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuestPersistence {
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitivePersistencePolicy {
    pub guest_persistence: GuestPersistence,
    pub max_artifacts: u32,
    pub max_total_artifact_bytes: u64,
}

impl SensitivePersistencePolicy {
    fn validate(&self) -> Result<(), SensitivePolicyError> {
        if self.max_artifacts > MAX_ARTIFACTS
            || self.max_total_artifact_bytes > MAX_ARTIFACT_BYTES
            || (self.max_artifacts == 0) != (self.max_total_artifact_bytes == 0)
        {
            return Err(SensitivePolicyError::InvalidField);
        }
        Ok(())
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SensitivePolicyError {
    #[error("sensitive policy version is unsupported")]
    Version,
    #[error("sensitive policy payload exceeds its bound")]
    PayloadTooLarge,
    #[error("sensitive policy encoding is invalid")]
    InvalidEncoding,
    #[error("sensitive policy encoding is not canonical")]
    NonCanonical,
    #[error("sensitive policy field is invalid")]
    InvalidField,
    #[error("sensitive policy lists must be nonempty, sorted, and unique")]
    NonCanonicalList,
}

fn validate_sorted_unique_capabilities(
    capabilities: &[SensitiveCapabilityRule],
) -> Result<(), SensitivePolicyError> {
    if capabilities.len() > MAX_SENSITIVE_CAPABILITIES {
        return Err(SensitivePolicyError::InvalidField);
    }
    let keys = capabilities.iter().map(SensitiveCapabilityRule::key);
    validate_sorted_keys(keys)
}

fn validate_relative_paths(paths: &[String]) -> Result<(), SensitivePolicyError> {
    validate_sorted_unique_strings(paths, validate_relative_path)
}

fn validate_relative_path(value: &str) -> Result<(), SensitivePolicyError> {
    if value.is_empty()
        || value.len() > MAX_RELATIVE_PATH_BYTES
        || value.starts_with('/')
        || value.contains('\\')
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/' | b'@' | b'+')
        })
    {
        return Err(SensitivePolicyError::InvalidField);
    }
    if value == "." {
        return Ok(());
    }
    if value
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(SensitivePolicyError::InvalidField);
    }
    Ok(())
}

fn validate_profile_id(value: &str) -> Result<(), SensitivePolicyError> {
    validate_id(value).map_err(|_| SensitivePolicyError::InvalidField)
}

fn validate_kubernetes_namespace(value: &str) -> Result<(), SensitivePolicyError> {
    if value.is_empty()
        || value.len() > 63
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(SensitivePolicyError::InvalidField);
    }
    Ok(())
}

fn validate_model_ref(value: &str) -> Result<(), SensitivePolicyError> {
    if value.is_empty() || value.len() > MAX_REFERENCE_BYTES {
        return Err(SensitivePolicyError::InvalidField);
    }
    let mut parts = value.split('/');
    let Some(provider) = parts.next() else {
        return Err(SensitivePolicyError::InvalidField);
    };
    let Some(model) = parts.next() else {
        return Err(SensitivePolicyError::InvalidField);
    };
    if parts.next().is_some() {
        return Err(SensitivePolicyError::InvalidField);
    }
    validate_profile_id(provider)?;
    validate_profile_id(model)
}

fn validate_sorted_unique<T: Ord>(values: &[T]) -> Result<(), SensitivePolicyError> {
    if values.is_empty() || values.len() > MAX_LIST_ITEMS {
        return Err(SensitivePolicyError::InvalidField);
    }
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(SensitivePolicyError::NonCanonicalList);
    }
    Ok(())
}

fn validate_sorted_unique_strings(
    values: &[String],
    validate: fn(&str) -> Result<(), SensitivePolicyError>,
) -> Result<(), SensitivePolicyError> {
    if values.is_empty() || values.len() > MAX_LIST_ITEMS {
        return Err(SensitivePolicyError::InvalidField);
    }
    for value in values {
        validate(value)?;
    }
    validate_sorted_keys(values.iter().cloned())
}

fn validate_sorted_keys(
    values: impl IntoIterator<Item = String>,
) -> Result<(), SensitivePolicyError> {
    let mut previous: Option<String> = None;
    for value in values {
        if previous.as_ref().is_some_and(|old| old >= &value) {
            return Err(SensitivePolicyError::NonCanonicalList);
        }
        previous = Some(value);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn budget() -> CapabilityBudget {
        CapabilityBudget {
            max_calls: 4,
            max_request_bytes: 4096,
            max_result_bytes: 8192,
        }
    }

    fn profile(id: &str) -> SensitiveProfileRef {
        SensitiveProfileRef {
            id: id.into(),
            sha256: HASH.into(),
        }
    }

    fn policy() -> SensitivePolicyV1 {
        SensitivePolicyV1 {
            version: SENSITIVE_POLICY_VERSION,
            profile_id: "profile-test".into(),
            capabilities: vec![
                SensitiveCapabilityRule::ReadPath {
                    root: profile("workspace"),
                    relative_prefixes: vec!["docs".into(), "src".into()],
                    budget: budget(),
                },
                SensitiveCapabilityRule::ServiceAction {
                    profile: profile("web-service"),
                    actions: vec![ServiceAction::Restart, ServiceAction::Status],
                    budget: budget(),
                },
            ],
            budgets: SensitiveBudgets {
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
            classifier: SensitiveClassifierPolicy::Required {
                trust_domain: ClassifierTrustDomain::LocalOnly,
                profile_id: "source-v1".into(),
                model_ref: "local/classifier-v1".into(),
                policy_sha256: HASH.into(),
                timeout_ms: 5000,
                max_source_bytes: 65_536,
                max_effect_bytes: 16_384,
            },
            persistence: SensitivePersistencePolicy {
                guest_persistence: GuestPersistence::Disabled,
                max_artifacts: 0,
                max_total_artifact_bytes: 0,
            },
        }
    }

    #[test]
    fn exact_canonical_bytes_parse_and_hash() {
        const GOLDEN: &str = r#"{"version":1,"profile_id":"profile-test","capabilities":[{"kind":"read_path","root":{"id":"workspace","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"relative_prefixes":["docs","src"],"budget":{"max_calls":4,"max_request_bytes":4096,"max_result_bytes":8192}},{"kind":"service_action","profile":{"id":"web-service","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"actions":["restart","status"],"budget":{"max_calls":4,"max_request_bytes":4096,"max_result_bytes":8192}}],"budgets":{"max_runs":2,"max_effects":8,"max_lease_s":300,"max_wall_ms":60000,"max_cpu_ms":30000,"max_rss_bytes":536870912,"max_io_read_bytes":16777216,"max_io_write_bytes":16777216,"max_scratch_bytes":67108864},"classifier":{"mode":"required","trust_domain":"local_only","profile_id":"source-v1","model_ref":"local/classifier-v1","policy_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","timeout_ms":5000,"max_source_bytes":65536,"max_effect_bytes":16384},"persistence":{"guest_persistence":"disabled","max_artifacts":0,"max_total_artifact_bytes":0}}"#;
        const GOLDEN_SHA256: &str =
            "d4996927bc8496030e050e1e93d8a4090fb92040d03e8be72e0a0c87802bc07c";

        let bytes = policy().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitivePolicy::parse(&bytes).unwrap();
        assert_eq!(parsed.policy(), &policy());
        assert_eq!(parsed.policy_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.policy_sha256(), hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn whitespace_unknown_fields_and_key_reordering_are_rejected() {
        let bytes = policy().canonical_bytes().unwrap();
        let mut whitespace = b" ".to_vec();
        whitespace.extend_from_slice(&bytes);
        assert_eq!(
            CanonicalSensitivePolicy::parse(&whitespace),
            Err(SensitivePolicyError::NonCanonical)
        );
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["unknown"] = serde_json::json!(true);
        assert_eq!(
            CanonicalSensitivePolicy::parse(&serde_json::to_vec(&value).unwrap()),
            Err(SensitivePolicyError::InvalidEncoding)
        );
        let reordered =
            serde_json::to_vec(&serde_json::from_slice::<serde_json::Value>(&bytes).unwrap())
                .unwrap();
        assert_ne!(reordered, bytes);
        assert_eq!(
            CanonicalSensitivePolicy::parse(&reordered),
            Err(SensitivePolicyError::NonCanonical)
        );

        let duplicate = String::from_utf8(bytes.clone()).unwrap().replacen(
            "\"version\":1",
            "\"version\":1,\"version\":1",
            1,
        );
        assert_eq!(
            CanonicalSensitivePolicy::parse(duplicate.as_bytes()),
            Err(SensitivePolicyError::InvalidEncoding)
        );

        let mut nested: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        nested["capabilities"][0]["root"]["unknown"] = serde_json::json!(true);
        assert_eq!(
            CanonicalSensitivePolicy::parse(&serde_json::to_vec(&nested).unwrap()),
            Err(SensitivePolicyError::InvalidEncoding)
        );
    }

    #[test]
    fn oversized_payload_is_rejected_before_decoding() {
        let oversized = vec![b' '; MAX_SENSITIVE_POLICY_BYTES + 1];
        assert_eq!(
            CanonicalSensitivePolicy::parse(&oversized),
            Err(SensitivePolicyError::PayloadTooLarge)
        );
    }

    #[test]
    fn capabilities_and_nested_lists_must_be_sorted_and_unique() {
        let mut value = policy();
        value.capabilities.swap(0, 1);
        assert_eq!(
            value.validate(),
            Err(SensitivePolicyError::NonCanonicalList)
        );
        let mut value = policy();
        if let SensitiveCapabilityRule::ReadPath {
            relative_prefixes, ..
        } = &mut value.capabilities[0]
        {
            *relative_prefixes = vec!["src".into(), "docs".into()];
        }
        assert_eq!(
            value.validate(),
            Err(SensitivePolicyError::NonCanonicalList)
        );
    }

    #[test]
    fn referenced_profile_content_hash_is_mandatory_and_bound() {
        let mut value = policy();
        if let SensitiveCapabilityRule::ReadPath { root, .. } = &mut value.capabilities[0] {
            root.sha256 = "A".repeat(64);
        }
        assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));

        let original = policy().canonical_bytes().unwrap();
        let mut changed = policy();
        if let SensitiveCapabilityRule::ReadPath { root, .. } = &mut changed.capabilities[0] {
            root.sha256 = "b".repeat(64);
        }
        let changed = changed.canonical_bytes().unwrap();
        assert_ne!(original, changed);
        assert_ne!(
            CanonicalSensitivePolicy::parse(&original)
                .unwrap()
                .policy_sha256(),
            CanonicalSensitivePolicy::parse(&changed)
                .unwrap()
                .policy_sha256()
        );
    }

    #[test]
    fn absolute_parent_and_backslash_paths_are_unrepresentable() {
        for path in [
            "/etc",
            "../secret",
            "src/../secret",
            "src\\secret",
            "src/*",
            "src/$name",
            "src/a b",
            "src:stream",
        ] {
            let mut value = policy();
            if let SensitiveCapabilityRule::ReadPath {
                relative_prefixes, ..
            } = &mut value.capabilities[0]
            {
                *relative_prefixes = vec![path.into()];
            }
            assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
        }
    }

    #[test]
    fn raw_shell_root_argv_host_paths_and_destinations_have_no_codec() {
        let bytes = policy().canonical_bytes().unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        for forbidden in [
            "\"shell\":",
            "\"argv\":",
            "\"host_path\":",
            "\"destination\":",
        ] {
            assert!(!text.contains(forbidden));
        }

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["capabilities"][0] = serde_json::json!({
            "kind": "root",
            "command": "anything"
        });
        assert_eq!(
            CanonicalSensitivePolicy::parse(&serde_json::to_vec(&value).unwrap()),
            Err(SensitivePolicyError::InvalidEncoding)
        );
    }

    #[test]
    fn every_structured_capability_variant_has_a_bounded_codec() {
        let mut value = policy();
        value.persistence.max_artifacts = 2;
        value.persistence.max_total_artifact_bytes = 4096;
        value.capabilities = vec![
            SensitiveCapabilityRule::ArtifactExport {
                destination_profile: profile("review-store"),
                max_artifact_bytes: 2048,
                budget: budget(),
            },
            SensitiveCapabilityRule::EditTree {
                tree: profile("workspace"),
                relative_prefixes: vec!["src".into()],
                max_files: 16,
                max_changed_bytes: 65_536,
                budget: budget(),
            },
            SensitiveCapabilityRule::KubernetesNamespace {
                cluster_profile: profile("cluster-test"),
                namespace: "project-test".into(),
                verbs: vec![KubernetesVerb::Get, KubernetesVerb::List],
                resources: vec![KubernetesResource::ConfigMap, KubernetesResource::Pod],
                budget: budget(),
            },
            SensitiveCapabilityRule::NetworkEndpoint {
                endpoint_profile: profile("package-index"),
                methods: vec![NetworkMethod::Get, NetworkMethod::Head],
                budget: budget(),
            },
            SensitiveCapabilityRule::PackageOperation {
                profile: profile("apt-project"),
                operations: vec![PackageOperation::Install],
                packages: vec!["curl".into(), "jq".into()],
                budget: budget(),
            },
            SensitiveCapabilityRule::ReadPath {
                root: profile("workspace"),
                relative_prefixes: vec!["docs".into(), "src".into()],
                budget: budget(),
            },
            SensitiveCapabilityRule::RemoteExecProfile {
                profile: profile("fixed-maintenance"),
                actions: vec!["collect-status".into(), "restart-worker".into()],
                budget: budget(),
            },
            SensitiveCapabilityRule::ServiceAction {
                profile: profile("web-service"),
                actions: vec![ServiceAction::Restart, ServiceAction::Status],
                budget: budget(),
            },
        ];
        value.validate().unwrap();
        CanonicalSensitivePolicy::parse(&value.canonical_bytes().unwrap()).unwrap();
    }

    #[test]
    fn zero_capability_policy_is_explicit_default_deny() {
        let mut value = policy();
        value.capabilities.clear();
        value.budgets.max_effects = 0;
        value.validate().unwrap();
        CanonicalSensitivePolicy::parse(&value.canonical_bytes().unwrap()).unwrap();

        value.budgets.max_effects = 1;
        assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
    }

    #[test]
    fn kubernetes_namespace_is_an_exact_dns_label() {
        for namespace in ["Project", "project_test", "-project", "project-", "a/b"] {
            let mut value = policy();
            value.capabilities = vec![SensitiveCapabilityRule::KubernetesNamespace {
                cluster_profile: profile("cluster-test"),
                namespace: namespace.into(),
                verbs: vec![KubernetesVerb::Get],
                resources: vec![KubernetesResource::Pod],
                budget: budget(),
            }];
            assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
        }
    }

    #[test]
    fn model_reference_is_a_name_not_an_endpoint() {
        for model_ref in ["https://example.com/model", "local", "local/a/b", "/model"] {
            let mut value = policy();
            if let SensitiveClassifierPolicy::Required {
                model_ref: current, ..
            } = &mut value.classifier
            {
                *current = model_ref.into();
            }
            assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
        }
    }

    #[test]
    fn remote_exec_requires_exact_sorted_action_names() {
        let mut value = policy();
        value.capabilities = vec![SensitiveCapabilityRule::RemoteExecProfile {
            profile: profile("maintenance"),
            actions: vec!["restart-worker".into(), "collect-status".into()],
            budget: budget(),
        }];
        assert_eq!(
            value.validate(),
            Err(SensitivePolicyError::NonCanonicalList)
        );
    }

    #[test]
    fn quantitative_bounds_fail_closed() {
        let mut value = policy();
        value.budgets.max_lease_s = MAX_LEASE_S + 1;
        assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
        let mut value = policy();
        if let SensitiveCapabilityRule::ReadPath { budget, .. } = &mut value.capabilities[0] {
            budget.max_calls = 0;
        }
        assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
        let mut value = policy();
        if let SensitiveClassifierPolicy::Required { timeout_ms, .. } = &mut value.classifier {
            *timeout_ms = MAX_CLASSIFIER_TIMEOUT_MS + 1;
        }
        assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
    }

    #[test]
    fn artifact_export_requires_matching_global_custody() {
        let mut value = policy();
        value.capabilities.insert(
            0,
            SensitiveCapabilityRule::ArtifactExport {
                destination_profile: profile("review-store"),
                max_artifact_bytes: 1024,
                budget: budget(),
            },
        );
        assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
        value.persistence.max_artifacts = 2;
        value.persistence.max_total_artifact_bytes = 2048;
        value.validate().unwrap();

        value.capabilities.remove(0);
        assert_eq!(value.validate(), Err(SensitivePolicyError::InvalidField));
    }

    #[test]
    fn disabled_classifier_is_explicit_and_canonical() {
        let mut value = policy();
        value.classifier = SensitiveClassifierPolicy::Disabled;
        let bytes = value.canonical_bytes().unwrap();
        assert!(
            String::from_utf8(bytes)
                .unwrap()
                .contains("\"classifier\":{\"mode\":\"disabled\"}")
        );
    }
}
