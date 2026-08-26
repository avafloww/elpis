//! Canonical local sensitive-profile artifacts.
//!
//! These bytes describe checks a later evaluator must perform. Parsing them does not inspect the
//! filesystem, resolve a path, inspect credentials, perform TLS, contact Kubernetes, evaluate a
//! request, prevent TOCTOU, or prove confinement.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    KubernetesResource, SensitiveProfileRef, sha256_hex, validate_id, validate_lower_hex_64,
};

pub const SENSITIVE_LOCAL_PROFILE_VERSION: u32 = 1;
pub const MAX_SENSITIVE_LOCAL_PROFILE_BYTES: usize = 16 * 1024;
const MAX_ROOT_PATH_BYTES: usize = 1024;
const MAX_RELATIVE_PATH_BYTES: u32 = 4096;
const MAX_COMPONENT_BYTES: u32 = 255;
const MAX_DEPTH: u32 = 64;
const MAX_ENTRIES: u32 = 1_000_000;
const MAX_ARTIFACT_FILES: u32 = 4096;
const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_KUBERNETES_RULES: usize = 20;
const MAX_KUBERNETES_NAMES: usize = 64;
const MAX_KUBERNETES_SELECTORS: usize = 32;
const MAX_KUBERNETES_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_KUBERNETES_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_KUBERNETES_WRITE_TEMPLATES: usize = 32;
const MAX_KUBERNETES_LABELS: usize = 32;
const MAX_CONFIG_MAP_DATA_ENTRIES: usize = 64;
const MAX_CONFIG_MAP_DATA_BYTES: usize = 8 * 1024;
const MAX_SERVICE_PORTS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitiveLocalProfileV1 {
    pub version: u32,
    pub id: String,
    pub profile: SensitiveLocalProfileKindV1,
}

