use std::cmp;
use std::fmt;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use elpis_grants::{
    AuthenticatedNarrowingPermit, CanonicalSensitivePolicy, CapabilityBudget, NarrowingOutcomeV1,
    SensitiveCapabilityRule, SensitiveClassifierPolicy, SensitivePolicyV1,
};
use rusqlite::{OptionalExtension, params};
use thiserror::Error;

use super::{
    ActiveGrant, Clock, GrantLedger, decode_hash, load_terminal_receipt, lower_hex_hash, sha256,
};
use crate::effect_authorization::DeterministicSensitiveEffectAuthorization;

const SESSION_BINDING_DOMAIN: &[u8] = b"elpis-sensitive-session-v1\0";

/// Deliberately coarse denial classes: callers do not receive a policy-inspection oracle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SensitiveSessionDenied {
    #[error("sensitive session is unavailable")]
    Unavailable,
    #[error("sensitive session policy is denied")]
    PolicyDenied,
    #[error("sensitive session policy is latched")]
    PolicyLatched,
    #[error("sensitive session lease has ended")]
    LeaseEnded,
    #[error("sensitive session budget is denied")]
    BudgetDenied,
}

/// Deliberately generic closure returned for every classifier-admission failure.
///
/// Guest-facing code must not distinguish a malformed, stale, replayed, expired, revoked,
/// flagged, unavailable, or over-budget classifier decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("sensitive authority is revoked")]
pub struct SensitiveAuthorityRevoked;

/// Maximum resources reserved permanently before one run can start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SensitiveRunReservation {
    pub max_wall_ms: u64,
    pub max_cpu_ms: u64,
    pub max_rss_bytes: u64,
    pub max_scratch_bytes: u64,
}

/// Maximum resources reserved permanently before one external effect can start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SensitiveEffectReservation {
    pub capability_index: u32,
    pub request_bytes: u64,
    pub max_result_bytes: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
    pub artifact_count: u32,
    pub artifact_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveSessionTerminalReason {
    LeaseEnded,
    BudgetExhausted,
    Unavailable,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct CapabilityUsage {
    calls: u32,
}

#[derive(Debug)]
enum SessionClock {
    System {
        started_at: Instant,
        max_elapsed: Duration,
    },
    #[cfg(test)]
    Fixed(u64),
}

impl SessionClock {
    fn from_ledger(clock: &Clock, max_elapsed_s: u64) -> Self {
        match clock {
            Clock::System => Self::System {
                started_at: Instant::now(),
                max_elapsed: Duration::from_secs(max_elapsed_s),
            },
            #[cfg(test)]
            Clock::Fixed(now) => Self::Fixed(*now),
        }
    }

    fn now_unix_s(&self) -> Result<u64, SensitiveSessionDenied> {
        match self {
            Self::System { .. } => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| SensitiveSessionDenied::Unavailable)
                .map(|duration| duration.as_secs()),
            #[cfg(test)]
            Self::Fixed(now) => Ok(*now),
        }
    }

    fn live_now(&self, wall_deadline_unix_s: u64) -> Result<Option<u64>, SensitiveSessionDenied> {
        let wall_now = self.now_unix_s()?;
        let live = match self {
            Self::System {
                started_at,
                max_elapsed,
            } => started_at.elapsed() < *max_elapsed && wall_now < wall_deadline_unix_s,
            #[cfg(test)]
            Self::Fixed(_) => wall_now < wall_deadline_unix_s,
        };
        Ok(live.then_some(wall_now))
    }

    fn is_live(&self, wall_deadline_unix_s: u64) -> Result<bool, SensitiveSessionDenied> {
        self.live_now(wall_deadline_unix_s).map(|now| now.is_some())
    }
}

pub struct SensitiveSession {
    active_grant: ActiveGrant,
    policy: CanonicalSensitivePolicy,
    policy_sha256: [u8; 32],
    binding: [u8; 32],
    lease_deadline_unix_s: u64,
    clock: SessionClock,
    terminal_reason: Option<SensitiveSessionTerminalReason>,
    last_narrowing_issuer_seq: u64,
    classifier_flagged: bool,
    runs_used: u32,
    effects_used: u32,
    wall_ms_reserved: u64,
    cpu_ms_reserved: u64,
    rss_bytes_reserved: u64,
    scratch_bytes_reserved: u64,
    io_read_bytes_used: u64,
    io_write_bytes_used: u64,
    artifacts_used: u32,
    artifact_bytes_used: u64,
    capability_usage: Vec<CapabilityUsage>,
}

impl fmt::Debug for SensitiveSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SensitiveSession")
            .field("grant_id", &self.active_grant.grant.grant_id)
            .field("executor_id", &self.active_grant.grant.executor_id)
            .field("profile_id", &self.policy.policy().profile_id)
            .field("lease_deadline_unix_s", &self.lease_deadline_unix_s)
            .field("runs_used", &self.runs_used)
            .field("effects_used", &self.effects_used)
            .finish_non_exhaustive()
    }
}

impl SensitiveSession {
    pub fn grant_id(&self) -> &str {
        &self.active_grant.grant.grant_id
    }

    pub fn executor_id(&self) -> &str {
        &self.active_grant.grant.executor_id
    }

    pub fn profile_id(&self) -> &str {
        &self.policy.policy().profile_id
    }

    pub fn policy_sha256(&self) -> &[u8; 32] {
        &self.policy_sha256
    }

    pub fn lease_deadline_unix_s(&self) -> u64 {
        self.lease_deadline_unix_s
    }

    pub fn runs_used(&self) -> u32 {
        self.runs_used
    }

    pub fn effects_used(&self) -> u32 {
        self.effects_used
    }

    pub fn terminal_reason(&self) -> Option<SensitiveSessionTerminalReason> {
        self.terminal_reason
    }

    /// Host-only classifier sequence state for diagnostics and control handling.
    pub fn last_narrowing_issuer_seq(&self) -> u64 {
        self.last_narrowing_issuer_seq
    }

    /// Host-only disposition. Guest-facing closure remains SensitiveAuthorityRevoked.
    pub fn classifier_flagged(&self) -> bool {
        self.classifier_flagged
    }

    pub(super) fn ledger_binding(&self) -> [u8; 32] {
        self.active_grant.ledger_binding
    }

    pub(super) fn grant_payload_sha256(&self) -> &[u8; 32] {
        &self.active_grant.payload_sha256
    }

    pub(super) fn canonical_policy_bytes(&self) -> Result<Vec<u8>, super::GrantLedgerError> {
        self.policy.policy().canonical_bytes().map_err(|error| {
            super::GrantLedgerError::Corrupt(format!(
                "live sensitive session policy is no longer canonical: {error}"
            ))
        })
    }

    pub(super) fn disable_after_terminal_control(&mut self) {
        self.terminal_reason = Some(SensitiveSessionTerminalReason::Unavailable);
    }

    pub fn mint_run_permit(
        &mut self,
        reservation: SensitiveRunReservation,
    ) -> Result<SensitiveRunPermit, SensitiveSessionDenied> {
        self.ensure_live()?;
        let budgets = &self.policy.policy().budgets;
        if reservation.max_wall_ms == 0
            || reservation.max_wall_ms > budgets.max_wall_ms
            || reservation.max_cpu_ms == 0
            || reservation.max_cpu_ms > budgets.max_cpu_ms
            || reservation.max_rss_bytes == 0
            || reservation.max_rss_bytes > budgets.max_rss_bytes
            || reservation.max_scratch_bytes > budgets.max_scratch_bytes
        {
            return Err(SensitiveSessionDenied::BudgetDenied);
        }
        let next = (
            self.runs_used
                .checked_add(1)
                .filter(|value| *value <= budgets.max_runs),
            self.wall_ms_reserved
                .checked_add(reservation.max_wall_ms)
                .filter(|value| *value <= budgets.max_wall_ms),
            self.cpu_ms_reserved
                .checked_add(reservation.max_cpu_ms)
                .filter(|value| *value <= budgets.max_cpu_ms),
            self.rss_bytes_reserved
                .checked_add(reservation.max_rss_bytes)
                .filter(|value| *value <= budgets.max_rss_bytes),
            self.scratch_bytes_reserved
                .checked_add(reservation.max_scratch_bytes)
                .filter(|value| *value <= budgets.max_scratch_bytes),
        );
        let (
            Some(run_index),
            Some(next_wall_ms),
            Some(next_cpu_ms),
            Some(next_rss_bytes),
            Some(next_scratch_bytes),
        ) = next
        else {
            return self.deny_budget_exhausted();
        };
        self.runs_used = run_index;
        self.wall_ms_reserved = next_wall_ms;
        self.cpu_ms_reserved = next_cpu_ms;
        self.rss_bytes_reserved = next_rss_bytes;
        self.scratch_bytes_reserved = next_scratch_bytes;
        Ok(SensitiveRunPermit {
            session_binding: self.binding,
            run_index,
            reservation,
        })
    }

