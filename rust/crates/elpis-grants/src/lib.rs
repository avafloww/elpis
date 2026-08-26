//! Pure canonical claims and Ed25519 verification for sensitive executor grants.
//!
//! This crate authenticates signed claims but does not admit or activate them. It has no
//! issuer private key, trusted clock, replay state, persistence, transport, effect, or clearance API.

#![forbid(unsafe_code)]

mod policy;
pub use policy::*;

use std::fmt;

use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const GRANT_VERSION: u32 = 1;
pub const MAX_GRANT_PAYLOAD_BYTES: usize = 8 * 1024;
pub const ED25519_PUBLIC_KEY_BYTES: usize = 32;
pub const ED25519_SIGNATURE_BYTES: usize = 64;
const MAX_ID_BYTES: usize = 120;
const DOMAIN: &[u8] = b"elpis-sensitive-grant-v1\0";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrantMode {
    SensitiveGranted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GrantV1 {
    pub version: u32,
    pub grant_id: String,
    pub issuer_id: String,
    pub issuer_seq: u64,
    pub executor_id: String,
    pub policy_epoch: u64,
    pub not_before_unix_s: u64,
    pub expires_at_unix_s: u64,
    pub mind_id: String,
    pub mandate_sha256: String,
    pub runtime_sha256: String,
    pub policy_sha256: String,
    pub mode: GrantMode,
    pub nonce: String,
}

impl GrantV1 {
    pub fn validate(&self) -> Result<(), GrantError> {
        if self.version != GRANT_VERSION {
            return Err(GrantError::Version);
        }
        for value in [
            &self.grant_id,
            &self.issuer_id,
            &self.executor_id,
            &self.mind_id,
        ] {
            validate_id(value)?;
        }
        if self.issuer_seq == 0
            || self.policy_epoch == 0
            || self.not_before_unix_s == 0
            || self.expires_at_unix_s <= self.not_before_unix_s
        {
            return Err(GrantError::InvalidField);
        }
        for value in [
            &self.mandate_sha256,
            &self.runtime_sha256,
            &self.policy_sha256,
            &self.nonce,
        ] {
            validate_lower_hex_64(value)?;
        }
        Ok(())
    }

    pub fn canonical_payload(&self) -> Result<Vec<u8>, GrantError> {
        self.validate()?;
        let payload = serde_json::to_vec(self).map_err(|_| GrantError::InvalidEncoding)?;
        if payload.len() > MAX_GRANT_PAYLOAD_BYTES {
            return Err(GrantError::PayloadTooLarge);
        }
        Ok(payload)
    }
}

/// Static local facts that can only narrow claims already covered by the signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantBinding {
    pub mind_id: String,
    pub mandate_sha256: String,
    pub runtime_sha256: String,
    pub policy_sha256: String,
}

impl GrantBinding {
    fn validate(&self) -> Result<(), GrantError> {
        validate_id(&self.mind_id)?;
        for value in [
            &self.mandate_sha256,
            &self.runtime_sha256,
            &self.policy_sha256,
        ] {
            validate_lower_hex_64(value)?;
        }
        Ok(())
    }
}

/// Boot-frozen authentication trust. It has no clock, replay ledger, or activation API.
#[derive(Clone)]
pub struct GrantVerifier {
    issuer_id: String,
    issuer_public_key: [u8; ED25519_PUBLIC_KEY_BYTES],
    executor_id: String,
    policy_epoch: u64,
    max_lifetime_s: u64,
}

impl fmt::Debug for GrantVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GrantVerifier")
            .field("issuer_id", &self.issuer_id)
            .field("public_key_sha256", &sha256_hex(&self.issuer_public_key))
            .field("executor_id", &self.executor_id)
            .field("policy_epoch", &self.policy_epoch)
            .field("max_lifetime_s", &self.max_lifetime_s)
            .finish()
    }
}

impl GrantVerifier {
    pub fn new(
        issuer_id: impl Into<String>,
        issuer_public_key: &[u8],
        executor_id: impl Into<String>,
        policy_epoch: u64,
        max_lifetime_s: u64,
    ) -> Result<Self, GrantError> {
        let issuer_id = issuer_id.into();
        let executor_id = executor_id.into();
        validate_id(&issuer_id)?;
        validate_id(&executor_id)?;
        let issuer_public_key = issuer_public_key
            .try_into()
            .map_err(|_| GrantError::InvalidPublicKey)?;
        if policy_epoch == 0 || max_lifetime_s == 0 {
            return Err(GrantError::InvalidExpectation);
        }
        Ok(Self {
            issuer_id,
            issuer_public_key,
            executor_id,
            policy_epoch,
            max_lifetime_s,
        })
    }

