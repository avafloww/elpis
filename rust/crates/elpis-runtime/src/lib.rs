use flate2::read::GzDecoder;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Component, Path, PathBuf};
use tar::EntryType;
use thiserror::Error;

const MARKER_FILE: &str = ".elpis-runtime.json";
const LOCK_FILE: &str = ".elpis-runtime.lock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeManifest {
    pub format: u32,
    pub archive_sha256: String,
    pub executable: String,
    pub entries: Vec<ManifestEntry>,
    pub max_entries: u64,
    pub max_unpacked_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManifestEntry {
    File {
        path: String,
        sha256: String,
        mode: u32,
        size: u64,
    },
    Symlink {
        path: String,
        target: String,
    },
}

impl ManifestEntry {
    fn path(&self) -> &str {
        match self {
            Self::File { path, .. } | Self::Symlink { path, .. } => path,
        }
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("runtime manifest is invalid: {0}")]
    Manifest(String),
    #[error("runtime archive hash mismatch")]
    ArchiveHash,
    #[error("runtime entry path is unsafe: {0}")]
    UnsafePath(String),
    #[error("runtime symlink escapes root: {path} -> {target}")]
    UnsafeSymlink { path: String, target: String },
    #[error("runtime archive contains unsupported entry: {0}")]
    UnsupportedEntry(String),
    #[error("runtime archive contains duplicate or unexpected entry: {0}")]
    UnexpectedEntry(String),
    #[error("runtime archive is missing manifest entry: {0}")]
    MissingEntry(String),
    #[error("runtime archive exceeds declared limits")]
    Limits,
    #[error("runtime file does not match manifest: {0}")]
    FileMismatch(String),
    #[error("runtime IO failed: {0}")]
    Io(#[from] io::Error),
    #[error("runtime JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub struct RuntimePayload<'a> {
    archive: &'a [u8],
    manifest: RuntimeManifest,
    manifest_bytes: &'a [u8],
}

pub struct RuntimeHandle {
    pub root: PathBuf,
    pub executable: PathBuf,
    pub payload_sha256: String,
    executable_sha256: String,
    _generation_lock: File,
}

impl RuntimeHandle {
    pub fn open_verified_executable(&self) -> Result<File, RuntimeError> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&self.executable)?;
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file() || sha256_reader(&mut file)? != self.executable_sha256 {
            return Err(RuntimeError::FileMismatch(
                self.executable.display().to_string(),
            ));
        }
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
}

impl<'a> RuntimePayload<'a> {
    pub fn new(archive: &'a [u8], manifest_bytes: &'a [u8]) -> Result<Self, RuntimeError> {
        let manifest: RuntimeManifest = serde_json::from_slice(manifest_bytes)?;
        validate_manifest(&manifest)?;
        if sha256_hex(archive) != manifest.archive_sha256 {
            return Err(RuntimeError::ArchiveHash);
        }
        Ok(Self {
            archive,
            manifest,
            manifest_bytes,
        })
    }

