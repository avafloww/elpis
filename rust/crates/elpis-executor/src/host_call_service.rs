//! Ledger-gated services for the executor-owned host capability.
//!
//! The injected runner keeps deterministic synchronous tests separate from the
//! inert owned service whose active handle owns real process custody.

use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use elpis_coordinator::{RunBinding, RunEffectClaim, RunEffectReporter};
use elpis_effects::{
    AmbiguityFallback, EffectError, EffectIdentity, EffectLedger, ExecutionToken, PrepareOutcome,
    StoredReceipt,
};
use elpis_protocol::v2::{
    CompletedEffectReceipt, EffectAmbiguity, EffectAmbiguityReason, EffectBinding,
};
use elpis_python::{
    ActiveHostCall, HostCall, HostCallService, HostCallStart, HostResult, PythonError,
};
use ring::digest::{SHA256, digest};

use crate::host_exec::{
    CapabilityProfile, HostExecRequest, HostExecResult, HostExecTermination,
    MAX_HOST_EXEC_RECEIPT_BYTES,
};
use crate::host_exec_process::{HostExecProcess, HostExecProcessOutcome, HostExecStartDisposition};

const REJECT_REQUEST: &str = "host execution request was rejected";
const REJECT_LEDGER: &str = "host execution ledger rejected the call";
const REJECT_AMBIGUOUS: &str = "host execution outcome is ambiguous";
const REJECT_REPORTER: &str = "host execution outcome capacity is unavailable";
const REJECT_START: &str = "host execution could not be started";
const REJECT_ASYNC: &str = "host execution requires asynchronous custody";
const REJECT_EXIT: &str = "host execution exited unsuccessfully";
const REJECT_SIGNAL: &str = "host execution was terminated by a signal";
const REJECT_UTF8: &str = "host execution stdout is not UTF-8";

#[derive(Debug)]
pub enum HostExecRunnerOutcome {
    Completed(ExecutionToken, HostExecResult),
    Ambiguous(ExecutionToken),
}

pub trait HostExecRunner: Send {
    fn run(&mut self, token: ExecutionToken, request: &HostExecRequest) -> HostExecRunnerOutcome;
}

