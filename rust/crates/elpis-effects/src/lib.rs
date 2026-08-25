//! Durable, authoritative idempotency ledger for capability side effects.
//!
//! This database intentionally has no dependency on the transport journal or
//! protocol. A caller must durably prepare an effect before executing it and
//! must durably complete it before delivering the receipt. If execution becomes
//! uncertain, the caller must consume its execution token to durably mark that
//! exact effect ambiguous before releasing ownership. A prepared effect also
//! becomes ambiguous whenever the database is reopened, so a process can never
//! silently execute it again after losing whether the effect occurred.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 1;
// "ELPE", deliberately distinct from elpis-journal's "ELPJ".
const APPLICATION_ID: i64 = 0x454c_5045;
const EFFECT_ID_DOMAIN: &[u8] = b"elpis-authoritative-effect-v1\0";

/// Maximum ASCII size of request, context, and run identifiers.
pub const MAX_ID_BYTES: usize = 120;
/// Maximum ASCII size of a capability name.
pub const MAX_CAPABILITY_BYTES: usize = 120;
/// Absolute bound on one canonical capability request.
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// Absolute bound on one canonical capability receipt.
pub const MAX_RECEIPT_BYTES: usize = 256 * 1024;
/// Conventional filename kept separate from the transport journal.
pub const EFFECTS_DATABASE_FILENAME: &str = "effects.sqlite";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectLimits {
    pub max_effects: u64,
    pub max_bytes: u64,
}

impl Default for EffectLimits {
    fn default() -> Self {
        Self {
            max_effects: 10_000,
            max_bytes: 64 * 1024 * 1024,
        }
    }
}

/// The complete identity of one capability invocation.
/// The bytes must already use the capability's canonical request encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectIdentity {
    request_id: String,
    context_id: String,
    generation: u64,
    run_id: String,
    call_index: u64,
    capability: String,
    canonical_request_bytes: Vec<u8>,
    canonical_request_sha256: [u8; 32],
}

