use elpis_protocol::{PROTOCOL_VERSION, Request};
use elpis_runtime::{ManifestEntry, RuntimeManifest, generate_manifest};
use flate2::read::GzDecoder;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

const TARGET: &str = "x86_64-unknown-linux-gnu";
const EXECUTABLE: &str = "python/bin/python3.13";
const MAX_HEADER_BYTES: usize = 64 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STAGE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Error)]
pub enum DistError {
    #[error("distribution configuration is invalid: {0}")]
    Config(&'static str),
    #[error("distribution artifact is invalid: {0}")]
    Invalid(String),
    #[error("distribution command failed: {0}")]
    Command(&'static str),
    #[error("distribution I/O failed")]
    Io(#[from] std::io::Error),
    #[error("distribution JSON failed")]
    Json(#[from] serde_json::Error),
    #[error("runtime validation failed")]
    Runtime(#[from] elpis_runtime::RuntimeError),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeLock {
    format: u32,
    python: PythonLock,
    payload: PayloadLock,
    packages: Vec<PackageLock>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PythonLock {
    version: String,
    source_archive_filename: String,
    source_archive_url: String,
    source_archive_bytes: u64,
    source_archive_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadLock {
    archive_sha256: String,
    archive_bytes: u64,
    manifest_sha256: String,
    manifest_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PackageLock {
    name: String,
    version: String,
    dist_info: String,
    wheel: String,
    wheel_url: String,
    wheel_bytes: u64,
    wheel_sha256: String,
    license_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Options {
    offline: bool,
    target: String,
    cache_dir: Option<PathBuf>,
    dist_dir: Option<PathBuf>,
}

#[derive(Serialize)]
struct Receipt<'a> {
    format: &'static str,
    version: &'a str,
    target: &'a str,
    cache_key: &'a str,
    binary: Artifact<'a>,
    runtime: RuntimeReceipt<'a>,
    sbom: Artifact<'a>,
}

#[derive(Serialize)]
struct Artifact<'a> {
    name: &'a str,
    sha256: &'a str,
    bytes: u64,
}

#[derive(Serialize)]
struct RuntimeReceipt<'a> {
    python_version: &'a str,
    source_sha256: &'a str,
    archive_sha256: &'a str,
    manifest_sha256: &'a str,
    packages: &'a [PackageLock],
}

#[derive(Serialize)]
struct Sbom<'a> {
    format: &'static str,
    version: &'a str,
    target: &'a str,
    runtime_archive_sha256: &'a str,
    python: PythonSbom<'a>,
    python_packages: &'a [PackageLock],
    rust_packages: Vec<RustPackage>,
}

#[derive(Serialize)]
struct PythonSbom<'a> {
    version: &'a str,
    source_sha256: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
struct RustPackage {
    name: String,
    version: String,
    license: Option<String>,
    source: String,
}

pub fn run(args: impl Iterator<Item = OsString>) -> Result<(), DistError> {
    let options = parse_options(args)?;
    dist(options)
}

fn parse_options(args: impl Iterator<Item = OsString>) -> Result<Options, DistError> {
    let mut args = args;
    if args.next().as_deref() != Some(OsStr::new("dist")) {
        return Err(DistError::Config(
            "usage: cargo xtask dist [--offline] [--cache-dir PATH] [--dist-dir PATH] [--target x86_64-unknown-linux-gnu]",
        ));
    }
    let mut options = Options {
        offline: false,
        target: TARGET.into(),
        cache_dir: None,
        dist_dir: None,
    };
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--offline") => options.offline = true,
            Some("--cache-dir") => options.cache_dir = Some(required_path(args.next())?),
            Some("--dist-dir") => options.dist_dir = Some(required_path(args.next())?),
            Some("--target") => {
                options.target = args
                    .next()
                    .and_then(|value| value.into_string().ok())
                    .filter(|value| !value.is_empty())
                    .ok_or(DistError::Config("--target requires a UTF-8 value"))?;
            }
            _ => return Err(DistError::Config("unknown dist argument")),
        }
    }
    if options.target != TARGET {
        return Err(DistError::Config(
            "only x86_64-unknown-linux-gnu is supported",
        ));
    }
    Ok(options)
}

fn required_path(value: Option<OsString>) -> Result<PathBuf, DistError> {
    value
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(DistError::Config("path argument is missing"))
}

fn dist(options: Options) -> Result<(), DistError> {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or(DistError::Config("workspace root is unavailable"))?
        .to_path_buf();
    let repo = workspace
        .parent()
        .ok_or(DistError::Config("repository root is unavailable"))?;
    let lock_path = workspace.join("python-runtime.lock.json");
    let cargo_lock_path = workspace.join("Cargo.lock");
    let lock_bytes = fs::read(&lock_path)?;
    let cargo_lock = fs::read(&cargo_lock_path)?;
    let lock: RuntimeLock = serde_json::from_slice(&lock_bytes)?;
    validate_lock(&lock)?;
    let cache = options.cache_dir.clone().unwrap_or(default_cache_dir()?);
    let dist_dir = options
        .dist_dir
        .clone()
        .unwrap_or_else(|| repo.join("dist"));
    if !cache.is_absolute()
        || !dist_dir.is_absolute()
        || cache.parent().and_then(Path::parent).is_none()
        || dist_dir.parent().and_then(Path::parent).is_none()
        || dist_dir == repo
        || dist_dir == workspace
    {
        return Err(DistError::Config(
            "cache and dist paths must be safe absolute paths",
        ));
    }
    ensure_private_dir(&cache)?;
    let lock_file = open_cache_lock(&cache)?;
    FileExt::lock_exclusive(&lock_file)?;
    let key = cache_key(&cargo_lock, &lock_bytes, &options.target);
    let objects = cache.join("objects");
    ensure_private_dir(&objects)?;
    let agent = download_agent();
    let python_object = ensure_object(
        &objects,
        &lock.python.source_archive_url,
        lock.python.source_archive_bytes,
        &lock.python.source_archive_sha256,
        options.offline,
        &agent,
    )?;
    let mut wheels = Vec::new();
    for package in &lock.packages {
        wheels.push((
            package,
            ensure_object(
                &objects,
                &package.wheel_url,
                package.wheel_bytes,
                &package.wheel_sha256,
                options.offline,
                &agent,
            )?,
        ));
    }
    let work = cache.join("work").join(&key);
    reset_tree(&work)?;
    ensure_private_dir(&work)?;
    let stage = work.join("stage");
    ensure_private_dir(&stage)?;
    extract_python(&python_object, &stage)?;
    let wheel_dir = work.join("wheels");
    ensure_private_dir(&wheel_dir)?;
    for (package, object) in &wheels {
        fs::copy(object, wheel_dir.join(&package.wheel))?;
    }
    install_packages(&stage, &wheel_dir, &lock.packages)?;
    let package_scripts = stage.join("python/lib/python3.13/site-packages/bin");
    if package_scripts.exists() {
        fs::remove_dir_all(package_scripts)?;
    }
    let site_packages = stage.join("python/lib/python3.13/site-packages");
    canonicalize_wheel_records(&site_packages)?;
    remove_python_cache(&site_packages)?;
    normalize_modes(&stage.join("python"))?;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut forbidden_paths = vec![workspace.as_path(), cache.as_path(), repo];
    if let Some(home) = home.as_deref() {
        forbidden_paths.push(home);
    }
    reject_tree_paths(&stage.join("python"), &forbidden_paths)?;
    package_canary(&stage)?;
    let archive = work.join("python-runtime.tar.gz");
    create_deterministic_archive(&stage, &archive)?;
    verify_path(
        &archive,
        lock.payload.archive_bytes,
        &lock.payload.archive_sha256,
    )?;
    let archive_bytes = fs::read(&archive)?;
    let mut manifest_bytes = generate_manifest(&archive_bytes, EXECUTABLE.into())?;
    manifest_bytes.push(b'\n');
    verify_bytes(
        &manifest_bytes,
        lock.payload.manifest_bytes,
        &lock.payload.manifest_sha256,
    )?;
    validate_package_receipts(&manifest_bytes, &lock.packages)?;
    let manifest = work.join("python-runtime-manifest.json");
    atomic_write(&work, "python-runtime-manifest.json", &manifest_bytes)?;
    let binary = build_executor(&workspace, &cache, &key, &archive, &manifest, &options)?;
    executor_canary(&binary, &work)?;
    let rust_packages = rust_sbom(&workspace, options.offline)?;
    publish(
        &dist_dir,
        &binary,
        &lock,
        &key,
        &options.target,
        rust_packages,
        &forbidden_paths,
    )?;
    Ok(())
}

fn validate_lock(lock: &RuntimeLock) -> Result<(), DistError> {
    if lock.format != 1
        || lock.python.version != "3.13.15"
        || !valid_name(&lock.python.source_archive_filename)
        || !valid_url(&lock.python.source_archive_url)
        || lock.python.source_archive_bytes == 0
        || !valid_sha(&lock.python.source_archive_sha256)
        || !valid_sha(&lock.payload.archive_sha256)
        || !valid_sha(&lock.payload.manifest_sha256)
        || lock.payload.archive_bytes == 0
        || lock.payload.manifest_bytes == 0
        || lock.packages.is_empty()
    {
        return Err(DistError::Config("runtime lock is invalid"));
    }
    let mut names = BTreeSet::new();
    for package in &lock.packages {
        if !names.insert(package.name.to_ascii_lowercase())
            || !valid_name(&package.wheel)
            || !valid_url(&package.wheel_url)
            || !valid_sha(&package.wheel_sha256)
            || package.wheel_bytes == 0
            || package.license_dir != format!("{}/licenses", package.dist_info)
        {
            return Err(DistError::Config("runtime package lock is invalid"));
        }
    }
    Ok(())
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
}

fn valid_url(value: &str) -> bool {
    value.starts_with("https://") && !value.contains('@') && !value.contains('#')
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn default_cache_dir() -> Result<PathBuf, DistError> {
    if let Some(path) = std::env::var_os("ELPIS_DIST_CACHE") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(path).join("elpis").join("dist"));
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join(".cache").join("elpis").join("dist"))
        .ok_or(DistError::Config("cache directory is not configured"))
}

fn ensure_private_dir(path: &Path) -> Result<(), DistError> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if !meta.file_type().is_dir()
                || meta.file_type().is_symlink()
                || meta.mode() & 0o7777 != 0o700
                || meta.uid() != rustix::process::geteuid().as_raw()
            {
                return Err(DistError::Config("cache directory is unsafe"));
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_dir()
        || meta.file_type().is_symlink()
        || meta.mode() & 0o7777 != 0o700
        || meta.uid() != rustix::process::geteuid().as_raw()
    {
        return Err(DistError::Config("cache directory is unsafe"));
    }
    Ok(())
}

fn open_cache_lock(cache: &Path) -> Result<File, DistError> {
    Ok(OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(cache.join("dist.lock"))?)
}

fn download_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(true)
        .proxy(None)
        .max_redirects(5)
        .http_status_as_error(false)
        .max_response_header_size(MAX_HEADER_BYTES)
        .max_idle_connections(0)
        .max_idle_connections_per_host(0)
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .timeout_per_call(Some(DOWNLOAD_TIMEOUT))
        .timeout_resolve(Some(STAGE_TIMEOUT))
        .timeout_connect(Some(STAGE_TIMEOUT))
        .timeout_recv_response(Some(STAGE_TIMEOUT))
        .timeout_recv_body(Some(DOWNLOAD_TIMEOUT))
        .build()
        .new_agent()
}

fn ensure_object(
    objects: &Path,
    url: &str,
    expected_bytes: u64,
    expected_sha: &str,
    offline: bool,
    agent: &ureq::Agent,
) -> Result<PathBuf, DistError> {
    let destination = objects.join(expected_sha);
    if verify_path(&destination, expected_bytes, expected_sha).is_ok() {
        return Ok(destination);
    }
    if destination.exists() {
        let meta = fs::symlink_metadata(&destination)?;
        if !meta.file_type().is_file() || meta.file_type().is_symlink() {
            return Err(DistError::Config("cached object is not a regular file"));
        }
        fs::remove_file(&destination)?;
    }
    if offline {
        return Err(DistError::Invalid(format!(
            "offline cache object {expected_sha} is unavailable"
        )));
    }
    let mut response = agent
        .get(url)
        .call()
        .map_err(|_| DistError::Invalid("artifact download failed".into()))?;
    if response.status() != ureq::http::StatusCode::OK
        || response
            .body()
            .content_length()
            .is_some_and(|length| length != expected_bytes)
    {
        return Err(DistError::Invalid("artifact response is invalid".into()));
    }
    store_reader(
        objects,
        expected_sha,
        expected_bytes,
        expected_sha,
        response.body_mut().as_reader(),
    )?;
    verify_path(&destination, expected_bytes, expected_sha)?;
    Ok(destination)
}

fn store_reader(
    dir: &Path,
    name: &str,
    expected_bytes: u64,
    expected_sha: &str,
    mut reader: impl Read,
) -> Result<(), DistError> {
    if !valid_name(name) {
        return Err(DistError::Config("cache object name is invalid"));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DistError::Config("system clock is before Unix epoch"))?
        .as_nanos();
    let temp_name = format!(".{name}.tmp-{}-{nonce}", std::process::id());
    let temp = dir.join(&temp_name);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temp)?;
    let result = (|| {
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read as u64)
                .ok_or_else(|| std::io::Error::other("download size overflow"))?;
            if total > expected_bytes {
                return Err(std::io::Error::other("download exceeds locked size"));
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read])?;
        }
        if total != expected_bytes || hex::encode(hasher.finalize()) != expected_sha {
            return Err(std::io::Error::other("download does not match lock"));
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, dir.join(name))?;
        File::open(dir)?.sync_all()?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(DistError::Io)
}

fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), DistError> {
    if !valid_name(name) {
        return Err(DistError::Config("atomic filename is invalid"));
    }
    let temp_name = format!(".{name}.tmp-{}", std::process::id());
    let temp = dir.join(&temp_name);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, dir.join(name))?;
        File::open(dir)?.sync_all()?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(DistError::Io)
}

fn verify_path(path: &Path, expected_bytes: u64, expected_sha: &str) -> Result<(), DistError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.file_type().is_file() || meta.len() != expected_bytes {
        return Err(DistError::Invalid("artifact size mismatch".into()));
    }
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    if hex::encode(hasher.finalize()) != expected_sha {
        return Err(DistError::Invalid("artifact SHA256 mismatch".into()));
    }
    Ok(())
}

fn verify_bytes(bytes: &[u8], expected_bytes: u64, expected_sha: &str) -> Result<(), DistError> {
    if bytes.len() as u64 != expected_bytes || hex::encode(Sha256::digest(bytes)) != expected_sha {
        return Err(DistError::Invalid(
            "artifact bytes do not match lock".into(),
        ));
    }
    Ok(())
}

fn cache_key(cargo_lock: &[u8], runtime_lock: &[u8], target: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"elpis-dist-cache-v1\0");
    hasher.update((cargo_lock.len() as u64).to_be_bytes());
    hasher.update(cargo_lock);
    hasher.update((runtime_lock.len() as u64).to_be_bytes());
    hasher.update(runtime_lock);
    hasher.update(target.as_bytes());
    hex::encode(hasher.finalize())
}

