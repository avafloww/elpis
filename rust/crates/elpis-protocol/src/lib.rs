use std::collections::HashSet;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const PROTOCOL_V1_VERSION: u32 = 1;
pub const PROTOCOL_V2_VERSION: u32 = 2;
/// The only active wire protocol. V2 DTOs are intentionally dormant.
pub const PROTOCOL_VERSION: u32 = PROTOCOL_V1_VERSION;
pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_SOURCE_BYTES: usize = 524_288;
pub const DEFAULT_PREVIEW_BYTES: usize = 16_384;
pub const MAX_PREVIEW_BYTES: usize = 65_536;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("protocol version mismatch")]
    Version,
    #[error("{0} must be 1 to {1} ASCII letters, digits, '.', '_', ':', or '-'")]
    InvalidId(&'static str, usize),
    #[error("generation must be greater than zero")]
    InvalidGeneration,
    #[error("source exceeds {MAX_SOURCE_BYTES} bytes")]
    SourceTooLarge,
    #[error("preview limit must be from 1 to {MAX_PREVIEW_BYTES} bytes")]
    InvalidPreviewLimit,
    #[error("invalid response shape")]
    InvalidResponse,
    #[error("invalid protocol-2 response shape")]
    InvalidResponseV2,
    #[error("invalid protocol-2 effect binding")]
    InvalidEffectBindingV2,
    #[error("invalid canonical base64url receipt")]
    InvalidReceiptEncoding,
    #[error("receipt SHA-256 does not match its bytes")]
    ReceiptHashMismatch,
    #[error("a receipt exceeds {MAX_EFFECT_RECEIPT_BYTES_V2} decoded bytes")]
    ReceiptTooLarge,
    #[error("too many completed effect receipts")]
    TooManyReceipts,
    #[error("completed effect receipts exceed their aggregate decoded byte limit")]
    ReceiptsTooLarge,
    #[error("completed effect receipts are not strictly ordered and unique")]
    InvalidReceiptOrder,
    #[error("protocol response exceeds {MAX_RESPONSE_BYTES_V2} bytes")]
    FrameTooLarge,
}

pub fn validate_id(label: &'static str, value: &str, max: usize) -> Result<(), ProtocolError> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(ProtocolError::InvalidId(label, max));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestV1 {
    Validate {
        protocol: u32,
        request_id: String,
        source: String,
    },
    Open {
        protocol: u32,
        request_id: String,
        context_id: String,
        generation: u64,
    },
    Run {
        protocol: u32,
        request_id: String,
        context_id: String,
        generation: u64,
        run_id: String,
        source: String,
        #[serde(default = "default_preview_bytes")]
        preview_max_bytes: usize,
    },
    Cancel {
        protocol: u32,
        request_id: String,
        context_id: String,
        generation: u64,
        target_request_id: String,
        run_id: String,
    },
    Close {
        protocol: u32,
        request_id: String,
        context_id: String,
        generation: u64,
    },
}

const fn default_preview_bytes() -> usize {
    DEFAULT_PREVIEW_BYTES
}

impl RequestV1 {
    pub fn request_id(&self) -> &str {
        match self {
            Self::Validate { request_id, .. }
            | Self::Open { request_id, .. }
            | Self::Run { request_id, .. }
            | Self::Cancel { request_id, .. }
            | Self::Close { request_id, .. } => request_id,
        }
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        let protocol = match self {
            Self::Validate { protocol, .. }
            | Self::Open { protocol, .. }
            | Self::Run { protocol, .. }
            | Self::Cancel { protocol, .. }
            | Self::Close { protocol, .. } => *protocol,
        };
        if protocol != PROTOCOL_V1_VERSION {
            return Err(ProtocolError::Version);
        }
        validate_id("request_id", self.request_id(), 120)?;
        match self {
            Self::Validate { source, .. } => validate_source(source),
            Self::Open {
                context_id,
                generation,
                ..
            }
            | Self::Close {
                context_id,
                generation,
                ..
            } => {
                validate_id("context_id", context_id, 120)?;
                validate_generation(*generation)
            }
            Self::Run {
                context_id,
                generation,
                run_id,
                source,
                preview_max_bytes,
                ..
            } => {
                validate_id("context_id", context_id, 120)?;
                validate_generation(*generation)?;
                validate_id("run_id", run_id, 120)?;
                validate_source(source)?;
                if !(1..=MAX_PREVIEW_BYTES).contains(preview_max_bytes) {
                    return Err(ProtocolError::InvalidPreviewLimit);
                }
                Ok(())
            }
            Self::Cancel {
                context_id,
                generation,
                target_request_id,
                run_id,
                ..
            } => {
                validate_id("context_id", context_id, 120)?;
                validate_generation(*generation)?;
                validate_id("target_request_id", target_request_id, 120)?;
                validate_id("run_id", run_id, 120)
            }
        }
    }
}