    /// Authenticates canonical signed claims and static local bindings.
    ///
    /// This does not check issuer-sequence freshness, current time, expiry, or terminal state.
    pub fn authenticate(
        &self,
        payload: &[u8],
        signature: &[u8],
        binding: &GrantBinding,
    ) -> Result<AuthenticatedGrant, GrantError> {
        if payload.is_empty() || payload.len() > MAX_GRANT_PAYLOAD_BYTES {
            return Err(GrantError::PayloadTooLarge);
        }
        if signature.len() != ED25519_SIGNATURE_BYTES {
            return Err(GrantError::InvalidSignature);
        }
        let signed = signature_input(payload)?;
        UnparsedPublicKey::new(&ED25519, &self.issuer_public_key)
            .verify(&signed, signature)
            .map_err(|_| GrantError::InvalidSignature)?;

        let grant: GrantV1 =
            serde_json::from_slice(payload).map_err(|_| GrantError::InvalidEncoding)?;
        grant.validate()?;
        let canonical = grant.canonical_payload()?;
        if canonical != payload {
            return Err(GrantError::NonCanonical);
        }
        binding.validate()?;
        self.validate_claims(&grant, binding)?;
        Ok(AuthenticatedGrant {
            payload_sha256: sha256_hex(payload),
            grant,
        })
    }

    fn validate_claims(&self, grant: &GrantV1, binding: &GrantBinding) -> Result<(), GrantError> {
        if grant.issuer_id != self.issuer_id
            || grant.executor_id != self.executor_id
            || grant.policy_epoch != self.policy_epoch
            || grant.mind_id != binding.mind_id
            || grant.mandate_sha256 != binding.mandate_sha256
            || grant.runtime_sha256 != binding.runtime_sha256
            || grant.policy_sha256 != binding.policy_sha256
        {
            return Err(GrantError::BindingMismatch);
        }
        let lifetime = grant
            .expires_at_unix_s
            .checked_sub(grant.not_before_unix_s)
            .ok_or(GrantError::InvalidField)?;
        if lifetime > self.max_lifetime_s {
            return Err(GrantError::LifetimeTooLong);
        }
        Ok(())
    }
}

/// Canonical claims authenticated against static trust, not an admitted or active grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedGrant {
    grant: GrantV1,
    payload_sha256: String,
}

impl AuthenticatedGrant {
    pub fn grant(&self) -> &GrantV1 {
        &self.grant
    }

    pub fn payload_sha256(&self) -> &str {
        &self.payload_sha256
    }
}

pub fn signature_input(payload: &[u8]) -> Result<Vec<u8>, GrantError> {
    if payload.is_empty() || payload.len() > MAX_GRANT_PAYLOAD_BYTES {
        return Err(GrantError::PayloadTooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| GrantError::PayloadTooLarge)?;
    let mut input = Vec::with_capacity(DOMAIN.len() + 4 + payload.len());
    input.extend_from_slice(DOMAIN);
    input.extend_from_slice(&length.to_be_bytes());
    input.extend_from_slice(payload);
    Ok(input)
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GrantError {
    #[error("grant version is unsupported")]
    Version,
    #[error("grant payload exceeds its bound")]
    PayloadTooLarge,
    #[error("grant encoding is invalid")]
    InvalidEncoding,
    #[error("grant encoding is not canonical")]
    NonCanonical,
    #[error("grant field is invalid")]
    InvalidField,
    #[error("grant verifier configuration or binding is invalid")]
    InvalidExpectation,
    #[error("issuer public key is invalid")]
    InvalidPublicKey,
    #[error("grant signature is invalid")]
    InvalidSignature,
    #[error("grant binding does not match local expectations")]
    BindingMismatch,
    #[error("grant lifetime exceeds the local limit")]
    LifetimeTooLong,
}

fn validate_id(value: &str) -> Result<(), GrantError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(GrantError::InvalidField);
    }
    Ok(())
}