impl EffectIdentity {
    pub fn new(
        request_id: impl Into<String>,
        context_id: impl Into<String>,
        generation: u64,
        run_id: impl Into<String>,
        call_index: u64,
        capability: impl Into<String>,
        canonical_request_bytes: impl Into<Vec<u8>>,
    ) -> Result<Self, EffectError> {
        let canonical_request_bytes = canonical_request_bytes.into();
        let identity = Self {
            request_id: request_id.into(),
            context_id: context_id.into(),
            generation,
            run_id: run_id.into(),
            call_index,
            capability: capability.into(),
            canonical_request_sha256: sha256(&canonical_request_bytes),
            canonical_request_bytes,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn context_id(&self) -> &str {
        &self.context_id
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn call_index(&self) -> u64 {
        self.call_index
    }
    pub fn capability(&self) -> &str {
        &self.capability
    }
    pub fn canonical_request_bytes(&self) -> &[u8] {
        &self.canonical_request_bytes
    }
    pub fn canonical_request_sha256(&self) -> [u8; 32] {
        self.canonical_request_sha256
    }

    /// Stable domain-separated digest over every length-delimited field.
    pub fn effect_id(&self) -> EffectId {
        let mut digest = Sha256::new();
        digest.update(EFFECT_ID_DOMAIN);
        hash_field(&mut digest, self.request_id.as_bytes());
        hash_field(&mut digest, self.context_id.as_bytes());
        digest.update(self.generation.to_be_bytes());
        hash_field(&mut digest, self.run_id.as_bytes());
        digest.update(self.call_index.to_be_bytes());
        hash_field(&mut digest, self.capability.as_bytes());
        hash_field(&mut digest, &self.canonical_request_bytes);
        digest.update(self.canonical_request_sha256);
        EffectId(digest.finalize().into())
    }

    fn validate(&self) -> Result<(), EffectError> {
        validate_name("request_id", &self.request_id, MAX_ID_BYTES)?;
        validate_name("context_id", &self.context_id, MAX_ID_BYTES)?;
        validate_name("run_id", &self.run_id, MAX_ID_BYTES)?;
        validate_name("capability", &self.capability, MAX_CAPABILITY_BYTES)?;
        if self.generation == 0 {
            return Err(EffectError::InvalidGeneration);
        }
        if self.canonical_request_bytes.len() > MAX_REQUEST_BYTES {
            return Err(EffectError::FieldTooLarge("canonical_request_bytes"));
        }
        if sha256(&self.canonical_request_bytes) != self.canonical_request_sha256 {
            return Err(EffectError::RequestHashMismatch);
        }
        Ok(())
    }

    fn accounted_bytes(&self) -> Result<u64, EffectError> {
        [
            self.request_id.len(),
            self.context_id.len(),
            self.run_id.len(),
            self.capability.len(),
            self.canonical_request_bytes.len(),
            32,
            32,
            8,
            8,
        ]
        .into_iter()
        .try_fold(0_u64, |total, length| {
            total
                .checked_add(length as u64)
                .ok_or(EffectError::InvalidLimits)
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct EffectId([u8; 32]);

impl EffectId {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }
}
impl AsRef<[u8]> for EffectId {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}
impl fmt::Debug for EffectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("EffectId")
            .field(&hex::encode(self.0))
            .finish()
    }
}
impl fmt::Display for EffectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

/// Non-cloneable execution authority minted only for a newly prepared row.
#[derive(Debug, PartialEq, Eq)]
pub struct ExecutionToken {
    effect_id: EffectId,
    request_sha256: [u8; 32],
}
impl ExecutionToken {
    pub fn effect_id(&self) -> EffectId {
        self.effect_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectStatus {
    Prepared,
    Completed,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredReceipt {
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEffect {
    pub effect_id: EffectId,
    pub identity: EffectIdentity,
    pub status: EffectStatus,
    pub receipt: Option<StoredReceipt>,
}

/// Exactly one variant contains execution authority.
#[derive(Debug, PartialEq, Eq)]
pub enum PrepareOutcome {
    New(ExecutionToken),
    Completed(StoredReceipt),
    Prepared,
    Ambiguous,
}

#[derive(Debug)]
pub enum AmbiguityFallback {
    Marked,
    AlreadyAmbiguous,
    AlreadyCompleted,
    Unconfirmed(Box<EffectError>),
}

impl fmt::Display for AmbiguityFallback {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Marked => f.write_str("marked ambiguous"),
            Self::AlreadyAmbiguous => f.write_str("already ambiguous"),
            Self::AlreadyCompleted => f.write_str("already completed"),
            Self::Unconfirmed(error) => write!(f, "could not confirm ambiguity: {error}"),
        }
    }
}

#[derive(Debug)]
pub struct CompletionFailure {
    completion_error: Box<EffectError>,
    ambiguity_fallback: AmbiguityFallback,
}

impl CompletionFailure {
    pub fn completion_error(&self) -> &EffectError {
        self.completion_error.as_ref()
    }

    pub fn ambiguity_fallback(&self) -> &AmbiguityFallback {
        &self.ambiguity_fallback
    }

    pub fn into_parts(self) -> (EffectError, AmbiguityFallback) {
        (*self.completion_error, self.ambiguity_fallback)
    }
}

impl fmt::Display for CompletionFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "effect completion failed: {}; ambiguity fallback {}",
            self.completion_error, self.ambiguity_fallback
        )
    }
}

impl std::error::Error for CompletionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.completion_error.as_ref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectLedgerState {
    pub effect_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug)]
pub struct EffectLedger {
    path: PathBuf,
    connection: Connection,
    limits: EffectLimits,
}
impl EffectLedger {
    pub fn open(path: impl AsRef<Path>, limits: EffectLimits) -> Result<Self, EffectError> {
        validate_limits(limits)?;
        let path = path.as_ref().to_path_buf();
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
        let actual: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if !actual.eq_ignore_ascii_case("wal") {
            return Err(EffectError::Corrupt("could not enable WAL mode".into()));
        }
        connection.pragma_update(None, "synchronous", "FULL")?;
        let synchronous: i64 =
            connection.pragma_query_value(None, "synchronous", |row| row.get(0))?;
        if synchronous != 2 {
            return Err(EffectError::Corrupt(
                "could not enable FULL synchronous mode".into(),
            ));
        }
        connection.pragma_update(None, "foreign_keys", "ON")?;
        run_quick_check(&connection)?;
        initialize_schema(&mut connection)?;
        validate_integrity(&connection, limits)?;
        let mut ledger = Self {
            path,
            connection,
            limits,
        };
        ledger.recover_prepared()?;
        Ok(ledger)
    }

    /// Opens the conventional `effects.sqlite` inside a private state directory.
    pub fn open_directory(
        directory: impl AsRef<Path>,
        limits: EffectLimits,
    ) -> Result<Self, EffectError> {
        Self::open(directory.as_ref().join(EFFECTS_DATABASE_FILENAME), limits)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn state(&self) -> Result<EffectLedgerState, EffectError> {
        load_state_connection(&self.connection)
    }

    pub fn prepare(&mut self, identity: &EffectIdentity) -> Result<PrepareOutcome, EffectError> {
        identity.validate()?;
        let effect_id = identity.effect_id();
        let limits = self.limits;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(stored) = load_by_logical_key(&transaction, identity)? {
            ensure_same_identity(&stored, identity)?;
            let outcome = match stored.status {
                EffectStatus::Prepared => PrepareOutcome::Prepared,
                EffectStatus::Ambiguous => PrepareOutcome::Ambiguous,
                EffectStatus::Completed => {
                    PrepareOutcome::Completed(stored.receipt.ok_or_else(|| {
                        EffectError::Corrupt("completed effect has no receipt".into())
                    })?)
                }
            };
            transaction.commit()?;
            return Ok(outcome);
        }
        if transaction
            .query_row(
                "SELECT 1 FROM effects WHERE effect_id = ?1",
                params![effect_id.as_bytes().as_slice()],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(EffectError::EffectIdCollision);
        }
        let state = load_state_transaction(&transaction)?;
        let added_bytes = identity.accounted_bytes()?;
        enforce_capacity(limits, state, added_bytes, 1)?;
        transaction.execute(
            "INSERT INTO effects (
                effect_id, request_id, context_id, generation, run_id,
                call_index, capability, request_sha256, request_bytes, status
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'prepared')",
            params![
                effect_id.as_bytes().as_slice(),
                identity.request_id,
                identity.context_id,
                u64_blob(identity.generation).as_slice(),
                identity.run_id,
                u64_blob(identity.call_index).as_slice(),
                identity.capability,
                identity.canonical_request_sha256.as_slice(),
                identity.canonical_request_bytes
            ],
        )?;
        let changed = transaction.execute(
            "UPDATE effects_state SET effect_count = effect_count + 1,
             total_bytes = total_bytes + ?1 WHERE singleton = 1",
            params![to_i64(added_bytes)?],
        )?;
        if changed != 1 {
            return Err(EffectError::ConcurrentChange);
        }
        transaction.commit()?;
        Ok(PrepareOutcome::New(ExecutionToken {
            effect_id,
            request_sha256: identity.canonical_request_sha256,
        }))
    }

    /// Durably relinquishes execution authority after an effect may have occurred.
    ///
    /// This transition is deliberately one-shot rather than idempotent: the token is
    /// consumed on every outcome, and a row that is already ambiguous is rejected.
    /// Thus an error can never return execution authority for a possibly performed
    /// effect. Reopening the ledger will conservatively recover any row that remained
    /// prepared.
    pub fn mark_ambiguous(&mut self, token: ExecutionToken) -> Result<(), EffectError> {
        self.mark_ambiguous_inner(&token)
    }

    fn mark_ambiguous_inner(&mut self, token: &ExecutionToken) -> Result<(), EffectError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored =
            load_by_effect_id(&transaction, token.effect_id)?.ok_or(EffectError::UnknownToken)?;
        if stored.identity.canonical_request_sha256 != token.request_sha256 {
            return Err(EffectError::UnknownToken);
        }
        match stored.status {
            EffectStatus::Prepared => {}
            EffectStatus::Ambiguous => return Err(EffectError::Ambiguous(token.effect_id)),
            EffectStatus::Completed => return Err(EffectError::AlreadyCompleted(token.effect_id)),
        }
        let changed = transaction.execute(
            "UPDATE effects SET status = 'ambiguous'
             WHERE effect_id = ?1 AND request_sha256 = ?2 AND status = 'prepared'",
            params![
                token.effect_id.as_bytes().as_slice(),
                token.request_sha256.as_slice()
            ],
        )?;
        if changed != 1 {
            return Err(EffectError::ConcurrentChange);
        }
        transaction.commit()?;
        Ok(())
    }

    /// Stores exact receipt bytes durably before they can be delivered.
    pub fn complete(
        &mut self,
        token: ExecutionToken,
        canonical_receipt_bytes: impl AsRef<[u8]>,
    ) -> Result<StoredReceipt, EffectError> {
        self.complete_inner(&token, canonical_receipt_bytes.as_ref())
    }

    /// Consumes one execution token into either a durable receipt or a bounded
    /// account of the attempted ambiguity fallback.
    pub fn complete_or_mark_ambiguous(
        &mut self,
        token: ExecutionToken,
        canonical_receipt_bytes: impl AsRef<[u8]>,
    ) -> Result<StoredReceipt, CompletionFailure> {
        match self.complete_inner(&token, canonical_receipt_bytes.as_ref()) {
            Ok(receipt) => Ok(receipt),
            Err(completion_error) => {
                let ambiguity_fallback = match self.mark_ambiguous_inner(&token) {
                    Ok(()) => AmbiguityFallback::Marked,
                    Err(EffectError::Ambiguous(_)) => AmbiguityFallback::AlreadyAmbiguous,
                    Err(EffectError::AlreadyCompleted(_)) => AmbiguityFallback::AlreadyCompleted,
                    Err(error) => AmbiguityFallback::Unconfirmed(Box::new(error)),
                };
                Err(CompletionFailure {
                    completion_error: Box::new(completion_error),
                    ambiguity_fallback,
                })
            }
        }
    }

    fn complete_inner(
        &mut self,
        token: &ExecutionToken,
        bytes: &[u8],
    ) -> Result<StoredReceipt, EffectError> {
        if bytes.len() > MAX_RECEIPT_BYTES {
            return Err(EffectError::FieldTooLarge("canonical_receipt_bytes"));
        }
        let receipt = StoredReceipt {
            bytes: bytes.to_vec(),
            sha256: sha256(bytes),
        };
        let limits = self.limits;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored =
            load_by_effect_id(&transaction, token.effect_id)?.ok_or(EffectError::UnknownToken)?;
        if stored.identity.canonical_request_sha256 != token.request_sha256 {
            return Err(EffectError::UnknownToken);
        }
        match stored.status {
            EffectStatus::Prepared => {}
            EffectStatus::Ambiguous => return Err(EffectError::Ambiguous(token.effect_id)),
            EffectStatus::Completed => return Err(EffectError::AlreadyCompleted(token.effect_id)),
        }
        let state = load_state_transaction(&transaction)?;
        let added_bytes = (receipt.bytes.len() as u64)
            .checked_add(32)
            .ok_or(EffectError::InvalidLimits)?;
        enforce_capacity(limits, state, added_bytes, 0)?;
        let changed = transaction.execute(
            "UPDATE effects SET status = 'completed', receipt_sha256 = ?1, receipt_bytes = ?2
             WHERE effect_id = ?3 AND status = 'prepared'",
            params![
                receipt.sha256.as_slice(),
                receipt.bytes.as_slice(),
                token.effect_id.as_bytes().as_slice()
            ],
        )?;
        if changed != 1 {
            return Err(EffectError::ConcurrentChange);
        }
        let changed = transaction.execute(
            "UPDATE effects_state SET total_bytes = total_bytes + ?1 WHERE singleton = 1",
            params![to_i64(added_bytes)?],
        )?;
        if changed != 1 {
            return Err(EffectError::ConcurrentChange);
        }
        transaction.commit()?;
        Ok(receipt)
    }

    pub fn effect(&self, effect_id: EffectId) -> Result<Option<StoredEffect>, EffectError> {
        load_by_effect_id_connection(&self.connection, effect_id)
    }

    fn recover_prepared(&mut self) -> Result<u64, EffectError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE effects SET status = 'ambiguous' WHERE status = 'prepared'",
            [],
        )?;
        transaction.commit()?;
        Ok(changed as u64)
    }
}

