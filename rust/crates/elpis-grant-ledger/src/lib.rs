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
    ED25519_SIGNATURE_BYTES, GrantBinding, GrantError, GrantV1, GrantVerifier,
    MAX_GRANT_PAYLOAD_BYTES,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 2;
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
    kind TEXT NOT NULL CHECK (kind IN ('completed', 'revoked', 'flagged')),
    occurred_at_unix_s BLOB NOT NULL
        CHECK (typeof(occurred_at_unix_s) = 'blob' AND length(occurred_at_unix_s) = 8)
);
CREATE TRIGGER grant_terminal_events_immutable
BEFORE UPDATE ON grant_terminal_events
BEGIN SELECT RAISE(ABORT, 'grant terminal events are immutable'); END;
CREATE TRIGGER grant_terminal_events_no_delete
BEFORE DELETE ON grant_terminal_events
BEGIN SELECT RAISE(ABORT, 'grant terminal events are append-only'); END;";

/// Conventional filename for the daemon-private grant ledger.
pub const GRANT_LEDGER_DATABASE_FILENAME: &str = "grants.sqlite";

/// Durable storage bounds applied at open and before every admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantLedgerLimits {
    pub max_grants: u64,
    pub max_bytes: u64,
}

impl Default for GrantLedgerLimits {
    fn default() -> Self {
        Self {
            max_grants: 10_000,
            max_bytes: 64 * 1024 * 1024,
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
}

impl GrantTerminalKind {
    fn as_db(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Revoked => "revoked",
            Self::Flagged => "flagged",
        }
    }

    fn from_db(value: &str) -> Result<Self, GrantLedgerError> {
        match value {
            "completed" => Ok(Self::Completed),
            "revoked" => Ok(Self::Revoked),
            "flagged" => Ok(Self::Flagged),
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
    limits: GrantLedgerLimits,
    clock: Clock,
}

impl GrantLedger {
    /// Opens a private ledger using the process wall clock.
    ///
    /// The verifier is moved into the ledger so callers cannot substitute an
    /// authenticated intermediate value during admission.
    pub fn open(
        path: impl AsRef<Path>,
        verifier: GrantVerifier,
        limits: GrantLedgerLimits,
    ) -> Result<Self, GrantLedgerError> {
        Self::open_with_clock(path.as_ref(), verifier, limits, Clock::System)
    }

    /// Opens grants.sqlite in a private state directory.
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

    fn open_with_clock(
        path: &Path,
        verifier: GrantVerifier,
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
        validate_integrity(&connection, &verifier, limits)?;
        Ok(Self {
            path,
            ledger_binding,
            connection,
            verifier,
            limits,
            clock,
        })
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
        let (count, last): (i64, Option<i64>) = transaction.query_row(
            "SELECT COUNT(*), MAX(event_seq) FROM grant_terminal_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let next = match (count, last) {
            (0, None) => 1_i64,
            (count, Some(last)) if count > 0 && count == last => last
                .checked_add(1)
                .ok_or(GrantLedgerError::TerminalSequenceExhausted)?,
            _ => {
                return Err(GrantLedgerError::Corrupt(
                    "terminal event sequence is not gap-free".into(),
                ));
            }
        };
        transaction.execute(
            "INSERT INTO grant_terminal_events (
                event_seq, grant_id, payload_sha256, kind, occurred_at_unix_s
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                next,
                grant.grant_id,
                payload_sha256.as_slice(),
                kind.as_db(),
                u64_blob(now).as_slice(),
            ],
        )?;
        transaction.commit()?;
        Ok(GrantTerminalReceipt {
            event_seq: next as u64,
            grant_id: grant.grant_id,
            payload_sha256,
            kind,
            occurred_at_unix_s: now,
        })
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
        || limits.max_grants > i64::MAX as u64
        || limits.max_bytes > i64::MAX as u64
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
    if !matches!(version, 0 | 1 | SCHEMA_VERSION) {
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
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
    }

    require_application_id(connection)?;
    require_schema_objects(connection, ADMISSION_SCHEMA_OBJECTS)?;
    require_schema_objects(connection, TERMINAL_SCHEMA_OBJECTS)
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

    if count != state.grant_count
        || total_bytes != state.total_bytes
        || maximum_seq != state.last_issuer_seq
    {
        return Err(GrantLedgerError::Corrupt(
            "grant state counters do not match stored rows".into(),
        ));
    }
    validate_terminal_integrity(connection, state.grant_count)
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

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use elpis_grants::{GRANT_VERSION, GrantMode, signature_input};
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

    fn binding() -> GrantBinding {
        GrantBinding {
            mind_id: "elm-test".into(),
            mandate_sha256: HASH_A.into(),
            runtime_sha256: HASH_B.into(),
            policy_sha256: HASH_C.into(),
        }
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
        let ledger =
            GrantLedger::open_with_clock(&path, verifier(), limits, Clock::Fixed(NOW)).unwrap();
        TestLedger {
            _temp: temp,
            path,
            ledger,
        }
    }

    fn default_test_ledger() -> TestLedger {
        test_ledger(GrantLedgerLimits::default())
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
        let active = admit(&mut test.ledger, "grant-race", 1);
        let duplicate = duplicate_active(&active);
        let mut other = GrantLedger::open_with_clock(
            &test.path,
            verifier(),
            GrantLedgerLimits::default(),
            Clock::Fixed(NOW),
        )
        .unwrap();
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
    fn schema_v1_migrates_transactionally_without_weakening_admission_rows() {
        let mut test = default_test_ledger();
        let active = admit(&mut test.ledger, "grant-v1", 1);
        drop(test.ledger);
        let connection = Connection::open(&test.path).unwrap();
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
        assert_eq!(migrated.complete(active).unwrap().event_seq(), 1);
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
