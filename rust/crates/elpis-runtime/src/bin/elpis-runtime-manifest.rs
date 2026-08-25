use elpis_runtime::generate_manifest;
use std::env;
use std::fs;

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
    let archive = fs::read(archive_path)?;
    let manifest = generate_manifest(&archive, executable)?;
    println!("{}", String::from_utf8(manifest)?);
    Ok(())
}