#[derive(Debug, Error)]
pub enum EffectError {
    #[error("effects SQLite error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("effects ledger I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("effects ledger is corrupt: {0}")]
    Corrupt(String),
    #[error("unsafe effects path: {0}")]
    UnsafePath(String),
    #[error("effect limits must be nonzero and fit SQLite counters")]
    InvalidLimits,
    #[error("{0} is empty")]
    EmptyField(&'static str),
    #[error("{0} exceeds its canonical bound")]
    FieldTooLarge(&'static str),
    #[error("{0} contains bytes outside ASCII letters, digits, '.', '_', ':', or '-'")]
    InvalidName(&'static str),
    #[error("generation must be greater than zero")]
    InvalidGeneration,
    #[error("canonical request SHA-256 does not match its bytes")]
    RequestHashMismatch,
    #[error("canonical request bytes changed under the same logical effect key")]
    Conflict,
    #[error("effect ID collision")]
    EffectIdCollision,
    #[error("effects ledger storage limit exceeded")]
    StorageLimit,
    #[error("execution token does not name a prepared effect")]
    UnknownToken,
    #[error("effect {0} is ambiguous and cannot be completed")]
    Ambiguous(EffectId),
    #[error("effect {0} is already completed")]
    AlreadyCompleted(EffectId),
    #[error("effects ledger row changed concurrently")]
    ConcurrentChange,
}

fn validate_name(name: &'static str, value: &str, max: usize) -> Result<(), EffectError> {
    if value.is_empty() {
        return Err(EffectError::EmptyField(name));
    }
    if value.len() > max {
        return Err(EffectError::FieldTooLarge(name));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(EffectError::InvalidName(name));
    }
    Ok(())
}
fn validate_limits(limits: EffectLimits) -> Result<(), EffectError> {
    if limits.max_effects == 0
        || limits.max_bytes == 0
        || limits.max_effects > i64::MAX as u64
        || limits.max_bytes > i64::MAX as u64
    {
        return Err(EffectError::InvalidLimits);
    }
    Ok(())
}
fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn hash_field(digest: &mut Sha256, bytes: &[u8]) {
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
}
fn u64_blob(value: u64) -> [u8; 8] {
    value.to_be_bytes()
}
fn decode_u64(bytes: Vec<u8>, field: &str) -> Result<u64, EffectError> {
    let bytes: [u8; 8] = bytes
        .try_into()
        .map_err(|_| EffectError::Corrupt(format!("{field} is not an eight-byte counter")))?;
    Ok(u64::from_be_bytes(bytes))
}
fn to_i64(value: u64) -> Result<i64, EffectError> {
    i64::try_from(value).map_err(|_| EffectError::InvalidLimits)
}

fn prepare_path(path: &Path) -> Result<bool, EffectError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(EffectError::UnsafePath(
            "database path must be absolute and have a file name".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| EffectError::UnsafePath("database path has no parent".into()))?;
    if parent.exists() {
        require_private_owned_dir(parent)?;
    } else {
        create_private_dir(parent)?;
        require_private_owned_dir(parent)?;
    }
    if fs::canonicalize(parent)? != parent {
        return Err(EffectError::UnsafePath(
            "state parent has a symlinked or non-canonical ancestor".into(),
        ));
    }
    let existed = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            require_private_owned_file(&metadata)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    Ok(existed)
}

#[cfg(unix)]
fn require_owned(metadata: &fs::Metadata, label: &str) -> Result<(), EffectError> {
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(EffectError::UnsafePath(format!(
            "{label} is not owned by the current user"
        )));
    }
    Ok(())
}
#[cfg(not(unix))]
fn require_owned(_metadata: &fs::Metadata, _label: &str) -> Result<(), EffectError> {
    Ok(())
}

#[cfg(unix)]
fn require_private_owned_dir(path: &Path) -> Result<(), EffectError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(EffectError::UnsafePath(
            "state parent is not a real directory".into(),
        ));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(EffectError::UnsafePath(
            "state parent is not owned by the current user".into(),
        ));
    }
    if metadata.permissions().mode() & 0o7777 != 0o700 {
        return Err(EffectError::UnsafePath(
            "state parent mode is not 0700".into(),
        ));
    }
    Ok(())
}
#[cfg(not(unix))]
fn require_private_owned_dir(_path: &Path) -> Result<(), EffectError> {
    Ok(())
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> Result<(), EffectError> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)?;
    Ok(())
}
#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> Result<(), EffectError> {
    fs::create_dir(path)?;
    Ok(())
}

#[cfg(all(test, unix))]
fn set_private_dir_mode(path: &Path) -> Result<(), EffectError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
#[cfg(all(test, not(unix)))]
fn set_private_dir_mode(_path: &Path) -> Result<(), EffectError> {
    Ok(())
}

fn secure_database_file(path: &Path, existed: bool) -> Result<(), EffectError> {
    if !existed {
        set_private_file_mode(path)?;
    }
    require_private_owned_file(&fs::symlink_metadata(path)?)
}

#[cfg(unix)]
fn require_private_owned_file(metadata: &fs::Metadata) -> Result<(), EffectError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(EffectError::UnsafePath(
            "database is not a regular file".into(),
        ));
    }
    require_owned(metadata, "database file")?;
    if metadata.nlink() != 1 {
        return Err(EffectError::UnsafePath(
            "database has multiple hard links".into(),
        ));
    }
    if metadata.permissions().mode() & 0o7777 != 0o600 {
        return Err(EffectError::UnsafePath(
            "existing database mode is not 0600".into(),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_owned_file(metadata: &fs::Metadata) -> Result<(), EffectError> {
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(EffectError::UnsafePath(
            "database is not a regular file".into(),
        ));
    }
    Ok(())
}
#[cfg(unix)]
fn set_private_file_mode(path: &Path) -> Result<(), EffectError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}
#[cfg(not(unix))]
fn set_private_file_mode(_path: &Path) -> Result<(), EffectError> {
    Ok(())
}

fn run_quick_check(connection: &Connection) -> Result<(), EffectError> {
    let mut statement = connection
        .prepare("PRAGMA quick_check")
        .map_err(|e| EffectError::Corrupt(format!("quick_check failed: {e}")))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| EffectError::Corrupt(format!("quick_check failed: {e}")))?;
    for row in rows {
        let result = row.map_err(|e| EffectError::Corrupt(format!("quick_check failed: {e}")))?;
        if result != "ok" {
            return Err(EffectError::Corrupt(result));
        }
    }
    Ok(())
}

