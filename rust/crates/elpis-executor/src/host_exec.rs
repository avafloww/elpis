//! Fixed policy and pure codec for the executor-owned `elpis.host.exec`
//! capability.
//!
//! Nothing in this module starts a process. It only decides whether the one
//! known capability is locally enabled, validates its bounded arguments, and
//! produces/consumes stable bytes for effect identity and receipts.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use elpis_python::HostCall;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const HOST_EXEC_CAPABILITY: &str = "elpis.host.exec";
pub const CAPABILITY_PROFILE_ENV: &str = "ELPIS_EXECUTOR_CAPABILITY_PROFILE";
pub const OWNED_PERMISSIVE_PROFILE: &str = "owned_permissive";
pub const DISABLED_PROFILE: &str = "disabled";

pub const MAX_HOST_EXEC_ARGV_ITEMS: usize = 64;
pub const MAX_HOST_EXEC_ARG_BYTES: usize = 4_096;
pub const MAX_HOST_EXEC_ARGV_BYTES: usize = 65_536;
pub const MAX_HOST_EXEC_STDIN_BYTES: usize = 65_536;
pub const MAX_HOST_EXEC_STREAM_BYTES: usize = 65_536;
pub const MAX_HOST_EXEC_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_HOST_EXEC_RECEIPT_BYTES: usize = 256 * 1024;
pub const MAX_HOST_EXEC_EXIT_CODE: i32 = 255;
pub const MAX_HOST_EXEC_SIGNAL: i32 = 127;

/// The complete executor-owned capability policy.
///
/// The default is fail-closed. There is intentionally no constructor from a
/// protocol request: the only parser accepts a value already read from local
/// executor configuration.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityProfile {
    #[default]
    Disabled,
    OwnedPermissive,
}

impl CapabilityProfile {
    /// Parse the exact local configuration value. An absent value selects the
    /// disabled default; aliases, case folding, and surrounding whitespace are
    /// deliberately not accepted.
    pub fn from_local_config(value: Option<&str>) -> Result<Self, HostExecError> {
        match value {
            None | Some(DISABLED_PROFILE) => Ok(Self::Disabled),
            Some(OWNED_PERMISSIVE_PROFILE) => Ok(Self::OwnedPermissive),
            Some(_) => Err(HostExecError::InvalidProfile),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => DISABLED_PROFILE,
            Self::OwnedPermissive => OWNED_PERMISSIVE_PROFILE,
        }
    }

