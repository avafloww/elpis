//! Daemon-owned durable admission for signed sensitive grants.
//!
//! GrantLedger owns both authentication trust and the wall clock. Its only admission
//! input is an untrusted payload/signature pair plus the local binding to check. Successful
//! admission durably inserts the exact signed grant and advances the issuer sequence in one
//! BEGIN IMMEDIATE transaction before minting a non-cloneable ActiveGrant. Terminal operations
//! consume that authority into one append-only receipt bound to the same durable admission.

#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use elpis_grants::{
    CanonicalSensitivePolicy, ED25519_SIGNATURE_BYTES, GrantBinding, GrantError, GrantV1,
    GrantVerifier, MAX_GRANT_PAYLOAD_BYTES, MAX_TERMINAL_CONTROL_PAYLOAD_BYTES,
    TerminalControlActionV1, TerminalControlV1, TerminalControlVerifier,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 4;
// "ELGL", deliberately distinct from the transport, effect, and other ledgers.
const APPLICATION_ID: i64 = 0x454c_474c;
const ADMISSION_SCHEMA_OBJECTS: &[(&str, &str)] = &[
    ("table", "grant_state"),
    ("table", "grants"),
    ("trigger", "grant_rows_immutable"),
    ("trigger", "grant_rows_no_delete"),
    ("trigger", "grant_state_no_delete"),
    ("trigger", "grant_state_sequence_monotonic"),
];
const TERMINAL_SCHEMA_OBJECTS: &[(&str, &str)] = &[
    ("table", "grant_terminal_events"),
    ("trigger", "grant_terminal_events_immutable"),
    ("trigger", "grant_terminal_events_no_delete"),
];
const TERMINAL_SCHEMA_SQL: &str = "CREATE TABLE grant_terminal_events (
    event_seq INTEGER PRIMARY KEY CHECK (event_seq > 0),
    grant_id TEXT NOT NULL UNIQUE REFERENCES grants(grant_id),
    payload_sha256 BLOB NOT NULL
        CHECK (typeof(payload_sha256) = 'blob' AND length(payload_sha256) = 32),
    kind TEXT NOT NULL CHECK (kind IN ('completed', 'revoked', 'flagged', 'expired', 'interrupted')),
    occurred_at_unix_s BLOB NOT NULL
        CHECK (typeof(occurred_at_unix_s) = 'blob' AND length(occurred_at_unix_s) = 8)
);
CREATE TRIGGER grant_terminal_events_immutable
BEFORE UPDATE ON grant_terminal_events
BEGIN SELECT RAISE(ABORT, 'grant terminal events are immutable'); END;
CREATE TRIGGER grant_terminal_events_no_delete
BEFORE DELETE ON grant_terminal_events
BEGIN SELECT RAISE(ABORT, 'grant terminal events are append-only'); END;";
const CONTROL_SCHEMA_OBJECTS: &[(&str, &str)] = &[
    ("table", "terminal_control_receipts"),
    ("trigger", "terminal_control_receipts_immutable"),
    ("trigger", "terminal_control_receipts_no_delete"),
    ("trigger", "terminal_control_receipts_shared_sequence"),
    ("trigger", "grant_rows_shared_sequence"),
];
const LATCH_SCHEMA_OBJECTS: &[(&str, &str)] = &[
    ("table", "policy_latch_events"),
    ("index", "policy_latch_events_key_sequence"),
    ("trigger", "policy_latch_events_immutable"),
    ("trigger", "policy_latch_events_no_delete"),
];
const V4_SCHEMA_SQL: &str = r#"CREATE TABLE terminal_control_receipts (
    receipt_seq INTEGER PRIMARY KEY CHECK (receipt_seq > 0),
    control_id TEXT NOT NULL UNIQUE
        CHECK (typeof(control_id) = 'text'
               AND length(CAST(control_id AS BLOB)) BETWEEN 1 AND 120
               AND control_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    issuer_id TEXT NOT NULL
        CHECK (typeof(issuer_id) = 'text'
               AND length(CAST(issuer_id AS BLOB)) BETWEEN 1 AND 120
               AND issuer_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    issuer_seq BLOB NOT NULL
        CHECK (typeof(issuer_seq) = 'blob' AND length(issuer_seq) = 8
               AND issuer_seq != zeroblob(8)),
    executor_id TEXT NOT NULL
        CHECK (typeof(executor_id) = 'text'
               AND length(CAST(executor_id AS BLOB)) BETWEEN 1 AND 120
               AND executor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    policy_epoch BLOB NOT NULL
        CHECK (typeof(policy_epoch) = 'blob' AND length(policy_epoch) = 8
               AND policy_epoch != zeroblob(8)),
    target_action TEXT NOT NULL
        CHECK (target_action IN ('revoke_grant', 'flag_grant', 'clear_latch')),
    target_grant_id TEXT REFERENCES grants(grant_id),
    target_grant_payload_sha256 BLOB,
    target_profile_id TEXT,
    target_policy_sha256 BLOB,
    issued_at_unix_s BLOB NOT NULL
        CHECK (typeof(issued_at_unix_s) = 'blob' AND length(issued_at_unix_s) = 8
               AND issued_at_unix_s != zeroblob(8)),
    expires_at_unix_s BLOB NOT NULL
        CHECK (typeof(expires_at_unix_s) = 'blob' AND length(expires_at_unix_s) = 8),
    admitted_at_unix_s BLOB NOT NULL
        CHECK (typeof(admitted_at_unix_s) = 'blob' AND length(admitted_at_unix_s) = 8
               AND admitted_at_unix_s != zeroblob(8)),
    payload_sha256 BLOB NOT NULL
        CHECK (typeof(payload_sha256) = 'blob' AND length(payload_sha256) = 32),
    payload_bytes BLOB NOT NULL UNIQUE
        CHECK (typeof(payload_bytes) = 'blob'
               AND length(payload_bytes) BETWEEN 1 AND 4096),
    signature BLOB NOT NULL
        CHECK (typeof(signature) = 'blob' AND length(signature) = 64),
    UNIQUE (issuer_id, issuer_seq),
    CHECK (expires_at_unix_s > issued_at_unix_s),
    CHECK (
        (target_action IN ('revoke_grant', 'flag_grant')
         AND typeof(target_grant_id) = 'text'
         AND length(CAST(target_grant_id AS BLOB)) BETWEEN 1 AND 120
         AND target_grant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
         AND typeof(target_grant_payload_sha256) = 'blob'
         AND length(target_grant_payload_sha256) = 32
         AND target_profile_id IS NULL AND target_policy_sha256 IS NULL)
        OR
        (target_action = 'clear_latch'
         AND target_grant_id IS NULL AND target_grant_payload_sha256 IS NULL
         AND typeof(target_profile_id) = 'text'
         AND length(CAST(target_profile_id AS BLOB)) BETWEEN 1 AND 120
         AND target_profile_id NOT GLOB '*[^A-Za-z0-9._:-]*'
         AND typeof(target_policy_sha256) = 'blob'
         AND length(target_policy_sha256) = 32)
    )
);
CREATE TRIGGER terminal_control_receipts_immutable
BEFORE UPDATE ON terminal_control_receipts
BEGIN SELECT RAISE(ABORT, 'terminal control receipts are immutable'); END;
CREATE TRIGGER terminal_control_receipts_no_delete
BEFORE DELETE ON terminal_control_receipts
BEGIN SELECT RAISE(ABORT, 'terminal control receipts are append-only'); END;
CREATE TRIGGER terminal_control_receipts_shared_sequence
BEFORE INSERT ON terminal_control_receipts
WHEN EXISTS (SELECT 1 FROM grants
             WHERE issuer_id = NEW.issuer_id AND issuer_seq = NEW.issuer_seq)
BEGIN SELECT RAISE(ABORT, 'issuer sequence was already used by a grant'); END;
CREATE TRIGGER grant_rows_shared_sequence
BEFORE INSERT ON grants
WHEN EXISTS (SELECT 1 FROM terminal_control_receipts
             WHERE issuer_id = NEW.issuer_id AND issuer_seq = NEW.issuer_seq)
BEGIN SELECT RAISE(ABORT, 'issuer sequence was already used by a control'); END;
CREATE TABLE policy_latch_events (
    event_seq INTEGER PRIMARY KEY CHECK (event_seq > 0),
    executor_id TEXT NOT NULL
        CHECK (typeof(executor_id) = 'text'
               AND length(CAST(executor_id AS BLOB)) BETWEEN 1 AND 120
               AND executor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    profile_id TEXT NOT NULL
        CHECK (typeof(profile_id) = 'text'
               AND length(CAST(profile_id AS BLOB)) BETWEEN 1 AND 120
               AND profile_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    policy_sha256 BLOB NOT NULL
        CHECK (typeof(policy_sha256) = 'blob' AND length(policy_sha256) = 32),
    policy_bytes BLOB,
    kind TEXT NOT NULL CHECK (kind IN ('flag', 'clear')),
    grant_id TEXT UNIQUE REFERENCES grants(grant_id),
    control_id TEXT NOT NULL UNIQUE REFERENCES terminal_control_receipts(control_id),
    occurred_at_unix_s BLOB NOT NULL
        CHECK (typeof(occurred_at_unix_s) = 'blob' AND length(occurred_at_unix_s) = 8
               AND occurred_at_unix_s != zeroblob(8)),
    CHECK ((kind = 'flag' AND grant_id IS NOT NULL
            AND typeof(policy_bytes) = 'blob'
            AND length(policy_bytes) BETWEEN 1 AND 32768)
           OR (kind = 'clear' AND grant_id IS NULL AND policy_bytes IS NULL))
);
CREATE INDEX policy_latch_events_key_sequence
ON policy_latch_events(executor_id, profile_id, policy_sha256, event_seq DESC);
CREATE TRIGGER policy_latch_events_immutable
BEFORE UPDATE ON policy_latch_events
BEGIN SELECT RAISE(ABORT, 'policy latch events are immutable'); END;
CREATE TRIGGER policy_latch_events_no_delete
BEFORE DELETE ON policy_latch_events
BEGIN SELECT RAISE(ABORT, 'policy latch events are append-only'); END;"#;

/// Conventional filename for the daemon-private grant ledger.
pub const GRANT_LEDGER_DATABASE_FILENAME: &str = "grants.sqlite";

/// Durable storage bounds applied at open and before every admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantLedgerLimits {
    pub max_grants: u64,
    pub max_bytes: u64,
    pub max_terminal_controls: u64,
    pub max_terminal_control_bytes: u64,
    pub max_latch_events: u64,
    pub max_latch_bytes: u64,
}

impl Default for GrantLedgerLimits {
    fn default() -> Self {
        Self {
            max_grants: 10_000,
            max_bytes: 64 * 1024 * 1024,
            max_terminal_controls: 10_000,
            max_terminal_control_bytes: 32 * 1024 * 1024,
            max_latch_events: 20_000,
            max_latch_bytes: 64 * 1024 * 1024,
        }
    }
}

/// One-use authority minted only after a new grant and its sequence are durable.
///
/// There is intentionally no public constructor and this type is intentionally not
/// Clone or Copy.
#[derive(Debug, PartialEq, Eq)]
pub struct ActiveGrant {
    grant: GrantV1,
    payload_sha256: [u8; 32],
    ledger_binding: [u8; 32],
}

impl ActiveGrant {
    pub fn grant(&self) -> &GrantV1 {
        &self.grant
    }

    pub fn payload_sha256(&self) -> &[u8; 32] {
        &self.payload_sha256
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantTerminalKind {
    Completed,
    Revoked,
    Flagged,
    Expired,
    Interrupted,
}

impl GrantTerminalKind {
    fn as_db(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Revoked => "revoked",
            Self::Flagged => "flagged",
            Self::Expired => "expired",
            Self::Interrupted => "interrupted",
        }
    }

    fn from_db(value: &str) -> Result<Self, GrantLedgerError> {
        match value {
            "completed" => Ok(Self::Completed),
            "revoked" => Ok(Self::Revoked),
            "flagged" => Ok(Self::Flagged),
            "expired" => Ok(Self::Expired),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(GrantLedgerError::Corrupt(
                "stored terminal kind is invalid".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantTerminalReceipt {
    event_seq: u64,
    grant_id: String,
    payload_sha256: [u8; 32],
    kind: GrantTerminalKind,
    occurred_at_unix_s: u64,
}

impl GrantTerminalReceipt {
    pub fn event_seq(&self) -> u64 {
        self.event_seq
    }

    pub fn grant_id(&self) -> &str {
        &self.grant_id
    }

    pub fn payload_sha256(&self) -> &[u8; 32] {
        &self.payload_sha256
    }

    pub fn kind(&self) -> GrantTerminalKind {
        self.kind
    }

    pub fn occurred_at_unix_s(&self) -> u64 {
        self.occurred_at_unix_s
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LedgerState {
    grant_count: u64,
    total_bytes: u64,
    last_issuer_seq: Option<u64>,
}

#[derive(Debug)]
enum Clock {
    System,
    #[cfg(test)]
    Fixed(u64),
}

impl Clock {
    fn now_unix_s(&self) -> Result<u64, GrantLedgerError> {
        match self {
            Self::System => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .map_err(|_| GrantLedgerError::ClockBeforeUnixEpoch),
            #[cfg(test)]
            Self::Fixed(now) => Ok(*now),
        }
    }
}

/// Private SQLite owner and the sole grant admission authority.
#[derive(Debug)]
pub struct GrantLedger {
    path: PathBuf,
    ledger_binding: [u8; 32],
    connection: Connection,
    verifier: GrantVerifier,
    control_verifier: Option<TerminalControlVerifier>,
    limits: GrantLedgerLimits,
    clock: Clock,
}

impl GrantLedger {
    /// Opens a private ledger using the process wall clock without terminal-control trust.
    ///
    /// This path fails closed if durable terminal-control rows already exist. Use
    /// [`Self::open_with_terminal_control_verifier`] to reopen such a ledger.
    pub fn open(
        path: impl AsRef<Path>,
        verifier: GrantVerifier,
        limits: GrantLedgerLimits,
    ) -> Result<Self, GrantLedgerError> {
        Self::open_with_verifiers_and_clock(path.as_ref(), verifier, None, limits, Clock::System)
    }

    /// Opens a private ledger with boot-frozen terminal-control verification custody.
    pub fn open_with_terminal_control_verifier(
        path: impl AsRef<Path>,
        verifier: GrantVerifier,
        control_verifier: TerminalControlVerifier,
        limits: GrantLedgerLimits,
    ) -> Result<Self, GrantLedgerError> {
        Self::open_with_verifiers_and_clock(
            path.as_ref(),
            verifier,
            Some(control_verifier),
            limits,
            Clock::System,
        )
    }

    /// Opens grants.sqlite in a private state directory without terminal-control trust.
    pub fn open_directory(
        directory: impl AsRef<Path>,
        verifier: GrantVerifier,
        limits: GrantLedgerLimits,
    ) -> Result<Self, GrantLedgerError> {
        Self::open(
            directory.as_ref().join(GRANT_LEDGER_DATABASE_FILENAME),
            verifier,
            limits,
        )
    }

    /// Opens grants.sqlite with boot-frozen terminal-control verification custody.
    pub fn open_directory_with_terminal_control_verifier(
        directory: impl AsRef<Path>,
        verifier: GrantVerifier,
        control_verifier: TerminalControlVerifier,
        limits: GrantLedgerLimits,
    ) -> Result<Self, GrantLedgerError> {
        Self::open_with_terminal_control_verifier(
            directory.as_ref().join(GRANT_LEDGER_DATABASE_FILENAME),
            verifier,
            control_verifier,
            limits,
        )
    }

    #[cfg(test)]
    fn open_with_clock(
        path: &Path,
        verifier: GrantVerifier,
        limits: GrantLedgerLimits,
        clock: Clock,
    ) -> Result<Self, GrantLedgerError> {
        Self::open_with_verifiers_and_clock(path, verifier, None, limits, clock)
    }

    #[cfg(test)]
    fn open_with_terminal_control_verifier_and_clock(
        path: &Path,
        verifier: GrantVerifier,
        control_verifier: TerminalControlVerifier,
        limits: GrantLedgerLimits,
        clock: Clock,
    ) -> Result<Self, GrantLedgerError> {
        Self::open_with_verifiers_and_clock(path, verifier, Some(control_verifier), limits, clock)
    }

    fn open_with_verifiers_and_clock(
        path: &Path,
        verifier: GrantVerifier,
        control_verifier: Option<TerminalControlVerifier>,
        limits: GrantLedgerLimits,
        clock: Clock,
    ) -> Result<Self, GrantLedgerError> {
        validate_limits(limits)?;
        let path = path.to_path_buf();
        let ledger_binding = sha256(path.as_os_str().as_encoded_bytes());
        let existed = prepare_path(&path)?;
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        secure_database_file(&path, existed)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        let journal_mode: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(GrantLedgerError::Corrupt(
                "could not enable WAL mode".into(),
            ));
        }
        connection.pragma_update(None, "synchronous", "FULL")?;
        let synchronous: i64 =
            connection.pragma_query_value(None, "synchronous", |row| row.get(0))?;
        if synchronous != 2 {
            return Err(GrantLedgerError::Corrupt(
                "could not enable FULL synchronous mode".into(),
            ));
        }
        connection.pragma_update(None, "foreign_keys", "ON")?;
        run_quick_check(&connection)?;
        initialize_schema(&mut connection)?;
        validate_integrity(&connection, &verifier, control_verifier.as_ref(), limits)?;
        let mut ledger = Self {
            path,
            ledger_binding,
            connection,
            verifier,
            control_verifier,
            limits,
            clock,
        };
        ledger.recover_unsettled_on_open()?;
        Ok(ledger)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Authenticates and atomically admits an untrusted signed canonical grant.
    ///
    /// Time comes exclusively from the ledger clock. Replays, identifier conflicts,
    /// reused or stale issuer sequences, and capacity failures never mint authority.
    pub fn admit(
        &mut self,
        payload: &[u8],
        signature: &[u8],
        binding: &GrantBinding,
    ) -> Result<ActiveGrant, GrantLedgerError> {
        // Authentication happens inside this owner. No caller-created authentication
        // token can cross the admission boundary.
        let authenticated = self.verifier.authenticate(payload, signature, binding)?;
        let grant = authenticated.grant().clone();
        let payload_sha256 = sha256(payload);
        let added_bytes = accounted_bytes(&grant, payload, signature)?;
        let limits = self.limits;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Check time only after obtaining the write reservation, so queueing behind
        // another writer cannot admit a grant that expired while waiting.
        let now = self.clock.now_unix_s()?;
        if now < grant.not_before_unix_s {
            return Err(GrantLedgerError::NotYetValid);
        }
        if now >= grant.expires_at_unix_s {
            return Err(GrantLedgerError::Expired);
        }

        if let Some(existing_payload) = transaction
            .query_row(
                "SELECT payload_bytes FROM grants WHERE grant_id = ?1",
                params![grant.grant_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?
        {
            return if existing_payload == payload {
                Err(GrantLedgerError::Replay)
            } else {
                Err(GrantLedgerError::GrantIdConflict)
            };
        }
        if transaction
            .query_row(
                "SELECT 1 FROM grants WHERE payload_bytes = ?1",
                params![payload],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(GrantLedgerError::Replay);
        }
        if transaction
            .query_row(
                "SELECT 1 FROM grants WHERE issuer_id = ?1 AND issuer_seq = ?2",
                params![grant.issuer_id, u64_blob(grant.issuer_seq).as_slice()],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(GrantLedgerError::IssuerSequenceReplay);
        }

        let (state, state_issuer) = load_state(&transaction)?;
        if let Some(existing_issuer) = state_issuer.as_deref()
            && existing_issuer != grant.issuer_id
        {
            return Err(GrantLedgerError::IssuerMismatch);
        }
        if state
            .last_issuer_seq
            .is_some_and(|last| grant.issuer_seq <= last)
        {
            return Err(GrantLedgerError::StaleIssuerSequence);
        }
        enforce_capacity(limits, state, added_bytes)?;

        transaction.execute(
            "INSERT INTO grants (
                grant_id, issuer_id, issuer_seq, not_before_unix_s, expires_at_unix_s,
                payload_sha256, payload_bytes, signature
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                grant.grant_id,
                grant.issuer_id,
                u64_blob(grant.issuer_seq).as_slice(),
                u64_blob(grant.not_before_unix_s).as_slice(),
                u64_blob(grant.expires_at_unix_s).as_slice(),
                payload_sha256.as_slice(),
                payload,
                signature,
            ],
        )?;

        let changed = match state.last_issuer_seq {
            Some(last) => transaction.execute(
                "UPDATE grant_state
                 SET last_issuer_seq = ?1, grant_count = grant_count + 1,
                     total_bytes = total_bytes + ?2
                 WHERE singleton = 1 AND issuer_id = ?3 AND last_issuer_seq = ?4",
                params![
                    u64_blob(grant.issuer_seq).as_slice(),
                    to_i64(added_bytes)?,
                    grant.issuer_id,
                    u64_blob(last).as_slice(),
                ],
            )?,
            None => transaction.execute(
                "UPDATE grant_state
                 SET issuer_id = ?1, last_issuer_seq = ?2, grant_count = 1,
                     total_bytes = ?3
                 WHERE singleton = 1 AND issuer_id IS NULL AND last_issuer_seq IS NULL
                   AND grant_count = 0 AND total_bytes = 0",
                params![
                    grant.issuer_id,
                    u64_blob(grant.issuer_seq).as_slice(),
                    to_i64(added_bytes)?,
                ],
            )?,
        };
        if changed != 1 {
            return Err(GrantLedgerError::ConcurrentChange);
        }
        transaction.commit()?;

        // Authority is constructed only after both INSERT and sequence advancement commit.
        Ok(ActiveGrant {
            grant,
            payload_sha256,
            ledger_binding: self.ledger_binding,
        })
    }

    pub fn complete(
        &mut self,
        active: ActiveGrant,
    ) -> Result<GrantTerminalReceipt, GrantLedgerError> {
        self.terminate(active, GrantTerminalKind::Completed)
    }

    pub fn revoke(
        &mut self,
        active: ActiveGrant,
    ) -> Result<GrantTerminalReceipt, GrantLedgerError> {
        self.terminate(active, GrantTerminalKind::Revoked)
    }

    pub fn flag(&mut self, active: ActiveGrant) -> Result<GrantTerminalReceipt, GrantLedgerError> {
        self.terminate(active, GrantTerminalKind::Flagged)
    }

    pub fn terminal_receipt(
        &self,
        grant_id: &str,
    ) -> Result<Option<GrantTerminalReceipt>, GrantLedgerError> {
        load_terminal_receipt(&self.connection, grant_id)
    }

    /// Returns the state derived from the latest append-only event for one exact latch key.
    pub fn policy_latch_is_set(
        &self,
        executor_id: &str,
        profile_id: &str,
        policy_sha256: &[u8; 32],
    ) -> Result<bool, GrantLedgerError> {
        if self.control_verifier.is_none() {
            return Err(GrantLedgerError::TerminalControlVerifierRequired);
        }
        let latest = self
            .connection
            .query_row(
                "SELECT kind FROM policy_latch_events
                 WHERE executor_id = ?1 AND profile_id = ?2 AND policy_sha256 = ?3
                 ORDER BY event_seq DESC LIMIT 1",
                params![executor_id, profile_id, policy_sha256.as_slice()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match latest.as_deref() {
            None | Some("clear") => Ok(false),
            Some("flag") => Ok(true),
            Some(_) => Err(GrantLedgerError::Corrupt(
                "stored policy latch event kind is invalid".into(),
            )),
        }
    }

    pub fn expire_due(&mut self) -> Result<Vec<GrantTerminalReceipt>, GrantLedgerError> {
        self.terminalize_unsettled(false)
    }

    fn recover_unsettled_on_open(&mut self) -> Result<(), GrantLedgerError> {
        self.terminalize_unsettled(true).map(|_| ())
    }

    fn terminalize_unsettled(
        &mut self,
        cold_open: bool,
    ) -> Result<Vec<GrantTerminalReceipt>, GrantLedgerError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = self.clock.now_unix_s()?;
        let candidates = {
            let mut statement = transaction.prepare(
                "SELECT grant.grant_id, grant.payload_sha256, grant.expires_at_unix_s
                 FROM grants AS grant
                 LEFT JOIN grant_terminal_events AS event ON event.grant_id = grant.grant_id
                 WHERE event.grant_id IS NULL
                 ORDER BY grant.issuer_seq",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut next = next_terminal_sequence(&transaction)?;
        let mut receipts = Vec::new();
        for (grant_id, payload_sha256, expires_at) in candidates {
            let payload_sha256 = decode_hash(payload_sha256, "grant payload hash")?;
            let expires_at = decode_u64(expires_at, "grant expiry")?;
            let kind = if expires_at <= now {
                GrantTerminalKind::Expired
            } else if cold_open {
                GrantTerminalKind::Interrupted
            } else {
                continue;
            };
            receipts.push(insert_terminal_receipt(
                &transaction,
                next,
                &grant_id,
                payload_sha256,
                kind,
                now,
            )?);
            next = next
                .checked_add(1)
                .ok_or(GrantLedgerError::TerminalSequenceExhausted)?;
        }
        transaction.commit()?;
        Ok(receipts)
    }

    fn terminate(
        &mut self,
        active: ActiveGrant,
        kind: GrantTerminalKind,
    ) -> Result<GrantTerminalReceipt, GrantLedgerError> {
        let ActiveGrant {
            grant,
            payload_sha256,
            ledger_binding,
        } = active;
        if ledger_binding != self.ledger_binding {
            return Err(GrantLedgerError::WrongLedger);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = self.clock.now_unix_s()?;
        let stored_hash = transaction
            .query_row(
                "SELECT payload_sha256 FROM grants WHERE grant_id = ?1",
                params![grant.grant_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?
            .ok_or(GrantLedgerError::UnknownActiveGrant)?;
        if stored_hash.as_slice() != payload_sha256 {
            return Err(GrantLedgerError::ActiveGrantMismatch);
        }
        if load_terminal_receipt(&transaction, &grant.grant_id)?.is_some() {
            return Err(GrantLedgerError::AlreadyTerminal);
        }
        let next = next_terminal_sequence(&transaction)?;
        let receipt = insert_terminal_receipt(
            &transaction,
            next,
            &grant.grant_id,
            payload_sha256,
            kind,
            now,
        )?;
        transaction.commit()?;
        Ok(receipt)
    }
}

#[derive(Debug, Error)]
pub enum GrantLedgerError {
    #[error("grant authentication failed: {0}")]
    Grant(#[from] GrantError),
    #[error("grant ledger SQLite error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("grant ledger I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("grant ledger is corrupt: {0}")]
    Corrupt(String),
    #[error("unsafe grant ledger path: {0}")]
    UnsafePath(String),
    #[error("grant ledger limits must be nonzero and fit SQLite counters")]
    InvalidLimits,
    #[error("system clock is before the Unix epoch")]
    ClockBeforeUnixEpoch,
    #[error("terminal-control rows require boot-frozen verifier custody")]
    TerminalControlVerifierRequired,
    #[error("grant is not yet valid")]
    NotYetValid,
    #[error("grant is expired")]
    Expired,
    #[error("the exact signed grant was already admitted")]
    Replay,
    #[error("grant ID was already used for different signed claims")]
    GrantIdConflict,
    #[error("issuer sequence was already used")]
    IssuerSequenceReplay,
    #[error("issuer sequence does not advance the durable high-water mark")]
    StaleIssuerSequence,
    #[error("grant issuer does not match the ledger issuer")]
    IssuerMismatch,
    #[error("grant ledger storage limit exceeded")]
    StorageLimit,
    #[error("grant ledger row changed concurrently")]
    ConcurrentChange,
    #[error("active grant belongs to another ledger")]
    WrongLedger,
    #[error("active grant is not present in this ledger")]
    UnknownActiveGrant,
    #[error("active grant payload does not match its durable admission")]
    ActiveGrantMismatch,
    #[error("grant already has a terminal receipt")]
    AlreadyTerminal,
    #[error("terminal receipt sequence is exhausted")]
    TerminalSequenceExhausted,
}

fn validate_limits(limits: GrantLedgerLimits) -> Result<(), GrantLedgerError> {
    if limits.max_grants == 0
        || limits.max_bytes == 0
        || limits.max_terminal_controls == 0
        || limits.max_terminal_control_bytes == 0
        || limits.max_latch_events == 0
        || limits.max_latch_bytes == 0
        || limits.max_grants > i64::MAX as u64
        || limits.max_bytes > i64::MAX as u64
        || limits.max_terminal_controls > i64::MAX as u64
        || limits.max_terminal_control_bytes > i64::MAX as u64
        || limits.max_latch_events > i64::MAX as u64
        || limits.max_latch_bytes > i64::MAX as u64
    {
        return Err(GrantLedgerError::InvalidLimits);
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn u64_blob(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}

fn decode_u64(bytes: Vec<u8>, field: &str) -> Result<u64, GrantLedgerError> {
    let bytes: [u8; 8] = bytes
        .try_into()
        .map_err(|_| GrantLedgerError::Corrupt(format!("{field} is not an eight-byte counter")))?;
    Ok(u64::from_be_bytes(bytes))
}

fn to_i64(value: u64) -> Result<i64, GrantLedgerError> {
    i64::try_from(value).map_err(|_| GrantLedgerError::InvalidLimits)
}

fn decode_hash(bytes: Vec<u8>, field: &str) -> Result<[u8; 32], GrantLedgerError> {
    bytes
        .try_into()
        .map_err(|_| GrantLedgerError::Corrupt(format!("{field} is not a SHA-256 digest")))
}

fn next_terminal_sequence(connection: &Connection) -> Result<i64, GrantLedgerError> {
    let (count, last): (i64, Option<i64>) = connection.query_row(
        "SELECT COUNT(*), MAX(event_seq) FROM grant_terminal_events",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    match (count, last) {
        (0, None) => Ok(1),
        (count, Some(last)) if count > 0 && count == last => last
            .checked_add(1)
            .ok_or(GrantLedgerError::TerminalSequenceExhausted),
        _ => Err(GrantLedgerError::Corrupt(
            "terminal event sequence is not gap-free".into(),
        )),
    }
}

fn insert_terminal_receipt(
    connection: &Connection,
    event_seq: i64,
    grant_id: &str,
    payload_sha256: [u8; 32],
    kind: GrantTerminalKind,
    occurred_at_unix_s: u64,
) -> Result<GrantTerminalReceipt, GrantLedgerError> {
    connection.execute(
        "INSERT INTO grant_terminal_events (
            event_seq, grant_id, payload_sha256, kind, occurred_at_unix_s
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            event_seq,
            grant_id,
            payload_sha256.as_slice(),
            kind.as_db(),
            u64_blob(occurred_at_unix_s).as_slice(),
        ],
    )?;
    Ok(GrantTerminalReceipt {
        event_seq: event_seq as u64,
        grant_id: grant_id.to_owned(),
        payload_sha256,
        kind,
        occurred_at_unix_s,
    })
}

fn load_terminal_receipt(
    connection: &Connection,
    grant_id: &str,
) -> Result<Option<GrantTerminalReceipt>, GrantLedgerError> {
    let raw = connection
        .query_row(
            "SELECT event.event_seq, event.grant_id, event.payload_sha256, event.kind,
                    event.occurred_at_unix_s, grant.payload_sha256
             FROM grant_terminal_events AS event
             LEFT JOIN grants AS grant ON grant.grant_id = event.grant_id
             WHERE event.grant_id = ?1",
            params![grant_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((event_seq, grant_id, payload_sha256, kind, occurred_at, grant_hash)) = raw else {
        return Ok(None);
    };
    let event_seq = u64::try_from(event_seq)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| GrantLedgerError::Corrupt("terminal event sequence is invalid".into()))?;
    let payload_sha256 = decode_hash(payload_sha256, "terminal payload hash")?;
    let grant_hash = grant_hash
        .ok_or_else(|| GrantLedgerError::Corrupt("terminal admission is missing".into()))?;
    if payload_sha256 != decode_hash(grant_hash, "grant payload hash")? {
        return Err(GrantLedgerError::Corrupt(
            "terminal receipt does not match its admission".into(),
        ));
    }
    Ok(Some(GrantTerminalReceipt {
        event_seq,
        grant_id,
        payload_sha256,
        kind: GrantTerminalKind::from_db(&kind)?,
        occurred_at_unix_s: decode_u64(occurred_at, "terminal occurrence time")?,
    }))
}

fn accounted_bytes(
    grant: &GrantV1,
    payload: &[u8],
    signature: &[u8],
) -> Result<u64, GrantLedgerError> {
    [
        grant.grant_id.len(),
        grant.issuer_id.len(),
        8,  // issuer sequence
        8,  // not-before
        8,  // expiry
        32, // payload digest
        payload.len(),
        signature.len(),
    ]
    .into_iter()
    .try_fold(0_u64, |total, length| {
        total
            .checked_add(length as u64)
            .ok_or(GrantLedgerError::InvalidLimits)
    })
}

fn enforce_capacity(
    limits: GrantLedgerLimits,
    state: LedgerState,
    added_bytes: u64,
) -> Result<(), GrantLedgerError> {
    let count = state
        .grant_count
        .checked_add(1)
        .ok_or(GrantLedgerError::StorageLimit)?;
    let bytes = state
        .total_bytes
        .checked_add(added_bytes)
        .ok_or(GrantLedgerError::StorageLimit)?;
    if count > limits.max_grants || bytes > limits.max_bytes {
        return Err(GrantLedgerError::StorageLimit);
    }
    Ok(())
}

fn prepare_path(path: &Path) -> Result<bool, GrantLedgerError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(GrantLedgerError::UnsafePath(
            "database path must be absolute and have a file name".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| GrantLedgerError::UnsafePath("database path has no parent".into()))?;
    if parent.exists() {
        require_private_owned_dir(parent)?;
    } else {
        create_private_dir(parent)?;
        require_private_owned_dir(parent)?;
    }
    if fs::canonicalize(parent)? != parent {
        return Err(GrantLedgerError::UnsafePath(
            "state parent has a symlinked or non-canonical ancestor".into(),
        ));
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            require_private_owned_file(&metadata)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn require_private_owned_dir(path: &Path) -> Result<(), GrantLedgerError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(GrantLedgerError::UnsafePath(
            "state parent is not a real directory".into(),
        ));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(GrantLedgerError::UnsafePath(
            "state parent is not owned by the current user".into(),
        ));
    }
    if metadata.permissions().mode() & 0o7777 != 0o700 {
        return Err(GrantLedgerError::UnsafePath(
            "state parent mode is not 0700".into(),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_owned_dir(_path: &Path) -> Result<(), GrantLedgerError> {
    Ok(())
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> Result<(), GrantLedgerError> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new().mode(0o700).create(path)?;
    // A setgid parent may add inherited mode bits despite DirBuilderExt::mode.
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> Result<(), GrantLedgerError> {
    fs::create_dir(path)?;
    Ok(())
}

fn secure_database_file(path: &Path, existed: bool) -> Result<(), GrantLedgerError> {
    if !existed {
        set_private_file_mode(path)?;
    }
    require_private_owned_file(&fs::symlink_metadata(path)?)
}

#[cfg(unix)]
fn require_private_owned_file(metadata: &fs::Metadata) -> Result<(), GrantLedgerError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(GrantLedgerError::UnsafePath(
            "database is not a regular file".into(),
        ));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(GrantLedgerError::UnsafePath(
            "database file is not owned by the current user".into(),
        ));
    }
    if metadata.nlink() != 1 {
        return Err(GrantLedgerError::UnsafePath(
            "database has multiple hard links".into(),
        ));
    }
    if metadata.permissions().mode() & 0o7777 != 0o600 {
        return Err(GrantLedgerError::UnsafePath(
            "existing database mode is not 0600".into(),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_owned_file(metadata: &fs::Metadata) -> Result<(), GrantLedgerError> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(GrantLedgerError::UnsafePath(
            "database is not a regular file".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_file_mode(path: &Path) -> Result<(), GrantLedgerError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_mode(_path: &Path) -> Result<(), GrantLedgerError> {
    Ok(())
}

fn run_quick_check(connection: &Connection) -> Result<(), GrantLedgerError> {
    let mut statement = connection
        .prepare("PRAGMA quick_check")
        .map_err(|error| GrantLedgerError::Corrupt(format!("quick_check failed: {error}")))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| GrantLedgerError::Corrupt(format!("quick_check failed: {error}")))?;
    for row in rows {
        let result =
            row.map_err(|error| GrantLedgerError::Corrupt(format!("quick_check failed: {error}")))?;
        if result != "ok" {
            return Err(GrantLedgerError::Corrupt(result));
        }
    }
    Ok(())
}

fn initialize_schema(connection: &mut Connection) -> Result<(), GrantLedgerError> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !matches!(version, 0 | 1 | 2 | 3 | SCHEMA_VERSION) {
        return Err(GrantLedgerError::Corrupt(format!(
            "unsupported schema version {version}"
        )));
    }
    if version == 0 {
        let objects: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        if objects != 0 {
            return Err(GrantLedgerError::Corrupt(
                "unversioned database already contains objects".into(),
            ));
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE grant_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                issuer_id TEXT,
                last_issuer_seq BLOB,
                grant_count INTEGER NOT NULL CHECK (grant_count >= 0),
                total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
                CHECK (
                    (issuer_id IS NULL AND last_issuer_seq IS NULL
                     AND grant_count = 0 AND total_bytes = 0)
                    OR
                    (typeof(issuer_id) = 'text'
                     AND length(CAST(issuer_id AS BLOB)) BETWEEN 1 AND 120
                     AND issuer_id NOT GLOB '*[^A-Za-z0-9._:-]*'
                     AND typeof(last_issuer_seq) = 'blob'
                     AND length(last_issuer_seq) = 8
                     AND last_issuer_seq != zeroblob(8))
                )
             );
             CREATE TABLE grants (
                grant_id TEXT PRIMARY KEY NOT NULL
                    CHECK (typeof(grant_id) = 'text'
                           AND length(CAST(grant_id AS BLOB)) BETWEEN 1 AND 120
                           AND grant_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
                issuer_id TEXT NOT NULL
                    CHECK (typeof(issuer_id) = 'text'
                           AND length(CAST(issuer_id AS BLOB)) BETWEEN 1 AND 120
                           AND issuer_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
                issuer_seq BLOB NOT NULL
                    CHECK (typeof(issuer_seq) = 'blob' AND length(issuer_seq) = 8
                           AND issuer_seq != zeroblob(8)),
                not_before_unix_s BLOB NOT NULL
                    CHECK (typeof(not_before_unix_s) = 'blob'
                           AND length(not_before_unix_s) = 8
                           AND not_before_unix_s != zeroblob(8)),
                expires_at_unix_s BLOB NOT NULL
                    CHECK (typeof(expires_at_unix_s) = 'blob'
                           AND length(expires_at_unix_s) = 8),
                payload_sha256 BLOB NOT NULL
                    CHECK (typeof(payload_sha256) = 'blob' AND length(payload_sha256) = 32),
                payload_bytes BLOB NOT NULL UNIQUE
                    CHECK (typeof(payload_bytes) = 'blob'
                           AND length(payload_bytes) BETWEEN 1 AND 8192),
                signature BLOB NOT NULL
                    CHECK (typeof(signature) = 'blob' AND length(signature) = 64),
                UNIQUE (issuer_id, issuer_seq)
             );
             CREATE TRIGGER grant_rows_immutable
             BEFORE UPDATE ON grants
             BEGIN SELECT RAISE(ABORT, 'grant rows are immutable'); END;
             CREATE TRIGGER grant_rows_no_delete
             BEFORE DELETE ON grants
             BEGIN SELECT RAISE(ABORT, 'grants are append-only'); END;
             CREATE TRIGGER grant_state_no_delete
             BEFORE DELETE ON grant_state
             BEGIN SELECT RAISE(ABORT, 'grant state cannot be deleted'); END;
             CREATE TRIGGER grant_state_sequence_monotonic
             BEFORE UPDATE OF issuer_id, last_issuer_seq ON grant_state
             WHEN NOT (
                (OLD.issuer_id IS NULL AND OLD.last_issuer_seq IS NULL
                 AND NEW.issuer_id IS NOT NULL AND NEW.last_issuer_seq IS NOT NULL)
                OR
                (OLD.issuer_id = NEW.issuer_id
                 AND typeof(NEW.last_issuer_seq) = 'blob'
                 AND NEW.last_issuer_seq > OLD.last_issuer_seq)
             )
             BEGIN SELECT RAISE(ABORT, 'issuer sequence must advance'); END;",
        )?;
        transaction.execute_batch(TERMINAL_SCHEMA_SQL)?;
        transaction.execute_batch(V4_SCHEMA_SQL)?;
        transaction.execute(
            "INSERT INTO grant_state (
                singleton, issuer_id, last_issuer_seq, grant_count, total_bytes
             ) VALUES (1, NULL, NULL, 0, 0)",
            [],
        )?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
    }
    if version == 1 {
        require_application_id(connection)?;
        require_schema_objects(connection, ADMISSION_SCHEMA_OBJECTS)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(TERMINAL_SCHEMA_SQL)?;
        transaction.pragma_update(None, "user_version", 3_i64)?;
        transaction.commit()?;
    }
    if version == 2 {
        require_application_id(connection)?;
        require_schema_objects(connection, ADMISSION_SCHEMA_OBJECTS)?;
        require_schema_objects(connection, TERMINAL_SCHEMA_OBJECTS)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "DROP TRIGGER grant_terminal_events_immutable;
             DROP TRIGGER grant_terminal_events_no_delete;
             ALTER TABLE grant_terminal_events RENAME TO grant_terminal_events_v2;",
        )?;
        transaction.execute_batch(TERMINAL_SCHEMA_SQL)?;
        transaction.execute(
            "INSERT INTO grant_terminal_events (
                event_seq, grant_id, payload_sha256, kind, occurred_at_unix_s
             )
             SELECT event_seq, grant_id, payload_sha256, kind, occurred_at_unix_s
             FROM grant_terminal_events_v2 ORDER BY event_seq",
            [],
        )?;
        transaction.execute_batch("DROP TABLE grant_terminal_events_v2")?;
        transaction.pragma_update(None, "user_version", 3_i64)?;
        transaction.commit()?;
    }

    let current_version: i64 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current_version == 3 {
        require_application_id(connection)?;
        require_schema_objects(connection, ADMISSION_SCHEMA_OBJECTS)?;
        require_schema_objects(connection, TERMINAL_SCHEMA_OBJECTS)?;
        migrate_v3_to_v4(connection)?;
    }

    require_application_id(connection)?;
    require_schema_objects(connection, ADMISSION_SCHEMA_OBJECTS)?;
    require_schema_objects(connection, TERMINAL_SCHEMA_OBJECTS)?;
    require_schema_objects(connection, CONTROL_SCHEMA_OBJECTS)?;
    require_schema_objects(connection, LATCH_SCHEMA_OBJECTS)
}

fn migrate_v3_to_v4(connection: &mut Connection) -> Result<(), GrantLedgerError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "DROP TRIGGER grant_state_no_delete;
         DROP TRIGGER grant_state_sequence_monotonic;
         ALTER TABLE grant_state RENAME TO grant_state_v3;
         CREATE TABLE grant_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            issuer_id TEXT,
            last_issuer_seq BLOB,
            grant_count INTEGER NOT NULL CHECK (grant_count >= 0),
            total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
            CHECK (
                (issuer_id IS NULL AND last_issuer_seq IS NULL
                 AND grant_count = 0 AND total_bytes = 0)
                OR
                (typeof(issuer_id) = 'text'
                 AND length(CAST(issuer_id AS BLOB)) BETWEEN 1 AND 120
                 AND issuer_id NOT GLOB '*[^A-Za-z0-9._:-]*'
                 AND typeof(last_issuer_seq) = 'blob'
                 AND length(last_issuer_seq) = 8
                 AND last_issuer_seq != zeroblob(8))
            )
         );
         INSERT INTO grant_state (
            singleton, issuer_id, last_issuer_seq, grant_count, total_bytes
         )
         SELECT singleton, issuer_id, last_issuer_seq, grant_count, total_bytes
         FROM grant_state_v3;
         DROP TABLE grant_state_v3;
         CREATE TRIGGER grant_state_no_delete
         BEFORE DELETE ON grant_state
         BEGIN SELECT RAISE(ABORT, 'grant state cannot be deleted'); END;
         CREATE TRIGGER grant_state_sequence_monotonic
         BEFORE UPDATE OF issuer_id, last_issuer_seq ON grant_state
         WHEN NOT (
            (OLD.issuer_id IS NULL AND OLD.last_issuer_seq IS NULL
             AND NEW.issuer_id IS NOT NULL AND NEW.last_issuer_seq IS NOT NULL)
            OR
            (OLD.issuer_id = NEW.issuer_id
             AND typeof(NEW.last_issuer_seq) = 'blob'
             AND NEW.last_issuer_seq > OLD.last_issuer_seq)
         )
         BEGIN SELECT RAISE(ABORT, 'issuer sequence must advance'); END;",
    )?;
    transaction.execute_batch(V4_SCHEMA_SQL)?;
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

fn require_application_id(connection: &Connection) -> Result<(), GrantLedgerError> {
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != APPLICATION_ID {
        return Err(GrantLedgerError::Corrupt("wrong application id".into()));
    }
    Ok(())
}

fn require_schema_objects(
    connection: &Connection,
    objects: &[(&str, &str)],
) -> Result<(), GrantLedgerError> {
    for (kind, name) in objects {
        let present: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
            params![kind, name],
            |row| row.get(0),
        )?;
        if present != 1 {
            return Err(GrantLedgerError::Corrupt(format!(
                "missing grant ledger {kind} {name}"
            )));
        }
    }
    Ok(())
}

fn load_state(connection: &Connection) -> Result<(LedgerState, Option<String>), GrantLedgerError> {
    let raw = connection.query_row(
        "SELECT issuer_id, last_issuer_seq, grant_count, total_bytes
         FROM grant_state WHERE singleton = 1",
        [],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<Vec<u8>>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )?;
    let (issuer, last, count, bytes) = raw;
    let last_issuer_seq = last
        .map(|value| decode_u64(value, "last issuer sequence"))
        .transpose()?;
    let grant_count = count
        .try_into()
        .map_err(|_| GrantLedgerError::Corrupt("negative grant count".into()))?;
    let total_bytes = bytes
        .try_into()
        .map_err(|_| GrantLedgerError::Corrupt("negative byte count".into()))?;
    if issuer.is_some() != last_issuer_seq.is_some()
        || (issuer.is_none() && (grant_count != 0 || total_bytes != 0))
    {
        return Err(GrantLedgerError::Corrupt(
            "grant state fields are inconsistent".into(),
        ));
    }
    Ok((
        LedgerState {
            grant_count,
            total_bytes,
            last_issuer_seq,
        },
        issuer,
    ))
}

fn validate_integrity(
    connection: &Connection,
    verifier: &GrantVerifier,
    control_verifier: Option<&TerminalControlVerifier>,
    limits: GrantLedgerLimits,
) -> Result<(), GrantLedgerError> {
    let (state, state_issuer) = load_state(connection)?;
    if state.grant_count > limits.max_grants || state.total_bytes > limits.max_bytes {
        return Err(GrantLedgerError::StorageLimit);
    }

    let mut statement = connection.prepare(
        "SELECT grant_id, issuer_id, issuer_seq, not_before_unix_s, expires_at_unix_s,
                payload_sha256, payload_bytes, signature
         FROM grants ORDER BY issuer_seq",
    )?;
    let mut rows = statement.query([])?;
    let mut count = 0_u64;
    let mut total_bytes = 0_u64;
    let mut maximum_seq = None;
    while let Some(row) = rows.next()? {
        let grant_id: String = row.get(0)?;
        let issuer_id: String = row.get(1)?;
        let issuer_seq = decode_u64(row.get(2)?, "issuer sequence")?;
        let not_before = decode_u64(row.get(3)?, "not-before")?;
        let expires_at = decode_u64(row.get(4)?, "expiry")?;
        let payload_sha256: Vec<u8> = row.get(5)?;
        let payload: Vec<u8> = row.get(6)?;
        let signature: Vec<u8> = row.get(7)?;

        if payload.len() > MAX_GRANT_PAYLOAD_BYTES
            || signature.len() != ED25519_SIGNATURE_BYTES
            || payload_sha256.as_slice() != sha256(&payload)
        {
            return Err(GrantLedgerError::Corrupt(
                "stored payload metadata is invalid".into(),
            ));
        }
        let decoded: GrantV1 = serde_json::from_slice(&payload).map_err(|error| {
            GrantLedgerError::Corrupt(format!("stored grant is invalid: {error}"))
        })?;
        let binding = GrantBinding {
            mind_id: decoded.mind_id.clone(),
            mandate_sha256: decoded.mandate_sha256.clone(),
            runtime_sha256: decoded.runtime_sha256.clone(),
            policy_sha256: decoded.policy_sha256.clone(),
        };
        let authenticated = verifier
            .authenticate(&payload, &signature, &binding)
            .map_err(|error| GrantLedgerError::Corrupt(error.to_string()))?;
        let grant = authenticated.grant();
        if grant.grant_id != grant_id
            || grant.issuer_id != issuer_id
            || grant.issuer_seq != issuer_seq
            || grant.not_before_unix_s != not_before
            || grant.expires_at_unix_s != expires_at
            || state_issuer.as_deref() != Some(issuer_id.as_str())
        {
            return Err(GrantLedgerError::Corrupt(
                "stored grant columns do not match signed claims".into(),
            ));
        }
        count = count
            .checked_add(1)
            .ok_or_else(|| GrantLedgerError::Corrupt("grant count overflow".into()))?;
        total_bytes = total_bytes
            .checked_add(accounted_bytes(grant, &payload, &signature)?)
            .ok_or_else(|| GrantLedgerError::Corrupt("grant byte count overflow".into()))?;
        maximum_seq = Some(maximum_seq.map_or(issuer_seq, |old: u64| old.max(issuer_seq)));
    }

    drop(rows);
    drop(statement);
    if count != state.grant_count || total_bytes != state.total_bytes {
        return Err(GrantLedgerError::Corrupt(
            "grant state counters do not match stored grant rows".into(),
        ));
    }

    let control_maximum = validate_control_integrity(
        connection,
        control_verifier,
        state_issuer.as_deref(),
        limits,
    )?;
    let durable_maximum = match (maximum_seq, control_maximum) {
        (Some(grant), Some(control)) => Some(grant.max(control)),
        (grant, control) => grant.or(control),
    };
    if durable_maximum != state.last_issuer_seq {
        return Err(GrantLedgerError::Corrupt(
            "issuer sequence high-water does not match grants and controls".into(),
        ));
    }
    let reused_sequences: i64 = connection.query_row(
        "SELECT COUNT(*) FROM grants AS grant
         JOIN terminal_control_receipts AS control
           ON control.issuer_id = grant.issuer_id
          AND control.issuer_seq = grant.issuer_seq",
        [],
        |row| row.get(0),
    )?;
    if reused_sequences != 0 {
        return Err(GrantLedgerError::Corrupt(
            "issuer sequence is shared by a grant and control".into(),
        ));
    }
    validate_terminal_integrity(connection, state.grant_count)?;
    validate_latch_integrity(connection, limits)
}

fn validate_terminal_integrity(
    connection: &Connection,
    grant_count: u64,
) -> Result<(), GrantLedgerError> {
    let mut statement = connection.prepare(
        "SELECT event.event_seq, event.grant_id, event.payload_sha256, event.kind,
                event.occurred_at_unix_s, grant.payload_sha256
         FROM grant_terminal_events AS event
         JOIN grants AS grant ON grant.grant_id = event.grant_id
         ORDER BY event.event_seq",
    )?;
    let mut rows = statement.query([])?;
    let mut expected = 1_u64;
    let mut seen_grants = std::collections::HashSet::new();
    while let Some(row) = rows.next()? {
        let event_seq: i64 = row.get(0)?;
        let event_seq = u64::try_from(event_seq)
            .ok()
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                GrantLedgerError::Corrupt("terminal event sequence is invalid".into())
            })?;
        if event_seq != expected {
            return Err(GrantLedgerError::Corrupt(
                "terminal event sequence is not gap-free".into(),
            ));
        }
        let grant_id: String = row.get(1)?;
        if !seen_grants.insert(grant_id) {
            return Err(GrantLedgerError::Corrupt(
                "grant has more than one terminal receipt".into(),
            ));
        }
        let event_hash = decode_hash(row.get(2)?, "terminal payload hash")?;
        let kind: String = row.get(3)?;
        GrantTerminalKind::from_db(&kind)?;
        decode_u64(row.get(4)?, "terminal occurrence time")?;
        let grant_hash = decode_hash(row.get(5)?, "grant payload hash")?;
        if event_hash != grant_hash {
            return Err(GrantLedgerError::Corrupt(
                "terminal receipt does not match its admission".into(),
            ));
        }
        expected = expected
            .checked_add(1)
            .ok_or(GrantLedgerError::TerminalSequenceExhausted)?;
    }
    if expected.saturating_sub(1) > grant_count {
        return Err(GrantLedgerError::Corrupt(
            "terminal receipt count exceeds grant count".into(),
        ));
    }
    Ok(())
}

fn validate_control_integrity(
    connection: &Connection,
    verifier: Option<&TerminalControlVerifier>,
    state_issuer: Option<&str>,
    limits: GrantLedgerLimits,
) -> Result<Option<u64>, GrantLedgerError> {
    let mut statement = connection.prepare(
        "SELECT receipt_seq, control_id, issuer_id, issuer_seq, executor_id, policy_epoch,
                target_action, target_grant_id, target_grant_payload_sha256,
                target_profile_id, target_policy_sha256, issued_at_unix_s,
                expires_at_unix_s, admitted_at_unix_s, payload_sha256, payload_bytes, signature
         FROM terminal_control_receipts ORDER BY receipt_seq",
    )?;
    let mut rows = statement.query([])?;
    let mut expected_receipt = 1_u64;
    let mut count = 0_u64;
    let mut total_bytes = 0_u64;
    let mut maximum_seq = None;
    while let Some(row) = rows.next()? {
        let receipt_seq = positive_sequence(row.get(0)?, "control receipt")?;
        if receipt_seq != expected_receipt {
            return Err(GrantLedgerError::Corrupt(
                "control receipt sequence is not gap-free".into(),
            ));
        }
        let control_id: String = row.get(1)?;
        let issuer_id: String = row.get(2)?;
        let issuer_seq = decode_u64(row.get(3)?, "control issuer sequence")?;
        let executor_id: String = row.get(4)?;
        let policy_epoch = decode_u64(row.get(5)?, "control policy epoch")?;
        let action: String = row.get(6)?;
        let target_grant_id: Option<String> = row.get(7)?;
        let target_grant_hash: Option<Vec<u8>> = row.get(8)?;
        let target_profile_id: Option<String> = row.get(9)?;
        let target_policy_hash: Option<Vec<u8>> = row.get(10)?;
        let issued_at = decode_u64(row.get(11)?, "control issuance time")?;
        let expires_at = decode_u64(row.get(12)?, "control expiry")?;
        let admitted_at = decode_u64(row.get(13)?, "control admission time")?;
        let payload_hash = decode_hash(row.get(14)?, "control payload hash")?;
        let payload: Vec<u8> = row.get(15)?;
        let signature: Vec<u8> = row.get(16)?;

        if receipt_seq != count + 1
            || admitted_at < issued_at
            || admitted_at >= expires_at
            || payload.is_empty()
            || payload.len() > MAX_TERMINAL_CONTROL_PAYLOAD_BYTES
            || signature.len() != ED25519_SIGNATURE_BYTES
            || payload_hash != sha256(&payload)
        {
            return Err(GrantLedgerError::Corrupt(
                "stored terminal control metadata is invalid".into(),
            ));
        }
        let verifier = verifier.ok_or(GrantLedgerError::TerminalControlVerifierRequired)?;
        let authenticated = verifier
            .authenticate(&payload, &signature)
            .map_err(|error| {
                GrantLedgerError::Corrupt(format!(
                    "stored terminal control authentication failed: {error}"
                ))
            })?;
        let control = authenticated.control();
        if lower_hex_hash(authenticated.payload_sha256())? != payload_hash
            || control.control_id != control_id
            || control.issuer_id != issuer_id
            || control.issuer_seq != issuer_seq
            || control.executor_id != executor_id
            || control.policy_epoch != policy_epoch
            || control.issued_at_unix_s != issued_at
            || control.expires_at_unix_s != expires_at
            || state_issuer != Some(issuer_id.as_str())
            || !control_target_matches(
                connection,
                &control.target,
                &control.executor_id,
                StoredControlTarget {
                    action: &action,
                    grant_id: target_grant_id.as_deref(),
                    grant_hash: target_grant_hash.as_deref(),
                    profile_id: target_profile_id.as_deref(),
                    policy_hash: target_policy_hash.as_deref(),
                },
            )?
        {
            return Err(GrantLedgerError::Corrupt(
                "stored terminal control columns do not match canonical claims".into(),
            ));
        }
        count = count.checked_add(1).ok_or(GrantLedgerError::StorageLimit)?;
        total_bytes = total_bytes
            .checked_add(accounted_control_bytes(control, &payload, &signature)?)
            .ok_or(GrantLedgerError::StorageLimit)?;
        maximum_seq = Some(maximum_seq.map_or(issuer_seq, |old: u64| old.max(issuer_seq)));
        expected_receipt = expected_receipt
            .checked_add(1)
            .ok_or(GrantLedgerError::TerminalSequenceExhausted)?;
    }
    if count > limits.max_terminal_controls || total_bytes > limits.max_terminal_control_bytes {
        return Err(GrantLedgerError::StorageLimit);
    }
    Ok(maximum_seq)
}

struct StoredControlTarget<'a> {
    action: &'a str,
    grant_id: Option<&'a str>,
    grant_hash: Option<&'a [u8]>,
    profile_id: Option<&'a str>,
    policy_hash: Option<&'a [u8]>,
}

fn control_target_matches(
    connection: &Connection,
    target: &TerminalControlActionV1,
    executor_id: &str,
    stored: StoredControlTarget<'_>,
) -> Result<bool, GrantLedgerError> {
    match target {
        TerminalControlActionV1::RevokeGrant {
            grant_id,
            grant_payload_sha256,
        }
        | TerminalControlActionV1::FlagGrant {
            grant_id,
            grant_payload_sha256,
        } => {
            let expected_action = match target {
                TerminalControlActionV1::RevokeGrant { .. } => "revoke_grant",
                _ => "flag_grant",
            };
            let claim_hash = lower_hex_hash(grant_payload_sha256)?;
            let admitted: Option<(Vec<u8>, Vec<u8>)> = connection
                .query_row(
                    "SELECT payload_sha256, payload_bytes FROM grants WHERE grant_id = ?1",
                    params![grant_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let admitted_matches = admitted
                .map(|(hash, payload)| -> Result<bool, GrantLedgerError> {
                    let grant: GrantV1 = serde_json::from_slice(&payload).map_err(|error| {
                        GrantLedgerError::Corrupt(format!(
                            "control target grant is invalid: {error}"
                        ))
                    })?;
                    Ok(hash.as_slice() == claim_hash && grant.executor_id == executor_id)
                })
                .transpose()?
                .unwrap_or(false);
            Ok(stored.action == expected_action
                && stored.grant_id == Some(grant_id.as_str())
                && stored.grant_hash == Some(claim_hash.as_slice())
                && admitted_matches
                && stored.profile_id.is_none()
                && stored.policy_hash.is_none())
        }
        TerminalControlActionV1::ClearLatch {
            profile_id,
            policy_sha256,
        } => {
            let claim_hash = lower_hex_hash(policy_sha256)?;
            Ok(stored.action == "clear_latch"
                && stored.grant_id.is_none()
                && stored.grant_hash.is_none()
                && stored.profile_id == Some(profile_id.as_str())
                && stored.policy_hash == Some(claim_hash.as_slice()))
        }
    }
}

fn validate_latch_integrity(
    connection: &Connection,
    limits: GrantLedgerLimits,
) -> Result<(), GrantLedgerError> {
    let mut statement = connection.prepare(
        "SELECT event.event_seq, event.executor_id, event.profile_id, event.policy_sha256,
                event.kind, event.grant_id, event.control_id, event.occurred_at_unix_s,
                event.policy_bytes, grant.payload_bytes, grant.payload_sha256,
                control.executor_id, control.target_action, control.target_grant_id,
                control.target_grant_payload_sha256, control.target_profile_id,
                control.target_policy_sha256, control.issuer_seq, control.admitted_at_unix_s
         FROM policy_latch_events AS event
         LEFT JOIN grants AS grant ON grant.grant_id = event.grant_id
         JOIN terminal_control_receipts AS control ON control.control_id = event.control_id
         ORDER BY event.event_seq",
    )?;
    let mut rows = statement.query([])?;
    let mut expected = 1_u64;
    let mut count = 0_u64;
    let mut total_bytes = 0_u64;
    let mut states = std::collections::HashMap::new();
    while let Some(row) = rows.next()? {
        let sequence = positive_sequence(row.get(0)?, "policy latch event")?;
        if sequence != expected {
            return Err(GrantLedgerError::Corrupt(
                "policy latch event sequence is not gap-free".into(),
            ));
        }
        let executor_id: String = row.get(1)?;
        let profile_id: String = row.get(2)?;
        let policy_hash = decode_hash(row.get(3)?, "latch policy hash")?;
        let kind: String = row.get(4)?;
        let grant_id: Option<String> = row.get(5)?;
        let control_id: String = row.get(6)?;
        let occurred_at = decode_u64(row.get(7)?, "latch occurrence time")?;
        let policy_bytes: Option<Vec<u8>> = row.get(8)?;
        let control_executor: String = row.get(11)?;
        let control_action: String = row.get(12)?;
        let control_grant_id: Option<String> = row.get(13)?;
        let control_grant_hash: Option<Vec<u8>> = row.get(14)?;
        let control_profile_id: Option<String> = row.get(15)?;
        let control_policy_hash: Option<Vec<u8>> = row.get(16)?;
        let control_sequence = decode_u64(row.get(17)?, "latch control issuer sequence")?;
        let admitted_at = decode_u64(row.get(18)?, "latch control admission time")?;

        let source_matches = if kind == "flag" {
            let grant_payload: Option<Vec<u8>> = row.get(9)?;
            let grant_payload_hash: Option<Vec<u8>> = row.get(10)?;
            let grant: Option<GrantV1> = grant_payload
                .map(|payload| serde_json::from_slice(&payload))
                .transpose()
                .map_err(|error| {
                    GrantLedgerError::Corrupt(format!("flag latch grant is invalid: {error}"))
                })?;
            let policy = policy_bytes
                .as_deref()
                .map(CanonicalSensitivePolicy::parse)
                .transpose()
                .map_err(|error| {
                    GrantLedgerError::Corrupt(format!("flag latch policy is invalid: {error}"))
                })?;
            grant_id.is_some()
                && control_executor == executor_id
                && control_action == "flag_grant"
                && control_grant_id == grant_id
                && control_grant_hash == grant_payload_hash
                && control_profile_id.is_none()
                && control_policy_hash.is_none()
                && grant.as_ref().is_some_and(|grant| {
                    grant.executor_id == executor_id
                        && lower_hex_hash(&grant.policy_sha256)
                            .is_ok_and(|hash| hash == policy_hash)
                })
                && policy.as_ref().is_some_and(|policy| {
                    policy.policy().profile_id == profile_id
                        && lower_hex_hash(policy.policy_sha256())
                            .is_ok_and(|hash| hash == policy_hash)
                })
        } else if kind == "clear" {
            grant_id.is_none()
                && policy_bytes.is_none()
                && control_executor == executor_id
                && control_action == "clear_latch"
                && control_grant_id.is_none()
                && control_grant_hash.is_none()
                && control_profile_id.as_deref() == Some(profile_id.as_str())
                && control_policy_hash.as_deref() == Some(policy_hash.as_slice())
        } else {
            false
        };
        let key = (executor_id.clone(), profile_id.clone(), policy_hash);
        let transition_matches = match states.get(&key) {
            None => kind == "flag",
            Some((previous_kind, previous_sequence)) => {
                control_sequence > *previous_sequence
                    && ((previous_kind == "flag" && kind == "clear")
                        || (previous_kind == "clear" && kind == "flag"))
            }
        };
        if !source_matches || !transition_matches || occurred_at == 0 || occurred_at < admitted_at {
            return Err(GrantLedgerError::Corrupt(
                "policy latch event does not match its exact source and sequence".into(),
            ));
        }
        total_bytes = total_bytes
            .checked_add(accounted_latch_bytes(
                &executor_id,
                &profile_id,
                &kind,
                grant_id.as_deref(),
                &control_id,
                policy_bytes.as_deref(),
            )?)
            .ok_or(GrantLedgerError::StorageLimit)?;
        states.insert(key, (kind, control_sequence));
        count = count.checked_add(1).ok_or(GrantLedgerError::StorageLimit)?;
        expected = expected
            .checked_add(1)
            .ok_or(GrantLedgerError::TerminalSequenceExhausted)?;
    }
    if count > limits.max_latch_events || total_bytes > limits.max_latch_bytes {
        return Err(GrantLedgerError::StorageLimit);
    }
    Ok(())
}

fn positive_sequence(value: i64, field: &str) -> Result<u64, GrantLedgerError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| GrantLedgerError::Corrupt(format!("{field} sequence is invalid")))
}

fn lower_hex_hash(value: &str) -> Result<[u8; 32], GrantLedgerError> {
    if value.len() != 64
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f'))
    {
        return Err(GrantLedgerError::Corrupt(
            "canonical SHA-256 claim is invalid".into(),
        ));
    }
    let mut result = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let nibble = |byte: u8| -> u8 {
            match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                _ => unreachable!(),
            }
        };
        result[index] = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    Ok(result)
}

fn accounted_control_bytes(
    control: &TerminalControlV1,
    payload: &[u8],
    signature: &[u8],
) -> Result<u64, GrantLedgerError> {
    let target_bytes = match &control.target {
        TerminalControlActionV1::RevokeGrant { grant_id, .. }
        | TerminalControlActionV1::FlagGrant { grant_id, .. } => grant_id.len() + 32,
        TerminalControlActionV1::ClearLatch { profile_id, .. } => profile_id.len() + 32,
    };
    [
        8,
        control.control_id.len(),
        control.issuer_id.len(),
        8,
        control.executor_id.len(),
        8,
        target_bytes,
        8,
        8,
        8,
        32,
        payload.len(),
        signature.len(),
    ]
    .into_iter()
    .try_fold(0_u64, |total, length| {
        total
            .checked_add(length as u64)
            .ok_or(GrantLedgerError::InvalidLimits)
    })
}

fn accounted_latch_bytes(
    executor_id: &str,
    profile_id: &str,
    kind: &str,
    grant_id: Option<&str>,
    control_id: &str,
    policy_bytes: Option<&[u8]>,
) -> Result<u64, GrantLedgerError> {
    [
        8,
        executor_id.len(),
        profile_id.len(),
        32,
        kind.len(),
        grant_id.map_or(0, str::len),
        control_id.len(),
        8,
        policy_bytes.map_or(0, <[u8]>::len),
    ]
    .into_iter()
    .try_fold(0_u64, |total, length| {
        total
            .checked_add(length as u64)
            .ok_or(GrantLedgerError::InvalidLimits)
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use elpis_grants::{
        GRANT_VERSION, GrantMode, GuestPersistence, SENSITIVE_POLICY_VERSION, SensitiveBudgets,
        SensitiveClassifierPolicy, SensitivePersistencePolicy, SensitivePolicyV1,
        TERMINAL_CONTROL_VERSION, TerminalControlActionV1, TerminalControlV1, signature_input,
        terminal_control_signature_input,
    };
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use tempfile::TempDir;

    use super::*;

    const NOW: u64 = 1_700_000_100;
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const NONCE: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn key(seed: u8) -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap()
    }

    fn verifier_with_seed(seed: u8) -> GrantVerifier {
        let key = key(seed);
        GrantVerifier::new(
            "operator-1",
            key.public_key().as_ref(),
            "executor-1",
            3,
            900,
        )
        .unwrap()
    }

    fn verifier() -> GrantVerifier {
        verifier_with_seed(7)
    }

    fn control_verifier_with_seed(seed: u8) -> TerminalControlVerifier {
        let key = key(seed);
        TerminalControlVerifier::new(
            "operator-1",
            key.public_key().as_ref(),
            "executor-1",
            3,
            900,
        )
        .unwrap()
    }

    fn control_verifier() -> TerminalControlVerifier {
        control_verifier_with_seed(7)
    }

    fn binding() -> GrantBinding {
        binding_for_policy(HASH_C)
    }

    fn binding_for_policy(policy_sha256: &str) -> GrantBinding {
        GrantBinding {
            mind_id: "elm-test".into(),
            mandate_sha256: HASH_A.into(),
            runtime_sha256: HASH_B.into(),
            policy_sha256: policy_sha256.into(),
        }
    }

    fn latch_policy_fixture() -> (Vec<u8>, String) {
        let policy = SensitivePolicyV1 {
            version: SENSITIVE_POLICY_VERSION,
            profile_id: "sensitive-v1".into(),
            capabilities: Vec::new(),
            budgets: SensitiveBudgets {
                max_runs: 1,
                max_effects: 0,
                max_lease_s: 300,
                max_wall_ms: 1_000,
                max_cpu_ms: 1_000,
                max_rss_bytes: 1_048_576,
                max_io_read_bytes: 1_048_576,
                max_io_write_bytes: 1_048_576,
                max_scratch_bytes: 1_048_576,
            },
            classifier: SensitiveClassifierPolicy::Disabled,
            persistence: SensitivePersistencePolicy {
                guest_persistence: GuestPersistence::Disabled,
                max_artifacts: 0,
                max_total_artifact_bytes: 0,
            },
        };
        let bytes = policy.canonical_bytes().unwrap();
        let canonical = CanonicalSensitivePolicy::parse(&bytes).unwrap();
        (bytes, canonical.policy_sha256().to_owned())
    }

    fn grant(id: &str, sequence: u64) -> GrantV1 {
        GrantV1 {
            version: GRANT_VERSION,
            grant_id: id.into(),
            issuer_id: "operator-1".into(),
            issuer_seq: sequence,
            executor_id: "executor-1".into(),
            policy_epoch: 3,
            not_before_unix_s: NOW,
            expires_at_unix_s: NOW + 600,
            mind_id: "elm-test".into(),
            mandate_sha256: HASH_A.into(),
            runtime_sha256: HASH_B.into(),
            policy_sha256: HASH_C.into(),
            mode: GrantMode::SensitiveGranted,
            nonce: NONCE.into(),
        }
    }

    fn latch_grant(id: &str, sequence: u64, policy_sha256: &str) -> GrantV1 {
        let mut grant = grant(id, sequence);
        grant.policy_sha256 = policy_sha256.into();
        grant
    }

    fn signed(grant: &GrantV1) -> (Vec<u8>, Vec<u8>) {
        let payload = grant.canonical_payload().unwrap();
        let signature = key(7)
            .sign(&signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        (payload, signature)
    }

    struct TestLedger {
        _temp: TempDir,
        path: PathBuf,
        ledger: GrantLedger,
    }

    fn test_ledger(limits: GrantLedgerLimits) -> TestLedger {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private").join("grants.sqlite");
        let ledger = GrantLedger::open_with_terminal_control_verifier_and_clock(
            &path,
            verifier(),
            control_verifier(),
            limits,
            Clock::Fixed(NOW),
        )
        .unwrap();
        TestLedger {
            _temp: temp,
            path,
            ledger,
        }
    }

    fn default_test_ledger() -> TestLedger {
        test_ledger(GrantLedgerLimits::default())
    }

    fn open_with_control_clock(
        path: &Path,
        verifier: GrantVerifier,
        limits: GrantLedgerLimits,
        clock: Clock,
    ) -> Result<GrantLedger, GrantLedgerError> {
        GrantLedger::open_with_terminal_control_verifier_and_clock(
            path,
            verifier,
            control_verifier(),
            limits,
            clock,
        )
    }

    fn admit(ledger: &mut GrantLedger, id: &str, sequence: u64) -> ActiveGrant {
        let (payload, signature) = signed(&grant(id, sequence));
        ledger.admit(&payload, &signature, &binding()).unwrap()
    }

    fn duplicate_active(active: &ActiveGrant) -> ActiveGrant {
        ActiveGrant {
            grant: active.grant.clone(),
            payload_sha256: active.payload_sha256,
            ledger_binding: active.ledger_binding,
        }
    }

    fn downgrade_v4_to_v3(connection: &Connection) {
        connection
            .execute_batch(
                "DROP TRIGGER policy_latch_events_immutable;
                 DROP TRIGGER policy_latch_events_no_delete;
                 DROP TABLE policy_latch_events;
                 DROP TRIGGER terminal_control_receipts_immutable;
                 DROP TRIGGER terminal_control_receipts_no_delete;
                 DROP TRIGGER terminal_control_receipts_shared_sequence;
                 DROP TRIGGER grant_rows_shared_sequence;
                 DROP TABLE terminal_control_receipts;
                 DROP TRIGGER grant_state_no_delete;
                 DROP TRIGGER grant_state_sequence_monotonic;
                 ALTER TABLE grant_state RENAME TO grant_state_v4;
                 CREATE TABLE grant_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    issuer_id TEXT,
                    last_issuer_seq BLOB,
                    grant_count INTEGER NOT NULL CHECK (grant_count >= 0),
                    total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
                    CHECK (
                        (issuer_id IS NULL AND last_issuer_seq IS NULL AND grant_count = 0)
                        OR
                        (typeof(issuer_id) = 'text'
                         AND length(CAST(issuer_id AS BLOB)) BETWEEN 1 AND 120
                         AND issuer_id NOT GLOB '*[^A-Za-z0-9._:-]*'
                         AND typeof(last_issuer_seq) = 'blob'
                         AND length(last_issuer_seq) = 8
                         AND last_issuer_seq != zeroblob(8)
                         AND grant_count > 0)
                    )
                 );
                 INSERT INTO grant_state
                 SELECT * FROM grant_state_v4;
                 DROP TABLE grant_state_v4;
                 CREATE TRIGGER grant_state_no_delete
                 BEFORE DELETE ON grant_state
                 BEGIN SELECT RAISE(ABORT, 'grant state cannot be deleted'); END;
                 CREATE TRIGGER grant_state_sequence_monotonic
                 BEFORE UPDATE OF issuer_id, last_issuer_seq ON grant_state
                 WHEN NOT (
                    (OLD.issuer_id IS NULL AND OLD.last_issuer_seq IS NULL
                     AND NEW.issuer_id IS NOT NULL AND NEW.last_issuer_seq IS NOT NULL)
                    OR
                    (OLD.issuer_id = NEW.issuer_id
                     AND typeof(NEW.last_issuer_seq) = 'blob'
                     AND NEW.last_issuer_seq > OLD.last_issuer_seq)
                 )
                 BEGIN SELECT RAISE(ABORT, 'issuer sequence must advance'); END;
                 PRAGMA user_version = 3;",
            )
            .unwrap();
    }

    fn flag_control(id: &str, sequence: u64, grant: &GrantV1) -> TerminalControlV1 {
        let payload = grant.canonical_payload().unwrap();
        TerminalControlV1 {
            version: TERMINAL_CONTROL_VERSION,
            control_id: id.into(),
            issuer_id: "operator-1".into(),
            issuer_seq: sequence,
            executor_id: "executor-1".into(),
            policy_epoch: 3,
            target: TerminalControlActionV1::FlagGrant {
                grant_id: grant.grant_id.clone(),
                grant_payload_sha256: sha256(&payload)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            },
            issued_at_unix_s: NOW,
            expires_at_unix_s: NOW + 300,
            nonce: NONCE.into(),
        }
    }

    fn clear_control(id: &str, sequence: u64) -> TerminalControlV1 {
        clear_control_for_policy(id, sequence, HASH_C)
    }

    fn clear_control_for_policy(id: &str, sequence: u64, policy_sha256: &str) -> TerminalControlV1 {
        TerminalControlV1 {
            version: TERMINAL_CONTROL_VERSION,
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
            expires_at_unix_s: NOW + 300,
            nonce: NONCE.into(),
        }
    }

    fn insert_control_row(connection: &Connection, control: &TerminalControlV1) {
        let payload = control.canonical_payload().unwrap();
        let signature = key(7)
            .sign(&terminal_control_signature_input(&payload).unwrap())
            .as_ref()
            .to_vec();
        let (action, grant_id, grant_hash, profile_id, policy_hash) = match &control.target {
            TerminalControlActionV1::RevokeGrant {
                grant_id,
                grant_payload_sha256,
            } => (
                "revoke_grant",
                Some(grant_id.as_str()),
                Some(lower_hex_hash(grant_payload_sha256).unwrap()),
                None,
                None,
            ),
            TerminalControlActionV1::FlagGrant {
                grant_id,
                grant_payload_sha256,
            } => (
                "flag_grant",
                Some(grant_id.as_str()),
                Some(lower_hex_hash(grant_payload_sha256).unwrap()),
                None,
                None,
            ),
            TerminalControlActionV1::ClearLatch {
                profile_id,
                policy_sha256,
            } => (
                "clear_latch",
                None,
                None,
                Some(profile_id.as_str()),
                Some(lower_hex_hash(policy_sha256).unwrap()),
            ),
        };
        let next: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(receipt_seq), 0) + 1 FROM terminal_control_receipts",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO terminal_control_receipts (
                    receipt_seq, control_id, issuer_id, issuer_seq, executor_id, policy_epoch,
                    target_action, target_grant_id, target_grant_payload_sha256,
                    target_profile_id, target_policy_sha256, issued_at_unix_s,
                    expires_at_unix_s, admitted_at_unix_s, payload_sha256, payload_bytes, signature
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    next,
                    control.control_id,
                    control.issuer_id,
                    u64_blob(control.issuer_seq).as_slice(),
                    control.executor_id,
                    u64_blob(control.policy_epoch).as_slice(),
                    action,
                    grant_id,
                    grant_hash.as_ref().map(|hash| hash.as_slice()),
                    profile_id,
                    policy_hash.as_ref().map(|hash| hash.as_slice()),
                    u64_blob(control.issued_at_unix_s).as_slice(),
                    u64_blob(control.expires_at_unix_s).as_slice(),
                    u64_blob(NOW).as_slice(),
                    sha256(&payload).as_slice(),
                    payload,
                    signature,
                ],
            )
            .unwrap();
    }

    fn insert_control(connection: &Connection, control: &TerminalControlV1) {
        insert_control_row(connection, control);
        let current: Option<Vec<u8>> = connection
            .query_row(
                "SELECT last_issuer_seq FROM grant_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        match current {
            Some(last) => {
                assert!(control.issuer_seq > decode_u64(last.clone(), "test sequence").unwrap());
                connection
                    .execute(
                        "UPDATE grant_state SET last_issuer_seq = ?1 WHERE singleton = 1 AND last_issuer_seq = ?2",
                        params![u64_blob(control.issuer_seq).as_slice(), last],
                    )
                    .unwrap();
            }
            None => {
                connection
                    .execute(
                        "UPDATE grant_state SET issuer_id = ?1, last_issuer_seq = ?2
                         WHERE singleton = 1 AND issuer_id IS NULL",
                        params![control.issuer_id, u64_blob(control.issuer_seq).as_slice()],
                    )
                    .unwrap();
            }
        }
    }

    #[test]
    fn newly_inserted_signed_grant_is_the_only_path_to_active_authority() {
        let mut test = default_test_ledger();
        let claim = grant("grant-1", 8);
        let (payload, signature) = signed(&claim);
        let active = test.ledger.admit(&payload, &signature, &binding()).unwrap();
        assert_eq!(active.grant(), &claim);
        assert_eq!(active.payload_sha256(), &sha256(&payload));

        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::Replay)
        ));
        let connection = Connection::open(&test.path).unwrap();
        let (rows, state_count): (i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM grants), grant_count FROM grant_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, state_count), (1, 1));
    }

    #[test]
    fn authentication_and_canonical_encoding_are_enforced_inside_admit() {
        let mut test = default_test_ledger();
        let (payload, mut signature) = signed(&grant("grant-1", 8));
        signature[0] ^= 1;
        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::Grant(GrantError::InvalidSignature))
        ));

        let canonical = String::from_utf8(payload).unwrap();
        let noncanonical = format!(" {canonical}").into_bytes();
        let signature = key(7).sign(&signature_input(&noncanonical).unwrap());
        assert!(matches!(
            test.ledger
                .admit(&noncanonical, signature.as_ref(), &binding()),
            Err(GrantLedgerError::Grant(GrantError::NonCanonical))
        ));

        let (payload, signature) = signed(&grant("grant-2", 9));
        let mut wrong_binding = binding();
        wrong_binding.mind_id = "elm-other".into();
        assert!(matches!(
            test.ledger.admit(&payload, &signature, &wrong_binding),
            Err(GrantLedgerError::Grant(GrantError::BindingMismatch))
        ));
    }

    #[test]
    fn internal_clock_uses_inclusive_not_before_and_exclusive_expiry() {
        let cases = [
            (NOW - 1, GrantLedgerError::NotYetValid),
            (NOW + 600, GrantLedgerError::Expired),
        ];
        for (clock, expected) in cases {
            let mut test = default_test_ledger();
            test.ledger.clock = Clock::Fixed(clock);
            let (payload, signature) = signed(&grant("grant-time", 1));
            let error = test
                .ledger
                .admit(&payload, &signature, &binding())
                .unwrap_err();
            assert_eq!(
                std::mem::discriminant(&error),
                std::mem::discriminant(&expected)
            );
        }

        let mut test = default_test_ledger();
        let (payload, signature) = signed(&grant("grant-start", 1));
        test.ledger.admit(&payload, &signature, &binding()).unwrap();

        let mut test = default_test_ledger();
        test.ledger.clock = Clock::Fixed(NOW + 599);
        let (payload, signature) = signed(&grant("grant-last-second", 1));
        test.ledger.admit(&payload, &signature, &binding()).unwrap();
    }

    #[test]
    fn id_sequence_and_high_water_uniqueness_fail_closed() {
        let mut test = default_test_ledger();
        let (payload, signature) = signed(&grant("grant-1", 8));
        test.ledger.admit(&payload, &signature, &binding()).unwrap();

        let (payload, signature) = signed(&grant("grant-1", 9));
        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::GrantIdConflict)
        ));
        let (payload, signature) = signed(&grant("grant-2", 8));
        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::IssuerSequenceReplay)
        ));
        let (payload, signature) = signed(&grant("grant-3", 7));
        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::StaleIssuerSequence)
        ));

        let (payload, signature) = signed(&grant("grant-4", 10));
        test.ledger.admit(&payload, &signature, &binding()).unwrap();
        drop(test.ledger);
        let mut reopened = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        let (payload, signature) = signed(&grant("grant-5", 9));
        assert!(matches!(
            reopened.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::StaleIssuerSequence)
        ));
    }

    #[test]
    fn concurrent_same_sequence_admission_mints_exactly_one_authority() {
        use std::sync::{Arc, Barrier};

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private").join("grants.sqlite");
        drop(
            GrantLedger::open_with_clock(
                &path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            )
            .unwrap(),
        );
        let barrier = Arc::new(Barrier::new(2));
        let handles = ["grant-race-a", "grant-race-b"].map(|id| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let (payload, signature) = signed(&grant(id, 42));
            std::thread::spawn(move || {
                let mut ledger = GrantLedger::open_with_clock(
                    &path,
                    verifier(),
                    GrantLedgerLimits::default(),
                    Clock::Fixed(NOW),
                )
                .unwrap();
                barrier.wait();
                match ledger.admit(&payload, &signature, &binding()) {
                    Ok(_active) => true,
                    Err(GrantLedgerError::IssuerSequenceReplay) => false,
                    Err(error) => panic!("unexpected concurrent admission result: {error}"),
                }
            })
        });
        let admitted = handles
            .into_iter()
            .map(|handle| handle.join().unwrap() as usize)
            .sum::<usize>();
        assert_eq!(admitted, 1);

        let connection = Connection::open(&path).unwrap();
        let (rows, count, sequence): (i64, i64, Vec<u8>) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM grants), grant_count, last_issuer_seq
                 FROM grant_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((rows, count), (1, 1));
        assert_eq!(decode_u64(sequence, "last issuer sequence").unwrap(), 42);
    }

    #[test]
    fn capacity_failure_rolls_back_insert_and_sequence_together() {
        let claim = grant("grant-limited", 42);
        let (payload, signature) = signed(&claim);
        let bytes = accounted_bytes(&claim, &payload, &signature).unwrap();
        let mut test = test_ledger(GrantLedgerLimits {
            max_grants: 1,
            max_bytes: bytes - 1,
            ..GrantLedgerLimits::default()
        });
        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::StorageLimit)
        ));
        drop(test.ledger);

        let mut reopened = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits {
                max_grants: 1,
                max_bytes: bytes,
                ..GrantLedgerLimits::default()
            },
            Clock::Fixed(NOW),
        )
        .unwrap();
        reopened.admit(&payload, &signature, &binding()).unwrap();
    }

    #[test]
    fn state_update_failure_rolls_back_insert_and_sequence_before_authority() {
        let mut test = default_test_ledger();
        test.ledger
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_grant_state_update
                 BEFORE UPDATE ON grant_state
                 BEGIN SELECT RAISE(ABORT, 'injected state failure'); END;",
            )
            .unwrap();
        let (payload, signature) = signed(&grant("grant-failure", 42));

        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::Sql(_))
        ));
        let (rows, count, issuer, sequence): (i64, i64, Option<String>, Option<Vec<u8>>) = test
            .ledger
            .connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM grants), grant_count, issuer_id, last_issuer_seq
                 FROM grant_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((rows, count, issuer, sequence), (0, 0, None, None));

        test.ledger
            .connection
            .execute_batch("DROP TRIGGER fail_grant_state_update")
            .unwrap();
        test.ledger.admit(&payload, &signature, &binding()).unwrap();
    }

    #[test]
    fn opening_checks_configured_limits_and_verifier_against_durable_rows() {
        let mut test = default_test_ledger();
        let (payload, signature) = signed(&grant("grant-1", 8));
        test.ledger.admit(&payload, &signature, &binding()).unwrap();
        drop(test.ledger);

        assert!(matches!(
            GrantLedger::open_with_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits {
                    max_grants: 1,
                    max_bytes: 1,
                    ..GrantLedgerLimits::default()
                },
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::StorageLimit)
        ));
        assert!(matches!(
            GrantLedger::open_with_clock(
                &test.path,
                verifier_with_seed(9),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
    }

    #[test]
    fn terminal_receipts_are_gap_free_append_only_and_queryable() {
        let mut test = default_test_ledger();
        let complete = admit(&mut test.ledger, "grant-complete", 1);
        let revoke = admit(&mut test.ledger, "grant-revoke", 2);
        let flag = admit(&mut test.ledger, "grant-flag", 3);

        let receipts = [
            test.ledger.complete(complete).unwrap(),
            test.ledger.revoke(revoke).unwrap(),
            test.ledger.flag(flag).unwrap(),
        ];
        assert_eq!(
            receipts
                .iter()
                .map(|receipt| (receipt.event_seq(), receipt.kind()))
                .collect::<Vec<_>>(),
            vec![
                (1, GrantTerminalKind::Completed),
                (2, GrantTerminalKind::Revoked),
                (3, GrantTerminalKind::Flagged),
            ]
        );
        for receipt in &receipts {
            assert_eq!(receipt.occurred_at_unix_s(), NOW);
            assert_eq!(
                test.ledger.terminal_receipt(receipt.grant_id()).unwrap(),
                Some(receipt.clone())
            );
        }
        let connection = Connection::open(&test.path).unwrap();
        assert!(
            connection
                .execute("DELETE FROM grant_terminal_events", [])
                .is_err()
        );
        assert!(
            connection
                .execute(
                    "UPDATE grant_terminal_events SET kind = 'flagged' WHERE event_seq = 1",
                    [],
                )
                .is_err()
        );
    }

    #[test]
    fn terminal_tokens_reject_wrong_ledger_mismatch_and_duplicate_settlement() {
        let mut test = default_test_ledger();
        let active = admit(&mut test.ledger, "grant-complete", 1);
        let duplicate = duplicate_active(&active);
        test.ledger.complete(active).unwrap();
        assert!(matches!(
            test.ledger.revoke(duplicate),
            Err(GrantLedgerError::AlreadyTerminal)
        ));

        let active = admit(&mut test.ledger, "grant-wrong-ledger", 2);
        let mut other = default_test_ledger();
        assert!(matches!(
            other.ledger.complete(active),
            Err(GrantLedgerError::WrongLedger)
        ));

        let active = admit(&mut test.ledger, "grant-mismatch", 3);
        let forged = ActiveGrant {
            grant: active.grant.clone(),
            payload_sha256: [0x55; 32],
            ledger_binding: active.ledger_binding,
        };
        assert!(matches!(
            test.ledger.complete(forged),
            Err(GrantLedgerError::ActiveGrantMismatch)
        ));
    }

    #[test]
    fn concurrent_duplicate_terminal_tokens_settle_exactly_once() {
        use std::sync::{Arc, Barrier};

        let mut test = default_test_ledger();
        let mut other = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        let active = admit(&mut test.ledger, "grant-race", 1);
        let duplicate = duplicate_active(&active);
        let barrier = Arc::new(Barrier::new(2));
        let first_barrier = Arc::clone(&barrier);
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            match test.ledger.complete(active) {
                Ok(receipt) => Some(receipt.kind()),
                Err(GrantLedgerError::AlreadyTerminal) => None,
                Err(error) => panic!("unexpected first terminal result: {error}"),
            }
        });
        let second = std::thread::spawn(move || {
            barrier.wait();
            match other.revoke(duplicate) {
                Ok(receipt) => Some(receipt.kind()),
                Err(GrantLedgerError::AlreadyTerminal) => None,
                Err(error) => panic!("unexpected second terminal result: {error}"),
            }
        });
        let results = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_some()).count(), 1);
        assert!(results.contains(&None));
    }

    #[test]
    fn terminal_persistence_failure_rolls_back_event_and_consumes_call_token() {
        let mut test = default_test_ledger();
        let active = admit(&mut test.ledger, "grant-failure", 1);
        test.ledger
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_terminal_insert
                 BEFORE INSERT ON grant_terminal_events
                 BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;",
            )
            .unwrap();
        assert!(matches!(
            test.ledger.complete(active),
            Err(GrantLedgerError::Sql(_))
        ));
        assert_eq!(test.ledger.terminal_receipt("grant-failure").unwrap(), None);
        test.ledger
            .connection
            .execute_batch("DROP TRIGGER fail_terminal_insert")
            .unwrap();
        let next = admit(&mut test.ledger, "grant-next", 2);
        assert_eq!(test.ledger.complete(next).unwrap().event_seq(), 1);
    }

    #[test]
    fn expire_due_uses_internal_clock_and_leaves_future_authority_live() {
        let mut test = default_test_ledger();
        let mut due_grant = grant("grant-due", 1);
        due_grant.expires_at_unix_s = NOW + 10;
        let (payload, signature) = signed(&due_grant);
        let due = test.ledger.admit(&payload, &signature, &binding()).unwrap();
        let future = admit(&mut test.ledger, "grant-future", 2);
        test.ledger.clock = Clock::Fixed(NOW + 10);

        let receipts = test.ledger.expire_due().unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(
            (
                receipts[0].grant_id(),
                receipts[0].event_seq(),
                receipts[0].kind()
            ),
            ("grant-due", 1, GrantTerminalKind::Expired)
        );
        assert!(test.ledger.expire_due().unwrap().is_empty());
        assert!(matches!(
            test.ledger.complete(due),
            Err(GrantLedgerError::AlreadyTerminal)
        ));
        let completed = test.ledger.complete(future).unwrap();
        assert_eq!(
            (completed.event_seq(), completed.kind()),
            (2, GrantTerminalKind::Completed)
        );
    }

    #[test]
    fn cold_open_expires_due_grants_interrupts_the_rest_and_fences_stale_tokens() {
        let mut test = default_test_ledger();
        let mut due_grant = grant("grant-due", 1);
        due_grant.expires_at_unix_s = NOW + 5;
        let (payload, signature) = signed(&due_grant);
        let due = test.ledger.admit(&payload, &signature, &binding()).unwrap();
        let future = admit(&mut test.ledger, "grant-future", 2);
        drop(test.ledger);

        let mut reopened = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW + 5),
        )
        .unwrap();
        let due_receipt = reopened.terminal_receipt("grant-due").unwrap().unwrap();
        let future_receipt = reopened.terminal_receipt("grant-future").unwrap().unwrap();
        assert_eq!(
            (due_receipt.event_seq(), due_receipt.kind()),
            (1, GrantTerminalKind::Expired)
        );
        assert_eq!(
            (future_receipt.event_seq(), future_receipt.kind()),
            (2, GrantTerminalKind::Interrupted)
        );
        assert!(matches!(
            reopened.complete(due),
            Err(GrantLedgerError::AlreadyTerminal)
        ));
        assert!(matches!(
            reopened.complete(future),
            Err(GrantLedgerError::AlreadyTerminal)
        ));
        drop(reopened);

        let reopened = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW + 20),
        )
        .unwrap();
        let count: i64 = reopened
            .connection
            .query_row("SELECT COUNT(*) FROM grant_terminal_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn cold_open_recovery_failure_rolls_back_all_receipts_before_return() {
        let mut test = default_test_ledger();
        let _first = admit(&mut test.ledger, "grant-first", 1);
        let _second = admit(&mut test.ledger, "grant-second", 2);
        drop(test.ledger);
        let connection = Connection::open(&test.path).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER fail_cold_recovery
                 BEFORE INSERT ON grant_terminal_events
                 WHEN NEW.grant_id = 'grant-second'
                 BEGIN SELECT RAISE(ABORT, 'injected cold recovery failure'); END;",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            GrantLedger::open_with_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Sql(_))
        ));
        let connection = Connection::open(&test.path).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM grant_terminal_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        connection
            .execute_batch("DROP TRIGGER fail_cold_recovery")
            .unwrap();
        drop(connection);

        let reopened = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        let first = reopened.terminal_receipt("grant-first").unwrap().unwrap();
        let second = reopened.terminal_receipt("grant-second").unwrap().unwrap();
        assert_eq!(
            (first.event_seq(), first.kind()),
            (1, GrantTerminalKind::Interrupted)
        );
        assert_eq!(
            (second.event_seq(), second.kind()),
            (2, GrantTerminalKind::Interrupted)
        );
    }

    #[test]
    fn concurrent_second_open_interrupts_and_fences_the_first_owner() {
        let mut first = default_test_ledger();
        let active = admit(&mut first.ledger, "grant-live", 1);
        let second = GrantLedger::open_with_clock(
            &first.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        let receipt = second.terminal_receipt("grant-live").unwrap().unwrap();
        assert_eq!(receipt.kind(), GrantTerminalKind::Interrupted);
        assert!(matches!(
            first.ledger.complete(active),
            Err(GrantLedgerError::AlreadyTerminal)
        ));
    }

    #[test]
    fn expire_due_failure_rolls_back_and_can_be_retried_without_a_token() {
        let mut test = default_test_ledger();
        let mut due_grant = grant("grant-due", 1);
        due_grant.expires_at_unix_s = NOW + 1;
        let (payload, signature) = signed(&due_grant);
        let _active = test.ledger.admit(&payload, &signature, &binding()).unwrap();
        test.ledger.clock = Clock::Fixed(NOW + 1);
        test.ledger
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_expiry
                 BEFORE INSERT ON grant_terminal_events
                 BEGIN SELECT RAISE(ABORT, 'injected expiry failure'); END;",
            )
            .unwrap();
        assert!(matches!(
            test.ledger.expire_due(),
            Err(GrantLedgerError::Sql(_))
        ));
        assert_eq!(test.ledger.terminal_receipt("grant-due").unwrap(), None);
        test.ledger
            .connection
            .execute_batch("DROP TRIGGER fail_expiry")
            .unwrap();
        let receipts = test.ledger.expire_due().unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].kind(), GrantTerminalKind::Expired);
    }

    #[test]
    fn schema_v3_migration_preserves_grants_and_terminal_receipts_exactly() {
        let mut test = default_test_ledger();
        let active = admit(&mut test.ledger, "grant-v3", 7);
        test.ledger.complete(active).unwrap();
        drop(test.ledger);
        let connection = Connection::open(&test.path).unwrap();
        let before_grant: (String, String, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) = connection
            .query_row(
                "SELECT grant_id, issuer_id, issuer_seq, payload_sha256, payload_bytes, signature
                 FROM grants WHERE grant_id = 'grant-v3'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        let before_terminal: (i64, String, Vec<u8>, String, Vec<u8>) = connection
            .query_row(
                "SELECT event_seq, grant_id, payload_sha256, kind, occurred_at_unix_s
                 FROM grant_terminal_events",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        downgrade_v4_to_v3(&connection);
        drop(connection);

        let migrated = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        let after_grant = migrated
            .connection
            .query_row(
                "SELECT grant_id, issuer_id, issuer_seq, payload_sha256, payload_bytes, signature
                 FROM grants WHERE grant_id = 'grant-v3'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        let after_terminal = migrated
            .connection
            .query_row(
                "SELECT event_seq, grant_id, payload_sha256, kind, occurred_at_unix_s
                 FROM grant_terminal_events",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(before_grant, after_grant);
        assert_eq!(before_terminal, after_terminal);
        assert_eq!(
            migrated
                .connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn schema_v3_migration_failure_rolls_back_state_objects_and_version() {
        let mut test = default_test_ledger();
        let active = admit(&mut test.ledger, "grant-v3", 7);
        test.ledger.complete(active).unwrap();
        drop(test.ledger);
        let connection = Connection::open(&test.path).unwrap();
        downgrade_v4_to_v3(&connection);
        connection
            .execute(
                "CREATE TABLE terminal_control_receipts (collision INTEGER)",
                [],
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            GrantLedger::open_with_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Sql(_))
        ));
        let connection = Connection::open(&test.path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let state_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM grant_state", [], |row| row.get(0))
            .unwrap();
        let old_state: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'grant_state_v3'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let grant_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM grants", [], |row| row.get(0))
            .unwrap();
        let terminal_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM grant_terminal_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            (version, state_rows, old_state, grant_rows, terminal_rows),
            (3, 1, 0, 1, 1)
        );
    }

    #[test]
    fn controls_share_the_grant_high_water_and_preserve_grant_only_counters() {
        let mut test = default_test_ledger();
        insert_control(&test.ledger.connection, &clear_control("control-5", 5));
        let (count, bytes, issuer, sequence): (i64, i64, String, Vec<u8>) = test
            .ledger
            .connection
            .query_row(
                "SELECT grant_count, total_bytes, issuer_id, last_issuer_seq FROM grant_state",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((count, bytes, issuer.as_str()), (0, 0, "operator-1"));
        assert_eq!(decode_u64(sequence, "sequence").unwrap(), 5);
        let (payload, signature) = signed(&grant("stale-after-control", 4));
        assert!(matches!(
            test.ledger.admit(&payload, &signature, &binding()),
            Err(GrantLedgerError::StaleIssuerSequence)
        ));
        let (payload, signature) = signed(&grant("new-after-control", 6));
        test.ledger.admit(&payload, &signature, &binding()).unwrap();
        drop(test.ledger);
        open_with_control_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
    }

    #[test]
    fn latch_state_is_latest_event_for_the_exact_three_part_key() {
        let mut test = default_test_ledger();
        let (policy_bytes, policy_sha256) = latch_policy_fixture();
        let policy_hash = lower_hex_hash(&policy_sha256).unwrap();
        let claim = latch_grant("grant-flag", 1, &policy_sha256);
        let (payload, signature) = signed(&claim);
        let _active = test
            .ledger
            .admit(&payload, &signature, &binding_for_policy(&policy_sha256))
            .unwrap();
        insert_control(
            &test.ledger.connection,
            &flag_control("control-flag", 2, &claim),
        );
        test.ledger
            .connection
            .execute(
                "INSERT INTO policy_latch_events (
                    event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                    kind, grant_id, control_id, occurred_at_unix_s
                 ) VALUES (1, 'executor-1', 'sensitive-v1', ?1, ?2, 'flag',
                           'grant-flag', 'control-flag', ?3)",
                params![
                    policy_hash.as_slice(),
                    policy_bytes,
                    u64_blob(NOW + 1).as_slice()
                ],
            )
            .unwrap();
        assert!(
            test.ledger
                .policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash)
                .unwrap()
        );
        assert!(
            !test
                .ledger
                .policy_latch_is_set("executor-1", "other-profile", &policy_hash)
                .unwrap()
        );

        insert_control(
            &test.ledger.connection,
            &clear_control_for_policy("control-clear", 3, &policy_sha256),
        );
        test.ledger
            .connection
            .execute(
                "INSERT INTO policy_latch_events (
                    event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                    kind, grant_id, control_id, occurred_at_unix_s
                 ) VALUES (2, 'executor-1', 'sensitive-v1', ?1, NULL, 'clear', NULL,
                           'control-clear', ?2)",
                params![policy_hash.as_slice(), u64_blob(NOW + 2).as_slice()],
            )
            .unwrap();
        assert!(
            !test
                .ledger
                .policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash)
                .unwrap()
        );
        drop(test.ledger);
        let reopened = open_with_control_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        assert!(
            !reopened
                .policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash)
                .unwrap()
        );
    }

    #[test]
    fn control_and_latch_rows_are_append_only_bounded_and_checked_on_reopen() {
        let mut test = default_test_ledger();
        let (policy_bytes, policy_sha256) = latch_policy_fixture();
        let policy_hash = lower_hex_hash(&policy_sha256).unwrap();
        let claim = latch_grant("grant-flag", 1, &policy_sha256);
        let (payload, signature) = signed(&claim);
        let _active = test
            .ledger
            .admit(&payload, &signature, &binding_for_policy(&policy_sha256))
            .unwrap();
        insert_control(
            &test.ledger.connection,
            &flag_control("control-flag", 2, &claim),
        );
        test.ledger
            .connection
            .execute(
                "INSERT INTO policy_latch_events (
                    event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                    kind, grant_id, control_id, occurred_at_unix_s
                 ) VALUES (1, 'executor-1', 'sensitive-v1', ?1, ?2, 'flag',
                           'grant-flag', 'control-flag', ?3)",
                params![
                    policy_hash.as_slice(),
                    policy_bytes,
                    u64_blob(NOW + 1).as_slice()
                ],
            )
            .unwrap();
        insert_control(
            &test.ledger.connection,
            &clear_control_for_policy("control-clear", 3, &policy_sha256),
        );
        test.ledger
            .connection
            .execute(
                "INSERT INTO policy_latch_events (
                    event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                    kind, grant_id, control_id, occurred_at_unix_s
                 ) VALUES (2, 'executor-1', 'sensitive-v1', ?1, NULL, 'clear', NULL,
                           'control-clear', ?2)",
                params![policy_hash.as_slice(), u64_blob(NOW + 2).as_slice()],
            )
            .unwrap();
        assert!(
            test.ledger
                .connection
                .execute("DELETE FROM policy_latch_events", [])
                .is_err()
        );
        assert!(
            test.ledger
                .connection
                .execute("UPDATE policy_latch_events SET profile_id = 'other'", [])
                .is_err()
        );
        assert!(
            test.ledger
                .connection
                .execute("DELETE FROM terminal_control_receipts", [])
                .is_err()
        );
        assert!(
            test.ledger
                .connection
                .execute(
                    "UPDATE terminal_control_receipts SET target_profile_id = 'other'",
                    []
                )
                .is_err()
        );
        drop(test.ledger);
        assert!(matches!(
            open_with_control_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits {
                    max_terminal_control_bytes: 1,
                    ..GrantLedgerLimits::default()
                },
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::StorageLimit)
        ));
        assert!(matches!(
            open_with_control_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits {
                    max_latch_bytes: 1,
                    ..GrantLedgerLimits::default()
                },
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::StorageLimit)
        ));

        let connection = Connection::open(&test.path).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER terminal_control_receipts_immutable;
             UPDATE terminal_control_receipts SET payload_sha256 = zeroblob(32);
             CREATE TRIGGER terminal_control_receipts_immutable
             BEFORE UPDATE ON terminal_control_receipts
             BEGIN SELECT RAISE(ABORT, 'terminal control receipts are immutable'); END;",
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            open_with_control_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
    }

    #[test]
    fn control_admission_time_must_remain_inside_signed_window() {
        let test = default_test_ledger();
        insert_control(&test.ledger.connection, &clear_control("control-1", 1));
        test.ledger
            .connection
            .execute_batch(
                "DROP TRIGGER terminal_control_receipts_immutable;
                 UPDATE terminal_control_receipts
                 SET admitted_at_unix_s = expires_at_unix_s;
                 CREATE TRIGGER terminal_control_receipts_immutable
                 BEFORE UPDATE ON terminal_control_receipts
                 BEGIN SELECT RAISE(ABORT, 'terminal control receipts are immutable'); END;",
            )
            .unwrap();
        drop(test.ledger);
        assert!(matches!(
            GrantLedger::open_with_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
    }

    #[test]
    fn latch_events_require_exact_control_source_and_flag_before_clear() {
        let mut wrong_source = default_test_ledger();
        let (policy_bytes, policy_sha256) = latch_policy_fixture();
        let policy_hash = lower_hex_hash(&policy_sha256).unwrap();
        let claim = latch_grant("grant-flag", 1, &policy_sha256);
        let (payload, signature) = signed(&claim);
        let _active = wrong_source
            .ledger
            .admit(&payload, &signature, &binding_for_policy(&policy_sha256))
            .unwrap();
        insert_control(
            &wrong_source.ledger.connection,
            &clear_control_for_policy("control-clear", 2, &policy_sha256),
        );
        assert!(
            wrong_source
                .ledger
                .connection
                .execute(
                    "INSERT INTO policy_latch_events (
                event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                kind, grant_id, control_id, occurred_at_unix_s
             ) VALUES (1, 'executor-1', 'sensitive-v1', ?1, ?2, 'flag',
                       'grant-flag', NULL, ?3)",
                    params![
                        policy_hash.as_slice(),
                        policy_bytes.clone(),
                        u64_blob(NOW + 1).as_slice()
                    ]
                )
                .is_err()
        );
        wrong_source
            .ledger
            .connection
            .execute(
                "INSERT INTO policy_latch_events (
                event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                kind, grant_id, control_id, occurred_at_unix_s
             ) VALUES (1, 'executor-1', 'sensitive-v1', ?1, ?2, 'flag',
                       'grant-flag', 'control-clear', ?3)",
                params![
                    policy_hash.as_slice(),
                    policy_bytes,
                    u64_blob(NOW + 1).as_slice()
                ],
            )
            .unwrap();
        drop(wrong_source.ledger);
        assert!(matches!(
            open_with_control_clock(
                &wrong_source.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));

        let clear_first = default_test_ledger();
        insert_control(
            &clear_first.ledger.connection,
            &clear_control_for_policy("control-clear", 1, &policy_sha256),
        );
        clear_first
            .ledger
            .connection
            .execute(
                "INSERT INTO policy_latch_events (
                event_seq, executor_id, profile_id, policy_sha256, policy_bytes,
                kind, grant_id, control_id, occurred_at_unix_s
             ) VALUES (1, 'executor-1', 'sensitive-v1', ?1, NULL, 'clear', NULL,
                       'control-clear', ?2)",
                params![policy_hash.as_slice(), u64_blob(NOW + 1).as_slice()],
            )
            .unwrap();
        drop(clear_first.ledger);
        assert!(matches!(
            open_with_control_clock(
                &clear_first.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
    }

    #[test]
    fn reopen_rejects_cross_table_issuer_sequence_collision_after_trigger_bypass() {
        let mut test = default_test_ledger();
        let _active = admit(&mut test.ledger, "grant-1", 1);
        test.ledger
            .connection
            .execute_batch("DROP TRIGGER terminal_control_receipts_shared_sequence")
            .unwrap();
        insert_control_row(
            &test.ledger.connection,
            &clear_control("control-collision", 1),
        );
        test.ledger
            .connection
            .execute_batch(
                "CREATE TRIGGER terminal_control_receipts_shared_sequence
                 BEFORE INSERT ON terminal_control_receipts
                 WHEN EXISTS (SELECT 1 FROM grants
                              WHERE issuer_id = NEW.issuer_id AND issuer_seq = NEW.issuer_seq)
                 BEGIN SELECT RAISE(ABORT, 'issuer sequence was already used by a grant'); END;",
            )
            .unwrap();
        drop(test.ledger);

        assert!(matches!(
            open_with_control_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
    }

    #[test]
    fn control_rows_require_exact_verifier_custody_on_reopen() {
        let test = default_test_ledger();
        insert_control(&test.ledger.connection, &clear_control("control-1", 1));
        drop(test.ledger);

        assert!(matches!(
            GrantLedger::open_with_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::TerminalControlVerifierRequired)
        ));
        assert!(matches!(
            GrantLedger::open_with_terminal_control_verifier_and_clock(
                &test.path,
                verifier(),
                control_verifier_with_seed(8),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
        open_with_control_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
    }

    #[test]
    fn latch_queries_require_verifier_custody_even_without_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private").join("grants.sqlite");
        let ledger = GrantLedger::open_with_clock(
            &path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        let policy_hash = lower_hex_hash(HASH_C).unwrap();
        assert!(matches!(
            ledger.policy_latch_is_set("executor-1", "sensitive-v1", &policy_hash),
            Err(GrantLedgerError::TerminalControlVerifierRequired)
        ));
    }

    #[test]
    fn schema_v2_migration_preserves_existing_terminal_receipts() {
        let mut test = default_test_ledger();
        let active = admit(&mut test.ledger, "grant-complete", 1);
        let before = test.ledger.complete(active).unwrap();
        drop(test.ledger);
        let connection = Connection::open(&test.path).unwrap();
        downgrade_v4_to_v3(&connection);
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);

        let migrated = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        assert_eq!(
            migrated.terminal_receipt("grant-complete").unwrap(),
            Some(before)
        );
        let version: i64 = migrated
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn schema_v2_migration_failure_restores_triggers_and_version() {
        let test = default_test_ledger();
        let path = test.path.clone();
        drop(test.ledger);
        let connection = Connection::open(&path).unwrap();
        downgrade_v4_to_v3(&connection);
        connection
            .execute_batch(
                "CREATE TABLE grant_terminal_events_v2 (collision INTEGER);
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            GrantLedger::open_with_clock(
                &path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Sql(_))
        ));
        let connection = Connection::open(&path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let triggers: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'trigger' AND name IN (
                    'grant_terminal_events_immutable', 'grant_terminal_events_no_delete'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN (
                    'grant_terminal_events', 'grant_terminal_events_v2'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((version, triggers, tables), (2, 2, 2));
    }

    #[test]
    fn schema_v1_migrates_transactionally_without_weakening_admission_rows() {
        let mut test = default_test_ledger();
        let active = admit(&mut test.ledger, "grant-v1", 1);
        drop(test.ledger);
        let connection = Connection::open(&test.path).unwrap();
        downgrade_v4_to_v3(&connection);
        connection
            .execute_batch(
                "DROP TRIGGER grant_terminal_events_immutable;
                 DROP TRIGGER grant_terminal_events_no_delete;
                 DROP TABLE grant_terminal_events;
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        drop(connection);

        let mut migrated = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
        let receipt = migrated.terminal_receipt("grant-v1").unwrap().unwrap();
        assert_eq!(
            (receipt.event_seq(), receipt.kind()),
            (1, GrantTerminalKind::Interrupted)
        );
        assert!(matches!(
            migrated.complete(active),
            Err(GrantLedgerError::AlreadyTerminal)
        ));
        let version: i64 = migrated
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(
            migrated
                .connection
                .execute(
                    "UPDATE grants SET issuer_id = 'other' WHERE grant_id = 'grant-v1'",
                    [],
                )
                .is_err()
        );
    }

    #[test]
    fn schema_v1_migration_failure_rolls_back_table_and_version() {
        let test = default_test_ledger();
        let path = test.path.clone();
        drop(test.ledger);
        let connection = Connection::open(&path).unwrap();
        downgrade_v4_to_v3(&connection);
        connection
            .execute_batch(
                "DROP TRIGGER grant_terminal_events_immutable;
                 DROP TRIGGER grant_terminal_events_no_delete;
                 DROP TABLE grant_terminal_events;
                 CREATE TABLE migration_collision (id INTEGER);
                 CREATE TRIGGER grant_terminal_events_immutable
                 BEFORE INSERT ON migration_collision BEGIN SELECT 1; END;
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            GrantLedger::open_with_clock(
                &path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Sql(_))
        ));
        let connection = Connection::open(&path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let terminal_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'grant_terminal_events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((version, terminal_table), (1, 0));
    }

    #[test]
    fn schema_v1_wrong_application_is_rejected_before_migration() {
        let test = default_test_ledger();
        let path = test.path.clone();
        drop(test.ledger);
        let connection = Connection::open(&path).unwrap();
        downgrade_v4_to_v3(&connection);
        connection
            .execute_batch(
                "DROP TRIGGER grant_terminal_events_immutable;
                 DROP TRIGGER grant_terminal_events_no_delete;
                 DROP TABLE grant_terminal_events;
                 PRAGMA user_version = 1;
                 PRAGMA application_id = 0;",
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            GrantLedger::open_with_clock(
                &path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
        let connection = Connection::open(&path).unwrap();
        let terminal_objects: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'grant_terminal_events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(terminal_objects, 0);
    }

    #[test]
    fn reopen_rejects_a_forged_terminal_sequence_gap() {
        let mut test = default_test_ledger();
        let first = admit(&mut test.ledger, "grant-first", 1);
        let second = admit(&mut test.ledger, "grant-second", 2);
        test.ledger.complete(first).unwrap();
        test.ledger.complete(second).unwrap();
        drop(test.ledger);
        let connection = Connection::open(&test.path).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER grant_terminal_events_no_delete;
                 DELETE FROM grant_terminal_events WHERE event_seq = 1;
                 CREATE TRIGGER grant_terminal_events_no_delete
                 BEFORE DELETE ON grant_terminal_events
                 BEGIN SELECT RAISE(ABORT, 'grant terminal events are append-only'); END;",
            )
            .unwrap();
        drop(connection);
        assert!(matches!(
            GrantLedger::open_with_clock(
                &test.path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
    }

    #[test]
    fn application_id_and_schema_are_checked() {
        let test = default_test_ledger();
        let path = test.path.clone();
        drop(test.ledger);
        let connection = Connection::open(&path).unwrap();
        connection
            .pragma_update(None, "application_id", 0_i64)
            .unwrap();
        drop(connection);
        assert!(matches!(
            GrantLedger::open_with_clock(
                &path,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::Corrupt(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn database_and_parent_are_private_and_symlinks_are_rejected() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let test = default_test_ledger();
        assert_eq!(
            fs::metadata(test.path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o700
        );
        assert_eq!(
            fs::metadata(&test.path).unwrap().permissions().mode() & 0o7777,
            0o600
        );

        let target = test._temp.path().join("target.sqlite");
        fs::write(&target, []).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let link = test._temp.path().join("link.sqlite");
        symlink(&target, &link).unwrap();
        assert!(matches!(
            GrantLedger::open_with_clock(
                &link,
                verifier(),
                GrantLedgerLimits::default(),
                Clock::Fixed(NOW),
            ),
            Err(GrantLedgerError::UnsafePath(_))
        ));
    }

    #[test]
    fn production_open_has_no_clock_or_sequence_inputs() {
        let open: fn(
            &Path,
            GrantVerifier,
            GrantLedgerLimits,
        ) -> Result<GrantLedger, GrantLedgerError> =
            |path, verifier, limits| GrantLedger::open(path, verifier, limits);
        let _ = open;
    }
}
