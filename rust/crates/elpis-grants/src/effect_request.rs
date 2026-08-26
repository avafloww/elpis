//! Canonical, content-addressed requests for sensitive effects.
//!
//! This module is deliberately grammar-only. It does not look up or evaluate profiles, read or
//! write files, accept content bodies, issue authority, or perform any other effect. Content is
//! bound by its declared byte length and SHA-256; a later effect adapter must verify the external
//! body before using it.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    NetworkContentType, NetworkMethod, PackageArchitecture, PackageOperation, ServiceAction,
    sha256_hex, validate_id, validate_lower_hex_64,
};

pub const SENSITIVE_EFFECT_REQUEST_VERSION: u32 = 1;
pub const MAX_SENSITIVE_EFFECT_REQUEST_BYTES: usize = 1024 * 1024;
pub const MAX_EFFECT_RELATIVE_PATH_BYTES: usize = 4096;
pub const MAX_EFFECT_PATH_COMPONENT_BYTES: usize = 255;
pub const MAX_EFFECT_PATH_DEPTH: usize = 64;
pub const MAX_EDIT_TREE_OPERATIONS: usize = 4096;
pub const MAX_EFFECT_CONTENT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub const MAX_EDIT_TREE_CONTENT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub const MAX_EFFECT_RESULT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SERVICE_UNIT_NAME_BYTES: usize = 128;
pub const MAX_PACKAGE_REQUEST_SELECTIONS: usize = 128;
pub const MAX_PACKAGE_NAME_BYTES: usize = 128;
pub const MAX_REMOTE_OUTPUT_BYTES: u64 = 1024 * 1024;
pub const MAX_NETWORK_PATH_BYTES: usize = 256;
pub const MAX_NETWORK_REQUEST_BYTES: u64 = 1024 * 1024;
pub const MAX_NETWORK_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// The v1 envelope. Field order is part of its canonical JSON representation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SensitiveEffectRequestV1 {
    pub version: u32,
    pub effect: SensitiveEffectV1,
}

impl SensitiveEffectRequestV1 {
    pub fn validate(&self) -> Result<(), SensitiveEffectRequestError> {
        if self.version != SENSITIVE_EFFECT_REQUEST_VERSION {
            return Err(SensitiveEffectRequestError::Version);
        }
        self.effect.validate()
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, SensitiveEffectRequestError> {
        self.validate()?;
        let bytes =
            serde_json::to_vec(self).map_err(|_| SensitiveEffectRequestError::InvalidEncoding)?;
        if bytes.len() > MAX_SENSITIVE_EFFECT_REQUEST_BYTES {
            return Err(SensitiveEffectRequestError::PayloadTooLarge);
        }
        Ok(bytes)
    }
}

/// A request parsed from its one accepted JSON representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalSensitiveEffectRequest {
    request: SensitiveEffectRequestV1,
    request_sha256: String,
}

impl CanonicalSensitiveEffectRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self, SensitiveEffectRequestError> {
        if bytes.is_empty() || bytes.len() > MAX_SENSITIVE_EFFECT_REQUEST_BYTES {
            return Err(SensitiveEffectRequestError::PayloadTooLarge);
        }
        let request: SensitiveEffectRequestV1 = serde_json::from_slice(bytes)
            .map_err(|_| SensitiveEffectRequestError::InvalidEncoding)?;
        let canonical = request.canonical_bytes()?;
        if canonical != bytes {
            return Err(SensitiveEffectRequestError::NonCanonical);
        }
        Ok(Self {
            request,
            request_sha256: sha256_hex(bytes),
        })
    }

    pub fn request(&self) -> &SensitiveEffectRequestV1 {
        &self.request
    }

    pub fn request_sha256(&self) -> &str {
        &self.request_sha256
    }
}

/// The closed set of v1 sensitive effects.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SensitiveEffectV1 {
    ReadPath {
        root_profile_id: String,
        relative_path: String,
        max_result_bytes: u64,
    },
    EditTree {
        tree_profile_id: String,
        operations: Vec<EditTreeRequestOperationV1>,
        max_result_bytes: u64,
    },
    ArtifactExport {
        destination_profile_id: String,
        artifact_name: String,
        content_sha256: String,
        content_bytes: u64,
        max_result_bytes: u64,
    },
    ServiceAction {
        service_profile_id: String,
        unit: String,
        action: ServiceAction,
        max_result_bytes: u64,
    },
    PackageOperation {
        package_profile_id: String,
        operation: PackageOperation,
        selections: Vec<PackageRequestSelectionV1>,
        max_result_bytes: u64,
    },
    RemoteExecProfile {
        remote_profile_id: String,
        action_id: String,
        max_stdout_bytes: u64,
        max_stderr_bytes: u64,
    },
    NetworkEndpoint {
        endpoint_profile_id: String,
        method: NetworkMethod,
        path: String,
        body: NetworkRequestBodyV1,
        max_response_bytes: u64,
    },
}

