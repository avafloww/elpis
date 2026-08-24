use elpis_runtime::{ManifestEntry, RuntimeManifest, RuntimePayload};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Cursor};
use std::path::{Component, Path};
use tar::EntryType;

fn main() {
    if let Err(error) = run() {
        eprintln!("elpis-runtime-manifest: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let archive_path = args
        .next()
        .ok_or("usage: elpis-runtime-manifest ARCHIVE EXECUTABLE")?;
    let executable = args
        .next()
        .ok_or("usage: elpis-runtime-manifest ARCHIVE EXECUTABLE")?
        .into_string()
        .map_err(|_| "executable path must be UTF-8")?;
    if args.next().is_some() {
        return Err("usage: elpis-runtime-manifest ARCHIVE EXECUTABLE".into());
    }
    let archive_bytes = fs::read(archive_path)?;
    let archive_sha256 = hex::encode(Sha256::digest(&archive_bytes));
    let decoder = GzDecoder::new(Cursor::new(&archive_bytes));
    let mut archive = tar::Archive::new(decoder);
    let mut entries = Vec::new();
    let mut unpacked_bytes = 0_u64;
    for item in archive.entries()? {
        let mut item = item?;
        let path = item.path()?.into_owned();
        let path = normalized_text(&path)?;
        let entry_type = item.header().entry_type();
        if entry_type == EntryType::Directory {
            continue;
        }
        if entry_type.is_file() {
            let size = item.header().size()?;
            unpacked_bytes = unpacked_bytes
                .checked_add(size)
                .ok_or("runtime size overflow")?;
            let mut hasher = Sha256::new();
            io::copy(&mut item, &mut HashSink(&mut hasher))?;
            let source_mode = item.header().mode()?;
            let mode = if source_mode & 0o111 != 0 {
                0o555
            } else {
                0o444
            };
            entries.push(ManifestEntry::File {
                path,
                sha256: hex::encode(hasher.finalize()),
                mode,
                size,
            });
        } else if entry_type.is_symlink() {
            let target = item.link_name()?.ok_or("symlink target is missing")?;
            let target = target
                .into_owned()
                .into_os_string()
                .into_string()
                .map_err(|_| "symlink target must be UTF-8")?;
            entries.push(ManifestEntry::Symlink { path, target });
        } else {
            return Err(format!("unsupported archive entry {path}").into());
        }
    }
    entries.sort_by(|left, right| entry_path(left).cmp(entry_path(right)));
    let manifest = RuntimeManifest {
        format: 1,
        archive_sha256,
        executable,
        max_entries: entries.len() as u64,
        max_unpacked_bytes: unpacked_bytes,
        entries,
    };
    let bytes = serde_json::to_vec(&manifest)?;
    RuntimePayload::new(&archive_bytes, &bytes)?;
    println!("{}", String::from_utf8(bytes)?);
    Ok(())
}

struct HashSink<'a>(&'a mut Sha256);

impl io::Write for HashSink<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn normalized_text(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_str().ok_or("path must be UTF-8")?),
            Component::CurDir => {}
            _ => return Err(format!("unsafe archive path {}", path.display()).into()),
        }
    }
    if parts.is_empty() {
        return Err("empty archive path".into());
    }
    Ok(parts.join("/"))
}

fn entry_path(entry: &ManifestEntry) -> &str {
    match entry {
        ManifestEntry::File { path, .. } | ManifestEntry::Symlink { path, .. } => path,
    }
}