    pub fn ensure(&self, cache_root: &Path) -> Result<RuntimeHandle, RuntimeError> {
        fs::create_dir_all(cache_root)?;
        fs::set_permissions(cache_root, fs::Permissions::from_mode(0o700))?;
        let lock_path = cache_root.join(LOCK_FILE);
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)?;
        FileExt::lock_shared(&lock)?;
        let payload_sha256 = self.manifest.archive_sha256.clone();
        let root = cache_root.join(&payload_sha256);
        if self.verify_tree(&root).is_err() {
            FileExt::unlock(&lock)?;
            FileExt::lock_exclusive(&lock)?;
            if self.verify_tree(&root).is_err() {
                self.rebuild(cache_root, &root)?;
                self.verify_tree(&root)?;
            }
            FileExt::lock_shared(&lock)?;
        }
        let executable = safe_join(&root, &self.manifest.executable)?;
        let executable_sha256 = self
            .manifest
            .entries
            .iter()
            .find_map(|entry| match entry {
                ManifestEntry::File { path, sha256, .. } if path == &self.manifest.executable => {
                    Some(sha256.clone())
                }
                _ => None,
            })
            .ok_or_else(|| RuntimeError::Manifest("executable is not a file".into()))?;
        Ok(RuntimeHandle {
            root,
            executable,
            payload_sha256,
            executable_sha256,
            _generation_lock: lock,
        })
    }

    fn rebuild(&self, cache_root: &Path, final_root: &Path) -> Result<(), RuntimeError> {
        let temp = cache_root.join(format!(
            ".{}.tmp-{}",
            self.manifest.archive_sha256,
            std::process::id()
        ));
        if temp.exists() {
            make_tree_writable(&temp)?;
            fs::remove_dir_all(&temp)?;
        }
        fs::create_dir(&temp)?;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o700))?;
        let result = self.extract_into(&temp).and_then(|()| {
            let marker = temp.join(MARKER_FILE);
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&marker)?;
            file.write_all(self.manifest_bytes)?;
            file.sync_all()?;
            file.set_permissions(fs::Permissions::from_mode(0o444))?;
            seal_tree(&temp)
        });
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&temp);
            return Err(error);
        }
        if final_root.exists() {
            let corrupt = cache_root.join(format!(
                ".{}.replaced-{}",
                self.manifest.archive_sha256,
                std::process::id()
            ));
            if corrupt.exists() {
                make_tree_writable(&corrupt)?;
                fs::remove_dir_all(&corrupt)?;
            }
            fs::rename(final_root, &corrupt)?;
            fs::rename(&temp, final_root)?;
            sync_dir(cache_root)?;
            make_tree_writable(&corrupt)?;
            fs::remove_dir_all(corrupt)?;
        } else {
            fs::rename(&temp, final_root)?;
            sync_dir(cache_root)?;
        }
        Ok(())
    }

    fn extract_into(&self, root: &Path) -> Result<(), RuntimeError> {
        let expected = manifest_map(&self.manifest)?;
        let mut seen = BTreeSet::new();
        let mut entries = 0_u64;
        let mut unpacked = 0_u64;
        let decoder = GzDecoder::new(Cursor::new(self.archive));
        let mut archive = tar::Archive::new(decoder);
        for item in archive.entries()? {
            let mut item = item?;
            let raw_path = item.path()?.into_owned();
            let relative = validate_relative_path(&raw_path)?;
            let path_text = path_text(&relative)?;
            let entry_type = item.header().entry_type();
            if entry_type == EntryType::Directory {
                fs::create_dir_all(safe_join(root, &relative)?)?;
                continue;
            }
            entries = entries.checked_add(1).ok_or(RuntimeError::Limits)?;
            if entries > self.manifest.max_entries {
                return Err(RuntimeError::Limits);
            }
            if !seen.insert(path_text.clone()) {
                return Err(RuntimeError::UnexpectedEntry(path_text));
            }
            let expected_entry = expected
                .get(&path_text)
                .ok_or_else(|| RuntimeError::UnexpectedEntry(path_text.clone()))?;
            let destination = safe_join(root, &relative)?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            match (entry_type, expected_entry) {
                (
                    kind,
                    ManifestEntry::File {
                        sha256, mode, size, ..
                    },
                ) if kind.is_file() => {
                    let declared = item.header().size()?;
                    if declared != *size {
                        return Err(RuntimeError::FileMismatch(path_text));
                    }
                    unpacked = unpacked.checked_add(declared).ok_or(RuntimeError::Limits)?;
                    if unpacked > self.manifest.max_unpacked_bytes {
                        return Err(RuntimeError::Limits);
                    }
                    let mut file = OpenOptions::new()
                        .create_new(true)
                        .write(true)
                        .open(&destination)?;
                    let mut hasher = Sha256::new();
                    let copied = io::copy(
                        &mut item.by_ref().take(declared),
                        &mut HashWriter::new(&mut file, &mut hasher),
                    )?;
                    if copied != declared || hex::encode(hasher.finalize()) != *sha256 {
                        return Err(RuntimeError::FileMismatch(path_text));
                    }
                    file.set_permissions(fs::Permissions::from_mode(mode & 0o777))?;
                    file.sync_all()?;
                }
                (kind, ManifestEntry::Symlink { target, .. }) if kind.is_symlink() => {
                    let actual = item
                        .link_name()?
                        .ok_or_else(|| RuntimeError::FileMismatch(path_text.clone()))?;
                    let actual_text = actual
                        .to_str()
                        .ok_or_else(|| RuntimeError::UnsafePath(path_text.clone()))?;
                    if actual_text != target || resolve_symlink(&relative, &actual).is_none() {
                        return Err(RuntimeError::UnsafeSymlink {
                            path: path_text,
                            target: actual_text.to_string(),
                        });
                    }
                    symlink(actual, destination)?;
                }
                _ => return Err(RuntimeError::UnsupportedEntry(path_text)),
            }
        }
        for path in expected.keys() {
            if !seen.contains(path) {
                return Err(RuntimeError::MissingEntry(path.clone()));
            }
        }
        Ok(())
    }

    fn verify_tree(&self, root: &Path) -> Result<(), RuntimeError> {
        let marker_path = root.join(MARKER_FILE);
        let marker = fs::read(&marker_path)?;
        let marker_mode = fs::metadata(&marker_path)?.permissions().mode() & 0o777;
        if marker != self.manifest_bytes || marker_mode != 0o444 {
            return Err(RuntimeError::FileMismatch(MARKER_FILE.into()));
        }
        if fs::metadata(root)?.permissions().mode() & 0o777 != 0o555 {
            return Err(RuntimeError::FileMismatch("runtime root mode".into()));
        }
        for entry in &self.manifest.entries {
            let path = safe_join(root, entry.path())?;
            match entry {
                ManifestEntry::File {
                    sha256, mode, size, ..
                } => {
                    let metadata = fs::symlink_metadata(&path)?;
                    if !metadata.file_type().is_file()
                        || metadata.len() != *size
                        || metadata.permissions().mode() & 0o777 != mode & 0o777
                        || sha256_file(&path)? != *sha256
                    {
                        return Err(RuntimeError::FileMismatch(entry.path().into()));
                    }
                }
                ManifestEntry::Symlink { target, .. } => {
                    let metadata = fs::symlink_metadata(&path)?;
                    if !metadata.file_type().is_symlink()
                        || fs::read_link(&path)? != Path::new(target)
                    {
                        return Err(RuntimeError::FileMismatch(entry.path().into()));
                    }
                }
            }
        }
        verify_tree_shape(root, &self.manifest)
    }
}

