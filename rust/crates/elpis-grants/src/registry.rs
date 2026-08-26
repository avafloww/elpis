//! Canonical custody for exact local sensitive-profile bytes.
//!
//! This module does not derive requirements from policy, evaluate a capability, or prove
//! confinement. It only validates and indexes inert profile artifacts.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    SensitiveLocalProfileKindV1, SensitiveLocalProfileV1, SensitiveProfileRef, sha256_hex,
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
    const REMOTE_JSON: &str = r#"{"version":1,"id":"resident-actions","profile":{"kind":"remote_actions","actions":[{"id":"check-state","execution":"direct_native_elf_no_shell_or_interpreter","executable_path":"/usr/libexec/elpis/check-state","executable_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","argv":["/usr/libexec/elpis/check-state","--format","json"],"environment":{"mode":"clear_then_set_fixed","locale":"C.UTF-8","timezone":"UTC"},"cwd_profile":{"id":"work-root","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"uid":10001,"gid":10001,"capabilities":[],"stdin":"closed","no_new_privileges":"required","timeout_ms":30000,"max_stdout_bytes":65536,"max_stderr_bytes":65536}]}}"#;

    fn service_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(SERVICE_JSON).unwrap()
    }

    fn remote_profile() -> SensitiveLocalProfileV1 {
        serde_json::from_str(REMOTE_JSON).unwrap()
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
        const GOLDEN: &str = r#"{"version":1,"profiles":[{"kind":"remote_actions","profile_sha256":"76c010f20c81f47bf54296effcae7f18b3d4c316d88cec3d53f97d399f9bd45e","profile":{"version":1,"id":"resident-actions","profile":{"kind":"remote_actions","actions":[{"id":"check-state","execution":"direct_native_elf_no_shell_or_interpreter","executable_path":"/usr/libexec/elpis/check-state","executable_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","argv":["/usr/libexec/elpis/check-state","--format","json"],"environment":{"mode":"clear_then_set_fixed","locale":"C.UTF-8","timezone":"UTC"},"cwd_profile":{"id":"work-root","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"uid":10001,"gid":10001,"capabilities":[],"stdin":"closed","no_new_privileges":"required","timeout_ms":30000,"max_stdout_bytes":65536,"max_stderr_bytes":65536}]}}},{"kind":"service_manager","profile_sha256":"2e63e14a85c5a09b324e494ccd23af19c967c3702e4b3407b07f5086ebb625fe","profile":{"version":1,"id":"resident-services","profile":{"kind":"service_manager","manager":"systemd_dbus","scope":{"mode":"system"},"unit_resolution":"exact_canonical_name_no_alias","units":[{"unit":"elpis-harness.service","actions":["restart","status"]},{"unit":"nginx.service","actions":["reload","restart","status"]}]}}}]}"#;
        const GOLDEN_SHA256: &str =
            "d70aefeabcd9f7d91e6ec9b7304763f71926c8ab386db07a4f726369c7995758";

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
            sha256: "76c010f20c81f47bf54296effcae7f18b3d4c316d88cec3d53f97d399f9bd45e".into(),
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
}