fn validate_generation(generation: u64) -> Result<(), ProtocolError> {
    if generation == 0 {
        return Err(ProtocolError::InvalidGeneration);
    }
    Ok(())
}

fn validate_source(source: &str) -> Result<(), ProtocolError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(ProtocolError::SourceTooLarge);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResponseV1 {
    pub protocol: u32,
    pub request_id: Option<String>,
    pub ok: bool,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ResponseV1 {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol != PROTOCOL_V1_VERSION
            || self
                .request_id
                .as_deref()
                .is_some_and(|id| validate_id("request_id", id, 120).is_err())
            || validate_id("response kind", &self.kind, 120).is_err()
        {
            return Err(ProtocolError::InvalidResponse);
        }
        if self.ok {
            if self.request_id.is_some()
                && self.result.is_some()
                && self.failure_kind.is_none()
                && self.error.is_none()
            {
                return Ok(());
            }
            return Err(ProtocolError::InvalidResponse);
        }
        let Some(failure_kind) = self.failure_kind.as_deref() else {
            return Err(ProtocolError::InvalidResponse);
        };
        if validate_id("failure kind", failure_kind, 120).is_err()
            || self.error.as_deref().is_none_or(str::is_empty)
        {
            return Err(ProtocolError::InvalidResponse);
        }
        match (failure_kind, self.result.as_ref()) {
            ("cancelled", Some(Value::Object(proof)))
                if proof.len() == 2
                    && proof.get("started").is_some_and(Value::is_boolean)
                    && proof
                        .get("context_invalidated")
                        .is_some_and(Value::is_boolean) =>
            {
                Ok(())
            }
            ("cancelled", _) | (_, Some(_)) => Err(ProtocolError::InvalidResponse),
            (_, None) => Ok(()),
        }
    }

    pub fn success(request_id: String, kind: impl Into<String>, result: Value) -> Self {
        Self {
            protocol: PROTOCOL_V1_VERSION,
            request_id: Some(request_id),
            ok: true,
            kind: kind.into(),
            result: Some(result),
            failure_kind: None,
            error: None,
        }
    }

    pub fn failure(
        request_id: Option<String>,
        kind: impl Into<String>,
        failure_kind: impl Into<String>,
        error: impl Into<String>,
    ) -> Self {
        Self {
            protocol: PROTOCOL_V1_VERSION,
            request_id,
            ok: false,
            kind: kind.into(),
            result: None,
            failure_kind: Some(failure_kind.into()),
            error: Some(error.into()),
        }
    }
}

/// Stable name for the currently active protocol-1 request DTO.
pub type Request = RequestV1;
/// Stable name for the currently active protocol-1 response DTO.
pub type Response = ResponseV1;

/// Version-scoped access to the frozen protocol-1 DTOs.
pub mod v1 {
    pub use super::{RequestV1 as Request, ResponseV1 as Response};
    pub const PROTOCOL_VERSION: u32 = super::PROTOCOL_V1_VERSION;
}

pub const MAX_NAME_BYTES_V2: usize = 120;
pub const MAX_EFFECT_RECEIPT_BYTES_V2: usize = 256 * 1024;
pub const MAX_COMPLETED_EFFECTS_V2: usize = 64;
pub const MAX_TOTAL_EFFECT_RECEIPT_BYTES_V2: usize = 512 * 1024;
pub const MAX_ERROR_BYTES_V2: usize = 8192;
/// Leaves bounded space for the future transport response envelope.
pub const MAX_RESPONSE_BYTES_V2: usize = MAX_FRAME_BYTES - 4096;
const MAX_RECEIPT_BASE64URL_BYTES_V2: usize = (MAX_EFFECT_RECEIPT_BYTES_V2 / 3) * 4 + 3;

/// Complete provenance for one effect. Executor identity is deliberately not
/// part of this logical, replay-stable binding.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct EffectBindingV2 {
    pub effect_id: String,
    pub request_id: String,
    pub context_id: String,
    pub generation: u64,
    pub run_id: String,
    pub call_index: u64,
    pub capability: String,
    pub request_sha256: String,
}

