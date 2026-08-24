//! Pure JSON envelopes and in-memory sequence fencing for executor transports.
//!
//! This crate deliberately contains no I/O, async runtime, TLS, retry, or persistence
//! implementation. A checkpoint is only a serializable representation; callers that
//! need crash-safe replay protection must durably journal it themselves.

use std::collections::BTreeSet;

pub use elpis_protocol::MAX_FRAME_BYTES;
use elpis_protocol::{PROTOCOL_VERSION, ProtocolError, Request, Response, validate_id};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_TRANSPORT_ID_BYTES: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientHello {
    Hello {
        #[serde(deserialize_with = "deserialize_protocol")]
        protocol: u32,
        #[serde(deserialize_with = "deserialize_executor_id")]
        executor_id: String,
        #[serde(deserialize_with = "deserialize_boot_epoch")]
        boot_epoch: String,
        last_committed_server_seq: u64,
    },
}

impl ClientHello {
    pub fn new(
        executor_id: impl Into<String>,
        boot_epoch: impl Into<String>,
        last_committed_server_seq: u64,
    ) -> Result<Self, ValidationError> {
        let hello = Self::Hello {
            protocol: PROTOCOL_VERSION,
            executor_id: executor_id.into(),
            boot_epoch: boot_epoch.into(),
            last_committed_server_seq,
        };
        hello.validate()?;
        Ok(hello)
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        let Self::Hello {
            protocol,
            executor_id,
            boot_epoch,
            ..
        } = self;
        validate_protocol(*protocol)?;
        validate_executor_id(executor_id)?;
        validate_boot_epoch(boot_epoch)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, DecodeError> {
        let value: Self = decode(bytes)?;
        value.validate()?;
        Ok(value)
    }

    pub fn to_json(&self) -> Result<Vec<u8>, EncodeError> {
        self.validate()?;
        encode(self)
    }

    pub fn executor_id(&self) -> &str {
        let Self::Hello { executor_id, .. } = self;
        executor_id
    }

    pub fn boot_epoch(&self) -> &str {
        let Self::Hello { boot_epoch, .. } = self;
        boot_epoch
    }

    pub fn last_committed_server_seq(&self) -> u64 {
        let Self::Hello {
            last_committed_server_seq,
            ..
        } = self;
        *last_committed_server_seq
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerWelcome {
    Welcome {
        #[serde(deserialize_with = "deserialize_protocol")]
        protocol: u32,
        #[serde(deserialize_with = "deserialize_executor_id")]
        executor_id: String,
        #[serde(deserialize_with = "deserialize_boot_epoch")]
        boot_epoch: String,
        #[serde(deserialize_with = "deserialize_connection_id")]
        connection_id: String,
        #[serde(deserialize_with = "deserialize_nonzero_seq")]
        next_server_seq: u64,
    },
}

impl ServerWelcome {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let Self::Welcome {
            protocol,
            executor_id,
            boot_epoch,
            connection_id,
            next_server_seq,
        } = self;
        validate_protocol(*protocol)?;
        validate_executor_id(executor_id)?;
        validate_boot_epoch(boot_epoch)?;
        validate_connection_id(connection_id)?;
        validate_nonzero_seq("next_server_seq", *next_server_seq)
    }

    /// Returns the opaque, hello-bound value required by [`ExecutorFence::new`].
    pub fn validate_for(self, hello: &ClientHello) -> Result<ValidatedWelcome, ValidationError> {
        hello.validate()?;
        self.validate()?;
        let Self::Welcome {
            protocol,
            executor_id,
            boot_epoch,
            connection_id,
            next_server_seq,
        } = self;
        if executor_id != hello.executor_id() {
            return Err(ValidationError::WelcomeExecutorMismatch);
        }
        if boot_epoch != hello.boot_epoch() {
            return Err(ValidationError::WelcomeBootEpochMismatch);
        }
        let expected = hello
            .last_committed_server_seq()
            .checked_add(1)
            .ok_or(ValidationError::SequenceExhausted)?;
        if next_server_seq != expected {
            return Err(ValidationError::WelcomeSequenceMismatch {
                expected,
                actual: next_server_seq,
            });
        }
        Ok(ValidatedWelcome {
            protocol,
            executor_id,
            boot_epoch,
            connection_id,
            next_server_seq,
        })
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, DecodeError> {
        let value: Self = decode(bytes)?;
        value.validate()?;
        Ok(value)
    }

    pub fn to_json(&self) -> Result<Vec<u8>, EncodeError> {
        self.validate()?;
        encode(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedWelcome {
    protocol: u32,
    executor_id: String,
    boot_epoch: String,
    connection_id: String,
    next_server_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerFrame {
    Request {
        #[serde(deserialize_with = "deserialize_protocol")]
        protocol: u32,
        #[serde(deserialize_with = "deserialize_executor_id")]
        executor_id: String,
        #[serde(deserialize_with = "deserialize_boot_epoch")]
        boot_epoch: String,
        #[serde(deserialize_with = "deserialize_connection_id")]
        connection_id: String,
        #[serde(deserialize_with = "deserialize_nonzero_seq")]
        seq: u64,
        request: Request,
    },
    Heartbeat {
        #[serde(deserialize_with = "deserialize_protocol")]
        protocol: u32,
        #[serde(deserialize_with = "deserialize_executor_id")]
        executor_id: String,
        #[serde(deserialize_with = "deserialize_boot_epoch")]
        boot_epoch: String,
        #[serde(deserialize_with = "deserialize_connection_id")]
        connection_id: String,
        #[serde(deserialize_with = "deserialize_nonzero_seq")]
        seq: u64,
    },
}

impl ServerFrame {
    pub fn from_json(bytes: &[u8]) -> Result<Self, DecodeError> {
        let value: Self = decode(bytes)?;
        value.validate_shape()?;
        Ok(value)
    }

    pub fn to_json(&self) -> Result<Vec<u8>, EncodeError> {
        self.validate_shape()?;
        encode(self)
    }

    fn binding(&self) -> FrameBinding<'_> {
        match self {
            Self::Request {
                protocol,
                executor_id,
                boot_epoch,
                connection_id,
                seq,
                ..
            }
            | Self::Heartbeat {
                protocol,
                executor_id,
                boot_epoch,
                connection_id,
                seq,
            } => FrameBinding {
                protocol: *protocol,
                executor_id,
                boot_epoch,
                connection_id,
                seq: *seq,
            },
        }
    }

    fn validate_shape(&self) -> Result<(), ValidationError> {
        self.binding().validate()?;
        if let Self::Request { request, .. } = self {
            request
                .validate()
                .map_err(ValidationError::InvalidRequest)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientFrame {
    Response {
        #[serde(deserialize_with = "deserialize_protocol")]
        protocol: u32,
        #[serde(deserialize_with = "deserialize_executor_id")]
        executor_id: String,
        #[serde(deserialize_with = "deserialize_boot_epoch")]
        boot_epoch: String,
        #[serde(deserialize_with = "deserialize_connection_id")]
        connection_id: String,
        #[serde(deserialize_with = "deserialize_nonzero_seq")]
        seq: u64,
        #[serde(deserialize_with = "deserialize_nonzero_seq")]
        request_seq: u64,
        response: Response,
    },
    Heartbeat {
        #[serde(deserialize_with = "deserialize_protocol")]
        protocol: u32,
        #[serde(deserialize_with = "deserialize_executor_id")]
        executor_id: String,
        #[serde(deserialize_with = "deserialize_boot_epoch")]
        boot_epoch: String,
        #[serde(deserialize_with = "deserialize_connection_id")]
        connection_id: String,
        #[serde(deserialize_with = "deserialize_nonzero_seq")]
        seq: u64,
        observed_server_seq: u64,
    },
}

impl ClientFrame {
    pub fn from_json(bytes: &[u8]) -> Result<Self, DecodeError> {
        let value: Self = decode(bytes)?;
        value.validate_shape()?;
        Ok(value)
    }

    pub fn to_json(&self) -> Result<Vec<u8>, EncodeError> {
        self.validate_shape()?;
        encode(self)
    }

    fn validate_shape(&self) -> Result<(), ValidationError> {
        match self {
            Self::Response {
                protocol,
                executor_id,
                boot_epoch,
                connection_id,
                seq,
                request_seq,
                response,
            } => {
                FrameBinding {
                    protocol: *protocol,
                    executor_id,
                    boot_epoch,
                    connection_id,
                    seq: *seq,
                }
                .validate()?;
                validate_nonzero_seq("request_seq", *request_seq)?;
                validate_response(response)
            }
            Self::Heartbeat {
                protocol,
                executor_id,
                boot_epoch,
                connection_id,
                seq,
                ..
            } => FrameBinding {
                protocol: *protocol,
                executor_id,
                boot_epoch,
                connection_id,
                seq: *seq,
            }
            .validate(),
        }
    }
}

struct FrameBinding<'a> {
    protocol: u32,
    executor_id: &'a str,
    boot_epoch: &'a str,
    connection_id: &'a str,
    seq: u64,
}

impl FrameBinding<'_> {
    fn validate(&self) -> Result<(), ValidationError> {
        validate_protocol(self.protocol)?;
        validate_executor_id(self.executor_id)?;
        validate_boot_epoch(self.boot_epoch)?;
        validate_connection_id(self.connection_id)?;
        validate_nonzero_seq("seq", self.seq)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DispatchedRequest {
    pub seq: u64,
    pub request: Request,
}

/// Serializable mechanics for a future durable journal. Serialization itself is not durable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FenceCheckpoint {
    pub executor_id: String,
    pub boot_epoch: String,
    pub connection_id: String,
    pub last_committed_server_seq: u64,
    pub next_client_seq: u64,
    pub request_seqs: Vec<u64>,
    pub responded_request_seqs: Vec<u64>,
}

impl FenceCheckpoint {
    pub fn validate(&self) -> Result<(), CheckpointError> {
        validate_executor_id(&self.executor_id)?;
        validate_boot_epoch(&self.boot_epoch)?;
        validate_connection_id(&self.connection_id)?;
        validate_nonzero_seq("next_client_seq", self.next_client_seq)?;
        self.last_committed_server_seq
            .checked_add(1)
            .ok_or(CheckpointError::SequenceExhausted)?;
        let mut requests = BTreeSet::new();
        let mut previous_request = None;
        for &seq in &self.request_seqs {
            if seq == 0 || seq > self.last_committed_server_seq {
                return Err(CheckpointError::InvalidRequestSequence(seq));
            }
            if !requests.insert(seq) {
                return Err(CheckpointError::DuplicateRequestSequence(seq));
            }
            if previous_request.is_some_and(|previous| seq < previous) {
                return Err(CheckpointError::UnorderedRequestSequences);
            }
            previous_request = Some(seq);
        }
        let mut responses = BTreeSet::new();
        let mut previous_response = None;
        for &seq in &self.responded_request_seqs {
            if seq == 0 || seq > self.last_committed_server_seq {
                return Err(CheckpointError::InvalidRespondedSequence(seq));
            }
            if !requests.contains(&seq) {
                return Err(CheckpointError::ResponseForNonRequest(seq));
            }
            if !responses.insert(seq) {
                return Err(CheckpointError::DuplicateRespondedSequence(seq));
            }
            if previous_response.is_some_and(|previous| seq < previous) {
                return Err(CheckpointError::UnorderedRespondedSequences);
            }
            previous_response = Some(seq);
        }
        let client_frames_used = self.next_client_seq - 1;
        if usize::try_from(client_frames_used).unwrap_or(usize::MAX) < responses.len() {
            return Err(CheckpointError::TooManyResponses);
        }
        Ok(())
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, DecodeError> {
        let value: Self = decode(bytes)?;
        value.validate()?;
        Ok(value)
    }

    pub fn to_json(&self) -> Result<Vec<u8>, EncodeError> {
        self.validate()?;
        encode(self)
    }
}

/// Memory-only fencing. It does not provide durable no-replay across a crash.
#[derive(Debug)]
pub struct ExecutorFence {
    executor_id: String,
    boot_epoch: String,
    connection_id: String,
    next_server_seq: u64,
    last_committed_server_seq: u64,
    next_client_seq: u64,
    request_seqs: BTreeSet<u64>,
    responded_request_seqs: BTreeSet<u64>,
}

impl ExecutorFence {
    pub fn new(welcome: ValidatedWelcome) -> Self {
        debug_assert_eq!(welcome.protocol, PROTOCOL_VERSION);
        Self {
            executor_id: welcome.executor_id,
            boot_epoch: welcome.boot_epoch,
            connection_id: welcome.connection_id,
            next_server_seq: welcome.next_server_seq,
            last_committed_server_seq: welcome.next_server_seq - 1,
            next_client_seq: 1,
            request_seqs: BTreeSet::new(),
            responded_request_seqs: BTreeSet::new(),
        }
    }

    /// Restores the supplied state exactly; impossible state is never silently reset.
    pub fn restore(checkpoint: FenceCheckpoint) -> Result<Self, CheckpointError> {
        checkpoint.validate()?;
        let next_server_seq = checkpoint
            .last_committed_server_seq
            .checked_add(1)
            .ok_or(CheckpointError::SequenceExhausted)?;
        Ok(Self {
            executor_id: checkpoint.executor_id,
            boot_epoch: checkpoint.boot_epoch,
            connection_id: checkpoint.connection_id,
            next_server_seq,
            last_committed_server_seq: checkpoint.last_committed_server_seq,
            next_client_seq: checkpoint.next_client_seq,
            request_seqs: checkpoint.request_seqs.into_iter().collect(),
            responded_request_seqs: checkpoint.responded_request_seqs.into_iter().collect(),
        })
    }

    /// Heartbeats return None and never dispatch. Requests are exposed only after commit.
    pub fn accept_server_frame(
        &mut self,
        frame: ServerFrame,
    ) -> Result<Option<DispatchedRequest>, FenceError> {
        let binding = frame.binding();
        self.validate_binding(&binding)?;
        binding.validate()?;
        if binding.seq < self.next_server_seq {
            return Err(FenceError::StaleSequence {
                expected: self.next_server_seq,
                actual: binding.seq,
            });
        }
        if binding.seq > self.next_server_seq {
            return Err(FenceError::SequenceGap {
                expected: self.next_server_seq,
                actual: binding.seq,
            });
        }
        let next = binding
            .seq
            .checked_add(1)
            .ok_or(FenceError::SequenceExhausted)?;
        if let ServerFrame::Request { request, .. } = &frame {
            request.validate()?;
        }
        let committed = binding.seq;
        self.next_server_seq = next;
        self.last_committed_server_seq = committed;
        match frame {
            ServerFrame::Request { request, .. } => {
                self.request_seqs.insert(committed);
                Ok(Some(DispatchedRequest {
                    seq: committed,
                    request,
                }))
            }
            ServerFrame::Heartbeat { .. } => Ok(None),
        }
    }

    pub fn build_response(
        &mut self,
        request_seq: u64,
        response: Response,
    ) -> Result<ClientFrame, FenceError> {
        validate_nonzero_seq("request_seq", request_seq)?;
        if request_seq > self.last_committed_server_seq {
            return Err(FenceError::UncommittedRequestSequence(request_seq));
        }
        if !self.request_seqs.contains(&request_seq) {
            return Err(FenceError::NotARequestSequence(request_seq));
        }
        if self.responded_request_seqs.contains(&request_seq) {
            return Err(FenceError::AlreadyResponded(request_seq));
        }
        validate_response(&response)?;
        let (seq, next) = self.reserve_client_sequence()?;
        let frame = ClientFrame::Response {
            protocol: PROTOCOL_VERSION,
            executor_id: self.executor_id.clone(),
            boot_epoch: self.boot_epoch.clone(),
            connection_id: self.connection_id.clone(),
            seq,
            request_seq,
            response,
        };
        self.next_client_seq = next;
        self.responded_request_seqs.insert(request_seq);
        Ok(frame)
    }

    pub fn build_heartbeat(&mut self) -> Result<ClientFrame, FenceError> {
        let (seq, next) = self.reserve_client_sequence()?;
        let frame = ClientFrame::Heartbeat {
            protocol: PROTOCOL_VERSION,
            executor_id: self.executor_id.clone(),
            boot_epoch: self.boot_epoch.clone(),
            connection_id: self.connection_id.clone(),
            seq,
            observed_server_seq: self.last_committed_server_seq,
        };
        self.next_client_seq = next;
        Ok(frame)
    }

    pub fn checkpoint(&self) -> FenceCheckpoint {
        FenceCheckpoint {
            executor_id: self.executor_id.clone(),
            boot_epoch: self.boot_epoch.clone(),
            connection_id: self.connection_id.clone(),
            last_committed_server_seq: self.last_committed_server_seq,
            next_client_seq: self.next_client_seq,
            request_seqs: self.request_seqs.iter().copied().collect(),
            responded_request_seqs: self.responded_request_seqs.iter().copied().collect(),
        }
    }

    pub fn next_server_seq(&self) -> u64 {
        self.next_server_seq
    }
    pub fn next_client_seq(&self) -> u64 {
        self.next_client_seq
    }
    pub fn last_committed_server_seq(&self) -> u64 {
        self.last_committed_server_seq
    }

    fn validate_binding(&self, binding: &FrameBinding<'_>) -> Result<(), FenceError> {
        if binding.protocol != PROTOCOL_VERSION {
            return Err(FenceError::WrongProtocol(binding.protocol));
        }
        if binding.executor_id != self.executor_id {
            return Err(FenceError::WrongExecutor);
        }
        if binding.boot_epoch != self.boot_epoch {
            return Err(FenceError::WrongBootEpoch);
        }
        if binding.connection_id != self.connection_id {
            return Err(FenceError::WrongConnection);
        }
        Ok(())
    }

    fn reserve_client_sequence(&self) -> Result<(u64, u64), FenceError> {
        let next = self
            .next_client_seq
            .checked_add(1)
            .ok_or(FenceError::SequenceExhausted)?;
        Ok((self.next_client_seq, next))
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("protocol must be {PROTOCOL_VERSION}, got {0}")]
    WrongProtocol(u32),
    #[error("invalid executor id: {0}")]
    InvalidExecutorId(ProtocolError),
    #[error("invalid connection id: {0}")]
    InvalidConnectionId(ProtocolError),
    #[error("boot_epoch must be exactly 32 lowercase hexadecimal characters")]
    InvalidBootEpoch,
    #[error("{0} must be greater than zero")]
    ZeroSequence(&'static str),
    #[error("sequence space is exhausted")]
    SequenceExhausted,
    #[error("welcome executor_id does not match hello")]
    WelcomeExecutorMismatch,
    #[error("welcome boot_epoch does not match hello")]
    WelcomeBootEpochMismatch,
    #[error("welcome next_server_seq mismatch: expected {expected}, got {actual}")]
    WelcomeSequenceMismatch { expected: u64, actual: u64 },
    #[error("invalid nested execution request: {0}")]
    InvalidRequest(ProtocolError),
    #[error("invalid response shape")]
    InvalidResponse,
}

#[derive(Debug, Error)]
pub enum DecodeError {
    #[error("frame exceeds {MAX_FRAME_BYTES} bytes")]
    FrameTooLarge,
    #[error("invalid JSON envelope: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error(transparent)]
    Checkpoint(#[from] CheckpointError),
}

#[derive(Debug, Error)]
pub enum EncodeError {
    #[error("frame exceeds {MAX_FRAME_BYTES} bytes")]
    FrameTooLarge,
    #[error("could not encode JSON envelope: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error(transparent)]
    Checkpoint(#[from] CheckpointError),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CheckpointError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error("checkpoint sequence space is exhausted")]
    SequenceExhausted,
    #[error("invalid request sequence {0}")]
    InvalidRequestSequence(u64),
    #[error("duplicate request sequence {0}")]
    DuplicateRequestSequence(u64),
    #[error("request sequences are not strictly increasing")]
    UnorderedRequestSequences,
    #[error("response references non-request sequence {0}")]
    ResponseForNonRequest(u64),
    #[error("invalid responded request sequence {0}")]
    InvalidRespondedSequence(u64),
    #[error("duplicate responded request sequence {0}")]
    DuplicateRespondedSequence(u64),
    #[error("responded request sequences are not strictly increasing")]
    UnorderedRespondedSequences,
    #[error("checkpoint has more responses than emitted client frames")]
    TooManyResponses,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FenceError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error("wrong protocol {0}")]
    WrongProtocol(u32),
    #[error("frame belongs to a different executor")]
    WrongExecutor,
    #[error("frame belongs to a different boot epoch")]
    WrongBootEpoch,
    #[error("frame belongs to a different connection")]
    WrongConnection,
    #[error("stale sequence {actual}; expected {expected}")]
    StaleSequence { expected: u64, actual: u64 },
    #[error("sequence gap at {actual}; expected {expected}")]
    SequenceGap { expected: u64, actual: u64 },
    #[error("sequence space is exhausted")]
    SequenceExhausted,
    #[error("execution request is invalid: {0}")]
    InvalidRequest(#[from] ProtocolError),
    #[error("request sequence {0} has not been committed")]
    UncommittedRequestSequence(u64),
    #[error("server sequence {0} did not carry a request")]
    NotARequestSequence(u64),
    #[error("request sequence {0} already received a response")]
    AlreadyResponded(u64),
}

fn validate_protocol(protocol: u32) -> Result<(), ValidationError> {
    if protocol != PROTOCOL_VERSION {
        return Err(ValidationError::WrongProtocol(protocol));
    }
    Ok(())
}

fn validate_executor_id(value: &str) -> Result<(), ValidationError> {
    validate_id("executor_id", value, MAX_TRANSPORT_ID_BYTES)
        .map_err(ValidationError::InvalidExecutorId)
}

fn validate_connection_id(value: &str) -> Result<(), ValidationError> {
    validate_id("connection_id", value, MAX_TRANSPORT_ID_BYTES)
        .map_err(ValidationError::InvalidConnectionId)
}

fn validate_boot_epoch(value: &str) -> Result<(), ValidationError> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ValidationError::InvalidBootEpoch);
    }
    Ok(())
}

fn validate_nonzero_seq(label: &'static str, seq: u64) -> Result<(), ValidationError> {
    if seq == 0 {
        return Err(ValidationError::ZeroSequence(label));
    }
    Ok(())
}

fn validate_response(response: &Response) -> Result<(), ValidationError> {
    let request_id_valid = response
        .request_id
        .as_deref()
        .is_none_or(|id| validate_id("request_id", id, 120).is_ok());
    let kind_valid = validate_id("response kind", &response.kind, 120).is_ok();
    let shape_valid = if response.ok {
        response.request_id.is_some()
            && response.result.is_some()
            && response.failure_kind.is_none()
            && response.error.is_none()
    } else {
        response.result.is_none()
            && response
                .failure_kind
                .as_deref()
                .is_some_and(|kind| validate_id("failure kind", kind, 120).is_ok())
            && response
                .error
                .as_deref()
                .is_some_and(|error| !error.is_empty())
    };
    if response.protocol != PROTOCOL_VERSION || !request_id_valid || !kind_valid || !shape_valid {
        return Err(ValidationError::InvalidResponse);
    }
    Ok(())
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, DecodeError> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(DecodeError::FrameTooLarge);
    }
    Ok(serde_json::from_slice(bytes)?)
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, EncodeError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(EncodeError::FrameTooLarge);
    }
    Ok(bytes)
}

fn deserialize_protocol<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    validate_protocol(value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn deserialize_executor_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    validate_executor_id(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn deserialize_connection_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    validate_connection_id(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn deserialize_boot_epoch<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    validate_boot_epoch(&value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

fn deserialize_nonzero_seq<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    validate_nonzero_seq("sequence", value).map_err(serde::de::Error::custom)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EPOCH: &str = "00112233445566778899aabbccddeeff";

    fn hello(last: u64) -> ClientHello {
        ClientHello::new("executor-1", EPOCH, last).unwrap()
    }

    fn fence_after(last: u64) -> ExecutorFence {
        let welcome = ServerWelcome::Welcome {
            protocol: PROTOCOL_VERSION,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            next_server_seq: last + 1,
        };
        ExecutorFence::new(welcome.validate_for(&hello(last)).unwrap())
    }

    fn request_frame(seq: u64) -> ServerFrame {
        ServerFrame::Request {
            protocol: PROTOCOL_VERSION,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            seq,
            request: Request::Validate {
                protocol: PROTOCOL_VERSION,
                request_id: format!("request-{seq}"),
                source: "40 + 2".into(),
            },
        }
    }

    fn heartbeat_frame(seq: u64) -> ServerFrame {
        ServerFrame::Heartbeat {
            protocol: PROTOCOL_VERSION,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            seq,
        }
    }

    fn response(id: &str) -> Response {
        Response::success(id.into(), "validate", json!({"valid": true}))
    }

    #[test]
    fn unknown_fields_are_rejected_in_every_envelope_family() {
        let hello = br#"{"kind":"hello","protocol":1,"executor_id":"e","boot_epoch":"00112233445566778899aabbccddeeff","last_committed_server_seq":0,"extra":true}"#;
        assert!(serde_json::from_slice::<ClientHello>(hello).is_err());

        let welcome = br#"{"kind":"welcome","protocol":1,"executor_id":"e","boot_epoch":"00112233445566778899aabbccddeeff","connection_id":"c","next_server_seq":1,"extra":true}"#;
        assert!(serde_json::from_slice::<ServerWelcome>(welcome).is_err());

        let server = br#"{"kind":"heartbeat","protocol":1,"executor_id":"e","boot_epoch":"00112233445566778899aabbccddeeff","connection_id":"c","seq":1,"extra":true}"#;
        assert!(serde_json::from_slice::<ServerFrame>(server).is_err());

        let client = br#"{"kind":"heartbeat","protocol":1,"executor_id":"e","boot_epoch":"00112233445566778899aabbccddeeff","connection_id":"c","seq":1,"observed_server_seq":0,"extra":true}"#;
        assert!(serde_json::from_slice::<ClientFrame>(client).is_err());
    }

    #[test]
    fn server_request_frames_roundtrip_and_validate_nested_requests() {
        let frame = request_frame(1);
        let json = frame.to_json().unwrap();
        assert_eq!(ServerFrame::from_json(&json).unwrap(), frame);
        let invalid = br#"{"kind":"request","protocol":1,"executor_id":"executor-1","boot_epoch":"00112233445566778899aabbccddeeff","connection_id":"connection-1","seq":1,"request":{"op":"open","protocol":1,"request_id":"r1","context_id":"c1","generation":0}}"#;
        assert!(matches!(
            ServerFrame::from_json(invalid),
            Err(DecodeError::Validation(ValidationError::InvalidRequest(
                ProtocolError::InvalidGeneration
            )))
        ));
    }

    #[test]
    fn malformed_response_shapes_are_rejected_during_decode() {
        for invalid in [
            br#"{"kind":"response","protocol":1,"executor_id":"executor-1","boot_epoch":"00112233445566778899aabbccddeeff","connection_id":"connection-1","seq":1,"request_seq":1,"response":{"protocol":1,"request_id":"r1","ok":true,"kind":"completed"}}"#.as_slice(),
            br#"{"kind":"response","protocol":1,"executor_id":"executor-1","boot_epoch":"00112233445566778899aabbccddeeff","connection_id":"connection-1","seq":1,"request_seq":1,"response":{"protocol":1,"request_id":"r1","ok":false,"kind":"failed","result":{},"failure_kind":"runtime","error":"no"}}"#.as_slice(),
        ] {
            assert!(matches!(
                ClientFrame::from_json(invalid),
                Err(DecodeError::Validation(ValidationError::InvalidResponse))
            ));
        }
    }

    #[test]
    fn malformed_ids_epochs_protocol_and_zero_sequences_are_rejected() {
        assert!(ClientHello::new("not valid", EPOCH, 0).is_err());
        assert!(ClientHello::new("e", "00112233445566778899AABBCCDDEEFF", 0).is_err());
        assert!(ClientHello::new("x".repeat(121), EPOCH, 0).is_err());

        let bad_protocol = br#"{"kind":"hello","protocol":2,"executor_id":"e","boot_epoch":"00112233445566778899aabbccddeeff","last_committed_server_seq":0}"#;
        assert!(serde_json::from_slice::<ClientHello>(bad_protocol).is_err());
        let zero = br#"{"kind":"heartbeat","protocol":1,"executor_id":"e","boot_epoch":"00112233445566778899aabbccddeeff","connection_id":"c","seq":0}"#;
        assert!(serde_json::from_slice::<ServerFrame>(zero).is_err());
    }

    #[test]
    fn welcome_must_match_hello_exactly() {
        let base = ServerWelcome::Welcome {
            protocol: 1,
            executor_id: "other".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "c".into(),
            next_server_seq: 1,
        };
        assert!(matches!(
            base.validate_for(&hello(0)),
            Err(ValidationError::WelcomeExecutorMismatch)
        ));

        let wrong_seq = ServerWelcome::Welcome {
            protocol: 1,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "c".into(),
            next_server_seq: 2,
        };
        assert!(matches!(
            wrong_seq.validate_for(&hello(0)),
            Err(ValidationError::WelcomeSequenceMismatch { .. })
        ));
    }

    #[test]
    fn exact_request_is_accepted_and_heartbeat_only_advances() {
        let mut fence = fence_after(0);
        let dispatch = fence
            .accept_server_frame(request_frame(1))
            .unwrap()
            .unwrap();
        assert_eq!(dispatch.seq, 1);
        assert_eq!(dispatch.request.request_id(), "request-1");
        assert_eq!(fence.next_server_seq(), 2);

        assert!(
            fence
                .accept_server_frame(heartbeat_frame(2))
                .unwrap()
                .is_none()
        );
        assert_eq!(fence.last_committed_server_seq(), 2);
        assert_eq!(fence.next_server_seq(), 3);
        assert!(matches!(
            fence.build_response(2, response("request-2")),
            Err(FenceError::NotARequestSequence(2))
        ));
        assert_eq!(fence.next_client_seq(), 1);
    }

    #[test]
    fn rejected_server_frames_never_advance_state() {
        let mut fence = fence_after(0);
        assert!(matches!(
            fence.accept_server_frame(request_frame(2)),
            Err(FenceError::SequenceGap { .. })
        ));
        assert_eq!(fence.next_server_seq(), 1);

        let mut wrong = request_frame(1);
        let ServerFrame::Request { connection_id, .. } = &mut wrong else {
            unreachable!()
        };
        *connection_id = "other".into();
        assert!(matches!(
            fence.accept_server_frame(wrong),
            Err(FenceError::WrongConnection)
        ));
        assert_eq!(fence.next_server_seq(), 1);

        let mut wrong = request_frame(1);
        let ServerFrame::Request { protocol, .. } = &mut wrong else {
            unreachable!()
        };
        *protocol = 2;
        assert!(matches!(
            fence.accept_server_frame(wrong),
            Err(FenceError::WrongProtocol(2))
        ));
        let mut wrong = request_frame(1);
        let ServerFrame::Request { executor_id, .. } = &mut wrong else {
            unreachable!()
        };
        *executor_id = "other".into();
        assert!(matches!(
            fence.accept_server_frame(wrong),
            Err(FenceError::WrongExecutor)
        ));
        let mut wrong = request_frame(1);
        let ServerFrame::Request { boot_epoch, .. } = &mut wrong else {
            unreachable!()
        };
        *boot_epoch = "ffeeddccbbaa99887766554433221100".into();
        assert!(matches!(
            fence.accept_server_frame(wrong),
            Err(FenceError::WrongBootEpoch)
        ));
        assert_eq!(fence.next_server_seq(), 1);

        fence.accept_server_frame(request_frame(1)).unwrap();
        assert!(matches!(
            fence.accept_server_frame(request_frame(1)),
            Err(FenceError::StaleSequence { .. })
        ));
        assert_eq!(fence.next_server_seq(), 2);
    }

    #[test]
    fn response_is_once_per_request_and_client_sequence_is_shared() {
        let mut fence = fence_after(0);
        fence.accept_server_frame(request_frame(1)).unwrap();
        let first = fence.build_response(1, response("request-1")).unwrap();
        assert!(matches!(
            first,
            ClientFrame::Response {
                seq: 1,
                request_seq: 1,
                ..
            }
        ));
        assert!(matches!(
            fence.build_response(1, response("request-1")),
            Err(FenceError::AlreadyResponded(1))
        ));
        assert_eq!(fence.next_client_seq(), 2);

        let heartbeat = fence.build_heartbeat().unwrap();
        assert!(matches!(
            heartbeat,
            ClientFrame::Heartbeat {
                seq: 2,
                observed_server_seq: 1,
                ..
            }
        ));
        assert_eq!(fence.next_client_seq(), 3);
    }

    #[test]
    fn checkpoint_json_and_restore_roundtrip_exactly() {
        let mut fence = fence_after(0);
        fence.accept_server_frame(request_frame(1)).unwrap();
        fence.build_response(1, response("request-1")).unwrap();
        fence.build_heartbeat().unwrap();
        let checkpoint = fence.checkpoint();
        let json = checkpoint.to_json().unwrap();
        let decoded = FenceCheckpoint::from_json(&json).unwrap();
        assert_eq!(decoded, checkpoint);
        let restored = ExecutorFence::restore(decoded).unwrap();
        assert_eq!(restored.checkpoint(), checkpoint);
        assert_eq!(restored.checkpoint().request_seqs, vec![1]);
        assert_eq!(restored.checkpoint().responded_request_seqs, vec![1]);

        let mut pending = fence_after(0);
        pending.accept_server_frame(request_frame(1)).unwrap();
        let mut restored_pending = ExecutorFence::restore(pending.checkpoint()).unwrap();
        assert!(matches!(
            restored_pending
                .build_response(1, response("request-1"))
                .unwrap(),
            ClientFrame::Response {
                request_seq: 1,
                seq: 1,
                ..
            }
        ));
    }

    #[test]
    fn impossible_checkpoints_are_rejected_without_reset() {
        let invalid = FenceCheckpoint {
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            last_committed_server_seq: 1,
            next_client_seq: 1,
            request_seqs: vec![1],
            responded_request_seqs: vec![1],
        };
        assert!(matches!(
            ExecutorFence::restore(invalid),
            Err(CheckpointError::TooManyResponses)
        ));

        let duplicate = FenceCheckpoint {
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            last_committed_server_seq: 2,
            next_client_seq: 3,
            request_seqs: vec![1],
            responded_request_seqs: vec![1, 1],
        };
        assert!(matches!(
            ExecutorFence::restore(duplicate),
            Err(CheckpointError::DuplicateRespondedSequence(1))
        ));

        let duplicate_request = FenceCheckpoint {
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            last_committed_server_seq: 2,
            next_client_seq: 1,
            request_seqs: vec![1, 1],
            responded_request_seqs: vec![],
        };
        assert!(matches!(
            ExecutorFence::restore(duplicate_request),
            Err(CheckpointError::DuplicateRequestSequence(1))
        ));

        let response_for_heartbeat = FenceCheckpoint {
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            last_committed_server_seq: 2,
            next_client_seq: 2,
            request_seqs: vec![1],
            responded_request_seqs: vec![2],
        };
        assert!(matches!(
            ExecutorFence::restore(response_for_heartbeat),
            Err(CheckpointError::ResponseForNonRequest(2))
        ));

        let unordered_requests = FenceCheckpoint {
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            last_committed_server_seq: 2,
            next_client_seq: 1,
            request_seqs: vec![2, 1],
            responded_request_seqs: vec![],
        };
        assert!(matches!(
            ExecutorFence::restore(unordered_requests),
            Err(CheckpointError::UnorderedRequestSequences)
        ));

        let unordered_responses = FenceCheckpoint {
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            last_committed_server_seq: 2,
            next_client_seq: 3,
            request_seqs: vec![1, 2],
            responded_request_seqs: vec![2, 1],
        };
        assert!(matches!(
            ExecutorFence::restore(unordered_responses),
            Err(CheckpointError::UnorderedRespondedSequences)
        ));
    }

    #[test]
    fn sequence_exhaustion_fails_closed() {
        let welcome = ServerWelcome::Welcome {
            protocol: 1,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            next_server_seq: u64::MAX,
        };
        let mut server_fence =
            ExecutorFence::new(welcome.validate_for(&hello(u64::MAX - 1)).unwrap());
        assert!(matches!(
            server_fence.accept_server_frame(heartbeat_frame(u64::MAX)),
            Err(FenceError::SequenceExhausted)
        ));
        assert_eq!(server_fence.next_server_seq(), u64::MAX);

        let cp = FenceCheckpoint {
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            last_committed_server_seq: 0,
            next_client_seq: u64::MAX,
            request_seqs: vec![],
            responded_request_seqs: vec![],
        };
        let mut client_fence = ExecutorFence::restore(cp).unwrap();
        assert!(matches!(
            client_fence.build_heartbeat(),
            Err(FenceError::SequenceExhausted)
        ));
        assert_eq!(client_fence.next_client_seq(), u64::MAX);
        assert!(matches!(
            ServerWelcome::Welcome {
                protocol: 1,
                executor_id: "executor-1".into(),
                boot_epoch: EPOCH.into(),
                connection_id: "c".into(),
                next_server_seq: u64::MAX,
            }
            .validate_for(&hello(u64::MAX)),
            Err(ValidationError::SequenceExhausted)
        ));
    }

    #[test]
    fn frame_size_limit_is_applied_before_json_parsing() {
        let oversized = vec![b' '; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            ClientHello::from_json(&oversized),
            Err(DecodeError::FrameTooLarge)
        ));
    }
}