    /// Consumes exact deterministic authorization and authenticated classifier evidence to mint
    /// one live effect permit. Every failure terminalizes the session behind one generic error.
    pub fn admit_classifier_narrowing(
        &mut self,
        run: &SensitiveRunPermit,
        authorization: DeterministicSensitiveEffectAuthorization,
        permit: AuthenticatedNarrowingPermit,
    ) -> Result<SensitiveEffectPermit, SensitiveAuthorityRevoked> {
        let admitted = self.admit_classifier_narrowing_inner(run, authorization, permit);
        if admitted.is_err() && self.terminal_reason.is_none() {
            self.terminal_reason = Some(SensitiveSessionTerminalReason::Unavailable);
        }
        admitted
    }

    fn admit_classifier_narrowing_inner(
        &mut self,
        run: &SensitiveRunPermit,
        authorization: DeterministicSensitiveEffectAuthorization,
        permit: AuthenticatedNarrowingPermit,
    ) -> Result<SensitiveEffectPermit, SensitiveAuthorityRevoked> {
        if self.terminal_reason.is_some() {
            return Err(SensitiveAuthorityRevoked);
        }
        let now = self
            .clock
            .live_now(self.lease_deadline_unix_s)
            .map_err(|_| SensitiveAuthorityRevoked)?
            .ok_or(SensitiveAuthorityRevoked)?;
        let claim = permit.permit();
        let (classifier_model_ref, classifier_policy_sha256) =
            match &self.policy.policy().classifier {
                SensitiveClassifierPolicy::Required {
                    model_ref,
                    policy_sha256,
                    ..
                } => (model_ref.as_str(), policy_sha256.as_str()),
                SensitiveClassifierPolicy::Disabled => return Err(SensitiveAuthorityRevoked),
            };
        let grant_payload_sha256 = encode_lower_hex(&self.active_grant.payload_sha256);
        let session_binding_sha256 = encode_lower_hex(&self.binding);
        let policy_sha256 = self.policy.policy_sha256();

        // Authentication only proves the signature over caller-supplied expectations. Admission
        // independently re-derives every mutable live-session and deterministic-proof binding.
        if run.session_binding != self.binding
            || claim.grant_id.as_str() != self.active_grant.grant.grant_id.as_str()
            || claim.executor_id.as_str() != self.active_grant.grant.executor_id.as_str()
            || claim.policy_epoch != self.active_grant.grant.policy_epoch
            || claim.grant_payload_sha256.as_str() != grant_payload_sha256.as_str()
            || claim.session_binding_sha256.as_str() != session_binding_sha256.as_str()
            || claim.policy_sha256.as_str() != policy_sha256
            || claim.effect_request_sha256.as_str() != authorization.request_sha256()
            || claim.classifier_model_ref.as_str() != classifier_model_ref
            || claim.classifier_policy_sha256.as_str() != classifier_policy_sha256
            || authorization.policy_profile_id() != self.policy.policy().profile_id.as_str()
            || authorization.policy_sha256() != policy_sha256
            || claim.issued_at_unix_s > now
            || now >= claim.expires_at_unix_s
            || claim.issuer_seq <= self.last_narrowing_issuer_seq
        {
            return Err(SensitiveAuthorityRevoked);
        }

        // Burn a valid issuer sequence before interpreting its outcome. A cloned authenticated
        // permit can therefore never authorize a second request in this live session.
        self.last_narrowing_issuer_seq = claim.issuer_seq;
        match claim.outcome {
            NarrowingOutcomeV1::Allow => {
                let dimensions = authorization.dimensions();
                let reservation = SensitiveEffectReservation {
                    capability_index: authorization.capability_index(),
                    request_bytes: dimensions.request_bytes,
                    max_result_bytes: dimensions.max_result_bytes,
                    io_read_bytes: dimensions.io_read_bytes,
                    io_write_bytes: dimensions.io_write_bytes,
                    artifact_count: dimensions.artifact_count,
                    artifact_bytes: dimensions.artifact_bytes,
                };
                self.mint_effect_permit(run, reservation)
                    .map_err(|_| SensitiveAuthorityRevoked)
            }
            NarrowingOutcomeV1::Revoke => Err(SensitiveAuthorityRevoked),
            NarrowingOutcomeV1::Flag => {
                self.classifier_flagged = true;
                Err(SensitiveAuthorityRevoked)
            }
        }
    }

    /// Terminalizes classifier timeout, provider failure, or malformed provider output without
    /// recording a malicious classifier disposition.
    pub fn classifier_unavailable<T>(&mut self) -> Result<T, SensitiveAuthorityRevoked> {
        self.terminal_reason = Some(SensitiveSessionTerminalReason::Unavailable);
        Err(SensitiveAuthorityRevoked)
    }

    pub fn mint_effect_permit(
        &mut self,
        run: &SensitiveRunPermit,
        reservation: SensitiveEffectReservation,
    ) -> Result<SensitiveEffectPermit, SensitiveSessionDenied> {
        self.ensure_live()?;
        if run.session_binding != self.binding {
            return Err(SensitiveSessionDenied::BudgetDenied);
        }
        let capability_index = usize::try_from(reservation.capability_index)
            .map_err(|_| SensitiveSessionDenied::BudgetDenied)?;
        let capability = self
            .policy
            .policy()
            .capabilities
            .get(capability_index)
            .ok_or(SensitiveSessionDenied::BudgetDenied)?;
        let capability_budget = capability_budget(capability);
        if reservation.request_bytes > capability_budget.max_request_bytes
            || reservation.max_result_bytes > capability_budget.max_result_bytes
        {
            return Err(SensitiveSessionDenied::BudgetDenied);
        }

        validate_artifact_reservation(self.policy.policy(), capability, reservation)?;
        let budgets = &self.policy.policy().budgets;
        let persistence = &self.policy.policy().persistence;
        let next = (
            self.effects_used
                .checked_add(1)
                .filter(|value| *value <= budgets.max_effects),
            self.capability_usage[capability_index]
                .calls
                .checked_add(1)
                .filter(|value| *value <= capability_budget.max_calls),
            self.io_read_bytes_used
                .checked_add(reservation.io_read_bytes)
                .filter(|value| *value <= budgets.max_io_read_bytes),
            self.io_write_bytes_used
                .checked_add(reservation.io_write_bytes)
                .filter(|value| *value <= budgets.max_io_write_bytes),
            self.artifacts_used
                .checked_add(reservation.artifact_count)
                .filter(|value| *value <= persistence.max_artifacts),
            self.artifact_bytes_used
                .checked_add(reservation.artifact_bytes)
                .filter(|value| *value <= persistence.max_total_artifact_bytes),
        );
        let (
            Some(next_effects),
            Some(next_capability_calls),
            Some(next_io_read),
            Some(next_io_write),
            Some(next_artifacts),
            Some(next_artifact_bytes),
        ) = next
        else {
            return self.deny_budget_exhausted();
        };

        self.capability_usage[capability_index].calls = next_capability_calls;
        self.effects_used = next_effects;
        self.io_read_bytes_used = next_io_read;
        self.io_write_bytes_used = next_io_write;
        self.artifacts_used = next_artifacts;
        self.artifact_bytes_used = next_artifact_bytes;

        Ok(SensitiveEffectPermit {
            session_binding: self.binding,
            run_index: run.run_index,
            effect_index: next_effects,
            reservation,
        })
    }

    pub(super) fn ensure_live(&mut self) -> Result<(), SensitiveSessionDenied> {
        if let Some(reason) = self.terminal_reason {
            return Err(reason.denial());
        }
        match self.clock.is_live(self.lease_deadline_unix_s) {
            Ok(true) => Ok(()),
            Ok(false) => {
                self.terminal_reason = Some(SensitiveSessionTerminalReason::LeaseEnded);
                Err(SensitiveSessionDenied::LeaseEnded)
            }
            Err(error) => {
                self.terminal_reason = Some(SensitiveSessionTerminalReason::Unavailable);
                Err(error)
            }
        }
    }

    fn deny_budget_exhausted<T>(&mut self) -> Result<T, SensitiveSessionDenied> {
        self.terminal_reason = Some(SensitiveSessionTerminalReason::BudgetExhausted);
        Err(SensitiveSessionDenied::BudgetDenied)
    }
}

