use elpis_runtime::RuntimePayload;
use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("elpis-runtime-materialize: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let archive_path = args
        .next()
        .ok_or("usage: elpis-runtime-materialize ARCHIVE MANIFEST CACHE")?;
    let manifest_path = args
        .next()
        .ok_or("usage: elpis-runtime-materialize ARCHIVE MANIFEST CACHE")?;
    let cache = PathBuf::from(
        args.next()
            .ok_or("usage: elpis-runtime-materialize ARCHIVE MANIFEST CACHE")?,
    );
    if args.next().is_some() {
        return Err("usage: elpis-runtime-materialize ARCHIVE MANIFEST CACHE".into());
    }
    let archive = fs::read(archive_path)?;
    let manifest = fs::read(manifest_path)?;
    let payload = RuntimePayload::new(&archive, &manifest)?;
    let handle = payload.ensure(&cache)?;
    println!("{}", handle.executable.display());
    Ok(())
}
