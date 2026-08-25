use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use elpis_identity::{CredentialMetadata, IdentityStore};
use elpis_journal::Journal;
use ring::rand::{SecureRandom, SystemRandom};
use thiserror::Error;

use crate::{DeferredDispatcher, LinkConfig, LinkError, Session, SessionEvent};

const MAX_SUPERVISOR_DURATION: Duration = Duration::from_secs(60 * 60);
const MAX_BACKOFF_DURATION: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackoffPolicy {
    base: Duration,
    maximum: Duration,
    jitter_percent: u8,
}

impl BackoffPolicy {
    pub fn new(
        base: Duration,
        maximum: Duration,
        jitter_percent: u8,
    ) -> Result<Self, SupervisorError> {
        if base.is_zero() || maximum < base || maximum > MAX_BACKOFF_DURATION || jitter_percent > 50
        {
            return Err(SupervisorError::InvalidConfiguration);
        }
        Ok(Self {
            base,
            maximum,
            jitter_percent,
        })
    }

    pub fn delay(&self, attempt: u32, entropy: u64) -> Duration {
        let factor = 1_u128 << attempt.min(63);
        let capped = self
            .base
            .as_nanos()
            .saturating_mul(factor)
            .min(self.maximum.as_nanos());
        let jitter = capped.saturating_mul(u128::from(self.jitter_percent)) / 100;
        let lower = capped - jitter;
        let upper = capped.saturating_add(jitter).min(self.maximum.as_nanos());
        let width = upper - lower + 1;
        let offset = u128::from(entropy) % width;
        duration_from_nanos(lower + offset)
    }

    pub fn base(&self) -> Duration {
        self.base
    }

    pub fn maximum(&self) -> Duration {
        self.maximum
    }

    pub fn jitter_percent(&self) -> u8 {
        self.jitter_percent
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorConfig {
    link: LinkConfig,
    heartbeat_interval: Duration,
    server_silence_timeout: Duration,
    credential_poll_interval: Duration,
    stable_connection: Duration,
    backoff: BackoffPolicy,
}

impl SupervisorConfig {
    pub fn new(
        link: LinkConfig,
        heartbeat_interval: Duration,
        server_silence_timeout: Duration,
        credential_poll_interval: Duration,
        stable_connection: Duration,
        backoff: BackoffPolicy,
    ) -> Result<Self, SupervisorError> {
        if heartbeat_interval.is_zero()
            || server_silence_timeout <= heartbeat_interval
            || credential_poll_interval.is_zero()
            || stable_connection.is_zero()
            || heartbeat_interval > MAX_SUPERVISOR_DURATION
            || server_silence_timeout > MAX_SUPERVISOR_DURATION
            || credential_poll_interval > MAX_SUPERVISOR_DURATION
            || stable_connection > MAX_SUPERVISOR_DURATION
            || link.io_timeout() > heartbeat_interval
            || link.io_timeout() > credential_poll_interval
            || link.io_timeout() > server_silence_timeout
        {
            return Err(SupervisorError::InvalidConfiguration);
        }
        Ok(Self {
            link,
            heartbeat_interval,
            server_silence_timeout,
            credential_poll_interval,
            stable_connection,
            backoff,
        })
    }

    pub fn link(&self) -> &LinkConfig {
        &self.link
    }

    pub fn heartbeat_interval(&self) -> Duration {
        self.heartbeat_interval
    }

    pub fn server_silence_timeout(&self) -> Duration {
        self.server_silence_timeout
    }

    pub fn credential_poll_interval(&self) -> Duration {
        self.credential_poll_interval
    }

    pub fn stable_connection(&self) -> Duration {
        self.stable_connection
    }

    pub fn backoff(&self) -> BackoffPolicy {
        self.backoff
    }
}

#[derive(Clone, Default)]
pub struct DrainSignal {
    inner: Arc<DrainState>,
}

#[derive(Default)]
struct DrainState {
    requested: AtomicBool,
    mutex: Mutex<()>,
    changed: Condvar,
}

impl fmt::Debug for DrainSignal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DrainSignal")
            .field("requested", &self.is_requested())
            .finish()
    }
}

impl DrainSignal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request(&self) {
        self.inner.requested.store(true, Ordering::Release);
        self.inner.changed.notify_all();
    }

    pub fn is_requested(&self) -> bool {
        self.inner.requested.load(Ordering::Acquire)
    }

    fn wait(&self, duration: Duration) -> bool {
        if self.is_requested() {
            return true;
        }
        let guard = self
            .inner
            .mutex
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = self
            .inner
            .changed
            .wait_timeout_while(guard, duration, |_| !self.is_requested())
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.is_requested()
    }
}

pub struct Supervisor {
    config: SupervisorConfig,
    boot_epoch: String,
    drain: DrainSignal,
}

