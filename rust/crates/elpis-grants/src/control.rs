use std::fmt;

use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    ED25519_PUBLIC_KEY_BYTES, ED25519_SIGNATURE_BYTES, sha256_hex, validate_id,
    validate_lower_hex_64,
};

pub const TERMINAL_CONTROL_VERSION: u32 = 1;
pub const MAX_TERMINAL_CONTROL_PAYLOAD_BYTES: usize = 4 * 1024;
const TERMINAL_CONTROL_DOMAIN: &[u8] = b"elpis-sensitive-terminal-control-v1\0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum TerminalControlActionV1 {
    RevokeGrant {
        grant_id: String,
        grant_payload_sha256: String,
    },
    FlagGrant {
        grant_id: String,
        grant_payload_sha256: String,
    },
    ClearLatch {
        profile_id: String,
        policy_sha256: String,
    },
}

impl TerminalControlActionV1 {
    fn validate(&self) -> Result<(), TerminalControlError> {
        match self {
            Self::RevokeGrant {
                grant_id,
                grant_payload_sha256,
            }
            | Self::FlagGrant {
                grant_id,
                grant_payload_sha256,
            } => {
                validate_id(grant_id).map_err(|_| TerminalControlError::InvalidField)?;
                validate_lower_hex_64(grant_payload_sha256)
                    .map_err(|_| TerminalControlError::InvalidField)
            }
            Self::ClearLatch {
                profile_id,
                policy_sha256,
            } => {
                validate_id(profile_id).map_err(|_| TerminalControlError::InvalidField)?;
                validate_lower_hex_64(policy_sha256).map_err(|_| TerminalControlError::InvalidField)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TerminalControlV1 {
    pub version: u32,
    pub control_id: String,
    pub issuer_id: String,
    pub issuer_seq: u64,
    pub executor_id: String,
    pub policy_epoch: u64,
    pub target: TerminalControlActionV1,
    pub issued_at_unix_s: u64,
    pub expires_at_unix_s: u64,
    pub nonce: String,
}

impl TerminalControlV1 {
    pub fn validate(&self) -> Result<(), TerminalControlError> {
        if self.version != TERMINAL_CONTROL_VERSION {
            return Err(TerminalControlError::Version);
        }
        for value in [&self.control_id, &self.issuer_id, &self.executor_id] {
            validate_id(value).map_err(|_| TerminalControlError::InvalidField)?;
        }
        if self.issuer_seq == 0
            || self.policy_epoch == 0
            || self.issued_at_unix_s == 0
            || self.expires_at_unix_s <= self.issued_at_unix_s
        {
            return Err(TerminalControlError::InvalidField);
        }
        validate_lower_hex_64(&self.nonce).map_err(|_| TerminalControlError::InvalidField)?;
        self.target.validate()
    }

    pub fn canonical_payload(&self) -> Result<Vec<u8>, TerminalControlError> {
        self.validate()?;
        let payload =
            serde_json::to_vec(self).map_err(|_| TerminalControlError::InvalidEncoding)?;
        if payload.len() > MAX_TERMINAL_CONTROL_PAYLOAD_BYTES {
            return Err(TerminalControlError::PayloadTooLarge);
        }
        Ok(payload)
    }
}

#[derive(Clone)]
pub struct TerminalControlVerifier {
    issuer_id: String,
    issuer_public_key: [u8; ED25519_PUBLIC_KEY_BYTES],
    executor_id: String,
    policy_epoch: u64,
    max_lifetime_s: u64,
}

impl fmt::Debug for TerminalControlVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TerminalControlVerifier")
            .field("issuer_id", &self.issuer_id)
            .field("public_key_sha256", &sha256_hex(&self.issuer_public_key))
            .field("executor_id", &self.executor_id)
            .field("policy_epoch", &self.policy_epoch)
            .field("max_lifetime_s", &self.max_lifetime_s)
            .finish()
    }
}

impl TerminalControlVerifier {
    pub fn new(
        issuer_id: impl Into<String>,
        issuer_public_key: &[u8],
        executor_id: impl Into<String>,
        policy_epoch: u64,
        max_lifetime_s: u64,
    ) -> Result<Self, TerminalControlError> {
        let issuer_id = issuer_id.into();
        let executor_id = executor_id.into();
        validate_id(&issuer_id).map_err(|_| TerminalControlError::InvalidExpectation)?;
        validate_id(&executor_id).map_err(|_| TerminalControlError::InvalidExpectation)?;
        let issuer_public_key = issuer_public_key
            .try_into()
            .map_err(|_| TerminalControlError::InvalidPublicKey)?;
        if policy_epoch == 0 || max_lifetime_s == 0 {
            return Err(TerminalControlError::InvalidExpectation);
        }
        Ok(Self {
            issuer_id,
            issuer_public_key,
            executor_id,
            policy_epoch,
            max_lifetime_s,
        })
    }

    /// Authenticates exact canonical signed claims against boot-frozen trust.
    ///
    /// This does not check current time, issuer-sequence freshness, replay, target state, or
    /// whether a latch-clear sequence is higher than the event that closed it.
    pub fn authenticate(
        &self,
        payload: &[u8],
        signature: &[u8],
    ) -> Result<AuthenticatedTerminalControl, TerminalControlError> {
        if payload.is_empty() || payload.len() > MAX_TERMINAL_CONTROL_PAYLOAD_BYTES {
            return Err(TerminalControlError::PayloadTooLarge);
        }
        if signature.len() != ED25519_SIGNATURE_BYTES {
            return Err(TerminalControlError::InvalidSignature);
        }
        let signed = terminal_control_signature_input(payload)?;
        UnparsedPublicKey::new(&ED25519, &self.issuer_public_key)
            .verify(&signed, signature)
            .map_err(|_| TerminalControlError::InvalidSignature)?;
        let control: TerminalControlV1 =
            serde_json::from_slice(payload).map_err(|_| TerminalControlError::InvalidEncoding)?;
        control.validate()?;
        if control.canonical_payload()? != payload {
            return Err(TerminalControlError::NonCanonical);
        }
        if control.issuer_id != self.issuer_id
            || control.executor_id != self.executor_id
            || control.policy_epoch != self.policy_epoch
        {
            return Err(TerminalControlError::BindingMismatch);
        }
        let lifetime = control
            .expires_at_unix_s
            .checked_sub(control.issued_at_unix_s)
            .ok_or(TerminalControlError::InvalidField)?;
        if lifetime > self.max_lifetime_s {
            return Err(TerminalControlError::LifetimeTooLong);
        }
        Ok(AuthenticatedTerminalControl {
            payload_sha256: sha256_hex(payload),
            control,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedTerminalControl {
    control: TerminalControlV1,
    payload_sha256: String,
}

impl AuthenticatedTerminalControl {
    pub fn control(&self) -> &TerminalControlV1 {
        &self.control
    }

    pub fn payload_sha256(&self) -> &str {
        &self.payload_sha256
    }
}

pub fn terminal_control_signature_input(payload: &[u8]) -> Result<Vec<u8>, TerminalControlError> {
    if payload.is_empty() || payload.len() > MAX_TERMINAL_CONTROL_PAYLOAD_BYTES {
        return Err(TerminalControlError::PayloadTooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| TerminalControlError::PayloadTooLarge)?;
    let mut input = Vec::with_capacity(TERMINAL_CONTROL_DOMAIN.len() + 4 + payload.len());
    input.extend_from_slice(TERMINAL_CONTROL_DOMAIN);
    input.extend_from_slice(&length.to_be_bytes());
    input.extend_from_slice(payload);
    Ok(input)
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TerminalControlError {
    #[error("terminal control version is unsupported")]
    Version,
    #[error("terminal control payload exceeds its bound")]
    PayloadTooLarge,
    #[error("terminal control encoding is invalid")]
    InvalidEncoding,
    #[error("terminal control encoding is not canonical")]
    NonCanonical,
    #[error("terminal control field is invalid")]
    InvalidField,
    #[error("terminal control verifier configuration is invalid")]
    InvalidExpectation,
    #[error("issuer public key is invalid")]
    InvalidPublicKey,
    #[error("terminal control signature is invalid")]
    InvalidSignature,
    #[error("terminal control does not match boot-frozen trust")]
    BindingMismatch,
    #[error("terminal control lifetime exceeds the local limit")]
    LifetimeTooLong,
}

#[cfg(test)]
mod tests {
    use ring::signature::{Ed25519KeyPair, KeyPair};

    use super::*;
    use crate::signature_input;

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const NONCE: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn key() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[9_u8; 32]).unwrap()
    }

    fn control(target: TerminalControlActionV1) -> TerminalControlV1 {
        TerminalControlV1 {
            version: TERMINAL_CONTROL_VERSION,
            control_id: "control-9".into(),
            issuer_id: "operator-1".into(),
            issuer_seq: 9,
            executor_id: "elpis-executor-v1-test".into(),
            policy_epoch: 3,
            target,
            issued_at_unix_s: 1_700_000_000,
            expires_at_unix_s: 1_700_000_300,
            nonce: NONCE.into(),
        }
    }

    fn verifier() -> TerminalControlVerifier {
        TerminalControlVerifier::new(
            "operator-1",
            key().public_key().as_ref(),
            "elpis-executor-v1-test",
            3,
            600,
        )
        .unwrap()
    }

    fn signed(value: &TerminalControlV1) -> (Vec<u8>, Vec<u8>) {
        let payload = value.canonical_payload().unwrap();
        let signature = key()
            .sign(&terminal_control_signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        (payload, signature)
    }

    #[test]
    fn authenticates_all_exact_terminal_targets() {
        let targets = [
            TerminalControlActionV1::RevokeGrant {
                grant_id: "grant-1".into(),
                grant_payload_sha256: HASH_A.into(),
            },
            TerminalControlActionV1::FlagGrant {
                grant_id: "grant-1".into(),
                grant_payload_sha256: HASH_A.into(),
            },
            TerminalControlActionV1::ClearLatch {
                profile_id: "sensitive-v1".into(),
                policy_sha256: HASH_B.into(),
            },
        ];
        for target in targets {
            let value = control(target);
            let (payload, signature) = signed(&value);
            let authenticated = verifier().authenticate(&payload, &signature).unwrap();
            assert_eq!(authenticated.control(), &value);
            assert_eq!(authenticated.payload_sha256(), sha256_hex(&payload));
        }
    }

    #[test]
    fn canonical_payload_and_signature_are_frozen() {
        let value = control(TerminalControlActionV1::ClearLatch {
            profile_id: "sensitive-v1".into(),
            policy_sha256: HASH_B.into(),
        });
        let (payload, signature) = signed(&value);
        assert_eq!(
            String::from_utf8(payload).unwrap(),
            r#"{"version":1,"control_id":"control-9","issuer_id":"operator-1","issuer_seq":9,"executor_id":"elpis-executor-v1-test","policy_epoch":3,"target":{"action":"clear_latch","profile_id":"sensitive-v1","policy_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"issued_at_unix_s":1700000000,"expires_at_unix_s":1700000300,"nonce":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}"#
        );
        assert_eq!(
            hex::encode(signature),
            "df4500102bf77f1490093f7e8a3a77c50f80244a81bc542681c9f1957e9405224ce2ec49c6107a91b1d36bf632458894ade45cd8b8c25c2bd64bdc3431a73f0a"
        );
    }

    #[test]
    fn grant_and_terminal_control_signature_domains_do_not_cross() {
        let value = control(TerminalControlActionV1::RevokeGrant {
            grant_id: "grant-1".into(),
            grant_payload_sha256: HASH_A.into(),
        });
        let payload = value.canonical_payload().unwrap();
        let wrong = key().sign(&signature_input(&payload).unwrap());
        assert_eq!(
            verifier().authenticate(&payload, wrong.as_ref()),
            Err(TerminalControlError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_noncanonical_unknown_invalid_and_mismatched_controls() {
        let value = control(TerminalControlActionV1::RevokeGrant {
            grant_id: "grant-1".into(),
            grant_payload_sha256: HASH_A.into(),
        });
        let (mut payload, _) = signed(&value);
        payload.push(b' ');
        let signature = key()
            .sign(&terminal_control_signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        assert_eq!(
            verifier().authenticate(&payload, &signature),
            Err(TerminalControlError::NonCanonical)
        );

        let mut unknown: serde_json::Value =
            serde_json::from_slice(&value.canonical_payload().unwrap()).unwrap();
        unknown["extra"] = serde_json::json!(true);
        let payload = serde_json::to_vec(&unknown).unwrap();
        let signature = key()
            .sign(&terminal_control_signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        assert_eq!(
            verifier().authenticate(&payload, &signature),
            Err(TerminalControlError::InvalidEncoding)
        );

        let mut invalid = value.clone();
        invalid.issuer_seq = 0;
        assert_eq!(invalid.validate(), Err(TerminalControlError::InvalidField));

        for mutation in 0..3 {
            let mut changed = value.clone();
            match mutation {
                0 => changed.issuer_id = "operator-2".into(),
                1 => changed.executor_id = "executor-2".into(),
                _ => changed.policy_epoch = 4,
            }
            let (payload, signature) = signed(&changed);
            assert_eq!(
                verifier().authenticate(&payload, &signature),
                Err(TerminalControlError::BindingMismatch)
            );
        }
    }

    #[test]
    fn target_fields_time_payload_and_signature_bounds_fail_closed() {
        let mut values = [
            control(TerminalControlActionV1::RevokeGrant {
                grant_id: "../grant".into(),
                grant_payload_sha256: HASH_A.into(),
            }),
            control(TerminalControlActionV1::FlagGrant {
                grant_id: "grant-1".into(),
                grant_payload_sha256: "A".repeat(64),
            }),
            control(TerminalControlActionV1::ClearLatch {
                profile_id: "profile/path".into(),
                policy_sha256: HASH_B.into(),
            }),
            control(TerminalControlActionV1::ClearLatch {
                profile_id: "sensitive-v1".into(),
                policy_sha256: "0".repeat(63),
            }),
        ];
        for value in &values {
            assert_eq!(value.validate(), Err(TerminalControlError::InvalidField));
        }
        values[0].target = TerminalControlActionV1::RevokeGrant {
            grant_id: "grant-1".into(),
            grant_payload_sha256: HASH_A.into(),
        };
        values[0].issued_at_unix_s = 0;
        assert_eq!(
            values[0].validate(),
            Err(TerminalControlError::InvalidField)
        );
        values[0].issued_at_unix_s = 1_700_000_000;
        values[0].expires_at_unix_s = values[0].issued_at_unix_s;
        assert_eq!(
            values[0].validate(),
            Err(TerminalControlError::InvalidField)
        );
        values[0].expires_at_unix_s = 1_700_000_300;
        values[0].nonce = "0".repeat(63);
        assert_eq!(
            values[0].validate(),
            Err(TerminalControlError::InvalidField)
        );

        let oversized = vec![b'x'; MAX_TERMINAL_CONTROL_PAYLOAD_BYTES + 1];
        assert_eq!(
            terminal_control_signature_input(&oversized),
            Err(TerminalControlError::PayloadTooLarge)
        );
        assert_eq!(
            verifier().authenticate(&oversized, &[0_u8; ED25519_SIGNATURE_BYTES]),
            Err(TerminalControlError::PayloadTooLarge)
        );
        let value = control(TerminalControlActionV1::RevokeGrant {
            grant_id: "grant-1".into(),
            grant_payload_sha256: HASH_A.into(),
        });
        let payload = value.canonical_payload().unwrap();
        assert_eq!(
            verifier().authenticate(&payload, &[0_u8; ED25519_SIGNATURE_BYTES - 1]),
            Err(TerminalControlError::InvalidSignature)
        );
    }

    #[test]
    fn lifetime_and_verifier_configuration_fail_closed() {
        let mut long = control(TerminalControlActionV1::ClearLatch {
            profile_id: "sensitive-v1".into(),
            policy_sha256: HASH_B.into(),
        });
        long.expires_at_unix_s = long.issued_at_unix_s + 601;
        let (payload, signature) = signed(&long);
        assert_eq!(
            verifier().authenticate(&payload, &signature),
            Err(TerminalControlError::LifetimeTooLong)
        );
        assert!(matches!(
            TerminalControlVerifier::new("operator-1", &[0_u8; 31], "executor-1", 3, 600),
            Err(TerminalControlError::InvalidPublicKey)
        ));
        assert!(matches!(
            TerminalControlVerifier::new("operator-1", &[0_u8; 32], "executor-1", 0, 600),
            Err(TerminalControlError::InvalidExpectation)
        ));
    }
}
