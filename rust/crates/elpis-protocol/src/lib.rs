use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const PROTOCOL_VERSION: u32 = 1;
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
pub enum Request {
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

impl Request {
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
        if protocol != PROTOCOL_VERSION {
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
pub struct Response {
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

impl Response {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol != PROTOCOL_VERSION
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
            protocol: PROTOCOL_VERSION,
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
            protocol: PROTOCOL_VERSION,
            request_id,
            ok: false,
            kind: kind.into(),
            result: None,
            failure_kind: Some(failure_kind.into()),
            error: Some(error.into()),
        }
    }
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
}
