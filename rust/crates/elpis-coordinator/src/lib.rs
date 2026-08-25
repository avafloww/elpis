//! Bounded coordination for executor requests.

use elpis_protocol::{Request, Response};
use elpis_python::{PythonContext, PythonContextActor, PythonError, PythonRuntime};
use serde_json::json;
use std::collections::HashMap;
use thiserror::Error;

/// Absolute process-local limit accepted for `CoordinatorConfig::max_contexts`.
pub const HARD_MAX_CONTEXTS: usize = 1_024;
/// Absolute process-local limit accepted for `CoordinatorConfig::max_tombstones`.
pub const HARD_MAX_TOMBSTONES: usize = 65_536;
pub const DEFAULT_MAX_CONTEXTS: usize = 64;
pub const DEFAULT_MAX_TOMBSTONES: usize = 4_096;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum CoordinatorConfigError {
    #[error("max_contexts must be from 1 to {HARD_MAX_CONTEXTS}")]
    InvalidMaxContexts,
    #[error("max_tombstones must be from 1 to {HARD_MAX_TOMBSTONES}")]
    InvalidMaxTombstones,
}

/// Validated, hard-bounded coordinator resource limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CoordinatorConfig {
    max_contexts: usize,
    max_tombstones: usize,
}

impl CoordinatorConfig {
    pub fn new(max_contexts: usize, max_tombstones: usize) -> Result<Self, CoordinatorConfigError> {
        if !(1..=HARD_MAX_CONTEXTS).contains(&max_contexts) {
            return Err(CoordinatorConfigError::InvalidMaxContexts);
        }
        if !(1..=HARD_MAX_TOMBSTONES).contains(&max_tombstones) {
            return Err(CoordinatorConfigError::InvalidMaxTombstones);
        }
        Ok(Self {
            max_contexts,
            max_tombstones,
        })
    }

    pub fn max_contexts(&self) -> usize {
        self.max_contexts
    }

    pub fn max_tombstones(&self) -> usize {
        self.max_tombstones
    }
}

impl Default for CoordinatorConfig {
    fn default() -> Self {
        Self {
            max_contexts: DEFAULT_MAX_CONTEXTS,
            max_tombstones: DEFAULT_MAX_TOMBSTONES,
        }
    }
}

/// One response, or two responses whose order is part of the result.
#[derive(Debug, Clone, PartialEq)]
pub enum CompletionGroup {
    Single(Response),
    Pair([Response; 2]),
}

impl CompletionGroup {
    pub fn responses(&self) -> &[Response] {
        match self {
            Self::Single(response) => std::slice::from_ref(response),
            Self::Pair(responses) => responses,
        }
    }

    pub fn into_responses(self) -> Vec<Response> {
        match self {
            Self::Single(response) => vec![response],
            Self::Pair(responses) => Vec::from(responses),
        }
    }
}

/// Owns all Python context actors and the bounded coordination state.
pub struct Coordinator {
    runtime: PythonRuntime,
    config: CoordinatorConfig,
    contexts: HashMap<String, PythonContextActor>,
}

impl Coordinator {
    pub fn new(runtime: PythonRuntime, config: CoordinatorConfig) -> Self {
        Self {
            runtime,
            config,
            contexts: HashMap::with_capacity(config.max_contexts()),
        }
    }

    pub fn config(&self) -> CoordinatorConfig {
        self.config
    }

    pub fn context_count(&self) -> usize {
        self.contexts.len()
    }

    /// Submit one decoded request. `None` is reserved for accepted asynchronous work.
    pub fn submit(&mut self, request: Request) -> Option<CompletionGroup> {
        let request_id = request.request_id().to_owned();
        if let Err(error) = request.validate() {
            return single(Response::failure(
                Some(request_id),
                "protocol",
                "protocol",
                error.to_string(),
            ));
        }

        let response = match request {
            Request::Validate { source, .. } => self.validate(request_id, &source),
            Request::Open {
                context_id,
                generation,
                ..
            } => self.open(request_id, context_id, generation),
            Request::Close {
                context_id,
                generation,
                ..
            } => self.close(request_id, context_id, generation),
            Request::Run { .. } => Response::failure(
                Some(request_id),
                "failed",
                "unsupported",
                "run coordinator is not active",
            ),
            Request::Cancel { .. } => Response::failure(
                Some(request_id),
                "failed",
                "unsupported",
                "cancellation coordinator is not active",
            ),
        };
        single(response)
    }

    fn validate(&self, request_id: String, source: &str) -> Response {
        match PythonContext::validate_source(&self.runtime, source) {
            Ok(()) => Response::success(request_id, "validated", json!({})),
            Err(PythonError::Syntax(error)) => {
                Response::failure(Some(request_id), "failed", "preparse", error)
            }
            Err(error) => {
                Response::failure(Some(request_id), "failed", "runtime", error.to_string())
            }
        }
    }