impl EffectBindingV2 {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if !is_lower_hex_64(&self.effect_id)
            || !is_lower_hex_64(&self.request_sha256)
            || validate_id("request_id", &self.request_id, MAX_NAME_BYTES_V2).is_err()
            || validate_id("context_id", &self.context_id, MAX_NAME_BYTES_V2).is_err()
            || validate_id("run_id", &self.run_id, MAX_NAME_BYTES_V2).is_err()
            || validate_id("capability", &self.capability, MAX_NAME_BYTES_V2).is_err()
            || self.generation == 0
        {
            return Err(ProtocolError::InvalidEffectBindingV2);
        }
        Ok(())
    }

    fn logical_key(&self) -> (&str, &str, u64, &str, u64) {
        (
            &self.request_id,
            &self.context_id,
            self.generation,
            &self.run_id,
            self.call_index,
        )
    }

    fn run_key(&self) -> (&str, &str, u64, &str) {
        (
            &self.request_id,
            &self.context_id,
            self.generation,
            &self.run_id,
        )
    }
}

/// Exact canonical receipt bytes and their digest for a completed effect.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CompletedEffectReceiptV2 {
    pub binding: EffectBindingV2,
    /// Unpadded base64url encoding of the capability-defined canonical bytes.
    pub receipt: String,
    pub receipt_sha256: String,
}

impl CompletedEffectReceiptV2 {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.binding.validate()?;
        if !is_lower_hex_64(&self.receipt_sha256) {
            return Err(ProtocolError::InvalidReceiptEncoding);
        }
        if self.receipt.len() > MAX_RECEIPT_BASE64URL_BYTES_V2 {
            return Err(ProtocolError::ReceiptTooLarge);
        }
        let decoded = URL_SAFE_NO_PAD
            .decode(self.receipt.as_bytes())
            .map_err(|_| ProtocolError::InvalidReceiptEncoding)?;
        if decoded.len() > MAX_EFFECT_RECEIPT_BYTES_V2 {
            return Err(ProtocolError::ReceiptTooLarge);
        }
        // Decoding alone is not enough: this rejects non-zero trailing bits,
        // padding, alternate alphabets, and every non-canonical spelling.
        if URL_SAFE_NO_PAD.encode(&decoded) != self.receipt {
            return Err(ProtocolError::InvalidReceiptEncoding);
        }
        let actual = format!("{:x}", Sha256::digest(&decoded));
        if actual != self.receipt_sha256 {
            return Err(ProtocolError::ReceiptHashMismatch);
        }
        Ok(())
    }

    pub fn receipt_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        URL_SAFE_NO_PAD
            .decode(self.receipt.as_bytes())
            .map_err(|_| ProtocolError::InvalidReceiptEncoding)
    }
}

/// The only protocol-defined causes for losing certainty after an effect may
/// have crossed the capability boundary.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectAmbiguityReasonV2 {
    PreparedAfterRestart,
    CompletionPersistenceFailed,
    ReceiptIntegrityFailed,
    ExecutorLost,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectAmbiguityV2 {
    pub binding: EffectBindingV2,
    pub reason: EffectAmbiguityReasonV2,
    pub may_have_occurred: bool,
    pub context_invalidated: bool,
}

impl EffectAmbiguityV2 {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.binding.validate()?;
        if !self.may_have_occurred || !self.context_invalidated {
            return Err(ProtocolError::InvalidResponseV2);
        }
        Ok(())
    }
}

/// Dormant protocol-2 response. It is intentionally not used by transport,
/// executor, journal, or client code until a separate negotiation change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResponseV2 {
    pub protocol: u32,
    pub request_id: Option<String>,
    pub ok: bool,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub completed_effects: Vec<CompletedEffectReceiptV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambiguity: Option<EffectAmbiguityV2>,
}