impl Supervisor {
    pub fn new(
        config: SupervisorConfig,
        boot_epoch: impl Into<String>,
        drain: DrainSignal,
    ) -> Result<Self, SupervisorError> {
        let boot_epoch = boot_epoch.into();
        if boot_epoch.len() != 32
            || !boot_epoch
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(SupervisorError::InvalidConfiguration);
        }
        Ok(Self {
            config,
            boot_epoch,
            drain,
        })
    }

    pub fn boot_epoch(&self) -> &str {
        &self.boot_epoch
    }

    pub fn drain_signal(&self) -> DrainSignal {
        self.drain.clone()
    }

    pub fn run(
        &self,
        identity: &IdentityStore,
        journal: &mut Journal,
        dispatcher: &mut impl DeferredDispatcher,
    ) -> Result<SupervisorExit, SupervisorError> {
        let mut attempt = 0_u32;
        loop {
            if self.drain.is_requested() {
                return Ok(SupervisorExit::Drained);
            }
            if dispatcher.has_pending() {
                return Err(SupervisorError::Link(LinkError::StateMismatch));
            }
            let credential = current_credential(identity)?;
            let session = Session::connect(&self.config.link, identity, journal, &self.boot_epoch);
            let mut session = match session {
                Ok(session) => session,
                Err(error) => match classify_link_error(error) {
                    LinkDisposition::Retry => {
                        self.wait_backoff(attempt)?;
                        attempt = attempt.saturating_add(1);
                        continue;
                    }
                    LinkDisposition::Credentials => {
                        return Err(SupervisorError::CredentialsUnavailable);
                    }
                    LinkDisposition::Fatal(error) => return Err(SupervisorError::Link(error)),
                },
            };
            let connected_at = Instant::now();
            if current_credential(identity)? != credential {
                let _ = session.close();
                attempt = 0;
                continue;
            }
            match self.run_active(&mut session, identity, journal, dispatcher, &credential) {
                ActiveOutcome::Drained => {
                    let _ = session.close();
                    return Ok(SupervisorExit::Drained);
                }
                ActiveOutcome::Rotated => {
                    if owns_pending(&session, dispatcher) {
                        let _ = session.close();
                        return Err(SupervisorError::Link(LinkError::StateMismatch));
                    }
                    let _ = session.close();
                    attempt = 0;
                }
                ActiveOutcome::CredentialsUnavailable => {
                    let _ = session.close();
                    return Err(SupervisorError::CredentialsUnavailable);
                }
                ActiveOutcome::Retry => {
                    if owns_pending(&session, dispatcher) {
                        let _ = session.close();
                        return Err(SupervisorError::Link(LinkError::StateMismatch));
                    }
                    let stable = connected_at.elapsed() >= self.config.stable_connection;
                    let _ = session.close();
                    if stable {
                        attempt = 0;
                    }
                    self.wait_backoff(attempt)?;
                    attempt = attempt.saturating_add(1);
                }
                ActiveOutcome::Fatal(error) => {
                    let _ = session.close();
                    return Err(SupervisorError::Link(error));
                }
            }
        }
    }

    fn run_active(
        &self,
        session: &mut Session,
        identity: &IdentityStore,
        journal: &mut Journal,
        dispatcher: &mut impl DeferredDispatcher,
        credential: &CredentialMetadata,
    ) -> ActiveOutcome {
        let mut last_server_activity = Instant::now();
        let mut last_heartbeat = Instant::now();
        let mut last_credential_poll = Instant::now();
        loop {
            if self.drain.is_requested() {
                return ActiveOutcome::Drained;
            }
            let now = Instant::now();
            if now.duration_since(last_credential_poll) >= self.config.credential_poll_interval {
                match identity.credential_metadata() {
                    Ok(Some(current)) if &current == credential => {
                        last_credential_poll = now;
                    }
                    Ok(Some(_)) if owns_pending(session, dispatcher) => {
                        return ActiveOutcome::Fatal(LinkError::StateMismatch);
                    }
                    Ok(Some(_)) => return ActiveOutcome::Rotated,
                    Ok(None) | Err(_) => return ActiveOutcome::CredentialsUnavailable,
                }
            }
            if now.duration_since(last_server_activity) >= self.config.server_silence_timeout {
                return retry_or_pending_fatal(owns_pending(session, dispatcher));
            }
            if now.duration_since(last_heartbeat) >= self.config.heartbeat_interval {
                if let Err(error) = session.send_heartbeat(journal) {
                    return active_from_link_error(error, owns_pending(session, dispatcher));
                }
                last_heartbeat = now;
            }
            match session.step(journal, dispatcher) {
                Ok(SessionEvent::Idle) => {}
                Ok(SessionEvent::Closed) => {
                    return retry_or_pending_fatal(owns_pending(session, dispatcher));
                }
                Ok(
                    SessionEvent::Control
                    | SessionEvent::ServerHeartbeat { .. }
                    | SessionEvent::RequestAccepted { .. }
                    | SessionEvent::RequestCompleted {
                        accepted_server_request: true,
                        ..
                    }
                    | SessionEvent::RequestPairCompleted {
                        accepted_server_request: true,
                        ..
                    }
                    | SessionEvent::CompletedResponseResent { .. },
                ) => last_server_activity = Instant::now(),
                Ok(
                    SessionEvent::RequestCompleted {
                        accepted_server_request: false,
                        ..
                    }
                    | SessionEvent::RequestPairCompleted {
                        accepted_server_request: false,
                        ..
                    },
                ) => {}
                Err(error) => {
                    return active_from_link_error(error, owns_pending(session, dispatcher));
                }
            }
        }
    }

    fn wait_backoff(&self, attempt: u32) -> Result<(), SupervisorError> {
        if self.drain.is_requested() {
            return Ok(());
        }
        let mut bytes = [0_u8; 8];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| SupervisorError::EntropyUnavailable)?;
        let delay = self
            .config
            .backoff
            .delay(attempt, u64::from_le_bytes(bytes));
        if self.drain.wait(delay) {
            return Ok(());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorExit {
    Drained,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SupervisorError {
    #[error("invalid supervisor configuration")]
    InvalidConfiguration,
    #[error("identity credentials are unavailable")]
    CredentialsUnavailable,
    #[error("secure entropy is unavailable")]
    EntropyUnavailable,
    #[error("link failed closed: {0}")]
    Link(LinkError),
}

enum ActiveOutcome {
    Drained,
    Rotated,
    CredentialsUnavailable,
    Retry,
    Fatal(LinkError),
}

enum LinkDisposition {
    Retry,
    Credentials,
    Fatal(LinkError),
}

fn current_credential(identity: &IdentityStore) -> Result<CredentialMetadata, SupervisorError> {
    identity
        .credential_metadata()
        .map_err(|_| SupervisorError::CredentialsUnavailable)?
        .ok_or(SupervisorError::CredentialsUnavailable)
}

fn classify_link_error(error: LinkError) -> LinkDisposition {
    match error {
        LinkError::Resolution
        | LinkError::Connection
        | LinkError::Handshake
        | LinkError::Transport => LinkDisposition::Retry,
        LinkError::Identity => LinkDisposition::Credentials,
        error @ (LinkError::InvalidConfiguration
        | LinkError::Protocol
        | LinkError::Journal
        | LinkError::Fence
        | LinkError::UncertainRequest(_)
        | LinkError::StateMismatch) => LinkDisposition::Fatal(error),
    }
}

fn owns_pending(session: &Session, dispatcher: &impl DeferredDispatcher) -> bool {
    session.has_pending() || dispatcher.has_pending()
}

fn retry_or_pending_fatal(pending: bool) -> ActiveOutcome {
    if pending {
        ActiveOutcome::Fatal(LinkError::StateMismatch)
    } else {
        ActiveOutcome::Retry
    }
}

fn active_from_link_error(error: LinkError, pending: bool) -> ActiveOutcome {
    match classify_link_error(error) {
        LinkDisposition::Retry if pending => ActiveOutcome::Fatal(LinkError::StateMismatch),
        LinkDisposition::Retry => ActiveOutcome::Retry,
        LinkDisposition::Credentials => ActiveOutcome::CredentialsUnavailable,
        LinkDisposition::Fatal(error) => ActiveOutcome::Fatal(error),
    }
}

fn duration_from_nanos(nanos: u128) -> Duration {
    Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_exponential_capped_and_jitter_bounded() {
        let policy =
            BackoffPolicy::new(Duration::from_millis(100), Duration::from_secs(2), 25).unwrap();
        for (attempt, nominal) in [
            (0, Duration::from_millis(100)),
            (1, Duration::from_millis(200)),
            (4, Duration::from_millis(1600)),
            (5, Duration::from_secs(2)),
            (63, Duration::from_secs(2)),
        ] {
            let jitter = nominal.as_nanos() * 25 / 100;
            let low = duration_from_nanos(nominal.as_nanos() - jitter);
            let high = duration_from_nanos(nominal.as_nanos() + jitter);
            assert!(policy.delay(attempt, 0) >= low);
            assert!(policy.delay(attempt, u64::MAX) <= high.min(policy.maximum()));
            assert!(policy.delay(attempt, u64::MAX) <= policy.maximum());
        }
    }

    #[test]
    fn drain_is_idempotent_and_interrupts_wait() {
        let signal = DrainSignal::new();
        let waiter = signal.clone();
        let thread = std::thread::spawn(move || waiter.wait(Duration::from_secs(60)));
        signal.request();
        signal.request();
        assert!(thread.join().unwrap());
        assert!(signal.is_requested());
    }

    #[test]
    fn invalid_backoff_and_boot_epoch_fail_closed() {
        assert!(BackoffPolicy::new(Duration::ZERO, Duration::from_secs(1), 0).is_err());
        assert!(BackoffPolicy::new(Duration::from_secs(2), Duration::from_secs(1), 0).is_err());
        assert!(BackoffPolicy::new(Duration::from_secs(1), Duration::from_secs(2), 51).is_err());
    }
}