impl SensitiveEffectV1 {
    fn validate(&self) -> Result<(), SensitiveEffectRequestError> {
        match self {
            Self::ReadPath {
                root_profile_id,
                relative_path,
                max_result_bytes,
            } => {
                validate_profile_id(root_profile_id)?;
                validate_relative_path(relative_path, true)?;
                validate_result_cap(*max_result_bytes)
            }
            Self::EditTree {
                tree_profile_id,
                operations,
                max_result_bytes,
            } => {
                validate_profile_id(tree_profile_id)?;
                validate_result_cap(*max_result_bytes)?;
                if operations.is_empty() || operations.len() > MAX_EDIT_TREE_OPERATIONS {
                    return Err(SensitiveEffectRequestError::InvalidList);
                }
                let mut aggregate_content_bytes = 0_u64;
                for operation in operations {
                    operation.validate()?;
                    aggregate_content_bytes = aggregate_content_bytes
                        .checked_add(operation.content_bytes())
                        .ok_or(SensitiveEffectRequestError::ContentTooLarge)?;
                    if aggregate_content_bytes > MAX_EDIT_TREE_CONTENT_BYTES {
                        return Err(SensitiveEffectRequestError::ContentTooLarge);
                    }
                }
                Ok(())
            }
            Self::ArtifactExport {
                destination_profile_id,
                artifact_name,
                content_sha256,
                content_bytes,
                max_result_bytes,
            } => {
                validate_profile_id(destination_profile_id)?;
                validate_artifact_name(artifact_name)?;
                validate_content(content_sha256, *content_bytes)?;
                validate_result_cap(*max_result_bytes)
            }
            Self::ServiceAction {
                service_profile_id,
                unit,
                max_result_bytes,
                ..
            } => {
                validate_profile_id(service_profile_id)?;
                validate_service_unit_name(unit)?;
                validate_result_cap(*max_result_bytes)
            }
            Self::PackageOperation {
                package_profile_id,
                selections,
                max_result_bytes,
                ..
            } => {
                validate_profile_id(package_profile_id)?;
                validate_result_cap(*max_result_bytes)?;
                if selections.is_empty()
                    || selections.len() > MAX_PACKAGE_REQUEST_SELECTIONS
                    || selections
                        .windows(2)
                        .any(|pair| pair[0].name >= pair[1].name)
                {
                    return Err(SensitiveEffectRequestError::InvalidList);
                }
                for selection in selections {
                    selection.validate()?;
                }
                Ok(())
            }
            Self::RemoteExecProfile {
                remote_profile_id,
                action_id,
                max_stdout_bytes,
                max_stderr_bytes,
            } => {
                validate_profile_id(remote_profile_id)?;
                validate_profile_id(action_id)?;
                validate_remote_output_cap(*max_stdout_bytes)?;
                validate_remote_output_cap(*max_stderr_bytes)
            }
            Self::NetworkEndpoint {
                endpoint_profile_id,
                method,
                path,
                body,
                max_response_bytes,
            } => {
                validate_profile_id(endpoint_profile_id)?;
                validate_network_path(path)?;
                body.validate()?;
                if matches!(method, NetworkMethod::Get | NetworkMethod::Head)
                    && !matches!(body, NetworkRequestBodyV1::Forbidden)
                {
                    return Err(SensitiveEffectRequestError::InvalidField);
                }
                validate_network_response_cap(*max_response_bytes)
            }
        }
    }
}

/// An exact archive selection. Lists are canonical in strictly increasing package-name order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PackageRequestSelectionV1 {
    pub name: String,
    pub version: String,
    pub architecture: PackageArchitecture,
    pub archive_sha256: String,
}

impl PackageRequestSelectionV1 {
    fn validate(&self) -> Result<(), SensitiveEffectRequestError> {
        validate_package_name(&self.name)?;
        validate_package_version(&self.version)?;
        validate_sha256(&self.archive_sha256)
    }
}

/// A request body is either absent or bound to exact external bytes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NetworkRequestBodyV1 {
    Forbidden,
    Content {
        content_type: NetworkContentType,
        content_sha256: String,
        content_bytes: u64,
    },
}

impl NetworkRequestBodyV1 {
    fn validate(&self) -> Result<(), SensitiveEffectRequestError> {
        match self {
            Self::Forbidden => Ok(()),
            Self::Content {
                content_sha256,
                content_bytes,
                ..
            } => {
                validate_sha256(content_sha256)?;
                if *content_bytes > MAX_NETWORK_REQUEST_BYTES {
                    return Err(SensitiveEffectRequestError::ContentTooLarge);
                }
                Ok(())
            }
        }
    }
}