fn validate_lower_hex_64(value: &str) -> Result<(), GrantError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(GrantError::InvalidField);
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use ring::signature::{Ed25519KeyPair, KeyPair};

    use super::*;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const NONCE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn key() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[7_u8; 32]).unwrap()
    }

    fn grant() -> GrantV1 {
        GrantV1 {
            version: GRANT_VERSION,
            grant_id: "grant-1".into(),
            issuer_id: "operator-1".into(),
            issuer_seq: 8,
            executor_id: "elpis-executor-v1-test".into(),
            policy_epoch: 3,
            not_before_unix_s: 1_700_000_000,
            expires_at_unix_s: 1_700_000_600,
            mind_id: "elm-e6menbfu".into(),
            mandate_sha256: HASH_A.into(),
            runtime_sha256: HASH_B.into(),
            policy_sha256: HASH_C.into(),
            mode: GrantMode::SensitiveGranted,
            nonce: NONCE.into(),
        }
    }

    fn binding() -> GrantBinding {
        GrantBinding {
            mind_id: "elm-e6menbfu".into(),
            mandate_sha256: HASH_A.into(),
            runtime_sha256: HASH_B.into(),
            policy_sha256: HASH_C.into(),
        }
    }

    fn signed(grant: &GrantV1) -> (Vec<u8>, Vec<u8>) {
        let payload = grant.canonical_payload().unwrap();
        let signature = key()
            .sign(&signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        (payload, signature)
    }

    fn verifier() -> GrantVerifier {
        let key = key();
        GrantVerifier::new(
            "operator-1",
            key.public_key().as_ref(),
            "elpis-executor-v1-test",
            3,
            900,
        )
        .unwrap()
    }

    #[test]
    fn canonical_payload_and_signature_input_have_golden_bytes() {
        let payload = grant().canonical_payload().unwrap();
        assert_eq!(
            payload,
            br#"{"version":1,"grant_id":"grant-1","issuer_id":"operator-1","issuer_seq":8,"executor_id":"elpis-executor-v1-test","policy_epoch":3,"not_before_unix_s":1700000000,"expires_at_unix_s":1700000600,"mind_id":"elm-e6menbfu","mandate_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtime_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policy_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","mode":"sensitive_granted","nonce":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}"#
        );
        let input = signature_input(&payload).unwrap();
        assert_eq!(&input[..DOMAIN.len()], DOMAIN);
        assert_eq!(
            &input[DOMAIN.len()..DOMAIN.len() + 4],
            &(payload.len() as u32).to_be_bytes()
        );
        assert_eq!(&input[DOMAIN.len() + 4..], payload);
        assert_eq!(
            hex::encode(key().sign(&input).as_ref()),
            "1f2e6988dd60b941aaee159d69acdedf3e81dd2c174b2f5eb832b2498cb4c2384f48d97262ac7b7895e936c57e78c13cf277790dd1ccd45b44791699fd65830b"
        );
    }

    #[test]
    fn exact_signed_grant_authenticates_and_returns_payload_hash() {
        let grant = grant();
        let (payload, signature) = signed(&grant);
        let verified = verifier()
            .authenticate(&payload, &signature, &binding())
            .unwrap();
        assert_eq!(verified.grant(), &grant);
        assert_eq!(verified.payload_sha256(), sha256_hex(&payload));
    }

    #[test]
    fn forged_tampered_and_wrong_key_signatures_are_rejected() {
        let (payload, mut signature) = signed(&grant());
        signature[0] ^= 1;
        assert_eq!(
            verifier().authenticate(&payload, &signature, &binding()),
            Err(GrantError::InvalidSignature)
        );

        let (_, signature) = signed(&grant());
        let mut tampered = payload.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(
            verifier().authenticate(&tampered, &signature, &binding()),
            Err(GrantError::InvalidSignature)
        );

        let other = Ed25519KeyPair::from_seed_unchecked(&[9_u8; 32]).unwrap();
        let verifier = GrantVerifier::new(
            "operator-1",
            other.public_key().as_ref(),
            "elpis-executor-v1-test",
            3,
            900,
        )
        .unwrap();
        assert_eq!(
            verifier.authenticate(&payload, &signed(&grant()).1, &binding()),
            Err(GrantError::InvalidSignature)
        );
    }

    #[test]
    fn validly_signed_noncanonical_json_is_rejected() {
        let canonical = String::from_utf8(grant().canonical_payload().unwrap()).unwrap();
        let variants = [
            format!(" {canonical}").into_bytes(),
            canonical
                .replacen(
                    "{\"version\":1,\"grant_id\":\"grant-1\",",
                    "{\"grant_id\":\"grant-1\",\"version\":1,",
                    1,
                )
                .into_bytes(),
            canonical
                .replacen("\"grant-1\"", "\"grant\\u002d1\"", 1)
                .into_bytes(),
        ];
        for payload in variants {
            assert!(serde_json::from_slice::<GrantV1>(&payload).is_ok());
            let signature = key().sign(&signature_input(&payload).unwrap());
            assert_eq!(
                verifier().authenticate(&payload, signature.as_ref(), &binding()),
                Err(GrantError::NonCanonical)
            );
        }
    }

    #[test]
    fn validly_signed_unknown_and_duplicate_fields_are_rejected() {
        let canonical = String::from_utf8(grant().canonical_payload().unwrap()).unwrap();
        let unknown = canonical.replacen("{", "{\"unknown\":1,", 1).into_bytes();
        let duplicate = canonical.replacen("{", "{\"version\":1,", 1).into_bytes();
        for payload in [unknown, duplicate] {
            let signature = key().sign(&signature_input(&payload).unwrap());
            assert_eq!(
                verifier().authenticate(&payload, signature.as_ref(), &binding()),
                Err(GrantError::InvalidEncoding)
            );
        }
    }

    #[test]
    fn lifetime_and_static_binding_fail_closed() {
        let (payload, signature) = signed(&grant());
        let mut cases = Vec::new();

        let mut wrong_mind = binding();
        wrong_mind.mind_id = "elm-other".into();
        cases.push((wrong_mind, GrantError::BindingMismatch));

        let mut wrong_mandate = binding();
        wrong_mandate.mandate_sha256 = NONCE.into();
        cases.push((wrong_mandate, GrantError::BindingMismatch));

        let mut wrong_runtime = binding();
        wrong_runtime.runtime_sha256 = NONCE.into();
        cases.push((wrong_runtime, GrantError::BindingMismatch));

        let mut wrong_policy = binding();
        wrong_policy.policy_sha256 = NONCE.into();
        cases.push((wrong_policy, GrantError::BindingMismatch));

        for (binding, error) in cases {
            assert_eq!(
                verifier().authenticate(&payload, &signature, &binding),
                Err(error)
            );
        }

        let short_lifetime = GrantVerifier::new(
            "operator-1",
            key().public_key().as_ref(),
            "elpis-executor-v1-test",
            3,
            599,
        )
        .unwrap();
        assert_eq!(
            short_lifetime.authenticate(&payload, &signature, &binding()),
            Err(GrantError::LifetimeTooLong)
        );

        for grant in [
            GrantV1 {
                issuer_id: "operator-2".into(),
                ..grant()
            },
            GrantV1 {
                executor_id: "elpis-executor-v1-other".into(),
                ..grant()
            },
            GrantV1 {
                policy_epoch: 4,
                ..grant()
            },
        ] {
            let (payload, signature) = signed(&grant);
            assert_eq!(
                verifier().authenticate(&payload, &signature, &binding()),
                Err(GrantError::BindingMismatch)
            );
        }
    }

    #[test]
    fn validly_signed_invalid_claims_are_rejected() {
        let cases = [
            (
                GrantV1 {
                    version: 2,
                    ..grant()
                },
                GrantError::Version,
            ),
            (
                GrantV1 {
                    grant_id: "not allowed".into(),
                    ..grant()
                },
                GrantError::InvalidField,
            ),
            (
                GrantV1 {
                    mandate_sha256: "A".repeat(64),
                    ..grant()
                },
                GrantError::InvalidField,
            ),
            (
                GrantV1 {
                    issuer_seq: 0,
                    ..grant()
                },
                GrantError::InvalidField,
            ),
            (
                GrantV1 {
                    expires_at_unix_s: 1_700_000_000,
                    ..grant()
                },
                GrantError::InvalidField,
            ),
        ];
        for (grant, error) in cases {
            let payload = serde_json::to_vec(&grant).unwrap();
            let signature = key().sign(&signature_input(&payload).unwrap());
            assert_eq!(
                verifier().authenticate(&payload, signature.as_ref(), &binding()),
                Err(error)
            );
        }
    }

    #[test]
    fn malformed_fields_and_bounds_are_rejected() {
        let mut invalid = grant();
        invalid.nonce = "D".repeat(64);
        assert_eq!(invalid.canonical_payload(), Err(GrantError::InvalidField));

        let mut invalid = grant();
        invalid.issuer_seq = 0;
        assert_eq!(invalid.canonical_payload(), Err(GrantError::InvalidField));

        assert!(matches!(
            GrantVerifier::new("operator-1", &[0_u8; 31], "elpis-executor-v1-test", 3, 900,),
            Err(GrantError::InvalidPublicKey)
        ));
        assert!(matches!(
            GrantVerifier::new("operator-1", &[0_u8; 32], "elpis-executor-v1-test", 3, 0,),
            Err(GrantError::InvalidExpectation)
        ));
        assert_eq!(
            signature_input(&vec![0_u8; MAX_GRANT_PAYLOAD_BYTES + 1]),
            Err(GrantError::PayloadTooLarge)
        );
        let (payload, _) = signed(&grant());
        assert_eq!(
            verifier().authenticate(&payload, &[0_u8; 63], &binding()),
            Err(GrantError::InvalidSignature)
        );
    }
}