impl ResponseV2 {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.validate_shape()?;
        let encoded = serde_json::to_vec(self).map_err(|_| ProtocolError::InvalidResponseV2)?;
        if encoded.len() > MAX_RESPONSE_BYTES_V2 {
            return Err(ProtocolError::FrameTooLarge);
        }
        Ok(())
    }

    fn validate_shape(&self) -> Result<(), ProtocolError> {
        if self.protocol != PROTOCOL_V2_VERSION
            || self
                .request_id
                .as_deref()
                .is_some_and(|id| validate_id("request_id", id, MAX_NAME_BYTES_V2).is_err())
            || validate_id("response kind", &self.kind, MAX_NAME_BYTES_V2).is_err()
        {
            return Err(ProtocolError::InvalidResponseV2);
        }
        if self.completed_effects.len() > MAX_COMPLETED_EFFECTS_V2 {
            return Err(ProtocolError::TooManyReceipts);
        }

        let mut total_receipt_bytes = 0usize;
        let mut prior_call_index = None;
        let mut run_key = None;
        let mut effect_ids = HashSet::with_capacity(self.completed_effects.len());
        let mut logical_keys = HashSet::with_capacity(self.completed_effects.len());
        for receipt in &self.completed_effects {
            receipt.validate()?;
            let receipt_run_key = receipt.binding.run_key();
            if self.request_id.as_deref() != Some(receipt.binding.request_id.as_str())
                || run_key.is_some_and(|expected| expected != receipt_run_key)
            {
                return Err(ProtocolError::InvalidResponseV2);
            }
            run_key = Some(receipt_run_key);
            if prior_call_index.is_some_and(|prior| prior >= receipt.binding.call_index)
                || !effect_ids.insert(receipt.binding.effect_id.as_str())
                || !logical_keys.insert(receipt.binding.logical_key())
            {
                return Err(ProtocolError::InvalidReceiptOrder);
            }
            prior_call_index = Some(receipt.binding.call_index);
            // Validation above proved this is canonical and bounded.
            let decoded_len = URL_SAFE_NO_PAD
                .decode(receipt.receipt.as_bytes())
                .map_err(|_| ProtocolError::InvalidReceiptEncoding)?
                .len();
            total_receipt_bytes = total_receipt_bytes
                .checked_add(decoded_len)
                .ok_or(ProtocolError::ReceiptsTooLarge)?;
            if total_receipt_bytes > MAX_TOTAL_EFFECT_RECEIPT_BYTES_V2 {
                return Err(ProtocolError::ReceiptsTooLarge);
            }
        }

        if let Some(ambiguity) = &self.ambiguity {
            ambiguity.validate()?;
            if self.request_id.as_deref() != Some(ambiguity.binding.request_id.as_str())
                || run_key.is_some_and(|expected| expected != ambiguity.binding.run_key())
                || effect_ids.contains(ambiguity.binding.effect_id.as_str())
                || logical_keys.contains(&ambiguity.binding.logical_key())
                || prior_call_index.is_some_and(|prior| prior >= ambiguity.binding.call_index)
            {
                return Err(ProtocolError::InvalidResponseV2);
            }
        }

        let error_is_valid = self
            .error
            .as_deref()
            .is_some_and(|error| !error.is_empty() && error.len() <= MAX_ERROR_BYTES_V2);
        if self.ok {
            if self.request_id.is_none()
                || self.result.is_none()
                || self.failure_kind.is_some()
                || self.error.is_some()
                || self.ambiguity.is_some()
            {
                return Err(ProtocolError::InvalidResponseV2);
            }
            return Ok(());
        }

        let Some(failure_kind) = self.failure_kind.as_deref() else {
            return Err(ProtocolError::InvalidResponseV2);
        };
        if validate_id("failure kind", failure_kind, MAX_NAME_BYTES_V2).is_err() || !error_is_valid
        {
            return Err(ProtocolError::InvalidResponseV2);
        }
        if (failure_kind == "effect_ambiguous") != self.ambiguity.is_some() {
            return Err(ProtocolError::InvalidResponseV2);
        }
        match (failure_kind, self.result.as_ref()) {
            ("cancelled", Some(Value::Object(proof))) => {
                let started = proof.get("started").and_then(Value::as_bool);
                let context_invalidated = proof.get("context_invalidated").and_then(Value::as_bool);
                if proof.len() != 2 || started.is_none() || started != context_invalidated {
                    return Err(ProtocolError::InvalidResponseV2);
                }
            }
            ("cancelled", _) | (_, Some(_)) => {
                return Err(ProtocolError::InvalidResponseV2);
            }
            (_, None) => {}
        }
        Ok(())
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() > MAX_RESPONSE_BYTES_V2 {
            return Err(ProtocolError::FrameTooLarge);
        }
        let response: Self =
            serde_json::from_slice(bytes).map_err(|_| ProtocolError::InvalidResponseV2)?;
        response.validate()?;
        Ok(response)
    }

    pub fn to_json(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|_| ProtocolError::InvalidResponseV2)
    }
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Version-scoped access to the dormant protocol-2 DTOs and limits.
pub mod v2 {
    pub use super::{
        CompletedEffectReceiptV2 as CompletedEffectReceipt,
        EffectAmbiguityReasonV2 as EffectAmbiguityReason, EffectAmbiguityV2 as EffectAmbiguity,
        EffectBindingV2 as EffectBinding, ResponseV2 as Response,
    };
    pub const PROTOCOL_VERSION: u32 = super::PROTOCOL_V2_VERSION;
    pub const MAX_FRAME_BYTES: usize = super::MAX_FRAME_BYTES;
    pub const MAX_RESPONSE_BYTES: usize = super::MAX_RESPONSE_BYTES_V2;
    pub const MAX_NAME_BYTES: usize = super::MAX_NAME_BYTES_V2;
    pub const MAX_RECEIPT_BYTES: usize = super::MAX_EFFECT_RECEIPT_BYTES_V2;
    pub const MAX_COMPLETED_EFFECTS: usize = super::MAX_COMPLETED_EFFECTS_V2;
    pub const MAX_TOTAL_RECEIPT_BYTES: usize = super::MAX_TOTAL_EFFECT_RECEIPT_BYTES_V2;
    pub const MAX_ERROR_BYTES: usize = super::MAX_ERROR_BYTES_V2;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_validation_accepts_only_exact_cancelled_failure_proof() {
        let mut cancelled = Response::failure(
            Some("run-1".into()),
            "failed",
            "cancelled",
            "python run was cancelled",
        );
        cancelled.result = Some(serde_json::json!({
            "started": true,
            "context_invalidated": true,
        }));
        assert_eq!(cancelled.validate(), Ok(()));

        for result in [
            serde_json::json!({"started": true}),
            serde_json::json!({"started": true, "context_invalidated": false, "extra": true}),
            serde_json::json!({"started": "yes", "context_invalidated": false}),
            serde_json::json!([true, false]),
        ] {
            let mut malformed = cancelled.clone();
            malformed.result = Some(result);
            assert_eq!(malformed.validate(), Err(ProtocolError::InvalidResponse));
        }
        let mut missing = cancelled.clone();
        missing.result = None;
        assert_eq!(missing.validate(), Err(ProtocolError::InvalidResponse));
        let mut arbitrary_failure =
            Response::failure(Some("run-1".into()), "failed", "runtime", "failed");
        arbitrary_failure.result = Some(serde_json::json!({}));
        assert_eq!(
            arbitrary_failure.validate(),
            Err(ProtocolError::InvalidResponse)
        );
    }