fn verify_tree_shape(root: &Path, manifest: &RuntimeManifest) -> Result<(), RuntimeError> {
    let mut leaves = BTreeSet::from([MARKER_FILE.to_string()]);
    let mut directories = BTreeSet::new();
    for entry in &manifest.entries {
        let path = validate_relative_path(Path::new(entry.path()))?;
        leaves.insert(path_text(&path)?);
        let mut parent = path.parent();
        while let Some(value) = parent {
            if value.as_os_str().is_empty() {
                break;
            }
            directories.insert(path_text(value)?);
            parent = value.parent();
        }
    }
    verify_tree_directory(root, root, &leaves, &directories)
}

fn verify_tree_directory(
    root: &Path,
    directory: &Path,
    leaves: &BTreeSet<String>,
    directories: &BTreeSet<String>,
) -> Result<(), RuntimeError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| RuntimeError::UnsafePath(path.display().to_string()))?;
        let text = path_text(relative)?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if !directories.contains(&text)
                || fs::metadata(&path)?.permissions().mode() & 0o777 != 0o555
            {
                return Err(RuntimeError::FileMismatch(text));
            }
            verify_tree_directory(root, &path, leaves, directories)?;
        } else if !leaves.contains(&text) {
            return Err(RuntimeError::FileMismatch(text));
        }
    }
    Ok(())
}

struct HashWriter<'a, W> {
    inner: &'a mut W,
    hasher: &'a mut Sha256,
}

