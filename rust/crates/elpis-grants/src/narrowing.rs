use std::fmt;

use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    ED25519_PUBLIC_KEY_BYTES, ED25519_SIGNATURE_BYTES, sha256_hex, validate_id,
    validate_lower_hex_64,
};

pub const NARROWING_PERMIT_VERSION: u32 = 1;
pub const MAX_NARROWING_PERMIT_PAYLOAD_BYTES: usize = 8 * 1024;
const MAX_CLASSIFIER_MODEL_REF_BYTES: usize = 200;
const NARROWING_PERMIT_DOMAIN: &[u8] = b"elpis-sensitive-narrowing-permit-v1\0";

/// The sole one-effect decision authenticated by a narrowing permit.
///
/// Authentication only proves that the issuer signed this outcome. Applying the outcome is the
/// responsibility of a separate admission/state layer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NarrowingOutcomeV1 {
    Allow,
    Revoke,
    Flag,
}

/// Canonical signed claims for one exact effect request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NarrowingPermitV1 {
    pub version: u32,
    pub permit_id: String,
    pub issuer_id: String,
    pub issuer_seq: u64,
    pub executor_id: String,
    pub policy_epoch: u64,
    pub grant_id: String,
    pub grant_payload_sha256: String,
    pub session_binding_sha256: String,
    pub effect_request_sha256: String,
    pub policy_sha256: String,
    pub classifier_model_ref: String,
    pub classifier_policy_sha256: String,
    pub outcome: NarrowingOutcomeV1,
    pub issued_at_unix_s: u64,
    pub expires_at_unix_s: u64,
    pub nonce: String,
}

impl NarrowingPermitV1 {
    pub fn validate(&self) -> Result<(), NarrowingPermitError> {
        if self.version != NARROWING_PERMIT_VERSION {
            return Err(NarrowingPermitError::Version);
        }
        for value in [
            &self.permit_id,
            &self.issuer_id,
            &self.executor_id,
            &self.grant_id,
        ] {
            validate_id(value).map_err(|_| NarrowingPermitError::InvalidField)?;
        }
        if self.issuer_seq == 0
            || self.policy_epoch == 0
            || self.issued_at_unix_s == 0
            || self.expires_at_unix_s <= self.issued_at_unix_s
        {
            return Err(NarrowingPermitError::InvalidField);
        }
        for value in [
            &self.grant_payload_sha256,
            &self.session_binding_sha256,
            &self.effect_request_sha256,
            &self.policy_sha256,
            &self.classifier_policy_sha256,
            &self.nonce,
        ] {
            validate_lower_hex_64(value).map_err(|_| NarrowingPermitError::InvalidField)?;
        }
        validate_classifier_model_ref(&self.classifier_model_ref)
    }

    pub fn canonical_payload(&self) -> Result<Vec<u8>, NarrowingPermitError> {
        self.validate()?;
        let payload =
            serde_json::to_vec(self).map_err(|_| NarrowingPermitError::InvalidEncoding)?;
        if payload.len() > MAX_NARROWING_PERMIT_PAYLOAD_BYTES {
            return Err(NarrowingPermitError::PayloadTooLarge);
        }
        Ok(payload)
    }
}

/// Exact local facts to which a permit must be bound.
///
/// These values are supplied for each authentication. They are not inferred from mutable session,
/// provider, policy, classifier, or effect state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrowingPermitBinding {
    pub grant_id: String,
    pub grant_payload_sha256: String,
    pub session_binding_sha256: String,
    pub effect_request_sha256: String,
    pub policy_sha256: String,
    pub classifier_model_ref: String,
    pub classifier_policy_sha256: String,
}

impl NarrowingPermitBinding {
    fn validate(&self) -> Result<(), NarrowingPermitError> {
        validate_id(&self.grant_id).map_err(|_| NarrowingPermitError::InvalidExpectation)?;
        for value in [
            &self.grant_payload_sha256,
            &self.session_binding_sha256,
            &self.effect_request_sha256,
            &self.policy_sha256,
            &self.classifier_policy_sha256,
        ] {
            validate_lower_hex_64(value).map_err(|_| NarrowingPermitError::InvalidExpectation)?;
        }
        validate_classifier_model_ref(&self.classifier_model_ref)
            .map_err(|_| NarrowingPermitError::InvalidExpectation)
    }
}