fn initialize_schema(connection: &mut Connection) -> Result<(), EffectError> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 0 && version != SCHEMA_VERSION {
        return Err(EffectError::Corrupt(format!(
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
            return Err(EffectError::Corrupt(
                "unversioned database already contains objects".into(),
            ));
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE effects_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                effect_count INTEGER NOT NULL CHECK (effect_count >= 0),
                total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0)
             );
             CREATE TABLE effects (
                effect_id BLOB PRIMARY KEY CHECK (typeof(effect_id) = 'blob' AND length(effect_id) = 32),
                request_id TEXT NOT NULL CHECK (typeof(request_id) = 'text' AND length(CAST(request_id AS BLOB)) BETWEEN 1 AND 120 AND request_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
                context_id TEXT NOT NULL CHECK (typeof(context_id) = 'text' AND length(CAST(context_id AS BLOB)) BETWEEN 1 AND 120 AND context_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
                generation BLOB NOT NULL CHECK (typeof(generation) = 'blob' AND length(generation) = 8 AND generation != zeroblob(8)),
                run_id TEXT NOT NULL CHECK (typeof(run_id) = 'text' AND length(CAST(run_id AS BLOB)) BETWEEN 1 AND 120 AND run_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
                call_index BLOB NOT NULL CHECK (typeof(call_index) = 'blob' AND length(call_index) = 8),
                capability TEXT NOT NULL CHECK (typeof(capability) = 'text' AND length(CAST(capability AS BLOB)) BETWEEN 1 AND 120 AND capability NOT GLOB '*[^A-Za-z0-9._:-]*'),
                request_sha256 BLOB NOT NULL CHECK (typeof(request_sha256) = 'blob' AND length(request_sha256) = 32),
                request_bytes BLOB NOT NULL CHECK (typeof(request_bytes) = 'blob' AND length(request_bytes) <= 262144),
                status TEXT NOT NULL CHECK (status IN ('prepared','completed','ambiguous')),
                receipt_sha256 BLOB CHECK (receipt_sha256 IS NULL OR (typeof(receipt_sha256) = 'blob' AND length(receipt_sha256) = 32)),
                receipt_bytes BLOB CHECK (receipt_bytes IS NULL OR (typeof(receipt_bytes) = 'blob' AND length(receipt_bytes) <= 262144)),
                UNIQUE (request_id, context_id, generation, run_id, call_index),
                CHECK (
                    (status = 'completed' AND receipt_sha256 IS NOT NULL AND receipt_bytes IS NOT NULL)
                    OR
                    (status IN ('prepared','ambiguous') AND receipt_sha256 IS NULL AND receipt_bytes IS NULL)
                )
             );
             CREATE TRIGGER effect_identity_immutable
             BEFORE UPDATE ON effects
             WHEN OLD.effect_id IS NOT NEW.effect_id
               OR OLD.request_id IS NOT NEW.request_id
               OR OLD.context_id IS NOT NEW.context_id
               OR OLD.generation IS NOT NEW.generation
               OR OLD.run_id IS NOT NEW.run_id
               OR OLD.call_index IS NOT NEW.call_index
               OR OLD.capability IS NOT NEW.capability
               OR OLD.request_sha256 IS NOT NEW.request_sha256
               OR OLD.request_bytes IS NOT NEW.request_bytes
             BEGIN SELECT RAISE(ABORT, 'effect identity is immutable'); END;
             CREATE TRIGGER effect_lifecycle
             BEFORE UPDATE OF status ON effects
             WHEN NOT (
                (OLD.status = 'prepared' AND NEW.status IN ('completed','ambiguous'))
                OR OLD.status = NEW.status
             )
             BEGIN SELECT RAISE(ABORT, 'invalid effect lifecycle transition'); END;
             CREATE TRIGGER effect_insert_prepared
             BEFORE INSERT ON effects WHEN NEW.status != 'prepared'
             BEGIN SELECT RAISE(ABORT, 'new effect must be prepared'); END;
             CREATE TRIGGER effect_completion_immutable
             BEFORE UPDATE ON effects
             WHEN OLD.status = 'completed' AND (
                OLD.status IS NOT NEW.status
                OR OLD.receipt_sha256 IS NOT NEW.receipt_sha256
                OR OLD.receipt_bytes IS NOT NEW.receipt_bytes
             )
             BEGIN SELECT RAISE(ABORT, 'completed effect is immutable'); END;
             CREATE TRIGGER effect_no_delete
             BEFORE DELETE ON effects
             BEGIN SELECT RAISE(ABORT, 'effects are append-only'); END;
             CREATE TRIGGER effects_state_no_delete
             BEFORE DELETE ON effects_state
             BEGIN SELECT RAISE(ABORT, 'effects state cannot be deleted'); END;"
        )?;
        transaction.execute(
            "INSERT INTO effects_state (singleton, effect_count, total_bytes) VALUES (1, 0, 0)",
            [],
        )?;
        transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
    }
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != APPLICATION_ID {
        return Err(EffectError::Corrupt("wrong application id".into()));
    }
    for (kind, name) in [
        ("table", "effects_state"),
        ("table", "effects"),
        ("trigger", "effect_identity_immutable"),
        ("trigger", "effect_lifecycle"),
        ("trigger", "effect_insert_prepared"),
        ("trigger", "effect_completion_immutable"),
        ("trigger", "effect_no_delete"),
        ("trigger", "effects_state_no_delete"),
    ] {
        let present: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2",
            params![kind, name],
            |row| row.get(0),
        )?;
        if present != 1 {
            return Err(EffectError::Corrupt(format!(
                "missing effects {kind} {name}"
            )));
        }
    }
    Ok(())
}

fn load_state_connection(connection: &Connection) -> Result<EffectLedgerState, EffectError> {
    connection
        .query_row(
            "SELECT effect_count, total_bytes FROM effects_state WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(EffectError::from)
        .and_then(decode_state)
}
fn load_state_transaction(transaction: &Transaction<'_>) -> Result<EffectLedgerState, EffectError> {
    transaction
        .query_row(
            "SELECT effect_count, total_bytes FROM effects_state WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(EffectError::from)
        .and_then(decode_state)
}
fn decode_state((count, bytes): (i64, i64)) -> Result<EffectLedgerState, EffectError> {
    Ok(EffectLedgerState {
        effect_count: count
            .try_into()
            .map_err(|_| EffectError::Corrupt("negative effect count".into()))?,
        total_bytes: bytes
            .try_into()
            .map_err(|_| EffectError::Corrupt("negative byte count".into()))?,
    })
}

fn enforce_capacity(
    limits: EffectLimits,
    state: EffectLedgerState,
    added_bytes: u64,
    added_effects: u64,
) -> Result<(), EffectError> {
    let count = state
        .effect_count
        .checked_add(added_effects)
        .ok_or(EffectError::StorageLimit)?;
    let bytes = state
        .total_bytes
        .checked_add(added_bytes)
        .ok_or(EffectError::StorageLimit)?;
    if count > limits.max_effects || bytes > limits.max_bytes {
        return Err(EffectError::StorageLimit);
    }
    Ok(())
}

const EFFECT_COLUMNS: &str =
    "effect_id, request_id, context_id, generation, run_id, call_index, capability,
     request_sha256, request_bytes, status, receipt_sha256, receipt_bytes";

fn load_by_logical_key(
    transaction: &Transaction<'_>,
    identity: &EffectIdentity,
) -> Result<Option<StoredEffect>, EffectError> {
    let sql = format!(
        "SELECT {EFFECT_COLUMNS} FROM effects
         WHERE request_id = ?1 AND context_id = ?2 AND generation = ?3
           AND run_id = ?4 AND call_index = ?5"
    );
    let raw = transaction
        .query_row(
            &sql,
            params![
                identity.request_id,
                identity.context_id,
                u64_blob(identity.generation).as_slice(),
                identity.run_id,
                u64_blob(identity.call_index).as_slice()
            ],
            decode_effect_row,
        )
        .optional()?;
    raw.map(decode_effect).transpose()
}

fn load_by_effect_id(
    transaction: &Transaction<'_>,
    effect_id: EffectId,
) -> Result<Option<StoredEffect>, EffectError> {
    let sql = format!("SELECT {EFFECT_COLUMNS} FROM effects WHERE effect_id = ?1");
    transaction
        .query_row(
            &sql,
            params![effect_id.as_bytes().as_slice()],
            decode_effect_row,
        )
        .optional()?
        .map(decode_effect)
        .transpose()
}

fn load_by_effect_id_connection(
    connection: &Connection,
    effect_id: EffectId,
) -> Result<Option<StoredEffect>, EffectError> {
    let sql = format!("SELECT {EFFECT_COLUMNS} FROM effects WHERE effect_id = ?1");
    connection
        .query_row(
            &sql,
            params![effect_id.as_bytes().as_slice()],
            decode_effect_row,
        )
        .optional()?
        .map(decode_effect)
        .transpose()
}

type RawEffect = (
    Vec<u8>,
    String,
    String,
    Vec<u8>,
    String,
    Vec<u8>,
    String,
    Vec<u8>,
    Vec<u8>,
    String,
    Option<Vec<u8>>,
    Option<Vec<u8>>,
);

fn decode_effect_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawEffect> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
    ))
}