impl<'a, W> HashWriter<'a, W> {
    fn new(inner: &'a mut W, hasher: &'a mut Sha256) -> Self {
        Self { inner, hasher }
    }
}

impl<W: Write> Write for HashWriter<'_, W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.hasher.update(&buffer[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn validate_manifest(manifest: &RuntimeManifest) -> Result<(), RuntimeError> {
    if manifest.format != 1
        || manifest.entries.is_empty()
        || manifest.max_entries == 0
        || manifest.max_unpacked_bytes == 0
        || !is_sha256(&manifest.archive_sha256)
    {
        return Err(RuntimeError::Manifest("invalid header".into()));
    }
    validate_relative_path(Path::new(&manifest.executable))?;
    let mut paths = BTreeSet::new();
    for entry in &manifest.entries {
        let relative = validate_relative_path(Path::new(entry.path()))?;
        let text = path_text(&relative)?;
        if !paths.insert(text.clone()) {
            return Err(RuntimeError::Manifest(format!("duplicate path {text}")));
        }
        match entry {
            ManifestEntry::File { sha256, mode, .. } => {
                if !is_sha256(sha256)
                    || mode & !0o777 != 0
                    || mode & 0o222 != 0
                    || mode & 0o400 == 0
                {
                    return Err(RuntimeError::Manifest(format!("invalid file {text}")));
                }
            }
            ManifestEntry::Symlink { target, .. } => {
                if resolve_symlink(&relative, Path::new(target)).is_none() {
                    return Err(RuntimeError::UnsafeSymlink {
                        path: text,
                        target: target.clone(),
                    });
                }
            }
        }
    }
    let executable_valid = manifest.entries.iter().any(|entry| {
        matches!(
            entry,
            ManifestEntry::File { path, mode, .. }
                if path == &manifest.executable && mode & 0o111 != 0
        )
    });
    if !executable_valid {
        return Err(RuntimeError::Manifest(
            "executable must be an executable regular file".into(),
        ));
    }
    Ok(())
}

fn manifest_map(
    manifest: &RuntimeManifest,
) -> Result<BTreeMap<String, &ManifestEntry>, RuntimeError> {
    manifest
        .entries
        .iter()
        .map(|entry| {
            Ok((
                path_text(&validate_relative_path(Path::new(entry.path()))?)?,
                entry,
            ))
        })
        .collect()
}

fn validate_relative_path(path: &Path) -> Result<PathBuf, RuntimeError> {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => output.push(value),
            Component::CurDir => {}
            _ => return Err(RuntimeError::UnsafePath(path.display().to_string())),
        }
    }
    if output.as_os_str().is_empty() {
        return Err(RuntimeError::UnsafePath(path.display().to_string()));
    }
    Ok(output)
}

fn resolve_symlink(path: &Path, target: &Path) -> Option<PathBuf> {
    if target.is_absolute() {
        return None;
    }
    let mut parts: Vec<_> = path
        .parent()?
        .components()
        .filter_map(|part| match part {
            Component::Normal(value) => Some(value.to_os_string()),
            _ => None,
        })
        .collect();
    for component in target.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    let mut output = PathBuf::new();
    for part in parts {
        output.push(part);
    }
    Some(output)
}

fn safe_join(root: &Path, relative: impl AsRef<Path>) -> Result<PathBuf, RuntimeError> {
    Ok(root.join(validate_relative_path(relative.as_ref())?))
}

fn path_text(path: &Path) -> Result<String, RuntimeError> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| RuntimeError::UnsafePath(path.display().to_string()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<String, RuntimeError> {
    let mut file = File::open(path)?;
    sha256_reader(&mut file)
}

fn sha256_reader(reader: &mut impl Read) -> Result<String, RuntimeError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn seal_tree(root: &Path) -> Result<(), RuntimeError> {
    let mut directories = Vec::new();
    collect_directories(root, &mut directories)?;
    for directory in directories.into_iter().rev() {
        sync_dir(&directory)?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o555))?;
    }
    Ok(())
}

