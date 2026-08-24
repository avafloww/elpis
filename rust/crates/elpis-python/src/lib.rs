use elpis_protocol::{MAX_FRAME_BYTES, MAX_SOURCE_BYTES, validate_id};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use thiserror::Error;

const BOOTSTRAP: &str = include_str!("bootstrap.py");

#[derive(Debug, Error)]
pub enum PythonError {
    #[error("python executable is unavailable: {0}")]
    Unavailable(#[source] std::io::Error),
    #[error("python protocol IO failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("python protocol returned EOF")]
    Eof,
    #[error("python protocol frame exceeds {MAX_FRAME_BYTES} bytes")]
    FrameTooLarge,
    #[error("python protocol frame is invalid: {0}")]
    InvalidFrame(#[from] serde_json::Error),
    #[error("python context binding mismatch")]
    Binding,
    #[error("run id was already used in this context")]
    DuplicateRun,
    #[error("source exceeds {MAX_SOURCE_BYTES} bytes")]
    SourceTooLarge,
    #[error("python syntax validation failed: {0}")]
    Syntax(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RunResult {
    pub ok: bool,
    pub kind: String,
    #[serde(default)]
    pub has_value: bool,
    pub saved_as: Option<String>,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub preview_bytes: usize,
    #[serde(default)]
    pub preview_truncated: bool,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stdout_bytes: usize,
    #[serde(default)]
    pub stdout_truncated: bool,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub stderr_bytes: usize,
    #[serde(default)]
    pub stderr_truncated: bool,
    pub failure_kind: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
struct ChildRun<'a> {
    op: &'static str,
    run_id: &'a str,
    source: &'a str,
    preview_max_bytes: usize,
}

#[derive(Serialize)]
struct ChildClose {
    op: &'static str,
}

#[derive(Debug, Clone)]
enum PythonExecutable {
    Path(PathBuf),
    Verified(Arc<File>),
}

#[derive(Debug, Clone)]
pub struct PythonRuntime {
    executable: PythonExecutable,
    isolated: bool,
}

impl PythonRuntime {
    pub fn system(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: PythonExecutable::Path(executable.into()),
            isolated: false,
        }
    }

    pub fn isolated(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: PythonExecutable::Path(executable.into()),
            isolated: true,
        }
    }

    pub fn isolated_verified(executable: File) -> Self {
        Self {
            executable: PythonExecutable::Verified(Arc::new(executable)),
            isolated: true,
        }
    }

    fn command(&self) -> Command {
        let mut command = match &self.executable {
            PythonExecutable::Path(path) => Command::new(path),
            PythonExecutable::Verified(file) => {
                Command::new(format!("/proc/self/fd/{}", file.as_raw_fd()))
            }
        };
        if self.isolated {
            command.args(["-I", "-B"]);
        }
        command
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONSTARTUP")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1");
        command
    }
}

pub struct PythonContext {
    context_id: String,
    generation: u64,
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    seen_runs: HashSet<String>,
    closed: bool,
}

impl PythonContext {
    pub fn validate_source(runtime: &PythonRuntime, source: &str) -> Result<(), PythonError> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(PythonError::SourceTooLarge);
        }
        let mut child = runtime
            .command()
            .args([
                "-c",
                "import ast,sys; ast.parse(sys.stdin.read(), '<elpis-python>', 'exec')",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(PythonError::Unavailable)?;
        child
            .stdin
            .take()
            .ok_or_else(|| PythonError::Io(io::Error::other("python stdin pipe is missing")))?
            .write_all(source.as_bytes())?;
        let output = child.wait_with_output()?;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(PythonError::Syntax(detail.chars().take(4096).collect()))
    }

    pub fn open(
        runtime: &PythonRuntime,
        context_id: String,
        generation: u64,
    ) -> Result<Self, PythonError> {
        validate_id("context_id", &context_id, 120).map_err(|_| PythonError::Binding)?;
        if generation == 0 {
            return Err(PythonError::Binding);
        }
        let mut child = runtime
            .command()
            .args(["-u", "-c", BOOTSTRAP])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(PythonError::Unavailable)?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| PythonError::Io(io::Error::other("python stdin pipe is missing")))?;
        let output =
            BufReader::new(child.stdout.take().ok_or_else(|| {
                PythonError::Io(io::Error::other("python stdout pipe is missing"))
            })?);
        Ok(Self {
            context_id,
            generation,
            child,
            input,
            output,
            seen_runs: HashSet::new(),
            closed: false,
        })
    }

    pub fn binding(&self) -> (&str, u64) {
        (&self.context_id, self.generation)
    }

    pub fn run(
        &mut self,
        context_id: &str,
        generation: u64,
        run_id: &str,
        source: &str,
        preview_max_bytes: usize,
    ) -> Result<RunResult, PythonError> {
        if self.closed || context_id != self.context_id || generation != self.generation {
            return Err(PythonError::Binding);
        }
        validate_id("run_id", run_id, 120).map_err(|_| PythonError::Binding)?;
        if source.len() > MAX_SOURCE_BYTES {
            return Err(PythonError::SourceTooLarge);
        }
        if !self.seen_runs.insert(run_id.to_string()) {
            return Err(PythonError::DuplicateRun);
        }
        self.write_frame(&ChildRun {
            op: "run",
            run_id,
            source,
            preview_max_bytes,
        })?;
        self.read_frame()
    }