impl<T: HostExecRunner + ?Sized> HostExecRunner for Box<T> {
    fn run(&mut self, token: ExecutionToken, request: &HostExecRequest) -> HostExecRunnerOutcome {
        (**self).run(token, request)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostExecLedgerError {
    Conflict,
    ReceiptIntegrity,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostExecCompletionFailure {
    MarkedAmbiguous,
    AlreadyAmbiguous,
    AlreadyCompleted,
    Unconfirmed,
}

pub trait HostExecLedger: Send {
    fn prepare(&mut self, identity: &EffectIdentity)
    -> Result<PrepareOutcome, HostExecLedgerError>;

    fn complete(
        &mut self,
        token: ExecutionToken,
        canonical_receipt_bytes: &[u8],
    ) -> Result<StoredReceipt, HostExecCompletionFailure>;

    fn mark_ambiguous(&mut self, token: ExecutionToken) -> Result<(), HostExecLedgerError>;
}

impl HostExecLedger for EffectLedger {
    fn prepare(
        &mut self,
        identity: &EffectIdentity,
    ) -> Result<PrepareOutcome, HostExecLedgerError> {
        EffectLedger::prepare(self, identity).map_err(classify_prepare_error)
    }

    fn complete(
        &mut self,
        token: ExecutionToken,
        canonical_receipt_bytes: &[u8],
    ) -> Result<StoredReceipt, HostExecCompletionFailure> {
        self.complete_or_mark_ambiguous(token, canonical_receipt_bytes)
            .map_err(|failure| match failure.ambiguity_fallback() {
                AmbiguityFallback::Marked => HostExecCompletionFailure::MarkedAmbiguous,
                AmbiguityFallback::AlreadyAmbiguous => HostExecCompletionFailure::AlreadyAmbiguous,
                AmbiguityFallback::AlreadyCompleted => HostExecCompletionFailure::AlreadyCompleted,
                AmbiguityFallback::Unconfirmed(_) => HostExecCompletionFailure::Unconfirmed,
            })
    }

    fn mark_ambiguous(&mut self, token: ExecutionToken) -> Result<(), HostExecLedgerError> {
        EffectLedger::mark_ambiguous(self, token).map_err(|_| HostExecLedgerError::Unavailable)
    }
}

#[derive(Clone)]
pub struct HostExecLedgerOwner {
    inner: Arc<Mutex<Box<dyn HostExecLedger>>>,
}

impl HostExecLedgerOwner {
    pub fn new(ledger: impl HostExecLedger + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Box::new(ledger))),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Box<dyn HostExecLedger>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct OwnedHostExecService {
    binding: RunBinding,
    effects: RunEffectReporter,
    profile: CapabilityProfile,
    ledger: HostExecLedgerOwner,
    ambiguity_reported: bool,
}

impl OwnedHostExecService {
    pub fn new(
        binding: &RunBinding,
        effects: RunEffectReporter,
        profile: CapabilityProfile,
        ledger: HostExecLedgerOwner,
    ) -> Self {
        Self {
            binding: binding.clone(),
            effects,
            profile,
            ledger,
            ambiguity_reported: false,
        }
    }

    fn start_owned(&mut self, call: &HostCall) -> HostCallStart {
        if self.ambiguity_reported {
            return HostCallStart::Complete(HostResult::rejected(REJECT_AMBIGUOUS));
        }
        let request = match HostExecRequest::from_host_call(self.profile, call) {
            Ok(request) => request,
            Err(_) => return HostCallStart::Complete(HostResult::rejected(REJECT_REQUEST)),
        };
        let identity = match EffectIdentity::new(
            self.binding.request_id(),
            self.binding.context_id(),
            self.binding.generation(),
            self.binding.run_id(),
            call.call_index,
            &call.capability,
            request.canonical_bytes(),
        ) {
            Ok(identity) => identity,
            Err(_) => return HostCallStart::Complete(HostResult::rejected(REJECT_REQUEST)),
        };
        let claim = match self
            .effects
            .reserve(protocol_binding(&identity), MAX_HOST_EXEC_RECEIPT_BYTES)
        {
            Ok(claim) => claim,
            Err(_) => return HostCallStart::Complete(HostResult::rejected(REJECT_REPORTER)),
        };
        let admission = self.ledger.lock().prepare(&identity);
        match admission {
            Err(HostExecLedgerError::ReceiptIntegrity) => {
                self.ambiguity_reported = true;
                HostCallStart::Complete(settle_ambiguity(
                    claim,
                    EffectAmbiguityReason::ReceiptIntegrityFailed,
                ))
            }
            Err(HostExecLedgerError::Conflict | HostExecLedgerError::Unavailable) => {
                HostCallStart::Complete(release_without_effect(claim, REJECT_LEDGER))
            }
            Ok(PrepareOutcome::Prepared | PrepareOutcome::Ambiguous) => {
                self.ambiguity_reported = true;
                HostCallStart::Complete(settle_ambiguity(
                    claim,
                    EffectAmbiguityReason::ExecutorLost,
                ))
            }
            Ok(PrepareOutcome::Completed(receipt)) => {
                HostCallStart::Complete(settle_completed(claim, receipt))
            }
            Ok(PrepareOutcome::New(token)) => match HostExecProcess::start(token, &request) {
                Ok(process) => HostCallStart::Active(Box::new(ActiveOwnedHostExecCall {
                    process: Some(process),
                    claim: Some(claim),
                    ledger: self.ledger.clone(),
                })),
                Err(failure) => {
                    let (token, _error, disposition) = failure.into_parts();
                    let marked = self.ledger.lock().mark_ambiguous(token).is_ok();
                    match disposition {
                        HostExecStartDisposition::NotStarted if marked => {
                            HostCallStart::Complete(release_without_effect(claim, REJECT_START))
                        }
                        HostExecStartDisposition::NotStarted
                        | HostExecStartDisposition::MayHaveExecuted => {
                            self.ambiguity_reported = true;
                            HostCallStart::Complete(settle_ambiguity(
                                claim,
                                EffectAmbiguityReason::ExecutorLost,
                            ))
                        }
                    }
                }
            },
        }
    }
}

impl HostCallService for OwnedHostExecService {
    fn call(&mut self, _call: &HostCall) -> HostResult {
        HostResult::rejected(REJECT_ASYNC)
    }

    fn start(&mut self, call: &HostCall) -> Result<HostCallStart, PythonError> {
        Ok(self.start_owned(call))
    }
}

struct ActiveOwnedHostExecCall {
    process: Option<HostExecProcess>,
    claim: Option<RunEffectClaim>,
    ledger: HostExecLedgerOwner,
}

impl ActiveOwnedHostExecCall {
    fn finish_process(&mut self, process: HostExecProcess) -> HostResult {
        let claim = self
            .claim
            .take()
            .expect("active host execution claim settles exactly once");
        match process.wait_reaped() {
            HostExecProcessOutcome::Completed { token, result } => {
                let bytes = result.canonical_receipt_bytes();
                match self.ledger.lock().complete(token, &bytes) {
                    Ok(receipt) => settle_completed(claim, receipt),
                    Err(_) => {
                        settle_ambiguity(claim, EffectAmbiguityReason::CompletionPersistenceFailed)
                    }
                }
            }
            HostExecProcessOutcome::Cancelled { token }
            | HostExecProcessOutcome::Ambiguous { token, .. } => {
                let _ = self.ledger.lock().mark_ambiguous(token);
                settle_ambiguity(claim, EffectAmbiguityReason::ExecutorLost)
            }
        }
    }

    fn finish_if_owned(&mut self) -> Option<HostResult> {
        self.process
            .take()
            .map(|process| self.finish_process(process))
    }
}

impl ActiveHostCall for ActiveOwnedHostExecCall {
    fn try_wait(&mut self) -> Result<Option<HostResult>, PythonError> {
        let Some(process) = self.process.as_mut() else {
            return Ok(None);
        };
        if !process
            .has_exited_unreaped()
            .map_err(process_custody_error)?
        {
            return Ok(None);
        }
        Ok(self.finish_if_owned())
    }

    fn cancel(&mut self) -> Result<(), PythonError> {
        match self.process.as_mut() {
            Some(process) => process.cancel().map_err(process_custody_error),
            None => Ok(()),
        }
    }

    fn wait_reaped(&mut self) -> Result<(), PythonError> {
        let _ = self.finish_if_owned();
        Ok(())
    }
}

impl Drop for ActiveOwnedHostExecCall {
    fn drop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.cancel();
            let _ = self.finish_process(process);
        }
    }
}

pub type HostExecService<R> = HostCallServiceCore<R>;

pub struct HostCallServiceCore<R> {
    binding: RunBinding,
    effects: RunEffectReporter,
    profile: CapabilityProfile,
    runner: R,
    ledger: HostExecLedgerOwner,
    ambiguity_reported: bool,
}

impl<R: HostExecRunner> HostCallServiceCore<R> {
    pub fn new(
        binding: &RunBinding,
        effects: RunEffectReporter,
        profile: CapabilityProfile,
        runner: R,
        ledger: HostExecLedgerOwner,
    ) -> Self {
        Self {
            binding: binding.clone(),
            effects,
            profile,
            runner,
            ledger,
            ambiguity_reported: false,
        }
    }