/// Boot-frozen trust for authenticating narrowing permits.
///
/// This verifier deliberately owns no signer, clock, replay/sequence state, evaluator, admission
/// decision, session mutation, provider, effect, or broker capability.
#[derive(Clone)]
pub struct NarrowingPermitVerifier {
    issuer_id: String,
    issuer_public_key: [u8; ED25519_PUBLIC_KEY_BYTES],
    executor_id: String,
    policy_epoch: u64,
    max_lifetime_s: u64,
}

impl fmt::Debug for NarrowingPermitVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NarrowingPermitVerifier")
            .field("issuer_id", &self.issuer_id)
            .field("public_key_sha256", &sha256_hex(&self.issuer_public_key))
            .field("executor_id", &self.executor_id)
            .field("policy_epoch", &self.policy_epoch)
            .field("max_lifetime_s", &self.max_lifetime_s)
            .finish()
    }
}

impl NarrowingPermitVerifier {
    pub fn new(
        issuer_id: impl Into<String>,
        issuer_public_key: &[u8],
        executor_id: impl Into<String>,
        policy_epoch: u64,
        max_lifetime_s: u64,
    ) -> Result<Self, NarrowingPermitError> {
        let issuer_id = issuer_id.into();
        let executor_id = executor_id.into();
        validate_id(&issuer_id).map_err(|_| NarrowingPermitError::InvalidExpectation)?;
        validate_id(&executor_id).map_err(|_| NarrowingPermitError::InvalidExpectation)?;
        let issuer_public_key = issuer_public_key
            .try_into()
            .map_err(|_| NarrowingPermitError::InvalidPublicKey)?;
        if policy_epoch == 0 || max_lifetime_s == 0 {
            return Err(NarrowingPermitError::InvalidExpectation);
        }
        Ok(Self {
            issuer_id,
            issuer_public_key,
            executor_id,
            policy_epoch,
            max_lifetime_s,
        })
    }

    /// Authenticates canonical signed claims against boot trust and every exact local binding.
    ///
    /// This does not evaluate the effect, apply the outcome, inspect current time, or enforce
    /// issuer-sequence freshness/replay. A successful result is evidence, not admission.
    pub fn authenticate(
        &self,
        payload: &[u8],
        signature: &[u8],
        binding: &NarrowingPermitBinding,
    ) -> Result<AuthenticatedNarrowingPermit, NarrowingPermitError> {
        if payload.is_empty() || payload.len() > MAX_NARROWING_PERMIT_PAYLOAD_BYTES {
            return Err(NarrowingPermitError::PayloadTooLarge);
        }
        if signature.len() != ED25519_SIGNATURE_BYTES {
            return Err(NarrowingPermitError::InvalidSignature);
        }
        let signed = narrowing_permit_signature_input(payload)?;
        UnparsedPublicKey::new(&ED25519, &self.issuer_public_key)
            .verify(&signed, signature)
            .map_err(|_| NarrowingPermitError::InvalidSignature)?;

        let permit: NarrowingPermitV1 =
            serde_json::from_slice(payload).map_err(|_| NarrowingPermitError::InvalidEncoding)?;
        permit.validate()?;
        if permit.canonical_payload()? != payload {
            return Err(NarrowingPermitError::NonCanonical);
        }
        binding.validate()?;
        self.validate_claims(&permit, binding)?;

        Ok(AuthenticatedNarrowingPermit {
            payload_sha256: sha256_hex(payload),
            permit,
        })
    }

    fn validate_claims(
        &self,
        permit: &NarrowingPermitV1,
        binding: &NarrowingPermitBinding,
    ) -> Result<(), NarrowingPermitError> {
        if permit.issuer_id != self.issuer_id
            || permit.executor_id != self.executor_id
            || permit.policy_epoch != self.policy_epoch
            || permit.grant_id != binding.grant_id
            || permit.grant_payload_sha256 != binding.grant_payload_sha256
            || permit.session_binding_sha256 != binding.session_binding_sha256
            || permit.effect_request_sha256 != binding.effect_request_sha256
            || permit.policy_sha256 != binding.policy_sha256
            || permit.classifier_model_ref != binding.classifier_model_ref
            || permit.classifier_policy_sha256 != binding.classifier_policy_sha256
        {
            return Err(NarrowingPermitError::BindingMismatch);
        }
        let lifetime = permit
            .expires_at_unix_s
            .checked_sub(permit.issued_at_unix_s)
            .ok_or(NarrowingPermitError::InvalidField)?;
        if lifetime > self.max_lifetime_s {
            return Err(NarrowingPermitError::LifetimeTooLong);
        }
        Ok(())
    }
}