    pub fn close(&mut self) -> Result<(), PythonError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let _ = self.write_frame(&ChildClose { op: "close" });
        let _ = self.read_frame::<RunResult>();
        match self.child.try_wait()? {
            Some(_) => Ok(()),
            None => {
                let _ = self.child.kill();
                let _ = self.child.wait();
                Ok(())
            }
        }
    }

    fn write_frame<T: Serialize>(&mut self, value: &T) -> Result<(), PythonError> {
        let frame = serde_json::to_vec(value)?;
        if frame.len() > MAX_FRAME_BYTES {
            return Err(PythonError::FrameTooLarge);
        }
        self.input.write_all(&frame)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        Ok(())
    }

    fn read_frame<T: for<'de> Deserialize<'de>>(&mut self) -> Result<T, PythonError> {
        let bytes = read_line_bounded(&mut self.output, MAX_FRAME_BYTES)?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

impl Drop for PythonContext {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn read_line_bounded<R: BufRead>(reader: &mut R, maximum: usize) -> Result<Vec<u8>, PythonError> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Err(PythonError::Eof);
        }
        if let Some(end) = available.iter().position(|byte| *byte == b'\n') {
            if output.len() + end > maximum {
                return Err(PythonError::FrameTooLarge);
            }
            output.extend_from_slice(&available[..end]);
            reader.consume(end + 1);
            return Ok(output);
        }
        if output.len() + available.len() > maximum {
            return Err(PythonError::FrameTooLarge);
        }
        let length = available.len();
        output.extend_from_slice(available);
        reader.consume(length);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> PythonRuntime {
        PythonRuntime::system("python3")
    }

    #[test]
    fn syntax_validation_executes_nothing() {
        assert!(PythonContext::validate_source(&runtime(), "x =").is_err());
    }

    #[test]
    fn state_and_trailing_values_persist() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let first = context.run("ctx-1", 1, "run-1", "x = 41", 1024).unwrap();
        assert!(first.ok);
        assert!(!first.has_value);
        let second = context.run("ctx-1", 1, "run-2", "x + 1", 1024).unwrap();
        assert_eq!(second.preview, "42");
        assert!(second.has_value);
        let none = context.run("ctx-1", 1, "run-3", "None", 1024).unwrap();
        assert_eq!(none.preview, "None");
        assert!(none.has_value);
        let no_value = context.run("ctx-1", 1, "run-4", "y = 7", 1024).unwrap();
        assert!(!no_value.has_value);
        let prior = context.run("ctx-1", 1, "run-5", "_", 1024).unwrap();
        assert_eq!(prior.preview, "None");
    }

    #[test]
    fn captures_stdout_without_corrupting_protocol() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let result = context
            .run("ctx-1", 1, "run-1", "print('hello')\n6 * 7", 1024)
            .unwrap();
        assert_eq!(result.stdout, "hello\n");
        assert_eq!(result.preview, "42");
    }

    #[test]
    fn rejects_stale_and_duplicate_runs() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 2).unwrap();
        assert!(matches!(
            context.run("ctx-1", 1, "run-1", "1", 1024),
            Err(PythonError::Binding)
        ));
        context.run("ctx-1", 2, "run-1", "1", 1024).unwrap();
        assert!(matches!(
            context.run("ctx-1", 2, "run-1", "1", 1024),
            Err(PythonError::DuplicateRun)
        ));
    }

    #[test]
    fn syntax_failure_does_not_mutate_context() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        context.run("ctx-1", 1, "run-1", "x = 9", 1024).unwrap();
        let failed = context.run("ctx-1", 1, "run-2", "x =", 1024).unwrap();
        assert!(!failed.ok);
        assert_eq!(failed.failure_kind.as_deref(), Some("preparse"));
        let value = context.run("ctx-1", 1, "run-3", "x", 1024).unwrap();
        assert_eq!(value.preview, "9");
    }

    #[test]
    fn runtime_failure_and_close_are_explicit() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let failed = context
            .run("ctx-1", 1, "run-1", "raise RuntimeError('nope')", 1024)
            .unwrap();
        assert!(!failed.ok);
        assert_eq!(failed.failure_kind.as_deref(), Some("runtime"));
        assert!(failed.error.unwrap().contains("RuntimeError: nope"));
        context.close().unwrap();
        context.close().unwrap();
    }

    #[test]
    fn preview_is_utf8_safe_and_original_stdout_cannot_poison_protocol() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        let result = context
            .run(
                "ctx-1",
                1,
                "run-1",
                "import sys\nsys.__stdout__.write('poison')\n'🐇' * 20",
                11,
            )
            .unwrap();
        assert!(result.ok);
        assert!(result.preview_truncated);
        assert!(result.preview.len() <= 11);
        assert!(!result.preview.contains('�'));
    }

    #[test]
    fn child_death_is_reported_without_replay() {
        let mut context = PythonContext::open(&runtime(), "ctx-1".into(), 1).unwrap();
        context.child.kill().unwrap();
        context.child.wait().unwrap();
        assert!(context.run("ctx-1", 1, "run-1", "40 + 2", 1024).is_err());
    }
}
