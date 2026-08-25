use std::collections::{HashMap, HashSet, VecDeque};

use elpis_protocol::{PROTOCOL_VERSION, Request, Response, validate_id};
use thiserror::Error;

const MAX_BOUND: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientConfig {
    max_active: usize,
    max_tombstones: usize,
    max_fenced_contexts: usize,
}

impl ClientConfig {
    pub fn new(
        max_active: usize,
        max_tombstones: usize,
        max_fenced_contexts: usize,
    ) -> Result<Self, ClientError> {
        if max_active == 0
            || max_tombstones == 0
            || max_fenced_contexts < max_active
            || max_active > MAX_BOUND
            || max_tombstones > MAX_BOUND
            || max_fenced_contexts > MAX_BOUND
        {
            return Err(ClientError::InvalidConfiguration);
        }
        Ok(Self {
            max_active,
            max_tombstones,
            max_fenced_contexts,
        })
    }
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            max_active: 64,
            max_tombstones: 256,
            max_fenced_contexts: 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRunKey {
    pub executor_id: String,
    pub request_id: String,
    pub context_id: String,
    pub generation: u64,
    pub run_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FuturePhase {
    Detached,
    CancelPending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRunFuture {
    pub future_id: String,
    pub key: RemoteRunKey,
    pub phase: FuturePhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Uncertainty {
    Transport,
    Protocol,
    CancellationProofLost,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SettlementOutcome {
    Exact {
        response: Response,
        cancel_response: Option<Response>,
    },
    Cancelled {
        run_response: Response,
        cancel_response: Response,
        started: bool,
        context_invalidated: bool,
    },
    Ambiguous {
        reason: Uncertainty,
    },
    Abandoned {
        outcome_unknown: bool,
        stopped: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settlement {
    pub future_id: Option<String>,
    pub key: RemoteRunKey,
    pub outcome: SettlementOutcome,
    pub context_fenced: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CancelRejection {
    pub future_id: String,
    pub key: RemoteRunKey,
    pub response: Response,
    pub settlement: Option<Settlement>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Abandonment {
    pub settlement: Settlement,
    pub best_effort_cancel: Option<Request>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponseEvent {
    Pending,
    Settled(Box<Settlement>),
    CancelRejected(Box<CancelRejection>),
    Duplicate,
    Stale,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ClientError {
    #[error("invalid client configuration")]
    InvalidConfiguration,
    #[error("invalid executor id")]
    InvalidExecutorId,
    #[error("request is invalid")]
    InvalidRequest,
    #[error("response is invalid")]
    InvalidResponse,
    #[error("only Run requests can be registered")]
    NotRun,
    #[error("active run capacity is exhausted")]
    Capacity,
    #[error("context is busy")]
    Busy,
    #[error("context generation is fenced")]
    Fenced,
    #[error("generation fence capacity is exhausted")]
    FenceCapacity,
    #[error("request id is already in use")]
    DuplicateRequestId,
    #[error("future id is invalid")]
    InvalidFutureId,
    #[error("future id is already in use")]
    DuplicateFutureId,
    #[error("run is unknown")]
    UnknownRun,
    #[error("future is unknown")]
    UnknownFuture,
    #[error("run is already detached")]
    AlreadyDetached,
    #[error("run is not detached")]
    NotDetached,
    #[error("cancellation is already pending")]
    CancelPending,
    #[error("response request id is missing or unknown")]
    UnknownResponse,
    #[error("terminal response conflicts with the first response")]
    ConflictingTerminalResponse,
}

#[derive(Debug, Clone)]
struct ActiveRun {
    key: RemoteRunKey,
    state: ActiveState,
}

#[derive(Debug, Clone)]
enum ActiveState {
    InFlight,
    Detached {
        future_id: String,
        cancel: Option<Box<PendingCancel>>,
    },
}

#[derive(Debug, Clone)]
struct PendingCancel {
    request_id: String,
    run_response: Option<Response>,
    cancel_response: Option<Response>,
}

#[derive(Debug, Clone)]
enum TerminalResponse {
    Exact(Box<Response>),
    Stale,
}

#[derive(Debug, Clone)]
struct Tombstone {
    response_ids: Vec<String>,
    future_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancelProof {
    AlreadyTerminal,
    Cancelled {
        started: bool,
        context_invalidated: bool,
    },
}

pub struct RemoteRunOwner {
    executor_id: String,
    config: ClientConfig,
    active: HashMap<String, ActiveRun>,
    busy_contexts: HashMap<String, String>,
    futures: HashMap<String, String>,
    cancel_to_run: HashMap<String, String>,
    fenced_through: HashMap<String, u64>,
    reserved_fence_contexts: HashSet<String>,
    terminal_responses: HashMap<String, TerminalResponse>,
    terminal_future_ids: HashSet<String>,
    tombstones: VecDeque<Tombstone>,
}

impl RemoteRunOwner {
    pub fn new(executor_id: impl Into<String>, config: ClientConfig) -> Result<Self, ClientError> {
        let executor_id = executor_id.into();
        validate_id("executor_id", &executor_id, 120)
            .map_err(|_| ClientError::InvalidExecutorId)?;
        Ok(Self {
            executor_id,
            config,
            active: HashMap::new(),
            busy_contexts: HashMap::new(),
            futures: HashMap::new(),
            cancel_to_run: HashMap::new(),
            fenced_through: HashMap::new(),
            reserved_fence_contexts: HashSet::new(),
            terminal_responses: HashMap::new(),
            terminal_future_ids: HashSet::new(),
            tombstones: VecDeque::new(),
        })
    }

    pub fn register_run(&mut self, request: &Request) -> Result<RemoteRunKey, ClientError> {
        request
            .validate()
            .map_err(|_| ClientError::InvalidRequest)?;
        let Request::Run {
            request_id,
            context_id,
            generation,
            run_id,
            ..
        } = request
        else {
            return Err(ClientError::NotRun);
        };
        if self.active.len() >= self.config.max_active {
            return Err(ClientError::Capacity);
        }
        if self.request_id_in_use(request_id) {
            return Err(ClientError::DuplicateRequestId);
        }
        if self.busy_contexts.contains_key(context_id) {
            return Err(ClientError::Busy);
        }
        if self
            .fenced_through
            .get(context_id)
            .is_some_and(|fenced| generation <= fenced)
        {
            return Err(ClientError::Fenced);
        }
        let reserve_fence = !self.fenced_through.contains_key(context_id);
        if reserve_fence
            && self.fenced_through.len() + self.reserved_fence_contexts.len()
                >= self.config.max_fenced_contexts
        {
            return Err(ClientError::FenceCapacity);
        }
        let key = RemoteRunKey {
            executor_id: self.executor_id.clone(),
            request_id: request_id.clone(),
            context_id: context_id.clone(),
            generation: *generation,
            run_id: run_id.clone(),
        };
        self.busy_contexts
            .insert(context_id.clone(), request_id.clone());
        if reserve_fence {
            self.reserved_fence_contexts.insert(context_id.clone());
        }
        self.active.insert(
            request_id.clone(),
            ActiveRun {
                key: key.clone(),
                state: ActiveState::InFlight,
            },
        );
        Ok(key)
    }

    pub fn detach(
        &mut self,
        request_id: &str,
        future_id: impl Into<String>,
    ) -> Result<RemoteRunFuture, ClientError> {
        let future_id = future_id.into();
        validate_id("future_id", &future_id, 120).map_err(|_| ClientError::InvalidFutureId)?;
        if self.futures.contains_key(&future_id) || self.terminal_future_ids.contains(&future_id) {
            return Err(ClientError::DuplicateFutureId);
        }
        let active = self
            .active
            .get_mut(request_id)
            .ok_or(ClientError::UnknownRun)?;
        if matches!(active.state, ActiveState::Detached { .. }) {
            return Err(ClientError::AlreadyDetached);
        }
        active.state = ActiveState::Detached {
            future_id: future_id.clone(),
            cancel: None,
        };
        self.futures
            .insert(future_id.clone(), request_id.to_owned());
        Ok(RemoteRunFuture {
            future_id,
            key: active.key.clone(),
            phase: FuturePhase::Detached,
        })
    }

    pub fn request_cancel(
        &mut self,
        future_id: &str,
        cancel_request_id: impl Into<String>,
    ) -> Result<Request, ClientError> {
        let run_request_id = self
            .futures
            .get(future_id)
            .cloned()
            .ok_or(ClientError::UnknownFuture)?;
        let cancel_request_id = cancel_request_id.into();
        validate_id("request_id", &cancel_request_id, 120)
            .map_err(|_| ClientError::InvalidRequest)?;
        if self.request_id_in_use(&cancel_request_id) {
            return Err(ClientError::DuplicateRequestId);
        }
        let active = self
            .active
            .get_mut(&run_request_id)
            .ok_or(ClientError::UnknownRun)?;
        let ActiveState::Detached { cancel, .. } = &mut active.state else {
            return Err(ClientError::NotDetached);
        };
        if cancel.is_some() {
            return Err(ClientError::CancelPending);
        }
        let request = Request::Cancel {
            protocol: PROTOCOL_VERSION,
            request_id: cancel_request_id.clone(),
            context_id: active.key.context_id.clone(),
            generation: active.key.generation,
            target_request_id: active.key.request_id.clone(),
            run_id: active.key.run_id.clone(),
        };
        request
            .validate()
            .map_err(|_| ClientError::InvalidRequest)?;
        *cancel = Some(Box::new(PendingCancel {
            request_id: cancel_request_id.clone(),
            run_response: None,
            cancel_response: None,
        }));
        self.cancel_to_run.insert(cancel_request_id, run_request_id);
        Ok(request)
    }

    pub fn accept_response(&mut self, response: Response) -> Result<ResponseEvent, ClientError> {
        response
            .validate()
            .map_err(|_| ClientError::InvalidResponse)?;
        let response_id = response
            .request_id
            .clone()
            .ok_or(ClientError::UnknownResponse)?;
        if let Some(terminal) = self.terminal_responses.get(&response_id) {
            return match terminal {
                TerminalResponse::Exact(first) if first.as_ref() == &response => {
                    Ok(ResponseEvent::Duplicate)
                }
                TerminalResponse::Exact(_) => Err(ClientError::ConflictingTerminalResponse),
                TerminalResponse::Stale => Ok(ResponseEvent::Stale),
            };
        }
        if let Some(run_request_id) = self.cancel_to_run.get(&response_id).cloned() {
            return self.accept_cancel_response(&run_request_id, response);
        }
        if self.active.contains_key(&response_id) {
            return self.accept_run_response(&response_id, response);
        }
        Err(ClientError::UnknownResponse)
    }

    pub fn mark_uncertain(
        &mut self,
        request_id: &str,
        reason: Uncertainty,
    ) -> Result<Settlement, ClientError> {
        let active = self
            .active
            .remove(request_id)
            .ok_or(ClientError::UnknownRun)?;
        Ok(self.finish_removed(
            active,
            SettlementOutcome::Ambiguous { reason },
            true,
            Vec::new(),
        ))
    }

    pub fn mark_future_uncertain(
        &mut self,
        future_id: &str,
        reason: Uncertainty,
    ) -> Result<Settlement, ClientError> {
        let request_id = self
            .futures
            .get(future_id)
            .cloned()
            .ok_or(ClientError::UnknownFuture)?;
        self.mark_uncertain(&request_id, reason)
    }

    pub fn abandon(
        &mut self,
        future_id: &str,
        best_effort_cancel_id: Option<String>,
    ) -> Result<Abandonment, ClientError> {
        let request_id = self
            .futures
            .get(future_id)
            .cloned()
            .ok_or(ClientError::UnknownFuture)?;
        let active = self
            .active
            .get(&request_id)
            .ok_or(ClientError::UnknownRun)?;
        let has_pending_cancel = matches!(
            active.state,
            ActiveState::Detached {
                cancel: Some(_),
                ..
            }
        );
        let best_effort_cancel = if has_pending_cancel {
            None
        } else if let Some(cancel_request_id) = best_effort_cancel_id {
            validate_id("request_id", &cancel_request_id, 120)
                .map_err(|_| ClientError::InvalidRequest)?;
            if self.request_id_in_use(&cancel_request_id) {
                return Err(ClientError::DuplicateRequestId);
            }
            let request = Request::Cancel {
                protocol: PROTOCOL_VERSION,
                request_id: cancel_request_id,
                context_id: active.key.context_id.clone(),
                generation: active.key.generation,
                target_request_id: active.key.request_id.clone(),
                run_id: active.key.run_id.clone(),
            };
            request
                .validate()
                .map_err(|_| ClientError::InvalidRequest)?;
            Some(request)
        } else {
            None
        };
        let active = self
            .active
            .remove(&request_id)
            .ok_or(ClientError::UnknownRun)?;
        let mut extra = Vec::new();
        if let Some(request) = &best_effort_cancel {
            extra.push((request.request_id().to_owned(), None));
        }
        let settlement = self.finish_removed(
            active,
            SettlementOutcome::Abandoned {
                outcome_unknown: true,
                stopped: false,
            },
            true,
            extra,
        );
        Ok(Abandonment {
            settlement,
            best_effort_cancel,
        })
    }

    pub fn future(&self, future_id: &str) -> Option<RemoteRunFuture> {
        let request_id = self.futures.get(future_id)?;
        let active = self.active.get(request_id)?;
        let ActiveState::Detached { cancel, .. } = &active.state else {
            return None;
        };
        Some(RemoteRunFuture {
            future_id: future_id.to_owned(),
            key: active.key.clone(),
            phase: if cancel.is_some() {
                FuturePhase::CancelPending
            } else {
                FuturePhase::Detached
            },
        })
    }

    pub fn is_busy(&self, context_id: &str) -> bool {
        self.busy_contexts.contains_key(context_id)
    }

    pub fn fenced_through(&self, context_id: &str) -> Option<u64> {
        self.fenced_through.get(context_id).copied()
    }

    pub fn fenced_context_count(&self) -> usize {
        self.fenced_through.len()
    }

    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    pub fn tombstone_count(&self) -> usize {
        self.tombstones.len()
    }

    fn accept_run_response(
        &mut self,
        request_id: &str,
        response: Response,
    ) -> Result<ResponseEvent, ClientError> {
        let mut finalize_cancel = false;
        let mut exact_now = false;
        {
            let active = self
                .active
                .get_mut(request_id)
                .ok_or(ClientError::UnknownRun)?;
            match &mut active.state {
                ActiveState::InFlight => exact_now = true,
                ActiveState::Detached { cancel: None, .. } => exact_now = true,
                ActiveState::Detached {
                    cancel: Some(cancel),
                    ..
                } => {
                    if let Some(first) = &cancel.run_response {
                        return if first == &response {
                            Ok(ResponseEvent::Duplicate)
                        } else {
                            self.finish_ambiguous(request_id, Uncertainty::Protocol)
                                .map(settled)
                        };
                    }
                    cancel.run_response = Some(response.clone());
                    finalize_cancel = cancel.cancel_response.is_some();
                }
            }
        }
        if exact_now {
            let active = self
                .active
                .remove(request_id)
                .ok_or(ClientError::UnknownRun)?;
            let fence = cancelled_run_facts(&response)
                .is_some_and(|(_, context_invalidated)| context_invalidated);
            let settlement = self.finish_removed(
                active,
                SettlementOutcome::Exact {
                    response: response.clone(),
                    cancel_response: None,
                },
                fence,
                vec![(request_id.to_owned(), Some(response))],
            );
            return Ok(settled(settlement));
        }
        if finalize_cancel {
            return self.finalize_cancel(request_id).map(settled);
        }
        Ok(ResponseEvent::Pending)
    }

    fn accept_cancel_response(
        &mut self,
        run_request_id: &str,
        response: Response,
    ) -> Result<ResponseEvent, ClientError> {
        if !response.ok {
            return self.reject_cancel(run_request_id, response);
        }
        if parse_cancel_proof(&response, run_request_id).is_none() {
            return self
                .finish_ambiguous(run_request_id, Uncertainty::Protocol)
                .map(settled);
        }
        let finalize = {
            let active = self
                .active
                .get_mut(run_request_id)
                .ok_or(ClientError::UnknownRun)?;
            let ActiveState::Detached {
                cancel: Some(cancel),
                ..
            } = &mut active.state
            else {
                return Err(ClientError::UnknownResponse);
            };
            if let Some(first) = &cancel.cancel_response {
                return if first == &response {
                    Ok(ResponseEvent::Duplicate)
                } else {
                    self.finish_ambiguous(run_request_id, Uncertainty::Protocol)
                        .map(settled)
                };
            }
            cancel.cancel_response = Some(response);
            cancel.run_response.is_some()
        };
        if finalize {
            return self.finalize_cancel(run_request_id).map(settled);
        }
        Ok(ResponseEvent::Pending)
    }

    fn reject_cancel(
        &mut self,
        run_request_id: &str,
        response: Response,
    ) -> Result<ResponseEvent, ClientError> {
        let (future_id, key, run_response, cancel_request_id) = {
            let active = self
                .active
                .get_mut(run_request_id)
                .ok_or(ClientError::UnknownRun)?;
            let ActiveState::Detached { future_id, cancel } = &mut active.state else {
                return Err(ClientError::UnknownResponse);
            };
            let pending = *cancel.take().ok_or(ClientError::UnknownResponse)?;
            (
                future_id.clone(),
                active.key.clone(),
                pending.run_response,
                pending.request_id,
            )
        };
        self.cancel_to_run.remove(&cancel_request_id);
        let settlement = if let Some(run_response) = run_response {
            let active = self
                .active
                .remove(run_request_id)
                .ok_or(ClientError::UnknownRun)?;
            let fence = cancelled_run_facts(&run_response)
                .is_some_and(|(_, context_invalidated)| context_invalidated);
            Some(self.finish_removed(
                active,
                SettlementOutcome::Exact {
                    response: run_response.clone(),
                    cancel_response: Some(response.clone()),
                },
                fence,
                vec![
                    (run_request_id.to_owned(), Some(run_response)),
                    (cancel_request_id, Some(response.clone())),
                ],
            ))
        } else {
            self.insert_tombstone(vec![(cancel_request_id, Some(response.clone()))], None);
            None
        };
        Ok(ResponseEvent::CancelRejected(Box::new(CancelRejection {
            future_id,
            key,
            response,
            settlement,
        })))
    }

    fn finalize_cancel(&mut self, request_id: &str) -> Result<Settlement, ClientError> {
        let active = self
            .active
            .remove(request_id)
            .ok_or(ClientError::UnknownRun)?;
        let ActiveState::Detached {
            cancel: Some(cancel),
            ..
        } = &active.state
        else {
            return Err(ClientError::UnknownResponse);
        };
        let run_response = cancel
            .run_response
            .clone()
            .ok_or(ClientError::UnknownResponse)?;
        let cancel_response = cancel
            .cancel_response
            .clone()
            .ok_or(ClientError::UnknownResponse)?;
        let proof = parse_cancel_proof(&cancel_response, request_id);
        let (outcome, fence) = match proof {
            Some(CancelProof::AlreadyTerminal) => {
                let fence = cancelled_run_facts(&run_response)
                    .is_some_and(|(_, context_invalidated)| context_invalidated);
                (
                    SettlementOutcome::Exact {
                        response: run_response.clone(),
                        cancel_response: Some(cancel_response.clone()),
                    },
                    fence,
                )
            }
            Some(CancelProof::Cancelled {
                started,
                context_invalidated,
            }) if cancelled_run_facts(&run_response) == Some((started, context_invalidated)) => (
                SettlementOutcome::Cancelled {
                    run_response: run_response.clone(),
                    cancel_response: cancel_response.clone(),
                    started,
                    context_invalidated,
                },
                context_invalidated,
            ),
            _ => {
                return Ok(self.finish_removed(
                    active,
                    SettlementOutcome::Ambiguous {
                        reason: Uncertainty::Protocol,
                    },
                    true,
                    Vec::new(),
                ));
            }
        };
        let cancel_id = cancel.request_id.clone();
        Ok(self.finish_removed(
            active,
            outcome,
            fence,
            vec![
                (request_id.to_owned(), Some(run_response)),
                (cancel_id, Some(cancel_response)),
            ],
        ))
    }

    fn finish_ambiguous(
        &mut self,
        request_id: &str,
        reason: Uncertainty,
    ) -> Result<Settlement, ClientError> {
        let active = self
            .active
            .remove(request_id)
            .ok_or(ClientError::UnknownRun)?;
        Ok(self.finish_removed(
            active,
            SettlementOutcome::Ambiguous { reason },
            true,
            Vec::new(),
        ))
    }

    fn finish_removed(
        &mut self,
        active: ActiveRun,
        outcome: SettlementOutcome,
        fence: bool,
        mut responses: Vec<(String, Option<Response>)>,
    ) -> Settlement {
        let future_id = match &active.state {
            ActiveState::InFlight => None,
            ActiveState::Detached { future_id, .. } => Some(future_id.clone()),
        };
        if let ActiveState::Detached {
            cancel: Some(cancel),
            ..
        } = &active.state
        {
            self.cancel_to_run.remove(&cancel.request_id);
            if !responses.iter().any(|(id, _)| id == &cancel.request_id) {
                responses.push((cancel.request_id.clone(), None));
            }
        }
        if fence {
            self.fence(&active.key.context_id, active.key.generation);
        } else {
            self.reserved_fence_contexts.remove(&active.key.context_id);
        }
        if self
            .busy_contexts
            .get(&active.key.context_id)
            .is_some_and(|request_id| request_id == &active.key.request_id)
        {
            self.busy_contexts.remove(&active.key.context_id);
        }
        if let Some(future_id) = &future_id {
            self.futures.remove(future_id);
        }
        if !responses.iter().any(|(id, _)| id == &active.key.request_id) {
            responses.push((active.key.request_id.clone(), None));
        }
        self.insert_tombstone(responses, future_id.clone());
        Settlement {
            future_id,
            key: active.key,
            outcome,
            context_fenced: fence,
        }
    }

    fn request_id_in_use(&self, request_id: &str) -> bool {
        self.active.contains_key(request_id)
            || self.cancel_to_run.contains_key(request_id)
            || self.terminal_responses.contains_key(request_id)
    }

    fn fence(&mut self, context_id: &str, generation: u64) {
        self.reserved_fence_contexts.remove(context_id);
        let fenced = self
            .fenced_through
            .entry(context_id.to_owned())
            .or_insert(generation);
        *fenced = (*fenced).max(generation);
    }

    fn insert_tombstone(
        &mut self,
        responses: Vec<(String, Option<Response>)>,
        future_id: Option<String>,
    ) {
        while self.tombstones.len() >= self.config.max_tombstones {
            if let Some(evicted) = self.tombstones.pop_front() {
                for response_id in evicted.response_ids {
                    self.terminal_responses.remove(&response_id);
                }
                if let Some(future_id) = evicted.future_id {
                    self.terminal_future_ids.remove(&future_id);
                }
            }
        }
        let mut response_ids = Vec::with_capacity(responses.len());
        for (response_id, response) in responses {
            response_ids.push(response_id.clone());
            self.terminal_responses.insert(
                response_id,
                response.map_or(TerminalResponse::Stale, |response| {
                    TerminalResponse::Exact(Box::new(response))
                }),
            );
        }
        if let Some(future_id) = &future_id {
            self.terminal_future_ids.insert(future_id.clone());
        }
        self.tombstones.push_back(Tombstone {
            response_ids,
            future_id,
        });
    }
}

fn settled(settlement: Settlement) -> ResponseEvent {
    ResponseEvent::Settled(Box::new(settlement))
}

fn parse_cancel_proof(response: &Response, target_request_id: &str) -> Option<CancelProof> {
    if !response.ok || response.kind != "cancelled" {
        return None;
    }
    let proof = response.result.as_ref()?.as_object()?;
    if proof.get("target_request_id")?.as_str()? != target_request_id {
        return None;
    }
    let already_terminal = proof.get("already_terminal")?.as_bool()?;
    if already_terminal {
        return (proof.len() == 2).then_some(CancelProof::AlreadyTerminal);
    }
    if proof.len() != 4 {
        return None;
    }
    Some(CancelProof::Cancelled {
        started: proof.get("started")?.as_bool()?,
        context_invalidated: proof.get("context_invalidated")?.as_bool()?,
    })
}

fn cancelled_run_facts(response: &Response) -> Option<(bool, bool)> {
    if response.ok || response.failure_kind.as_deref() != Some("cancelled") {
        return None;
    }
    let proof = response.result.as_ref()?.as_object()?;
    Some((
        proof.get("started")?.as_bool()?,
        proof.get("context_invalidated")?.as_bool()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn owner() -> RemoteRunOwner {
        RemoteRunOwner::new("executor-1", ClientConfig::new(2, 3, 8).unwrap()).unwrap()
    }

    fn run(request_id: &str, context_id: &str, generation: u64, run_id: &str) -> Request {
        Request::Run {
            protocol: PROTOCOL_VERSION,
            request_id: request_id.into(),
            context_id: context_id.into(),
            generation,
            run_id: run_id.into(),
            source: "40 + 2".into(),
            preview_max_bytes: 1024,
        }
    }

    fn completed(request_id: &str, value: i64) -> Response {
        Response::success(request_id.into(), "completed", json!({"value": value}))
    }

    fn cancelled_run(request_id: &str, started: bool, invalidated: bool) -> Response {
        let mut response = Response::failure(
            Some(request_id.into()),
            "failed",
            "cancelled",
            "python run was cancelled",
        );
        response.result = Some(json!({
            "started": started,
            "context_invalidated": invalidated,
        }));
        response
    }

    fn cancel_success(
        request_id: &str,
        target: &str,
        started: bool,
        invalidated: bool,
    ) -> Response {
        Response::success(
            request_id.into(),
            "cancelled",
            json!({
                "target_request_id": target,
                "already_terminal": false,
                "started": started,
                "context_invalidated": invalidated,
            }),
        )
    }

    fn already_terminal(request_id: &str, target: &str) -> Response {
        Response::success(
            request_id.into(),
            "cancelled",
            json!({
                "target_request_id": target,
                "already_terminal": true,
            }),
        )
    }

    #[test]
    fn deadline_detach_is_local_and_exact_response_settles_once() {
        let mut owner = owner();
        let request = run("request-1", "context-1", 1, "run-1");
        owner.register_run(&request).unwrap();
        let future = owner.detach("request-1", "future-1").unwrap();
        assert_eq!(future.phase, FuturePhase::Detached);
        assert!(owner.is_busy("context-1"));
        assert_eq!(owner.future("future-1"), Some(future));

        let response = completed("request-1", 42);
        let ResponseEvent::Settled(settlement) = owner.accept_response(response.clone()).unwrap()
        else {
            panic!("response did not settle");
        };
        assert_eq!(settlement.future_id.as_deref(), Some("future-1"));
        assert_eq!(
            settlement.outcome,
            SettlementOutcome::Exact {
                response: response.clone(),
                cancel_response: None,
            }
        );
        assert!(!owner.is_busy("context-1"));
        assert_eq!(
            owner.accept_response(response).unwrap(),
            ResponseEvent::Duplicate
        );
    }

    #[test]
    fn response_before_deadline_has_no_future_or_notice_owner() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        let ResponseEvent::Settled(settlement) =
            owner.accept_response(completed("request-1", 42)).unwrap()
        else {
            panic!("response did not settle");
        };
        assert_eq!(settlement.future_id, None);
        assert_eq!(
            owner.detach("request-1", "future-1"),
            Err(ClientError::UnknownRun)
        );
    }

    #[test]
    fn detached_and_cancel_pending_keep_context_busy() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        assert_eq!(
            owner.register_run(&run("request-2", "context-1", 1, "run-2")),
            Err(ClientError::Busy)
        );
        let cancel = owner.request_cancel("future-1", "cancel-1").unwrap();
        assert!(matches!(cancel, Request::Cancel { .. }));
        assert_eq!(
            owner.future("future-1").unwrap().phase,
            FuturePhase::CancelPending
        );
        assert_eq!(
            owner.request_cancel("future-1", "cancel-2"),
            Err(ClientError::CancelPending)
        );
        assert!(owner.is_busy("context-1"));
    }

    #[test]
    fn prestart_cancel_requires_matching_pair_and_preserves_generation() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        assert_eq!(
            owner
                .accept_response(cancelled_run("request-1", false, false))
                .unwrap(),
            ResponseEvent::Pending
        );
        let ResponseEvent::Settled(settlement) = owner
            .accept_response(cancel_success("cancel-1", "request-1", false, false))
            .unwrap()
        else {
            panic!("cancel pair did not settle");
        };
        assert!(matches!(
            settlement.outcome,
            SettlementOutcome::Cancelled {
                started: false,
                context_invalidated: false,
                ..
            }
        ));
        assert!(!settlement.context_fenced);
        assert_eq!(owner.fenced_through("context-1"), None);
        owner
            .register_run(&run("request-2", "context-1", 1, "run-2"))
            .unwrap();
    }

    #[test]
    fn active_cancel_fences_invalidated_generation() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 2, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        owner
            .accept_response(cancel_success("cancel-1", "request-1", true, true))
            .unwrap();
        let ResponseEvent::Settled(settlement) = owner
            .accept_response(cancelled_run("request-1", true, true))
            .unwrap()
        else {
            panic!("cancel pair did not settle");
        };
        assert!(settlement.context_fenced);
        assert_eq!(owner.fenced_through("context-1"), Some(2));
        assert_eq!(
            owner.register_run(&run("request-2", "context-1", 2, "run-2")),
            Err(ClientError::Fenced)
        );
        owner
            .register_run(&run("request-3", "context-1", 3, "run-3"))
            .unwrap();
    }

    #[test]
    fn completion_winning_cancel_settles_exact_run() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        let run_response = completed("request-1", 42);
        owner.accept_response(run_response.clone()).unwrap();
        let cancel_response = already_terminal("cancel-1", "request-1");
        let ResponseEvent::Settled(settlement) =
            owner.accept_response(cancel_response.clone()).unwrap()
        else {
            panic!("completion-winning cancel did not settle");
        };
        assert_eq!(
            settlement.outcome,
            SettlementOutcome::Exact {
                response: run_response,
                cancel_response: Some(cancel_response),
            }
        );
        assert!(!settlement.context_fenced);
    }

    #[test]
    fn rejected_cancel_keeps_busy_and_allows_retry() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        let rejection = Response::failure(
            Some("cancel-1".into()),
            "failed",
            "state_mismatch",
            "not proven",
        );
        let ResponseEvent::CancelRejected(rejected) =
            owner.accept_response(rejection.clone()).unwrap()
        else {
            panic!("cancel rejection was not surfaced");
        };
        assert_eq!(rejected.response, rejection);
        assert_eq!(rejected.settlement, None);
        assert!(owner.is_busy("context-1"));
        assert_eq!(
            owner.future("future-1").unwrap().phase,
            FuturePhase::Detached
        );
        owner.request_cancel("future-1", "cancel-2").unwrap();
    }

    #[test]
    fn rejected_cancel_after_run_response_settles_exact_run_once() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        let run_response = completed("request-1", 42);
        assert_eq!(
            owner.accept_response(run_response.clone()).unwrap(),
            ResponseEvent::Pending
        );
        let rejection = Response::failure(
            Some("cancel-1".into()),
            "failed",
            "state_mismatch",
            "not proven",
        );
        let ResponseEvent::CancelRejected(rejected) =
            owner.accept_response(rejection.clone()).unwrap()
        else {
            panic!("cancel rejection was not surfaced");
        };
        let settlement = rejected.settlement.expect("exact Run result was lost");
        assert_eq!(
            settlement.outcome,
            SettlementOutcome::Exact {
                response: run_response.clone(),
                cancel_response: Some(rejection.clone()),
            }
        );
        assert!(!owner.is_busy("context-1"));
        assert_eq!(
            owner.accept_response(run_response).unwrap(),
            ResponseEvent::Duplicate
        );
        assert_eq!(
            owner.accept_response(rejection).unwrap(),
            ResponseEvent::Duplicate
        );
    }

    #[test]
    fn malformed_cancel_success_fences_without_claiming_stop() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 2, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        let malformed = Response::success(
            "cancel-1".into(),
            "cancelled",
            json!({
                "target_request_id": "wrong-target",
                "already_terminal": false,
                "started": true,
                "context_invalidated": true,
            }),
        );
        let ResponseEvent::Settled(settlement) = owner.accept_response(malformed).unwrap() else {
            panic!("malformed proof did not settle ambiguous");
        };
        assert_eq!(
            settlement.outcome,
            SettlementOutcome::Ambiguous {
                reason: Uncertainty::Protocol,
            }
        );
        assert!(settlement.context_fenced);
        assert_eq!(owner.fenced_through("context-1"), Some(2));
    }

    #[test]
    fn rejected_cancel_still_honors_exact_run_invalidation_proof() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 2, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        owner
            .accept_response(cancelled_run("request-1", true, true))
            .unwrap();
        let rejection = Response::failure(
            Some("cancel-1".into()),
            "failed",
            "state_mismatch",
            "not proven",
        );
        let ResponseEvent::CancelRejected(rejected) = owner.accept_response(rejection).unwrap()
        else {
            panic!("cancel rejection was not surfaced");
        };
        let settlement = rejected.settlement.expect("exact Run proof was lost");
        assert!(settlement.context_fenced);
        assert_eq!(owner.fenced_through("context-1"), Some(2));
    }

    #[test]
    fn invalid_response_is_rejected_before_owner_mutation() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        let mut invalid = completed("request-1", 42);
        invalid.result = None;
        assert_eq!(
            owner.accept_response(invalid),
            Err(ClientError::InvalidResponse)
        );
        assert!(owner.is_busy("context-1"));
        assert!(owner.future("future-1").is_some());
    }

    #[test]
    fn mismatched_cancel_proof_is_ambiguous_and_fences() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 4, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        owner
            .accept_response(cancelled_run("request-1", true, true))
            .unwrap();
        let ResponseEvent::Settled(settlement) = owner
            .accept_response(cancel_success("cancel-1", "request-1", false, false))
            .unwrap()
        else {
            panic!("mismatch did not settle ambiguous");
        };
        assert_eq!(
            settlement.outcome,
            SettlementOutcome::Ambiguous {
                reason: Uncertainty::Protocol,
            }
        );
        assert!(settlement.context_fenced);
        assert_eq!(owner.fenced_through("context-1"), Some(4));
    }

    #[test]
    fn uncertainty_fences_before_release_and_late_response_is_stale() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 5, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        let settlement = owner
            .mark_future_uncertain("future-1", Uncertainty::Transport)
            .unwrap();
        assert!(settlement.context_fenced);
        assert!(!owner.is_busy("context-1"));
        assert_eq!(owner.fenced_through("context-1"), Some(5));
        owner
            .register_run(&run("request-2", "context-1", 6, "run-2"))
            .unwrap();
        assert_eq!(
            owner.accept_response(completed("request-1", 42)).unwrap(),
            ResponseEvent::Stale
        );
        assert!(owner.is_busy("context-1"));
        assert_eq!(owner.active_count(), 1);
    }

    #[test]
    fn abandon_is_honest_fenced_and_best_effort_once() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 3, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        let abandoned = owner
            .abandon("future-1", Some("cancel-abandon".into()))
            .unwrap();
        assert!(matches!(
            abandoned.settlement.outcome,
            SettlementOutcome::Abandoned {
                outcome_unknown: true,
                stopped: false,
            }
        ));
        assert!(abandoned.settlement.context_fenced);
        assert!(matches!(
            abandoned.best_effort_cancel,
            Some(Request::Cancel { .. })
        ));
        assert_eq!(
            owner
                .accept_response(cancel_success("cancel-abandon", "request-1", true, true,))
                .unwrap(),
            ResponseEvent::Stale
        );
        assert_eq!(
            owner.abandon("future-1", Some("cancel-again".into())),
            Err(ClientError::UnknownFuture)
        );
    }

    #[test]
    fn abandon_does_not_resend_pending_cancel() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        let abandoned = owner
            .abandon("future-1", Some("cancel-unused".into()))
            .unwrap();
        assert_eq!(abandoned.best_effort_cancel, None);
        assert_eq!(
            owner
                .accept_response(cancel_success("cancel-1", "request-1", true, true))
                .unwrap(),
            ResponseEvent::Stale
        );
    }

