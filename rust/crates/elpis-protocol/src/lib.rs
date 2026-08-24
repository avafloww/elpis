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
            | Self::Close { request_id, .. } => request_id,
        }
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        let protocol = match self {
            Self::Validate { protocol, .. }
            | Self::Open { protocol, .. }
            | Self::Run { protocol, .. }
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
}