/// One operation in an edit transaction. Vector order is semantic and is never sorted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EditTreeRequestOperationV1 {
    CreateDirectory {
        path: String,
    },
    CreateFile {
        path: String,
        content_sha256: String,
        content_bytes: u64,
    },
    DeleteFile {
        path: String,
        precondition: DestructiveFilePreconditionV1,
    },
    RemoveDirectory {
        path: String,
        precondition: RemoveDirectoryPreconditionV1,
    },
    ReplaceFile {
        path: String,
        precondition: DestructiveFilePreconditionV1,
        content_sha256: String,
        content_bytes: u64,
    },
}

impl EditTreeRequestOperationV1 {
    fn validate(&self) -> Result<(), SensitiveEffectRequestError> {
        match self {
            Self::CreateDirectory { path } => validate_relative_path(path, false),
            Self::CreateFile {
                path,
                content_sha256,
                content_bytes,
            } => {
                validate_relative_path(path, false)?;
                validate_content(content_sha256, *content_bytes)
            }
            Self::DeleteFile { path, precondition } => {
                validate_relative_path(path, false)?;
                precondition.validate()
            }
            Self::RemoveDirectory { path, .. } => validate_relative_path(path, false),
            Self::ReplaceFile {
                path,
                precondition,
                content_sha256,
                content_bytes,
            } => {
                validate_relative_path(path, false)?;
                precondition.validate()?;
                validate_content(content_sha256, *content_bytes)
            }
        }
    }

    fn content_bytes(&self) -> u64 {
        match self {
            Self::CreateFile { content_bytes, .. } | Self::ReplaceFile { content_bytes, .. } => {
                *content_bytes
            }
            _ => 0,
        }
    }
}

/// Exact identity and content expected before deleting or replacing a regular file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DestructiveFilePreconditionV1 {
    pub mount_id: u64,
    pub device: u64,
    pub inode: u64,
    pub sha256: String,
}

impl DestructiveFilePreconditionV1 {
    fn validate(&self) -> Result<(), SensitiveEffectRequestError> {
        if self.mount_id == 0 || self.device == 0 || self.inode == 0 {
            return Err(SensitiveEffectRequestError::InvalidField);
        }
        validate_sha256(&self.sha256)
    }
}

/// An explicit assertion required for directory removal. There is no recursive form.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoveDirectoryPreconditionV1 {
    EmptyDirectory,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SensitiveEffectRequestError {
    #[error("sensitive effect request version is unsupported")]
    Version,
    #[error("sensitive effect request payload exceeds its bound")]
    PayloadTooLarge,
    #[error("sensitive effect request encoding is invalid")]
    InvalidEncoding,
    #[error("sensitive effect request encoding is not canonical")]
    NonCanonical,
    #[error("sensitive effect request field is invalid")]
    InvalidField,
    #[error("sensitive effect request list is empty, noncanonical, or exceeds its bound")]
    InvalidList,
    #[error("sensitive effect request content length exceeds its bound")]
    ContentTooLarge,
}

fn validate_profile_id(value: &str) -> Result<(), SensitiveEffectRequestError> {
    validate_id(value).map_err(|_| SensitiveEffectRequestError::InvalidField)
}

fn validate_sha256(value: &str) -> Result<(), SensitiveEffectRequestError> {
    validate_lower_hex_64(value).map_err(|_| SensitiveEffectRequestError::InvalidField)
}

fn validate_content(sha256: &str, bytes: u64) -> Result<(), SensitiveEffectRequestError> {
    validate_sha256(sha256)?;
    if bytes > MAX_EFFECT_CONTENT_BYTES {
        return Err(SensitiveEffectRequestError::ContentTooLarge);
    }
    Ok(())
}

