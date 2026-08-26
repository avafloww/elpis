//! Canonical local sensitive-profile artifacts.
//!
//! These bytes describe checks a later evaluator must perform. Parsing them does not inspect the
//! filesystem, resolve a path, inspect credentials, perform TLS, contact Kubernetes, evaluate a
//! request, prevent TOCTOU, or prove confinement.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    KubernetesResource, NetworkMethod, PackageOperation, SensitiveProfileRef, ServiceAction,
    sha256_hex, validate_id, validate_lower_hex_64,
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
const MAX_NETWORK_ADDRESSES: usize = 16;
const MAX_NETWORK_TLS_PINS: usize = 8;
const MAX_NETWORK_ROUTES: usize = 32;
const MAX_NETWORK_CONTENT_TYPES: usize = 3;
const MAX_NETWORK_PATH_BYTES: usize = 256;
const MAX_NETWORK_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_NETWORK_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SERVICE_UNITS: usize = 32;
const MAX_SERVICE_UNIT_NAME_BYTES: usize = 128;
const MAX_PACKAGE_NAMES: usize = 128;
const MAX_PACKAGE_NAME_BYTES: usize = 128;
const MAX_REMOTE_ACTIONS: usize = 32;
const MAX_REMOTE_ARGV_ITEMS: usize = 64;
const MAX_REMOTE_ARG_BYTES: usize = 4096;
const MAX_REMOTE_ARGV_BYTES: usize = 65_536;
const MAX_REMOTE_TIMEOUT_MS: u64 = 300_000;
const MAX_REMOTE_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_PROFILE_IO_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

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
    NetworkEndpoint {
        origin: NetworkHttpsOrigin,
        address_policy: NetworkAddressPolicy,
        tls: NetworkTlsPolicy,
        routes: Vec<NetworkRouteRule>,
        request_headers: NetworkRequestHeaderPolicy,
        response_encoding: NetworkResponseEncodingPolicy,
        redirects: NetworkRedirectPolicy,
        max_request_bytes: u64,
        max_response_bytes: u64,
    },
    ServiceManager {
        manager: ServiceManagerKind,
        scope: ServiceManagerScope,
        unit_resolution: ServiceUnitResolutionPolicy,
        units: Vec<ServiceUnitRule>,
    },
    PackageTransaction {
        manager: PackageManagerKind,
        target_root: SensitiveProfileRef,
        repository_endpoint: SensitiveProfileRef,
        repository_snapshot: PackageRepositorySnapshot,
        operations: Vec<PackageOperation>,
        packages: Vec<PackageSelection>,
        dependencies: PackageDependencyPolicy,
        maintainer_scripts: PackageMaintainerScriptPolicy,
        configuration: PackageConfigurationPolicy,
        /// Conservative whole-effect read ceiling for pre-effect reservation.
        max_io_read_bytes: u64,
        /// Conservative whole-effect write ceiling for pre-effect reservation.
        max_io_write_bytes: u64,
    },
    RemoteActions {
        actions: Vec<RemoteActionRule>,
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
            Self::NetworkEndpoint {
                origin,
                address_policy,
                tls,
                routes,
                max_request_bytes,
                max_response_bytes,
                ..
            } => {
                origin.validate()?;
                address_policy.validate()?;
                tls.validate()?;
                if tls.server_name != origin.host
                    || origin
                        .host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|address| {
                            !address_policy.addresses.contains(&address.to_string())
                        })
                {
                    return Err(SensitiveLocalProfileError::InvalidField);
                }
                validate_network_routes(routes)?;
                if *max_request_bytes == 0
                    || *max_request_bytes > MAX_NETWORK_REQUEST_BYTES
                    || *max_response_bytes == 0
                    || *max_response_bytes > MAX_NETWORK_RESPONSE_BYTES
                {
                    return Err(SensitiveLocalProfileError::InvalidField);
                }
                Ok(())
            }
            Self::ServiceManager { scope, units, .. } => {
                scope.validate()?;
                validate_service_unit_rules(units)
            }
            Self::PackageTransaction {
                target_root,
                repository_endpoint,
                repository_snapshot,
                operations,
                packages,
                max_io_read_bytes,
                max_io_write_bytes,
                ..
            } => {
                target_root
                    .validate()
                    .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
                repository_endpoint
                    .validate()
                    .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
                repository_snapshot.validate()?;
                validate_package_operations(operations)?;
                validate_package_names(packages)?;
                validate_profile_io_bounds(*max_io_read_bytes, *max_io_write_bytes)
            }
            Self::RemoteActions { actions } => validate_remote_actions(actions),
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

/// One exact HTTPS origin; paths, queries, userinfo, and credentials cannot be encoded here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NetworkHttpsOrigin {
    pub protocol: NetworkProtocol,
    pub host: String,
    pub port: u16,
}