fn decode_effect(raw: RawEffect) -> Result<StoredEffect, EffectError> {
    let (
        effect_id,
        request_id,
        context_id,
        generation,
        run_id,
        call_index,
        capability,
        request_sha256,
        request_bytes,
        status,
        receipt_sha256,
        receipt_bytes,
    ) = raw;
    let effect_id = EffectId(
        effect_id
            .try_into()
            .map_err(|_| EffectError::Corrupt("effect ID has wrong length".into()))?,
    );
    let request_sha256: [u8; 32] = request_sha256
        .try_into()
        .map_err(|_| EffectError::Corrupt("request hash has wrong length".into()))?;
    let identity = EffectIdentity {
        request_id,
        context_id,
        generation: decode_u64(generation, "generation")?,
        run_id,
        call_index: decode_u64(call_index, "call index")?,
        capability,
        canonical_request_bytes: request_bytes,
        canonical_request_sha256: request_sha256,
    };
    identity
        .validate()
        .map_err(|error| EffectError::Corrupt(error.to_string()))?;
    if identity.effect_id() != effect_id {
        return Err(EffectError::Corrupt(
            "stored effect ID does not match identity".into(),
        ));
    }
    let (status, receipt) = match status.as_str() {
        "prepared" if receipt_sha256.is_none() && receipt_bytes.is_none() => {
            (EffectStatus::Prepared, None)
        }
        "ambiguous" if receipt_sha256.is_none() && receipt_bytes.is_none() => {
            (EffectStatus::Ambiguous, None)
        }
        "completed" => {
            let bytes = receipt_bytes
                .ok_or_else(|| EffectError::Corrupt("completed effect lacks receipt".into()))?;
            if bytes.len() > MAX_RECEIPT_BYTES {
                return Err(EffectError::Corrupt("stored receipt exceeds bound".into()));
            }
            let digest: [u8; 32] = receipt_sha256
                .ok_or_else(|| EffectError::Corrupt("completed effect lacks receipt hash".into()))?
                .try_into()
                .map_err(|_| EffectError::Corrupt("receipt hash has wrong length".into()))?;
            if sha256(&bytes) != digest {
                return Err(EffectError::Corrupt("stored receipt hash mismatch".into()));
            }
            (
                EffectStatus::Completed,
                Some(StoredReceipt {
                    bytes,
                    sha256: digest,
                }),
            )
        }
        _ => {
            return Err(EffectError::Corrupt(
                "invalid effect lifecycle fields".into(),
            ));
        }
    };
    Ok(StoredEffect {
        effect_id,
        identity,
        status,
        receipt,
    })
}

fn ensure_same_identity(
    stored: &StoredEffect,
    supplied: &EffectIdentity,
) -> Result<(), EffectError> {
    if &stored.identity != supplied || stored.effect_id != supplied.effect_id() {
        return Err(EffectError::Conflict);
    }
    Ok(())
}