impl SensitiveSessionTerminalReason {
    fn denial(self) -> SensitiveSessionDenied {
        match self {
            Self::LeaseEnded => SensitiveSessionDenied::LeaseEnded,
            Self::BudgetExhausted => SensitiveSessionDenied::BudgetDenied,
            Self::Unavailable => SensitiveSessionDenied::Unavailable,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SensitiveRunPermit {
    session_binding: [u8; 32],
    run_index: u32,
    reservation: SensitiveRunReservation,
}

impl SensitiveRunPermit {
    pub fn run_index(&self) -> u32 {
        self.run_index
    }

    pub fn reservation(&self) -> SensitiveRunReservation {
        self.reservation
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SensitiveEffectPermit {
    session_binding: [u8; 32],
    run_index: u32,
    effect_index: u32,
    reservation: SensitiveEffectReservation,
}

impl SensitiveEffectPermit {
    pub fn run_index(&self) -> u32 {
        self.run_index
    }

    pub fn effect_index(&self) -> u32 {
        self.effect_index
    }

    pub fn reservation(&self) -> SensitiveEffectReservation {
        self.reservation
    }
}

impl GrantLedger {
    pub fn begin_sensitive_session(
        &self,
        active: ActiveGrant,
        policy: CanonicalSensitivePolicy,
    ) -> Result<SensitiveSession, SensitiveSessionDenied> {
        let ActiveGrant {
            grant,
            payload_sha256,
            ledger_binding,
        } = active;
        if ledger_binding != self.ledger_binding {
            return Err(SensitiveSessionDenied::Unavailable);
        }
        if grant.policy_sha256 != policy.policy_sha256() {
            return Err(SensitiveSessionDenied::PolicyDenied);
        }
        let policy_sha256 = lower_hex_hash(policy.policy_sha256())
            .map_err(|_| SensitiveSessionDenied::PolicyDenied)?;
        let stored_hash = self
            .connection
            .query_row(
                "SELECT payload_sha256 FROM grants WHERE grant_id = ?1",
                params![grant.grant_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(|_| SensitiveSessionDenied::Unavailable)?
            .ok_or(SensitiveSessionDenied::Unavailable)
            .and_then(|bytes| {
                decode_hash(bytes, "grant payload hash")
                    .map_err(|_| SensitiveSessionDenied::Unavailable)
            })?;
        if stored_hash != payload_sha256
            || load_terminal_receipt(&self.connection, &grant.grant_id)
                .map_err(|_| SensitiveSessionDenied::Unavailable)?
                .is_some()
        {
            return Err(SensitiveSessionDenied::Unavailable);
        }
        let now = self
            .clock
            .now_unix_s()
            .map_err(|_| SensitiveSessionDenied::Unavailable)?;
        if now < grant.not_before_unix_s || now >= grant.expires_at_unix_s {
            return Err(SensitiveSessionDenied::LeaseEnded);
        }
        if self
            .policy_latch_is_set(
                &grant.executor_id,
                &policy.policy().profile_id,
                &policy_sha256,
            )
            .map_err(|_| SensitiveSessionDenied::Unavailable)?
        {
            return Err(SensitiveSessionDenied::PolicyLatched);
        }
        let policy_deadline = now
            .checked_add(policy.policy().budgets.max_lease_s)
            .ok_or(SensitiveSessionDenied::Unavailable)?;
        let lease_deadline_unix_s = cmp::min(grant.expires_at_unix_s, policy_deadline);
        let binding = session_binding(ledger_binding, payload_sha256, policy_sha256);
        let capability_usage = vec![CapabilityUsage::default(); policy.policy().capabilities.len()];
        Ok(SensitiveSession {
            active_grant: ActiveGrant {
                grant,
                payload_sha256,
                ledger_binding,
            },
            policy,
            policy_sha256,
            binding,
            lease_deadline_unix_s,
            clock: SessionClock::from_ledger(&self.clock, lease_deadline_unix_s - now),
            terminal_reason: None,
            last_narrowing_issuer_seq: 0,
            classifier_flagged: false,
            runs_used: 0,
            effects_used: 0,
            wall_ms_reserved: 0,
            cpu_ms_reserved: 0,
            rss_bytes_reserved: 0,
            scratch_bytes_reserved: 0,
            io_read_bytes_used: 0,
            io_write_bytes_used: 0,
            artifacts_used: 0,
            artifact_bytes_used: 0,
            capability_usage,
        })
    }

    pub fn finish_sensitive_session(
        &mut self,
        mut session: SensitiveSession,
    ) -> Result<super::GrantTerminalReceipt, super::GrantLedgerError> {
        let _ = session.ensure_live();
        let kind = match session.terminal_reason {
            None => super::GrantTerminalKind::Completed,
            Some(SensitiveSessionTerminalReason::LeaseEnded) => super::GrantTerminalKind::Expired,
            Some(
                SensitiveSessionTerminalReason::BudgetExhausted
                | SensitiveSessionTerminalReason::Unavailable,
            ) => super::GrantTerminalKind::Interrupted,
        };
        self.terminate(session.active_grant, kind)
    }

    /// Atomically admits a signed revoke/flag for this exact live session and settles its grant.
    ///
    /// The session is consumed on every path. Only a committed admission returns an
    /// informational kill request; this method never kills or launches anything.
    pub fn admit_terminal_control_for_sensitive_session(
        &mut self,
        payload: &[u8],
        signature: &[u8],
        mut session: SensitiveSession,
    ) -> Result<super::SensitiveSessionKillRequest, super::GrantLedgerError> {
        let admission =
            self.admit_terminal_control_inner(payload, signature, Some(&mut session))?;
        let terminal_receipt = admission.terminal_receipt.ok_or_else(|| {
            super::GrantLedgerError::Corrupt(
                "integrated terminal control committed without a terminal receipt".into(),
            )
        })?;

        // The durable transaction has committed before the in-memory session is disabled and
        // before the non-authority request becomes observable.
        let executor_id = session.executor_id().to_owned();
        let grant_id = session.grant_id().to_owned();
        session.disable_after_terminal_control();
        Ok(super::SensitiveSessionKillRequest {
            executor_id,
            grant_id,
            control_receipt: admission.receipt,
            terminal_receipt,
        })
    }
}

fn capability_budget(capability: &SensitiveCapabilityRule) -> &CapabilityBudget {
    match capability {
        SensitiveCapabilityRule::ReadPath { budget, .. }
        | SensitiveCapabilityRule::EditTree { budget, .. }
        | SensitiveCapabilityRule::ServiceAction { budget, .. }
        | SensitiveCapabilityRule::PackageOperation { budget, .. }
        | SensitiveCapabilityRule::KubernetesNamespace { budget, .. }
        | SensitiveCapabilityRule::RemoteExecProfile { budget, .. }
        | SensitiveCapabilityRule::NetworkEndpoint { budget, .. }
        | SensitiveCapabilityRule::ArtifactExport { budget, .. } => budget,
    }
}

fn validate_artifact_reservation(
    policy: &SensitivePolicyV1,
    capability: &SensitiveCapabilityRule,
    reservation: SensitiveEffectReservation,
) -> Result<(), SensitiveSessionDenied> {
    if (reservation.artifact_count == 0) != (reservation.artifact_bytes == 0)
        || reservation.artifact_count > 1
    {
        return Err(SensitiveSessionDenied::BudgetDenied);
    }
    if reservation.artifact_count == 0 {
        return Ok(());
    }
    let SensitiveCapabilityRule::ArtifactExport {
        max_artifact_bytes, ..
    } = capability
    else {
        return Err(SensitiveSessionDenied::BudgetDenied);
    };
    if reservation.artifact_bytes > *max_artifact_bytes {
        return Err(SensitiveSessionDenied::BudgetDenied);
    }
    if policy.persistence.max_artifacts == 0 || policy.persistence.max_total_artifact_bytes == 0 {
        return Err(SensitiveSessionDenied::BudgetDenied);
    }
    Ok(())
}

fn encode_lower_hex(bytes: &[u8; 32]) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(64);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn session_binding(
    ledger_binding: [u8; 32],
    payload_sha256: [u8; 32],
    policy_sha256: [u8; 32],
) -> [u8; 32] {
    let mut input = Vec::with_capacity(SESSION_BINDING_DOMAIN.len() + 96);
    input.extend_from_slice(SESSION_BINDING_DOMAIN);
    input.extend_from_slice(&ledger_binding);
    input.extend_from_slice(&payload_sha256);
    input.extend_from_slice(&policy_sha256);
    sha256(&input)
}

#[cfg(test)]
mod tests {
    use elpis_grants::{
        ArtifactNamePolicy, ArtifactWriteMode, CanonicalSensitiveEffectRequest,
        CanonicalSensitiveProfileRegistry, ClassifierTrustDomain, EntryOwnershipPolicy,
        EntryWritePolicy, FilesystemRootBinding, GRANT_VERSION, GrantBinding, GrantMode, GrantV1,
        GrantVerifier, GuestPersistence, HardLinkPolicy, MountCrossingPolicy,
        NARROWING_PERMIT_VERSION, NarrowingOutcomeV1, NarrowingPermitBinding, NarrowingPermitV1,
        NarrowingPermitVerifier, SENSITIVE_EFFECT_REQUEST_VERSION, SENSITIVE_LOCAL_PROFILE_VERSION,
        SENSITIVE_POLICY_VERSION, SENSITIVE_PROFILE_REGISTRY_VERSION, SensitiveBudgets,
        SensitiveClassifierPolicy, SensitiveEffectRequestV1, SensitiveEffectV1,
        SensitiveLocalProfileKindV1, SensitiveLocalProfileV1, SensitivePersistencePolicy,
        SensitiveProfileRef, SensitiveProfileRegistryEntryV1, SensitiveProfileRegistryV1,
        SpecialFilePolicy, SymlinkPolicy, TerminalControlActionV1, TerminalControlV1,
        TerminalControlVerifier, narrowing_permit_signature_input, signature_input,
        terminal_control_signature_input,
    };
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use tempfile::TempDir;

    use super::*;
    use crate::effect_authorization::authorize_sensitive_effect;
    use crate::{GrantLedgerLimits, u64_blob};

    const NOW: u64 = 1_700_000_100;
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const NONCE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    struct Fixture {
        _temp: TempDir,
        ledger: GrantLedger,
    }

    fn key() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[19; 32]).unwrap()
    }

    fn verifier() -> GrantVerifier {
        GrantVerifier::new(
            "operator-1",
            key().public_key().as_ref(),
            "executor-1",
            3,
            900,
        )
        .unwrap()
    }

    fn control_verifier() -> TerminalControlVerifier {
        TerminalControlVerifier::new(
            "operator-1",
            key().public_key().as_ref(),
            "executor-1",
            3,
            900,
        )
        .unwrap()
    }

    fn fixture(with_control_verifier: bool) -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private").join("grants.sqlite");
        let ledger = if with_control_verifier {
            GrantLedger::open_with_terminal_control_verifier_and_clock(
                &path,
                verifier(),
                control_verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            )
        } else {
            GrantLedger::open_with_clock(
                &path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            )
        }
        .unwrap();
        Fixture {
            _temp: temp,
            ledger,
        }
    }

    fn policy() -> (Vec<u8>, CanonicalSensitivePolicy) {
        let policy = SensitivePolicyV1 {
            version: SENSITIVE_POLICY_VERSION,
            profile_id: "sensitive-v1".into(),
            capabilities: vec![SensitiveCapabilityRule::ArtifactExport {
                destination_profile: SensitiveProfileRef {
                    id: "artifact-destination-v1".into(),
                    sha256: HASH_D.into(),
                },
                max_artifact_bytes: 40,
                budget: CapabilityBudget {
                    max_calls: 2,
                    max_request_bytes: 30,
                    max_result_bytes: 40,
                },
            }],
            budgets: SensitiveBudgets {
                max_runs: 2,
                max_effects: 2,
                max_lease_s: 30,
                max_wall_ms: 1_000,
                max_cpu_ms: 800,
                max_rss_bytes: 1_048_576,
                max_io_read_bytes: 100,
                max_io_write_bytes: 100,
                max_scratch_bytes: 2_048,
            },
            classifier: SensitiveClassifierPolicy::Disabled,
            persistence: SensitivePersistencePolicy {
                guest_persistence: GuestPersistence::Disabled,
                max_artifacts: 2,
                max_total_artifact_bytes: 50,
            },
        };
        let bytes = policy.canonical_bytes().unwrap();
        let canonical = CanonicalSensitivePolicy::parse(&bytes).unwrap();
        (bytes, canonical)
    }

    fn grant(id: &str, sequence: u64, policy_sha256: &str, expires_at: u64) -> GrantV1 {
        GrantV1 {
            version: GRANT_VERSION,
            grant_id: id.into(),
            issuer_id: "operator-1".into(),
            issuer_seq: sequence,
            executor_id: "executor-1".into(),
            policy_epoch: 3,
            not_before_unix_s: NOW,
            expires_at_unix_s: expires_at,
            mind_id: "elm-session-test".into(),
            mandate_sha256: HASH_A.into(),
            runtime_sha256: HASH_B.into(),
            policy_sha256: policy_sha256.into(),
            mode: GrantMode::SensitiveGranted,
            nonce: NONCE.into(),
        }
    }

    fn binding(policy_sha256: &str) -> GrantBinding {
        GrantBinding {
            mind_id: "elm-session-test".into(),
            mandate_sha256: HASH_A.into(),
            runtime_sha256: HASH_B.into(),
            policy_sha256: policy_sha256.into(),
        }
    }

    fn admit(
        ledger: &mut GrantLedger,
        id: &str,
        sequence: u64,
        policy_sha256: &str,
        expires_at: u64,
    ) -> (GrantV1, ActiveGrant) {
        let grant = grant(id, sequence, policy_sha256, expires_at);
        let payload = grant.canonical_payload().unwrap();
        let signature = key().sign(&signature_input(&payload).unwrap());
        let active = ledger
            .admit(&payload, signature.as_ref(), &binding(policy_sha256))
            .unwrap();
        (grant, active)
    }

    fn duplicate_active(active: &ActiveGrant) -> ActiveGrant {
        ActiveGrant {
            grant: active.grant.clone(),
            payload_sha256: active.payload_sha256,
            ledger_binding: active.ledger_binding,
        }
    }

    fn terminal_control(
        id: &str,
        sequence: u64,
        grant: &GrantV1,
        flagged: bool,
    ) -> (Vec<u8>, Vec<u8>) {
        let grant_payload = grant.canonical_payload().unwrap();
        let target = if flagged {
            TerminalControlActionV1::FlagGrant {
                grant_id: grant.grant_id.clone(),
                grant_payload_sha256: hex_hash(sha256(&grant_payload)),
            }
        } else {
            TerminalControlActionV1::RevokeGrant {
                grant_id: grant.grant_id.clone(),
                grant_payload_sha256: hex_hash(sha256(&grant_payload)),
            }
        };
        let control = TerminalControlV1 {
            version: elpis_grants::TERMINAL_CONTROL_VERSION,
            control_id: id.into(),
            issuer_id: "operator-1".into(),
            issuer_seq: sequence,
            executor_id: "executor-1".into(),
            policy_epoch: 3,
            target,
            issued_at_unix_s: NOW,
            expires_at_unix_s: NOW + 60,
            nonce: NONCE.into(),
        };
        let payload = control.canonical_payload().unwrap();
        let signature = key()
            .sign(&terminal_control_signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        (payload, signature)
    }

    fn clear_control(id: &str, sequence: u64, policy_sha256: &str) -> (Vec<u8>, Vec<u8>) {
        let control = TerminalControlV1 {
            version: elpis_grants::TERMINAL_CONTROL_VERSION,
            control_id: id.into(),
            issuer_id: "operator-1".into(),
            issuer_seq: sequence,
            executor_id: "executor-1".into(),
            policy_epoch: 3,
            target: TerminalControlActionV1::ClearLatch {
                profile_id: "sensitive-v1".into(),
                policy_sha256: policy_sha256.into(),
            },
            issued_at_unix_s: NOW,
            expires_at_unix_s: NOW + 60,
            nonce: NONCE.into(),
        };
        let payload = control.canonical_payload().unwrap();
        let signature = key()
            .sign(&terminal_control_signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        (payload, signature)
    }

    fn hex_hash(hash: [u8; 32]) -> String {
        hash.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn run_reservation() -> SensitiveRunReservation {
        SensitiveRunReservation {
            max_wall_ms: 500,
            max_cpu_ms: 400,
            max_rss_bytes: 524_288,
            max_scratch_bytes: 1_024,
        }
    }

    fn reservation(
        io_read_bytes: u64,
        io_write_bytes: u64,
        artifact_bytes: u64,
    ) -> SensitiveEffectReservation {
        SensitiveEffectReservation {
            capability_index: 0,
            request_bytes: 20,
            max_result_bytes: 30,
            io_read_bytes,
            io_write_bytes,
            artifact_count: u32::from(artifact_bytes > 0),
            artifact_bytes,
        }
    }

    fn classified_inputs() -> (
        CanonicalSensitivePolicy,
        CanonicalSensitiveProfileRegistry,
        CanonicalSensitiveEffectRequest,
    ) {
        let profile = SensitiveLocalProfileV1 {
            version: SENSITIVE_LOCAL_PROFILE_VERSION,
            id: "artifact-destination-v1".into(),
            profile: SensitiveLocalProfileKindV1::ArtifactCustody {
                root: FilesystemRootBinding {
                    canonical_root: "/srv/elpis-classified-artifacts".into(),
                    expected_mount_id: 7,
                    expected_device: 8,
                    expected_inode: 9,
                    expected_owner_uid: 1000,
                    expected_owner_gid: 1000,
                    expected_permissions: 0o700,
                    entry_ownership: EntryOwnershipPolicy::RootOwnerOnly,
                    entry_writes: EntryWritePolicy::OwnerOnly,
                    symlinks: SymlinkPolicy::Deny,
                    hard_links: HardLinkPolicy::DenyMultipleLinks,
                    mount_crossing: MountCrossingPolicy::Deny,
                    special_files: SpecialFilePolicy::RegularFilesAndDirectoriesOnly,
                },
                write_mode: ArtifactWriteMode::CreateOnly,
                name_policy: ArtifactNamePolicy::OpaqueUuid,
                created_file_mode: 0o600,
                max_files: 2,
                max_single_file_bytes: 40,
                max_total_bytes: 50,
            },
        };
        let entry = SensitiveProfileRegistryEntryV1::from_profile(profile).unwrap();
        let destination_profile = SensitiveProfileRef {
            id: entry.profile.id.clone(),
            sha256: entry.profile_sha256.clone(),
        };
        let registry_value = SensitiveProfileRegistryV1 {
            version: SENSITIVE_PROFILE_REGISTRY_VERSION,
            profiles: vec![entry],
        };
        let registry =
            CanonicalSensitiveProfileRegistry::parse(&registry_value.canonical_bytes().unwrap())
                .unwrap();
        let policy_value = SensitivePolicyV1 {
            version: SENSITIVE_POLICY_VERSION,
            profile_id: "sensitive-v1".into(),
            capabilities: vec![SensitiveCapabilityRule::ArtifactExport {
                destination_profile,
                max_artifact_bytes: 40,
                budget: CapabilityBudget {
                    max_calls: 2,
                    max_request_bytes: 16_384,
                    max_result_bytes: 40,
                },
            }],
            budgets: SensitiveBudgets {
                max_runs: 2,
                max_effects: 2,
                max_lease_s: 30,
                max_wall_ms: 1_000,
                max_cpu_ms: 800,
                max_rss_bytes: 1_048_576,
                max_io_read_bytes: 100,
                max_io_write_bytes: 100,
                max_scratch_bytes: 2_048,
            },
            classifier: SensitiveClassifierPolicy::Required {
                trust_domain: ClassifierTrustDomain::ApprovedProvider,
                profile_id: "classifier-profile-v1".into(),
                model_ref: "provider/model-v1".into(),
                policy_sha256: HASH_A.into(),
                timeout_ms: 1_000,
                max_source_bytes: 4_096,
                max_effect_bytes: 4_096,
            },
            persistence: SensitivePersistencePolicy {
                guest_persistence: GuestPersistence::Disabled,
                max_artifacts: 2,
                max_total_artifact_bytes: 50,
            },
        };
        let policy =
            CanonicalSensitivePolicy::parse(&policy_value.canonical_bytes().unwrap()).unwrap();
        let request_value = SensitiveEffectRequestV1 {
            version: SENSITIVE_EFFECT_REQUEST_VERSION,
            effect: SensitiveEffectV1::ArtifactExport {
                destination_profile_id: "artifact-destination-v1".into(),
                artifact_name: "123e4567-e89b-12d3-a456-426614174000".into(),
                content_sha256: HASH_B.into(),
                content_bytes: 20,
                max_result_bytes: 30,
            },
        };
        let request =
            CanonicalSensitiveEffectRequest::parse(&request_value.canonical_bytes().unwrap())
                .unwrap();
        (policy, registry, request)
    }

    fn classified_session(
        fixture: &mut Fixture,
        grant_id: &str,
    ) -> (
        SensitiveSession,
        CanonicalSensitiveProfileRegistry,
        CanonicalSensitiveEffectRequest,
    ) {
        let (policy, registry, request) = classified_inputs();
        let policy_sha256 = policy.policy_sha256().to_owned();
        let (_, active) = admit(&mut fixture.ledger, grant_id, 1, &policy_sha256, NOW + 60);
        let session = fixture
            .ledger
            .begin_sensitive_session(active, policy)
            .unwrap();
        (session, registry, request)
    }

    fn narrowing_evidence(
        session: &SensitiveSession,
        effect_request_sha256: &str,
        issuer_seq: u64,
        outcome: NarrowingOutcomeV1,
        issued_at_unix_s: u64,
        expires_at_unix_s: u64,
        session_binding_override: Option<&str>,
    ) -> AuthenticatedNarrowingPermit {
        let session_binding_sha256 = session_binding_override
            .map(str::to_owned)
            .unwrap_or_else(|| encode_lower_hex(&session.binding));
        let binding = NarrowingPermitBinding {
            grant_id: session.active_grant.grant.grant_id.clone(),
            grant_payload_sha256: encode_lower_hex(&session.active_grant.payload_sha256),
            session_binding_sha256,
            effect_request_sha256: effect_request_sha256.into(),
            policy_sha256: session.policy.policy_sha256().into(),
            classifier_model_ref: "provider/model-v1".into(),
            classifier_policy_sha256: HASH_A.into(),
        };
        let permit = NarrowingPermitV1 {
            version: NARROWING_PERMIT_VERSION,
            permit_id: format!("permit-{issuer_seq}"),
            issuer_id: "operator-1".into(),
            issuer_seq,
            executor_id: "executor-1".into(),
            policy_epoch: 3,
            grant_id: binding.grant_id.clone(),
            grant_payload_sha256: binding.grant_payload_sha256.clone(),
            session_binding_sha256: binding.session_binding_sha256.clone(),
            effect_request_sha256: binding.effect_request_sha256.clone(),
            policy_sha256: binding.policy_sha256.clone(),
            classifier_model_ref: binding.classifier_model_ref.clone(),
            classifier_policy_sha256: binding.classifier_policy_sha256.clone(),
            outcome,
            issued_at_unix_s,
            expires_at_unix_s,
            nonce: NONCE.into(),
        };
        let payload = permit.canonical_payload().unwrap();
        let signature = key().sign(&narrowing_permit_signature_input(&payload).unwrap());
        NarrowingPermitVerifier::new(
            "operator-1",
            key().public_key().as_ref(),
            "executor-1",
            3,
            900,
        )
        .unwrap()
        .authenticate(&payload, signature.as_ref(), &binding)
        .unwrap()
    }

    #[test]
    fn classifier_allow_mints_exact_authorized_dimensions_and_replay_revokes() {
        let mut fixture = fixture(true);
        let (mut session, registry, request) =
            classified_session(&mut fixture, "grant-classifier-allow");
        let run = session.mint_run_permit(run_reservation()).unwrap();
        let authorization =
            authorize_sensitive_effect(&session.policy, &registry, &request).unwrap();
        let expected = authorization.dimensions();
        let evidence = narrowing_evidence(
            &session,
            authorization.request_sha256(),
            1,
            NarrowingOutcomeV1::Allow,
            NOW,
            NOW + 10,
            None,
        );
        let replay = evidence.clone();
        let effect = session
            .admit_classifier_narrowing(&run, authorization, evidence)
            .unwrap();
        assert_eq!(effect.reservation().capability_index, 0);
        assert_eq!(effect.reservation().request_bytes, expected.request_bytes);
        assert_eq!(effect.reservation().artifact_bytes, expected.artifact_bytes);
        assert_eq!(session.last_narrowing_issuer_seq(), 1);
        assert!(!session.classifier_flagged());

        let replay_authorization =
            authorize_sensitive_effect(&session.policy, &registry, &request).unwrap();
        assert_eq!(
            session.admit_classifier_narrowing(&run, replay_authorization, replay),
            Err(SensitiveAuthorityRevoked)
        );
        assert_eq!(session.last_narrowing_issuer_seq(), 1);
        assert_eq!(
            session.terminal_reason(),
            Some(SensitiveSessionTerminalReason::Unavailable)
        );
    }

    #[test]
    fn caller_authenticated_wrong_binding_is_rederived_and_terminal() {
        let mut fixture = fixture(true);
        let (mut session, registry, request) =
            classified_session(&mut fixture, "grant-classifier-binding");
        let run = session.mint_run_permit(run_reservation()).unwrap();
        let authorization =
            authorize_sensitive_effect(&session.policy, &registry, &request).unwrap();
        let evidence = narrowing_evidence(
            &session,
            authorization.request_sha256(),
            1,
            NarrowingOutcomeV1::Allow,
            NOW,
            NOW + 10,
            Some(HASH_D),
        );
        assert_eq!(
            session.admit_classifier_narrowing(&run, authorization, evidence),
            Err(SensitiveAuthorityRevoked)
        );
        assert_eq!(session.last_narrowing_issuer_seq(), 0);
        assert!(!session.classifier_flagged());
        assert_eq!(
            session.terminal_reason(),
            Some(SensitiveSessionTerminalReason::Unavailable)
        );
    }

    #[test]
    fn higher_sequence_permit_for_another_request_cannot_cross_authorization() {
        let mut fixture = fixture(true);
        let (mut session, registry, request) =
            classified_session(&mut fixture, "grant-classifier-request");
        let run = session.mint_run_permit(run_reservation()).unwrap();
        let authorization =
            authorize_sensitive_effect(&session.policy, &registry, &request).unwrap();
        let evidence = narrowing_evidence(
            &session,
            HASH_D,
            99,
            NarrowingOutcomeV1::Allow,
            NOW,
            NOW + 10,
            None,
        );
        assert_eq!(
            session.admit_classifier_narrowing(&run, authorization, evidence),
            Err(SensitiveAuthorityRevoked)
        );
        assert_eq!(session.last_narrowing_issuer_seq(), 0);
        assert_eq!(
            session.terminal_reason(),
            Some(SensitiveSessionTerminalReason::Unavailable)
        );
    }

    #[test]
    fn flag_and_revoke_advance_sequence_before_generic_closure() {
        for (grant_id, outcome, flagged) in [
            ("grant-classifier-revoke", NarrowingOutcomeV1::Revoke, false),
            ("grant-classifier-flag", NarrowingOutcomeV1::Flag, true),
        ] {
            let mut fixture = fixture(true);
            let (mut session, registry, request) = classified_session(&mut fixture, grant_id);
            let run = session.mint_run_permit(run_reservation()).unwrap();
            let authorization =
                authorize_sensitive_effect(&session.policy, &registry, &request).unwrap();
            let evidence = narrowing_evidence(
                &session,
                authorization.request_sha256(),
                7,
                outcome,
                NOW,
                NOW + 10,
                None,
            );
            assert_eq!(
                session.admit_classifier_narrowing(&run, authorization, evidence),
                Err(SensitiveAuthorityRevoked)
            );
            assert_eq!(session.last_narrowing_issuer_seq(), 7);
            assert_eq!(session.classifier_flagged(), flagged);
            assert_eq!(
                session.terminal_reason(),
                Some(SensitiveSessionTerminalReason::Unavailable)
            );
        }
    }

    #[test]
    fn expired_and_unavailable_classifier_paths_are_generic_and_unflagged() {
        let mut expired_fixture = fixture(true);
        let (mut session, registry, request) =
            classified_session(&mut expired_fixture, "grant-classifier-expired");
        let run = session.mint_run_permit(run_reservation()).unwrap();
        let authorization =
            authorize_sensitive_effect(&session.policy, &registry, &request).unwrap();
        let evidence = narrowing_evidence(
            &session,
            authorization.request_sha256(),
            1,
            NarrowingOutcomeV1::Allow,
            NOW - 10,
            NOW,
            None,
        );
        assert_eq!(
            session.admit_classifier_narrowing(&run, authorization, evidence),
            Err(SensitiveAuthorityRevoked)
        );
        assert!(!session.classifier_flagged());

        let mut unavailable_fixture = fixture(true);
        let (mut session, _, _) =
            classified_session(&mut unavailable_fixture, "grant-classifier-unavailable");
        assert_eq!(
            session.classifier_unavailable::<()>(),
            Err(SensitiveAuthorityRevoked)
        );
        assert!(!session.classifier_flagged());
        assert_eq!(
            session.terminal_reason(),
            Some(SensitiveSessionTerminalReason::Unavailable)
        );
    }

    #[test]
    fn cold_reopen_interrupts_unsettled_session_and_fences_stale_authority() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut fixture.ledger,
            "grant-restart-interrupted",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let stale = duplicate_active(&active);
        let session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        let path = fixture.ledger.path().to_path_buf();
        drop(session);
        drop(fixture.ledger);

        let reopened = GrantLedger::open_with_terminal_control_verifier_and_clock(
            &path,
            verifier(),
            control_verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        assert_eq!(
            reopened
                .terminal_receipt("grant-restart-interrupted")
                .unwrap()
                .unwrap()
                .kind(),
            crate::GrantTerminalKind::Interrupted
        );
        let (_, canonical) = policy();
        assert!(matches!(
            reopened.begin_sensitive_session(stale, canonical),
            Err(SensitiveSessionDenied::Unavailable)
        ));
    }

    #[test]
    fn flag_and_clear_survive_restart_without_resurrecting_session() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let policy_hash = lower_hex_hash(&policy_sha256).unwrap();
        let (grant, active) = admit(
            &mut fixture.ledger,
            "grant-clear-no-resurrection",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let stale = duplicate_active(&active);
        let session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        let (payload, signature) = terminal_control("flag-before-restart", 2, &grant, true);
        let request = fixture
            .ledger
            .admit_terminal_control_for_sensitive_session(&payload, &signature, session)
            .unwrap();
        assert_eq!(request.control_receipt().latch_event_seq(), Some(1));
        let path = fixture.ledger.path().to_path_buf();
        drop(request);
        drop(fixture.ledger);

        let mut reopened = GrantLedger::open_with_terminal_control_verifier_and_clock(
            &path,
            verifier(),
            control_verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        assert_eq!(
            reopened
                .terminal_receipt("grant-clear-no-resurrection")
                .unwrap()
                .unwrap()
                .kind(),
            crate::GrantTerminalKind::Flagged
        );
        assert!(
            reopened
                .policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash)
                .unwrap()
        );
        let (payload, signature) = clear_control("wrong-clear-after-restart", 3, HASH_A);
        assert!(matches!(
            reopened.admit_terminal_control(&payload, &signature),
            Err(crate::GrantLedgerError::PolicyLatchNotFlagged)
        ));
        assert!(
            reopened
                .policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash)
                .unwrap()
        );
        let (payload, signature) = clear_control("clear-after-restart", 3, &policy_sha256);
        let clear = reopened
            .admit_terminal_control(&payload, &signature)
            .unwrap();
        assert_eq!(clear.latch_event_seq(), Some(2));
        assert!(
            !reopened
                .policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash)
                .unwrap()
        );
        let (_, canonical) = policy();
        assert!(matches!(
            reopened.begin_sensitive_session(stale, canonical),
            Err(SensitiveSessionDenied::Unavailable)
        ));
        drop(reopened);

        let reopened = GrantLedger::open_with_terminal_control_verifier_and_clock(
            &path,
            verifier(),
            control_verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        assert_eq!(
            reopened
                .terminal_receipt("grant-clear-no-resurrection")
                .unwrap()
                .unwrap()
                .kind(),
            crate::GrantTerminalKind::Flagged
        );
        assert!(
            !reopened
                .policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash)
                .unwrap()
        );
        let counts: (i64, i64, i64) = reopened
            .connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM terminal_control_receipts),
                    (SELECT COUNT(*) FROM grant_terminal_events),
                    (SELECT COUNT(*) FROM policy_latch_events)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (2, 1, 2));
    }

    #[test]
    fn competing_stale_sessions_produce_one_terminal_event_and_one_request() {
        let mut fixture = fixture(true);
        let (_, canonical_one) = policy();
        let policy_sha256 = canonical_one.policy_sha256().to_owned();
        let (grant, active) = admit(
            &mut fixture.ledger,
            "grant-stale-session-race",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let duplicate = duplicate_active(&active);
        let session_one = fixture
            .ledger
            .begin_sensitive_session(active, canonical_one)
            .unwrap();
        let (_, canonical_two) = policy();
        let session_two = fixture
            .ledger
            .begin_sensitive_session(duplicate, canonical_two)
            .unwrap();
        let (revoke_payload, revoke_signature) = terminal_control("race-revoke", 2, &grant, false);
        let request = fixture
            .ledger
            .admit_terminal_control_for_sensitive_session(
                &revoke_payload,
                &revoke_signature,
                session_one,
            )
            .unwrap();
        assert_eq!(
            request.terminal_receipt().kind(),
            crate::GrantTerminalKind::Revoked
        );
        let (flag_payload, flag_signature) = terminal_control("race-flag", 3, &grant, true);
        assert!(matches!(
            fixture.ledger.admit_terminal_control_for_sensitive_session(
                &flag_payload,
                &flag_signature,
                session_two,
            ),
            Err(crate::GrantLedgerError::ControlTargetAlreadyTerminal)
        ));
        let durable: (i64, i64, i64, Vec<u8>) = fixture
            .ledger
            .connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM terminal_control_receipts),
                    (SELECT COUNT(*) FROM grant_terminal_events),
                    (SELECT COUNT(*) FROM policy_latch_events),
                    last_issuer_seq
                 FROM grant_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((durable.0, durable.1, durable.2), (1, 1, 0));
        assert_eq!(
            super::super::decode_u64(durable.3, "test sequence").unwrap(),
            2
        );
    }

    #[test]
    fn integrated_revoke_atomically_settles_exact_session_and_returns_request() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (grant, active) = admit(
            &mut fixture.ledger,
            "grant-integrated-revoke",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        let (payload, signature) = terminal_control("revoke-session", 2, &grant, false);

        let request = fixture
            .ledger
            .admit_terminal_control_for_sensitive_session(&payload, &signature, session)
            .unwrap();
        assert_eq!(request.executor_id(), "executor-1");
        assert_eq!(request.grant_id(), "grant-integrated-revoke");
        assert_eq!(request.control_receipt().receipt_seq(), 1);
        assert_eq!(request.control_receipt().latch_event_seq(), None);
        assert_eq!(
            request.terminal_receipt().kind(),
            crate::GrantTerminalKind::Revoked
        );
        assert_eq!(request.terminal_receipt().event_seq(), 1);
        assert_eq!(
            fixture
                .ledger
                .terminal_receipt("grant-integrated-revoke")
                .unwrap()
                .unwrap(),
            request.terminal_receipt().clone()
        );
        let durable_sequence = fixture
            .ledger
            .connection
            .query_row(
                "SELECT last_issuer_seq FROM grant_state WHERE singleton = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .unwrap();
        assert_eq!(
            super::super::decode_u64(durable_sequence, "test sequence").unwrap(),
            2
        );
    }

    #[test]
    fn integrated_flag_persists_exact_canonical_policy_and_latches() {
        let mut fixture = fixture(true);
        let (policy_bytes, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (grant, active) = admit(
            &mut fixture.ledger,
            "grant-integrated-flag",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        let (payload, signature) = terminal_control("flag-session", 2, &grant, true);

        let request = fixture
            .ledger
            .admit_terminal_control_for_sensitive_session(&payload, &signature, session)
            .unwrap();
        assert_eq!(request.control_receipt().latch_event_seq(), Some(1));
        assert_eq!(
            request.terminal_receipt().kind(),
            crate::GrantTerminalKind::Flagged
        );
        let stored: (String, Vec<u8>, Vec<u8>) = fixture
            .ledger
            .connection
            .query_row(
                "SELECT profile_id, policy_sha256, policy_bytes
                 FROM policy_latch_events WHERE event_seq = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored.0, "sensitive-v1");
        // The latch is bound to the session policy, while the terminal receipt is bound
        // independently to the exact admitted grant payload.
        assert_eq!(
            stored.1.as_slice(),
            lower_hex_hash(&policy_sha256).unwrap().as_slice()
        );
        assert_eq!(stored.2, policy_bytes);
        assert!(
            fixture
                .ledger
                .policy_latch_is_set(
                    "executor-1",
                    "sensitive-v1",
                    &lower_hex_hash(&policy_sha256).unwrap(),
                )
                .unwrap()
        );
        super::super::validate_latch_integrity(
            &fixture.ledger.connection,
            GrantLedgerLimits::default(),
        )
        .unwrap();
    }

    #[test]
    fn integrated_flag_late_write_failure_leaves_no_receipt_only_gap() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (grant, active) = admit(
            &mut fixture.ledger,
            "grant-atomic-flag",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        fixture
            .ledger
            .connection
            .execute_batch(
                "CREATE TRIGGER test_reject_flag_latch
                 BEFORE INSERT ON policy_latch_events WHEN NEW.kind = 'flag'
                 BEGIN SELECT RAISE(ABORT, 'synthetic late flag failure'); END;",
            )
            .unwrap();
        let (payload, signature) = terminal_control("atomic-flag", 2, &grant, true);

        assert!(matches!(
            fixture
                .ledger
                .admit_terminal_control_for_sensitive_session(&payload, &signature, session,),
            Err(crate::GrantLedgerError::Sql(_))
        ));
        let durable: (i64, i64, i64, Vec<u8>) = fixture
            .ledger
            .connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM terminal_control_receipts),
                    (SELECT COUNT(*) FROM grant_terminal_events),
                    (SELECT COUNT(*) FROM policy_latch_events),
                    last_issuer_seq
                 FROM grant_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((durable.0, durable.1, durable.2), (0, 0, 0));
        assert_eq!(
            super::super::decode_u64(durable.3, "test sequence").unwrap(),
            1
        );
    }

    #[test]
    fn integrated_control_requires_live_session_and_rolls_back() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (grant, active) = admit(
            &mut fixture.ledger,
            "grant-expired-control",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let mut session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        session.clock = SessionClock::Fixed(NOW + 60);
        let (payload, signature) = terminal_control("expired-session", 2, &grant, false);

        assert!(matches!(
            fixture
                .ledger
                .admit_terminal_control_for_sensitive_session(&payload, &signature, session,),
            Err(crate::GrantLedgerError::SensitiveSessionUnavailable)
        ));
        let durable: (i64, i64, i64, Vec<u8>) = fixture
            .ledger
            .connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM terminal_control_receipts),
                    (SELECT COUNT(*) FROM grant_terminal_events),
                    (SELECT COUNT(*) FROM policy_latch_events),
                    last_issuer_seq
                 FROM grant_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((durable.0, durable.1, durable.2), (0, 0, 0));
        assert_eq!(
            super::super::decode_u64(durable.3, "test sequence").unwrap(),
            1
        );
    }

    #[test]
    fn integrated_target_mismatch_rolls_back_every_receipt_and_sequence() {
        let mut fixture = fixture(true);
        let (_, policy_one) = policy();
        let policy_sha256 = policy_one.policy_sha256().to_owned();
        let (_, active_one) = admit(
            &mut fixture.ledger,
            "grant-session-target",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let (other_grant, _) = admit(
            &mut fixture.ledger,
            "grant-control-target",
            2,
            &policy_sha256,
            NOW + 60,
        );
        let session = fixture
            .ledger
            .begin_sensitive_session(active_one, policy_one)
            .unwrap();
        let (payload, signature) = terminal_control("wrong-exact-target", 3, &other_grant, false);

        assert!(matches!(
            fixture
                .ledger
                .admit_terminal_control_for_sensitive_session(&payload, &signature, session,),
            Err(crate::GrantLedgerError::ControlTargetMismatch)
        ));
        let counts: (i64, i64, i64) = fixture
            .ledger
            .connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM terminal_control_receipts),
                    (SELECT COUNT(*) FROM grant_terminal_events),
                    (SELECT COUNT(*) FROM policy_latch_events)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0));
        let (_, replacement) = admit(
            &mut fixture.ledger,
            "grant-sequence-not-consumed",
            3,
            &policy_sha256,
            NOW + 60,
        );
        fixture.ledger.revoke(replacement).unwrap();
    }

    #[test]
    fn exact_session_mints_bound_permits_and_reserves_every_budget() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut fixture.ledger,
            "grant-session",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let mut session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        assert_eq!(session.grant_id(), "grant-session");
        assert_eq!(session.executor_id(), "executor-1");
        assert_eq!(session.profile_id(), "sensitive-v1");
        assert_eq!(session.lease_deadline_unix_s(), NOW + 30);
        let debug = format!("{session:?}");
        assert!(!debug.contains("artifact-destination-v1"));
        assert!(!debug.contains(HASH_D));

        let run = session.mint_run_permit(run_reservation()).unwrap();
        assert_eq!(run.run_index(), 1);
        assert_eq!(run.reservation(), run_reservation());
        assert_eq!(
            session
                .mint_run_permit(run_reservation())
                .unwrap()
                .run_index(),
            2
        );

        let first_reservation = reservation(60, 30, 20);
        let first = session.mint_effect_permit(&run, first_reservation).unwrap();
        assert_eq!(first.run_index(), 1);
        assert_eq!(first.effect_index(), 1);
        assert_eq!(first.reservation(), first_reservation);

        let mut invalid_per_call = reservation(1, 1, 1);
        invalid_per_call.request_bytes = 31;
        assert_eq!(
            session.mint_effect_permit(&run, invalid_per_call),
            Err(SensitiveSessionDenied::BudgetDenied)
        );
        assert_eq!(session.effects_used(), 1);
        assert_eq!(session.terminal_reason(), None);

        let second = session
            .mint_effect_permit(&run, reservation(40, 70, 30))
            .unwrap();
        assert_eq!(second.effect_index(), 2);
        assert_eq!(session.effects_used(), 2);
        assert_eq!(session.terminal_reason(), None);
    }

    #[test]
    fn cumulative_denial_latches_and_settles_interrupted_once() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut fixture.ledger,
            "grant-budget-terminal",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let mut session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        session.mint_run_permit(run_reservation()).unwrap();
        let mut cumulative_overdraw = run_reservation();
        cumulative_overdraw.max_wall_ms += 1;
        assert_eq!(
            session.mint_run_permit(cumulative_overdraw),
            Err(SensitiveSessionDenied::BudgetDenied)
        );
        assert_eq!(
            session.terminal_reason(),
            Some(SensitiveSessionTerminalReason::BudgetExhausted)
        );
        assert_eq!(
            session.mint_run_permit(run_reservation()),
            Err(SensitiveSessionDenied::BudgetDenied)
        );
        let receipt = fixture.ledger.finish_sensitive_session(session).unwrap();
        assert_eq!(receipt.kind(), crate::GrantTerminalKind::Interrupted);
        assert_eq!(receipt.grant_id(), "grant-budget-terminal");
    }