    fn invoke(&mut self, call: &HostCall) -> HostResult {
        if self.ambiguity_reported {
            return HostResult::rejected(REJECT_AMBIGUOUS);
        }
        let request = match HostExecRequest::from_host_call(self.profile, call) {
            Ok(request) => request,
            Err(_) => return HostResult::rejected(REJECT_REQUEST),
        };
        let identity = match EffectIdentity::new(
            self.binding.request_id(),
            self.binding.context_id(),
            self.binding.generation(),
            self.binding.run_id(),
            call.call_index,
            &call.capability,
            request.canonical_bytes(),
        ) {
            Ok(identity) => identity,
            Err(_) => return HostResult::rejected(REJECT_REQUEST),
        };
        let binding = protocol_binding(&identity);
        let claim = match self.effects.reserve(binding, MAX_HOST_EXEC_RECEIPT_BYTES) {
            Ok(claim) => claim,
            Err(_) => return HostResult::rejected(REJECT_REPORTER),
        };
        let admission = self.ledger.lock().prepare(&identity);
        match admission {
            Err(HostExecLedgerError::ReceiptIntegrity) => {
                self.report_ambiguity(claim, EffectAmbiguityReason::ReceiptIntegrityFailed)
            }
            Err(HostExecLedgerError::Conflict | HostExecLedgerError::Unavailable) => {
                self.reject_without_effect(claim, REJECT_LEDGER)
            }
            Ok(PrepareOutcome::Prepared | PrepareOutcome::Ambiguous) => {
                self.report_ambiguity(claim, EffectAmbiguityReason::ExecutorLost)
            }
            Ok(PrepareOutcome::Completed(receipt)) => self.finish_completed(claim, receipt),
            Ok(PrepareOutcome::New(token)) => self.execute_new(claim, token, &request),
        }
    }