    fn open(&mut self, request_id: String, context_id: String, generation: u64) -> Response {
        if self.contexts.contains_key(&context_id) {
            return Response::failure(
                Some(request_id),
                "failed",
                "conflict",
                "context is already open",
            );
        }
        if self.contexts.len() >= self.config.max_contexts() {
            return Response::failure(
                Some(request_id),
                "failed",
                "capacity",
                "context capacity is exhausted",
            );
        }

        match PythonContextActor::open(&self.runtime, context_id.clone(), generation) {
            Ok(actor) => {
                self.contexts.insert(context_id.clone(), actor);
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

    fn close(&mut self, request_id: String, context_id: String, generation: u64) -> Response {
        let Some(actor) = self.contexts.get(&context_id) else {
            return Response::success(request_id, "closed", json!({"already_closed": true}));
        };
        if actor.binding() != (context_id.as_str(), generation) {
            return Response::failure(
                Some(request_id),
                "failed",
                "binding",
                "context generation mismatch",
            );
        }

        let actor = self
            .contexts
            .remove(&context_id)
            .expect("the checked context remains present");
        match actor.close() {
            Ok(()) => Response::success(request_id, "closed", json!({"already_closed": false})),
            Err(error) => {
                Response::failure(Some(request_id), "failed", "runtime", error.to_string())
            }
        }
    }
}

impl Drop for Coordinator {
    fn drop(&mut self) {
        // ActorInner also has a defensive Drop implementation. Draining and
        // closing here makes coordinator teardown synchronous and deterministic.
        for (_, actor) in self.contexts.drain() {
            let _ = actor.close();
        }
    }
}

fn single(response: Response) -> Option<CompletionGroup> {
    Some(CompletionGroup::Single(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpis_protocol::{DEFAULT_PREVIEW_BYTES, PROTOCOL_VERSION};

    fn coordinator(max_contexts: usize) -> Coordinator {
        Coordinator::new(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(max_contexts, 3).unwrap(),
        )
    }

    fn only(group: Option<CompletionGroup>) -> Response {
        match group.expect("immediate request returned no response") {
            CompletionGroup::Single(response) => response,
            CompletionGroup::Pair(_) => panic!("immediate request returned a response pair"),
        }
    }

    fn open(context_id: &str, request_id: &str, generation: u64) -> Request {
        Request::Open {
            protocol: PROTOCOL_VERSION,
            request_id: request_id.into(),
            context_id: context_id.into(),
            generation,
        }
    }

    fn close(context_id: &str, request_id: &str, generation: u64) -> Request {
        Request::Close {
            protocol: PROTOCOL_VERSION,
            request_id: request_id.into(),
            context_id: context_id.into(),
            generation,
        }
    }

    #[test]
    fn config_enforces_both_hard_bounds() {
        assert_eq!(
            CoordinatorConfig::new(0, 1),
            Err(CoordinatorConfigError::InvalidMaxContexts)
        );
        assert_eq!(
            CoordinatorConfig::new(HARD_MAX_CONTEXTS + 1, 1),
            Err(CoordinatorConfigError::InvalidMaxContexts)
        );
        assert_eq!(
            CoordinatorConfig::new(1, 0),
            Err(CoordinatorConfigError::InvalidMaxTombstones)
        );
        assert_eq!(
            CoordinatorConfig::new(1, HARD_MAX_TOMBSTONES + 1),
            Err(CoordinatorConfigError::InvalidMaxTombstones)
        );
        let limits = CoordinatorConfig::new(HARD_MAX_CONTEXTS, HARD_MAX_TOMBSTONES).unwrap();
        assert_eq!(limits.max_contexts(), HARD_MAX_CONTEXTS);
        assert_eq!(limits.max_tombstones(), HARD_MAX_TOMBSTONES);
        assert!(CoordinatorConfig::default().max_contexts() <= HARD_MAX_CONTEXTS);
        assert!(CoordinatorConfig::default().max_tombstones() <= HARD_MAX_TOMBSTONES);
    }

    #[test]
    fn invalid_request_does_not_mutate_coordinator_state() {
        let mut coordinator = coordinator(1);
        let response = only(coordinator.submit(Request::Open {
            protocol: PROTOCOL_VERSION + 1,
            request_id: "open-invalid".into(),
            context_id: "context-1".into(),
            generation: 1,
        }));
        assert_eq!(response.kind, "protocol");
        assert_eq!(response.failure_kind.as_deref(), Some("protocol"));
        assert_eq!(coordinator.context_count(), 0);
    }

    #[test]
    fn failed_actor_open_does_not_consume_context_capacity() {
        let mut coordinator = Coordinator::new(
            PythonRuntime::system("/definitely/missing/elpis-python"),
            CoordinatorConfig::new(1, 1).unwrap(),
        );
        let response = only(coordinator.submit(open("context-1", "open-1", 1)));
        assert_eq!(response.failure_kind.as_deref(), Some("runtime"));
        assert_eq!(coordinator.context_count(), 0);
    }

    #[test]
    fn validate_preserves_immediate_response_semantics() {
        let mut coordinator = coordinator(1);
        let valid = only(coordinator.submit(Request::Validate {
            protocol: PROTOCOL_VERSION,
            request_id: "validate-1".into(),
            source: "answer = 40 + 2".into(),
        }));
        assert_eq!(
            valid,
            Response::success("validate-1".into(), "validated", json!({}))
        );

        let invalid = only(coordinator.submit(Request::Validate {
            protocol: PROTOCOL_VERSION,
            request_id: "validate-2".into(),
            source: "if:".into(),
        }));
        assert!(!invalid.ok);
        assert_eq!(invalid.kind, "failed");
        assert_eq!(invalid.failure_kind.as_deref(), Some("preparse"));
        assert_eq!(coordinator.context_count(), 0);
    }

    #[test]
    fn open_rejects_duplicates_before_capacity_and_bounds_contexts() {
        let mut coordinator = coordinator(1);
        let opened = only(coordinator.submit(open("context-1", "open-1", 7)));
        assert_eq!(opened.kind, "opened");
        assert_eq!(
            opened.result,
            Some(json!({"context_id": "context-1", "generation": 7}))
        );

        let duplicate = only(coordinator.submit(open("context-1", "open-2", 8)));
        assert_eq!(duplicate.failure_kind.as_deref(), Some("conflict"));
        assert_eq!(duplicate.error.as_deref(), Some("context is already open"));

        let capacity = only(coordinator.submit(open("context-2", "open-3", 1)));
        assert_eq!(capacity.failure_kind.as_deref(), Some("capacity"));
        assert_eq!(
            capacity.error.as_deref(),
            Some("context capacity is exhausted")
        );
        assert_eq!(coordinator.context_count(), 1);
    }

    #[test]
    fn close_is_generation_fenced_and_idempotent() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-1", "open-1", 7))).ok);

        let stale = only(coordinator.submit(close("context-1", "close-stale", 8)));
        assert_eq!(stale.failure_kind.as_deref(), Some("binding"));
        assert_eq!(stale.error.as_deref(), Some("context generation mismatch"));
        assert_eq!(coordinator.context_count(), 1);

        let closed = only(coordinator.submit(close("context-1", "close-1", 7)));
        assert_eq!(closed.kind, "closed");
        assert_eq!(closed.result, Some(json!({"already_closed": false})));
        assert_eq!(coordinator.context_count(), 0);

        let repeated = only(coordinator.submit(close("context-1", "close-2", 7)));
        assert_eq!(repeated.kind, "closed");
        assert_eq!(repeated.result, Some(json!({"already_closed": true})));
    }

    #[test]
    fn unsupported_run_and_cancel_have_no_effect() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);

        let run = only(coordinator.submit(Request::Run {
            protocol: PROTOCOL_VERSION,
            request_id: "request-1".into(),
            context_id: "context-1".into(),
            generation: 1,
            run_id: "run-1".into(),
            source: "raise SystemExit".into(),
            preview_max_bytes: DEFAULT_PREVIEW_BYTES,
        }));
        assert_eq!(run.failure_kind.as_deref(), Some("unsupported"));

        let cancel = only(coordinator.submit(Request::Cancel {
            protocol: PROTOCOL_VERSION,
            request_id: "cancel-1".into(),
            context_id: "context-1".into(),
            generation: 1,
            target_request_id: "request-1".into(),
            run_id: "run-1".into(),
        }));
        assert_eq!(cancel.failure_kind.as_deref(), Some("unsupported"));
        assert_eq!(coordinator.context_count(), 1);
    }

    #[test]
    fn completion_group_preserves_pair_order() {
        let first = Response::success("request-1".into(), "first", json!({}));
        let second = Response::success("request-2".into(), "second", json!({}));
        let group = CompletionGroup::Pair([first, second]);
        assert_eq!(group.responses()[0].kind, "first");
        assert_eq!(group.responses()[1].kind, "second");
        let responses = group.into_responses();
        assert_eq!(responses[0].kind, "first");
        assert_eq!(responses[1].kind, "second");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dropping_coordinator_reaps_its_context_actors() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "elpis-coordinator-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let pid_file = directory.join("python.pid");
        let wrapper = directory.join("python-wrapper");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec python3 \"$@\"\n",
                pid_file.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&wrapper).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&wrapper, permissions).unwrap();

        let mut coordinator = Coordinator::new(
            PythonRuntime::system(&wrapper),
            CoordinatorConfig::new(1, 1).unwrap(),
        );
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        let deadline = Instant::now() + Duration::from_secs(5);
        let pid = loop {
            match std::fs::read_to_string(&pid_file) {
                Ok(pid) if !pid.trim().is_empty() => break pid,
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("PID witness failed: {error}"),
            }
            assert!(Instant::now() < deadline, "PID witness timed out");
            std::thread::yield_now();
        };
        let process_path = std::path::PathBuf::from(format!("/proc/{}", pid.trim()));
        assert!(process_path.exists());
        drop(coordinator);
        assert!(!process_path.exists(), "Python actor child was not reaped");
        let _ = std::fs::remove_dir_all(directory);
    }
}