    #[test]
    fn unknown_request_fields_are_rejected() {
        let raw = r#"{"op":"open","protocol":1,"request_id":"r1","context_id":"c1","generation":1,"extra":true}"#;
        assert!(serde_json::from_str::<Request>(raw).is_err());
    }

    #[test]
    fn request_validation_fences_ids_and_limits() {
        let request = Request::Run {
            protocol: PROTOCOL_VERSION,
            request_id: "req-1".into(),
            context_id: "ctx-1".into(),
            generation: 2,
            run_id: "run-1".into(),
            source: "40 + 2".into(),
            preview_max_bytes: DEFAULT_PREVIEW_BYTES,
        };
        assert_eq!(request.validate(), Ok(()));
    }

    #[test]
    fn cancel_is_exact_and_validates_every_binding() {
        let raw = r#"{"op":"cancel","protocol":1,"request_id":"cancel-1","context_id":"ctx-1","generation":2,"target_request_id":"request-1","run_id":"run-1"}"#;
        let request: Request = serde_json::from_str(raw).unwrap();
        assert_eq!(request.validate(), Ok(()));
        assert_eq!(serde_json::to_string(&request).unwrap(), raw);

        for malformed in [
            r#"{"op":"cancel","protocol":1,"request_id":"","context_id":"ctx-1","generation":2,"target_request_id":"request-1","run_id":"run-1"}"#,
            r#"{"op":"cancel","protocol":1,"request_id":"cancel-1","context_id":"bad/id","generation":2,"target_request_id":"request-1","run_id":"run-1"}"#,
            r#"{"op":"cancel","protocol":1,"request_id":"cancel-1","context_id":"ctx-1","generation":0,"target_request_id":"request-1","run_id":"run-1"}"#,
            r#"{"op":"cancel","protocol":1,"request_id":"cancel-1","context_id":"ctx-1","generation":2,"target_request_id":"bad target","run_id":"run-1"}"#,
            r#"{"op":"cancel","protocol":1,"request_id":"cancel-1","context_id":"ctx-1","generation":2,"target_request_id":"request-1","run_id":""}"#,
        ] {
            let request: Request = serde_json::from_str(malformed).unwrap();
            assert!(request.validate().is_err(), "accepted {malformed}");
        }

        for invalid_shape in [
            r#"{"op":"cancel","protocol":1,"request_id":"cancel-1","context_id":"ctx-1","generation":2,"run_id":"run-1"}"#,
            r#"{"op":"cancel","protocol":1,"request_id":"cancel-1","context_id":"ctx-1","generation":2,"target_request_id":"request-1","run_id":"run-1","extra":true}"#,
            r#"{"op":"detach","protocol":1,"request_id":"cancel-1","context_id":"ctx-1","generation":2,"target_request_id":"request-1","run_id":"run-1"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(invalid_shape).is_err());
        }
    }