fn collect_directories(path: &Path, output: &mut Vec<PathBuf>) -> Result<(), RuntimeError> {
    output.push(path.to_path_buf());
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            collect_directories(&entry.path(), output)?;
        }
    }
    Ok(())
}

fn make_tree_writable(root: &Path) -> Result<(), RuntimeError> {
    if !root.exists() {
        return Ok(());
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            make_tree_writable(&entry.path())?;
        }
    }
    Ok(())
}

fn sync_dir(path: &Path) -> Result<(), RuntimeError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use tar::{Builder, Header};
    use tempfile::tempdir;

    const PYTHON: &[u8] = b"#!/bin/sh\nexit 0\n";
    const DATA: &[u8] = b"runtime-data";

    fn append_file(builder: &mut Builder<GzEncoder<Vec<u8>>>, path: &str, data: &[u8], mode: u32) {
        let mut header = Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_cksum();
        builder.append_data(&mut header, path, data).unwrap();
    }

    fn fixture(extra: bool, symlink_target: &str) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = Builder::new(encoder);
        append_file(&mut builder, "python/bin/python3.13", PYTHON, 0o555);
        append_file(&mut builder, "python/lib/data.txt", DATA, 0o444);
        let mut link = Header::new_gnu();
        link.set_entry_type(EntryType::Symlink);
        link.set_size(0);
        link.set_mode(0o777);
        link.set_cksum();
        builder
            .append_link(&mut link, "python/bin/python3", Path::new(symlink_target))
            .unwrap();
        if extra {
            append_file(&mut builder, "python/extra.py", b"bad", 0o444);
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn manifest(archive: &[u8], symlink_target: &str) -> RuntimeManifest {
        RuntimeManifest {
            format: 1,
            archive_sha256: sha256_hex(archive),
            executable: "python/bin/python3.13".into(),
            entries: vec![
                ManifestEntry::File {
                    path: "python/bin/python3.13".into(),
                    sha256: sha256_hex(PYTHON),
                    mode: 0o555,
                    size: PYTHON.len() as u64,
                },
                ManifestEntry::File {
                    path: "python/lib/data.txt".into(),
                    sha256: sha256_hex(DATA),
                    mode: 0o444,
                    size: DATA.len() as u64,
                },
                ManifestEntry::Symlink {
                    path: "python/bin/python3".into(),
                    target: symlink_target.into(),
                },
            ],
            max_entries: 3,
            max_unpacked_bytes: 1024,
        }
    }

    #[test]
    fn extracts_reuses_and_repairs_corrupt_runtime() {
        let archive = fixture(false, "python3.13");
        let manifest = serde_json::to_vec(&manifest(&archive, "python3.13")).unwrap();
        let payload = RuntimePayload::new(&archive, &manifest).unwrap();
        let cache = tempdir().unwrap();
        let first = payload.ensure(cache.path()).unwrap();
        assert_eq!(fs::read(&first.executable).unwrap(), PYTHON);
        assert_eq!(
            fs::read_link(first.root.join("python/bin/python3")).unwrap(),
            Path::new("python3.13")
        );
        let executable = first.executable.clone();
        let root = first.root.clone();
        drop(first);
        make_tree_writable(&root).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&executable, b"corrupt").unwrap();
        fs::write(root.join("python/lib/sitecustomize.py"), b"malicious").unwrap();
        let repaired = payload.ensure(cache.path()).unwrap();
        assert_eq!(fs::read(&repaired.executable).unwrap(), PYTHON);
        assert_eq!(
            fs::metadata(&repaired.executable)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o555
        );
        assert!(!repaired.root.join("python/lib/sitecustomize.py").exists());
        let concurrent = payload.ensure(cache.path()).unwrap();
        assert_eq!(concurrent.root, repaired.root);
        let marker_root = repaired.root.clone();
        let marker = marker_root.join(MARKER_FILE);
        drop(concurrent);
        drop(repaired);
        make_tree_writable(&marker_root).unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(marker, b"corrupt marker").unwrap();
        let marker_repaired = payload.ensure(cache.path()).unwrap();
        assert_eq!(
            fs::read(marker_repaired.root.join(MARKER_FILE)).unwrap(),
            manifest
        );
    }

    #[test]
    fn verified_executable_descriptor_survives_path_replacement() {
        let archive = fixture(false, "python3.13");
        let manifest = serde_json::to_vec(&manifest(&archive, "python3.13")).unwrap();
        let payload = RuntimePayload::new(&archive, &manifest).unwrap();
        let cache = tempdir().unwrap();
        let handle = payload.ensure(cache.path()).unwrap();
        let mut executable = handle.open_verified_executable().unwrap();
        let root = handle.root.clone();
        let path = handle.executable.clone();
        drop(handle);
        make_tree_writable(&root).unwrap();
        let replaced = path.with_extension("verified-inode");
        fs::rename(&path, &replaced).unwrap();
        fs::write(&path, b"#!/bin/sh\nexit 91\n").unwrap();
        let mut original = Vec::new();
        executable.read_to_end(&mut original).unwrap();
        assert_eq!(original, PYTHON);
        drop(executable);
        let repaired = payload.ensure(cache.path()).unwrap();
        assert_eq!(fs::read(repaired.executable).unwrap(), PYTHON);
    }

    #[test]
    fn rejects_writable_base_file_mode() {
        let archive = fixture(false, "python3.13");
        let mut value = manifest(&archive, "python3.13");
        let ManifestEntry::File { mode, .. } = &mut value.entries[0] else {
            unreachable!();
        };
        *mode = 0o755;
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            RuntimePayload::new(&archive, &bytes),
            Err(RuntimeError::Manifest(_))
        ));
    }

    #[test]
    fn rejects_archive_hash_mismatch() {
        let archive = fixture(false, "python3.13");
        let mut value = manifest(&archive, "python3.13");
        value.archive_sha256 = "00".repeat(32);
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(matches!(
            RuntimePayload::new(&archive, &bytes),
            Err(RuntimeError::ArchiveHash)
        ));
    }

    #[test]
    fn rejects_symlink_that_escapes_runtime_root() {
        let archive = fixture(false, "../../../etc/passwd");
        let bytes = serde_json::to_vec(&manifest(&archive, "../../../etc/passwd")).unwrap();
        assert!(matches!(
            RuntimePayload::new(&archive, &bytes),
            Err(RuntimeError::UnsafeSymlink { .. })
        ));
    }

    #[test]
    fn rejects_unexpected_archive_file() {
        let archive = fixture(true, "python3.13");
        let mut value = manifest(&archive, "python3.13");
        value.max_entries = 4;
        let bytes = serde_json::to_vec(&value).unwrap();
        let payload = RuntimePayload::new(&archive, &bytes).unwrap();
        let cache = tempdir().unwrap();
        assert!(matches!(
            payload.ensure(cache.path()),
            Err(RuntimeError::UnexpectedEntry(path)) if path == "python/extra.py"
        ));
    }

    #[test]
    fn enforces_unpacked_byte_limit() {
        let archive = fixture(false, "python3.13");
        let mut value = manifest(&archive, "python3.13");
        value.max_unpacked_bytes = 1;
        let bytes = serde_json::to_vec(&value).unwrap();
        let payload = RuntimePayload::new(&archive, &bytes).unwrap();
        let cache = tempdir().unwrap();
        assert!(matches!(
            payload.ensure(cache.path()),
            Err(RuntimeError::Limits)
        ));
    }

    #[test]
    fn concurrent_handles_share_verified_generation() {
        let archive = fixture(false, "python3.13");
        let bytes = serde_json::to_vec(&manifest(&archive, "python3.13")).unwrap();
        let payload = RuntimePayload::new(&archive, &bytes).unwrap();
        let cache = tempdir().unwrap();
        drop(payload.ensure(cache.path()).unwrap());
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            let threads: Vec<_> = (0..4)
                .map(|_| {
                    let barrier = &barrier;
                    let payload = &payload;
                    let cache = cache.path();
                    scope.spawn(move || {
                        let handle = payload.ensure(cache).unwrap();
                        barrier.wait();
                        assert!(handle.executable.exists());
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }
        });
    }
}
