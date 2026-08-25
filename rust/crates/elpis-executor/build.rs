use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeLock {
    format: u32,
    python: PythonLock,
    payload: PayloadLock,
    packages: Vec<PackageLock>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PythonLock {
    version: String,
    source_archive_filename: String,
    source_archive_url: String,
    source_archive_bytes: u64,
    source_archive_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadLock {
    archive_sha256: String,
    archive_bytes: u64,
    manifest_sha256: String,
    manifest_bytes: u64,
}

#[derive(Deserialize)]
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

fn main() {
    println!("cargo:rerun-if-env-changed=ELPIS_PYTHON_ARCHIVE");
    println!("cargo:rerun-if-env-changed=ELPIS_PYTHON_MANIFEST");
    if env::var_os("CARGO_FEATURE_EMBEDDED_PYTHON").is_none() {
        return;
    }
    if let Err(error) = seal_bundle() {
        panic!("embedded Python bundle rejected: {error}");
    }
}

fn seal_bundle() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").ok_or("missing CARGO_MANIFEST_DIR")?);
    let lock_path = manifest_dir.join("../../python-runtime.lock.json");
    println!("cargo:rerun-if-changed={}", lock_path.display());
    let lock_bytes = fs::read(&lock_path)?;
    let lock: RuntimeLock = serde_json::from_slice(&lock_bytes)?;
    if lock.format != 1
        || lock.python.version != "3.13.15"
        || lock.python.source_archive_filename.is_empty()
        || !valid_https_url(&lock.python.source_archive_url)
        || lock.python.source_archive_bytes == 0
        || !is_sha256(&lock.python.source_archive_sha256)
    {
        return Err("runtime lock header is invalid".into());
    }
    validate_packages(&lock.packages)?;

    let archive_path = required_path("ELPIS_PYTHON_ARCHIVE")?;
    let runtime_manifest_path = required_path("ELPIS_PYTHON_MANIFEST")?;
    println!("cargo:rerun-if-changed={}", archive_path.display());
    println!("cargo:rerun-if-changed={}", runtime_manifest_path.display());
    let archive = fs::read(&archive_path)?;
    let runtime_manifest = fs::read(&runtime_manifest_path)?;
    verify_bytes(
        "archive",
        &archive,
        lock.payload.archive_bytes,
        &lock.payload.archive_sha256,
    )?;
    verify_bytes(
        "manifest",
        &runtime_manifest,
        lock.payload.manifest_bytes,
        &lock.payload.manifest_sha256,
    )?;

    let manifest_json: serde_json::Value = serde_json::from_slice(&runtime_manifest)?;
    if manifest_json.get("format").and_then(|value| value.as_u64()) != Some(1)
        || manifest_json
            .get("archive_sha256")
            .and_then(|value| value.as_str())
            != Some(lock.payload.archive_sha256.as_str())
    {
        return Err("runtime manifest does not bind the pinned archive".into());
    }
    let paths: Vec<&str> = manifest_json
        .get("entries")
        .and_then(|value| value.as_array())
        .ok_or("runtime manifest entries are missing")?
        .iter()
        .map(|entry| {
            entry
                .get("path")
                .and_then(|value| value.as_str())
                .ok_or("runtime manifest entry path is invalid")
        })
        .collect::<Result<_, _>>()?;
    for package in &lock.packages {
        let prefix = format!("python/lib/python3.13/site-packages/{}/", package.dist_info);
        let license_prefix = format!(
            "python/lib/python3.13/site-packages/{}/",
            package.license_dir
        );
        if !paths.iter().any(|path| path.starts_with(&prefix))
            || !paths.iter().any(|path| path.starts_with(&license_prefix))
        {
            return Err(format!(
                "package {} {} metadata or licenses are absent",
                package.name, package.version
            )
            .into());
        }
    }

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").ok_or("missing OUT_DIR")?);
    fs::write(out_dir.join("python-runtime.tar.gz"), &archive)?;
    fs::write(
        out_dir.join("python-runtime-manifest.json"),
        &runtime_manifest,
    )?;
    let generated = format!(
        "pub static PYTHON_ARCHIVE: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/python-runtime.tar.gz\"));\n\
         pub static PYTHON_MANIFEST: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/python-runtime-manifest.json\"));\n\
         pub const PYTHON_ARCHIVE_SHA256: &str = \"{}\";\n\
         pub const PYTHON_MANIFEST_SHA256: &str = \"{}\";\n",
        lock.payload.archive_sha256, lock.payload.manifest_sha256
    );
    fs::write(out_dir.join("python_bundle.rs"), generated)?;
    Ok(())
}

fn required_path(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{name} is required with embedded-python").into())
}

fn verify_bytes(
    label: &str,
    bytes: &[u8],
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if bytes.len() as u64 != expected_size || hex::encode(Sha256::digest(bytes)) != expected_sha256
    {
        return Err(format!("{label} size or SHA256 mismatch").into());
    }
    Ok(())
}

fn validate_packages(packages: &[PackageLock]) -> Result<(), Box<dyn std::error::Error>> {
    if packages.is_empty() {
        return Err("runtime package lock is empty".into());
    }
    for package in packages {
        if package.name.is_empty()
            || package.version.is_empty()
            || package.dist_info.is_empty()
            || package.wheel.is_empty()
            || !valid_https_url(&package.wheel_url)
            || package.wheel_bytes == 0
            || !is_sha256(&package.wheel_sha256)
            || package.license_dir != format!("{}/licenses", package.dist_info)
        {
            return Err("runtime package lock entry is invalid".into());
        }
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_https_url(value: &str) -> bool {
    value.starts_with("https://") && !value.contains('#') && !value.contains('@')
}