fn validate_result_cap(bytes: u64) -> Result<(), SensitiveEffectRequestError> {
    if bytes == 0 || bytes > MAX_EFFECT_RESULT_BYTES {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_remote_output_cap(bytes: u64) -> Result<(), SensitiveEffectRequestError> {
    if bytes == 0 || bytes > MAX_REMOTE_OUTPUT_BYTES {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_network_response_cap(bytes: u64) -> Result<(), SensitiveEffectRequestError> {
    if bytes == 0 || bytes > MAX_NETWORK_RESPONSE_BYTES {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_service_unit_name(value: &str) -> Result<(), SensitiveEffectRequestError> {
    let Some(stem) = value.strip_suffix(".service") else {
        return Err(SensitiveEffectRequestError::InvalidField);
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
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_package_name(value: &str) -> Result<(), SensitiveEffectRequestError> {
    if value.is_empty()
        || value.len() > MAX_PACKAGE_NAME_BYTES
        || !value.as_bytes()[0].is_ascii_lowercase()
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.')
        })
    {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_package_version(value: &str) -> Result<(), SensitiveEffectRequestError> {
    if value.is_empty()
        || value.len() > MAX_PACKAGE_NAME_BYTES
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b':' | b'~' | b'-')
        })
    {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_network_path(value: &str) -> Result<(), SensitiveEffectRequestError> {
    if value.len() < 2
        || value.len() > MAX_NETWORK_PATH_BYTES
        || !value.starts_with('/')
        || value.ends_with('/')
        || value.contains("//")
        || value.contains(['\\', '?', '#', '%', '@', ':'])
        || value.split('/').skip(1).any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || !segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
                })
        })
    {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_relative_path(
    value: &str,
    allow_current_directory: bool,
) -> Result<(), SensitiveEffectRequestError> {
    if value == "." {
        return if allow_current_directory {
            Ok(())
        } else {
            Err(SensitiveEffectRequestError::InvalidField)
        };
    }
    if value.is_empty()
        || value.len() > MAX_EFFECT_RELATIVE_PATH_BYTES
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
    {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    let mut depth = 0_usize;
    for component in value.split('/') {
        depth += 1;
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.len() > MAX_EFFECT_PATH_COMPONENT_BYTES
            || !component.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'@' | b'+')
            })
        {
            return Err(SensitiveEffectRequestError::InvalidField);
        }
    }
    if depth > MAX_EFFECT_PATH_DEPTH {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

fn validate_artifact_name(value: &str) -> Result<(), SensitiveEffectRequestError> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || !matches!(bytes[8], b'-')
        || !matches!(bytes[13], b'-')
        || !matches!(bytes[18], b'-')
        || !matches!(bytes[23], b'-')
        || !bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                || byte.is_ascii_digit()
                || matches!(byte, b'a'..=b'f')
        })
        // RFC 4122 UUID versions and variant, excluding nil and non-versioned identifiers.
        || !matches!(bytes[14], b'1'..=b'5')
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    {
        return Err(SensitiveEffectRequestError::InvalidField);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn request(effect: SensitiveEffectV1) -> SensitiveEffectRequestV1 {
        SensitiveEffectRequestV1 {
            version: SENSITIVE_EFFECT_REQUEST_VERSION,
            effect,
        }
    }

    fn identity() -> DestructiveFilePreconditionV1 {
        DestructiveFilePreconditionV1 {
            mount_id: 7,
            device: 8,
            inode: 9,
            sha256: HASH_A.into(),
        }
    }

    #[test]
    fn canonical_requests_have_stable_bytes_and_hash() {
        let cases = [
            request(SensitiveEffectV1::ReadPath {
                root_profile_id: "profile.read-1".into(),
                relative_path: ".".into(),
                max_result_bytes: 4096,
            }),
            request(SensitiveEffectV1::EditTree {
                tree_profile_id: "profile.edit-1".into(),
                operations: vec![
                    EditTreeRequestOperationV1::CreateDirectory {
                        path: "reports".into(),
                    },
                    EditTreeRequestOperationV1::CreateFile {
                        path: "reports/new.txt".into(),
                        content_sha256: HASH_B.into(),
                        content_bytes: 12,
                    },
                    EditTreeRequestOperationV1::DeleteFile {
                        path: "old.txt".into(),
                        precondition: identity(),
                    },
                    EditTreeRequestOperationV1::RemoveDirectory {
                        path: "empty".into(),
                        precondition: RemoveDirectoryPreconditionV1::EmptyDirectory,
                    },
                    EditTreeRequestOperationV1::ReplaceFile {
                        path: "current.txt".into(),
                        precondition: identity(),
                        content_sha256: HASH_B.into(),
                        content_bytes: 5,
                    },
                ],
                max_result_bytes: 8192,
            }),
            request(SensitiveEffectV1::ArtifactExport {
                destination_profile_id: "profile.artifacts-1".into(),
                artifact_name: "550e8400-e29b-41d4-a716-446655440000".into(),
                content_sha256: HASH_A.into(),
                content_bytes: 25,
                max_result_bytes: 1024,
            }),
        ];

        for (index, request) in cases.into_iter().enumerate() {
            let bytes = request.canonical_bytes().unwrap();
            let parsed = CanonicalSensitiveEffectRequest::parse(&bytes).unwrap();
            assert_eq!(parsed.request(), &request);
            assert_eq!(parsed.request_sha256(), sha256_hex(&bytes));
            assert_eq!(parsed.request_sha256().len(), 64);
            if index == 0 {
                assert_eq!(
                    bytes,
                    br#"{"version":1,"effect":{"kind":"read_path","root_profile_id":"profile.read-1","relative_path":".","max_result_bytes":4096}}"#.to_vec()
                );
                assert_eq!(
                    parsed.request_sha256(),
                    "b4afb502434a0032f5e3730481e7130b840bf4accaa2816d867f3a663fbd3b30"
                );
            }
        }
    }

    fn package_selection(
        name: &str,
        version: &str,
        architecture: PackageArchitecture,
        archive_sha256: &str,
    ) -> PackageRequestSelectionV1 {
        PackageRequestSelectionV1 {
            name: name.into(),
            version: version.into(),
            architecture,
            archive_sha256: archive_sha256.into(),
        }
    }

    #[test]
    fn new_request_variants_have_stable_bytes_and_hashes() {
        let cases = [
            (
                request(SensitiveEffectV1::ServiceAction {
                    service_profile_id: "profile.service-1".into(),
                    unit: "api@blue.service".into(),
                    action: ServiceAction::Restart,
                    max_result_bytes: 4096,
                }),
                br#"{"version":1,"effect":{"kind":"service_action","service_profile_id":"profile.service-1","unit":"api@blue.service","action":"restart","max_result_bytes":4096}}"#.as_slice(),
                "feb273c9ac3759cef9120281d9d50e55a3f2825be0df155b6defcf983a1771f9",
            ),
            (
                request(SensitiveEffectV1::PackageOperation {
                    package_profile_id: "profile.packages-1".into(),
                    operation: PackageOperation::Install,
                    selections: vec![
                        package_selection("libalpha", "1:2.3-4", PackageArchitecture::Amd64, HASH_A),
                        package_selection("tool-beta", "5.0~rc1", PackageArchitecture::Arm64, HASH_B),
                    ],
                    max_result_bytes: 8192,
                }),
                br#"{"version":1,"effect":{"kind":"package_operation","package_profile_id":"profile.packages-1","operation":"install","selections":[{"name":"libalpha","version":"1:2.3-4","architecture":"amd64","archive_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"name":"tool-beta","version":"5.0~rc1","architecture":"arm64","archive_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"max_result_bytes":8192}}"#.as_slice(),
                "08a7c1bf2d6a1366db34591c7e658d33564ba4f61c0677fb296226e2ab194289",
            ),
            (
                request(SensitiveEffectV1::RemoteExecProfile {
                    remote_profile_id: "profile.remote-1".into(),
                    action_id: "rotate-logs".into(),
                    max_stdout_bytes: 65_536,
                    max_stderr_bytes: 32_768,
                }),
                br#"{"version":1,"effect":{"kind":"remote_exec_profile","remote_profile_id":"profile.remote-1","action_id":"rotate-logs","max_stdout_bytes":65536,"max_stderr_bytes":32768}}"#.as_slice(),
                "f089ee3c2155a1560bc6d8295361d5420c296c4ed4aaebdc9b85f80420c118ce",
            ),
            (
                request(SensitiveEffectV1::NetworkEndpoint {
                    endpoint_profile_id: "profile.network-1".into(),
                    method: NetworkMethod::Post,
                    path: "/v1/reports/current".into(),
                    body: NetworkRequestBodyV1::Content {
                        content_type: NetworkContentType::ApplicationJson,
                        content_sha256: HASH_A.into(),
                        content_bytes: 27,
                    },
                    max_response_bytes: 1024 * 1024,
                }),
                br#"{"version":1,"effect":{"kind":"network_endpoint","endpoint_profile_id":"profile.network-1","method":"post","path":"/v1/reports/current","body":{"kind":"content","content_type":"application/json","content_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","content_bytes":27},"max_response_bytes":1048576}}"#.as_slice(),
                "8eb01def787f824b49d8efd26fda2222688774cd081edae44037baafa8c71978",
            ),
        ];

        for (request, expected_bytes, expected_hash) in cases {
            let bytes = request.canonical_bytes().unwrap();
            assert_eq!(bytes.as_slice(), expected_bytes);
            let parsed = CanonicalSensitiveEffectRequest::parse(&bytes).unwrap();
            assert_eq!(parsed.request(), &request);
            assert_eq!(parsed.request_sha256(), expected_hash);
        }
    }

    #[test]
    fn operation_order_is_preserved_in_canonical_bytes() {
        let first = request(SensitiveEffectV1::EditTree {
            tree_profile_id: "tree".into(),
            operations: vec![
                EditTreeRequestOperationV1::CreateDirectory { path: "a".into() },
                EditTreeRequestOperationV1::CreateDirectory { path: "b".into() },
            ],
            max_result_bytes: 1,
        });
        let reversed = request(SensitiveEffectV1::EditTree {
            tree_profile_id: "tree".into(),
            operations: vec![
                EditTreeRequestOperationV1::CreateDirectory { path: "b".into() },
                EditTreeRequestOperationV1::CreateDirectory { path: "a".into() },
            ],
            max_result_bytes: 1,
        });
        assert_ne!(
            first.canonical_bytes().unwrap(),
            reversed.canonical_bytes().unwrap()
        );
    }

    #[test]
    fn unknown_duplicate_and_noncanonical_json_are_rejected() {
        let canonical = request(SensitiveEffectV1::ReadPath {
            root_profile_id: "read".into(),
            relative_path: "file.txt".into(),
            max_result_bytes: 1,
        })
        .canonical_bytes()
        .unwrap();
        let text = String::from_utf8(canonical.clone()).unwrap();
        let unknown = text.replacen("{", "{\"extra\":true,", 1);
        let duplicate = text.replacen("{", "{\"version\":1,", 1);
        let nested_unknown = text.replacen(
            "{\"kind\":\"read_path\",",
            "{\"kind\":\"read_path\",\"recursive\":true,",
            1,
        );
        for invalid in [unknown, nested_unknown] {
            assert_eq!(
                CanonicalSensitiveEffectRequest::parse(invalid.as_bytes()),
                Err(SensitiveEffectRequestError::InvalidEncoding)
            );
        }
        assert_eq!(
            CanonicalSensitiveEffectRequest::parse(duplicate.as_bytes()),
            Err(SensitiveEffectRequestError::InvalidEncoding)
        );
        for bytes in [
            format!(" {text}").into_bytes(),
            text.replacen("{\"version\":1,", "{\"version\":1, ", 1)
                .into_bytes(),
            text.replacen("file.txt", "file\\u002etxt", 1).into_bytes(),
        ] {
            assert_eq!(
                CanonicalSensitiveEffectRequest::parse(&bytes),
                Err(SensitiveEffectRequestError::NonCanonical)
            );
        }
    }

    #[test]
    fn paths_are_relative_bounded_and_current_directory_is_read_only() {
        for invalid in [
            "",
            "/etc",
            "a/",
            "a//b",
            "a/./b",
            "../a",
            "a/../b",
            "a\\b",
            "snowman-☃",
        ] {
            let read = request(SensitiveEffectV1::ReadPath {
                root_profile_id: "read".into(),
                relative_path: invalid.into(),
                max_result_bytes: 1,
            });
            assert_eq!(
                read.validate(),
                Err(SensitiveEffectRequestError::InvalidField)
            );
        }
        assert!(
            request(SensitiveEffectV1::ReadPath {
                root_profile_id: "read".into(),
                relative_path: ".".into(),
                max_result_bytes: 1,
            })
            .validate()
            .is_ok()
        );
        assert_eq!(
            request(SensitiveEffectV1::EditTree {
                tree_profile_id: "edit".into(),
                operations: vec![EditTreeRequestOperationV1::CreateDirectory { path: ".".into() }],
                max_result_bytes: 1,
            })
            .validate(),
            Err(SensitiveEffectRequestError::InvalidField)
        );
    }

    #[test]
    fn hashes_lengths_preconditions_names_and_caps_fail_closed() {
        let invalid_identity = DestructiveFilePreconditionV1 {
            inode: 0,
            ..identity()
        };
        let cases = [
            request(SensitiveEffectV1::EditTree {
                tree_profile_id: "edit".into(),
                operations: vec![],
                max_result_bytes: 1,
            }),
            request(SensitiveEffectV1::EditTree {
                tree_profile_id: "edit".into(),
                operations: vec![EditTreeRequestOperationV1::DeleteFile {
                    path: "x".into(),
                    precondition: invalid_identity,
                }],
                max_result_bytes: 1,
            }),
            request(SensitiveEffectV1::ArtifactExport {
                destination_profile_id: "artifacts".into(),
                artifact_name: "550E8400-E29B-41D4-A716-446655440000".into(),
                content_sha256: HASH_A.into(),
                content_bytes: 1,
                max_result_bytes: 1,
            }),
            request(SensitiveEffectV1::ArtifactExport {
                destination_profile_id: "artifacts".into(),
                artifact_name: "550e8400-e29b-41d4-7716-446655440000".into(),
                content_sha256: HASH_A.into(),
                content_bytes: 1,
                max_result_bytes: 1,
            }),
            request(SensitiveEffectV1::ArtifactExport {
                destination_profile_id: "artifacts".into(),
                artifact_name: "550e8400-e29b-41d4-a716-446655440000".into(),
                content_sha256: "A".repeat(64),
                content_bytes: 1,
                max_result_bytes: 1,
            }),
            request(SensitiveEffectV1::ReadPath {
                root_profile_id: "read".into(),
                relative_path: ".".into(),
                max_result_bytes: 0,
            }),
        ];
        for case in cases {
            assert!(case.validate().is_err());
        }
    }

    #[test]
    fn service_units_are_canonical_and_caps_and_ids_are_bounded() {
        for unit in [
            "api",
            "/api.service",
            "Api.service",
            ".api.service",
            "api..blue.service",
            "api@@blue.service",
            "api.service/other.service",
        ] {
            assert_eq!(
                request(SensitiveEffectV1::ServiceAction {
                    service_profile_id: "services".into(),
                    unit: unit.into(),
                    action: ServiceAction::Status,
                    max_result_bytes: 1,
                })
                .validate(),
                Err(SensitiveEffectRequestError::InvalidField)
            );
        }
        for (profile_id, cap) in [
            ("bad/id", 1),
            ("services", 0),
            ("services", MAX_EFFECT_RESULT_BYTES + 1),
        ] {
            assert_eq!(
                request(SensitiveEffectV1::ServiceAction {
                    service_profile_id: profile_id.into(),
                    unit: "api.service".into(),
                    action: ServiceAction::Restart,
                    max_result_bytes: cap,
                })
                .validate(),
                Err(SensitiveEffectRequestError::InvalidField)
            );
        }
    }

    #[test]
    fn package_selections_are_exact_sorted_nonempty_and_bounded() {
        let first = package_selection("alpha", "1.0", PackageArchitecture::Amd64, HASH_A);
        let second = package_selection("beta", "2.0", PackageArchitecture::Arm64, HASH_B);
        let package_request = |selections| {
            request(SensitiveEffectV1::PackageOperation {
                package_profile_id: "packages".into(),
                operation: PackageOperation::Upgrade,
                selections,
                max_result_bytes: 1,
            })
        };

        assert!(
            package_request(vec![first.clone(), second.clone()])
                .validate()
                .is_ok()
        );
        for selections in [
            Vec::new(),
            vec![second.clone(), first.clone()],
            vec![first.clone(), first.clone()],
            vec![package_selection(
                "Alpha",
                "1.0",
                PackageArchitecture::Amd64,
                HASH_A,
            )],
            vec![package_selection(
                "alpha",
                "1/0",
                PackageArchitecture::Amd64,
                HASH_A,
            )],
            vec![package_selection(
                "alpha",
                "1.0",
                PackageArchitecture::Amd64,
                &"A".repeat(64),
            )],
        ] {
            assert!(package_request(selections).validate().is_err());
        }
        assert_eq!(
            package_request(vec![first; MAX_PACKAGE_REQUEST_SELECTIONS + 1]).validate(),
            Err(SensitiveEffectRequestError::InvalidList)
        );
    }

    #[test]
    fn remote_requests_bind_only_profile_action_and_output_caps() {
        for (profile_id, action_id, stdout, stderr) in [
            ("bad/profile", "rotate", 1, 1),
            ("remote", "bad/action", 1, 1),
            ("remote", "rotate", 0, 1),
            ("remote", "rotate", 1, 0),
            ("remote", "rotate", MAX_REMOTE_OUTPUT_BYTES + 1, 1),
            ("remote", "rotate", 1, MAX_REMOTE_OUTPUT_BYTES + 1),
        ] {
            assert_eq!(
                request(SensitiveEffectV1::RemoteExecProfile {
                    remote_profile_id: profile_id.into(),
                    action_id: action_id.into(),
                    max_stdout_bytes: stdout,
                    max_stderr_bytes: stderr,
                })
                .validate(),
                Err(SensitiveEffectRequestError::InvalidField)
            );
        }
    }

    #[test]
    fn network_paths_bodies_methods_and_caps_fail_closed() {
        let network_request = |method, path: &str, body, cap| {
            request(SensitiveEffectV1::NetworkEndpoint {
                endpoint_profile_id: "endpoint".into(),
                method,
                path: path.into(),
                body,
                max_response_bytes: cap,
            })
        };
        for path in [
            "",
            "/",
            "relative",
            "https://example.com/v1",
            "//user@example.com/v1",
            "/v1/",
            "/v1//item",
            "/v1/./item",
            "/v1/../item",
            "/v1/item?secret=x",
            "/v1/item#fragment",
            "/v1/%69tem",
            "/v1/user@example.com",
            "/v1\\item",
        ] {
            assert_eq!(
                network_request(NetworkMethod::Get, path, NetworkRequestBodyV1::Forbidden, 1)
                    .validate(),
                Err(SensitiveEffectRequestError::InvalidField)
            );
        }

        let content = |hash: &str, bytes| NetworkRequestBodyV1::Content {
            content_type: NetworkContentType::ApplicationJson,
            content_sha256: hash.into(),
            content_bytes: bytes,
        };
        assert_eq!(
            network_request(NetworkMethod::Get, "/v1/item", content(HASH_A, 1), 1).validate(),
            Err(SensitiveEffectRequestError::InvalidField)
        );
        assert_eq!(
            network_request(
                NetworkMethod::Post,
                "/v1/item",
                content(HASH_A, MAX_NETWORK_REQUEST_BYTES + 1),
                1
            )
            .validate(),
            Err(SensitiveEffectRequestError::ContentTooLarge)
        );
        assert_eq!(
            network_request(
                NetworkMethod::Post,
                "/v1/item",
                content(&"A".repeat(64), 1),
                1
            )
            .validate(),
            Err(SensitiveEffectRequestError::InvalidField)
        );
        for cap in [0, MAX_NETWORK_RESPONSE_BYTES + 1] {
            assert_eq!(
                network_request(NetworkMethod::Post, "/v1/item", content(HASH_A, 1), cap)
                    .validate(),
                Err(SensitiveEffectRequestError::InvalidField)
            );
        }
    }

    #[test]
    fn request_grammar_has_no_argument_transport_or_credential_overrides() {
        let forbidden = [
            br#"{"version":1,"effect":{"kind":"remote_exec_profile","remote_profile_id":"remote","action_id":"rotate","max_stdout_bytes":1,"max_stderr_bytes":1,"argv":["/bin/sh"]}}"#.as_slice(),
            br#"{"version":1,"effect":{"kind":"remote_exec_profile","remote_profile_id":"remote","action_id":"rotate","max_stdout_bytes":1,"max_stderr_bytes":1,"env":{"TOKEN":"x"}}}"#.as_slice(),
            br#"{"version":1,"effect":{"kind":"network_endpoint","endpoint_profile_id":"endpoint","method":"get","path":"/v1/item","body":{"kind":"forbidden"},"max_response_bytes":1,"url":"https://example.com","headers":{"authorization":"x"},"query":"secret=x","credential_profile_id":"secret"}}"#.as_slice(),
            br#"{"version":1,"effect":{"kind":"package_operation","package_profile_id":"packages","operation":"install","selections":[{"name":"alpha","version":"1.0","architecture":"amd64","archive_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","url":"https://example.com/a.deb"}],"max_result_bytes":1}}"#.as_slice(),
        ];
        for bytes in forbidden {
            assert_eq!(
                CanonicalSensitiveEffectRequest::parse(bytes),
                Err(SensitiveEffectRequestError::InvalidEncoding)
            );
        }

        let noncanonical_order = br#"{"effect":{"kind":"network_endpoint","endpoint_profile_id":"endpoint","method":"get","path":"/v1/item","body":{"kind":"forbidden"},"max_response_bytes":1},"version":1}"#;
        assert_eq!(
            CanonicalSensitiveEffectRequest::parse(noncanonical_order),
            Err(SensitiveEffectRequestError::NonCanonical)
        );
    }

    #[test]
    fn raw_and_constructed_payloads_are_bounded() {
        assert_eq!(
            CanonicalSensitiveEffectRequest::parse(&vec![
                b' ';
                MAX_SENSITIVE_EFFECT_REQUEST_BYTES + 1
            ]),
            Err(SensitiveEffectRequestError::PayloadTooLarge)
        );
        let operations = vec![
            EditTreeRequestOperationV1::CreateDirectory {
                path: "x".repeat(MAX_EFFECT_PATH_COMPONENT_BYTES),
            };
            MAX_EDIT_TREE_OPERATIONS
        ];
        assert_eq!(
            request(SensitiveEffectV1::EditTree {
                tree_profile_id: "edit".into(),
                operations,
                max_result_bytes: 1,
            })
            .canonical_bytes(),
            Err(SensitiveEffectRequestError::PayloadTooLarge)
        );
    }

    #[test]
    fn all_collections_and_declared_byte_counts_are_bounded() {
        let too_many = vec![
            EditTreeRequestOperationV1::CreateDirectory { path: "x".into() };
            MAX_EDIT_TREE_OPERATIONS + 1
        ];
        assert_eq!(
            request(SensitiveEffectV1::EditTree {
                tree_profile_id: "edit".into(),
                operations: too_many,
                max_result_bytes: 1,
            })
            .validate(),
            Err(SensitiveEffectRequestError::InvalidList)
        );

        let aggregate = request(SensitiveEffectV1::EditTree {
            tree_profile_id: "edit".into(),
            operations: vec![
                EditTreeRequestOperationV1::CreateFile {
                    path: "a".into(),
                    content_sha256: HASH_A.into(),
                    content_bytes: MAX_EDIT_TREE_CONTENT_BYTES,
                },
                EditTreeRequestOperationV1::CreateFile {
                    path: "b".into(),
                    content_sha256: HASH_B.into(),
                    content_bytes: 1,
                },
            ],
            max_result_bytes: 1,
        });
        assert_eq!(
            aggregate.validate(),
            Err(SensitiveEffectRequestError::ContentTooLarge)
        );

        assert_eq!(
            request(SensitiveEffectV1::ArtifactExport {
                destination_profile_id: "artifacts".into(),
                artifact_name: "550e8400-e29b-41d4-a716-446655440000".into(),
                content_sha256: HASH_A.into(),
                content_bytes: MAX_EFFECT_CONTENT_BYTES + 1,
                max_result_bytes: 1,
            })
            .validate(),
            Err(SensitiveEffectRequestError::ContentTooLarge)
        );
    }
}
