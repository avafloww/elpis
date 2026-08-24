#[cfg(all(not(feature = "embedded-python"), not(debug_assertions)))]
compile_error!("release builds require the embedded-python feature");

use elpis_protocol::{MAX_FRAME_BYTES, Request, Response};
use elpis_python::{PythonContext, PythonError, PythonRuntime};
use serde_json::json;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
#[cfg(feature = "embedded-python")]
use std::path::PathBuf;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

#[cfg(feature = "embedded-python")]
include!(concat!(env!("OUT_DIR"), "/python_bundle.rs"));

struct ExecutorRuntime {
    python: PythonRuntime,
    #[cfg(feature = "embedded-python")]
    _generation: elpis_runtime::RuntimeHandle,
}

#[cfg(not(feature = "embedded-python"))]
fn load_runtime() -> Result<ExecutorRuntime, String> {
    Ok(ExecutorRuntime {
        python: PythonRuntime::system("python3"),
    })
}

#[cfg(feature = "embedded-python")]
fn load_runtime() -> Result<ExecutorRuntime, String> {
    let state = std::env::var_os("ELPIS_EXECUTOR_STATE_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| "ELPIS_EXECUTOR_STATE_DIR is required".to_string())?;
    let payload = elpis_runtime::RuntimePayload::new(PYTHON_ARCHIVE, PYTHON_MANIFEST)
        .map_err(|error| error.to_string())?;
    let generation = payload
        .ensure(&state.join("python-runtime"))
        .map_err(|error| error.to_string())?;
    if generation.payload_sha256 != PYTHON_ARCHIVE_SHA256 {
        return Err("embedded runtime generation hash mismatch".into());
    }
    let executable = generation
        .open_verified_executable()
        .map_err(|error| error.to_string())?;
    let python = PythonRuntime::isolated_verified(executable);
    Ok(ExecutorRuntime {
        python,
        _generation: generation,
    })
}

fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("elpis_executor=info,elpis_python=info,elpis_runtime=info")
    });
    tracing_subscriber::fmt()
        .json()
        .with_ansi(false)
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .init();
}

fn main() {
    init_logging();
    info!(
        embedded_python = cfg!(feature = "embedded-python"),
        "executor starting"
    );
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut stdout = io::stdout().lock();
    let runtime = match load_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            error!(error = %error, "runtime startup failed");
            std::process::exit(1);
        }
    };
    #[cfg(feature = "embedded-python")]
    info!(
        archive_sha256 = PYTHON_ARCHIVE_SHA256,
        manifest_sha256 = PYTHON_MANIFEST_SHA256,
        "executor runtime ready"
    );
    #[cfg(not(feature = "embedded-python"))]
    info!("executor runtime ready");
    let mut contexts: HashMap<String, PythonContext> = HashMap::new();
    loop {
        let frame = match read_request_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) => {
                warn!(error = %error, "protocol transport failed");
                let response = Response::failure(None, "protocol", "transport", error.to_string());
                write_response(&mut stdout, &response);
                break;
            }
        };
        let response = match std::str::from_utf8(&frame) {
            Ok(line) => handle(line, &mut contexts, &runtime.python),
            Err(error) => Response::failure(None, "protocol", "protocol", error.to_string()),
        };
        write_response(&mut stdout, &response);
    }
    let open_contexts = contexts.len();
    for context in contexts.values_mut() {
        let _ = context.close();
    }
    info!(open_contexts, "executor stopped");
}

fn read_request_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Ok(Some(output))
            };
        }
        if let Some(end) = available.iter().position(|byte| *byte == b'\n') {
            if output.len() + end > MAX_FRAME_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "request frame is too large",
                ));
            }
            output.extend_from_slice(&available[..end]);
            reader.consume(end + 1);
            return Ok(Some(output));
        }
        if output.len() + available.len() > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request frame is too large",
            ));
        }
        let length = available.len();
        output.extend_from_slice(available);
        reader.consume(length);
    }
}