    fn execute_new(
        &mut self,
        claim: RunEffectClaim,
        token: ExecutionToken,
        request: &HostExecRequest,
    ) -> HostResult {
        let expected_effect_id = claim.binding().effect_id.clone();
        match self.runner.run(token, request) {
            HostExecRunnerOutcome::Ambiguous(token) => {
                if token.effect_id().to_hex() == expected_effect_id {
                    let _ = self.ledger.lock().mark_ambiguous(token);
                }
                self.report_ambiguity(claim, EffectAmbiguityReason::ExecutorLost)
            }
            HostExecRunnerOutcome::Completed(token, result) => {
                if token.effect_id().to_hex() != expected_effect_id {
                    return self.report_ambiguity(claim, EffectAmbiguityReason::ExecutorLost);
                }
                let bytes = result.canonical_receipt_bytes();
                if HostExecResult::decode_canonical_receipt(&bytes).is_err() {
                    let _ = self.ledger.lock().mark_ambiguous(token);
                    return self
                        .report_ambiguity(claim, EffectAmbiguityReason::ReceiptIntegrityFailed);
                }
                let completion = self.ledger.lock().complete(token, &bytes);
                match completion {
                    Ok(receipt) => self.finish_completed(claim, receipt),
                    Err(_) => self.report_ambiguity(
                        claim,
                        EffectAmbiguityReason::CompletionPersistenceFailed,
                    ),
                }
            }
        }
    }

    fn finish_completed(&mut self, claim: RunEffectClaim, receipt: StoredReceipt) -> HostResult {
        let result = match verify_and_decode(&receipt) {
            Ok(result) => result,
            Err(()) => {
                return self.report_ambiguity(claim, EffectAmbiguityReason::ReceiptIntegrityFailed);
            }
        };
        let completed = CompletedEffectReceipt {
            binding: claim.binding().clone(),
            receipt: URL_SAFE_NO_PAD.encode(&receipt.bytes),
            receipt_sha256: hex::encode(receipt.sha256),
        };
        if claim.completed(completed).is_err() {
            self.ambiguity_reported = true;
            return HostResult::rejected(REJECT_AMBIGUOUS);
        }
        guest_result(result)
    }

    fn report_ambiguity(
        &mut self,
        claim: RunEffectClaim,
        reason: EffectAmbiguityReason,
    ) -> HostResult {
        self.ambiguity_reported = true;
        let ambiguity = EffectAmbiguity {
            binding: claim.binding().clone(),
            reason,
            may_have_occurred: true,
            context_invalidated: true,
        };
        let _ = claim.ambiguous(ambiguity);
        HostResult::rejected(REJECT_AMBIGUOUS)
    }