impl NetworkHttpsOrigin {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_network_host(&self.host)?;
        if self.port == 0 {
            return Err(SensitiveLocalProfileError::InvalidField);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkProtocol {
    Https,
}

/// DNS may discover addresses, but only a direct no-proxy connection to this exact set is valid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NetworkAddressPolicy {
    pub mode: NetworkAddressMode,
    pub addresses: Vec<String>,
}

impl NetworkAddressPolicy {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        if self.addresses.is_empty()
            || self.addresses.len() > MAX_NETWORK_ADDRESSES
            || self.addresses.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(SensitiveLocalProfileError::NonCanonicalList);
        }
        for value in &self.addresses {
            let address = value
                .parse::<std::net::IpAddr>()
                .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
            if address.to_string() != *value {
                return Err(SensitiveLocalProfileError::InvalidField);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkAddressMode {
    DirectConnectOnlyPinnedNoProxy,
}

/// TLS must satisfy hostname/validity checks and both exact pin families, without fallback trust.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NetworkTlsPolicy {
    pub server_name: String,
    pub minimum_version: NetworkTlsVersion,
    pub verification: NetworkTlsVerification,
    /// Exact accepted trust-anchor certificate DER hashes; no other trust store is consulted.
    pub ca_certificate_sha256: Vec<String>,
    /// Exact accepted leaf SubjectPublicKeyInfo hashes.
    pub leaf_spki_sha256: Vec<String>,
}

impl NetworkTlsPolicy {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_network_host(&self.server_name)?;
        validate_network_hashes(&self.ca_certificate_sha256)?;
        validate_network_hashes(&self.leaf_spki_sha256)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkTlsVersion {
    Tls13,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkTlsVerification {
    PinnedCaAndLeafSpkiWithHostnameAndValidity,
}

/// One method at one canonical segment-prefix, with exact request/response body grammar.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NetworkRouteRule {
    pub path_prefix: String,
    pub method: NetworkMethod,
    pub query: NetworkQueryPolicy,
    pub request_body: NetworkRequestBodyPolicy,
    pub response_content_types: Vec<NetworkContentType>,
}

impl NetworkRouteRule {
    fn key(&self) -> String {
        format!("{}:{}", self.path_prefix, network_method_name(self.method))
    }

    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_network_path_prefix(&self.path_prefix)?;
        self.request_body.validate()?;
        validate_network_content_types(&self.response_content_types)?;
        if matches!(self.method, NetworkMethod::Get | NetworkMethod::Head)
            && !matches!(self.request_body, NetworkRequestBodyPolicy::Forbidden)
        {
            return Err(SensitiveLocalProfileError::InvalidField);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum NetworkRequestBodyPolicy {
    Forbidden,
    Allowed {
        content_types: Vec<NetworkContentType>,
    },
}

impl NetworkRequestBodyPolicy {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        match self {
            Self::Forbidden => Ok(()),
            Self::Allowed { content_types } => validate_network_content_types(content_types),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum NetworkContentType {
    #[serde(rename = "application/json")]
    ApplicationJson,
    #[serde(rename = "application/octet-stream")]
    ApplicationOctetStream,
    #[serde(rename = "text/plain;charset=utf-8")]
    TextPlainUtf8,
}

/// A future evaluator generates `Host` from the origin and may add only a validated Content-Type.
/// Caller-supplied authorization, cookie, proxy, forwarding, override, and custom headers are absent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkRequestHeaderPolicy {
    GeneratedHostAndAllowedContentTypeOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkQueryPolicy {
    Forbidden,
}

/// Reject compressed content so the response cap applies to the exact received body bytes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkResponseEncodingPolicy {
    IdentityOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkRedirectPolicy {
    Deny,
}

/// Exact systemd D-Bus authority. No manager executable or command string is represented.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceManagerKind {
    SystemdDbus,
}

/// The manager must return the same canonical unit name requested; aliases are not accepted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceUnitResolutionPolicy {
    ExactCanonicalNameNoAlias,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServiceManagerScope {
    System,
    User { uid: u32 },
}

impl ServiceManagerScope {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        match self {
            Self::System => Ok(()),
            Self::User { uid } if *uid > 0 => Ok(()),
            Self::User { .. } => Err(SensitiveLocalProfileError::InvalidField),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ServiceUnitRule {
    pub unit: String,
    pub actions: Vec<ServiceAction>,
}

impl ServiceUnitRule {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_service_unit_name(&self.unit)?;
        if self.actions.is_empty() || self.actions.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(SensitiveLocalProfileError::NonCanonicalList);
        }
        Ok(())
    }
}

/// Repository artifacts are fetched through the separately joined endpoint, then consumed offline.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageManagerKind {
    DebianAptDpkgOffline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PackageRepositorySnapshot {
    /// Exact signed repository metadata bytes; package archive hashes are derived from this snapshot.
    pub metadata_sha256: String,
    /// Exact public signing-key bytes accepted to verify the snapshot signature.
    pub signing_key_sha256: String,
}

impl PackageRepositorySnapshot {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_lower_hex_64(&self.metadata_sha256)
            .and_then(|_| validate_lower_hex_64(&self.signing_key_sha256))
            .map_err(|_| SensitiveLocalProfileError::InvalidField)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PackageSelection {
    pub name: String,
    pub version: String,
    pub architecture: PackageArchitecture,
    /// Exact package archive bytes; must also match the pinned snapshot metadata.
    pub archive_sha256: String,
}

impl PackageSelection {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_package_name(&self.name)?;
        validate_package_version(&self.version)?;
        validate_lower_hex_64(&self.archive_sha256)
            .map_err(|_| SensitiveLocalProfileError::InvalidField)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageArchitecture {
    Amd64,
    Arm64,
    I386,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageDependencyPolicy {
    ExactListedPackagesOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageMaintainerScriptPolicy {
    Forbidden,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageConfigurationPolicy {
    FailOnPromptOrConffileChange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteActionRule {
    pub id: String,
    pub execution: RemoteExecutionMode,
    pub executable_path: String,
    pub executable_sha256: String,
    pub argv: Vec<String>,
    pub environment: RemoteEnvironmentPolicy,
    pub cwd_profile: SensitiveProfileRef,
    pub uid: u32,
    pub gid: u32,
    pub capabilities: Vec<RemoteLinuxCapability>,
    pub stdin: RemoteStdinPolicy,
    pub no_new_privileges: RemoteNoNewPrivilegesPolicy,
    pub timeout_ms: u64,
    pub max_stdout_bytes: u64,
    pub max_stderr_bytes: u64,
    /// Conservative whole-effect read ceiling for pre-effect reservation.
    pub max_io_read_bytes: u64,
    /// Conservative whole-effect write ceiling for pre-effect reservation.
    pub max_io_write_bytes: u64,
}

impl RemoteActionRule {
    fn validate(&self) -> Result<(), SensitiveLocalProfileError> {
        validate_id(&self.id).map_err(|_| SensitiveLocalProfileError::InvalidField)?;
        validate_absolute_root(&self.executable_path)?;
        validate_lower_hex_64(&self.executable_sha256)
            .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
        self.cwd_profile
            .validate()
            .map_err(|_| SensitiveLocalProfileError::InvalidField)?;
        validate_remote_argv(&self.argv, &self.executable_path)?;
        if self.uid == 0
            || self.gid == 0
            || self.capabilities.windows(2).any(|pair| pair[0] >= pair[1])
            || self.timeout_ms == 0
            || self.timeout_ms > MAX_REMOTE_TIMEOUT_MS
            || self.max_stdout_bytes == 0
            || self.max_stdout_bytes > MAX_REMOTE_OUTPUT_BYTES
            || self.max_stderr_bytes == 0
            || self.max_stderr_bytes > MAX_REMOTE_OUTPUT_BYTES
        {
            return Err(SensitiveLocalProfileError::InvalidField);
        }
        validate_profile_io_bounds(self.max_io_read_bytes, self.max_io_write_bytes)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteExecutionMode {
    DirectNativeElfNoShellOrInterpreter,
}

/// The process receives an empty environment plus only these fixed nonsecret values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteEnvironmentPolicy {
    pub mode: RemoteEnvironmentMode,
    pub locale: RemoteLocale,
    pub timezone: RemoteTimezone,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteEnvironmentMode {
    ClearThenSetFixed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RemoteLocale {
    #[serde(rename = "C.UTF-8")]
    CUtf8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RemoteTimezone {
    #[serde(rename = "UTC")]
    Utc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RemoteLinuxCapability {
    CapNetBindService,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteStdinPolicy {
    Closed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteNoNewPrivilegesPolicy {
    Required,
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

fn validate_profile_io_bounds(
    max_io_read_bytes: u64,
    max_io_write_bytes: u64,
) -> Result<(), SensitiveLocalProfileError> {
    if max_io_read_bytes == 0
        || max_io_read_bytes > MAX_PROFILE_IO_BYTES
        || max_io_write_bytes == 0
        || max_io_write_bytes > MAX_PROFILE_IO_BYTES
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_remote_actions(actions: &[RemoteActionRule]) -> Result<(), SensitiveLocalProfileError> {
    if actions.is_empty()
        || actions.len() > MAX_REMOTE_ACTIONS
        || actions.windows(2).any(|pair| pair[0].id >= pair[1].id)
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    for action in actions {
        action.validate()?;
    }
    Ok(())
}

fn validate_remote_argv(
    argv: &[String],
    executable_path: &str,
) -> Result<(), SensitiveLocalProfileError> {
    if argv.is_empty() || argv.len() > MAX_REMOTE_ARGV_ITEMS || argv[0] != executable_path {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    let mut total = 0usize;
    for argument in argv {
        if argument.len() > MAX_REMOTE_ARG_BYTES
            || argument.contains('\0')
            || argument.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(SensitiveLocalProfileError::InvalidField);
        }
        total = total
            .checked_add(argument.len())
            .ok_or(SensitiveLocalProfileError::InvalidField)?;
    }
    if total > MAX_REMOTE_ARGV_BYTES {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_package_operations(
    operations: &[PackageOperation],
) -> Result<(), SensitiveLocalProfileError> {
    if operations.is_empty() || operations.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    Ok(())
}

fn validate_package_names(packages: &[PackageSelection]) -> Result<(), SensitiveLocalProfileError> {
    if packages.is_empty()
        || packages.len() > MAX_PACKAGE_NAMES
        || packages.windows(2).any(|pair| pair[0].name >= pair[1].name)
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    for package in packages {
        package.validate()?;
    }
    Ok(())
}

fn validate_package_name(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.is_empty()
        || value.len() > MAX_PACKAGE_NAME_BYTES
        || !value.as_bytes()[0].is_ascii_lowercase()
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.')
        })
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_package_version(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.is_empty()
        || value.len() > MAX_PACKAGE_NAME_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b':' | b'~' | b'-')
        })
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_service_unit_rules(
    units: &[ServiceUnitRule],
) -> Result<(), SensitiveLocalProfileError> {
    if units.is_empty()
        || units.len() > MAX_SERVICE_UNITS
        || units.windows(2).any(|pair| pair[0].unit >= pair[1].unit)
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    for unit in units {
        unit.validate()?;
    }
    Ok(())
}

fn validate_service_unit_name(value: &str) -> Result<(), SensitiveLocalProfileError> {
    let Some(stem) = value.strip_suffix(".service") else {
        return Err(SensitiveLocalProfileError::InvalidField);
    };
    if value.len() > MAX_SERVICE_UNIT_NAME_BYTES
        || stem.is_empty()
        || stem.starts_with(['-', '.', '_', '@'])
        || stem.ends_with(['-', '.', '_', '@'])
        || stem.contains("..")
        || stem.matches('@').count() > 1
        || !stem.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'-' | b'.' | b'_' | b'@')
        })
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn validate_network_routes(routes: &[NetworkRouteRule]) -> Result<(), SensitiveLocalProfileError> {
    if routes.is_empty() || routes.len() > MAX_NETWORK_ROUTES {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    let mut previous_key = None;
    let mut prefixes = Vec::new();
    for route in routes {
        route.validate()?;
        let key = route.key();
        if previous_key
            .as_ref()
            .is_some_and(|value: &String| value >= &key)
        {
            return Err(SensitiveLocalProfileError::NonCanonicalList);
        }
        previous_key = Some(key);
        if !prefixes.contains(&route.path_prefix) {
            for prefix in &prefixes {
                if network_path_contains(prefix, &route.path_prefix)
                    || network_path_contains(&route.path_prefix, prefix)
                {
                    return Err(SensitiveLocalProfileError::InvalidField);
                }
            }
            prefixes.push(route.path_prefix.clone());
        }
    }
    Ok(())
}

fn validate_network_hashes(values: &[String]) -> Result<(), SensitiveLocalProfileError> {
    if values.is_empty()
        || values.len() > MAX_NETWORK_TLS_PINS
        || values.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    for value in values {
        validate_lower_hex_64(value).map_err(|_| SensitiveLocalProfileError::InvalidField)?;
    }
    Ok(())
}

fn validate_network_content_types(
    values: &[NetworkContentType],
) -> Result<(), SensitiveLocalProfileError> {
    if values.is_empty()
        || values.len() > MAX_NETWORK_CONTENT_TYPES
        || values.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(SensitiveLocalProfileError::NonCanonicalList);
    }
    Ok(())
}

fn validate_network_host(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if let Ok(address) = value.parse::<std::net::IpAddr>() {
        if address.to_string() == value {
            return Ok(());
        }
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    validate_kubernetes_dns_name(value)
}

fn validate_network_path_prefix(value: &str) -> Result<(), SensitiveLocalProfileError> {
    if value.len() < 2
        || value.len() > MAX_NETWORK_PATH_BYTES
        || !value.starts_with('/')
        || value.ends_with('/')
        || value.contains("//")
        || value.contains(['\\', '?', '#', '%'])
        || value.split('/').skip(1).any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || !segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
                })
        })
    {
        return Err(SensitiveLocalProfileError::InvalidField);
    }
    Ok(())
}

fn network_path_contains(prefix: &str, path: &str) -> bool {
    path.len() > prefix.len()
        && path.starts_with(prefix)
        && path.as_bytes().get(prefix.len()) == Some(&b'/')
}

fn network_method_name(method: NetworkMethod) -> &'static str {
    match method {
        NetworkMethod::Delete => "delete",
        NetworkMethod::Get => "get",
        NetworkMethod::Head => "head",
        NetworkMethod::Post => "post",
        NetworkMethod::Put => "put",
    }
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

    fn network_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "package-index-endpoint".into(),
            profile: SensitiveLocalProfileKindV1::NetworkEndpoint {
                origin: NetworkHttpsOrigin {
                    protocol: NetworkProtocol::Https,
                    host: "api.example.test".into(),
                    port: 443,
                },
                address_policy: NetworkAddressPolicy {
                    mode: NetworkAddressMode::DirectConnectOnlyPinnedNoProxy,
                    addresses: vec!["198.51.100.10".into(), "2001:db8::10".into()],
                },
                tls: NetworkTlsPolicy {
                    server_name: "api.example.test".into(),
                    minimum_version: NetworkTlsVersion::Tls13,
                    verification:
                        NetworkTlsVerification::PinnedCaAndLeafSpkiWithHostnameAndValidity,
                    ca_certificate_sha256: vec!["a".repeat(64), "b".repeat(64)],
                    leaf_spki_sha256: vec!["c".repeat(64)],
                },
                routes: vec![
                    NetworkRouteRule {
                        path_prefix: "/v1/artifacts".into(),
                        method: NetworkMethod::Get,
                        query: NetworkQueryPolicy::Forbidden,
                        request_body: NetworkRequestBodyPolicy::Forbidden,
                        response_content_types: vec![NetworkContentType::ApplicationOctetStream],
                    },
                    NetworkRouteRule {
                        path_prefix: "/v1/artifacts".into(),
                        method: NetworkMethod::Post,
                        query: NetworkQueryPolicy::Forbidden,
                        request_body: NetworkRequestBodyPolicy::Allowed {
                            content_types: vec![NetworkContentType::ApplicationJson],
                        },
                        response_content_types: vec![NetworkContentType::ApplicationJson],
                    },
                    NetworkRouteRule {
                        path_prefix: "/v1/status".into(),
                        method: NetworkMethod::Get,
                        query: NetworkQueryPolicy::Forbidden,
                        request_body: NetworkRequestBodyPolicy::Forbidden,
                        response_content_types: vec![NetworkContentType::ApplicationJson],
                    },
                ],
                request_headers: NetworkRequestHeaderPolicy::GeneratedHostAndAllowedContentTypeOnly,
                response_encoding: NetworkResponseEncodingPolicy::IdentityOnly,
                redirects: NetworkRedirectPolicy::Deny,
                max_request_bytes: 64 * 1024,
                max_response_bytes: 1024 * 1024,
            },
        }
    }

    #[test]
    fn network_endpoint_canonical_bytes_and_hash_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"id":"package-index-endpoint","profile":{"kind":"network_endpoint","origin":{"protocol":"https","host":"api.example.test","port":443},"address_policy":{"mode":"direct_connect_only_pinned_no_proxy","addresses":["198.51.100.10","2001:db8::10"]},"tls":{"server_name":"api.example.test","minimum_version":"tls13","verification":"pinned_ca_and_leaf_spki_with_hostname_and_validity","ca_certificate_sha256":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"leaf_spki_sha256":["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]},"routes":[{"path_prefix":"/v1/artifacts","method":"get","query":"forbidden","request_body":{"mode":"forbidden"},"response_content_types":["application/octet-stream"]},{"path_prefix":"/v1/artifacts","method":"post","query":"forbidden","request_body":{"mode":"allowed","content_types":["application/json"]},"response_content_types":["application/json"]},{"path_prefix":"/v1/status","method":"get","query":"forbidden","request_body":{"mode":"forbidden"},"response_content_types":["application/json"]}],"request_headers":"generated_host_and_allowed_content_type_only","response_encoding":"identity_only","redirects":"deny","max_request_bytes":65536,"max_response_bytes":1048576}}"#;
        const GOLDEN_SHA256: &str =
            "7bb0a6bb5d1cdf3955aabbe00172c8166db4fc28f70b616dd68221c25e16d460";

        let bytes = network_profile().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveLocalProfile::parse(&bytes).unwrap();
        assert_eq!(parsed.profile(), &network_profile());
        assert_eq!(parsed.profile_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.profile_sha256(), hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn network_origin_and_connect_addresses_are_exact_and_canonical() {
        for host in [
            "https://api.example.test",
            "user@api.example.test",
            "*.example.test",
            "API.example.test",
            "api.example.test.",
            "2001:0db8::10",
        ] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { origin, .. } = &mut value.profile
            {
                origin.host = host.into();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { origin, .. } = &mut value.profile {
            origin.port = 0;
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { tls, .. } = &mut value.profile {
            tls.server_name = "other.example.test".into();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        for addresses in [
            vec![],
            vec!["2001:db8::10".into(), "198.51.100.10".into()],
            vec!["198.51.100.10".into(), "198.51.100.10".into()],
            vec!["not-an-ip".into()],
            vec!["2001:0db8::10".into()],
        ] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { address_policy, .. } =
                &mut value.profile
            {
                address_policy.addresses = addresses;
            }
            assert!(matches!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
                    | Err(SensitiveLocalProfileError::InvalidField)
            ));
        }

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint {
            origin,
            address_policy,
            tls,
            ..
        } = &mut value.profile
        {
            origin.host = "192.0.2.1".into();
            tls.server_name = "192.0.2.1".into();
            address_policy.addresses = vec!["198.51.100.10".into()];
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { address_policy, .. } =
            &mut value.profile
        {
            address_policy.addresses = (0..=MAX_NETWORK_ADDRESSES)
                .map(|index| format!("192.0.2.{index}"))
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );
    }

    #[test]
    fn network_tls_requires_exact_dual_pins_and_no_fallback() {
        for target in ["ca", "spki"] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { tls, .. } = &mut value.profile {
                if target == "ca" {
                    tls.ca_certificate_sha256.clear();
                } else {
                    tls.leaf_spki_sha256.clear();
                }
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        for pins in [
            vec!["b".repeat(64), "a".repeat(64)],
            vec!["a".repeat(64), "a".repeat(64)],
            vec!["A".repeat(64)],
            vec!["a".repeat(63)],
        ] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { tls, .. } = &mut value.profile {
                tls.ca_certificate_sha256 = pins;
            }
            assert!(matches!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
                    | Err(SensitiveLocalProfileError::InvalidField)
            ));
        }

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { tls, .. } = &mut value.profile {
            tls.ca_certificate_sha256 = (0..=MAX_NETWORK_TLS_PINS)
                .map(|index| format!("{index:064x}"))
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );
    }

    #[test]
    fn network_routes_are_exact_sorted_nonoverlapping_and_bounded() {
        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile {
            routes.reverse();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile {
            routes.push(routes.last().unwrap().clone());
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile {
            *routes = vec![
                NetworkRouteRule {
                    path_prefix: "/v1/admin".into(),
                    method: NetworkMethod::Get,
                    query: NetworkQueryPolicy::Forbidden,
                    request_body: NetworkRequestBodyPolicy::Forbidden,
                    response_content_types: vec![NetworkContentType::ApplicationJson],
                },
                NetworkRouteRule {
                    path_prefix: "/v1".into(),
                    method: NetworkMethod::Get,
                    query: NetworkQueryPolicy::Forbidden,
                    request_body: NetworkRequestBodyPolicy::Forbidden,
                    response_content_types: vec![NetworkContentType::ApplicationJson],
                },
            ];
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        for count in [0, MAX_NETWORK_ROUTES + 1] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile
            {
                *routes = (0..count)
                    .map(|index| NetworkRouteRule {
                        path_prefix: format!("/route-{index:02}"),
                        method: NetworkMethod::Get,
                        query: NetworkQueryPolicy::Forbidden,
                        request_body: NetworkRequestBodyPolicy::Forbidden,
                        response_content_types: vec![NetworkContentType::ApplicationJson],
                    })
                    .collect();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }
    }

    #[test]
    fn network_path_body_content_types_and_byte_caps_fail_closed() {
        for path in [
            "/",
            "v1/status",
            "/v1/status/",
            "/v1//status",
            "/v1/../status",
            "/v1/%2e%2e/status",
            "/v1/status?all=true",
            "/v1/status#fragment",
            "/v1\\status",
        ] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile
            {
                routes[2].path_prefix = path.into();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile {
            routes[2].path_prefix = format!("/{}", "a".repeat(MAX_NETWORK_PATH_BYTES));
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        let mut value = network_profile();
        if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile {
            routes[0].request_body = NetworkRequestBodyPolicy::Allowed {
                content_types: vec![NetworkContentType::ApplicationJson],
            };
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        for target in ["request", "response"] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile
            {
                if target == "request" {
                    routes[1].request_body = NetworkRequestBodyPolicy::Allowed {
                        content_types: vec![],
                    };
                } else {
                    routes[1].response_content_types.clear();
                }
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        for content_types in [
            vec![
                NetworkContentType::ApplicationOctetStream,
                NetworkContentType::ApplicationJson,
            ],
            vec![
                NetworkContentType::ApplicationJson,
                NetworkContentType::ApplicationJson,
            ],
        ] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint { routes, .. } = &mut value.profile
            {
                routes[1].response_content_types = content_types;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        for (request, response) in [
            (0, 1024),
            (MAX_NETWORK_REQUEST_BYTES + 1, 1024),
            (1024, 0),
            (1024, MAX_NETWORK_RESPONSE_BYTES + 1),
        ] {
            let mut value = network_profile();
            if let SensitiveLocalProfileKindV1::NetworkEndpoint {
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
    fn network_encoding_rejects_protocol_trust_redirect_query_header_and_credentials_widening() {
        let bytes = network_profile().canonical_bytes().unwrap();
        for mutation in [
            "http",
            "any_address",
            "tls12",
            "system_trust",
            "follow_redirect",
            "query",
            "headers",
            "gzip",
            "patch",
            "wildcard_content_type",
            "userinfo",
            "credential",
            "url_path",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            match mutation {
                "http" => value["profile"]["origin"]["protocol"] = serde_json::json!("http"),
                "any_address" => {
                    value["profile"]["address_policy"]["mode"] = serde_json::json!("any")
                }
                "tls12" => value["profile"]["tls"]["minimum_version"] = serde_json::json!("tls12"),
                "system_trust" => {
                    value["profile"]["tls"]["verification"] = serde_json::json!("system_trust")
                }
                "follow_redirect" => value["profile"]["redirects"] = serde_json::json!("follow"),
                "query" => value["profile"]["routes"][0]["query"] = serde_json::json!("allowed"),
                "headers" => {
                    value["profile"]["request_headers"] = serde_json::json!("caller_supplied")
                }
                "gzip" => value["profile"]["response_encoding"] = serde_json::json!("gzip"),
                "patch" => value["profile"]["routes"][0]["method"] = serde_json::json!("patch"),
                "wildcard_content_type" => {
                    value["profile"]["routes"][0]["response_content_types"][0] =
                        serde_json::json!("*/*")
                }
                "userinfo" => {
                    value["profile"]["origin"]["userinfo"] = serde_json::json!("user:pass")
                }
                "credential" => value["profile"]["credential"] = serde_json::json!("secret"),
                _ => value["profile"]["origin"]["path"] = serde_json::json!("/admin"),
            }
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&value).unwrap()),
                Err(SensitiveLocalProfileError::InvalidEncoding)
            );
        }
    }
    fn service_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "resident-services".into(),
            profile: SensitiveLocalProfileKindV1::ServiceManager {
                manager: ServiceManagerKind::SystemdDbus,
                scope: ServiceManagerScope::System,
                unit_resolution: ServiceUnitResolutionPolicy::ExactCanonicalNameNoAlias,
                units: vec![
                    ServiceUnitRule {
                        unit: "elpis-harness.service".into(),
                        actions: vec![ServiceAction::Restart, ServiceAction::Status],
                    },
                    ServiceUnitRule {
                        unit: "nginx.service".into(),
                        actions: vec![
                            ServiceAction::Reload,
                            ServiceAction::Restart,
                            ServiceAction::Status,
                        ],
                    },
                ],
            },
        }
    }

    #[test]
    fn service_profile_canonical_bytes_and_hash_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"id":"resident-services","profile":{"kind":"service_manager","manager":"systemd_dbus","scope":{"mode":"system"},"unit_resolution":"exact_canonical_name_no_alias","units":[{"unit":"elpis-harness.service","actions":["restart","status"]},{"unit":"nginx.service","actions":["reload","restart","status"]}]}}"#;
        const GOLDEN_SHA256: &str =
            "2e63e14a85c5a09b324e494ccd23af19c967c3702e4b3407b07f5086ebb625fe";

        let bytes = service_profile().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveLocalProfile::parse(&bytes).unwrap();
        assert_eq!(parsed.profile(), &service_profile());
        assert_eq!(parsed.profile_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.profile_sha256(), hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn service_scope_and_unit_list_are_exact_and_bounded() {
        let mut value = service_profile();
        if let SensitiveLocalProfileKindV1::ServiceManager { scope, .. } = &mut value.profile {
            *scope = ServiceManagerScope::User { uid: 0 };
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        let mut value = service_profile();
        if let SensitiveLocalProfileKindV1::ServiceManager { scope, .. } = &mut value.profile {
            *scope = ServiceManagerScope::User { uid: 1000 };
        }
        assert!(value.validate().is_ok());
        assert_ne!(
            value.canonical_bytes().unwrap(),
            service_profile().canonical_bytes().unwrap()
        );

        for units in [
            vec![],
            vec![
                ServiceUnitRule {
                    unit: "nginx.service".into(),
                    actions: vec![ServiceAction::Status],
                },
                ServiceUnitRule {
                    unit: "elpis-harness.service".into(),
                    actions: vec![ServiceAction::Status],
                },
            ],
            vec![
                ServiceUnitRule {
                    unit: "nginx.service".into(),
                    actions: vec![ServiceAction::Status],
                },
                ServiceUnitRule {
                    unit: "nginx.service".into(),
                    actions: vec![ServiceAction::Restart],
                },
            ],
        ] {
            let mut value = service_profile();
            if let SensitiveLocalProfileKindV1::ServiceManager { units: target, .. } =
                &mut value.profile
            {
                *target = units;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        let mut value = service_profile();
        if let SensitiveLocalProfileKindV1::ServiceManager { units, .. } = &mut value.profile {
            *units = (0..=MAX_SERVICE_UNITS)
                .map(|index| ServiceUnitRule {
                    unit: format!("unit-{index:02}.service"),
                    actions: vec![ServiceAction::Status],
                })
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );
    }

    #[test]
    fn service_names_and_actions_are_conservative_sorted_and_unique() {
        for unit in [
            "",
            ".service",
            "nginx",
            "nginx.socket",
            "Nginx.service",
            "../nginx.service",
            "path/nginx.service",
            "nginx*.service",
            "-nginx.service",
            "nginx-.service",
            "nginx@.service",
            "nginx@@blue.service",
            "nginx..blue.service",
        ] {
            let mut value = service_profile();
            if let SensitiveLocalProfileKindV1::ServiceManager { units, .. } = &mut value.profile {
                units.truncate(1);
                units[0].unit = unit.into();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let mut value = service_profile();
        if let SensitiveLocalProfileKindV1::ServiceManager { units, .. } = &mut value.profile {
            units.truncate(1);
            units[0].unit = format!("{}.service", "a".repeat(MAX_SERVICE_UNIT_NAME_BYTES));
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );

        let mut value = service_profile();
        if let SensitiveLocalProfileKindV1::ServiceManager { units, .. } = &mut value.profile {
            units[1].unit = "worker@blue.service".into();
        }
        assert!(value.validate().is_ok());

        for actions in [
            vec![],
            vec![ServiceAction::Status, ServiceAction::Restart],
            vec![ServiceAction::Status, ServiceAction::Status],
        ] {
            let mut value = service_profile();
            if let SensitiveLocalProfileKindV1::ServiceManager { units, .. } = &mut value.profile {
                units[0].actions = actions;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }
    }

    #[test]
    fn service_encoding_rejects_commands_daemon_reload_and_unit_overrides() {
        let bytes = service_profile().canonical_bytes().unwrap();
        for mutation in [
            "manager",
            "scope",
            "alias_resolution",
            "daemon_reload",
            "command",
            "unit_path",
            "environment",
            "transient",
            "credential",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            match mutation {
                "manager" => value["profile"]["manager"] = serde_json::json!("shell"),
                "scope" => value["profile"]["scope"] = serde_json::json!({"mode":"global"}),
                "alias_resolution" => {
                    value["profile"]["unit_resolution"] = serde_json::json!("allow_alias")
                }
                "daemon_reload" => {
                    value["profile"]["units"][0]["actions"][0] = serde_json::json!("daemon_reload")
                }
                "command" => value["profile"]["command"] = serde_json::json!("systemctl"),
                "unit_path" => {
                    value["profile"]["units"][0]["path"] =
                        serde_json::json!("/etc/systemd/system/nginx.service")
                }
                "environment" => {
                    value["profile"]["units"][0]["environment"] =
                        serde_json::json!({"LD_PRELOAD":"/tmp/x.so"})
                }
                "transient" => value["profile"]["units"][0]["transient"] = serde_json::json!(true),
                _ => value["profile"]["credential"] = serde_json::json!("secret"),
            }
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&value).unwrap()),
                Err(SensitiveLocalProfileError::InvalidEncoding)
            );
        }
    }
    fn package_profile() -> SensitiveLocalProfileV1 {
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "debian-tools".into(),
            profile: SensitiveLocalProfileKindV1::PackageTransaction {
                manager: PackageManagerKind::DebianAptDpkgOffline,
                target_root: SensitiveProfileRef {
                    id: "debian-root".into(),
                    sha256: "a".repeat(64),
                },
                repository_endpoint: SensitiveProfileRef {
                    id: "debian-snapshot".into(),
                    sha256: "b".repeat(64),
                },
                repository_snapshot: PackageRepositorySnapshot {
                    metadata_sha256: "c".repeat(64),
                    signing_key_sha256: "d".repeat(64),
                },
                operations: vec![PackageOperation::Install, PackageOperation::Upgrade],
                packages: vec![
                    PackageSelection {
                        name: "curl".into(),
                        version: "7.88.1-10+deb12u12".into(),
                        architecture: PackageArchitecture::Amd64,
                        archive_sha256: "e".repeat(64),
                    },
                    PackageSelection {
                        name: "jq".into(),
                        version: "1.6-2.1+deb12u1".into(),
                        architecture: PackageArchitecture::Amd64,
                        archive_sha256: "f".repeat(64),
                    },
                ],
                dependencies: PackageDependencyPolicy::ExactListedPackagesOnly,
                maintainer_scripts: PackageMaintainerScriptPolicy::Forbidden,
                configuration: PackageConfigurationPolicy::FailOnPromptOrConffileChange,
                max_io_read_bytes: 1_073_741_824,
                max_io_write_bytes: 2_147_483_648,
            },
        }
    }

    #[test]
    fn package_profile_canonical_bytes_and_hash_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"id":"debian-tools","profile":{"kind":"package_transaction","manager":"debian_apt_dpkg_offline","target_root":{"id":"debian-root","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"repository_endpoint":{"id":"debian-snapshot","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"repository_snapshot":{"metadata_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","signing_key_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"operations":["install","upgrade"],"packages":[{"name":"curl","version":"7.88.1-10+deb12u12","architecture":"amd64","archive_sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},{"name":"jq","version":"1.6-2.1+deb12u1","architecture":"amd64","archive_sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}],"dependencies":"exact_listed_packages_only","maintainer_scripts":"forbidden","configuration":"fail_on_prompt_or_conffile_change","max_io_read_bytes":1073741824,"max_io_write_bytes":2147483648}}"#;
        const GOLDEN_SHA256: &str =
            "e59f13b3919bbb9300528095659023d405a6b4239817fda6c2d9ff97b5c5d4c2";

        let bytes = package_profile().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveLocalProfile::parse(&bytes).unwrap();
        assert_eq!(parsed.profile(), &package_profile());
        assert_eq!(parsed.profile_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.profile_sha256(), hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn package_root_endpoint_snapshot_and_archive_hashes_are_exact() {
        for target in ["root", "endpoint", "metadata", "key", "archive"] {
            let mut value = package_profile();
            if let SensitiveLocalProfileKindV1::PackageTransaction {
                target_root,
                repository_endpoint,
                repository_snapshot,
                packages,
                ..
            } = &mut value.profile
            {
                match target {
                    "root" => target_root.sha256 = "A".repeat(64),
                    "endpoint" => repository_endpoint.sha256 = "short".into(),
                    "metadata" => repository_snapshot.metadata_sha256 = "c".repeat(63),
                    "key" => repository_snapshot.signing_key_sha256 = "D".repeat(64),
                    _ => packages[0].archive_sha256 = "e".repeat(63),
                }
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let original = package_profile().canonical_bytes().unwrap();
        let mut changed = package_profile();
        if let SensitiveLocalProfileKindV1::PackageTransaction {
            repository_snapshot,
            ..
        } = &mut changed.profile
        {
            repository_snapshot.metadata_sha256 = "9".repeat(64);
        }
        assert_ne!(original, changed.canonical_bytes().unwrap());
    }

    #[test]
    fn package_operations_and_selections_are_nonempty_sorted_unique_and_bounded() {
        for operations in [
            vec![],
            vec![PackageOperation::Upgrade, PackageOperation::Install],
            vec![PackageOperation::Install, PackageOperation::Install],
        ] {
            let mut value = package_profile();
            if let SensitiveLocalProfileKindV1::PackageTransaction {
                operations: target, ..
            } = &mut value.profile
            {
                *target = operations;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        for packages in [
            vec![],
            vec![
                PackageSelection {
                    name: "jq".into(),
                    version: "1".into(),
                    architecture: PackageArchitecture::Amd64,
                    archive_sha256: "a".repeat(64),
                },
                PackageSelection {
                    name: "curl".into(),
                    version: "1".into(),
                    architecture: PackageArchitecture::Amd64,
                    archive_sha256: "b".repeat(64),
                },
            ],
            vec![
                PackageSelection {
                    name: "curl".into(),
                    version: "1".into(),
                    architecture: PackageArchitecture::Amd64,
                    archive_sha256: "a".repeat(64),
                },
                PackageSelection {
                    name: "curl".into(),
                    version: "2".into(),
                    architecture: PackageArchitecture::Amd64,
                    archive_sha256: "b".repeat(64),
                },
            ],
        ] {
            let mut value = package_profile();
            if let SensitiveLocalProfileKindV1::PackageTransaction {
                packages: target, ..
            } = &mut value.profile
            {
                *target = packages;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        let mut value = package_profile();
        if let SensitiveLocalProfileKindV1::PackageTransaction { packages, .. } = &mut value.profile
        {
            *packages = (0..=MAX_PACKAGE_NAMES)
                .map(|index| PackageSelection {
                    name: format!("pkg{index:03}"),
                    version: "1".into(),
                    architecture: PackageArchitecture::Amd64,
                    archive_sha256: format!("{index:064x}"),
                })
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );
    }

    #[test]
    fn package_name_version_and_architecture_grammar_fail_closed() {
        for (name, version) in [
            ("Curl", "1"),
            ("../curl", "1"),
            ("curl:amd64", "1"),
            ("curl", ""),
            ("curl", "1/../../x"),
            ("curl", "1 2"),
        ] {
            let mut value = package_profile();
            if let SensitiveLocalProfileKindV1::PackageTransaction { packages, .. } =
                &mut value.profile
            {
                packages.truncate(1);
                packages[0].name = name.into();
                packages[0].version = version.into();
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let mut value = package_profile();
        if let SensitiveLocalProfileKindV1::PackageTransaction { packages, .. } = &mut value.profile
        {
            packages.truncate(1);
            packages[0].name = format!("p{}", "a".repeat(MAX_PACKAGE_NAME_BYTES));
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::InvalidField)
        );
    }

    #[test]
    fn package_io_bounds_are_nonzero_and_hard_capped() {
        for (max_io_read_bytes, max_io_write_bytes) in [
            (0, 1),
            (MAX_PROFILE_IO_BYTES + 1, 1),
            (1, 0),
            (1, MAX_PROFILE_IO_BYTES + 1),
        ] {
            let mut value = package_profile();
            if let SensitiveLocalProfileKindV1::PackageTransaction {
                max_io_read_bytes: read,
                max_io_write_bytes: write,
                ..
            } = &mut value.profile
            {
                *read = max_io_read_bytes;
                *write = max_io_write_bytes;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
    }

    #[test]
    fn package_encoding_rejects_online_urls_host_roots_scripts_hooks_and_args() {
        let bytes = package_profile().canonical_bytes().unwrap();
        for mutation in [
            "manager",
            "root_path",
            "repository_url",
            "architecture",
            "dependencies",
            "scripts",
            "configuration",
            "arguments",
            "hooks",
            "credential",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            match mutation {
                "manager" => value["profile"]["manager"] = serde_json::json!("apt_online"),
                "root_path" => value["profile"]["target_root"]["path"] = serde_json::json!("/"),
                "repository_url" => {
                    value["profile"]["repository_url"] = serde_json::json!("https://example.test")
                }
                "architecture" => {
                    value["profile"]["packages"][0]["architecture"] = serde_json::json!("native")
                }
                "dependencies" => {
                    value["profile"]["dependencies"] = serde_json::json!("resolve_any")
                }
                "scripts" => value["profile"]["maintainer_scripts"] = serde_json::json!("allow"),
                "configuration" => value["profile"]["configuration"] = serde_json::json!("prompt"),
                "arguments" => value["profile"]["arguments"] = serde_json::json!(["--force-yes"]),
                "hooks" => value["profile"]["hooks"] = serde_json::json!(["pre-invoke"]),
                _ => value["profile"]["credential"] = serde_json::json!("secret"),
            }
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&value).unwrap()),
                Err(SensitiveLocalProfileError::InvalidEncoding)
            );
        }
    }
    fn remote_profile() -> SensitiveLocalProfileV1 {
        let executable = "/usr/libexec/elpis/check-state".to_string();
        SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "resident-actions".into(),
            profile: SensitiveLocalProfileKindV1::RemoteActions {
                actions: vec![RemoteActionRule {
                    id: "check-state".into(),
                    execution: RemoteExecutionMode::DirectNativeElfNoShellOrInterpreter,
                    executable_path: executable.clone(),
                    executable_sha256: "b".repeat(64),
                    argv: vec![executable, "--format".into(), "json".into()],
                    environment: RemoteEnvironmentPolicy {
                        mode: RemoteEnvironmentMode::ClearThenSetFixed,
                        locale: RemoteLocale::CUtf8,
                        timezone: RemoteTimezone::Utc,
                    },
                    cwd_profile: SensitiveProfileRef {
                        id: "work-root".into(),
                        sha256: "a".repeat(64),
                    },
                    uid: 10001,
                    gid: 10001,
                    capabilities: vec![],
                    stdin: RemoteStdinPolicy::Closed,
                    no_new_privileges: RemoteNoNewPrivilegesPolicy::Required,
                    timeout_ms: 30_000,
                    max_stdout_bytes: 65_536,
                    max_stderr_bytes: 65_536,
                    max_io_read_bytes: 8_388_608,
                    max_io_write_bytes: 4_194_304,
                }],
            },
        }
    }

    #[test]
    fn remote_profile_canonical_bytes_and_hash_are_frozen() {
        const GOLDEN: &str = r#"{"version":1,"id":"resident-actions","profile":{"kind":"remote_actions","actions":[{"id":"check-state","execution":"direct_native_elf_no_shell_or_interpreter","executable_path":"/usr/libexec/elpis/check-state","executable_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","argv":["/usr/libexec/elpis/check-state","--format","json"],"environment":{"mode":"clear_then_set_fixed","locale":"C.UTF-8","timezone":"UTC"},"cwd_profile":{"id":"work-root","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"uid":10001,"gid":10001,"capabilities":[],"stdin":"closed","no_new_privileges":"required","timeout_ms":30000,"max_stdout_bytes":65536,"max_stderr_bytes":65536,"max_io_read_bytes":8388608,"max_io_write_bytes":4194304}]}}"#;
        const GOLDEN_SHA256: &str =
            "38a372a64ace0b1df1589f2f57752a180f0431c6a6f16861369bf1c6f4b6a0d5";

        let bytes = remote_profile().canonical_bytes().unwrap();
        assert_eq!(bytes, GOLDEN.as_bytes());
        let parsed = CanonicalSensitiveLocalProfile::parse(&bytes).unwrap();
        assert_eq!(parsed.profile(), &remote_profile());
        assert_eq!(parsed.profile_sha256(), GOLDEN_SHA256);
        assert_eq!(parsed.profile_sha256(), hex::encode(Sha256::digest(&bytes)));
    }

    #[test]
    fn remote_actions_are_nonempty_sorted_unique_and_bounded() {
        for actions in [
            vec![],
            vec![
                RemoteActionRule {
                    id: "z-last".into(),
                    ..remote_action()
                },
                RemoteActionRule {
                    id: "a-first".into(),
                    ..remote_action()
                },
            ],
            vec![remote_action(), remote_action()],
        ] {
            let mut value = remote_profile();
            if let SensitiveLocalProfileKindV1::RemoteActions { actions: target } =
                &mut value.profile
            {
                *target = actions;
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::NonCanonicalList)
            );
        }

        let mut value = remote_profile();
        if let SensitiveLocalProfileKindV1::RemoteActions { actions } = &mut value.profile {
            *actions = (0..=MAX_REMOTE_ACTIONS)
                .map(|index| RemoteActionRule {
                    id: format!("action-{index:02}"),
                    ..remote_action()
                })
                .collect();
        }
        assert_eq!(
            value.validate(),
            Err(SensitiveLocalProfileError::NonCanonicalList)
        );
    }

    fn remote_action() -> RemoteActionRule {
        match remote_profile().profile {
            SensitiveLocalProfileKindV1::RemoteActions { mut actions } => actions.remove(0),
            _ => unreachable!(),
        }
    }

    #[test]
    fn remote_executable_and_argv_are_exact_bounded_and_control_free() {
        for mutation in [
            "relative", "hash", "argv0", "nul", "control", "item", "total",
        ] {
            let mut value = remote_profile();
            if let SensitiveLocalProfileKindV1::RemoteActions { actions } = &mut value.profile {
                let action = &mut actions[0];
                match mutation {
                    "relative" => action.executable_path = "bin/check-state".into(),
                    "hash" => action.executable_sha256 = "B".repeat(64),
                    "argv0" => action.argv[0] = "/usr/bin/other".into(),
                    "nul" => action.argv[1] = "bad\0arg".into(),
                    "control" => action.argv[1] = "bad\narg".into(),
                    "item" => action.argv[1] = "x".repeat(MAX_REMOTE_ARG_BYTES + 1),
                    _ => {
                        action.argv = vec![action.executable_path.clone()];
                        action
                            .argv
                            .extend((0..16).map(|_| "x".repeat(MAX_REMOTE_ARG_BYTES)));
                    }
                }
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }
    }

    #[test]
    fn remote_identity_capabilities_and_resource_bounds_fail_closed() {
        for mutation in [
            "cwd",
            "uid",
            "gid",
            "caps",
            "timeout0",
            "timeout",
            "stdout",
            "stderr",
            "io_read_zero",
            "io_read_overflow",
            "io_write_zero",
            "io_write_overflow",
        ] {
            let mut value = remote_profile();
            if let SensitiveLocalProfileKindV1::RemoteActions { actions } = &mut value.profile {
                let action = &mut actions[0];
                match mutation {
                    "cwd" => action.cwd_profile.sha256 = "short".into(),
                    "uid" => action.uid = 0,
                    "gid" => action.gid = 0,
                    "caps" => {
                        action.capabilities = vec![
                            RemoteLinuxCapability::CapNetBindService,
                            RemoteLinuxCapability::CapNetBindService,
                        ]
                    }
                    "timeout0" => action.timeout_ms = 0,
                    "timeout" => action.timeout_ms = MAX_REMOTE_TIMEOUT_MS + 1,
                    "stdout" => action.max_stdout_bytes = MAX_REMOTE_OUTPUT_BYTES + 1,
                    "stderr" => action.max_stderr_bytes = 0,
                    "io_read_zero" => action.max_io_read_bytes = 0,
                    "io_read_overflow" => action.max_io_read_bytes = MAX_PROFILE_IO_BYTES + 1,
                    "io_write_zero" => action.max_io_write_bytes = 0,
                    _ => action.max_io_write_bytes = MAX_PROFILE_IO_BYTES + 1,
                }
            }
            assert_eq!(
                value.validate(),
                Err(SensitiveLocalProfileError::InvalidField)
            );
        }

        let mut value = remote_profile();
        if let SensitiveLocalProfileKindV1::RemoteActions { actions } = &mut value.profile {
            actions[0].capabilities = vec![RemoteLinuxCapability::CapNetBindService];
        }
        assert!(value.validate().is_ok());
    }

    #[test]
    fn remote_encoding_rejects_shell_path_lookup_and_caller_control() {
        let bytes = remote_profile().canonical_bytes().unwrap();
        for mutation in [
            "shell",
            "path_lookup",
            "caller_argv",
            "caller_env",
            "caller_cwd",
            "stdin",
            "privileges",
            "credential",
            "supplementary_groups",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            match mutation {
                "shell" => value["profile"]["actions"][0]["execution"] = serde_json::json!("shell"),
                "path_lookup" => {
                    value["profile"]["actions"][0]["executable_path"] =
                        serde_json::json!("check-state")
                }
                "caller_argv" => {
                    value["profile"]["actions"][0]["argv_policy"] = serde_json::json!("caller")
                }
                "caller_env" => {
                    value["profile"]["actions"][0]["environment"] =
                        serde_json::json!({"mode":"caller"})
                }
                "caller_cwd" => {
                    value["profile"]["actions"][0]["cwd_policy"] = serde_json::json!("caller")
                }
                "stdin" => value["profile"]["actions"][0]["stdin"] = serde_json::json!("caller"),
                "privileges" => {
                    value["profile"]["actions"][0]["no_new_privileges"] =
                        serde_json::json!("disabled")
                }
                "credential" => {
                    value["profile"]["actions"][0]["credential"] = serde_json::json!("secret")
                }
                _ => value["profile"]["actions"][0]["supplementary_gids"] = serde_json::json!([0]),
            }
            let expected = if mutation == "path_lookup" {
                SensitiveLocalProfileError::InvalidField
            } else {
                SensitiveLocalProfileError::InvalidEncoding
            };
            assert_eq!(
                CanonicalSensitiveLocalProfile::parse(&serde_json::to_vec(&value).unwrap()),
                Err(expected)
            );
        }
    }
}