fn handle(
    line: &str,
    contexts: &mut HashMap<String, PythonContext>,
    runtime: &PythonRuntime,
) -> Response {
    let request = match serde_json::from_str::<Request>(line) {
        Ok(request) => request,
        Err(error) => return Response::failure(None, "protocol", "protocol", error.to_string()),
    };
    let request_id = request.request_id().to_string();
    if let Err(error) = request.validate() {
        return Response::failure(Some(request_id), "protocol", "protocol", error.to_string());
    }
    match request {
        Request::Validate { source, .. } => {
            match PythonContext::validate_source(runtime, &source) {
                Ok(()) => Response::success(request_id, "validated", json!({})),
                Err(PythonError::Syntax(error)) => {
                    Response::failure(Some(request_id), "failed", "preparse", error)
                }
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
        Request::Open {
            context_id,
            generation,
            ..
        } => {
            if contexts.contains_key(&context_id) {
                return Response::failure(
                    Some(request_id),
                    "failed",
                    "conflict",
                    "context is already open",
                );
            }
            match PythonContext::open(runtime, context_id.clone(), generation) {
                Ok(context) => {
                    contexts.insert(context_id.clone(), context);
                    Response::success(
                        request_id,
                        "opened",
                        json!({"context_id": context_id, "generation": generation}),
                    )
                }
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
        Request::Run {
            context_id,
            generation,
            run_id,
            source,
            preview_max_bytes,
            ..
        } => {
            let Some(context) = contexts.get_mut(&context_id) else {
                return Response::failure(
                    Some(request_id),
                    "failed",
                    "not_found",
                    "context is not open",
                );
            };
            match context.run(&context_id, generation, &run_id, &source, preview_max_bytes) {
                Ok(result) if result.ok => match serde_json::to_value(result) {
                    Ok(value) => Response::success(request_id, "completed", value),
                    Err(error) => Response::failure(
                        Some(request_id),
                        "failed",
                        "serialization",
                        error.to_string(),
                    ),
                },
                Ok(result) => Response::failure(
                    Some(request_id),
                    result.kind,
                    result.failure_kind.unwrap_or_else(|| "runtime".into()),
                    result.error.unwrap_or_else(|| "python run failed".into()),
                ),
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
        Request::Close {
            context_id,
            generation,
            ..
        } => {
            let Some(mut context) = contexts.remove(&context_id) else {
                return Response::success(request_id, "closed", json!({"already_closed": true}));
            };
            if context.binding() != (context_id.as_str(), generation) {
                contexts.insert(context_id, context);
                return Response::failure(
                    Some(request_id),
                    "failed",
                    "binding",
                    "context generation mismatch",
                );
            }
            match context.close() {
                Ok(()) => Response::success(request_id, "closed", json!({"already_closed": false})),
                Err(error) => {
                    Response::failure(Some(request_id), "failed", "runtime", error.to_string())
                }
            }
        }
    }
}

fn write_response(output: &mut impl Write, response: &Response) {
    let Ok(mut bytes) = serde_json::to_vec(response) else {
        return;
    };
    bytes.push(b'\n');
    let _ = output.write_all(&bytes);
    let _ = output.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpis_protocol::PROTOCOL_VERSION;

    fn request(
        value: serde_json::Value,
        contexts: &mut HashMap<String, PythonContext>,
    ) -> Response {
        handle(
            &value.to_string(),
            contexts,
            &PythonRuntime::system("python3"),
        )
    }

    #[test]
    fn opens_runs_and_closes_persistent_context() {
        let mut contexts = HashMap::new();
        let opened = request(
            json!({"op":"open","protocol":PROTOCOL_VERSION,"request_id":"r1","context_id":"c1","generation":1}),
            &mut contexts,
        );
        assert!(opened.ok);
        let assigned = request(
            json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"r2","context_id":"c1","generation":1,"run_id":"run-1","source":"x = 21"}),
            &mut contexts,
        );
        assert!(assigned.ok);
        let value = request(
            json!({"op":"run","protocol":PROTOCOL_VERSION,"request_id":"r3","context_id":"c1","generation":1,"run_id":"run-2","source":"x * 2"}),
            &mut contexts,
        );
        assert_eq!(value.result.unwrap()["preview"], "42");
        let closed = request(
            json!({"op":"close","protocol":PROTOCOL_VERSION,"request_id":"r4","context_id":"c1","generation":1}),
            &mut contexts,
        );
        assert!(closed.ok);
    }

    #[test]
    fn rejects_unknown_fields_before_effect() {
        let mut contexts = HashMap::new();
        let response = handle(
            r#"{"op":"open","protocol":1,"request_id":"r1","context_id":"c1","generation":1,"unexpected":true}"#,
            &mut contexts,
            &PythonRuntime::system("python3"),
        );
        assert!(!response.ok);
        assert!(contexts.is_empty());
    }

    #[test]
    fn frame_reader_rejects_oversized_input_without_unbounded_growth() {
        let bytes = vec![b'x'; MAX_FRAME_BYTES + 1];
        let mut reader = std::io::BufReader::new(bytes.as_slice());
        let error = read_request_frame(&mut reader).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
