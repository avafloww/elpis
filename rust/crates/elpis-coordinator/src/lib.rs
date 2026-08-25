//! Bounded coordination for executor requests.

use elpis_protocol::{Request, Response};
use elpis_python::{
    CancelOutcome, HostCallService, PythonContext, PythonContextActor, PythonError,
    PythonRunHandle, PythonRuntime, RejectHostCalls, RunResult,
};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
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
    Single(Box<Response>),
    Pair(Box<[Response; 2]>),
}

impl CompletionGroup {
    pub fn responses(&self) -> &[Response] {
        match self {
            Self::Single(response) => std::slice::from_ref(response.as_ref()),
            Self::Pair(responses) => responses.as_ref(),
        }
    }

    pub fn into_responses(self) -> Vec<Response> {
        match self {
            Self::Single(response) => vec![*response],
            Self::Pair(responses) => Vec::from(*responses),
        }
    }
}

/// Validated identity of one Run presented to its host-service factory.
///
/// The coordinator constructs this only after protocol validation and after
/// duplicate, context-binding, and busy checks have passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunBinding {
    request_id: String,
    context_id: String,
    generation: u64,
    run_id: String,
}

impl RunBinding {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn context_id(&self) -> &str {
        &self.context_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }
}

/// Bounded failure returned when a per-Run host service cannot be built.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
#[error("host service factory failed")]
pub struct HostServiceFactoryError;

/// Process-local factory for a host service bound to exactly one validated Run.
pub trait HostServiceFactory: Send {
    fn build(
        &mut self,
        binding: &RunBinding,
    ) -> Result<Box<dyn HostCallService>, HostServiceFactoryError>;
}

impl<F> HostServiceFactory for F
where
    F: FnMut(&RunBinding) -> Result<Box<dyn HostCallService>, HostServiceFactoryError> + Send,
{
    fn build(
        &mut self,
        binding: &RunBinding,
    ) -> Result<Box<dyn HostCallService>, HostServiceFactoryError> {
        self(binding)
    }
}

struct ActiveRun {
    binding: RunBinding,
    handle: PythonRunHandle,
    pending_cancel: Option<PendingCancel>,
}