fn reset_tree(path: &Path) -> Result<(), DistError> {
    if path.exists() {
        make_writable(path)?;
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

fn make_writable(path: &Path) -> Result<(), DistError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || meta.file_type().is_file() {
        if meta.file_type().is_file() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        make_writable(&entry?.path())?;
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn extract_python(archive: &Path, stage: &Path) -> Result<(), DistError> {
    let file = File::open(archive)?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(stage)?;
    if !stage.join(EXECUTABLE).is_file() {
        return Err(DistError::Invalid(
            "Python archive executable is absent".into(),
        ));
    }
    Ok(())
}

fn install_packages(
    stage: &Path,
    wheels: &Path,
    packages: &[PackageLock],
) -> Result<(), DistError> {
    let python = stage.join(EXECUTABLE);
    let target = stage.join("python/lib/python3.13/site-packages");
    let mut command = Command::new(python);
    command
        .args([
            "-I",
            "-B",
            "-m",
            "pip",
            "install",
            "--no-index",
            "--only-binary=:all:",
            "--no-compile",
            "--no-deps",
            "--target",
        ])
        .arg(&target)
        .arg("--find-links")
        .arg(wheels);
    for package in packages {
        command.arg(format!("{}=={}", package.name, package.version));
    }
    run_command(&mut command, "pinned wheel install")
}

fn remove_python_cache(root: &Path) -> Result<(), DistError> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let path = entry.path();
            let ty = entry.file_type()?;
            if ty.is_dir() && entry.file_name() == "__pycache__" {
                fs::remove_dir_all(path)?;
            } else if ty.is_dir() {
                stack.push(path);
            } else if ty.is_file() && path.extension() == Some(OsStr::new("pyc")) {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

fn canonicalize_wheel_records(site_packages: &Path) -> Result<(), DistError> {
    for entry in fs::read_dir(site_packages)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || !entry.file_name().to_string_lossy().ends_with(".dist-info")
        {
            continue;
        }
        let record = entry.path().join("RECORD");
        if !record.is_file() {
            continue;
        }
        let bytes = fs::read(&record)?;
        let mut canonical = Vec::with_capacity(bytes.len());
        for line in bytes.split_inclusive(|byte| *byte == b'\n') {
            if !line.starts_with(b"../../bin/") {
                canonical.extend_from_slice(line);
            }
        }
        fs::write(record, canonical)?;
    }
    Ok(())
}

fn normalize_modes(root: &Path) -> Result<(), DistError> {
    let mut directories = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        directories.push(path.clone());
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                let mode = entry.metadata()?.mode() & 0o700;
                fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn package_canary(stage: &Path) -> Result<(), DistError> {
    let mut command = Command::new(stage.join(EXECUTABLE));
    command
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .args([
            "-I",
            "-B",
            "-c",
            "from PIL import Image; import numpy,yaml,requests; im=Image.new('RGB',(2,2),(1,2,3)); assert im.getpixel((0,0))==(1,2,3); assert numpy.arange(4).sum()==6; assert yaml.safe_load('x: 7')['x']==7; assert requests.__version__=='2.34.2'",
        ]);
    run_command(&mut command, "runtime package canary")
}

fn create_deterministic_archive(stage: &Path, output: &Path) -> Result<(), DistError> {
    let tar_path = output.with_extension("tar");
    let mut tar = Command::new("tar");
    tar.current_dir(stage)
        .env("LC_ALL", "C")
        .args([
            "--sort=name",
            "--mtime=@0",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "-cf",
        ])
        .arg(&tar_path)
        .arg("python");
    run_command(&mut tar, "deterministic tar assembly")?;
    let output_file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(output)?;
    let status = Command::new("gzip")
        .args(["-n", "-c"])
        .arg(&tar_path)
        .stdout(Stdio::from(output_file))
        .status()?;
    fs::remove_file(tar_path)?;
    if !status.success() {
        return Err(DistError::Command("deterministic gzip assembly"));
    }
    Ok(())
}

fn validate_package_receipts(manifest: &[u8], packages: &[PackageLock]) -> Result<(), DistError> {
    let manifest: RuntimeManifest = serde_json::from_slice(manifest)?;
    let paths = manifest
        .entries
        .iter()
        .map(|entry| match entry {
            ManifestEntry::File { path, .. } | ManifestEntry::Symlink { path, .. } => path.as_str(),
        })
        .collect::<Vec<_>>();
    for package in packages {
        let metadata = format!("python/lib/python3.13/site-packages/{}/", package.dist_info);
        let licenses = format!(
            "python/lib/python3.13/site-packages/{}/",
            package.license_dir
        );
        if !paths.iter().any(|path| path.starts_with(&metadata))
            || !paths.iter().any(|path| path.starts_with(&licenses))
        {
            return Err(DistError::Invalid(format!(
                "package {} metadata or licenses are absent",
                package.name
            )));
        }
    }
    Ok(())
}

fn build_executor(
    workspace: &Path,
    cache: &Path,
    key: &str,
    archive: &Path,
    manifest: &Path,
    options: &Options,
) -> Result<PathBuf, DistError> {
    let target_dir = cache.join("build").join(key).join("target");
    ensure_private_dir(
        target_dir
            .parent()
            .ok_or(DistError::Config("build path is invalid"))?,
    )?;
    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cargo")));
    let mut flags = vec![
        format!("--remap-path-prefix={}=/src/elpis", workspace.display()),
        format!("--remap-path-prefix={}=/cache", cache.display()),
    ];
    if let Some(home) = &cargo_home {
        flags.push(format!("--remap-path-prefix={}=/cargo", home.display()));
    }
    let mut command = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    command
        .current_dir(workspace)
        .args([
            "build",
            "--release",
            "--locked",
            "--target",
            &options.target,
            "-p",
            "elpis-executor",
            "--features",
            "embedded-python",
        ])
        .env("CARGO_TARGET_DIR", &target_dir)
        .env("CARGO_ENCODED_RUSTFLAGS", flags.join("\u{1f}"))
        .env("SOURCE_DATE_EPOCH", "0")
        .env("ELPIS_PYTHON_ARCHIVE", archive)
        .env("ELPIS_PYTHON_MANIFEST", manifest);
    if options.offline {
        command.arg("--offline");
    }
    run_command(&mut command, "release executor build")?;
    let binary = target_dir
        .join(&options.target)
        .join("release")
        .join("elpis-executor");
    if !binary.is_file() {
        return Err(DistError::Invalid(
            "release executor binary is absent".into(),
        ));
    }
    Ok(binary)
}

fn executor_canary(binary: &Path, work: &Path) -> Result<(), DistError> {
    let state = work.join("canary-state");
    reset_tree(&state)?;
    ensure_private_dir(&state)?;
    let frames = [
        Request::Open {
            protocol: PROTOCOL_VERSION,
            request_id: "d1".into(),
            context_id: "c1".into(),
            generation: 1,
        },
        Request::Run {
            protocol: PROTOCOL_VERSION,
            request_id: "d2".into(),
            context_id: "c1".into(),
            generation: 1,
            run_id: "r1".into(),
            source: "(__import__('sys').version_info[:3],__import__('PIL').__version__,__import__('numpy').__version__,__import__('yaml').__version__,__import__('requests').__version__,6*7)".into(),
            preview_max_bytes: 1024,
        },
        Request::Close {
            protocol: PROTOCOL_VERSION,
            request_id: "d3".into(),
            context_id: "c1".into(),
            generation: 1,
        },
    ]
    .into_iter()
    .map(|request| serde_json::to_string(&request))
    .collect::<Result<Vec<_>, _>>()?;
    let mut child = Command::new(binary)
        .env_clear()
        .env("PATH", "/nonexistent")
        .env("ELPIS_EXECUTOR_MODE", "stdin")
        .env("ELPIS_EXECUTOR_STATE_DIR", &state)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(DistError::Command("canary stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(DistError::Command("canary stdout"))?;
    let mut stdout = BufReader::new(stdout);
    let mut values = Vec::with_capacity(frames.len());
    for frame in frames {
        stdin.write_all(frame.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        let mut line = String::new();
        if stdout.read_line(&mut line)? == 0 {
            return Err(DistError::Invalid(
                "executor canary response is absent".into(),
            ));
        }
        values.push(serde_json::from_str::<serde_json::Value>(&line)?);
    }
    drop(stdin);
    drop(stdout);
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(DistError::Command("PATH-empty executor canary"));
    }
    if values.len() != 3
        || values
            .iter()
            .any(|value| value.get("ok") != Some(&serde_json::Value::Bool(true)))
        || values[1]
            .pointer("/result/preview")
            .and_then(|value| value.as_str())
            .is_none_or(|value| !value.contains("42"))
    {
        return Err(DistError::Invalid(
            "executor canary response is invalid".into(),
        ));
    }
    Ok(())
}

fn rust_sbom(workspace: &Path, offline: bool) -> Result<Vec<RustPackage>, DistError> {
    let mut command = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    command
        .current_dir(workspace)
        .args(["metadata", "--locked", "--format-version", "1"]);
    if offline {
        command.arg("--offline");
    }
    let output = command.output()?;
    if !output.status.success() {
        return Err(DistError::Command("Cargo metadata SBOM"));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let packages = value
        .get("packages")
        .and_then(|value| value.as_array())
        .ok_or(DistError::Invalid(
            "Cargo metadata packages are absent".into(),
        ))?;
    let executor_id = packages
        .iter()
        .find(|package| {
            package.get("name").and_then(|value| value.as_str()) == Some("elpis-executor")
        })
        .and_then(|package| package.get("id"))
        .and_then(|value| value.as_str())
        .ok_or(DistError::Invalid(
            "executor package is absent from Cargo metadata".into(),
        ))?;
    let nodes = value
        .pointer("/resolve/nodes")
        .and_then(|value| value.as_array())
        .ok_or(DistError::Invalid(
            "Cargo dependency graph is absent".into(),
        ))?;
    let mut dependencies = BTreeMap::<&str, Vec<&str>>::new();
    for node in nodes {
        let id = node
            .get("id")
            .and_then(|value| value.as_str())
            .ok_or(DistError::Invalid("Cargo node id is absent".into()))?;
        let deps = node
            .get("deps")
            .and_then(|value| value.as_array())
            .ok_or(DistError::Invalid(
                "Cargo node dependencies are absent".into(),
            ))?
            .iter()
            .map(|dependency| {
                dependency
                    .get("pkg")
                    .and_then(|value| value.as_str())
                    .ok_or(DistError::Invalid("Cargo dependency id is absent".into()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        dependencies.insert(id, deps);
    }
    let mut included = BTreeSet::new();
    let mut stack = vec![executor_id];
    while let Some(id) = stack.pop() {
        if !included.insert(id) {
            continue;
        }
        if let Some(deps) = dependencies.get(id) {
            stack.extend(deps.iter().copied());
        }
    }
    let mut result = packages
        .iter()
        .filter(|package| {
            package
                .get("id")
                .and_then(|value| value.as_str())
                .is_some_and(|id| included.contains(id))
        })
        .map(|package| {
            let source = match package.get("source").and_then(|value| value.as_str()) {
                Some(value) if value.starts_with("registry+") => "crates.io",
                Some(value) if value.starts_with("git+") => "git",
                Some(_) => "external",
                None => "workspace",
            }
            .to_string();
            Ok(RustPackage {
                name: package
                    .get("name")
                    .and_then(|value| value.as_str())
                    .ok_or(DistError::Invalid("Cargo package name is absent".into()))?
                    .to_string(),
                version: package
                    .get("version")
                    .and_then(|value| value.as_str())
                    .ok_or(DistError::Invalid("Cargo package version is absent".into()))?
                    .to_string(),
                license: package
                    .get("license")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                source,
            })
        })
        .collect::<Result<Vec<_>, DistError>>()?;
    result.sort_by(|left, right| (&left.name, &left.version).cmp(&(&right.name, &right.version)));
    result.dedup_by(|left, right| left.name == right.name && left.version == right.version);
    Ok(result)
}

fn publish(
    dist: &Path,
    binary: &Path,
    lock: &RuntimeLock,
    key: &str,
    target: &str,
    rust_packages: Vec<RustPackage>,
    forbidden_paths: &[&Path],
) -> Result<(), DistError> {
    reset_dist(dist)?;
    fs::create_dir_all(dist)?;
    fs::set_permissions(dist, fs::Permissions::from_mode(0o755))?;
    let version = env!("CARGO_PKG_VERSION");
    let stem = format!("elpis-executor-v{version}-{target}");
    let binary_name = stem.clone();
    let binary_out = dist.join(&binary_name);
    fs::copy(binary, &binary_out)?;
    fs::set_permissions(&binary_out, fs::Permissions::from_mode(0o555))?;
    let binary_bytes = fs::read(&binary_out)?;
    reject_paths(&binary_bytes, forbidden_paths)?;
    let binary_sha = hex::encode(Sha256::digest(&binary_bytes));
    let sbom_name = format!("{stem}.sbom.json");
    let sbom = Sbom {
        format: "elpis-executor-sbom-v1",
        version,
        target,
        runtime_archive_sha256: &lock.payload.archive_sha256,
        python: PythonSbom {
            version: &lock.python.version,
            source_sha256: &lock.python.source_archive_sha256,
        },
        python_packages: &lock.packages,
        rust_packages,
    };
    let sbom_bytes = serde_json::to_vec_pretty(&sbom)?;
    write_public_file(&dist.join(&sbom_name), &sbom_bytes)?;
    let sbom_sha = hex::encode(Sha256::digest(&sbom_bytes));
    let receipt = Receipt {
        format: "elpis-executor-dist-v1",
        version,
        target,
        cache_key: key,
        binary: Artifact {
            name: &binary_name,
            sha256: &binary_sha,
            bytes: binary_bytes.len() as u64,
        },
        runtime: RuntimeReceipt {
            python_version: &lock.python.version,
            source_sha256: &lock.python.source_archive_sha256,
            archive_sha256: &lock.payload.archive_sha256,
            manifest_sha256: &lock.payload.manifest_sha256,
            packages: &lock.packages,
        },
        sbom: Artifact {
            name: &sbom_name,
            sha256: &sbom_sha,
            bytes: sbom_bytes.len() as u64,
        },
    };
    write_public_file(
        &dist.join(format!("{stem}.receipt.json")),
        &serde_json::to_vec_pretty(&receipt)?,
    )?;
    write_public_file(
        &dist.join(format!("{stem}.sha256")),
        format!("{binary_sha}  {binary_name}\n{sbom_sha}  {sbom_name}\n").as_bytes(),
    )?;
    Ok(())
}

fn reset_dist(path: &Path) -> Result<(), DistError> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
                return Err(DistError::Config("dist path is not an owned directory"));
            }
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let name = entry.file_name();
                if !entry.file_type()?.is_file()
                    || !name.to_string_lossy().starts_with("elpis-executor-v")
                {
                    return Err(DistError::Config("dist directory contains unowned entries"));
                }
                fs::remove_file(entry.path())?;
            }
            fs::remove_dir(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn write_public_file(path: &Path, bytes: &[u8]) -> Result<(), DistError> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o644))?;
    Ok(())
}

fn reject_tree_paths(root: &Path, paths: &[&Path]) -> Result<(), DistError> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                reject_paths(&fs::read(path)?, paths)?;
            }
        }
    }
    Ok(())
}

fn reject_paths(bytes: &[u8], paths: &[&Path]) -> Result<(), DistError> {
    for path in paths {
        let raw = path.as_os_str().as_encoded_bytes();
        if !raw.is_empty() && bytes.windows(raw.len()).any(|window| window == raw) {
            return Err(DistError::Invalid(
                "binary contains a private build path".into(),
            ));
        }
    }
    Ok(())
}

fn run_command(command: &mut Command, label: &'static str) -> Result<(), DistError> {
    if command.status()?.success() {
        Ok(())
    } else {
        Err(DistError::Command(label))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_explicit_offline_dist_options() {
        let options = parse_options(
            [
                "dist",
                "--offline",
                "--cache-dir",
                "/cache",
                "--dist-dir",
                "/dist",
                "--target",
                TARGET,
            ]
            .into_iter()
            .map(OsString::from),
        )
        .unwrap();
        assert!(options.offline);
        assert_eq!(options.cache_dir, Some(PathBuf::from("/cache")));
        assert_eq!(options.dist_dir, Some(PathBuf::from("/dist")));
    }

    #[test]
    fn rejects_unknown_command_and_target() {
        assert!(parse_options([OsString::from("nope")].into_iter()).is_err());
        assert!(
            parse_options(
                ["dist", "--target", "aarch64-unknown-linux-gnu"]
                    .into_iter()
                    .map(OsString::from)
            )
            .is_err()
        );
    }

    #[test]
    fn cache_key_binds_both_locks_and_target() {
        let first = cache_key(b"cargo", b"runtime", TARGET);
        assert_eq!(first, cache_key(b"cargo", b"runtime", TARGET));
        assert_ne!(first, cache_key(b"cargo2", b"runtime", TARGET));
        assert_ne!(first, cache_key(b"cargo", b"runtime2", TARGET));
    }

    #[test]
    fn verifies_and_rejects_corrupt_cached_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = b"artifact";
        let sha = hex::encode(Sha256::digest(bytes));
        let path = temp.path().join(&sha);
        fs::write(&path, bytes).unwrap();
        assert!(verify_path(&path, bytes.len() as u64, &sha).is_ok());
        fs::write(&path, b"corrupt").unwrap();
        assert!(verify_path(&path, bytes.len() as u64, &sha).is_err());
    }

    #[test]
    fn streamed_cache_write_verifies_bytes_and_cleans_failures() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = b"streamed artifact";
        let sha = hex::encode(Sha256::digest(bytes));
        store_reader(
            temp.path(),
            &sha,
            bytes.len() as u64,
            &sha,
            std::io::Cursor::new(bytes),
        )
        .unwrap();
        assert_eq!(fs::read(temp.path().join(&sha)).unwrap(), bytes);
        fs::remove_file(temp.path().join(&sha)).unwrap();
        assert!(
            store_reader(
                temp.path(),
                &sha,
                bytes.len() as u64,
                &sha,
                std::io::Cursor::new(b"wrong"),
            )
            .is_err()
        );
        assert!(!temp.path().join(&sha).exists());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejects_paths_embedded_in_binary_bytes() {
        assert!(reject_paths(b"prefix/home/test/suffix", &[Path::new("/home/test")]).is_err());
        assert!(reject_paths(b"clean", &[Path::new("/home/test")]).is_ok());
    }

    #[test]
    fn private_directory_validation_never_repermissions_existing_path() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("cache");
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_private_dir(&path).is_err());
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o7777, 0o755);
    }

    #[test]
    fn dist_cleanup_refuses_unknown_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("dist");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("unowned"), b"keep").unwrap();
        assert!(reset_dist(&path).is_err());
        assert!(path.join("unowned").exists());
    }
}