impl SensitiveLocalProfileV1 {
    pub fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        if self.version != SENSITIVE_LOCAL_PROFILE_VERSION {
            return Err(SensitiveLocalProfileError::Version);
        }
        validate_id(&self.id).map_err(|_| SensitiveLocalProfileError::InvalidField)?;
        self.profile.validate()
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, SensitiveLocalProfileError> {
        self.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| SensitiveLocalProfileError::InvalidEncoding)?;
        if bytes.len() > MAX_SENSITIVE_LOCAL_PROFILE_BYTES {
            return Err(SensitiveLocalProfileError::PayloadTooLarge);
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalSensitiveLocalProfile {
    profile: SensitiveLocalProfileV1,
    profile_sha256: String,
}

impl CanonicalSensitiveLocalProfile {
    pub fn parse(bytes: &[u8]) -> Result<Self, SensitiveLocalProfileError> {
        if bytes.is_empty() || bytes.len() > MAX_SENSITIVE_LOCAL_PROFILE_BYTES {
            return Err(SensitiveLocalProfileError::PayloadTooLarge);
        }
        let profile: SensitiveLocalProfileV1 = serde_json::from_slice(bytes)
            .map_err(|_| SensitiveLocalProfileError::InvalidEncoding)?;
        let canonical = profile.canonical_bytes()?;
        if canonical != bytes {
            return Err(SensitiveLocalProfileError::NonCanonical);
        }
        Ok(Self {
            profile,
            profile_sha256: sha256_hex(bytes),
        })
    }

    pub fn profile(&self) -> &SensitiveLocalProfileV1 {
        &self.profile
    }

    pub fn profile_sha256(&self) -> &str {
        &self.profile_sha256
    }

    pub fn profile_ref(&self) -> SensitiveProfileRef {
        SensitiveProfileRef {
            id: self.profile.id.clone(),
            sha256: self.profile_sha256.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SensitiveLocalProfileKindV1 {
    FilesystemRoot {
        root: FilesystemRootBinding,
        max_depth: u32,
        max_relative_path_bytes: u32,
        max_component_bytes: u32,
        max_entries: u32,
    },
    EditableTree {
        root: FilesystemRootBinding,
        max_depth: u32,
        max_relative_path_bytes: u32,
        max_component_bytes: u32,
        max_entries: u32,
        operations: Vec<EditTreeOperation>,
        create_policy: CreatePolicy,
        replace_policy: DestructivePrecondition,
        delete_policy: DestructivePrecondition,
        commit_policy: WriteCommitPolicy,
        created_file_mode: u32,
        created_directory_mode: u32,
    },
    ArtifactCustody {
        root: FilesystemRootBinding,
        write_mode: ArtifactWriteMode,
        name_policy: ArtifactNamePolicy,
        created_file_mode: u32,
        max_files: u32,
        max_single_file_bytes: u64,
        max_total_bytes: u64,
    },
    KubernetesCluster {
        api_server: KubernetesApiServer,
        credential_profile: SensitiveProfileRef,
        namespace: String,
        rules: Vec<KubernetesQueryRule>,
        max_request_bytes: u64,
        max_response_bytes: u64,
    },
    KubernetesObjectTemplates {
        cluster_profile: SensitiveProfileRef,
        templates: Vec<KubernetesWriteTemplate>,
    },
}

impl SensitiveLocalProfileKindV1 {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        match self {
            Self::FilesystemRoot {
                root,
                max_depth,
                max_relative_path_bytes,
                max_component_bytes,
                max_entries,
            } => {
                root.validate()?;
                validate_path_limits(
                    *max_depth,
                    *max_relative_path_bytes,
                    *max_component_bytes,
                    *max_entries,
                )
            }
            Self::EditableTree {
                root,
                max_depth,
                max_relative_path_bytes,
                max_component_bytes,
                max_entries,
                operations,
                created_file_mode,
                created_directory_mode,
                ..
            } => {
                root.validate()?;
                validate_path_limits(
                    *max_depth,
                    *max_relative_path_bytes,
                    *max_component_bytes,
                    *max_entries,
                )?;
                validate_sorted_unique(operations)?;
                if !matches!(*created_file_mode, 0o600 | 0o640)
                    || !matches!(*created_directory_mode, 0o700 | 0o750)
                {
                    return Err(SensitiveLocalProfileError::InvalidField);
                }
                Ok(())
            }
            Self::ArtifactCustody {
                root,
                max_files,
                max_single_file_bytes,
                max_total_bytes,
                created_file_mode,
                ..
            } => {
                root.validate()?;
                if root.expected_permissions != 0o700
                    || *created_file_mode != 0o600
                    || *max_files == 0
                    || *max_files > MAX_ARTIFACT_FILES
                    || *max_single_file_bytes == 0
                    || *max_single_file_bytes > MAX_ARTIFACT_BYTES
                    || *max_total_bytes == 0
                    || *max_total_bytes > MAX_ARTIFACT_BYTES
                    || *max_single_file_bytes > *max_total_bytes
                {
                    return Err(SensitiveLocalProfileError::InvalidField);
                }
                Ok(())
            }
            Self::KubernetesCluster {
                api_server,
                credential_profile,
                namespace,
                rules,
                max_request_bytes,
                max_response_bytes,
            } => {
                api_server.validate()?;
                credential_profile
                    .validate()
                    .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
                validate_kubernetes_dns_label(namespace)?;
                validate_kubernetes_rules(rules)?;
                if *max_request_bytes == 0
                    || *max_request_bytes > MAX_KUBERNETES_REQUEST_BYTES
                    || *max_response_bytes == 0
                    || *max_response_bytes > MAX_KUBERNETES_RESPONSE_BYTES
                {
                    return Err(SensitiveLocalProfileError::InvalidField);
                }
                Ok(())
            }
            Self::KubernetesObjectTemplates {
                cluster_profile,
                templates,
            } => {
                cluster_profile
                    .validate()
                    .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
                validate_kubernetes_write_templates(templates)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FilesystemRootBinding {
    pub canonical_root: String,
    pub expected_mount_id: u64,
    pub expected_device: u64,
    pub expected_inode: u64,
    pub expected_owner_uid: u32,
    pub expected_owner_gid: u32,
    pub expected_permissions: u32,
    pub entry_ownership: EntryOwnershipPolicy,
    pub entry_writes: EntryWritePolicy,
    pub symlinks: SymlinkPolicy,
    pub hard_links: HardLinkPolicy,
    pub mount_crossing: MountCrossingPolicy,
    pub special_files: SpecialFilePolicy,
}

impl FilesystemRootBinding {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_absolute_root(&self.canonical_root)?;
        if self.expected_mount_id == 0
            || self.expected_device == 0
            || self.expected_inode == 0
            || !matches!(self.expected_permissions, 0o700 | 0o750 | 0o755)
        {
            return Err(SensitiveLocalProfileError::InvalidField);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryOwnershipPolicy {
    RootOwnerOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryWritePolicy {
    OwnerOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SymlinkPolicy {
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HardLinkPolicy {
    DenyMultipleLinks,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MountCrossingPolicy {
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpecialFilePolicy {
    RegularFilesAndDirectoriesOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EditTreeOperation {
    CreateDirectory,
    CreateFile,
    DeleteFile,
    RemoveDirectory,
    ReplaceFile,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CreatePolicy {
    Exclusive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DestructivePrecondition {
    ExactIdentityAndSha256,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WriteCommitPolicy {
    FsyncFileRenameFsyncDirectory,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactWriteMode {
    CreateOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactNamePolicy {
    OpaqueUuid,
}

/// Exact HTTPS API origin and TLS identity without a URL path or credential material.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct KubernetesApiServer {
    pub host: String,
    pub port: u16,
    pub tls_server_name: String,
    pub ca_sha256: String,
    pub redirects: KubernetesRedirectPolicy,
}

impl KubernetesApiServer {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_kubernetes_host(&self.host)?;
        validate_kubernetes_host(&self.tls_server_name)?;
        validate_lower_hex_64(&self.ca_sha256)
            .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
        if self.port == 0 {
            return Err(SensitiveLocalProfileError::InvalidField);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesRedirectPolicy {
    Deny,
}

/// Namespaced query/delete authority; writes and delete-collection are unrepresentable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "verb", rename_all = "snake_case", deny_unknown_fields)]
pub enum KubernetesQueryRule {
    Delete {
        resource: KubernetesResource,
        names: Vec<String>,
        precondition: KubernetesDeletePrecondition,
    },
    Get {
        resource: KubernetesResource,
        names: Vec<String>,
    },
    List {
        resource: KubernetesResource,
        selectors: Vec<KubernetesLabelSelector>,
    },
    Watch {
        resource: KubernetesResource,
        selectors: Vec<KubernetesLabelSelector>,
    },
}

impl KubernetesQueryRule {
    fn key(&self) -> String {
        let (verb, resource) = match self {
            Self::Delete { resource, .. } => ("delete", resource),
            Self::Get { resource, .. } => ("get", resource),
            Self::List { resource, .. } => ("list", resource),
            Self::Watch { resource, .. } => ("watch", resource),
        };
        format!("{verb}:{}", kubernetes_resource_name(resource))
    }

    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        match self {
            Self::Delete { names, .. } | Self::Get { names, .. } => {
                validate_kubernetes_names(names)
            }
            Self::List { selectors, .. } | Self::Watch { selectors, .. } => {
                validate_kubernetes_selectors(selectors)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct KubernetesLabelSelector {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesDeletePrecondition {
    ExactUidAndResourceVersion,
}

/// Exact write authority over four fixed object/action shapes; no generic body exists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum KubernetesWriteTemplate {
    CreateConfigMap {
        precondition: KubernetesCreatePrecondition,
        name: String,
        labels: Vec<KubernetesLabel>,
        immutable: KubernetesImmutablePolicy,
        data: Vec<KubernetesConfigMapDataEntry>,
    },
    UpdateConfigMap {
        precondition: KubernetesUpdatePrecondition,
        projection: KubernetesConfigMapUpdateProjection,
        name: String,
        labels: Vec<KubernetesLabel>,
        immutable: KubernetesImmutablePolicy,
        data: Vec<KubernetesConfigMapDataEntry>,
    },
    CreateClusterIpService {
        precondition: KubernetesCreatePrecondition,
        name: String,
        labels: Vec<KubernetesLabel>,
        selectors: Vec<KubernetesLabelSelector>,
        ports: Vec<KubernetesServicePort>,
    },
    UpdateClusterIpService {
        precondition: KubernetesUpdatePrecondition,
        projection: KubernetesServiceUpdateProjection,
        name: String,
        labels: Vec<KubernetesLabel>,
        selectors: Vec<KubernetesLabelSelector>,
        ports: Vec<KubernetesServicePort>,
    },
}

impl KubernetesWriteTemplate {
    fn key(&self) -> String {
        match self {
            Self::CreateConfigMap { name, .. } => format!("create:config_map:{name}"),
            Self::UpdateConfigMap { name, .. } => format!("update:config_map:{name}"),
            Self::CreateClusterIpService { name, .. } => {
                format!("create:cluster_ip_service:{name}")
            }
            Self::UpdateClusterIpService { name, .. } => {
                format!("update:cluster_ip_service:{name}")
            }
        }
    }

    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        match self {
            Self::CreateConfigMap {
                name, labels, data, ..
            }
            | Self::UpdateConfigMap {
                name, labels, data, ..
            } => {
                validate_kubernetes_dns_name(name)?;
                validate_kubernetes_labels(labels)?;
                validate_config_map_data(data)
            }
            Self::CreateClusterIpService {
                name,
                labels,
                selectors,
                ports,
                ..
            }
            | Self::UpdateClusterIpService {
                name,
                labels,
                selectors,
                ports,
                ..
            } => {
                validate_kubernetes_dns_name(name)?;
                validate_kubernetes_labels(labels)?;
                validate_kubernetes_selectors(selectors)?;
                validate_service_ports(ports)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesCreatePrecondition {
    Exclusive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesUpdatePrecondition {
    ExactUidAndResourceVersion,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesImmutablePolicy {
    Required,
}

/// Replace labels only after proving immutable data exactly matches the template.
///
/// A future evaluator must preserve Kubernetes-owned identity metadata and reject annotations,
/// finalizers, owner references, binary data, or any data mismatch.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesConfigMapUpdateProjection {
    ReplaceLabelsVerifyImmutableDataPreserveServerIdentity,
}

/// Replace labels, selectors, and ports while preserving only Kubernetes-owned identity/allocation.
///
/// Allocation is exactly `clusterIP`, `clusterIPs`, `ipFamilies`, and `ipFamilyPolicy`. A future
/// evaluator must require ClusterIP defaults and reject every other unrepresented user-controlled
/// metadata or spec field rather than silently merging it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesServiceUpdateProjection {
    ReplaceLabelsSelectorsAndPortsPreserveServerIdentityAndAllocation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct KubernetesLabel {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct KubernetesConfigMapDataEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct KubernetesServicePort {
    pub name: String,
    pub port: u16,
    pub target_port: u16,
    pub protocol: KubernetesServiceProtocol,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum KubernetesServiceProtocol {
    Tcp,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SensitiveLocalProfileError {
    #[error("sensitive local profile version is unsupported")]
    Version,
    #[error("sensitive local profile payload exceeds its bound")]
    PayloadTooLarge,
    #[error("sensitive local profile encoding is invalid")]
    InvalidEncoding,
    #[error("sensitive local profile encoding is not canonical")]
    NonCanonical,
    #[error("sensitive local profile field is invalid")]
    InvalidField,
    #[error("sensitive local profile lists must be nonempty, sorted, and unique")]
    NonCanonicalList,
}

fn validate_path_limits(
    max_depth: u32,
    max_relative_path_bytes: u32,
    max_component_bytes: u32,
    max_entries: u32,
) -> Result<(), SensitiveLocalProfileError> {
    if max_depth == 0
        || max_depth > MAX_DEPTH
        || max_relative_path_bytes == 0
        || max_relative_path_bytes > MAX_RELATIVE_PATH_BYTES
        || max_component_bytes == 0
        || max_component_bytes > MAX_COMPONENT_BYTES
        || max_entries == 0
        || max_entries > MAX_ENTRIES
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_absolute_root(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value == "/"
        || value.len() < 2
        || value.len() > MAX_ROOT_PATH_BYTES
        || !value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/' | b'@' | b'+')
        })
        || value
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_kubernetes_write_templates(
    templates: &[KubernetesWriteTemplate],
) -> Result<(), SensitiveLocalProfileError> {
    if templates.is_empty() || templates.len() > MAX_KUBERNETES_WRITE_TEMPLATES {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    let mut previous = None;
    for template in templates {
        template.validate()?;
        let key = template.key();
        if previous
            .as_ref()
            .is_some_and(|value: &String| value >= &key)
        {
            return Err(SensitiveLocalProfileError::NonCanonicalList);
        }
        previous = Some(key);
    }
    Ok(())
}

fn validate_kubernetes_labels(
    labels: &[KubernetesLabel],
) -> Result<(), SensitiveLocalProfileError> {
    if labels.len() > MAX_KUBERNETES_LABELS
        || labels.windows(2).any(|pair| pair[0].key >= pair[1].key)
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    for label in labels {
        validate_kubernetes_label_key(&label.key)?;
        validate_kubernetes_label_token(&label.value)?;
    }
    Ok(())
}

fn validate_config_map_data(
    data: &[KubernetesConfigMapDataEntry],
) -> Result<(), SensitiveLocalProfileError> {
    if data.len() > MAX_CONFIG_MAP_DATA_ENTRIES
        || data.windows(2).any(|pair| pair[0].key >= pair[1].key)
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    let mut total = 0usize;
    for entry in data {
        validate_config_map_key(&entry.key)?;
        total = total
            .checked_add(entry.key.len())
            .and_then(|value| value.checked_add(entry.value.len()))
            .ok_or(SensitiveLocalProfileError::InvalidField)?;
    }
    if total > MAX_CONFIG_MAP_DATA_BYTES {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_config_map_key(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.is_empty()
        || value.len() > 253
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_service_ports(
    ports: &[KubernetesServicePort],
) -> Result<(), SensitiveLocalProfileError> {
    if ports.is_empty()
        || ports.len() > MAX_SERVICE_PORTS
        || ports.windows(2).any(|pair| pair[0].name >= pair[1].name)
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    let mut seen_ports = std::collections::BTreeSet::new();
    for port in ports {
        validate_service_port_name(&port.name)?;
        if port.port == 0 || port.target_port == 0 || !seen_ports.insert(port.port) {
            return Err(SensitiveLocalProfileError::InvalidField);
        }
    }
    Ok(())
}

fn validate_service_port_name(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.is_empty()
        || value.len() > 15
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_kubernetes_rules(
    rules: &[KubernetesQueryRule],
) -> Result<(), SensitiveLocalProfileError> {
    if rules.is_empty() || rules.len() > MAX_KUBERNETES_RULES {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    let mut previous = None;
    for rule in rules {
        rule.validate()?;
        let key = rule.key();
        if previous
            .as_ref()
            .is_some_and(|value: &String| value >= &key)
        {
            return Err(SensitiveLocalProfileError::NonCanonicalList);
        }
        previous = Some(key);
    }
    Ok(())
}

fn validate_kubernetes_names(names: &[String]) -> Result<(), SensitiveLocalProfileError> {
    if names.is_empty()
        || names.len() > MAX_KUBERNETES_NAMES
        || names.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    for name in names {
        validate_kubernetes_dns_name(name)?;
    }
    Ok(())
}

fn validate_kubernetes_selectors(
    selectors: &[KubernetesLabelSelector],
) -> Result<(), SensitiveLocalProfileError> {
    if selectors.is_empty()
        || selectors.len() > MAX_KUBERNETES_SELECTORS
        || selectors.windows(2).any(|pair| pair[0].key >= pair[1].key)
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    for selector in selectors {
        validate_kubernetes_label_key(&selector.key)?;
        validate_kubernetes_label_token(&selector.value)?;
    }
    Ok(())
}

fn validate_kubernetes_host(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if let Ok(address) = value.parse::<std::net::IpAddr>() {
        if address.to_string() == value {
            return Ok(());
        }
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    validate_kubernetes_dns_name(value)
}

fn validate_kubernetes_dns_label(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.len() > 63 || value.contains('.') {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    validate_kubernetes_dns_name(value)
}

fn validate_kubernetes_dns_name(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.is_empty()
        || value.len() > 253
        || value.starts_with('.')
        || value.ends_with('.')
        || value.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                || !label.as_bytes()[0].is_ascii_alphanumeric()
                || !label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
        })
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_kubernetes_label_key(value: &str) -> Result<(), SensitiveLocalProfileError> {
    let mut parts = value.split('/');
    let first = parts.next().unwrap_or_default();
    let second = parts.next();
    if parts.next().is_some() {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    match second {
        Some(name) => {
            validate_kubernetes_dns_name(first)?;
            validate_kubernetes_label_token(name)
        }
        None => validate_kubernetes_label_token(first),
    }
}

fn validate_kubernetes_label_token(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.is_empty()
        || value.len() > 63
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn kubernetes_resource_name(resource: &KubernetesResource) -> &'static str {
    match resource {
        KubernetesResource::ConfigMap => "config_map",
        KubernetesResource::Deployment => "deployment",
        KubernetesResource::Job => "job",
        KubernetesResource::Pod => "pod",
        KubernetesResource::Service => "service",
    }
}

fn validate_sorted_unique<T: Ord>(values: &[T]) -> Result<(), SensitiveLocalProfileError> {
    if values.is_empty() || values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    fn root() -> FilesystemRootBinding {
        FilesystemRootBinding {
            canonical_root: "/srv/elpis/project".into(),
            expected_mount_id: 11,
            expected_device: 22,
            expected_inode: 33,
            expected_owner_uid: 1000,
            expected_owner_gid: 1000,
            expected_permissions: 0o750,
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
            id: "project-read".into(),
            profile: SensitiveLocalProfileKindV1::FilesystemRoot {
                root: root(),
                max_depth: 16,
                max_relative_path_bytes: 512,
                max_component_bytes: 120,
                max_entries: 10_000,
            },
        }
    }

    #[test]
    fn exact_canonical_bytes_hash_and_ref_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"id":"project-read","profile":{"kind":"filesystem_root","root":{"canonical_root":"/srv/elpis/project","expected_mount_id":11,"expected_device":22,"expected_inode":33,"expected_owner_uid":1000,"expected_owner_gid":1000,"expected_permissions":488,"entry_ownership":"root_owner_only","entry_writes":"owner_only","symlinks":"deny","hard_links":"deny_multiple_links","mount_crossing":"deny","special_files":"regular_files_and_directories_only"},"max_depth":16,"max_relative_path_bytes":512,"max_component_bytes":120,"max_entries":10000}}"#;
        const GOLDEN_SHA256: &str =
            "2d5355184ef32393327f9298f2e2caa65042f1bcb9a94e8bfdfc6116cd54bc86";

        let bytes = read_profile().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveLocalProfile::parse(&bytes).unwrap();
        assert_eq!(parsed.profile(), &read_profile());
        assert_eq!(parsed.profile_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.profile_sha256(), hex::encode(Sha256::digest(&bytes)));
        assert_eq!(
            parsed.profile_ref(),
            SensitiveProfileRef {
                id: "project-read".into(),
                sha256: GOLDEN_SHA256.into(),
            }
        );
    }

    #[test]
    fn unknown_duplicate_reordered_and_oversized_payloads_fail_closed() {
        let bytes = read_profile().canonical_bytes().unwrap();
        let mut unknown: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        unknown["profile"]["root"]["unknown"] = serde_json::json!(true);
        assert_eq!(
            CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&unknown).unwrap()),
            Err(SensitiveLocalProfileError::InvalidEncoding)
        );
        let duplicate = String::from_utf8(bytes.clone()).unwrap().replacen(
            "\"version\":1",
            "\"version\":1,\"version\":1",
            1,
        );
        assert_eq!(
            CanonicalSensitiveLocalProfile::parse(duplicate.as_bytes()),
            Err(SensitiveLocalProfileError::InvalidEncoding)
        );
        let reordered =
            serde_json::to_vec(&serde_json::from_slice::<serde_json::Value>(&bytes).unwrap())
                .unwrap();
        assert_ne!(reordered, bytes);
        assert_eq!(
            CanonicalSensitiveLocalProfile::parse(&reordered),
            Err(SensitiveLocalProfileError::NonCanonical)
        );
        assert_eq!(
            CanonicalSensitiveLocalProfile::parse(&vec![
                b' ';
                MAX_SENSITIVE_LOCAL_PROFILE_BYTES + 1
            ]),
            Err(SensitiveLocalProfileError::PayloadTooLarge)
        );
    }

    #[test]
    fn deny_only_resolution_policies_reject_widening_strings() {
        let bytes = read_profile().canonical_bytes().unwrap();
        for (field, widened) in [
            ("entry_ownership", "any_owner"),
            ("entry_writes", "group_writable"),
            ("symlinks", "allow"),
            ("hard_links", "allow_multiple_links"),
            ("mount_crossing", "allow"),
            ("special_files", "allow_devices"),
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            value["profile"]["root"][field] = serde_json::json!(widened);
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&value).unwrap()),
                Err(SensitiveLocalProfileError::InvalidEncoding)
            );
        }
    }

    #[test]
    fn root_is_absolute_nonroot_canonical_and_identity_bound() {
        for path in [
            "/",
            "relative/path",
            "/srv//project",
            "/srv/./project",
            "/srv/../project",
            "/srv/project/",
            "/srv/project\\escape",
            "/srv/project/*",
            "/srv/project:stream",
        ] {
            let mut value = read_profile();
            if let SensitiveLocalProfileKindV1::FilesystemRoot { root, .. } = &mut value.profile {
                root.canonical_root = path.into();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
        for field in 0..3 {
            let mut value = read_profile();
            if let SensitiveLocalProfileKindV1::FilesystemRoot { root, .. } = &mut value.profile {
                match field {
                    0 => root.expected_mount_id = 0,
                    1 => root.expected_device = 0,
                    _ => root.expected_inode = 0,
                }
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
        let mut value = read_profile();
        if let SensitiveLocalProfileKindV1::FilesystemRoot { root, .. } = &mut value.profile {
            root.expected_permissions = 0o777;
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );
    }

    #[test]
    fn editable_tree_requires_sorted_operations_safe_modes_and_bounds() {
        let mut value = SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "project-edit".into(),
            profile: SensitiveLocalProfileKindV1::EditableTree {
                root: root(),
                max_depth: 16,
                max_relative_path_bytes: 512,
                max_component_bytes: 120,
                max_entries: 10_000,
                operations: vec![
                    EditTreeOperation::CreateFile,
                    EditTreeOperation::ReplaceFile,
                ],
                create_policy: CreatePolicy::Exclusive,
                replace_policy: DestructivePrecondition::ExactIdentityAndSha256,
                delete_policy: DestructivePrecondition::ExactIdentityAndSha256,
                commit_policy: WriteCommitPolicy::FsyncFileRenameFsyncDirectory,
                created_file_mode: 0o600,
                created_directory_mode: 0o700,
            },
        };
        value.validate().unwrap();
        if let SensitiveLocalProfileKindV1::EditableTree { operations, .. } = &mut value.profile {
            operations.reverse();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );
        if let SensitiveLocalProfileKindV1::EditableTree {
            operations,
            created_file_mode,
            ..
        } = &mut value.profile
        {
            operations.reverse();
            *created_file_mode = 0o666;
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );
    }

    #[test]
    fn edit_write_policies_reject_any_widening_value() {
        let value = SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "project-edit".into(),
            profile: SensitiveLocalProfileKindV1::EditableTree {
                root: root(),
                max_depth: 16,
                max_relative_path_bytes: 512,
                max_component_bytes: 120,
                max_entries: 10_000,
                operations: vec![EditTreeOperation::ReplaceFile],
                create_policy: CreatePolicy::Exclusive,
                replace_policy: DestructivePrecondition::ExactIdentityAndSha256,
                delete_policy: DestructivePrecondition::ExactIdentityAndSha256,
                commit_policy: WriteCommitPolicy::FsyncFileRenameFsyncDirectory,
                created_file_mode: 0o600,
                created_directory_mode: 0o700,
            },
        };
        let bytes = value.canonical_bytes().unwrap();
        for (field, widened) in [
            ("create_policy", "overwrite"),
            ("replace_policy", "no_precondition"),
            ("delete_policy", "path_only"),
            ("commit_policy", "direct_write"),
        ] {
            let mut widened_value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            widened_value["profile"][field] = serde_json::json!(widened);
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&widened_value).unwrap()),
                Err(SensitiveLocalProfileError::InvalidEncoding)
            );
        }
    }

    #[test]
    fn artifact_custody_is_create_only_opaque_named_and_bounded() {
        let mut artifact_root = root();
        artifact_root.expected_permissions = 0o700;
        let mut value = SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "review-artifacts".into(),
            profile: SensitiveLocalProfileKindV1::ArtifactCustody {
                root: artifact_root,
                write_mode: ArtifactWriteMode::CreateOnly,
                name_policy: ArtifactNamePolicy::OpaqueUuid,
                created_file_mode: 0o600,
                max_files: 4,
                max_single_file_bytes: 1024,
                max_total_bytes: 4096,
            },
        };
        value.validate().unwrap();
        if let SensitiveLocalProfileKindV1::ArtifactCustody {
            max_single_file_bytes,
            max_total_bytes,
            ..
        } = &mut value.profile
        {
            *max_single_file_bytes = *max_total_bytes + 1;
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );
    }

    fn kubernetes_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "cluster-query".into(),
            profile: SensitiveLocalProfileKindV1::KubernetesCluster {
                api_server: KubernetesApiServer {
                    host: "api.cluster.example".into(),
                    port: 6443,
                    tls_server_name: "api.cluster.example".into(),
                    ca_sha256: "a".repeat(64),
                    redirects: KubernetesRedirectPolicy::Deny,
                },
                credential_profile: SensitiveProfileRef {
                    id: "cluster-credential".into(),
                    sha256: "b".repeat(64),
                },
                namespace: "elpis-workers".into(),
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
                            KubernetesLabelSelector {
                                key: "app.kubernetes.io/name".into(),
                                value: "elpis-worker".into(),
                            },
                            KubernetesLabelSelector {
                                key: "elpis.dev/mind".into(),
                                value: "elm-34v9m41b".into(),
                            },
                        ],
                    },
                    KubernetesQueryRule::Watch {
                        resource: KubernetesResource::Service,
                        selectors: vec![KubernetesLabelSelector {
                            key: "app".into(),
                            value: "elpis".into(),
                        }],
                    },
                ],
                max_request_bytes: 64 * 1024,
                max_response_bytes: 1024 * 1024,
            },
        }
    }

    #[test]
    fn kubernetes_query_canonical_bytes_and_hash_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"id":"cluster-query","profile":{"kind":"kubernetes_cluster","api_server":{"host":"api.cluster.example","port":6443,"tls_server_name":"api.cluster.example","ca_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","redirects":"deny"},"credential_profile":{"id":"cluster-credential","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"namespace":"elpis-workers","rules":[{"verb":"delete","resource":"config_map","names":["worker-lock"],"precondition":"exact_uid_and_resource_version"},{"verb":"get","resource":"pod","names":["worker-a","worker-b"]},{"verb":"list","resource":"pod","selectors":[{"key":"app.kubernetes.io/name","value":"elpis-worker"},{"key":"elpis.dev/mind","value":"elm-34v9m41b"}]},{"verb":"watch","resource":"service","selectors":[{"key":"app","value":"elpis"}]}],"max_request_bytes":65536,"max_response_bytes":1048576}}"#;
        const GOLDEN_SHA256: &str =
            "6338334f1357aa71545bd157b06d770aab5126d038d7f77f63aaaf69212909d3";

        let bytes = kubernetes_profile().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveLocalProfile::parse(&bytes).unwrap();
        assert_eq!(parsed.profile(), &kubernetes_profile());
        assert_eq!(parsed.profile_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.profile_sha256(), hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn kubernetes_query_scope_is_nonempty_sorted_unique_and_bounded() {
        kubernetes_profile().validate().unwrap();

        let mut value = kubernetes_profile();
        if let SensitiveLocalProfileKindV1::KubernetesCluster { rules, .. } = &mut value.profile {
            rules.reverse();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_profile();
        if let SensitiveLocalProfileKindV1::KubernetesCluster { rules, .. } = &mut value.profile
            && let KubernetesQueryRule::Get { names, .. } = &mut rules[1]
        {
            names.push("worker-b".into());
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_profile();
        if let SensitiveLocalProfileKindV1::KubernetesCluster { rules, .. } = &mut value.profile
            && let KubernetesQueryRule::List { selectors, .. } = &mut rules[2]
        {
            selectors.reverse();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_profile();
        if let SensitiveLocalProfileKindV1::KubernetesCluster { rules, .. } = &mut value.profile
            && let KubernetesQueryRule::List { selectors, .. } = &mut rules[2]
        {
            selectors.push(KubernetesLabelSelector {
                key: "elpis.dev/mind".into(),
                value: "another".into(),
            });
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        for (request, response) in [
            (0, 1024),
            (MAX_KUBERNETES_REQUEST_BYTES + 1, 1024),
            (1024, 0),
            (1024, MAX_KUBERNETES_RESPONSE_BYTES + 1),
        ] {
            let mut value = kubernetes_profile();
            if let SensitiveLocalProfileKindV1::KubernetesCluster {
                max_request_bytes,
                max_response_bytes,
                ..
            } = &mut value.profile
            {
                *max_request_bytes = request;
                *max_response_bytes = response;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
    }

    #[test]
    fn kubernetes_cluster_and_credential_identity_fail_closed() {
        for host in [
            "https://api.cluster.example",
            "API.cluster.example",
            "api.cluster.example.",
            "api..cluster.example",
            "2001:0db8::1",
        ] {
            let mut value = kubernetes_profile();
            if let SensitiveLocalProfileKindV1::KubernetesCluster { api_server, .. } =
                &mut value.profile
            {
                api_server.host = host.into();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        for namespace in [
            "Default",
            "default/other",
            ".default",
            "default.",
            "team.prod",
        ] {
            let mut value = kubernetes_profile();
            if let SensitiveLocalProfileKindV1::KubernetesCluster {
                namespace: field, ..
            } = &mut value.profile
            {
                *field = namespace.into();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let mut value = kubernetes_profile();
        if let SensitiveLocalProfileKindV1::KubernetesCluster {
            api_server,
            credential_profile,
            ..
        } = &mut value.profile
        {
            api_server.port = 0;
            credential_profile.id = "../credential".into();
            credential_profile.sha256 = "A".repeat(64);
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        let mut value = kubernetes_profile();
        if let SensitiveLocalProfileKindV1::KubernetesCluster { api_server, .. } =
            &mut value.profile
        {
            api_server.host = "2001:db8::1".into();
            api_server.tls_server_name = "10.42.0.1".into();
        }
        value.validate().unwrap();
    }

    #[test]
    fn kubernetes_query_grammar_rejects_wildcards_and_widening() {
        for bad in ["*", "pod/*", "-leading", "trailing-", "UPPER"] {
            let mut value = kubernetes_profile();
            if let SensitiveLocalProfileKindV1::KubernetesCluster { rules, .. } = &mut value.profile
                && let KubernetesQueryRule::Get { names, .. } = &mut rules[1]
            {
                names.clear();
                names.push(bad.into());
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        for (key, selector_value) in [
            ("*", "worker"),
            ("app//name", "worker"),
            ("App/name", "worker"),
            ("app/name", ""),
            ("app/name", "wild*card"),
        ] {
            let mut value = kubernetes_profile();
            if let SensitiveLocalProfileKindV1::KubernetesCluster { rules, .. } = &mut value.profile
                && let KubernetesQueryRule::Watch { selectors, .. } = &mut rules[3]
            {
                selectors[0] = KubernetesLabelSelector {
                    key: key.into(),
                    value: selector_value.into(),
                };
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let bytes = kubernetes_profile().canonical_bytes().unwrap();
        for mutation in [
            "secret_resource",
            "patch_verb",
            "weak_delete",
            "url_path",
            "redirects",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            match mutation {
                "secret_resource" => {
                    value["profile"]["rules"][0]["resource"] = serde_json::json!("secret")
                }
                "patch_verb" => value["profile"]["rules"][1]["verb"] = serde_json::json!("patch"),
                "weak_delete" => {
                    value["profile"]["rules"][0]["precondition"] = serde_json::json!("none")
                }
                "url_path" => value["profile"]["api_server"]["path"] = serde_json::json!("/api/v1"),
                _ => value["profile"]["api_server"]["redirects"] = serde_json::json!("follow"),
            }
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&value).unwrap()),
                Err(SensitiveLocalProfileError::InvalidEncoding)
            );
        }
    }

    fn kubernetes_write_profile() -> SensitiveLocalProfileV1 {
        let service_labels = vec![
            KubernetesLabel {
                key: "app".into(),
                value: "api".into(),
            },
            KubernetesLabel {
                key: "app.kubernetes.io/managed-by".into(),
                value: "elpis".into(),
            },
        ];
        let selectors = vec![KubernetesLabelSelector {
            key: "app".into(),
            value: "api".into(),
        }];
        let ports = vec![KubernetesServicePort {
            name: "https".into(),
            port: 443,
            target_port: 8443,
            protocol: KubernetesServiceProtocol::Tcp,
        }];
        let config_labels = vec![KubernetesLabel {
            key: "app".into(),
            value: "settings".into(),
        }];
        let data = vec![
            KubernetesConfigMapDataEntry {
                key: "config.toml".into(),
                value: "mode = \"safe\"\n".into(),
            },
            KubernetesConfigMapDataEntry {
                key: "generation".into(),
                value: "1".into(),
            },
        ];
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "cluster-writes".into(),
            profile: SensitiveLocalProfileKindV1::KubernetesObjectTemplates {
                cluster_profile: SensitiveProfileRef {
                    id: "cluster-query".into(),
                    sha256: "c".repeat(64),
                },
                templates: vec![
                    KubernetesWriteTemplate::CreateClusterIpService {
                        precondition: KubernetesCreatePrecondition::Exclusive,
                        name: "api".into(),
                        labels: service_labels.clone(),
                        selectors: selectors.clone(),
                        ports: ports.clone(),
                    },
                    KubernetesWriteTemplate::CreateConfigMap {
                        precondition: KubernetesCreatePrecondition::Exclusive,
                        name: "settings".into(),
                        labels: config_labels.clone(),
                        immutable: KubernetesImmutablePolicy::Required,
                        data: data.clone(),
                    },
                    KubernetesWriteTemplate::UpdateClusterIpService {
                        precondition: KubernetesUpdatePrecondition::ExactUidAndResourceVersion,
                        projection: KubernetesServiceUpdateProjection::ReplaceLabelsSelectorsAndPortsPreserveServerIdentityAndAllocation,
                        name: "api".into(),
                        labels: service_labels,
                        selectors,
                        ports,
                    },
                    KubernetesWriteTemplate::UpdateConfigMap {
                        precondition: KubernetesUpdatePrecondition::ExactUidAndResourceVersion,
                        projection: KubernetesConfigMapUpdateProjection::ReplaceLabelsVerifyImmutableDataPreserveServerIdentity,
                        name: "settings".into(),
                        labels: config_labels,
                        immutable: KubernetesImmutablePolicy::Required,
                        data,
                    },
                ],
            },
        }
    }

    #[test]
    fn kubernetes_write_template_bytes_and_hash_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"id":"cluster-writes","profile":{"kind":"kubernetes_object_templates","cluster_profile":{"id":"cluster-query","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},"templates":[{"action":"create_cluster_ip_service","precondition":"exclusive","name":"api","labels":[{"key":"app","value":"api"},{"key":"app.kubernetes.io/managed-by","value":"elpis"}],"selectors":[{"key":"app","value":"api"}],"ports":[{"name":"https","port":443,"target_port":8443,"protocol":"tcp"}]},{"action":"create_config_map","precondition":"exclusive","name":"settings","labels":[{"key":"app","value":"settings"}],"immutable":"required","data":[{"key":"config.toml","value":"mode = \"safe\"\n"},{"key":"generation","value":"1"}]},{"action":"update_cluster_ip_service","precondition":"exact_uid_and_resource_version","projection":"replace_labels_selectors_and_ports_preserve_server_identity_and_allocation","name":"api","labels":[{"key":"app","value":"api"},{"key":"app.kubernetes.io/managed-by","value":"elpis"}],"selectors":[{"key":"app","value":"api"}],"ports":[{"name":"https","port":443,"target_port":8443,"protocol":"tcp"}]},{"action":"update_config_map","precondition":"exact_uid_and_resource_version","projection":"replace_labels_verify_immutable_data_preserve_server_identity","name":"settings","labels":[{"key":"app","value":"settings"}],"immutable":"required","data":[{"key":"config.toml","value":"mode = \"safe\"\n"},{"key":"generation","value":"1"}]}]}}"#;
        const GOLDEN_SHA256: &str =
            "9cac3d3c62a52e2a26b7ffce5e7cec72451c589b74fc871b195b9930ecea0aff";

        let bytes = kubernetes_write_profile().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveLocalProfile::parse(&bytes).unwrap();
        assert_eq!(parsed.profile(), &kubernetes_write_profile());
        assert_eq!(parsed.profile_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.profile_sha256(), hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn kubernetes_write_templates_and_cluster_ref_are_exact_sorted_and_unique() {
        kubernetes_write_profile().validate().unwrap();

        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
        {
            templates.reverse();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
        {
            templates.push(templates.last().unwrap().clone());
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        for count in [0, MAX_KUBERNETES_WRITE_TEMPLATES + 1] {
            let mut value = kubernetes_write_profile();
            if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
                &mut value.profile
            {
                *templates = (0..count)
                    .map(|index| KubernetesWriteTemplate::CreateConfigMap {
                        precondition: KubernetesCreatePrecondition::Exclusive,
                        name: format!("cm-{index:02}"),
                        labels: vec![],
                        immutable: KubernetesImmutablePolicy::Required,
                        data: vec![],
                    })
                    .collect();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        for (id, sha256) in [
            ("../cluster", "c".repeat(64)),
            ("cluster-query", "C".repeat(64)),
        ] {
            let mut value = kubernetes_write_profile();
            if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates {
                cluster_profile, ..
            } = &mut value.profile
            {
                cluster_profile.id = id.into();
                cluster_profile.sha256 = sha256;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
    }

    #[test]
    fn config_map_templates_require_exact_immutable_sorted_bounded_data() {
        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
            && let KubernetesWriteTemplate::CreateConfigMap { data, .. } = &mut templates[1]
        {
            data.reverse();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
            && let KubernetesWriteTemplate::CreateConfigMap { labels, .. } = &mut templates[1]
        {
            labels.push(labels[0].clone());
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
            && let KubernetesWriteTemplate::CreateConfigMap { labels, .. } = &mut templates[1]
        {
            *labels = (0..=MAX_KUBERNETES_LABELS)
                .map(|index| KubernetesLabel {
                    key: format!("label-{index:02}"),
                    value: "value".into(),
                })
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
            && let KubernetesWriteTemplate::CreateConfigMap { data, .. } = &mut templates[1]
        {
            *data = (0..=MAX_CONFIG_MAP_DATA_ENTRIES)
                .map(|index| KubernetesConfigMapDataEntry {
                    key: format!("key-{index:02}"),
                    value: String::new(),
                })
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        for (key, data_value) in [
            ("bad/key", "ok".into()),
            ("config", "x".repeat(MAX_CONFIG_MAP_DATA_BYTES + 1)),
        ] {
            let mut value = kubernetes_write_profile();
            if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
                &mut value.profile
                && let KubernetesWriteTemplate::CreateConfigMap { data, .. } = &mut templates[1]
            {
                data.clear();
                data.push(KubernetesConfigMapDataEntry {
                    key: key.into(),
                    value: data_value,
                });
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
    }

    #[test]
    fn cluster_ip_service_templates_require_exact_selectors_and_tcp_ports() {
        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
            && let KubernetesWriteTemplate::CreateClusterIpService { selectors, .. } =
                &mut templates[0]
        {
            selectors.clear();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
            && let KubernetesWriteTemplate::CreateClusterIpService { ports, .. } = &mut templates[0]
        {
            ports.push(KubernetesServicePort {
                name: "web".into(),
                port: 443,
                target_port: 8080,
                protocol: KubernetesServiceProtocol::Tcp,
            });
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        let mut value = kubernetes_write_profile();
        if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
            &mut value.profile
            && let KubernetesWriteTemplate::CreateClusterIpService { ports, .. } = &mut templates[0]
        {
            *ports = (0..=MAX_SERVICE_PORTS)
                .map(|index| KubernetesServicePort {
                    name: format!("p{index:02}"),
                    port: 10_000 + index as u16,
                    target_port: 20_000 + index as u16,
                    protocol: KubernetesServiceProtocol::Tcp,
                })
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        for (name, port, target_port) in [("UPPER", 80, 8080), ("web", 0, 8080), ("web", 80, 0)] {
            let mut value = kubernetes_write_profile();
            if let SensitiveLocalProfileKindV1::KubernetesObjectTemplates { templates, .. } =
                &mut value.profile
                && let KubernetesWriteTemplate::CreateClusterIpService { ports, .. } =
                    &mut templates[0]
            {
                ports[0].name = name.into();
                ports[0].port = port;
                ports[0].target_port = target_port;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
    }

    #[test]
    fn kubernetes_write_grammar_rejects_workloads_patch_and_service_widening() {
        let bytes = kubernetes_write_profile().canonical_bytes().unwrap();
        for mutation in [
            "pod_action",
            "patch_action",
            "weak_create",
            "weak_update",
            "weak_projection",
            "mutable_config_map",
            "binary_data",
            "annotations",
            "node_port",
            "external_name",
            "load_balancer",
            "cluster_ip",
            "generic_body",
            "udp",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            match mutation {
                "pod_action" => {
                    value["profile"]["templates"][0]["action"] = serde_json::json!("create_pod")
                }
                "patch_action" => {
                    value["profile"]["templates"][0]["action"] = serde_json::json!("patch")
                }
                "weak_create" => {
                    value["profile"]["templates"][0]["precondition"] =
                        serde_json::json!("overwrite")
                }
                "weak_update" => {
                    value["profile"]["templates"][2]["precondition"] =
                        serde_json::json!("resource_version_only")
                }
                "weak_projection" => {
                    value["profile"]["templates"][2]["projection"] = serde_json::json!("merge")
                }
                "mutable_config_map" => {
                    value["profile"]["templates"][1]["immutable"] = serde_json::json!("allow")
                }
                "binary_data" => {
                    value["profile"]["templates"][1]["binary_data"] = serde_json::json!({})
                }
                "annotations" => {
                    value["profile"]["templates"][0]["annotations"] = serde_json::json!({})
                }
                "node_port" => {
                    value["profile"]["templates"][0]["node_port"] = serde_json::json!(30443)
                }
                "external_name" => {
                    value["profile"]["templates"][0]["external_name"] =
                        serde_json::json!("outside.example")
                }
                "load_balancer" => {
                    value["profile"]["templates"][0]["load_balancer_ip"] =
                        serde_json::json!("203.0.113.1")
                }
                "cluster_ip" => {
                    value["profile"]["templates"][0]["cluster_ip"] = serde_json::json!("10.43.0.10")
                }
                "generic_body" => {
                    value["profile"]["templates"][0]["body"] =
                        serde_json::json!({"spec":{"hostNetwork":true}})
                }
                _ => {
                    value["profile"]["templates"][0]["ports"][0]["protocol"] =
                        serde_json::json!("udp")
                }
            }
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&value).unwrap()),
                Err(SensitiveLocalProfileError::InvalidEncoding)
            );
        }
    }
}