fn validate_integrity(connection: &Connection, limits: EffectLimits) -> Result<(), EffectError> {
    let state_rows: i64 =
        connection.query_row("SELECT COUNT(*) FROM effects_state", [], |row| row.get(0))?;
    if state_rows != 1 {
        return Err(EffectError::Corrupt(
            "effects state cardinality is not one".into(),
        ));
    }
    let state = load_state_connection(connection)?;
    let sql = format!("SELECT {EFFECT_COLUMNS} FROM effects ORDER BY effect_id");
    let mut statement = connection.prepare(&sql)?;
    let raw_rows = statement.query_map([], decode_effect_row)?;
    let mut count = 0_u64;
    let mut total = 0_u64;
    for raw in raw_rows {
        let effect = decode_effect(raw?)?;
        count = count
            .checked_add(1)
            .ok_or_else(|| EffectError::Corrupt("effect count overflow".into()))?;
        total = total
            .checked_add(effect.identity.accounted_bytes()?)
            .ok_or_else(|| EffectError::Corrupt("byte count overflow".into()))?;
        if let Some(receipt) = effect.receipt {
            total = total
                .checked_add(receipt.bytes.len() as u64 + 32)
                .ok_or_else(|| EffectError::Corrupt("byte count overflow".into()))?;
        }
    }
    if count != state.effect_count || total != state.total_bytes {
        return Err(EffectError::Corrupt(
            "effects state counters do not match rows".into(),
        ));
    }
    if count > limits.max_effects || total > limits.max_bytes {
        return Err(EffectError::StorageLimit);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    fn path(temp: &TempDir) -> PathBuf {
        temp.path().join("private").join(EFFECTS_DATABASE_FILENAME)
    }
    fn identity(bytes: &[u8]) -> EffectIdentity {
        EffectIdentity::new("request-1", "context-1", 7, "run-1", 0, "mail.send", bytes).unwrap()
    }
    fn new_token(outcome: PrepareOutcome) -> ExecutionToken {
        match outcome {
            PrepareOutcome::New(token) => token,
            other => panic!("expected new token, got {other:?}"),
        }
    }

    fn duplicate_token(token: &ExecutionToken) -> ExecutionToken {
        ExecutionToken {
            effect_id: token.effect_id,
            request_sha256: token.request_sha256,
        }
    }

    #[test]
    fn exact_replay_executes_external_effect_once() {
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();
        let identity = identity(br#"{"to":"aster@example.com"}"#);
        let executions = AtomicUsize::new(0);

        let token = new_token(ledger.prepare(&identity).unwrap());
        executions.fetch_add(1, Ordering::SeqCst);
        let first = ledger.complete(token, br#"{"message_id":"m-1"}"#).unwrap();
        let replay = ledger.prepare(&identity).unwrap();

        assert_eq!(executions.load(Ordering::SeqCst), 1);
        assert_eq!(replay, PrepareOutcome::Completed(first));
        assert_eq!(ledger.state().unwrap().effect_count, 1);
    }

    #[test]
    fn completion_fallback_success_returns_exact_receipt() {
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();
        let identity = identity(b"helper success");
        let token = new_token(ledger.prepare(&identity).unwrap());

        let receipt = ledger
            .complete_or_mark_ambiguous(token, b"exact helper receipt")
            .unwrap();

        assert_eq!(receipt.bytes, b"exact helper receipt");
        assert_eq!(
            ledger.prepare(&identity).unwrap(),
            PrepareOutcome::Completed(receipt)
        );
    }

    #[test]
    fn validation_and_capacity_failures_durably_mark_ambiguity() {
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();
        let oversized_identity = identity(b"oversized receipt");
        let token = new_token(ledger.prepare(&oversized_identity).unwrap());
        let before = ledger.state().unwrap();
        let failure = ledger
            .complete_or_mark_ambiguous(token, vec![0; MAX_RECEIPT_BYTES + 1])
            .unwrap_err();
        assert!(matches!(
            failure.completion_error(),
            EffectError::FieldTooLarge("canonical_receipt_bytes")
        ));
        assert!(matches!(
            failure.ambiguity_fallback(),
            AmbiguityFallback::Marked
        ));
        assert_eq!(ledger.state().unwrap(), before);
        let stored = ledger
            .effect(oversized_identity.effect_id())
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, EffectStatus::Ambiguous);
        assert!(stored.receipt.is_none());

        let limited_temp = TempDir::new().unwrap();
        let limits = EffectLimits {
            max_effects: 1,
            max_bytes: 120,
        };
        let mut limited = EffectLedger::open(path(&limited_temp), limits).unwrap();
        let limited_identity = identity(b"x");
        let token = new_token(limited.prepare(&limited_identity).unwrap());
        let before = limited.state().unwrap();
        let failure = limited
            .complete_or_mark_ambiguous(token, b"receipt")
            .unwrap_err();
        assert!(matches!(
            failure.completion_error(),
            EffectError::StorageLimit
        ));
        assert!(matches!(
            failure.ambiguity_fallback(),
            AmbiguityFallback::Marked
        ));
        assert_eq!(limited.state().unwrap(), before);
        assert_eq!(
            limited
                .effect(limited_identity.effect_id())
                .unwrap()
                .unwrap()
                .status,
            EffectStatus::Ambiguous
        );
    }

    #[test]
    fn completion_storage_fault_marks_ambiguity_and_preserves_original_error() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let identity = identity(b"completion fault");
        let token = new_token(ledger.prepare(&identity).unwrap());
        let before = ledger.state().unwrap();
        let fault = Connection::open(&db).unwrap();
        fault
            .execute_batch(
                "CREATE TRIGGER injected_completion_fault
                 BEFORE UPDATE OF status ON effects WHEN NEW.status = 'completed'
                 BEGIN SELECT RAISE(ABORT, 'injected completion fault'); END;",
            )
            .unwrap();

        let failure = ledger
            .complete_or_mark_ambiguous(token, b"receipt")
            .unwrap_err();
        assert!(matches!(failure.completion_error(), EffectError::Sql(_)));
        assert!(matches!(
            failure.ambiguity_fallback(),
            AmbiguityFallback::Marked
        ));
        assert_eq!(ledger.state().unwrap(), before);
        let stored = ledger.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Ambiguous);
        assert!(stored.receipt.is_none());
    }

    #[test]
    fn failed_completion_and_fallback_leave_no_second_token_and_reopen_ambiguous() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let identity = identity(b"double persistence fault");
        let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let token = new_token(ledger.prepare(&identity).unwrap());
        let fault = Connection::open(&db).unwrap();
        fault
            .execute_batch(
                "CREATE TRIGGER injected_completion_fault
                 BEFORE UPDATE OF status ON effects WHEN NEW.status = 'completed'
                 BEGIN SELECT RAISE(ABORT, 'injected completion fault'); END;
                 CREATE TRIGGER injected_ambiguity_fault
                 BEFORE UPDATE OF status ON effects WHEN NEW.status = 'ambiguous'
                 BEGIN SELECT RAISE(ABORT, 'injected ambiguity fault'); END;",
            )
            .unwrap();

        let failure = ledger
            .complete_or_mark_ambiguous(token, b"receipt")
            .unwrap_err();
        let (completion_error, ambiguity_fallback) = failure.into_parts();
        assert!(
            completion_error
                .to_string()
                .contains("injected completion fault")
        );
        let AmbiguityFallback::Unconfirmed(ambiguity_error) = ambiguity_fallback else {
            panic!("expected unconfirmed ambiguity fallback");
        };
        assert!(
            ambiguity_error
                .to_string()
                .contains("injected ambiguity fault")
        );
        let stored = ledger.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Prepared);
        assert!(stored.receipt.is_none());
        assert_eq!(ledger.prepare(&identity).unwrap(), PrepareOutcome::Prepared);

        fault
            .execute_batch(
                "DROP TRIGGER injected_completion_fault;
                 DROP TRIGGER injected_ambiguity_fault;",
            )
            .unwrap();
        drop(fault);
        drop(ledger);
        let reopened = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        assert_eq!(
            reopened
                .effect(identity.effect_id())
                .unwrap()
                .unwrap()
                .status,
            EffectStatus::Ambiguous
        );
    }

    #[test]
    fn completion_fallback_reports_already_terminal_and_unknown_tokens() {
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();

        let ambiguous_identity = identity(b"already ambiguous");
        let token = new_token(ledger.prepare(&ambiguous_identity).unwrap());
        let stale = duplicate_token(&token);
        ledger.mark_ambiguous(token).unwrap();
        let failure = ledger
            .complete_or_mark_ambiguous(stale, b"receipt")
            .unwrap_err();
        assert!(matches!(
            failure.completion_error(),
            EffectError::Ambiguous(id) if *id == ambiguous_identity.effect_id()
        ));
        assert!(matches!(
            failure.ambiguity_fallback(),
            AmbiguityFallback::AlreadyAmbiguous
        ));

        let completed_identity = EffectIdentity::new(
            "request-2",
            "context-1",
            7,
            "run-1",
            1,
            "mail.send",
            b"already completed".to_vec(),
        )
        .unwrap();
        let token = new_token(ledger.prepare(&completed_identity).unwrap());
        let stale = duplicate_token(&token);
        let receipt = ledger.complete(token, b"stored receipt").unwrap();
        let failure = ledger
            .complete_or_mark_ambiguous(stale, b"replacement")
            .unwrap_err();
        assert!(matches!(
            failure.completion_error(),
            EffectError::AlreadyCompleted(id) if *id == completed_identity.effect_id()
        ));
        assert!(matches!(
            failure.ambiguity_fallback(),
            AmbiguityFallback::AlreadyCompleted
        ));
        assert_eq!(
            ledger
                .effect(completed_identity.effect_id())
                .unwrap()
                .unwrap()
                .receipt,
            Some(receipt)
        );

        let unknown = ExecutionToken {
            effect_id: EffectId::from_bytes([0x88; 32]),
            request_sha256: [0x99; 32],
        };
        let failure = ledger
            .complete_or_mark_ambiguous(unknown, b"receipt")
            .unwrap_err();
        assert!(matches!(
            failure.completion_error(),
            EffectError::UnknownToken
        ));
        assert!(matches!(
            failure.ambiguity_fallback(),
            AmbiguityFallback::Unconfirmed(error)
                if matches!(error.as_ref(), EffectError::UnknownToken)
        ));
    }

    #[test]
    fn crash_after_prepare_and_possible_effect_is_ambiguous_without_token() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let identity = identity(b"canonical request");
        {
            let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
            let _lost_token = new_token(ledger.prepare(&identity).unwrap());
            // Simulate performing the external side effect and crashing before complete.
        }
        let mut reopened = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        assert_eq!(
            reopened.prepare(&identity).unwrap(),
            PrepareOutcome::Ambiguous
        );
        assert_eq!(
            reopened
                .effect(identity.effect_id())
                .unwrap()
                .unwrap()
                .status,
            EffectStatus::Ambiguous
        );
    }

    #[test]
    fn token_marks_exact_prepared_effect_ambiguous_without_mutating_identity_or_receipt() {
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();
        let identity = identity(b"possibly sent");
        let token = new_token(ledger.prepare(&identity).unwrap());
        let before_state = ledger.state().unwrap();
        let before = ledger.effect(identity.effect_id()).unwrap().unwrap();

        ledger.mark_ambiguous(token).unwrap();

        let after = ledger.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(after.effect_id, before.effect_id);
        assert_eq!(after.identity, before.identity);
        assert_eq!(after.status, EffectStatus::Ambiguous);
        assert!(before.receipt.is_none());
        assert!(after.receipt.is_none());
        assert_eq!(ledger.state().unwrap(), before_state);
        assert_eq!(
            ledger.prepare(&identity).unwrap(),
            PrepareOutcome::Ambiguous
        );
    }

    #[test]
    fn explicit_ambiguity_persists_and_recovery_does_not_retransition_it() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let identity = identity(b"uncertain result");
        {
            let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
            let token = new_token(ledger.prepare(&identity).unwrap());
            ledger.mark_ambiguous(token).unwrap();
        }

        let mut reopened = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        assert_eq!(reopened.recover_prepared().unwrap(), 0);
        let stored = reopened.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Ambiguous);
        assert!(stored.receipt.is_none());
        assert_eq!(
            reopened.prepare(&identity).unwrap(),
            PrepareOutcome::Ambiguous
        );
    }

    #[test]
    fn ambiguity_rejects_wrong_unknown_completed_and_already_ambiguous_tokens() {
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();
        let prepared = identity(b"prepared");
        let token = new_token(ledger.prepare(&prepared).unwrap());

        let wrong_hash = ExecutionToken {
            effect_id: token.effect_id,
            request_sha256: [0x55; 32],
        };
        assert!(matches!(
            ledger.mark_ambiguous(wrong_hash),
            Err(EffectError::UnknownToken)
        ));
        assert_eq!(
            ledger.effect(prepared.effect_id()).unwrap().unwrap().status,
            EffectStatus::Prepared
        );

        let unknown = ExecutionToken {
            effect_id: EffectId::from_bytes([0x77; 32]),
            request_sha256: prepared.canonical_request_sha256(),
        };
        assert!(matches!(
            ledger.mark_ambiguous(unknown),
            Err(EffectError::UnknownToken)
        ));

        let ambiguous_id = token.effect_id;
        let ambiguous_hash = token.request_sha256;
        ledger.mark_ambiguous(token).unwrap();
        assert!(matches!(
            ledger.mark_ambiguous(ExecutionToken {
                effect_id: ambiguous_id,
                request_sha256: ambiguous_hash,
            }),
            Err(EffectError::Ambiguous(id)) if id == ambiguous_id
        ));

        let completed = EffectIdentity::new(
            "request-2",
            "context-1",
            7,
            "run-1",
            1,
            "mail.send",
            b"completed".to_vec(),
        )
        .unwrap();
        let completed_token = new_token(ledger.prepare(&completed).unwrap());
        let stale_token = ExecutionToken {
            effect_id: completed_token.effect_id,
            request_sha256: completed_token.request_sha256,
        };
        let receipt = ledger.complete(completed_token, b"exact receipt").unwrap();
        assert!(matches!(
            ledger.mark_ambiguous(stale_token),
            Err(EffectError::AlreadyCompleted(id)) if id == completed.effect_id()
        ));
        let stored = ledger.effect(completed.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Completed);
        assert_eq!(stored.receipt, Some(receipt));
    }

    #[test]
    fn ambiguity_storage_fault_rolls_back_the_transition() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let identity = identity(b"storage fault");
        let token = new_token(ledger.prepare(&identity).unwrap());
        let before = ledger.state().unwrap();
        let fault = Connection::open(&db).unwrap();
        fault
            .execute_batch(
                "CREATE TRIGGER injected_ambiguity_fault
                 BEFORE UPDATE OF status ON effects WHEN NEW.status = 'ambiguous'
                 BEGIN SELECT RAISE(ABORT, 'injected ambiguity fault'); END;",
            )
            .unwrap();

        assert!(matches!(
            ledger.mark_ambiguous(token),
            Err(EffectError::Sql(_))
        ));
        assert_eq!(ledger.state().unwrap(), before);
        let stored = ledger.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Prepared);
        assert!(stored.receipt.is_none());
        assert_eq!(ledger.prepare(&identity).unwrap(), PrepareOutcome::Prepared);

        fault
            .execute_batch("DROP TRIGGER injected_ambiguity_fault")
            .unwrap();
        drop(fault);
        drop(ledger);
        let reopened = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        assert_eq!(
            reopened
                .effect(identity.effect_id())
                .unwrap()
                .unwrap()
                .status,
            EffectStatus::Ambiguous
        );
    }

    #[test]
    fn ambiguity_transaction_acquisition_failure_leaves_row_prepared() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let identity = identity(b"transaction fault");
        let token = new_token(ledger.prepare(&identity).unwrap());
        ledger.connection.busy_timeout(Duration::ZERO).unwrap();
        let blocker = Connection::open(&db).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();

        assert!(matches!(
            ledger.mark_ambiguous(token),
            Err(EffectError::Sql(_))
        ));
        let stored = ledger.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Prepared);
        assert!(stored.receipt.is_none());
        blocker.execute_batch("ROLLBACK").unwrap();
        assert_eq!(ledger.prepare(&identity).unwrap(), PrepareOutcome::Prepared);

        drop(blocker);
        drop(ledger);
        let reopened = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        assert_eq!(
            reopened
                .effect(identity.effect_id())
                .unwrap()
                .unwrap()
                .status,
            EffectStatus::Ambiguous
        );
    }

    #[test]
    fn ambiguity_detects_a_concurrent_state_change_and_rolls_it_back() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let identity = identity(b"concurrent transition");
        let token = new_token(ledger.prepare(&identity).unwrap());
        ledger
            .connection
            .pragma_update(None, "recursive_triggers", "OFF")
            .unwrap();
        let fault = Connection::open(&db).unwrap();
        fault
            .execute_batch(
                "CREATE TRIGGER injected_concurrent_ambiguity
                 BEFORE UPDATE OF status ON effects WHEN NEW.status = 'ambiguous'
                 BEGIN
                   UPDATE effects SET status = 'ambiguous' WHERE effect_id = OLD.effect_id;
                   SELECT RAISE(IGNORE);
                 END;",
            )
            .unwrap();

        assert!(matches!(
            ledger.mark_ambiguous(token),
            Err(EffectError::ConcurrentChange)
        ));
        let stored = ledger.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Prepared);
        assert!(stored.receipt.is_none());
    }

    #[test]
    fn completion_before_delivery_replays_exact_stored_bytes() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let identity = identity(b"request bytes");
        let exact = b"\x00canonical\xffreceipt";
        {
            let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
            let token = new_token(ledger.prepare(&identity).unwrap());
            let committed = ledger.complete(token, exact).unwrap();
            assert_eq!(committed.bytes, exact);
            // Crash before delivering committed to the caller.
        }
        let mut reopened = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        match reopened.prepare(&identity).unwrap() {
            PrepareOutcome::Completed(receipt) => {
                assert_eq!(receipt.bytes, exact);
                assert_eq!(receipt.sha256, sha256(exact));
            }
            other => panic!("expected completed replay, got {other:?}"),
        }
    }

    #[test]
    fn changed_request_bytes_under_logical_key_conflict() {
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();
        let first = identity(b"one");
        let changed = identity(b"two");
        let _token = new_token(ledger.prepare(&first).unwrap());
        assert_eq!(ledger.prepare(&first).unwrap(), PrepareOutcome::Prepared);
        assert!(matches!(
            ledger.prepare(&changed),
            Err(EffectError::Conflict)
        ));
        let changed_capability = EffectIdentity::new(
            "request-1",
            "context-1",
            7,
            "run-1",
            0,
            "mail.delete",
            b"one".to_vec(),
        )
        .unwrap();
        assert!(matches!(
            ledger.prepare(&changed_capability),
            Err(EffectError::Conflict)
        ));
        assert_eq!(ledger.state().unwrap().effect_count, 1);
    }

    #[test]
    fn duplicate_open_turns_inflight_prepare_ambiguous_without_second_token() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let identity = identity(b"one owner only");
        let mut first = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let token = new_token(first.prepare(&identity).unwrap());

        let mut second = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        assert_eq!(
            second.prepare(&identity).unwrap(),
            PrepareOutcome::Ambiguous
        );
        assert!(matches!(
            first.complete(token, b"too late"),
            Err(EffectError::Ambiguous(_))
        ));
    }

    #[test]
    fn sql_fault_rolls_back_prepare_and_completion_counters() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let identity = identity(b"fault test");
        let token = new_token(ledger.prepare(&identity).unwrap());
        let before = ledger.state().unwrap();
        let fault = Connection::open(&db).unwrap();
        fault
            .execute_batch(
                "CREATE TRIGGER injected_completion_fault
             BEFORE UPDATE OF status ON effects WHEN NEW.status = 'completed'
             BEGIN SELECT RAISE(ABORT, 'injected fault'); END;",
            )
            .unwrap();
        assert!(matches!(
            ledger.complete(token, b"receipt"),
            Err(EffectError::Sql(_))
        ));
        assert_eq!(ledger.state().unwrap(), before);
        let stored = ledger.effect(identity.effect_id()).unwrap().unwrap();
        assert_eq!(stored.status, EffectStatus::Prepared);
        assert!(stored.receipt.is_none());
    }

    #[test]
    fn bounded_capacity_is_transactional() {
        let temp = TempDir::new().unwrap();
        let limits = EffectLimits {
            max_effects: 1,
            max_bytes: 1024,
        };
        let mut ledger = EffectLedger::open(path(&temp), limits).unwrap();
        let first = identity(b"one");
        let _token = new_token(ledger.prepare(&first).unwrap());
        let second = EffectIdentity::new(
            "request-2",
            "context-1",
            7,
            "run-1",
            1,
            "mail.send",
            b"two".to_vec(),
        )
        .unwrap();
        let before = ledger.state().unwrap();
        assert!(matches!(
            ledger.prepare(&second),
            Err(EffectError::StorageLimit)
        ));
        assert_eq!(ledger.state().unwrap(), before);
    }

    #[test]
    fn receipt_byte_capacity_failure_leaves_prepared_row_unchanged() {
        let temp = TempDir::new().unwrap();
        let limits = EffectLimits {
            max_effects: 1,
            max_bytes: 120,
        };
        let mut ledger = EffectLedger::open(path(&temp), limits).unwrap();
        let identity = identity(b"x");
        let token = new_token(ledger.prepare(&identity).unwrap());
        let before = ledger.state().unwrap();
        assert!(matches!(
            ledger.complete(token, b"receipt"),
            Err(EffectError::StorageLimit)
        ));
        assert_eq!(ledger.state().unwrap(), before);
        assert_eq!(
            ledger.effect(identity.effect_id()).unwrap().unwrap().status,
            EffectStatus::Prepared
        );
    }

    #[cfg(unix)]
    #[test]
    fn parent_and_database_have_private_owned_modes_and_symlinks_are_rejected() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        let parent = fs::metadata(db.parent().unwrap()).unwrap();
        let file = fs::metadata(&db).unwrap();
        assert_eq!(parent.permissions().mode() & 0o777, 0o700);
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
        assert_eq!(parent.uid(), rustix::process::geteuid().as_raw());
        assert_eq!(file.uid(), rustix::process::geteuid().as_raw());
        drop(ledger);

        let link_parent = temp.path().join("link-private");
        fs::create_dir(&link_parent).unwrap();
        fs::set_permissions(&link_parent, fs::Permissions::from_mode(0o700)).unwrap();
        let target = link_parent.join("target");
        fs::write(&target, b"not sqlite").unwrap();
        let link = link_parent.join("effects.sqlite");
        symlink(&target, &link).unwrap();
        assert!(matches!(
            EffectLedger::open(&link, EffectLimits::default()),
            Err(EffectError::UnsafePath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn permissive_existing_parent_is_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let temp = TempDir::new().unwrap();
        let parent = temp.path().join("unsafe");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            EffectLedger::open(parent.join("effects.sqlite"), EffectLimits::default()),
            Err(EffectError::UnsafePath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn relative_symlinked_insecure_and_hard_linked_paths_are_rejected_without_repair() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

        assert!(matches!(
            EffectLedger::open("relative/effects.sqlite", EffectLimits::default()),
            Err(EffectError::UnsafePath(_))
        ));

        let temp = TempDir::new().unwrap();
        let real = temp.path().join("real");
        let nested = real.join("nested");
        fs::create_dir(&real).unwrap();
        fs::create_dir(&nested).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = temp.path().join("alias");
        symlink(&real, &alias).unwrap();
        assert!(matches!(
            EffectLedger::open(alias.join("nested/effects.sqlite"), EffectLimits::default()),
            Err(EffectError::UnsafePath(_))
        ));

        let db = path(&temp);
        let ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
        drop(ledger);
        fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            EffectLedger::open(&db, EffectLimits::default()),
            Err(EffectError::UnsafePath(_))
        ));
        assert_eq!(
            fs::metadata(&db).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
        let hard_link = db.with_file_name("effects-hard-link.sqlite");
        fs::hard_link(&db, &hard_link).unwrap();
        assert_eq!(fs::metadata(&db).unwrap().nlink(), 2);
        assert!(matches!(
            EffectLedger::open(&db, EffectLimits::default()),
            Err(EffectError::UnsafePath(_))
        ));
    }

    #[test]
    fn corruption_and_other_application_databases_are_rejected() {
        let temp = TempDir::new().unwrap();
        let corrupt_parent = temp.path().join("corrupt");
        fs::create_dir(&corrupt_parent).unwrap();
        set_private_dir_mode(&corrupt_parent).unwrap();
        let corrupt = corrupt_parent.join("effects.sqlite");
        fs::write(&corrupt, b"not a sqlite database").unwrap();
        assert!(EffectLedger::open(&corrupt, EffectLimits::default()).is_err());

        let other_parent = temp.path().join("other");
        fs::create_dir(&other_parent).unwrap();
        set_private_dir_mode(&other_parent).unwrap();
        let other = other_parent.join("effects.sqlite");
        let connection = Connection::open(&other).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE journal_state (value INTEGER); PRAGMA user_version = 1;
             PRAGMA application_id = 1162629194;",
            )
            .unwrap();
        drop(connection);
        set_private_file_mode(&other).unwrap();
        assert!(matches!(
            EffectLedger::open(&other, EffectLimits::default()),
            Err(EffectError::Corrupt(_))
        ));
    }

    #[test]
    fn schema_enforces_immutable_identity_completion_and_no_delete() {
        let temp = TempDir::new().unwrap();
        let db = path(&temp);
        let identity = identity(b"immutability");
        {
            let mut ledger = EffectLedger::open(&db, EffectLimits::default()).unwrap();
            let token = new_token(ledger.prepare(&identity).unwrap());
            ledger.complete(token, b"receipt").unwrap();
        }
        let connection = Connection::open(&db).unwrap();
        assert!(
            connection
                .execute("UPDATE effects SET request_bytes = X'00'", [])
                .is_err()
        );
        assert!(
            connection
                .execute("UPDATE effects SET receipt_bytes = X'00'", [])
                .is_err()
        );
        assert!(connection.execute("DELETE FROM effects", []).is_err());
        let app: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(app, APPLICATION_ID);
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn identities_and_receipts_are_bounded_and_hash_checked() {
        assert!(matches!(
            EffectIdentity::new("", "context", 1, "run", 0, "cap", b"x".to_vec()),
            Err(EffectError::EmptyField("request_id"))
        ));
        assert!(matches!(
            EffectIdentity::new("request", "context", 0, "run", 0, "cap", b"x".to_vec()),
            Err(EffectError::InvalidGeneration)
        ));
        assert!(matches!(
            EffectIdentity::new(
                "request/invalid",
                "context",
                1,
                "run",
                0,
                "cap",
                b"x".to_vec()
            ),
            Err(EffectError::InvalidName("request_id"))
        ));
        assert!(matches!(
            EffectIdentity::new(
                "request",
                "context",
                1,
                "run",
                0,
                "cap",
                vec![0; MAX_REQUEST_BYTES + 1]
            ),
            Err(EffectError::FieldTooLarge("canonical_request_bytes"))
        ));
        let mut mismatched =
            EffectIdentity::new("request", "context", 1, "run", 0, "cap", b"x".to_vec()).unwrap();
        mismatched.canonical_request_sha256 = [0; 32];
        assert!(matches!(
            mismatched.validate(),
            Err(EffectError::RequestHashMismatch)
        ));
        let temp = TempDir::new().unwrap();
        let mut ledger = EffectLedger::open(path(&temp), EffectLimits::default()).unwrap();
        let token = new_token(ledger.prepare(&identity(b"x")).unwrap());
        let oversized = vec![0_u8; MAX_RECEIPT_BYTES + 1];
        assert!(matches!(
            ledger.complete(token, oversized),
            Err(EffectError::FieldTooLarge(_))
        ));
    }
}