    fn binding(call_index: u64) -> EffectBindingV2 {
        EffectBindingV2 {
            effect_id: format!("{call_index:064x}"),
            request_id: "request-1".into(),
            context_id: "context-1".into(),
            generation: 7,
            run_id: "run-1".into(),
            call_index,
            capability: "mail.send".into(),
            request_sha256: "11".repeat(32),
        }
    }

    fn receipt(call_index: u64, bytes: &[u8]) -> CompletedEffectReceiptV2 {
        CompletedEffectReceiptV2 {
            binding: binding(call_index),
            receipt: URL_SAFE_NO_PAD.encode(bytes),
            receipt_sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    fn success_v2(receipts: Vec<CompletedEffectReceiptV2>) -> ResponseV2 {
        ResponseV2 {
            protocol: PROTOCOL_V2_VERSION,
            request_id: Some("request-1".into()),
            ok: true,
            kind: "completed".into(),
            result: Some(serde_json::json!({})),
            failure_kind: None,
            error: None,
            completed_effects: receipts,
            ambiguity: None,
        }
    }

    #[test]
    fn protocol_1_dtos_have_frozen_golden_json() {
        let cases = [
            r#"{"op":"validate","protocol":1,"request_id":"r1","source":"1 + 1"}"#,
            r#"{"op":"open","protocol":1,"request_id":"r2","context_id":"c1","generation":1}"#,
            r#"{"op":"run","protocol":1,"request_id":"r3","context_id":"c1","generation":1,"run_id":"run1","source":"2 + 2","preview_max_bytes":16384}"#,
            r#"{"op":"cancel","protocol":1,"request_id":"r4","context_id":"c1","generation":1,"target_request_id":"r3","run_id":"run1"}"#,
            r#"{"op":"close","protocol":1,"request_id":"r5","context_id":"c1","generation":1}"#,
        ];
        for golden in cases {
            let explicit: RequestV1 = serde_json::from_str(golden).unwrap();
            let current: Request = explicit.clone();
            assert_eq!(explicit.validate(), Ok(()));
            assert_eq!(serde_json::to_string(&current).unwrap(), golden);
        }

        let success =
            ResponseV1::success("r3".into(), "completed", serde_json::json!({"value": 4}));
        assert_eq!(
            serde_json::to_string(&success).unwrap(),
            r#"{"protocol":1,"request_id":"r3","ok":true,"kind":"completed","result":{"value":4}}"#
        );
        let failure = ResponseV1::failure(Some("r3".into()), "failed", "runtime", "no");
        assert_eq!(
            serde_json::to_string(&failure).unwrap(),
            r#"{"protocol":1,"request_id":"r3","ok":false,"kind":"failed","failure_kind":"runtime","error":"no"}"#
        );
        let mut wrong_version: RequestV1 = serde_json::from_str(cases[1]).unwrap();
        if let RequestV1::Open { protocol, .. } = &mut wrong_version {
            *protocol = PROTOCOL_V2_VERSION;
        }
        assert_eq!(wrong_version.validate(), Err(ProtocolError::Version));
        assert!(
            serde_json::from_str::<ResponseV1>(
                r#"{"protocol":1,"request_id":"r3","ok":true,"kind":"completed","result":{},"extra":true}"#,
            )
            .is_err()
        );
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(v1::PROTOCOL_VERSION, 1);
        assert_eq!(v2::PROTOCOL_VERSION, 2);
    }

    #[test]
    fn protocol_2_receipt_and_ambiguity_have_golden_json() {
        let response = success_v2(vec![receipt(1, b"")]);
        let golden = concat!(
            r#"{"protocol":2,"request_id":"request-1","ok":true,"kind":"completed","result":{},"completed_effects":[{"binding":{"effect_id":"#,
            r#""0000000000000000000000000000000000000000000000000000000000000001","request_id":"request-1","context_id":"context-1","generation":7,"run_id":"run-1","call_index":1,"capability":"mail.send","request_sha256":"#,
            r#""1111111111111111111111111111111111111111111111111111111111111111"},"receipt":"","receipt_sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]}"#,
        );
        assert_eq!(response.to_json().unwrap(), golden.as_bytes());
        assert_eq!(ResponseV2::from_json(golden.as_bytes()).unwrap(), response);

        let mut ambiguous = ResponseV2 {
            protocol: 2,
            request_id: Some("request-1".into()),
            ok: false,
            kind: "failed".into(),
            result: None,
            failure_kind: Some("effect_ambiguous".into()),
            error: Some("outcome unknown".into()),
            completed_effects: vec![],
            ambiguity: Some(EffectAmbiguityV2 {
                binding: binding(1),
                reason: EffectAmbiguityReasonV2::PreparedAfterRestart,
                may_have_occurred: true,
                context_invalidated: true,
            }),
        };
        assert_eq!(ambiguous.validate(), Ok(()));
        ambiguous.ambiguity.as_mut().unwrap().may_have_occurred = false;
        assert!(ambiguous.validate().is_err());
    }

    #[test]
    fn protocol_2_rejects_malformed_receipts_hashes_and_extra_fields() {
        for spelling in ["AA==", "+w", "AB", "a b"] {
            let mut malformed = receipt(1, b"\0");
            malformed.receipt = spelling.into();
            assert_eq!(
                malformed.validate(),
                Err(ProtocolError::InvalidReceiptEncoding),
                "accepted {spelling}"
            );
        }
        let mut wrong_hash = receipt(1, b"receipt");
        wrong_hash.receipt_sha256 = "00".repeat(32);
        assert_eq!(
            wrong_hash.validate(),
            Err(ProtocolError::ReceiptHashMismatch)
        );
        wrong_hash.receipt_sha256 = "AA".repeat(32);
        assert!(wrong_hash.validate().is_err());

        let valid = String::from_utf8(success_v2(vec![]).to_json().unwrap()).unwrap();
        let with_extra = valid.replacen(
            "\"completed_effects\":[]",
            "\"completed_effects\":[],\"executor_id\":\"forbidden\"",
            1,
        );
        assert!(serde_json::from_str::<ResponseV2>(&with_extra).is_err());
        let nested_extra = serde_json::to_string(&receipt(1, b"x")).unwrap().replacen(
            "\"effect_id\":",
            "\"executor_id\":\"x\",\"effect_id\":",
            1,
        );
        assert!(serde_json::from_str::<CompletedEffectReceiptV2>(&nested_extra).is_err());
    }

    #[test]
    fn protocol_2_binding_names_hashes_and_reason_are_closed() {
        let mut edge = binding(0);
        edge.capability = "a".repeat(MAX_NAME_BYTES_V2);
        assert_eq!(edge.validate(), Ok(()));
        edge.capability.push('a');
        assert_eq!(edge.validate(), Err(ProtocolError::InvalidEffectBindingV2));
        edge.capability = "mail/send".into();
        assert!(edge.validate().is_err());

        let mut bad_hex = binding(0);
        bad_hex.effect_id = "AA".repeat(32);
        assert!(bad_hex.validate().is_err());
        bad_hex.effect_id = "0".repeat(63);
        assert!(bad_hex.validate().is_err());

        for (reason, spelling) in [
            (
                EffectAmbiguityReasonV2::PreparedAfterRestart,
                "prepared_after_restart",
            ),
            (
                EffectAmbiguityReasonV2::CompletionPersistenceFailed,
                "completion_persistence_failed",
            ),
            (
                EffectAmbiguityReasonV2::ReceiptIntegrityFailed,
                "receipt_integrity_failed",
            ),
            (EffectAmbiguityReasonV2::ExecutorLost, "executor_lost"),
        ] {
            let raw = serde_json::to_string(&EffectAmbiguityV2 {
                binding: binding(0),
                reason,
                may_have_occurred: true,
                context_invalidated: true,
            })
            .unwrap();
            assert!(raw.contains(spelling));
            assert_eq!(
                serde_json::from_str::<EffectAmbiguityV2>(&raw)
                    .unwrap()
                    .reason,
                reason
            );
        }
        let raw = serde_json::to_string(&EffectAmbiguityV2 {
            binding: binding(0),
            reason: EffectAmbiguityReasonV2::PreparedAfterRestart,
            may_have_occurred: true,
            context_invalidated: true,
        })
        .unwrap()
        .replace("prepared_after_restart", "arbitrary_reason");
        assert!(serde_json::from_str::<EffectAmbiguityV2>(&raw).is_err());
    }

    #[test]
    fn protocol_2_enforces_receipt_bounds_order_and_unique_keys() {
        let max = vec![7_u8; MAX_EFFECT_RECEIPT_BYTES_V2];
        assert_eq!(receipt(1, &max).validate(), Ok(()));
        assert_eq!(
            receipt(1, &vec![7_u8; MAX_EFFECT_RECEIPT_BYTES_V2 + 1]).validate(),
            Err(ProtocolError::ReceiptTooLarge)
        );

        let mut reversed = success_v2(vec![receipt(2, b"a"), receipt(1, b"b")]);
        assert_eq!(reversed.validate(), Err(ProtocolError::InvalidReceiptOrder));
        reversed.completed_effects = vec![receipt(1, b"a"), receipt(1, b"b")];
        reversed.completed_effects[1].binding.effect_id = "22".repeat(32);
        assert_eq!(reversed.validate(), Err(ProtocolError::InvalidReceiptOrder));

        let mut mixed_run = success_v2(vec![receipt(1, b"a"), receipt(2, b"b")]);
        mixed_run.completed_effects[1].binding.context_id = "context-2".into();
        assert_eq!(mixed_run.validate(), Err(ProtocolError::InvalidResponseV2));

        let sixty_four = (1..=MAX_COMPLETED_EFFECTS_V2 as u64)
            .map(|index| receipt(index, b""))
            .collect();
        assert_eq!(success_v2(sixty_four).validate(), Ok(()));
        let sixty_five = (1..=(MAX_COMPLETED_EFFECTS_V2 + 1) as u64)
            .map(|index| receipt(index, b""))
            .collect();
        assert!(success_v2(sixty_five).validate().is_err());

        let at_total = success_v2(vec![
            receipt(1, &vec![0; MAX_EFFECT_RECEIPT_BYTES_V2]),
            receipt(2, &vec![1; MAX_EFFECT_RECEIPT_BYTES_V2]),
        ]);
        assert_eq!(at_total.validate(), Ok(()));
        let over_total = success_v2(vec![
            receipt(1, &vec![0; MAX_EFFECT_RECEIPT_BYTES_V2]),
            receipt(2, &vec![1; MAX_EFFECT_RECEIPT_BYTES_V2]),
            receipt(3, &[2]),
        ]);
        assert_eq!(over_total.validate(), Err(ProtocolError::ReceiptsTooLarge));
    }

    #[test]
    fn protocol_2_response_matrix_error_and_frame_bounds_are_strict() {
        let mut response = success_v2(vec![]);
        response.ambiguity = Some(EffectAmbiguityV2 {
            binding: binding(1),
            reason: EffectAmbiguityReasonV2::CompletionPersistenceFailed,
            may_have_occurred: true,
            context_invalidated: true,
        });
        assert!(response.validate().is_err());

        response.ok = false;
        response.result = None;
        response.failure_kind = Some("runtime".into());
        response.error = Some("failed".into());
        assert!(response.validate().is_err());
        response.failure_kind = Some("effect_ambiguous".into());
        assert_eq!(response.validate(), Ok(()));
        response.ambiguity = None;
        assert!(response.validate().is_err());

        let mut cancelled = response;
        cancelled.failure_kind = Some("cancelled".into());
        cancelled.result = Some(serde_json::json!({
            "started": true,
            "context_invalidated": true,
        }));
        assert_eq!(cancelled.validate(), Ok(()));
        cancelled.result = Some(serde_json::json!({
            "started": false,
            "context_invalidated": true,
        }));
        assert_eq!(cancelled.validate(), Err(ProtocolError::InvalidResponseV2));
        cancelled.result = Some(serde_json::json!({
            "started": true,
            "context_invalidated": true,
        }));
        cancelled.error = Some("x".repeat(MAX_ERROR_BYTES_V2));
        assert_eq!(cancelled.validate(), Ok(()));
        cancelled.error.as_mut().unwrap().push('x');
        assert!(cancelled.validate().is_err());

        let mut huge = success_v2(vec![]);
        huge.result = Some(Value::String("x".repeat(MAX_RESPONSE_BYTES_V2)));
        assert_eq!(huge.validate(), Err(ProtocolError::FrameTooLarge));
        assert_eq!(
            ResponseV2::from_json(&vec![b' '; MAX_RESPONSE_BYTES_V2 + 1]),
            Err(ProtocolError::FrameTooLarge)
        );
    }
}