    /// Authorize exactly the owned host execution capability.
    pub fn authorize(self, capability: &str) -> Result<(), HostExecError> {
        if capability != HOST_EXEC_CAPABILITY {
            return Err(HostExecError::UnknownCapability);
        }
        if self != Self::OwnedPermissive {
            return Err(HostExecError::CapabilityDisabled);
        }
        Ok(())
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum HostExecError {
    #[error("invalid executor capability profile")]
    InvalidProfile,
    #[error("unknown host capability")]
    UnknownCapability,
    #[error("host execution capability is disabled")]
    CapabilityDisabled,
    #[error("malformed host execution request")]
    MalformedRequest,
    #[error("host execution argv must not be empty")]
    EmptyArgv,
    #[error("host execution program must not be empty")]
    EmptyProgram,
    #[error("host execution argv has too many items")]
    TooManyArguments,
    #[error("host execution argv item is too large")]
    ArgumentTooLarge,
    #[error("host execution argv contains NUL")]
    ArgumentContainsNul,
    #[error("host execution argv is too large")]
    ArgumentsTooLarge,
    #[error("host execution stdin is too large")]
    StdinTooLarge,
    #[error("host execution request encoding is too large")]
    RequestTooLarge,
    #[error("malformed host execution receipt")]
    MalformedReceipt,
    #[error("host execution termination is invalid")]
    InvalidTermination,
    #[error("host execution stdout is too large")]
    StdoutTooLarge,
    #[error("host execution stderr is too large")]
    StderrTooLarge,
    #[error("host execution receipt encoding is too large")]
    ReceiptTooLarge,
    #[error("host execution receipt is not canonical")]
    NonCanonicalReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostExecRequest {
    argv: Vec<String>,
    stdin: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestWire {
    argv: Vec<String>,
    #[serde(default)]
    stdin: String,
}

impl HostExecRequest {
    pub fn new(argv: Vec<String>, stdin: String) -> Result<Self, HostExecError> {
        let request = Self { argv, stdin };
        request.validate()?;
        request.encode()?;
        Ok(request)
    }

    /// Validate and canonicalize one already-strict Python host-call DTO.
    pub fn from_host_call(
        profile: CapabilityProfile,
        call: &HostCall,
    ) -> Result<Self, HostExecError> {
        profile.authorize(&call.capability)?;
        Self::new(call.argv.clone(), call.stdin.clone())
    }

    /// Decode a bounded JSON capability body, rejecting unknown or duplicate
    /// fields, and normalize an omitted stdin to the empty string.
    pub fn decode(
        profile: CapabilityProfile,
        capability: &str,
        bytes: &[u8],
    ) -> Result<Self, HostExecError> {
        profile.authorize(capability)?;
        if bytes.len() > MAX_HOST_EXEC_REQUEST_BYTES {
            return Err(HostExecError::RequestTooLarge);
        }
        let wire: RequestWire =
            serde_json::from_slice(bytes).map_err(|_| HostExecError::MalformedRequest)?;
        Self::new(wire.argv, wire.stdin)
    }

    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    pub fn stdin(&self) -> &str {
        &self.stdin
    }

    pub fn stdin_bytes(&self) -> &[u8] {
        self.stdin.as_bytes()
    }

    /// Stable compact JSON with fixed field order. The optional wire stdin is
    /// always emitted, making omitted and explicitly empty input identical for
    /// effect identity.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        self.encode()
            .expect("validated host execution request has bounded encoding")
    }

    fn validate(&self) -> Result<(), HostExecError> {
        if self.argv.is_empty() {
            return Err(HostExecError::EmptyArgv);
        }
        if self.argv[0].is_empty() {
            return Err(HostExecError::EmptyProgram);
        }
        if self.argv.len() > MAX_HOST_EXEC_ARGV_ITEMS {
            return Err(HostExecError::TooManyArguments);
        }
        let mut total = 0usize;
        for argument in &self.argv {
            if argument.len() > MAX_HOST_EXEC_ARG_BYTES {
                return Err(HostExecError::ArgumentTooLarge);
            }
            if argument.as_bytes().contains(&0) {
                return Err(HostExecError::ArgumentContainsNul);
            }
            total = total
                .checked_add(argument.len())
                .ok_or(HostExecError::ArgumentsTooLarge)?;
        }
        if total > MAX_HOST_EXEC_ARGV_BYTES {
            return Err(HostExecError::ArgumentsTooLarge);
        }
        if self.stdin.len() > MAX_HOST_EXEC_STDIN_BYTES {
            return Err(HostExecError::StdinTooLarge);
        }
        Ok(())
    }

    fn encode(&self) -> Result<Vec<u8>, HostExecError> {
        let bytes = serde_json::to_vec(&RequestWire {
            argv: self.argv.clone(),
            stdin: self.stdin.clone(),
        })
        .map_err(|_| HostExecError::MalformedRequest)?;
        if bytes.len() > MAX_HOST_EXEC_REQUEST_BYTES {
            return Err(HostExecError::RequestTooLarge);
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostExecTermination {
    Exited(i32),
    Signaled(i32),
}

impl HostExecTermination {
    fn validate(self) -> Result<(), HostExecError> {
        match self {
            Self::Exited(code) if (0..=MAX_HOST_EXEC_EXIT_CODE).contains(&code) => Ok(()),
            Self::Signaled(signal) if (1..=MAX_HOST_EXEC_SIGNAL).contains(&signal) => Ok(()),
            _ => Err(HostExecError::InvalidTermination),
        }
    }
}

/// Decoded, bounded result represented by a canonical receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostExecResult {
    termination: HostExecTermination,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Canonical receipt content and its decoded execution result are identical.
pub type HostExecReceipt = HostExecResult;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TerminationKind {
    Exited,
    Signaled,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminationWire {
    kind: TerminationKind,
    value: i32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReceiptWire {
    termination: TerminationWire,
    stdout: String,
    stderr: String,
}

impl HostExecResult {
    pub fn new(
        termination: HostExecTermination,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    ) -> Result<Self, HostExecError> {
        let result = Self {
            termination,
            stdout,
            stderr,
        };
        result.validate()?;
        result.encode()?;
        Ok(result)
    }

    pub fn termination(&self) -> HostExecTermination {
        self.termination
    }

    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    pub fn stderr(&self) -> &[u8] {
        &self.stderr
    }

    /// Stable compact JSON. Stream bytes use canonical unpadded base64url, so
    /// arbitrary process output remains independent of UTF-8 and JSON escaping.
    pub fn canonical_receipt_bytes(&self) -> Vec<u8> {
        self.encode()
            .expect("validated host execution result has bounded encoding")
    }

    /// Decode only bytes in the canonical Rust encoding. Durable receipts
    /// therefore have one spelling, not merely one JSON meaning.
    pub fn decode_canonical_receipt(bytes: &[u8]) -> Result<Self, HostExecError> {
        if bytes.len() > MAX_HOST_EXEC_RECEIPT_BYTES {
            return Err(HostExecError::ReceiptTooLarge);
        }
        let wire: ReceiptWire =
            serde_json::from_slice(bytes).map_err(|_| HostExecError::MalformedReceipt)?;
        let termination = match wire.termination.kind {
            TerminationKind::Exited => HostExecTermination::Exited(wire.termination.value),
            TerminationKind::Signaled => HostExecTermination::Signaled(wire.termination.value),
        };
        let stdout = decode_canonical_base64(&wire.stdout)?;
        let stderr = decode_canonical_base64(&wire.stderr)?;
        let result = Self::new(termination, stdout, stderr)?;
        if result.canonical_receipt_bytes() != bytes {
            return Err(HostExecError::NonCanonicalReceipt);
        }
        Ok(result)
    }

    fn validate(&self) -> Result<(), HostExecError> {
        self.termination.validate()?;
        if self.stdout.len() > MAX_HOST_EXEC_STREAM_BYTES {
            return Err(HostExecError::StdoutTooLarge);
        }
        if self.stderr.len() > MAX_HOST_EXEC_STREAM_BYTES {
            return Err(HostExecError::StderrTooLarge);
        }
        Ok(())
    }

    fn encode(&self) -> Result<Vec<u8>, HostExecError> {
        let (kind, value) = match self.termination {
            HostExecTermination::Exited(code) => (TerminationKind::Exited, code),
            HostExecTermination::Signaled(signal) => (TerminationKind::Signaled, signal),
        };
        let bytes = serde_json::to_vec(&ReceiptWire {
            termination: TerminationWire { kind, value },
            stdout: URL_SAFE_NO_PAD.encode(&self.stdout),
            stderr: URL_SAFE_NO_PAD.encode(&self.stderr),
        })
        .map_err(|_| HostExecError::MalformedReceipt)?;
        if bytes.len() > MAX_HOST_EXEC_RECEIPT_BYTES {
            return Err(HostExecError::ReceiptTooLarge);
        }
        Ok(bytes)
    }
}

fn decode_canonical_base64(value: &str) -> Result<Vec<u8>, HostExecError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| HostExecError::MalformedReceipt)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(HostExecError::MalformedReceipt);
    }
    Ok(decoded)
}
