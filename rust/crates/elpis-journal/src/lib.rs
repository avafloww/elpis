use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use elpis_protocol::Request;
use elpis_transport::{ClientFrame, FenceCheckpoint, ServerFrame};
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 1;
const APPLICATION_ID: i64 = 0x454c_504a;
const ZERO_SEQ: [u8; 8] = 0_u64.to_be_bytes();
const ONE_SEQ: [u8; 8] = 1_u64.to_be_bytes();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JournalLimits {
    pub max_requests: u64,
    pub max_bytes: u64,
}

impl Default for JournalLimits {
    fn default() -> Self {
        Self {
            max_requests: 10_000,
            max_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRequest {
    server_seq: u64,
    request_sha256: [u8; 32],
}

impl PreparedRequest {
    pub fn server_seq(&self) -> u64 {
        self.server_seq
    }

    pub fn request_sha256(&self) -> [u8; 32] {
        self.request_sha256
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Prepared,
    Completed,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredResponse {
    pub client_seq: u64,
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRequest {
    pub server_seq: u64,
    pub request_id: String,
    pub request_bytes: Vec<u8>,
    pub request_sha256: [u8; 32],
    pub status: RequestStatus,
    pub response: Option<StoredResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareOutcome {
    New(PreparedRequest),
    Existing(StoredRequest),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeartbeatOutcome {
    New,
    Existing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientHeartbeatOutcome {
    New,
    Existing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalState {
    pub executor_id: Option<String>,
    pub boot_epoch: Option<String>,
    pub connection_id: Option<String>,
    pub last_committed_server_seq: u64,
    pub next_client_seq: u64,
    pub request_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug)]
pub struct Journal {
    path: PathBuf,
    connection: Connection,
    limits: JournalLimits,
}

impl Journal {
    pub fn open(path: impl AsRef<Path>, limits: JournalLimits) -> Result<Self, JournalError> {
        validate_limits(limits)?;
        let path = path.as_ref().to_path_buf();
        prepare_path(&path)?;
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        set_private_file_mode(&path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let check: String = connection.pragma_query_value(None, "quick_check", |row| row.get(0))?;
        if check != "ok" {
            return Err(JournalError::Corrupt(check));
        }
        initialize_schema(&connection)?;
        validate_integrity(&connection, limits)?;
        let mut journal = Self {
            path,
            connection,
            limits,
        };
        journal.recover_prepared()?;
        Ok(journal)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn state(&self) -> Result<JournalState, JournalError> {
        load_state_connection(&self.connection)
    }

    pub fn prepare(&mut self, frame: &ServerFrame) -> Result<PrepareOutcome, JournalError> {
        frame.to_json()?;
        let (binding, server_seq, request) = match frame {
            ServerFrame::Request {
                executor_id,
                boot_epoch,
                connection_id,
                seq,
                request,
                ..
            } => (
                Binding::new(executor_id, boot_epoch, connection_id),
                *seq,
                request,
            ),
            ServerFrame::Heartbeat { .. } => return Err(JournalError::ExpectedRequest),
        };
        let request_bytes = serde_json::to_vec(request)?;
        let request_sha256 = sha256(&request_bytes);
        let request_id = request.request_id();
        let limits = self.limits;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        bind_or_verify(&transaction, &binding)?;
        let state = load_state_transaction(&transaction)?;
        match classify_sequence(server_seq, state.last_committed_server_seq)? {
            SequenceClass::Next => {
                enforce_capacity(limits, &state, request_bytes.len() as u64, 1)?;
                transaction.execute(
                    "INSERT INTO journal_requests (
                        server_seq, executor_id, boot_epoch, connection_id, request_id,
                        request_sha256, request_bytes, status
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'prepared')",
                    params![
                        seq_blob(server_seq),
                        binding.executor_id,
                        binding.boot_epoch,
                        binding.connection_id,
                        request_id,
                        request_sha256.as_slice(),
                        request_bytes,
                    ],
                )?;
                update_committed_sequence(&transaction, server_seq, request_bytes.len() as u64, 1)?;
                transaction.commit()?;
                Ok(PrepareOutcome::New(PreparedRequest {
                    server_seq,
                    request_sha256,
                }))
            }
            SequenceClass::Existing => {
                let stored = load_request_transaction(&transaction, server_seq)?
                    .ok_or(JournalError::SequenceCollision(server_seq))?;
                if stored.request_id != request_id
                    || stored.request_sha256 != request_sha256
                    || stored.request_bytes != request_bytes
                {
                    return Err(JournalError::RequestConflict(server_seq));
                }
                transaction.commit()?;
                Ok(PrepareOutcome::Existing(stored))
            }
        }
    }

    pub fn commit_heartbeat(
        &mut self,
        frame: &ServerFrame,
    ) -> Result<HeartbeatOutcome, JournalError> {
        frame.to_json()?;
        let (binding, server_seq) = match frame {
            ServerFrame::Heartbeat {
                executor_id,
                boot_epoch,
                connection_id,
                seq,
                ..
            } => (Binding::new(executor_id, boot_epoch, connection_id), *seq),
            ServerFrame::Request { .. } => return Err(JournalError::ExpectedHeartbeat),
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        bind_or_verify(&transaction, &binding)?;
        let state = load_state_transaction(&transaction)?;
        match classify_sequence(server_seq, state.last_committed_server_seq)? {
            SequenceClass::Next => {
                update_committed_sequence(&transaction, server_seq, 0, 0)?;
                transaction.commit()?;
                Ok(HeartbeatOutcome::New)
            }
            SequenceClass::Existing => {
                if load_request_transaction(&transaction, server_seq)?.is_some() {
                    return Err(JournalError::SequenceCollision(server_seq));
                }
                transaction.commit()?;
                Ok(HeartbeatOutcome::Existing)
            }
        }
    }

    pub fn commit_client_heartbeat(
        &mut self,
        frame: &ClientFrame,
    ) -> Result<ClientHeartbeatOutcome, JournalError> {
        frame.to_json()?;
        let (binding, client_seq, observed_server_seq) = match frame {
            ClientFrame::Heartbeat {
                executor_id,
                boot_epoch,
                connection_id,
                seq,
                observed_server_seq,
                ..
            } => (
                Binding::new(executor_id, boot_epoch, connection_id),
                *seq,
                *observed_server_seq,
            ),
            ClientFrame::Response { .. } => return Err(JournalError::ExpectedClientHeartbeat),
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        bind_or_verify(&transaction, &binding)?;
        let state = load_state_transaction(&transaction)?;
        if client_seq == state.next_client_seq {
            if observed_server_seq != state.last_committed_server_seq {
                return Err(JournalError::ObservedServerSequenceMismatch {
                    expected: state.last_committed_server_seq,
                    actual: observed_server_seq,
                });
            }
            let next = client_seq
                .checked_add(1)
                .ok_or(JournalError::SequenceExhausted)?;
            transaction.execute(
                "UPDATE journal_state SET next_client_seq = ?1 WHERE singleton = 1",
                params![seq_blob(next)],
            )?;
            transaction.commit()?;
            return Ok(ClientHeartbeatOutcome::New);
        }
        if client_seq > state.next_client_seq {
            return Err(JournalError::ClientSequenceMismatch {
                expected: state.next_client_seq,
                actual: client_seq,
            });
        }
        if response_uses_client_sequence(&transaction, client_seq)? {
            return Err(JournalError::ClientSequenceCollision(client_seq));
        }
        transaction.commit()?;
        Ok(ClientHeartbeatOutcome::Existing)
    }

    pub fn complete(
        &mut self,
        prepared: &PreparedRequest,
        frame: &ClientFrame,
    ) -> Result<StoredResponse, JournalError> {
        let response_bytes = frame.to_json()?;
        let (binding, client_seq, request_seq, response_request_id) = match frame {
            ClientFrame::Response {
                executor_id,
                boot_epoch,
                connection_id,
                seq,
                request_seq,
                response,
                ..
            } => (
                Binding::new(executor_id, boot_epoch, connection_id),
                *seq,
                *request_seq,
                response.request_id.as_deref(),
            ),
            ClientFrame::Heartbeat { .. } => return Err(JournalError::ExpectedResponse),
        };
        if request_seq != prepared.server_seq {
            return Err(JournalError::ResponseRequestMismatch {
                expected: prepared.server_seq,
                actual: request_seq,
            });
        }
        let response_sha256 = sha256(&response_bytes);
        let limits = self.limits;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        bind_or_verify(&transaction, &binding)?;
        let state = load_state_transaction(&transaction)?;
        let stored = load_request_transaction(&transaction, request_seq)?
            .ok_or(JournalError::UnknownRequest(request_seq))?;
        if stored.request_sha256 != prepared.request_sha256 {
            return Err(JournalError::RequestConflict(request_seq));
        }
        if response_request_id != Some(stored.request_id.as_str()) {
            return Err(JournalError::ResponseIdMismatch);
        }
        match stored.status {
            RequestStatus::Prepared => {
                if client_seq != state.next_client_seq {
                    return Err(JournalError::ClientSequenceMismatch {
                        expected: state.next_client_seq,
                        actual: client_seq,
                    });
                }
                let next_client_seq = client_seq
                    .checked_add(1)
                    .ok_or(JournalError::SequenceExhausted)?;
                enforce_capacity(limits, &state, response_bytes.len() as u64, 0)?;
                let changed = transaction.execute(
                    "UPDATE journal_requests
                     SET status = 'completed', response_sha256 = ?1,
                         response_bytes = ?2, client_seq = ?3
                     WHERE server_seq = ?4 AND status = 'prepared'",
                    params![
                        response_sha256.as_slice(),
                        response_bytes,
                        seq_blob(client_seq),
                        seq_blob(request_seq),
                    ],
                )?;
                if changed != 1 {
                    return Err(JournalError::ConcurrentChange);
                }
                transaction.execute(
                    "UPDATE journal_state
                     SET next_client_seq = ?1, total_bytes = total_bytes + ?2
                     WHERE singleton = 1",
                    params![seq_blob(next_client_seq), response_bytes.len() as i64],
                )?;
                transaction.commit()?;
                Ok(StoredResponse {
                    client_seq,
                    bytes: response_bytes,
                    sha256: response_sha256,
                })
            }
            RequestStatus::Completed => {
                let existing = stored.response.ok_or(JournalError::Corrupt(
                    "completed request has no response".into(),
                ))?;
                if existing.client_seq != client_seq
                    || existing.sha256 != response_sha256
                    || existing.bytes != response_bytes
                {
                    return Err(JournalError::ResponseConflict(request_seq));
                }
                transaction.commit()?;
                Ok(existing)
            }
            RequestStatus::Ambiguous => Err(JournalError::Ambiguous(request_seq)),
        }
    }

    pub fn request(&self, server_seq: u64) -> Result<Option<StoredRequest>, JournalError> {
        load_request_connection(&self.connection, server_seq)
    }

    pub fn fence_checkpoint(
        &self,
        executor_id: &str,
        boot_epoch: &str,
        connection_id: &str,
    ) -> Result<FenceCheckpoint, JournalError> {
        let state = self.state()?;
        for (stored, expected) in [
            (state.executor_id.as_deref(), executor_id),
            (state.boot_epoch.as_deref(), boot_epoch),
            (state.connection_id.as_deref(), connection_id),
        ] {
            if stored.is_some_and(|value| value != expected) {
                return Err(JournalError::BindingMismatch);
            }
        }
        let mut statement = self.connection.prepare(request_select_all())?;
        let requests = statement
            .query_map([], decode_request)?
            .collect::<Result<Vec<_>, _>>()?;
        let checkpoint = FenceCheckpoint {
            executor_id: executor_id.to_owned(),
            boot_epoch: boot_epoch.to_owned(),
            connection_id: connection_id.to_owned(),
            last_committed_server_seq: state.last_committed_server_seq,
            next_client_seq: state.next_client_seq,
            request_seqs: requests.iter().map(|request| request.server_seq).collect(),
            responded_request_seqs: requests
                .iter()
                .filter(|request| request.status == RequestStatus::Completed)
                .map(|request| request.server_seq)
                .collect(),
        };
        checkpoint.to_json()?;
        Ok(checkpoint)
    }

    fn recover_prepared(&mut self) -> Result<u64, JournalError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE journal_requests SET status = 'ambiguous' WHERE status = 'prepared'",
            [],
        )?;
        transaction.commit()?;
        Ok(changed as u64)
    }
}

#[derive(Debug, Clone)]
struct Binding<'a> {
    executor_id: &'a str,
    boot_epoch: &'a str,
    connection_id: &'a str,
}

impl<'a> Binding<'a> {
    fn new(executor_id: &'a str, boot_epoch: &'a str, connection_id: &'a str) -> Self {
        Self {
            executor_id,
            boot_epoch,
            connection_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SequenceClass {
    Next,
    Existing,
}

#[derive(Debug, Error)]
pub enum JournalError {
    #[error("journal SQLite error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("journal JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("transport frame is invalid: {0}")]
    Transport(#[from] elpis_transport::EncodeError),
    #[error("journal is corrupt: {0}")]
    Corrupt(String),
    #[error("unsafe journal path: {0}")]
    UnsafePath(String),
    #[error("journal limits must be nonzero and fit SQLite counters")]
    InvalidLimits,
    #[error("expected a request frame")]
    ExpectedRequest,
    #[error("expected a heartbeat frame")]
    ExpectedHeartbeat,
    #[error("expected a response frame")]
    ExpectedResponse,
    #[error("expected a client heartbeat frame")]
    ExpectedClientHeartbeat,
    #[error("transport identity does not match the journal binding")]
    BindingMismatch,
    #[error("server sequence {actual} has a gap; expected {expected}")]
    SequenceGap { expected: u64, actual: u64 },
    #[error("sequence space is exhausted")]
    SequenceExhausted,
    #[error("server sequence {0} collides with a different frame kind")]
    SequenceCollision(u64),
    #[error("server sequence {0} carries different request bytes or id")]
    RequestConflict(u64),
    #[error("unknown request sequence {0}")]
    UnknownRequest(u64),
    #[error("response request sequence mismatch: expected {expected}, got {actual}")]
    ResponseRequestMismatch { expected: u64, actual: u64 },
    #[error("response request_id does not match the prepared request")]
    ResponseIdMismatch,
    #[error("client sequence mismatch: expected {expected}, got {actual}")]
    ClientSequenceMismatch { expected: u64, actual: u64 },
    #[error("client sequence {0} was already used by a response")]
    ClientSequenceCollision(u64),
    #[error("observed server sequence mismatch: expected {expected}, got {actual}")]
    ObservedServerSequenceMismatch { expected: u64, actual: u64 },
    #[error("request sequence {0} is ambiguous and cannot be completed")]
    Ambiguous(u64),
    #[error("request sequence {0} already has different response bytes")]
    ResponseConflict(u64),
    #[error("journal storage limit exceeded")]
    StorageLimit,
    #[error("journal row changed concurrently")]
    ConcurrentChange,
}

fn validate_limits(limits: JournalLimits) -> Result<(), JournalError> {
    if limits.max_requests == 0
        || limits.max_bytes == 0
        || limits.max_requests > i64::MAX as u64
        || limits.max_bytes > i64::MAX as u64
    {
        return Err(JournalError::InvalidLimits);
    }
    Ok(())
}

fn prepare_path(path: &Path) -> Result<(), JournalError> {
    let parent = path
        .parent()
        .ok_or_else(|| JournalError::UnsafePath("path has no parent".into()))?;
    let existed = parent.exists();
    fs::create_dir_all(parent)?;
    if existed {
        require_private_dir(parent)?;
    } else {
        set_private_dir_mode(parent)?;
    }
    if let Ok(metadata) = fs::symlink_metadata(path)
        && metadata.file_type().is_symlink()
    {
        return Err(JournalError::UnsafePath("database is a symlink".into()));
    }
    Ok(())
}

#[cfg(unix)]
fn require_private_dir(path: &Path) -> Result<(), JournalError> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(JournalError::UnsafePath(
            "state parent is not a real directory".into(),
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(JournalError::UnsafePath(
            "existing state directory is accessible to group or other".into(),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_dir(_path: &Path) -> Result<(), JournalError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_dir_mode(path: &Path) -> Result<(), JournalError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_dir_mode(_path: &Path) -> Result<(), JournalError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_mode(path: &Path) -> Result<(), JournalError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_mode(_path: &Path) -> Result<(), JournalError> {
    Ok(())
}

impl From<std::io::Error> for JournalError {
    fn from(error: std::io::Error) -> Self {
        Self::UnsafePath(error.to_string())
    }
}

fn initialize_schema(connection: &Connection) -> Result<(), JournalError> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 0 && version != SCHEMA_VERSION {
        return Err(JournalError::Corrupt(format!(
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
            return Err(JournalError::Corrupt(
                "unversioned database already contains objects".into(),
            ));
        }
    }
    if version == 0 {
        connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS journal_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            executor_id TEXT,
            boot_epoch TEXT,
            connection_id TEXT,
            last_server_seq BLOB NOT NULL CHECK (length(last_server_seq) = 8),
            next_client_seq BLOB NOT NULL CHECK (length(next_client_seq) = 8),
            request_count INTEGER NOT NULL CHECK (request_count >= 0),
            total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
            CHECK ((executor_id IS NULL) = (boot_epoch IS NULL)),
            CHECK ((executor_id IS NULL) = (connection_id IS NULL))
        );
        CREATE TABLE IF NOT EXISTS journal_requests (
            server_seq BLOB PRIMARY KEY CHECK (length(server_seq) = 8),
            executor_id TEXT NOT NULL,
            boot_epoch TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
            request_bytes BLOB NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('prepared', 'completed', 'ambiguous')),
            response_sha256 BLOB CHECK (response_sha256 IS NULL OR length(response_sha256) = 32),
            response_bytes BLOB,
            client_seq BLOB UNIQUE CHECK (client_seq IS NULL OR length(client_seq) = 8),
            CHECK (
                (status = 'completed' AND response_sha256 IS NOT NULL AND response_bytes IS NOT NULL AND client_seq IS NOT NULL)
                OR
                (status IN ('prepared', 'ambiguous') AND response_sha256 IS NULL AND response_bytes IS NULL AND client_seq IS NULL)
            )
        );
        CREATE TRIGGER IF NOT EXISTS journal_request_identity_immutable
        BEFORE UPDATE ON journal_requests
        WHEN OLD.server_seq != NEW.server_seq
          OR OLD.executor_id != NEW.executor_id
          OR OLD.boot_epoch != NEW.boot_epoch
          OR OLD.connection_id != NEW.connection_id
          OR OLD.request_id != NEW.request_id
          OR OLD.request_sha256 != NEW.request_sha256
          OR OLD.request_bytes != NEW.request_bytes
        BEGIN SELECT RAISE(ABORT, 'request identity is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS journal_request_lifecycle
        BEFORE UPDATE OF status ON journal_requests
        WHEN NOT (
            (OLD.status = 'prepared' AND NEW.status IN ('completed', 'ambiguous'))
            OR OLD.status = NEW.status
        )
        BEGIN SELECT RAISE(ABORT, 'invalid request lifecycle transition'); END;
        CREATE TRIGGER IF NOT EXISTS journal_request_insert_prepared
        BEFORE INSERT ON journal_requests
        WHEN NEW.status != 'prepared'
        BEGIN SELECT RAISE(ABORT, 'new request must be prepared'); END;
        CREATE TRIGGER IF NOT EXISTS journal_request_completed_immutable
        BEFORE UPDATE ON journal_requests
        WHEN OLD.status = 'completed' AND (
            OLD.status != NEW.status
            OR OLD.response_sha256 != NEW.response_sha256
            OR OLD.response_bytes != NEW.response_bytes
            OR OLD.client_seq != NEW.client_seq
        )
        BEGIN SELECT RAISE(ABORT, 'completed receipt is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS journal_request_no_delete
        BEFORE DELETE ON journal_requests
        BEGIN SELECT RAISE(ABORT, 'journal requests are append-only'); END;",
        )?;
        connection.execute(
            "INSERT INTO journal_state (
                singleton, executor_id, boot_epoch, connection_id,
                last_server_seq, next_client_seq, request_count, total_bytes
             ) VALUES (1, NULL, NULL, NULL, ?1, ?2, 0, 0)",
            params![ZERO_SEQ.as_slice(), ONE_SEQ.as_slice()],
        )?;
        connection.pragma_update(None, "application_id", APPLICATION_ID)?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != APPLICATION_ID {
        return Err(JournalError::Corrupt("wrong application id".into()));
    }
    for (kind, name) in [
        ("table", "journal_state"),
        ("table", "journal_requests"),
        ("trigger", "journal_request_identity_immutable"),
        ("trigger", "journal_request_lifecycle"),
        ("trigger", "journal_request_insert_prepared"),
        ("trigger", "journal_request_completed_immutable"),
        ("trigger", "journal_request_no_delete"),
    ] {
        let present: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
            params![kind, name],
            |row| row.get(0),
        )?;
        if present != 1 {
            return Err(JournalError::Corrupt(format!(
                "missing journal {kind} {name}"
            )));
        }
    }
    Ok(())
}

fn bind_or_verify(
    transaction: &Transaction<'_>,
    binding: &Binding<'_>,
) -> Result<(), JournalError> {
    let current: (Option<String>, Option<String>, Option<String>) = transaction.query_row(
        "SELECT executor_id, boot_epoch, connection_id FROM journal_state WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    match current {
        (None, None, None) => {
            transaction.execute(
                "UPDATE journal_state
                 SET executor_id = ?1, boot_epoch = ?2, connection_id = ?3
                 WHERE singleton = 1",
                params![
                    binding.executor_id,
                    binding.boot_epoch,
                    binding.connection_id
                ],
            )?;
            Ok(())
        }
        (Some(executor_id), Some(boot_epoch), Some(connection_id))
            if executor_id == binding.executor_id
                && boot_epoch == binding.boot_epoch
                && connection_id == binding.connection_id =>
        {
            Ok(())
        }
        _ => Err(JournalError::BindingMismatch),
    }
}

fn load_state_connection(connection: &Connection) -> Result<JournalState, JournalError> {
    connection
        .query_row(
            "SELECT executor_id, boot_epoch, connection_id, last_server_seq,
                    next_client_seq, request_count, total_bytes
             FROM journal_state WHERE singleton = 1",
            [],
            decode_state,
        )
        .map_err(Into::into)
}

fn load_state_transaction(transaction: &Transaction<'_>) -> Result<JournalState, JournalError> {
    transaction
        .query_row(
            "SELECT executor_id, boot_epoch, connection_id, last_server_seq,
                    next_client_seq, request_count, total_bytes
             FROM journal_state WHERE singleton = 1",
            [],
            decode_state,
        )
        .map_err(Into::into)
}

fn decode_state(row: &rusqlite::Row<'_>) -> rusqlite::Result<JournalState> {
    let last: Vec<u8> = row.get(3)?;
    let next: Vec<u8> = row.get(4)?;
    let request_count: i64 = row.get(5)?;
    let total_bytes: i64 = row.get(6)?;
    Ok(JournalState {
        executor_id: row.get(0)?,
        boot_epoch: row.get(1)?,
        connection_id: row.get(2)?,
        last_committed_server_seq: decode_seq_sql(last)?,
        next_client_seq: decode_seq_sql(next)?,
        request_count: u64::try_from(request_count)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(5, request_count))?,
        total_bytes: u64::try_from(total_bytes)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(6, total_bytes))?,
    })
}

fn response_uses_client_sequence(
    transaction: &Transaction<'_>,
    client_seq: u64,
) -> Result<bool, JournalError> {
    let found: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM journal_requests WHERE client_seq = ?1",
            params![seq_blob(client_seq)],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn load_request_connection(
    connection: &Connection,
    server_seq: u64,
) -> Result<Option<StoredRequest>, JournalError> {
    connection
        .query_row(
            request_select(),
            params![seq_blob(server_seq)],
            decode_request,
        )
        .optional()
        .map_err(Into::into)
}

fn load_request_transaction(
    transaction: &Transaction<'_>,
    server_seq: u64,
) -> Result<Option<StoredRequest>, JournalError> {
    transaction
        .query_row(
            request_select(),
            params![seq_blob(server_seq)],
            decode_request,
        )
        .optional()
        .map_err(Into::into)
}

fn request_select() -> &'static str {
    "SELECT server_seq, request_id, request_sha256, request_bytes, status,
            response_sha256, response_bytes, client_seq
     FROM journal_requests WHERE server_seq = ?1"
}

fn request_select_all() -> &'static str {
    "SELECT server_seq, request_id, request_sha256, request_bytes, status,
            response_sha256, response_bytes, client_seq
     FROM journal_requests ORDER BY server_seq"
}

fn decode_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRequest> {
    let server_seq = decode_seq_sql(row.get(0)?)?;
    let request_sha256 = decode_hash_sql(row.get(2)?, 2)?;
    let status_text: String = row.get(4)?;
    let status = match status_text.as_str() {
        "prepared" => RequestStatus::Prepared,
        "completed" => RequestStatus::Completed,
        "ambiguous" => RequestStatus::Ambiguous,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let response_sha: Option<Vec<u8>> = row.get(5)?;
    let response_bytes: Option<Vec<u8>> = row.get(6)?;
    let client_seq: Option<Vec<u8>> = row.get(7)?;
    let response = match (response_sha, response_bytes, client_seq) {
        (Some(sha), Some(bytes), Some(seq)) => Some(StoredResponse {
            client_seq: decode_seq_sql(seq)?,
            bytes,
            sha256: decode_hash_sql(sha, 5)?,
        }),
        (None, None, None) => None,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let request_id: String = row.get(1)?;
    let request_bytes: Vec<u8> = row.get(3)?;
    if sha256(&request_bytes) != request_sha256 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let request: Request =
        serde_json::from_slice(&request_bytes).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if request.validate().is_err()
        || request.request_id() != request_id
        || serde_json::to_vec(&request).ok().as_deref() != Some(request_bytes.as_slice())
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if let Some(stored) = &response {
        if sha256(&stored.bytes) != stored.sha256 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let frame =
            ClientFrame::from_json(&stored.bytes).map_err(|_| rusqlite::Error::InvalidQuery)?;
        match frame {
            ClientFrame::Response {
                seq,
                request_seq,
                response,
                ..
            } if seq == stored.client_seq
                && request_seq == server_seq
                && response.request_id.as_deref() == Some(request_id.as_str()) => {}
            _ => return Err(rusqlite::Error::InvalidQuery),
        }
    }
    Ok(StoredRequest {
        server_seq,
        request_id,
        request_bytes,
        request_sha256,
        status,
        response,
    })
}

fn decode_seq_sql(bytes: Vec<u8>) -> rusqlite::Result<u64> {
    let array: [u8; 8] = bytes
        .try_into()
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    Ok(u64::from_be_bytes(array))
}

fn decode_hash_sql(bytes: Vec<u8>, column: usize) -> rusqlite::Result<[u8; 32]> {
    bytes.try_into().map_err(|bytes: Vec<u8>| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Blob,
            format!("expected 32-byte hash, got {}", bytes.len()).into(),
        )
    })
}

fn seq_blob(value: u64) -> Vec<u8> {
    value.to_be_bytes().to_vec()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn validate_integrity(connection: &Connection, limits: JournalLimits) -> Result<(), JournalError> {
    let state = load_state_connection(connection)?;
    enforce_capacity(
        limits,
        &JournalState {
            request_count: 0,
            total_bytes: 0,
            ..state.clone()
        },
        state.total_bytes,
        state.request_count,
    )?;
    let (count, bytes): (i64, i64) = connection.query_row(
        "SELECT COUNT(*), COALESCE(SUM(length(request_bytes) + COALESCE(length(response_bytes), 0)), 0) FROM journal_requests",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if u64::try_from(count).ok() != Some(state.request_count)
        || u64::try_from(bytes).ok() != Some(state.total_bytes)
    {
        return Err(JournalError::Corrupt(
            "state counters do not match request rows".into(),
        ));
    }
    let mut statement = connection.prepare(request_select_all())?;
    let rows = statement.query_map([], decode_request)?;
    for row in rows {
        let stored = row?;
        if stored.server_seq > state.last_committed_server_seq {
            return Err(JournalError::Corrupt(
                "request exceeds committed server sequence".into(),
            ));
        }
        if let Some(response) = stored.response {
            if response.client_seq >= state.next_client_seq {
                return Err(JournalError::Corrupt(
                    "response exceeds committed client sequence".into(),
                ));
            }
            let frame = ClientFrame::from_json(&response.bytes)
                .map_err(|error| JournalError::Corrupt(error.to_string()))?;
            match frame {
                ClientFrame::Response {
                    executor_id,
                    boot_epoch,
                    connection_id,
                    ..
                } if Some(executor_id.as_str()) == state.executor_id.as_deref()
                    && Some(boot_epoch.as_str()) == state.boot_epoch.as_deref()
                    && Some(connection_id.as_str()) == state.connection_id.as_deref() => {}
                _ => {
                    return Err(JournalError::Corrupt("response binding mismatch".into()));
                }
            }
        }
    }
    if state.request_count > 0 {
        let binding = (
            state
                .executor_id
                .as_deref()
                .ok_or_else(|| JournalError::Corrupt("missing executor binding".into()))?,
            state
                .boot_epoch
                .as_deref()
                .ok_or_else(|| JournalError::Corrupt("missing boot binding".into()))?,
            state
                .connection_id
                .as_deref()
                .ok_or_else(|| JournalError::Corrupt("missing connection binding".into()))?,
        );
        let mismatches: i64 = connection.query_row(
            "SELECT COUNT(*) FROM journal_requests WHERE executor_id != ?1 OR boot_epoch != ?2 OR connection_id != ?3",
            params![binding.0, binding.1, binding.2],
            |row| row.get(0),
        )?;
        if mismatches != 0 {
            return Err(JournalError::Corrupt("request binding mismatch".into()));
        }
    }
    Ok(())
}

fn classify_sequence(actual: u64, last: u64) -> Result<SequenceClass, JournalError> {
    if actual == 0 {
        return Err(JournalError::SequenceGap {
            expected: last.checked_add(1).ok_or(JournalError::SequenceExhausted)?,
            actual,
        });
    }
    let expected = last.checked_add(1).ok_or(JournalError::SequenceExhausted)?;
    if actual == expected {
        Ok(SequenceClass::Next)
    } else if actual <= last {
        Ok(SequenceClass::Existing)
    } else {
        Err(JournalError::SequenceGap { expected, actual })
    }
}

fn enforce_capacity(
    limits: JournalLimits,
    state: &JournalState,
    added_bytes: u64,
    added_requests: u64,
) -> Result<(), JournalError> {
    let requests = state
        .request_count
        .checked_add(added_requests)
        .ok_or(JournalError::StorageLimit)?;
    let bytes = state
        .total_bytes
        .checked_add(added_bytes)
        .ok_or(JournalError::StorageLimit)?;
    if requests > limits.max_requests || bytes > limits.max_bytes {
        return Err(JournalError::StorageLimit);
    }
    Ok(())
}

fn update_committed_sequence(
    transaction: &Transaction<'_>,
    server_seq: u64,
    added_bytes: u64,
    added_requests: u64,
) -> Result<(), JournalError> {
    transaction.execute(
        "UPDATE journal_state
         SET last_server_seq = ?1,
             total_bytes = total_bytes + ?2,
             request_count = request_count + ?3
         WHERE singleton = 1",
        params![
            seq_blob(server_seq),
            added_bytes as i64,
            added_requests as i64
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpis_protocol::{PROTOCOL_VERSION, Request, Response};
    use serde_json::json;
    use tempfile::TempDir;

    const EPOCH: &str = "00112233445566778899aabbccddeeff";

    fn request(seq: u64, request_id: &str, source: &str) -> ServerFrame {
        ServerFrame::Request {
            protocol: PROTOCOL_VERSION,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            seq,
            request: Request::Validate {
                protocol: PROTOCOL_VERSION,
                request_id: request_id.into(),
                source: source.into(),
            },
        }
    }

    fn heartbeat(seq: u64) -> ServerFrame {
        ServerFrame::Heartbeat {
            protocol: PROTOCOL_VERSION,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            seq,
        }
    }

    fn client_heartbeat(client_seq: u64, observed_server_seq: u64) -> ClientFrame {
        ClientFrame::Heartbeat {
            protocol: PROTOCOL_VERSION,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            seq: client_seq,
            observed_server_seq,
        }
    }

    fn response(client_seq: u64, request_seq: u64, request_id: &str) -> ClientFrame {
        ClientFrame::Response {
            protocol: PROTOCOL_VERSION,
            executor_id: "executor-1".into(),
            boot_epoch: EPOCH.into(),
            connection_id: "connection-1".into(),
            seq: client_seq,
            request_seq,
            response: Response::success(request_id.into(), "validate", json!({"valid": true})),
        }
    }

    fn database(temp: &TempDir) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let state = temp.path().join("state");
        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        state.join("journal.sqlite")
    }

    fn open(temp: &TempDir) -> Journal {
        Journal::open(database(temp), JournalLimits::default()).unwrap()
    }

    #[test]
    fn fence_checkpoint_reconstructs_completed_and_ambiguous_requests() {
        let temp = TempDir::new().unwrap();
        let mut journal = open(&temp);
        let empty = journal
            .fence_checkpoint("executor-1", EPOCH, "connection-1")
            .unwrap();
        assert_eq!(empty.last_committed_server_seq, 0);
        assert_eq!(empty.next_client_seq, 1);
        assert!(empty.request_seqs.is_empty());
        assert!(empty.responded_request_seqs.is_empty());

        let prepared = match journal.prepare(&request(1, "request-1", "x = 1")).unwrap() {
            PrepareOutcome::New(prepared) => prepared,
            PrepareOutcome::Existing(_) => panic!("request unexpectedly existed"),
        };
        journal
            .complete(&prepared, &response(1, 1, "request-1"))
            .unwrap();
        journal.prepare(&request(2, "request-2", "x = 2")).unwrap();
        drop(journal);

        let reopened = open(&temp);
        let checkpoint = reopened
            .fence_checkpoint("executor-1", EPOCH, "connection-1")
            .unwrap();
        assert_eq!(checkpoint.last_committed_server_seq, 2);
        assert_eq!(checkpoint.next_client_seq, 2);
        assert_eq!(checkpoint.request_seqs, vec![1, 2]);
        assert_eq!(checkpoint.responded_request_seqs, vec![1]);
        assert!(matches!(
            reopened.fence_checkpoint("executor-1", EPOCH, "other-connection"),
            Err(JournalError::BindingMismatch)
        ));
    }

    #[test]
    fn prepared_and_completed_boundaries_survive_reopen() {
        let temp = TempDir::new().unwrap();
        let mut journal = open(&temp);
        let token = match journal.prepare(&request(1, "request-1", "40 + 2")).unwrap() {
            PrepareOutcome::New(token) => token,
            other => panic!("unexpected {other:?}"),
        };
        let completed = journal
            .complete(&token, &response(1, 1, "request-1"))
            .unwrap();
        drop(journal);

        let mut reopened = open(&temp);
        let stored = reopened.request(1).unwrap().unwrap();
        assert_eq!(stored.status, RequestStatus::Completed);
        assert_eq!(stored.response.as_ref(), Some(&completed));
        assert_eq!(reopened.state().unwrap().last_committed_server_seq, 1);
        assert_eq!(reopened.state().unwrap().next_client_seq, 2);
        assert!(matches!(
            reopened
                .prepare(&request(1, "request-1", "40 + 2"))
                .unwrap(),
            PrepareOutcome::Existing(StoredRequest {
                status: RequestStatus::Completed,
                ..
            })
        ));
        assert!(matches!(
            reopened
                .complete(&token, &response(1, 1, "request-1"))
                .unwrap(),
            StoredResponse { client_seq: 1, .. }
        ));
        assert!(matches!(
            reopened.prepare(&request(1, "request-1", "different")),
            Err(JournalError::RequestConflict(1))
        ));
    }

    #[test]
    fn prepared_only_becomes_ambiguous_and_never_returns_a_new_token() {
        let temp = TempDir::new().unwrap();
        let token = {
            let mut journal = open(&temp);
            match journal
                .prepare(&request(1, "request-1", "effect()"))
                .unwrap()
            {
                PrepareOutcome::New(token) => token,
                other => panic!("unexpected {other:?}"),
            }
        };
        let mut reopened = open(&temp);
        assert_eq!(
            reopened.request(1).unwrap().unwrap().status,
            RequestStatus::Ambiguous
        );
        assert!(matches!(
            reopened
                .prepare(&request(1, "request-1", "effect()"))
                .unwrap(),
            PrepareOutcome::Existing(StoredRequest {
                status: RequestStatus::Ambiguous,
                ..
            })
        ));
        assert!(matches!(
            reopened.complete(&token, &response(1, 1, "request-1")),
            Err(JournalError::Ambiguous(1))
        ));
    }

    #[test]
    fn gaps_heartbeats_and_frame_kind_collisions_fail_closed() {
        let temp = TempDir::new().unwrap();
        let mut journal = open(&temp);
        assert!(matches!(
            journal.prepare(&request(2, "request-2", "x")),
            Err(JournalError::SequenceGap {
                expected: 1,
                actual: 2
            })
        ));
        assert_eq!(
            journal.commit_heartbeat(&heartbeat(1)).unwrap(),
            HeartbeatOutcome::New
        );
        assert_eq!(
            journal.commit_heartbeat(&heartbeat(1)).unwrap(),
            HeartbeatOutcome::Existing
        );
        assert!(matches!(
            journal.prepare(&request(1, "request-1", "x")),
            Err(JournalError::SequenceCollision(1))
        ));
        assert!(matches!(
            journal.commit_heartbeat(&heartbeat(3)),
            Err(JournalError::SequenceGap {
                expected: 2,
                actual: 3
            })
        ));
        assert!(matches!(
            journal.prepare(&request(2, "request-2", "x")).unwrap(),
            PrepareOutcome::New(_)
        ));
        assert!(matches!(
            journal.commit_heartbeat(&heartbeat(2)),
            Err(JournalError::SequenceCollision(2))
        ));
    }

    #[test]
    fn binding_response_and_client_sequence_mismatches_fail_closed() {
        let temp = TempDir::new().unwrap();
        let mut journal = open(&temp);
        let token = match journal.prepare(&request(1, "request-1", "x")).unwrap() {
            PrepareOutcome::New(token) => token,
            other => panic!("unexpected {other:?}"),
        };
        let mut wrong_binding = response(1, 1, "request-1");
        let ClientFrame::Response { connection_id, .. } = &mut wrong_binding else {
            unreachable!()
        };
        *connection_id = "other".into();
        assert!(matches!(
            journal.complete(&token, &wrong_binding),
            Err(JournalError::BindingMismatch)
        ));
        assert!(matches!(
            journal.complete(&token, &response(2, 1, "request-1")),
            Err(JournalError::ClientSequenceMismatch {
                expected: 1,
                actual: 2
            })
        ));
        assert!(matches!(
            journal.complete(&token, &response(1, 1, "other")),
            Err(JournalError::ResponseIdMismatch)
        ));
        assert_eq!(
            journal.request(1).unwrap().unwrap().status,
            RequestStatus::Prepared
        );
    }

    #[test]
    fn client_heartbeats_advance_without_request_rows() {
        let temp = TempDir::new().unwrap();
        let mut journal = open(&temp);
        assert_eq!(
            journal.commit_heartbeat(&heartbeat(1)).unwrap(),
            HeartbeatOutcome::New
        );
        assert_eq!(
            journal
                .commit_client_heartbeat(&client_heartbeat(1, 1))
                .unwrap(),
            ClientHeartbeatOutcome::New
        );
        assert_eq!(journal.state().unwrap().next_client_seq, 2);
        assert_eq!(
            journal
                .commit_client_heartbeat(&client_heartbeat(1, 1))
                .unwrap(),
            ClientHeartbeatOutcome::Existing
        );
        assert!(matches!(
            journal.commit_client_heartbeat(&client_heartbeat(3, 1)),
            Err(JournalError::ClientSequenceMismatch {
                expected: 2,
                actual: 3
            })
        ));
        assert!(matches!(
            journal.commit_client_heartbeat(&client_heartbeat(2, 0)),
            Err(JournalError::ObservedServerSequenceMismatch {
                expected: 1,
                actual: 0
            })
        ));
        let token = match journal.prepare(&request(2, "request-2", "x")).unwrap() {
            PrepareOutcome::New(token) => token,
            other => panic!("unexpected {other:?}"),
        };
        journal
            .complete(&token, &response(2, 2, "request-2"))
            .unwrap();
        assert!(matches!(
            journal.commit_client_heartbeat(&client_heartbeat(2, 2)),
            Err(JournalError::ClientSequenceCollision(2))
        ));
    }

    #[test]
    fn storage_limits_reject_before_mutating_state() {
        let temp = TempDir::new().unwrap();
        let mut journal = Journal::open(
            database(&temp),
            JournalLimits {
                max_requests: 1,
                max_bytes: 8,
            },
        )
        .unwrap();
        assert!(matches!(
            journal.prepare(&request(1, "request-1", "too much")),
            Err(JournalError::StorageLimit)
        ));
        assert_eq!(journal.state().unwrap().last_committed_server_seq, 0);
        assert_eq!(journal.state().unwrap().request_count, 0);
    }

    #[test]
    fn completion_capacity_failure_keeps_request_prepared() {
        let temp = TempDir::new().unwrap();
        let frame = request(1, "request-1", "x");
        let request_len = match &frame {
            ServerFrame::Request { request, .. } => serde_json::to_vec(request).unwrap().len(),
            _ => unreachable!(),
        };
        let mut journal = Journal::open(
            database(&temp),
            JournalLimits {
                max_requests: 1,
                max_bytes: request_len as u64 + 1,
            },
        )
        .unwrap();
        let token = match journal.prepare(&frame).unwrap() {
            PrepareOutcome::New(token) => token,
            other => panic!("unexpected {other:?}"),
        };
        assert!(matches!(
            journal.complete(&token, &response(1, 1, "request-1")),
            Err(JournalError::StorageLimit)
        ));
        assert_eq!(
            journal.request(1).unwrap().unwrap().status,
            RequestStatus::Prepared
        );
        assert_eq!(journal.state().unwrap().next_client_seq, 1);
    }

    #[test]
    fn counter_and_schema_tampering_fail_open_time_audit() {
        let temp = TempDir::new().unwrap();
        let database_path = database(&temp);
        {
            let mut journal = Journal::open(&database_path, JournalLimits::default()).unwrap();
            assert!(matches!(
                journal.prepare(&request(1, "request-1", "x")).unwrap(),
                PrepareOutcome::New(_)
            ));
        }
        let raw = Connection::open(&database_path).unwrap();
        raw.execute("UPDATE journal_state SET total_bytes = total_bytes + 1", [])
            .unwrap();
        drop(raw);
        assert!(matches!(
            Journal::open(&database_path, JournalLimits::default()),
            Err(JournalError::Corrupt(_))
        ));

        let second = TempDir::new().unwrap();
        let second_database = database(&second);
        drop(Journal::open(&second_database, JournalLimits::default()).unwrap());
        let raw = Connection::open(&second_database).unwrap();
        raw.execute("DROP TRIGGER journal_request_no_delete", [])
            .unwrap();
        drop(raw);
        assert!(matches!(
            Journal::open(&second_database, JournalLimits::default()),
            Err(JournalError::Corrupt(_))
        ));
    }

    #[test]
    fn corrupt_and_symlink_database_paths_are_rejected() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let corrupt = temp.path().join("corrupt.sqlite");
        fs::write(&corrupt, b"not sqlite").unwrap();
        assert!(Journal::open(&corrupt, JournalLimits::default()).is_err());

        let target = temp.path().join("target.sqlite");
        let link = temp.path().join("link.sqlite");
        fs::write(&target, b"").unwrap();
        symlink(&target, &link).unwrap();
        assert!(matches!(
            Journal::open(&link, JournalLimits::default()),
            Err(JournalError::UnsafePath(_))
        ));

        let shared = temp.path().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            Journal::open(shared.join("journal.sqlite"), JournalLimits::default()),
            Err(JournalError::UnsafePath(_))
        ));
        assert_eq!(
            fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