    #[test]
    fn invalid_abandon_request_keeps_future_and_busy_owner() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        assert_eq!(
            owner.abandon("future-1", Some("bad request id".into())),
            Err(ClientError::InvalidRequest)
        );
        assert!(owner.is_busy("context-1"));
        assert!(owner.future("future-1").is_some());
    }

    #[test]
    fn rejected_cancel_is_tombstoned_and_cannot_be_reused() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        let rejection = Response::failure(
            Some("cancel-1".into()),
            "failed",
            "state_mismatch",
            "not proven",
        );
        owner.accept_response(rejection.clone()).unwrap();
        assert_eq!(
            owner.accept_response(rejection).unwrap(),
            ResponseEvent::Duplicate
        );
        assert_eq!(
            owner.request_cancel("future-1", "cancel-1"),
            Err(ClientError::DuplicateRequestId)
        );
    }

    #[test]
    fn exact_cancelled_run_without_pending_cancel_honors_invalidation() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 2, "run-1"))
            .unwrap();
        let ResponseEvent::Settled(settlement) = owner
            .accept_response(cancelled_run("request-1", true, true))
            .unwrap()
        else {
            panic!("cancelled run did not settle");
        };
        assert!(settlement.context_fenced);
        assert_eq!(owner.fenced_through("context-1"), Some(2));
    }

    #[test]
    fn duplicate_pending_pair_responses_never_settle_twice() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.request_cancel("future-1", "cancel-1").unwrap();
        let run_response = cancelled_run("request-1", true, true);
        assert_eq!(
            owner.accept_response(run_response.clone()).unwrap(),
            ResponseEvent::Pending
        );
        assert_eq!(
            owner.accept_response(run_response).unwrap(),
            ResponseEvent::Duplicate
        );
        let cancel_response = cancel_success("cancel-1", "request-1", true, true);
        let ResponseEvent::Settled(_) = owner.accept_response(cancel_response.clone()).unwrap()
        else {
            panic!("pair did not settle");
        };
        assert_eq!(
            owner.accept_response(cancel_response).unwrap(),
            ResponseEvent::Duplicate
        );
    }

    #[test]
    fn persistent_fence_capacity_is_reserved_before_run_registration() {
        let mut owner =
            RemoteRunOwner::new("executor-1", ClientConfig::new(1, 2, 1).unwrap()).unwrap();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.detach("request-1", "future-1").unwrap();
        owner.abandon("future-1", None).unwrap();
        assert_eq!(owner.fenced_context_count(), 1);
        assert_eq!(
            owner.register_run(&run("request-2", "context-2", 1, "run-2")),
            Err(ClientError::FenceCapacity)
        );
        owner
            .register_run(&run("request-3", "context-1", 2, "run-3"))
            .unwrap();
    }

    #[test]
    fn exact_completion_releases_unused_fence_reservation() {
        let mut owner =
            RemoteRunOwner::new("executor-1", ClientConfig::new(1, 2, 1).unwrap()).unwrap();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.accept_response(completed("request-1", 1)).unwrap();
        owner
            .register_run(&run("request-2", "context-2", 1, "run-2"))
            .unwrap();
    }

    #[test]
    fn capacity_and_tombstone_eviction_are_bounded() {
        let mut owner =
            RemoteRunOwner::new("executor-1", ClientConfig::new(1, 1, 2).unwrap()).unwrap();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        assert_eq!(
            owner.register_run(&run("request-2", "context-2", 1, "run-2")),
            Err(ClientError::Capacity)
        );
        owner.accept_response(completed("request-1", 1)).unwrap();
        owner
            .register_run(&run("request-2", "context-2", 1, "run-2"))
            .unwrap();
        owner.accept_response(completed("request-2", 2)).unwrap();
        assert_eq!(owner.tombstone_count(), 1);
        assert_eq!(
            owner.accept_response(completed("request-1", 1)),
            Err(ClientError::UnknownResponse)
        );
    }

    #[test]
    fn conflicting_terminal_replay_cannot_overwrite_settlement() {
        let mut owner = owner();
        owner
            .register_run(&run("request-1", "context-1", 1, "run-1"))
            .unwrap();
        owner.accept_response(completed("request-1", 1)).unwrap();
        assert_eq!(
            owner.accept_response(completed("request-1", 2)),
            Err(ClientError::ConflictingTerminalResponse)
        );
        assert!(!owner.is_busy("context-1"));
    }
}