/// Authenticated claims only; this type conveys no admission, freshness, or applied outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedNarrowingPermit {
    permit: NarrowingPermitV1,
    payload_sha256: String,
}

impl AuthenticatedNarrowingPermit {
    pub fn permit(&self) -> &NarrowingPermitV1 {
        &self.permit
    }

    pub fn payload_sha256(&self) -> &str {
        &self.payload_sha256
    }
}

/// Constructs the distinct, length-prefixed Ed25519 message for a canonical permit payload.
pub fn narrowing_permit_signature_input(payload: &[u8]) -> Result<Vec<u8>, NarrowingPermitError> {
    if payload.is_empty() || payload.len() > MAX_NARROWING_PERMIT_PAYLOAD_BYTES {
        return Err(NarrowingPermitError::PayloadTooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| NarrowingPermitError::PayloadTooLarge)?;
    let mut input = Vec::with_capacity(NARROWING_PERMIT_DOMAIN.len() + 4 + payload.len());
    input.extend_from_slice(NARROWING_PERMIT_DOMAIN);
    input.extend_from_slice(&length.to_be_bytes());
    input.extend_from_slice(payload);
    Ok(input)
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum NarrowingPermitError {
    #[error("narrowing permit version is unsupported")]
    Version,
    #[error("narrowing permit payload exceeds its bound")]
    PayloadTooLarge,
    #[error("narrowing permit encoding is invalid")]
    InvalidEncoding,
    #[error("narrowing permit encoding is not canonical")]
    NonCanonical,
    #[error("narrowing permit field is invalid")]
    InvalidField,
    #[error("narrowing permit verifier configuration or binding is invalid")]
    InvalidExpectation,
    #[error("issuer public key is invalid")]
    InvalidPublicKey,
    #[error("narrowing permit signature is invalid")]
    InvalidSignature,
    #[error("narrowing permit does not match boot-frozen local bindings")]
    BindingMismatch,
    #[error("narrowing permit lifetime exceeds the local limit")]
    LifetimeTooLong,
}

fn validate_classifier_model_ref(value: &str) -> Result<(), NarrowingPermitError> {
    if value.is_empty() || value.len() > MAX_CLASSIFIER_MODEL_REF_BYTES {
        return Err(NarrowingPermitError::InvalidField);
    }
    // A model is a conservative provider/name reference, never a URL, path, or endpoint.
    let mut parts = value.split('/');
    let provider = parts.next().ok_or(NarrowingPermitError::InvalidField)?;
    let model = parts.next().ok_or(NarrowingPermitError::InvalidField)?;
    if parts.next().is_some() {
        return Err(NarrowingPermitError::InvalidField);
    }
    validate_model_component(provider)?;
    validate_model_component(model)
}

fn validate_model_component(value: &str) -> Result<(), NarrowingPermitError> {
    validate_id(value).map_err(|_| NarrowingPermitError::InvalidField)?;
    if value == "."
        || value == ".."
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
        return Err(NarrowingPermitError::InvalidField);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use ring::signature::{Ed25519KeyPair, KeyPair};

    use super::*;
    use crate::{signature_input, terminal_control_signature_input};

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const HASH_E: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const NONCE: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn key() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[23_u8; 32]).unwrap()
    }

    fn permit(outcome: NarrowingOutcomeV1) -> NarrowingPermitV1 {
        NarrowingPermitV1 {
            version: NARROWING_PERMIT_VERSION,
            permit_id: "permit-0001".into(),
            issuer_id: "classifier-issuer-v1".into(),
            issuer_seq: 41,
            executor_id: "elpis-executor-v1-test".into(),
            policy_epoch: 7,
            grant_id: "grant-0009".into(),
            grant_payload_sha256: HASH_A.into(),
            session_binding_sha256: HASH_B.into(),
            effect_request_sha256: HASH_C.into(),
            policy_sha256: HASH_D.into(),
            classifier_model_ref: "local/classifier-v1".into(),
            classifier_policy_sha256: HASH_E.into(),
            outcome,
            issued_at_unix_s: 1_700_000_000,
            expires_at_unix_s: 1_700_000_120,
            nonce: NONCE.into(),
        }
    }

    fn binding() -> NarrowingPermitBinding {
        NarrowingPermitBinding {
            grant_id: "grant-0009".into(),
            grant_payload_sha256: HASH_A.into(),
            session_binding_sha256: HASH_B.into(),
            effect_request_sha256: HASH_C.into(),
            policy_sha256: HASH_D.into(),
            classifier_model_ref: "local/classifier-v1".into(),
            classifier_policy_sha256: HASH_E.into(),
        }
    }

    fn verifier() -> NarrowingPermitVerifier {
        NarrowingPermitVerifier::new(
            "classifier-issuer-v1",
            key().public_key().as_ref(),
            "elpis-executor-v1-test",
            7,
            300,
        )
        .unwrap()
    }

    fn signed(value: &NarrowingPermitV1) -> (Vec<u8>, Vec<u8>) {
        let payload = value.canonical_payload().unwrap();
        let signature = key()
            .sign(&narrowing_permit_signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        (payload, signature)
    }

    fn authenticate(
        value: &NarrowingPermitV1,
    ) -> Result<AuthenticatedNarrowingPermit, NarrowingPermitError> {
        let (payload, signature) = signed(value);
        verifier().authenticate(&payload, &signature, &binding())
    }

    #[test]
    fn canonical_payload_and_signature_vector_are_frozen() {
        let payload = permit(NarrowingOutcomeV1::Allow)
            .canonical_payload()
            .unwrap();
        assert_eq!(
            payload,
            br#"{"version":1,"permit_id":"permit-0001","issuer_id":"classifier-issuer-v1","issuer_seq":41,"executor_id":"elpis-executor-v1-test","policy_epoch":7,"grant_id":"grant-0009","grant_payload_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","session_binding_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","effect_request_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","policy_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","classifier_model_ref":"local/classifier-v1","classifier_policy_sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","outcome":"allow","issued_at_unix_s":1700000000,"expires_at_unix_s":1700000120,"nonce":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}"#
        );
        let input = narrowing_permit_signature_input(&payload).unwrap();
        assert_eq!(
            &input[..NARROWING_PERMIT_DOMAIN.len()],
            NARROWING_PERMIT_DOMAIN
        );
        assert_eq!(
            &input[NARROWING_PERMIT_DOMAIN.len()..NARROWING_PERMIT_DOMAIN.len() + 4],
            &(payload.len() as u32).to_be_bytes()
        );
        assert_eq!(&input[NARROWING_PERMIT_DOMAIN.len() + 4..], payload);
        assert_eq!(
            hex::encode(key().sign(&input).as_ref()),
            "47f07e32015a1b133e6b9c8a4ec4a219e0bb3de1a6eeb9fe5997dbe14c2cfa42dd184c596bc9695256999c69721d6a956d97abf32f21a4b8711002938083b802"
        );
    }

    #[test]
    fn authenticates_each_outcome_as_claims_only() {
        for outcome in [
            NarrowingOutcomeV1::Allow,
            NarrowingOutcomeV1::Revoke,
            NarrowingOutcomeV1::Flag,
        ] {
            let expected = permit(outcome);
            let (payload, signature) = signed(&expected);
            let authenticated = verifier()
                .authenticate(&payload, &signature, &binding())
                .unwrap();
            assert_eq!(authenticated.permit(), &expected);
            assert_eq!(authenticated.payload_sha256(), sha256_hex(&payload));
        }
    }

    #[test]
    fn every_per_request_and_boot_binding_is_exact() {
        let (payload, signature) = signed(&permit(NarrowingOutcomeV1::Allow));
        let mut bindings = Vec::new();
        let mut value = binding();
        value.grant_id = "grant-other".into();
        bindings.push(value);
        let mut value = binding();
        value.grant_payload_sha256 = HASH_B.into();
        bindings.push(value);
        let mut value = binding();
        value.session_binding_sha256 = HASH_C.into();
        bindings.push(value);
        let mut value = binding();
        value.effect_request_sha256 = HASH_D.into();
        bindings.push(value);
        let mut value = binding();
        value.policy_sha256 = HASH_E.into();
        bindings.push(value);
        let mut value = binding();
        value.classifier_model_ref = "local/classifier-v2".into();
        bindings.push(value);
        let mut value = binding();
        value.classifier_policy_sha256 = HASH_A.into();
        bindings.push(value);

        for local in bindings {
            assert_eq!(
                verifier().authenticate(&payload, &signature, &local),
                Err(NarrowingPermitError::BindingMismatch)
            );
        }

        for boot in [
            NarrowingPermitVerifier::new(
                "other-issuer",
                key().public_key().as_ref(),
                "elpis-executor-v1-test",
                7,
                300,
            )
            .unwrap(),
            NarrowingPermitVerifier::new(
                "classifier-issuer-v1",
                key().public_key().as_ref(),
                "other-executor",
                7,
                300,
            )
            .unwrap(),
            NarrowingPermitVerifier::new(
                "classifier-issuer-v1",
                key().public_key().as_ref(),
                "elpis-executor-v1-test",
                8,
                300,
            )
            .unwrap(),
        ] {
            assert_eq!(
                boot.authenticate(&payload, &signature, &binding()),
                Err(NarrowingPermitError::BindingMismatch)
            );
        }
    }

    #[test]
    fn forged_tampered_wrong_key_and_cross_domain_signatures_fail() {
        let (payload, signature) = signed(&permit(NarrowingOutcomeV1::Allow));
        let mut forged = signature.clone();
        forged[0] ^= 1;
        assert_eq!(
            verifier().authenticate(&payload, &forged, &binding()),
            Err(NarrowingPermitError::InvalidSignature)
        );

        let mut tampered = payload.clone();
        let index = tampered.iter().position(|byte| *byte == b'a').unwrap();
        tampered[index] = b'b';
        assert_eq!(
            verifier().authenticate(&tampered, &signature, &binding()),
            Err(NarrowingPermitError::InvalidSignature)
        );

        let other = Ed25519KeyPair::from_seed_unchecked(&[24_u8; 32]).unwrap();
        let wrong_key = NarrowingPermitVerifier::new(
            "classifier-issuer-v1",
            other.public_key().as_ref(),
            "elpis-executor-v1-test",
            7,
            300,
        )
        .unwrap();
        assert_eq!(
            wrong_key.authenticate(&payload, &signature, &binding()),
            Err(NarrowingPermitError::InvalidSignature)
        );

        for input in [
            signature_input(&payload).unwrap(),
            terminal_control_signature_input(&payload).unwrap(),
        ] {
            let cross_signature = key().sign(&input);
            assert_eq!(
                verifier().authenticate(&payload, cross_signature.as_ref(), &binding()),
                Err(NarrowingPermitError::InvalidSignature)
            );
        }
    }

    #[test]
    fn validly_signed_noncanonical_json_fails_closed() {
        let canonical = String::from_utf8(
            permit(NarrowingOutcomeV1::Allow)
                .canonical_payload()
                .unwrap(),
        )
        .unwrap();
        let variants = [
            format!(" {canonical}").into_bytes(),
            canonical
                .replacen(
                    "{\"version\":1,\"permit_id\":\"permit-0001\",",
                    "{\"permit_id\":\"permit-0001\",\"version\":1,",
                    1,
                )
                .into_bytes(),
            canonical
                .replacen("\"permit-0001\"", "\"permit\\u002d0001\"", 1)
                .into_bytes(),
        ];
        for payload in variants {
            assert!(serde_json::from_slice::<NarrowingPermitV1>(&payload).is_ok());
            let signature = key().sign(&narrowing_permit_signature_input(&payload).unwrap());
            assert_eq!(
                verifier().authenticate(&payload, signature.as_ref(), &binding()),
                Err(NarrowingPermitError::NonCanonical)
            );
        }
    }

    #[test]
    fn unknown_duplicate_and_invalid_outcome_fields_are_rejected() {
        let canonical = String::from_utf8(
            permit(NarrowingOutcomeV1::Allow)
                .canonical_payload()
                .unwrap(),
        )
        .unwrap();
        for payload in [
            canonical.replacen('{', "{\"unknown\":1,", 1).into_bytes(),
            canonical.replacen('{', "{\"version\":1,", 1).into_bytes(),
            canonical
                .replacen("\"outcome\":\"allow\"", "\"outcome\":\"deny\"", 1)
                .into_bytes(),
        ] {
            let signature = key().sign(&narrowing_permit_signature_input(&payload).unwrap());
            assert_eq!(
                verifier().authenticate(&payload, signature.as_ref(), &binding()),
                Err(NarrowingPermitError::InvalidEncoding)
            );
        }
    }

    #[test]
    fn field_validation_and_model_reference_are_conservative() {
        let mut invalid = Vec::new();
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.version = 2;
        assert_eq!(value.validate(), Err(NarrowingPermitError::Version));

        for model_ref in [
            "local",
            "/classifier-v1",
            "local/",
            "local/a/b",
            "local/..",
            "local/.hidden",
            "local/trailing-",
            "https://example.com/model",
            "local/classifier v1",
        ] {
            let mut value = permit(NarrowingOutcomeV1::Allow);
            value.classifier_model_ref = model_ref.into();
            invalid.push(value);
        }
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.issuer_seq = 0;
        invalid.push(value);
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.policy_epoch = 0;
        invalid.push(value);
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.issued_at_unix_s = 0;
        invalid.push(value);
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.expires_at_unix_s = value.issued_at_unix_s;
        invalid.push(value);
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.permit_id = "bad/id".into();
        invalid.push(value);
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.effect_request_sha256 = HASH_A.to_uppercase();
        invalid.push(value);
        let mut value = permit(NarrowingOutcomeV1::Allow);
        value.nonce.pop();
        invalid.push(value);

        for value in invalid {
            assert_eq!(value.validate(), Err(NarrowingPermitError::InvalidField));
        }
        assert!(permit(NarrowingOutcomeV1::Flag).validate().is_ok());
    }

    #[test]
    fn lifetime_configuration_binding_signature_and_payload_bounds_fail_closed() {
        let mut long = permit(NarrowingOutcomeV1::Allow);
        long.expires_at_unix_s = long.issued_at_unix_s + 301;
        assert_eq!(
            authenticate(&long),
            Err(NarrowingPermitError::LifetimeTooLong)
        );

        for (epoch, lifetime) in [(0, 1), (1, 0)] {
            assert!(matches!(
                NarrowingPermitVerifier::new(
                    "classifier-issuer-v1",
                    key().public_key().as_ref(),
                    "elpis-executor-v1-test",
                    epoch,
                    lifetime,
                ),
                Err(NarrowingPermitError::InvalidExpectation)
            ));
        }
        assert!(matches!(
            NarrowingPermitVerifier::new(
                "classifier-issuer-v1",
                &[0; 31],
                "elpis-executor-v1-test",
                7,
                300,
            ),
            Err(NarrowingPermitError::InvalidPublicKey)
        ));

        let mut invalid_binding = binding();
        invalid_binding.classifier_model_ref = "https://example.com/model".into();
        let (payload, signature) = signed(&permit(NarrowingOutcomeV1::Allow));
        assert_eq!(
            verifier().authenticate(&payload, &signature, &invalid_binding),
            Err(NarrowingPermitError::InvalidExpectation)
        );
        assert_eq!(
            verifier().authenticate(&payload, &[0; 63], &binding()),
            Err(NarrowingPermitError::InvalidSignature)
        );

        for payload in [
            Vec::new(),
            vec![b' '; MAX_NARROWING_PERMIT_PAYLOAD_BYTES + 1],
        ] {
            assert_eq!(
                narrowing_permit_signature_input(&payload),
                Err(NarrowingPermitError::PayloadTooLarge)
            );
            assert_eq!(
                verifier().authenticate(&payload, &[0; 64], &binding()),
                Err(NarrowingPermitError::PayloadTooLarge)
            );
        }
    }
}