    #[test]
    fn durable_terminal_receipt_wins_against_duplicated_test_authority() {
        let mut fixture = fixture(true);
        let (_, policy_one) = policy();
        let policy_sha256 = policy_one.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut fixture.ledger,
            "grant-exact-once",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let duplicate = ActiveGrant {
            grant: active.grant.clone(),
            payload_sha256: active.payload_sha256,
            ledger_binding: active.ledger_binding,
        };
        let session_one = fixture
            .ledger
            .begin_sensitive_session(active, policy_one)
            .unwrap();
        let (_, policy_two) = policy();
        let session_two = fixture
            .ledger
            .begin_sensitive_session(duplicate, policy_two)
            .unwrap();
        fixture
            .ledger
            .finish_sensitive_session(session_one)
            .unwrap();
        assert!(matches!(
            fixture.ledger.finish_sensitive_session(session_two),
            Err(crate::GrantLedgerError::AlreadyTerminal)
        ));
        assert_eq!(
            fixture
                .ledger
                .terminal_receipt("grant-exact-once")
                .unwrap()
                .unwrap()
                .kind(),
            crate::GrantTerminalKind::Completed
        );
    }

    #[test]
    fn live_session_finishes_completed() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut fixture.ledger,
            "grant-completed-session",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        let receipt = fixture.ledger.finish_sensitive_session(session).unwrap();
        assert_eq!(receipt.kind(), crate::GrantTerminalKind::Completed);
        assert_eq!(receipt.grant_id(), "grant-completed-session");
    }

    #[test]
    fn denied_effect_reservations_do_not_consume_capacity() {
        let mut fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut fixture.ledger,
            "grant-capacity",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let mut session = fixture
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        let run = session.mint_run_permit(run_reservation()).unwrap();
        let mut too_large = reservation(1, 1, 1);
        too_large.request_bytes = 31;
        assert_eq!(
            session.mint_effect_permit(&run, too_large),
            Err(SensitiveSessionDenied::BudgetDenied)
        );
        let mut malformed_artifact = reservation(1, 1, 0);
        malformed_artifact.artifact_count = 1;
        assert_eq!(
            session.mint_effect_permit(&run, malformed_artifact),
            Err(SensitiveSessionDenied::BudgetDenied)
        );
        assert_eq!(session.effects_used(), 0);
        assert_eq!(
            session
                .mint_effect_permit(&run, reservation(1, 1, 1))
                .unwrap()
                .effect_index(),
            1
        );
    }

    #[test]
    fn run_permit_is_bound_to_one_exact_session() {
        let mut fixture = fixture(true);
        let (_, policy_one) = policy();
        let policy_sha256 = policy_one.policy_sha256().to_owned();
        let (_, active_one) = admit(
            &mut fixture.ledger,
            "grant-one",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let (_, active_two) = admit(
            &mut fixture.ledger,
            "grant-two",
            2,
            &policy_sha256,
            NOW + 60,
        );
        let mut session_one = fixture
            .ledger
            .begin_sensitive_session(active_one, policy_one)
            .unwrap();
        let (_, policy_two) = policy();
        let mut session_two = fixture
            .ledger
            .begin_sensitive_session(active_two, policy_two)
            .unwrap();
        let run_one = session_one.mint_run_permit(run_reservation()).unwrap();
        assert_eq!(
            session_two.mint_effect_permit(&run_one, reservation(1, 1, 1)),
            Err(SensitiveSessionDenied::BudgetDenied)
        );
        assert_eq!(session_two.effects_used(), 0);
    }

    #[test]
    fn policy_mismatch_wrong_ledger_and_missing_latch_custody_fail_closed() {
        let mut policy_fixture = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut policy_fixture.ledger,
            "grant-policy",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let mut different = canonical.policy().clone();
        different.profile_id = "different-profile".into();
        let bytes = different.canonical_bytes().unwrap();
        let different = CanonicalSensitivePolicy::parse(&bytes).unwrap();
        assert!(matches!(
            policy_fixture
                .ledger
                .begin_sensitive_session(active, different),
            Err(SensitiveSessionDenied::PolicyDenied)
        ));

        let mut first = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut first.ledger,
            "grant-wrong-ledger",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let second = fixture(true);
        assert!(matches!(
            second.ledger.begin_sensitive_session(active, canonical),
            Err(SensitiveSessionDenied::Unavailable)
        ));

        let mut terminal = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut terminal.ledger,
            "grant-terminal",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let duplicate = ActiveGrant {
            grant: active.grant.clone(),
            payload_sha256: active.payload_sha256,
            ledger_binding: active.ledger_binding,
        };
        terminal.ledger.complete(active).unwrap();
        assert!(matches!(
            terminal
                .ledger
                .begin_sensitive_session(duplicate, canonical),
            Err(SensitiveSessionDenied::Unavailable)
        ));

        let mut missing = fixture(false);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut missing.ledger,
            "grant-no-control-custody",
            1,
            &policy_sha256,
            NOW + 60,
        );
        assert!(matches!(
            missing.ledger.begin_sensitive_session(active, canonical),
            Err(SensitiveSessionDenied::Unavailable)
        ));
    }

    #[test]
    fn exact_flagged_policy_and_expired_lease_deny_permits() {
        let mut latch_fixture = fixture(true);
        let (policy_bytes, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (grant, active) = admit(
            &mut latch_fixture.ledger,
            "grant-latched",
            1,
            &policy_sha256,
            NOW + 60,
        );
        let grant_payload = grant.canonical_payload().unwrap();
        let grant_payload_sha256: String = sha256(&grant_payload)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let control = TerminalControlV1 {
            version: elpis_grants::TERMINAL_CONTROL_VERSION,
            control_id: "control-flag".into(),
            issuer_id: "operator-1".into(),
            issuer_seq: 2,
            executor_id: "executor-1".into(),
            policy_epoch: 3,
            target: TerminalControlActionV1::FlagGrant {
                grant_id: grant.grant_id.clone(),
                grant_payload_sha256,
            },
            issued_at_unix_s: NOW,
            expires_at_unix_s: NOW + 300,
            nonce: NONCE.into(),
        };
        let control_payload = control.canonical_payload().unwrap();
        let signature = key().sign(&terminal_control_signature_input(&control_payload).unwrap());
        latch_fixture
            .ledger
            .admit_terminal_control(&control_payload, signature.as_ref())
            .unwrap();
        latch_fixture
            .ledger
            .connection
            .execute(
                "INSERT INTO policy_latch_events (
                    event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                    kind, grant_id, control_id, occurred_at_unix_s
                 ) VALUES (1, 'executor-1', 'sensitive-v1', ?1, ?2, 'flag',
                           'grant-latched', 'control-flag', ?3)",
                params![
                    lower_hex_hash(&policy_sha256).unwrap().as_slice(),
                    policy_bytes,
                    u64_blob(NOW).as_slice()
                ],
            )
            .unwrap();
        assert!(matches!(
            latch_fixture
                .ledger
                .begin_sensitive_session(active, canonical),
            Err(SensitiveSessionDenied::PolicyLatched)
        ));

        let mut rollback = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut rollback.ledger,
            "grant-clock-rollback",
            1,
            &policy_sha256,
            NOW + 60,
        );
        rollback.ledger.clock = Clock::Fixed(NOW - 1);
        assert!(matches!(
            rollback.ledger.begin_sensitive_session(active, canonical),
            Err(SensitiveSessionDenied::LeaseEnded)
        ));

        let mut expiry = fixture(true);
        let (_, canonical) = policy();
        let policy_sha256 = canonical.policy_sha256().to_owned();
        let (_, active) = admit(
            &mut expiry.ledger,
            "grant-expiry",
            1,
            &policy_sha256,
            NOW + 10,
        );
        let mut session = expiry
            .ledger
            .begin_sensitive_session(active, canonical)
            .unwrap();
        assert_eq!(session.lease_deadline_unix_s(), NOW + 10);
        session.clock = SessionClock::Fixed(NOW + 10);
        assert_eq!(
            session.mint_run_permit(run_reservation()),
            Err(SensitiveSessionDenied::LeaseEnded)
        );
        assert_eq!(
            session.terminal_reason(),
            Some(SensitiveSessionTerminalReason::LeaseEnded)
        );
        let receipt = expiry.ledger.finish_sensitive_session(session).unwrap();
        assert_eq!(receipt.kind(), crate::GrantTerminalKind::Expired);
    }
}