struct PendingCancel {
    request_id: String,
    mode: PendingCancelMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingCancelMode {
    Owned {
        started: bool,
        context_invalidated: bool,
    },
    CompletionWon,
}

struct Tombstones {
    capacity: usize,
    order: VecDeque<String>,
    entries: HashMap<String, RunBinding>,
}

impl Tombstones {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::with_capacity(capacity),
            entries: HashMap::with_capacity(capacity),
        }
    }

    fn insert(&mut self, binding: RunBinding) {
        if self.entries.contains_key(&binding.request_id) {
            self.entries.insert(binding.request_id.clone(), binding);
            return;
        }
        if self.entries.len() == self.capacity {
            let oldest = self
                .order
                .pop_front()
                .expect("full tombstones have an oldest key");
            self.entries
                .remove(&oldest)
                .expect("tombstone order and entries stay synchronized");
        }
        self.order.push_back(binding.request_id.clone());
        self.entries.insert(binding.request_id.clone(), binding);
    }

    fn get(&self, request_id: &str) -> Option<&RunBinding> {
        self.entries.get(request_id)
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Owns all Python context actors and the bounded coordination state.
pub struct Coordinator {
    runtime: PythonRuntime,
    config: CoordinatorConfig,
    contexts: HashMap<String, PythonContextActor>,
    active: HashMap<String, ActiveRun>,
    active_by_context: HashMap<String, String>,
    active_order: VecDeque<String>,
    tombstones: Tombstones,
    host_service_factory: Box<dyn HostServiceFactory>,
}

impl Coordinator {
    /// Construct a coordinator whose Runs reject every host call.
    pub fn new(runtime: PythonRuntime, config: CoordinatorConfig) -> Self {
        Self::with_host_service_factory(runtime, config, |_binding: &RunBinding| {
            Ok(Box::new(RejectHostCalls) as Box<dyn HostCallService>)
        })
    }

    /// Construct a coordinator with a process-local per-Run host-service factory.
    ///
    /// The factory is invoked only after the Run request and its context binding
    /// have passed the coordinator's admission checks. A factory error produces
    /// a fixed, bounded failure and does not schedule or record the Run.
    pub fn with_host_service_factory<F>(
        runtime: PythonRuntime,
        config: CoordinatorConfig,
        factory: F,
    ) -> Self
    where
        F: HostServiceFactory + 'static,
    {
        Self {
            runtime,
            config,
            contexts: HashMap::with_capacity(config.max_contexts()),
            active: HashMap::with_capacity(config.max_contexts()),
            active_by_context: HashMap::with_capacity(config.max_contexts()),
            active_order: VecDeque::with_capacity(config.max_contexts()),
            tombstones: Tombstones::new(config.max_tombstones()),
            host_service_factory: Box::new(factory),
        }
    }

    pub fn config(&self) -> CoordinatorConfig {
        self.config
    }

    pub fn context_count(&self) -> usize {
        self.contexts.len()
    }

    pub fn active_run_count(&self) -> usize {
        self.active.len()
    }

    pub fn close_all(&mut self) -> usize {
        let context_count = self.contexts.len();
        self.active.clear();
        self.active_by_context.clear();
        self.active_order.clear();
        for (_, actor) in self.contexts.drain() {
            let _ = actor.close();
        }
        context_count
    }

    pub fn tombstone_count(&self) -> usize {
        self.tombstones.len()
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
            Request::Run {
                context_id,
                generation,
                run_id,
                source,
                preview_max_bytes,
                ..
            } => {
                return self.run(
                    request_id,
                    context_id,
                    generation,
                    run_id,
                    source,
                    preview_max_bytes,
                );
            }
            Request::Cancel {
                context_id,
                generation,
                target_request_id,
                run_id,
                ..
            } => {
                return self.cancel(
                    request_id,
                    context_id,
                    generation,
                    target_request_id,
                    run_id,
                );
            }
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

    fn run(
        &mut self,
        request_id: String,
        context_id: String,
        generation: u64,
        run_id: String,
        source: String,
        preview_max_bytes: usize,
    ) -> Option<CompletionGroup> {
        self.schedule_run(
            request_id,
            context_id,
            generation,
            run_id,
            source,
            preview_max_bytes,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn schedule_run(
        &mut self,
        request_id: String,
        context_id: String,
        generation: u64,
        run_id: String,
        source: String,
        preview_max_bytes: usize,
        release: bool,
    ) -> Option<CompletionGroup> {
        if let Some(active) = self.active.get(&request_id) {
            let exact = active.binding.context_id == context_id
                && active.binding.generation == generation
                && active.binding.run_id == run_id;
            return single(Response::failure(
                Some(request_id),
                "failed",
                "conflict",
                if exact {
                    "run request is already active"
                } else {
                    "run request_id was already used"
                },
            ));
        }
        if let Some(terminal) = self.tombstones.get(&request_id) {
            let exact = terminal.context_id == context_id
                && terminal.generation == generation
                && terminal.run_id == run_id;
            return single(Response::failure(
                Some(request_id),
                "failed",
                "conflict",
                if exact {
                    "run request already completed"
                } else {
                    "run request_id was already used"
                },
            ));
        }
        let Some(actor) = self.contexts.get(&context_id) else {
            return single(Response::failure(
                Some(request_id),
                "failed",
                "not_found",
                "context is not open",
            ));
        };
        if actor.binding() != (context_id.as_str(), generation) {
            return single(Response::failure(
                Some(request_id),
                "failed",
                "binding",
                "context generation mismatch",
            ));
        }
        if self.active_by_context.contains_key(&context_id) {
            return single(Response::failure(
                Some(request_id),
                "failed",
                "busy",
                "context already has an active run",
            ));
        }

        let binding = RunBinding {
            request_id: request_id.clone(),
            context_id: context_id.clone(),
            generation,
            run_id: run_id.clone(),
        };
        let service = match self.host_service_factory.build(&binding) {
            Ok(service) => service,
            Err(_) => {
                return single(Response::failure(
                    Some(request_id),
                    "failed",
                    "runtime",
                    "host service factory failed",
                ));
            }
        };
        let scheduled = actor.schedule_deferred_with_host_service(
            &context_id,
            generation,
            &run_id,
            &source,
            preview_max_bytes,
            service,
        );
        let handle = match scheduled {
            Ok(handle) => handle,
            Err(error) => {
                let invalid = !actor.is_valid();
                if invalid {
                    self.remove_context(&context_id);
                }
                return single(run_schedule_failure(request_id, error));
            }
        };
        let control = handle.control();
        self.active_by_context
            .insert(context_id, request_id.clone());
        self.active_order.push_back(request_id.clone());
        self.active.insert(
            request_id,
            ActiveRun {
                binding,
                handle,
                pending_cancel: None,
            },
        );
        if release {
            let _ = control.start();
        }
        None
    }

    fn cancel(
        &mut self,
        request_id: String,
        context_id: String,
        generation: u64,
        target_request_id: String,
        run_id: String,
    ) -> Option<CompletionGroup> {
        if let Some(active) = self.active.get(&target_request_id) {
            if active.binding.context_id != context_id
                || active.binding.generation != generation
                || active.binding.run_id != run_id
            {
                return single(Response::failure(
                    Some(request_id),
                    "failed",
                    "binding",
                    "cancel target binding mismatch",
                ));
            }
            if active.pending_cancel.is_some() {
                return single(Response::failure(
                    Some(request_id),
                    "failed",
                    "already_requested",
                    "cancellation was already requested",
                ));
            }
        } else if let Some(terminal) = self.tombstones.get(&target_request_id) {
            if terminal.context_id != context_id
                || terminal.generation != generation
                || terminal.run_id != run_id
            {
                return single(Response::failure(
                    Some(request_id),
                    "failed",
                    "binding",
                    "cancel target binding mismatch",
                ));
            }
            return single(cancel_already_terminal(request_id, target_request_id));
        } else {
            return single(Response::failure(
                Some(request_id),
                "failed",
                "not_found",
                "cancel target was not found",
            ));
        }

        let terminal = self
            .active
            .get(&target_request_id)
            .expect("the checked active target remains present")
            .handle
            .try_wait();
        let terminal = match terminal {
            Ok(Some(result)) => Some(Ok(result)),
            Err(error) => Some(Err(error)),
            Ok(None) => None,
        };
        if let Some(terminal) = terminal {
            self.active
                .get_mut(&target_request_id)
                .expect("the completion-winning target remains active")
                .pending_cancel = Some(PendingCancel {
                request_id,
                mode: PendingCancelMode::CompletionWon,
            });
            return Some(self.finish_active(&target_request_id, terminal));
        }

        let outcome = self
            .active
            .get(&target_request_id)
            .expect("the probed active target remains present")
            .handle
            .cancel();
        let mode = match outcome {
            Ok(CancelOutcome::RequestedBeforeStart) => PendingCancelMode::Owned {
                started: false,
                context_invalidated: false,
            },
            Ok(CancelOutcome::RequestedWhileExecuting) => PendingCancelMode::Owned {
                started: true,
                context_invalidated: true,
            },
            Ok(CancelOutcome::AlreadyRequested) => {
                return single(Response::failure(
                    Some(request_id),
                    "failed",
                    "already_requested",
                    "cancellation was already requested",
                ));
            }
            Ok(CancelOutcome::Terminal) => PendingCancelMode::CompletionWon,
            Err(error) => {
                return single(Response::failure(
                    Some(request_id),
                    "failed",
                    "runtime",
                    error.to_string(),
                ));
            }
        };
        self.active
            .get_mut(&target_request_id)
            .expect("the cancelled active target remains present")
            .pending_cancel = Some(PendingCancel { request_id, mode });
        None
    }

    /// Poll each currently active run at most once in fair FIFO order.
    pub fn poll(&mut self) -> Vec<CompletionGroup> {
        let mut completions = Vec::new();
        let pending = self.active_order.len();
        for _ in 0..pending {
            let request_id = self
                .active_order
                .pop_front()
                .expect("active order length was captured");
            let outcome = self
                .active
                .get(&request_id)
                .expect("active order and map stay synchronized")
                .handle
                .try_wait();
            match outcome {
                Ok(None) => self.active_order.push_back(request_id),
                Ok(Some(result)) => {
                    completions.push(self.finish_active(&request_id, Ok(result)));
                }
                Err(error) => {
                    completions.push(self.finish_active(&request_id, Err(error)));
                }
            }
        }
        completions
    }

    fn finish_active(
        &mut self,
        target_request_id: &str,
        terminal: Result<RunResult, PythonError>,
    ) -> CompletionGroup {
        let active = self
            .active
            .remove(target_request_id)
            .expect("terminal target remains active until finalization");
        self.active_order
            .retain(|request_id| request_id != target_request_id);
        if self.active_by_context.get(&active.binding.context_id)
            == Some(&active.binding.request_id)
        {
            self.active_by_context.remove(&active.binding.context_id);
        }
        let group = terminal_completion(&active.binding, active.pending_cancel, terminal);
        if self
            .contexts
            .get(&active.binding.context_id)
            .is_some_and(|actor| !actor.is_valid())
        {
            self.remove_context(&active.binding.context_id);
        }
        self.tombstones.insert(active.binding);
        group
    }

    fn remove_context(&mut self, context_id: &str) {
        if let Some(actor) = self.contexts.remove(context_id) {
            let _ = actor.close();
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
        if self.active_by_context.contains_key(&context_id) {
            return Response::failure(
                Some(request_id),
                "failed",
                "busy",
                "context has an active run",
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
        self.close_all();
    }
}

fn single(response: Response) -> Option<CompletionGroup> {
    Some(CompletionGroup::Single(Box::new(response)))
}

fn terminal_completion(
    binding: &RunBinding,
    pending_cancel: Option<PendingCancel>,
    terminal: Result<RunResult, PythonError>,
) -> CompletionGroup {
    let Some(pending) = pending_cancel else {
        return CompletionGroup::Single(Box::new(run_terminal_response(
            binding.request_id.clone(),
            terminal,
        )));
    };
    match pending.mode {
        PendingCancelMode::CompletionWon => CompletionGroup::Pair(Box::new([
            run_terminal_response(binding.request_id.clone(), terminal),
            cancel_already_terminal(pending.request_id, binding.request_id.clone()),
        ])),
        PendingCancelMode::Owned {
            started,
            context_invalidated,
        } if matches!(&terminal, Err(PythonError::Cancelled)) => CompletionGroup::Pair(Box::new([
            cancelled_run_response(binding.request_id.clone(), started, context_invalidated),
            cancel_success(
                pending.request_id,
                binding.request_id.clone(),
                started,
                context_invalidated,
            ),
        ])),
        PendingCancelMode::Owned { .. } => CompletionGroup::Pair(Box::new([
            run_terminal_response(binding.request_id.clone(), terminal),
            Response::failure(
                Some(pending.request_id),
                "failed",
                "state_mismatch",
                "run reached an unexpected terminal state after cancellation",
            ),
        ])),
    }
}

fn run_terminal_response(request_id: String, terminal: Result<RunResult, PythonError>) -> Response {
    match terminal {
        Ok(result) => run_result_response(request_id, result),
        Err(error) => Response::failure(Some(request_id), "failed", "runtime", error.to_string()),
    }
}

fn cancelled_run_response(
    request_id: String,
    started: bool,
    context_invalidated: bool,
) -> Response {
    let mut response = Response::failure(
        Some(request_id),
        "failed",
        "cancelled",
        "python run was cancelled",
    );
    response.result = Some(json!({
        "started": started,
        "context_invalidated": context_invalidated,
    }));
    response
}

fn cancel_success(
    request_id: String,
    target_request_id: String,
    started: bool,
    context_invalidated: bool,
) -> Response {
    Response::success(
        request_id,
        "cancelled",
        json!({
            "target_request_id": target_request_id,
            "already_terminal": false,
            "started": started,
            "context_invalidated": context_invalidated,
        }),
    )
}

fn cancel_already_terminal(request_id: String, target_request_id: String) -> Response {
    Response::success(
        request_id,
        "cancelled",
        json!({
            "target_request_id": target_request_id,
            "already_terminal": true,
        }),
    )
}

fn run_schedule_failure(request_id: String, error: PythonError) -> Response {
    let (failure_kind, message) = match error {
        PythonError::Binding => ("binding", "context generation mismatch".into()),
        PythonError::Busy => ("busy", "context already has an active run".into()),
        PythonError::DuplicateRun => ("conflict", "run_id was already used in this context".into()),
        error => ("runtime", error.to_string()),
    };
    Response::failure(Some(request_id), "failed", failure_kind, message)
}

fn run_result_response(request_id: String, result: RunResult) -> Response {
    if result.ok {
        return match serde_json::to_value(result) {
            Ok(value) => Response::success(request_id, "completed", value),
            Err(error) => Response::failure(
                Some(request_id),
                "failed",
                "serialization",
                error.to_string(),
            ),
        };
    }
    Response::failure(
        Some(request_id),
        result.kind,
        result.failure_kind.unwrap_or_else(|| "runtime".into()),
        result.error.unwrap_or_else(|| "python run failed".into()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use elpis_protocol::{DEFAULT_PREVIEW_BYTES, PROTOCOL_VERSION};
    use elpis_python::{HostCall, HostResult};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    struct CountingHostService {
        calls: Arc<AtomicUsize>,
        result: &'static str,
    }

    impl HostCallService for CountingHostService {
        fn call(&mut self, _call: &HostCall) -> HostResult {
            self.calls.fetch_add(1, Ordering::SeqCst);
            HostResult::accepted(self.result)
        }
    }

    fn coordinator(max_contexts: usize) -> Coordinator {
        Coordinator::new(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(max_contexts, 3).unwrap(),
        )
    }

    fn only(group: Option<CompletionGroup>) -> Response {
        match group.expect("immediate request returned no response") {
            CompletionGroup::Single(response) => *response,
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

    fn run_request(
        context_id: &str,
        request_id: &str,
        generation: u64,
        run_id: &str,
        source: impl Into<String>,
    ) -> Request {
        Request::Run {
            protocol: PROTOCOL_VERSION,
            request_id: request_id.into(),
            context_id: context_id.into(),
            generation,
            run_id: run_id.into(),
            source: source.into(),
            preview_max_bytes: DEFAULT_PREVIEW_BYTES,
        }
    }

    fn cancel_request(
        request_id: &str,
        context_id: &str,
        generation: u64,
        target_request_id: &str,
        run_id: &str,
    ) -> Request {
        Request::Cancel {
            protocol: PROTOCOL_VERSION,
            request_id: request_id.into(),
            context_id: context_id.into(),
            generation,
            target_request_id: target_request_id.into(),
            run_id: run_id.into(),
        }
    }

    fn wait_for(coordinator: &mut Coordinator, count: usize) -> Vec<Response> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut responses = Vec::new();
        while responses.len() < count {
            responses.extend(
                coordinator
                    .poll()
                    .into_iter()
                    .flat_map(CompletionGroup::into_responses),
            );
            if responses.len() < count {
                assert!(Instant::now() < deadline, "coordinator poll timed out");
                std::thread::yield_now();
            }
        }
        responses
    }

    fn wait_group(coordinator: &mut Coordinator) -> CompletionGroup {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut groups = coordinator.poll();
            if !groups.is_empty() {
                assert_eq!(groups.len(), 1);
                return groups.remove(0);
            }
            assert!(
                Instant::now() < deadline,
                "coordinator group poll timed out"
            );
            std::thread::yield_now();
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
    fn close_all_cancels_active_work_reaps_contexts_and_is_idempotent() {
        let mut coordinator = coordinator(2);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(only(coordinator.submit(open("context-2", "open-2", 1))).ok);
        assert!(
            coordinator
                .submit(run_request(
                    "context-1",
                    "run-1",
                    1,
                    "run-a",
                    "import time; time.sleep(30)",
                ))
                .is_none()
        );
        assert_eq!(coordinator.context_count(), 2);
        assert_eq!(coordinator.active_run_count(), 1);
        assert_eq!(coordinator.close_all(), 2);
        assert_eq!(coordinator.context_count(), 0);
        assert_eq!(coordinator.active_run_count(), 0);
        assert!(coordinator.poll().is_empty());
        assert_eq!(coordinator.close_all(), 0);
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
    fn executing_cancel_pairs_run_then_first_owner_and_invalidates_context() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(
            coordinator
                .submit(run_request(
                    "context-1",
                    "request-1",
                    1,
                    "run-1",
                    "import time\nwhile True: time.sleep(1)",
                ))
                .is_none()
        );
        let control = coordinator
            .active
            .get("request-1")
            .unwrap()
            .handle
            .control();
        let state = control.state();
        if state == elpis_python::RunState::Scheduled {
            assert_eq!(
                control.wait_for_change(state),
                elpis_python::RunState::Executing
            );
        } else {
            assert_eq!(state, elpis_python::RunState::Executing);
        }

        assert!(
            coordinator
                .submit(cancel_request(
                    "cancel-1",
                    "context-1",
                    1,
                    "request-1",
                    "run-1",
                ))
                .is_none()
        );
        let stale = only(coordinator.submit(cancel_request(
            "cancel-stale",
            "context-1",
            2,
            "request-1",
            "run-1",
        )));
        assert_eq!(stale.failure_kind.as_deref(), Some("binding"));
        let later = only(coordinator.submit(cancel_request(
            "cancel-2",
            "context-1",
            1,
            "request-1",
            "run-1",
        )));
        assert_eq!(later.failure_kind.as_deref(), Some("already_requested"));

        let responses = wait_for(&mut coordinator, 2);
        assert_eq!(responses[0].request_id.as_deref(), Some("request-1"));
        assert_eq!(responses[0].failure_kind.as_deref(), Some("cancelled"));
        assert_eq!(
            responses[0].result,
            Some(json!({"started": true, "context_invalidated": true}))
        );
        assert_eq!(responses[1].request_id.as_deref(), Some("cancel-1"));
        assert!(responses[1].ok);
        assert_eq!(
            responses[1].result,
            Some(json!({
                "target_request_id": "request-1",
                "already_terminal": false,
                "started": true,
                "context_invalidated": true,
            }))
        );
        assert_eq!(coordinator.active_run_count(), 0);
        assert_eq!(coordinator.context_count(), 0);
        assert_eq!(coordinator.tombstone_count(), 1);
    }

    #[test]
    fn prestart_cancel_proves_source_nonexecution_and_preserves_context() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let marker = std::env::temp_dir().join(format!(
            "elpis-coordinator-cancel-marker-{}-{unique}",
            std::process::id()
        ));
        let marker_literal = serde_json::to_string(marker.to_str().unwrap()).unwrap();
        assert!(
            coordinator
                .schedule_run(
                    "request-1".into(),
                    "context-1".into(),
                    1,
                    "run-1".into(),
                    format!("open({marker_literal}, 'w').write('executed')"),
                    DEFAULT_PREVIEW_BYTES,
                    false,
                )
                .is_none()
        );
        assert_eq!(
            coordinator.active.get("request-1").unwrap().handle.state(),
            elpis_python::RunState::Scheduled
        );
        assert!(
            coordinator
                .submit(cancel_request(
                    "cancel-1",
                    "context-1",
                    1,
                    "request-1",
                    "run-1",
                ))
                .is_none()
        );
        let responses = wait_for(&mut coordinator, 2);
        assert_eq!(responses[0].failure_kind.as_deref(), Some("cancelled"));
        assert_eq!(
            responses[0].result,
            Some(json!({"started": false, "context_invalidated": false}))
        );
        assert_eq!(
            responses[1].result,
            Some(json!({
                "target_request_id": "request-1",
                "already_terminal": false,
                "started": false,
                "context_invalidated": false,
            }))
        );
        assert!(!marker.exists());
        assert_eq!(coordinator.context_count(), 1);
        assert!(
            coordinator
                .submit(run_request("context-1", "request-2", 1, "run-2", "2"))
                .is_none()
        );
        assert!(wait_for(&mut coordinator, 1)[0].ok);
        assert!(!marker.exists());
    }

    #[test]
    fn cancel_lookup_distinguishes_missing_binding_and_terminal_target() {
        let mut coordinator = coordinator(1);
        let missing = only(coordinator.submit(cancel_request(
            "cancel-missing",
            "context-1",
            1,
            "request-1",
            "run-1",
        )));
        assert_eq!(missing.failure_kind.as_deref(), Some("not_found"));

        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", "1"))
                .is_none()
        );
        let active_mismatch = only(coordinator.submit(cancel_request(
            "cancel-mismatch",
            "context-1",
            1,
            "request-1",
            "different-run",
        )));
        assert_eq!(active_mismatch.failure_kind.as_deref(), Some("binding"));
        assert_eq!(coordinator.active_run_count(), 1);
        assert!(wait_for(&mut coordinator, 1)[0].ok);

        let terminal = only(coordinator.submit(cancel_request(
            "cancel-terminal",
            "context-1",
            1,
            "request-1",
            "run-1",
        )));
        assert!(terminal.ok);
        assert_eq!(terminal.kind, "cancelled");
        assert_eq!(
            terminal.result,
            Some(json!({
                "target_request_id": "request-1",
                "already_terminal": true,
            }))
        );
        let terminal_mismatch = only(coordinator.submit(cancel_request(
            "cancel-terminal-mismatch",
            "context-1",
            2,
            "request-1",
            "run-1",
        )));
        assert_eq!(terminal_mismatch.failure_kind.as_deref(), Some("binding"));
        assert_eq!(coordinator.tombstone_count(), 1);
    }

    #[test]
    fn stale_cancel_cannot_touch_replacement_and_eviction_becomes_not_found() {
        let mut coordinator = Coordinator::new(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(1, 1).unwrap(),
        );
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", "1"))
                .is_none()
        );
        assert!(wait_for(&mut coordinator, 1)[0].ok);
        assert!(only(coordinator.submit(close("context-1", "close-1", 1))).ok);
        assert!(only(coordinator.submit(open("context-1", "open-2", 2))).ok);
        assert!(
            coordinator
                .submit(run_request(
                    "context-1",
                    "request-2",
                    2,
                    "run-2",
                    "import time\nwhile True: time.sleep(1)",
                ))
                .is_none()
        );
        let control = coordinator
            .active
            .get("request-2")
            .unwrap()
            .handle
            .control();
        let state = control.state();
        if state == elpis_python::RunState::Scheduled {
            assert_eq!(
                control.wait_for_change(state),
                elpis_python::RunState::Executing
            );
        } else {
            assert_eq!(state, elpis_python::RunState::Executing);
        }

        let old_terminal = only(coordinator.submit(cancel_request(
            "cancel-old",
            "context-1",
            1,
            "request-1",
            "run-1",
        )));
        assert!(old_terminal.ok);
        assert_eq!(
            old_terminal.result,
            Some(json!({
                "target_request_id": "request-1",
                "already_terminal": true,
            }))
        );
        let stale_replacement = only(coordinator.submit(cancel_request(
            "cancel-stale",
            "context-1",
            1,
            "request-2",
            "run-2",
        )));
        assert_eq!(stale_replacement.failure_kind.as_deref(), Some("binding"));
        assert_eq!(coordinator.active_run_count(), 1);

        assert!(
            coordinator
                .submit(cancel_request(
                    "cancel-current",
                    "context-1",
                    2,
                    "request-2",
                    "run-2",
                ))
                .is_none()
        );
        let responses = wait_for(&mut coordinator, 2);
        assert_eq!(responses[0].failure_kind.as_deref(), Some("cancelled"));
        assert!(responses[1].ok);
        assert_eq!(coordinator.tombstone_count(), 1);
        assert!(coordinator.tombstones.get("request-1").is_none());
        assert!(coordinator.tombstones.get("request-2").is_some());

        let evicted = only(coordinator.submit(cancel_request(
            "cancel-evicted",
            "context-1",
            1,
            "request-1",
            "run-1",
        )));
        assert_eq!(evicted.failure_kind.as_deref(), Some("not_found"));
    }

    #[test]
    fn completion_observed_before_cancel_returns_run_then_already_terminal() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", "42"))
                .is_none()
        );
        coordinator
            .active
            .get("request-1")
            .unwrap()
            .handle
            .control()
            .wait_terminal();
        let group = coordinator
            .submit(cancel_request(
                "cancel-1",
                "context-1",
                1,
                "request-1",
                "run-1",
            ))
            .unwrap_or_else(|| wait_group(&mut coordinator));
        let CompletionGroup::Pair(responses) = group else {
            panic!("completion-winning cancel must preserve paired ordering");
        };
        assert_eq!(responses[0].request_id.as_deref(), Some("request-1"));
        assert!(responses[0].ok);
        assert_eq!(responses[1].request_id.as_deref(), Some("cancel-1"));
        assert_eq!(
            responses[1].result,
            Some(json!({
                "target_request_id": "request-1",
                "already_terminal": true,
            }))
        );
        assert_eq!(coordinator.active_run_count(), 0);
        assert_eq!(coordinator.tombstone_count(), 1);
        assert!(coordinator.poll().is_empty());
    }

    #[test]
    fn unexpected_terminal_after_owned_cancel_fails_cancel_closed() {
        let binding = RunBinding {
            request_id: "request-1".into(),
            context_id: "context-1".into(),
            generation: 1,
            run_id: "run-1".into(),
        };
        let pending = PendingCancel {
            request_id: "cancel-1".into(),
            mode: PendingCancelMode::Owned {
                started: true,
                context_invalidated: true,
            },
        };
        let result: RunResult = serde_json::from_value(json!({
            "ok": true,
            "kind": "value",
            "saved_as": null,
            "failure_kind": null,
            "error": null
        }))
        .unwrap();
        let CompletionGroup::Pair(responses) =
            terminal_completion(&binding, Some(pending), Ok(result))
        else {
            panic!("owned cancellation always has two logical responses");
        };
        assert!(responses[0].ok);
        assert_eq!(responses[1].failure_kind.as_deref(), Some("state_mismatch"));
        assert!(!responses[1].ok);
    }

    #[test]
    fn run_rejects_missing_and_stale_contexts_before_scheduling() {
        let mut coordinator = coordinator(1);
        let missing =
            only(coordinator.submit(run_request("context-1", "request-missing", 1, "run-1", "1")));
        assert_eq!(missing.failure_kind.as_deref(), Some("not_found"));
        assert!(only(coordinator.submit(open("context-1", "open-1", 2))).ok);
        let stale =
            only(coordinator.submit(run_request("context-1", "request-stale", 1, "run-2", "2")));
        assert_eq!(stale.failure_kind.as_deref(), Some("binding"));
        assert_eq!(coordinator.active_run_count(), 0);
        assert_eq!(coordinator.tombstone_count(), 0);
    }

    #[test]
    fn concurrent_completed_runs_each_emit_exactly_once() {
        let mut coordinator = coordinator(2);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(only(coordinator.submit(open("context-2", "open-2", 1))).ok);
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", "1"))
                .is_none()
        );
        assert!(
            coordinator
                .submit(run_request("context-2", "request-2", 1, "run-2", "2"))
                .is_none()
        );
        let responses = wait_for(&mut coordinator, 2);
        let mut request_ids: Vec<_> = responses
            .iter()
            .map(|response| response.request_id.as_deref().unwrap())
            .collect();
        request_ids.sort_unstable();
        assert_eq!(request_ids, ["request-1", "request-2"]);
        assert!(responses.iter().all(|response| response.ok));
        assert_eq!(coordinator.active_run_count(), 0);
        assert_eq!(coordinator.tombstone_count(), 2);
        assert!(coordinator.poll().is_empty());
    }

    #[test]
    fn injected_service_receives_exact_validated_run_binding() {
        let bindings = Arc::new(Mutex::new(Vec::new()));
        let service_calls = Arc::new(AtomicUsize::new(0));
        let captured_bindings = Arc::clone(&bindings);
        let captured_calls = Arc::clone(&service_calls);
        let mut coordinator = Coordinator::with_host_service_factory(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(1, 3).unwrap(),
            move |binding: &RunBinding| {
                captured_bindings.lock().unwrap().push(binding.clone());
                Ok(Box::new(CountingHostService {
                    calls: Arc::clone(&captured_calls),
                    result: "bound",
                }) as Box<dyn HostCallService>)
            },
        );
        assert!(only(coordinator.submit(open("context-bound", "open-bound", 7))).ok);
        assert!(
            coordinator
                .submit(run_request(
                    "context-bound",
                    "request-bound",
                    7,
                    "run-bound",
                    "host_call('test.bound', [], '')",
                ))
                .is_none()
        );

        let response = wait_for(&mut coordinator, 1).remove(0);
        assert!(response.ok);
        assert_eq!(
            response
                .result
                .as_ref()
                .and_then(|result| result.get("preview"))
                .and_then(|preview| preview.as_str()),
            Some("'bound'")
        );
        assert_eq!(service_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            *bindings.lock().unwrap(),
            [RunBinding {
                request_id: "request-bound".into(),
                context_id: "context-bound".into(),
                generation: 7,
                run_id: "run-bound".into(),
            }]
        );
    }

    #[test]
    fn default_constructor_remains_exact_host_call_rejection() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-default", "open-default", 1))).ok);
        assert!(
            coordinator
                .submit(run_request(
                    "context-default",
                    "request-default",
                    1,
                    "run-default",
                    "host_call('test.echo', [], '')",
                ))
                .is_none()
        );

        let response = wait_for(&mut coordinator, 1).remove(0);
        assert!(!response.ok);
        assert_eq!(response.failure_kind.as_deref(), Some("runtime"));
        assert!(
            response
                .error
                .as_deref()
                .unwrap()
                .contains("host calls are disabled for this run")
        );
    }

    #[test]
    fn factory_failure_is_bounded_and_does_not_start_or_record_run() {
        let factory_calls = Arc::new(AtomicUsize::new(0));
        let captured_calls = Arc::clone(&factory_calls);
        let mut coordinator = Coordinator::with_host_service_factory(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(1, 3).unwrap(),
            move |_binding: &RunBinding| {
                if captured_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(HostServiceFactoryError);
                }
                Ok(Box::new(RejectHostCalls) as Box<dyn HostCallService>)
            },
        );
        assert!(only(coordinator.submit(open("context-factory", "open-factory", 1))).ok);
        let failed = only(coordinator.submit(run_request(
            "context-factory",
            "request-failed",
            1,
            "run-failed",
            "factory_source_started = True",
        )));
        assert_eq!(failed.failure_kind.as_deref(), Some("runtime"));
        assert_eq!(failed.error.as_deref(), Some("host service factory failed"));
        failed.validate().unwrap();
        assert_eq!(coordinator.active_run_count(), 0);
        assert_eq!(coordinator.tombstone_count(), 0);
        assert_eq!(coordinator.context_count(), 1);

        assert!(
            coordinator
                .submit(run_request(
                    "context-factory",
                    "request-failed",
                    1,
                    "run-failed",
                    "globals().get('factory_source_started', 'clean')",
                ))
                .is_none()
        );
        let response = wait_for(&mut coordinator, 1).remove(0);
        assert!(response.ok);
        assert_eq!(
            response
                .result
                .as_ref()
                .and_then(|result| result.get("preview"))
                .and_then(|preview| preview.as_str()),
            Some("'clean'")
        );
        assert_eq!(factory_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn admission_failures_do_not_build_services_and_deferred_cancel_never_calls_one() {
        let factory_calls = Arc::new(AtomicUsize::new(0));
        let service_calls = Arc::new(AtomicUsize::new(0));
        let captured_factory_calls = Arc::clone(&factory_calls);
        let captured_service_calls = Arc::clone(&service_calls);
        let mut coordinator = Coordinator::with_host_service_factory(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(1, 3).unwrap(),
            move |_binding: &RunBinding| {
                captured_factory_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Box::new(CountingHostService {
                    calls: Arc::clone(&captured_service_calls),
                    result: "unexpected",
                }) as Box<dyn HostCallService>)
            },
        );

        let missing = only(coordinator.submit(run_request(
            "context-guarded",
            "request-missing",
            2,
            "run-missing",
            "1",
        )));
        assert_eq!(missing.failure_kind.as_deref(), Some("not_found"));
        assert_eq!(factory_calls.load(Ordering::SeqCst), 0);
        assert!(only(coordinator.submit(open("context-guarded", "open-guarded", 2))).ok);
        let stale = only(coordinator.submit(run_request(
            "context-guarded",
            "request-stale",
            1,
            "run-stale",
            "1",
        )));
        assert_eq!(stale.failure_kind.as_deref(), Some("binding"));
        assert_eq!(factory_calls.load(Ordering::SeqCst), 0);

        assert!(
            coordinator
                .schedule_run(
                    "request-active".into(),
                    "context-guarded".into(),
                    2,
                    "run-active".into(),
                    "host_call('test.deferred', [], '')".into(),
                    DEFAULT_PREVIEW_BYTES,
                    false,
                )
                .is_none()
        );
        assert_eq!(factory_calls.load(Ordering::SeqCst), 1);
        let duplicate = only(coordinator.submit(run_request(
            "context-guarded",
            "request-active",
            2,
            "run-active",
            "1",
        )));
        assert_eq!(duplicate.failure_kind.as_deref(), Some("conflict"));
        let conflicting = only(coordinator.submit(run_request(
            "context-guarded",
            "request-active",
            2,
            "run-conflicting",
            "1",
        )));
        assert_eq!(conflicting.failure_kind.as_deref(), Some("conflict"));
        let busy = only(coordinator.submit(run_request(
            "context-guarded",
            "request-busy",
            2,
            "run-busy",
            "1",
        )));
        assert_eq!(busy.failure_kind.as_deref(), Some("busy"));
        assert_eq!(factory_calls.load(Ordering::SeqCst), 1);

        assert!(
            coordinator
                .submit(cancel_request(
                    "cancel-active",
                    "context-guarded",
                    2,
                    "request-active",
                    "run-active",
                ))
                .is_none()
        );
        let responses = wait_for(&mut coordinator, 2);
        assert_eq!(responses[0].failure_kind.as_deref(), Some("cancelled"));
        assert_eq!(
            responses[0].result,
            Some(json!({"started": false, "context_invalidated": false}))
        );
        assert_eq!(service_calls.load(Ordering::SeqCst), 0);
        assert_eq!(coordinator.tombstone_count(), 1);

        let terminal_duplicate = only(coordinator.submit(run_request(
            "context-guarded",
            "request-active",
            2,
            "run-active",
            "1",
        )));
        assert_eq!(terminal_duplicate.failure_kind.as_deref(), Some("conflict"));
        assert_eq!(factory_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn injected_factory_preserves_ordinary_run_response_parity() {
        let config = CoordinatorConfig::new(1, 3).unwrap();
        let mut default = Coordinator::new(PythonRuntime::system("python3"), config);
        let mut injected = Coordinator::with_host_service_factory(
            PythonRuntime::system("python3"),
            config,
            |_binding: &RunBinding| Ok(Box::new(RejectHostCalls) as Box<dyn HostCallService>),
        );
        assert!(only(default.submit(open("context-parity", "open-parity", 1))).ok);
        assert!(only(injected.submit(open("context-parity", "open-parity", 1))).ok);
        let request = run_request(
            "context-parity",
            "request-parity",
            1,
            "run-parity",
            "40 + 2",
        );
        assert!(default.submit(request.clone()).is_none());
        assert!(injected.submit(request).is_none());
        let default_response = wait_for(&mut default, 1).remove(0);
        let injected_response = wait_for(&mut injected, 1).remove(0);
        assert_eq!(injected_response, default_response);
    }

    #[test]
    fn run_is_pending_then_completes_once_with_existing_response_shape() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", "40 + 2"))
                .is_none()
        );
        assert_eq!(coordinator.active_run_count(), 1);

        let responses = wait_for(&mut coordinator, 1);
        assert_eq!(responses.len(), 1);
        assert!(responses[0].ok);
        assert_eq!(responses[0].kind, "completed");
        assert_eq!(responses[0].request_id.as_deref(), Some("request-1"));
        assert_eq!(
            responses[0]
                .result
                .as_ref()
                .and_then(|value| value.get("preview"))
                .and_then(|value| value.as_str()),
            Some("42")
        );
        assert_eq!(coordinator.active_run_count(), 0);
        assert_eq!(coordinator.tombstone_count(), 1);
        assert!(coordinator.poll().is_empty());
        assert!(only(coordinator.submit(close("context-1", "close-1", 1))).ok);
    }

    #[test]
    fn active_run_rejects_duplicate_busy_and_close_without_cancelling() {
        let mut coordinator = coordinator(1);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        let source = "import time\nwhile True: time.sleep(1)";
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", source))
                .is_none()
        );
        let duplicate =
            only(coordinator.submit(run_request("context-1", "request-1", 1, "run-1", "1")));
        assert_eq!(duplicate.failure_kind.as_deref(), Some("conflict"));
        let busy = only(coordinator.submit(run_request("context-1", "request-2", 1, "run-2", "2")));
        assert_eq!(busy.failure_kind.as_deref(), Some("busy"));
        let close = only(coordinator.submit(close("context-1", "close-1", 1)));
        assert_eq!(close.failure_kind.as_deref(), Some("busy"));
        assert_eq!(coordinator.active_run_count(), 1);
        assert_eq!(coordinator.context_count(), 1);
    }

    #[test]
    fn preparse_completion_preserves_context_and_tombstones_evict_fifo() {
        let mut coordinator = Coordinator::new(
            PythonRuntime::system("python3"),
            CoordinatorConfig::new(1, 1).unwrap(),
        );
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", "if:"))
                .is_none()
        );
        let first = wait_for(&mut coordinator, 1).remove(0);
        assert_eq!(first.failure_kind.as_deref(), Some("preparse"));
        assert_eq!(coordinator.context_count(), 1);
        let binding = coordinator.tombstones.get("request-1").unwrap();
        assert_eq!(binding.context_id, "context-1");
        assert_eq!(binding.generation, 1);
        assert_eq!(binding.run_id, "run-1");
        let duplicate =
            only(coordinator.submit(run_request("context-1", "request-1", 1, "run-1", "1")));
        assert_eq!(duplicate.failure_kind.as_deref(), Some("conflict"));
        let reused_run_id =
            only(coordinator.submit(run_request("context-1", "request-other", 1, "run-1", "1")));
        assert_eq!(reused_run_id.failure_kind.as_deref(), Some("conflict"));
        assert_eq!(coordinator.active_run_count(), 0);
        assert_eq!(coordinator.context_count(), 1);

        assert!(
            coordinator
                .submit(run_request("context-1", "request-2", 1, "run-2", "2"))
                .is_none()
        );
        wait_for(&mut coordinator, 1);
        assert!(coordinator.tombstones.get("request-1").is_none());
        assert!(coordinator.tombstones.get("request-2").is_some());
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-3", "3"))
                .is_none()
        );
        wait_for(&mut coordinator, 1);
        assert!(coordinator.tombstones.get("request-2").is_none());
        assert!(coordinator.tombstones.get("request-1").is_some());
    }

    #[test]
    fn poll_is_fair_across_contexts_and_child_exit_invalidates_only_its_context() {
        let mut coordinator = coordinator(3);
        assert!(only(coordinator.submit(open("context-1", "open-1", 1))).ok);
        assert!(only(coordinator.submit(open("context-2", "open-2", 1))).ok);
        assert!(only(coordinator.submit(open("context-3", "open-3", 1))).ok);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let gate = std::env::temp_dir().join(format!(
            "elpis-coordinator-gate-{}-{unique}",
            std::process::id()
        ));
        let gate_literal = serde_json::to_string(gate.to_str().unwrap()).unwrap();
        let blocked = format!(
            "import pathlib, time\np = pathlib.Path({gate_literal})\nwhile not p.exists(): time.sleep(0.001)\n1"
        );
        assert!(
            coordinator
                .submit(run_request("context-1", "request-1", 1, "run-1", blocked))
                .is_none()
        );
        assert!(
            coordinator
                .submit(run_request("context-2", "request-2", 1, "run-2", "2"))
                .is_none()
        );
        let first = wait_for(&mut coordinator, 1).remove(0);
        assert_eq!(first.request_id.as_deref(), Some("request-2"));
        std::fs::write(&gate, b"go").unwrap();
        let second = wait_for(&mut coordinator, 1).remove(0);
        assert_eq!(second.request_id.as_deref(), Some("request-1"));
        let _ = std::fs::remove_file(&gate);

        assert!(
            coordinator
                .submit(run_request(
                    "context-3",
                    "request-3",
                    1,
                    "run-3",
                    "import os\nos._exit(23)",
                ))
                .is_none()
        );
        let crashed = wait_for(&mut coordinator, 1).remove(0);
        assert_eq!(crashed.failure_kind.as_deref(), Some("runtime"));
        assert_eq!(coordinator.context_count(), 2);
        assert!(only(coordinator.submit(close("context-3", "close-3", 1))).ok);
    }

    #[test]
    fn completion_group_preserves_pair_order() {
        let first = Response::success("request-1".into(), "first", json!({}));
        let second = Response::success("request-2".into(), "second", json!({}));
        let group = CompletionGroup::Pair(Box::new([first, second]));
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
