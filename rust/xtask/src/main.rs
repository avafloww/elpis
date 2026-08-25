fn main() {
    if let Err(error) = xtask::run(std::env::args_os().skip(1)) {
        eprintln!("xtask: {error}");
        std::process::exit(1);
    }
}