    fn reject_without_effect(
        &mut self,
        claim: RunEffectClaim,
        message: &'static str,
    ) -> HostResult {
        if claim.release().is_ok() {
            HostResult::rejected(message)
        } else {
            self.ambiguity_reported = true;
            HostResult::rejected(REJECT_AMBIGUOUS)
        }
    }
}

impl<R: HostExecRunner> HostCallService for HostCallServiceCore<R> {
    fn call(&mut self, call: &HostCall) -> HostResult {
        self.invoke(call)
    }
}

fn settle_completed(claim: RunEffectClaim, receipt: StoredReceipt) -> HostResult {
    let result = match verify_and_decode(&receipt) {
        Ok(result) => result,
        Err(()) => {
            return settle_ambiguity(claim, EffectAmbiguityReason::ReceiptIntegrityFailed);
        }
    };
    let completed = CompletedEffectReceipt {
        binding: claim.binding().clone(),
        receipt: URL_SAFE_NO_PAD.encode(&receipt.bytes),
        receipt_sha256: hex::encode(receipt.sha256),
    };
    if claim.completed(completed).is_err() {
        return HostResult::rejected(REJECT_AMBIGUOUS);
    }
    guest_result(result)
}

fn settle_ambiguity(claim: RunEffectClaim, reason: EffectAmbiguityReason) -> HostResult {
    let ambiguity = EffectAmbiguity {
        binding: claim.binding().clone(),
        reason,
        may_have_occurred: true,
        context_invalidated: true,
    };
    let _ = claim.ambiguous(ambiguity);
    HostResult::rejected(REJECT_AMBIGUOUS)
}

fn release_without_effect(claim: RunEffectClaim, message: &'static str) -> HostResult {
    if claim.release().is_ok() {
        HostResult::rejected(message)
    } else {
        HostResult::rejected(REJECT_AMBIGUOUS)
    }
}

fn process_custody_error(_error: impl std::error::Error) -> PythonError {
    PythonError::Io(io::Error::other("host execution process custody failed"))
}

fn classify_prepare_error(error: EffectError) -> HostExecLedgerError {
    match error {
        EffectError::Conflict | EffectError::EffectIdCollision => HostExecLedgerError::Conflict,
        EffectError::Corrupt(_) => HostExecLedgerError::ReceiptIntegrity,
        _ => HostExecLedgerError::Unavailable,
    }
}

fn protocol_binding(identity: &EffectIdentity) -> EffectBinding {
    EffectBinding {
        effect_id: identity.effect_id().to_hex(),
        request_id: identity.request_id().to_owned(),
        context_id: identity.context_id().to_owned(),
        generation: identity.generation(),
        run_id: identity.run_id().to_owned(),
        call_index: identity.call_index(),
        capability: identity.capability().to_owned(),
        request_sha256: hex::encode(identity.canonical_request_sha256()),
    }
}

fn verify_and_decode(receipt: &StoredReceipt) -> Result<HostExecResult, ()> {
    let actual = digest(&SHA256, &receipt.bytes);
    if actual.as_ref() != receipt.sha256.as_slice() {
        return Err(());
    }
    HostExecResult::decode_canonical_receipt(&receipt.bytes).map_err(|_| ())
}

fn guest_result(result: HostExecResult) -> HostResult {
    match result.termination() {
        HostExecTermination::Exited(0) => match String::from_utf8(result.stdout().to_vec()) {
            Ok(stdout) => HostResult::accepted(stdout),
            Err(_) => HostResult::rejected(REJECT_UTF8),
        },
        HostExecTermination::Exited(_) => HostResult::rejected(REJECT_EXIT),
        HostExecTermination::Signaled(_) => HostResult::rejected(REJECT_SIGNAL),
    }
}
