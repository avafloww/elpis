use super::{PythonContext, PythonError, PythonRuntime, RunResult};
use elpis_protocol::{MAX_SOURCE_BYTES, validate_id};
use std::collections::HashSet;
use std::io;
use std::sync::{
    Arc, Condvar, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// The externally observable state of one scheduled run.
/// Transitions are monotonic: Scheduled to Executing to Terminal, with
/// CancelRequested inserted before Terminal when cancellation wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Scheduled,
    Executing,
    CancelRequested,
    Terminal(RunTerminal),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunTerminal {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// Cancellation linearized while the run was still scheduled. No source is executed.
    RequestedBeforeStart,
    /// Cancellation linearized while Python was executing. The process group was signalled.
    RequestedWhileExecuting,
    /// Another caller had already requested cancellation.
    AlreadyRequested,
    /// The run was already terminal (or this control belongs to an old run).
    Terminal,
}

struct RunEntry {
    token: u64,
    state: Mutex<RunState>,
    changed: Condvar,
    released: AtomicBool,
}

impl RunEntry {
    fn new(token: u64, released: bool) -> Self {
        Self {
            token,
            state: Mutex::new(RunState::Scheduled),
            changed: Condvar::new(),
            released: AtomicBool::new(released),
        }
    }

    fn set(&self, state: RunState) {
        *lock(&self.state) = state;
        self.changed.notify_all();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaderState {
    Starting,
    Unreaped(u32),
    Reaped,
}

struct SharedState {
    active: Option<Arc<RunEntry>>,
    leader: LeaderState,
    valid: bool,
    closing: bool,
    next_token: u64,
    seen_runs: HashSet<String>,
}

struct Shared {
    state: Mutex<SharedState>,
}

enum Command {
    Run {
        entry: Arc<RunEntry>,
        context_id: String,
        generation: u64,
        run_id: String,
        source: String,
        preview_max_bytes: usize,
        completion: mpsc::SyncSender<Result<RunResult, PythonError>>,
    },
    Shutdown,
}

struct ActorInner {
    context_id: String,
    generation: u64,
    shared: Arc<Shared>,
    sender: mpsc::Sender<Command>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

/// A clonable control handle for a context actor.
/// The PythonContext and all child wait operations remain on the actor thread.
#[derive(Clone)]
pub struct PythonContextActor {
    inner: Arc<ActorInner>,
}

impl PythonContextActor {
    pub fn open(
        runtime: &PythonRuntime,
        context_id: String,
        generation: u64,
    ) -> Result<Self, PythonError> {
        validate_id("context_id", &context_id, 120).map_err(|_| PythonError::Binding)?;
        if generation == 0 {
            return Err(PythonError::Binding);
        }

        let shared = Arc::new(Shared {
            state: Mutex::new(SharedState {
                active: None,
                leader: LeaderState::Starting,
                valid: true,
                closing: false,
                next_token: 1,
                seen_runs: HashSet::new(),
            }),
        });
        let (sender, receiver) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let actor_runtime = runtime.clone();
        let actor_context_id = context_id.clone();
        let actor_shared = Arc::clone(&shared);
        let thread = thread::Builder::new()
            .name(format!("elpis-python-{context_id}"))
            .spawn(move || {
                let mut context =
                    match PythonContext::open(&actor_runtime, actor_context_id, generation) {
                        Ok(context) => context,
                        Err(error) => {
                            let mut state = lock(&actor_shared.state);
                            state.valid = false;
                            state.leader = LeaderState::Reaped;
                            drop(state);
                            let _ = started_tx.send(Err(error));
                            return;
                        }
                    };
                {
                    let mut state = lock(&actor_shared.state);
                    state.leader = LeaderState::Unreaped(context.leader_pid());
                }
                if started_tx.send(Ok(())).is_err() {
                    close_context(&mut context, &actor_shared);
                    return;
                }
                actor_loop(&mut context, &actor_shared, receiver);
            })
            .map_err(PythonError::Io)?;

        match started_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(ActorInner {
                    context_id,
                    generation,
                    shared,
                    sender,
                    thread: Mutex::new(Some(thread)),
                }),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err(PythonError::ActorClosed)
            }
        }
    }

    pub fn binding(&self) -> (&str, u64) {
        (&self.inner.context_id, self.inner.generation)
    }

    pub fn is_valid(&self) -> bool {
        let state = lock(&self.inner.shared.state);
        state.valid && !state.closing
    }

    pub fn has_active_run(&self) -> bool {
        lock(&self.inner.shared.state).active.is_some()
    }

    pub fn run(
        &self,
        context_id: &str,
        generation: u64,
        run_id: &str,
        source: &str,
        preview_max_bytes: usize,
    ) -> Result<PythonRunHandle, PythonError> {
        self.schedule(context_id, generation, run_id, source, preview_max_bytes)
    }

    pub fn schedule(
        &self,
        context_id: &str,
        generation: u64,
        run_id: &str,
        source: &str,
        preview_max_bytes: usize,
    ) -> Result<PythonRunHandle, PythonError> {
        self.schedule_inner(
            context_id,
            generation,
            run_id,
            source,
            preview_max_bytes,
            true,
        )
    }

    /// Reserve the context in Scheduled state without allowing execution yet.
    /// Call start on the returned handle, or cancel it before start.
    pub fn schedule_deferred(
        &self,
        context_id: &str,
        generation: u64,
        run_id: &str,
        source: &str,
        preview_max_bytes: usize,
    ) -> Result<PythonRunHandle, PythonError> {
        self.schedule_inner(
            context_id,
            generation,
            run_id,
            source,
            preview_max_bytes,
            false,
        )
    }

    fn schedule_inner(
        &self,
        context_id: &str,
        generation: u64,
        run_id: &str,
        source: &str,
        preview_max_bytes: usize,
        released: bool,
    ) -> Result<PythonRunHandle, PythonError> {
        if context_id != self.inner.context_id || generation != self.inner.generation {
            return Err(PythonError::Binding);
        }
        validate_id("run_id", run_id, 120).map_err(|_| PythonError::Binding)?;
        if source.len() > MAX_SOURCE_BYTES {
            return Err(PythonError::SourceTooLarge);
        }

        let entry = {
            let mut state = lock(&self.inner.shared.state);
            if state.closing {
                return Err(PythonError::ActorClosed);
            }
            if !state.valid {
                return Err(PythonError::InvalidContext);
            }
            if state.active.is_some() {
                return Err(PythonError::Busy);
            }
            if !state.seen_runs.insert(run_id.to_owned()) {
                return Err(PythonError::DuplicateRun);
            }
            let token = state.next_token;
            state.next_token = state.next_token.wrapping_add(1).max(1);
            let entry = Arc::new(RunEntry::new(token, released));
            state.active = Some(Arc::clone(&entry));
            entry
        };

        let (completion_tx, completion_rx) = mpsc::sync_channel(1);
        let command = Command::Run {
            entry: Arc::clone(&entry),
            context_id: context_id.to_owned(),
            generation,
            run_id: run_id.to_owned(),
            source: source.to_owned(),
            preview_max_bytes,
            completion: completion_tx,
        };
        if self.inner.sender.send(command).is_err() {
            let mut shared = lock(&self.inner.shared.state);
            shared.valid = false;
            clear_if_active(&mut shared, &entry);
            entry.set(RunState::Terminal(RunTerminal::Failed));
            return Err(PythonError::ActorClosed);
        }

        Ok(PythonRunHandle {
            control: PythonRunControl {
                shared: Arc::clone(&self.inner.shared),
                entry,
            },
            completion: completion_rx,
        })
    }

    /// Stop the actor. If a run is executing this is an active cancellation.
    pub fn close(&self) -> Result<(), PythonError> {
        let should_shutdown = {
            let mut state = lock(&self.inner.shared.state);
            if state.closing {
                false
            } else {
                cancel_active_locked(&mut state)?;
                state.closing = true;
                true
            }
        };
        if should_shutdown {
            let _ = self.inner.sender.send(Command::Shutdown);
        }
        let mut thread = lock(&self.inner.thread);
        if let Some(handle) = thread.take() {
            handle.join().map_err(|_| {
                PythonError::Io(io::Error::other("python context actor thread panicked"))
            })?;
        }
        Ok(())
    }
}

impl Drop for ActorInner {
    fn drop(&mut self) {
        {
            let mut state = lock(&self.shared.state);
            state.closing = true;
            let _ = cancel_active_locked(&mut state);
        }
        let _ = self.sender.send(Command::Shutdown);
        if let Some(handle) = lock(&self.thread).take() {
            let _ = handle.join();
        }
    }
}

/// A clonable, run-specific cancellation and state handle.
/// Its token prevents an old handle from signalling a later run or replacement context.
#[derive(Clone)]
pub struct PythonRunControl {
    shared: Arc<Shared>,
    entry: Arc<RunEntry>,
}

impl PythonRunControl {
    pub fn state(&self) -> RunState {
        *lock(&self.entry.state)
    }

    /// Release a deferred run for execution. Returns false once cancellation or
    /// a terminal transition has won.
    pub fn start(&self) -> bool {
        let state = lock(&self.entry.state);
        if *state != RunState::Scheduled {
            return false;
        }
        self.entry.released.store(true, Ordering::Release);
        self.entry.changed.notify_all();
        true
    }

    /// Wait until the run no longer has the supplied observed state.
    pub fn wait_for_change(&self, observed: RunState) -> RunState {
        let mut state = lock(&self.entry.state);
        while *state == observed {
            state = wait(&self.entry.changed, state);
        }
        *state
    }

    pub fn wait_terminal(&self) -> RunTerminal {
        let mut state = lock(&self.entry.state);
        loop {
            if let RunState::Terminal(terminal) = *state {
                return terminal;
            }
            state = wait(&self.entry.changed, state);
        }
    }

    pub fn cancel(&self) -> Result<CancelOutcome, PythonError> {
        let shared = lock(&self.shared.state);
        let Some(active) = shared.active.as_ref() else {
            return Ok(CancelOutcome::Terminal);
        };
        if active.token != self.entry.token || !Arc::ptr_eq(active, &self.entry) {
            return Ok(CancelOutcome::Terminal);
        }

        let mut run_state = lock(&self.entry.state);
        match *run_state {
            RunState::Scheduled => {
                *run_state = RunState::CancelRequested;
                self.entry.changed.notify_all();
                Ok(CancelOutcome::RequestedBeforeStart)
            }
            RunState::Executing => {
                signal_unreaped(&shared)?;
                *run_state = RunState::CancelRequested;
                self.entry.changed.notify_all();
                Ok(CancelOutcome::RequestedWhileExecuting)
            }
            RunState::CancelRequested => Ok(CancelOutcome::AlreadyRequested),
            RunState::Terminal(_) => Ok(CancelOutcome::Terminal),
        }
    }
}

/// Completion receiver plus its independently clonable run control.
pub struct PythonRunHandle {
    control: PythonRunControl,
    completion: mpsc::Receiver<Result<RunResult, PythonError>>,
}

impl PythonRunHandle {
    pub fn control(&self) -> PythonRunControl {
        self.control.clone()
    }

    pub fn state(&self) -> RunState {
        self.control.state()
    }

    pub fn start(&self) -> bool {
        self.control.start()
    }

    pub fn wait_for_change(&self, observed: RunState) -> RunState {
        self.control.wait_for_change(observed)
    }

    pub fn cancel(&self) -> Result<CancelOutcome, PythonError> {
        self.control.cancel()
    }

    pub fn wait(self) -> Result<RunResult, PythonError> {
        self.completion
            .recv()
            .unwrap_or(Err(PythonError::ActorClosed))
    }
}

fn actor_loop(
    context: &mut PythonContext,
    shared: &Arc<Shared>,
    receiver: mpsc::Receiver<Command>,
) {
    loop {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(Command::Run {
                entry,
                context_id,
                generation,
                run_id,
                source,
                preview_max_bytes,
                completion,
            }) => process_run(
                context,
                shared,
                entry,
                context_id,
                generation,
                run_id,
                source,
                preview_max_bytes,
                completion,
            ),
            Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => poll_unexpected_exit(context, shared),
        }
    }
    close_context(context, shared);
}

#[allow(clippy::too_many_arguments)]
fn process_run(
    context: &mut PythonContext,
    shared: &Arc<Shared>,
    entry: Arc<RunEntry>,
    context_id: String,
    generation: u64,
    run_id: String,
    source: String,
    preview_max_bytes: usize,
    completion: mpsc::SyncSender<Result<RunResult, PythonError>>,
) {
    // Deferred scheduling gives cancellation a deterministic pre-execution point.
    {
        let mut run_state = lock(&entry.state);
        while *run_state == RunState::Scheduled && !entry.released.load(Ordering::Acquire) {
            run_state = wait(&entry.changed, run_state);
        }
    }
    {
        let mut state = lock(&shared.state);
        if !is_active(&state, &entry) || !state.valid {
            entry.set(RunState::Terminal(RunTerminal::Failed));
            clear_if_active(&mut state, &entry);
            let _ = completion.send(Err(PythonError::InvalidContext));
            return;
        }
        let mut run_state = lock(&entry.state);
        match *run_state {
            RunState::CancelRequested => {
                *run_state = RunState::Terminal(RunTerminal::Cancelled);
                entry.changed.notify_all();
                clear_if_active(&mut state, &entry);
                let _ = completion.send(Err(PythonError::Cancelled));
                return;
            }
            RunState::Scheduled => {
                *run_state = RunState::Executing;
                entry.changed.notify_all();
            }
            _ => {
                *run_state = RunState::Terminal(RunTerminal::Failed);
                entry.changed.notify_all();
                clear_if_active(&mut state, &entry);
                let _ = completion.send(Err(PythonError::ActorClosed));
                return;
            }
        }
    }

    let result = context.run(&context_id, generation, &run_id, &source, preview_max_bytes);

    let mut state = lock(&shared.state);
    let cancellation_won = matches!(*lock(&entry.state), RunState::CancelRequested);
    if cancellation_won {
        let outcome = terminate_and_reap_locked(context, &mut state);
        state.valid = false;
        clear_if_active(&mut state, &entry);
        match outcome {
            Ok(()) => {
                entry.set(RunState::Terminal(RunTerminal::Cancelled));
                let _ = completion.send(Err(PythonError::Cancelled));
            }
            Err(error) => {
                entry.set(RunState::Terminal(RunTerminal::Failed));
                let _ = completion.send(Err(error));
            }
        }
        return;
    }

    match result {
        Ok(result) => {
            clear_if_active(&mut state, &entry);
            entry.set(RunState::Terminal(RunTerminal::Completed));
            let _ = completion.send(Ok(result));
        }
        Err(error) => {
            let cleanup = terminate_and_reap_locked(context, &mut state);
            state.valid = false;
            clear_if_active(&mut state, &entry);
            entry.set(RunState::Terminal(RunTerminal::Failed));
            let _ = completion.send(cleanup.map_or_else(Err, |_| Err(error)));
        }
    }
}

fn poll_unexpected_exit(context: &mut PythonContext, shared: &Arc<Shared>) {
    let mut state = lock(&shared.state);
    if !matches!(state.leader, LeaderState::Unreaped(_)) {
        return;
    }
    match context.has_exited_unreaped() {
        Ok(true) => {
            let _ = terminate_and_reap_locked(context, &mut state);
            state.valid = false;
        }
        Err(_) => {
            let _ = terminate_and_reap_locked(context, &mut state);
            state.valid = false;
        }
        Ok(false) => {}
    }
}

fn close_context(context: &mut PythonContext, shared: &Arc<Shared>) {
    let mut state = lock(&shared.state);
    if matches!(state.leader, LeaderState::Unreaped(_)) {
        let _ = context.close();
        if context.was_reaped() {
            state.leader = LeaderState::Reaped;
        }
    }
    state.valid = false;
    state.closing = true;
}

fn terminate_and_reap_locked(
    context: &mut PythonContext,
    state: &mut SharedState,
) -> Result<(), PythonError> {
    if matches!(state.leader, LeaderState::Unreaped(_)) {
        context.signal_group(libc::SIGKILL)?;
        context.wait_reaped()?;
        // Assignment is under the mutex also held by cancellation, so no signal
        // can occur after wait has reaped the numeric pid.
        state.leader = LeaderState::Reaped;
    }
    Ok(())
}

fn cancel_active_locked(state: &mut SharedState) -> Result<(), PythonError> {
    let Some(entry) = state.active.as_ref().cloned() else {
        return Ok(());
    };
    let mut run_state = lock(&entry.state);
    match *run_state {
        RunState::Scheduled => {
            *run_state = RunState::CancelRequested;
            entry.changed.notify_all();
        }
        RunState::Executing => {
            signal_unreaped(state)?;
            *run_state = RunState::CancelRequested;
            entry.changed.notify_all();
        }
        RunState::CancelRequested | RunState::Terminal(_) => {}
    }
    Ok(())
}

fn signal_unreaped(state: &SharedState) -> Result<(), PythonError> {
    let LeaderState::Unreaped(pid) = state.leader else {
        return Err(PythonError::InvalidContext);
    };
    let pid = libc::pid_t::try_from(pid)
        .map_err(|_| PythonError::Io(io::Error::other("python child pid is out of range")))?;
    // SAFETY: the actor put this child in a fresh process group with pgid equal to pid.
    let result = unsafe { libc::kill(-pid, libc::SIGKILL) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(PythonError::Io(error));
        }
    }
    Ok(())
}

fn is_active(state: &SharedState, entry: &Arc<RunEntry>) -> bool {
    state
        .active
        .as_ref()
        .is_some_and(|active| active.token == entry.token && Arc::ptr_eq(active, entry))
}

fn clear_if_active(state: &mut SharedState, entry: &Arc<RunEntry>) {
    if is_active(state, entry) {
        state.active = None;
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait<'a, T>(condvar: &Condvar, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
    condvar
        .wait(guard)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn runtime() -> PythonRuntime {
        PythonRuntime::system("python3")
    }

    fn actor(id: &str) -> PythonContextActor {
        PythonContextActor::open(&runtime(), id.to_owned(), 1).unwrap()
    }

    fn wait_until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate() {
            assert!(Instant::now() < deadline, "condition timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn temporary_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "elpis-python-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn wait_for_pid(path: &std::path::Path) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = fs::read_to_string(path)
                && let Ok(pid) = text.trim().parse()
            {
                return pid;
            }
            assert!(
                Instant::now() < deadline,
                "pid file did not become readable"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn cancel_before_start_executes_nothing_and_context_is_reusable() {
        let actor = actor("deferred-cancel");
        let run = actor
            .schedule_deferred("deferred-cancel", 1, "run-1", "x = 99", 1024)
            .unwrap();
        assert_eq!(run.state(), RunState::Scheduled);
        assert!(matches!(
            actor.run("deferred-cancel", 1, "run-busy", "1", 1024),
            Err(PythonError::Busy)
        ));
        assert_eq!(run.cancel().unwrap(), CancelOutcome::RequestedBeforeStart);
        assert!(matches!(run.wait(), Err(PythonError::Cancelled)));
        assert!(actor.is_valid());

        let check = actor
            .run("deferred-cancel", 1, "run-2", "'x' in globals()", 1024)
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(check.preview, "False");
        actor.close().unwrap();
    }

    #[test]
    fn active_cancel_kills_spawned_group_and_invalidates_context() {
        let actor = actor("active-cancel");
        let child_pid_path = temporary_path("child-pid");
        let source = format!(
            "import pathlib, subprocess, time\np = subprocess.Popen(['/bin/sh', '-c', 'while :; do sleep 1; done'])\npathlib.Path({:?}).write_text(str(p.pid))\nwhile True: time.sleep(1)",
            child_pid_path.to_string_lossy()
        );
        let run = actor
            .run("active-cancel", 1, "run-1", &source, 1024)
            .unwrap();
        let control = run.control();
        let child_pid = wait_for_pid(&child_pid_path);
        assert_eq!(
            control.cancel().unwrap(),
            CancelOutcome::RequestedWhileExecuting
        );
        assert!(matches!(run.wait(), Err(PythonError::Cancelled)));
        assert_eq!(control.wait_terminal(), RunTerminal::Cancelled);
        assert!(!actor.is_valid());
        assert!(matches!(
            actor.run("active-cancel", 1, "run-2", "1", 1024),
            Err(PythonError::InvalidContext)
        ));
        wait_until(|| {
            let stat = fs::read_to_string(format!("/proc/{child_pid}/stat"));
            match stat {
                Err(_) => true,
                Ok(stat) => stat.split_whitespace().nth(2) == Some("Z"),
            }
        });
        let _ = fs::remove_file(child_pid_path);
        actor.close().unwrap();
    }

    #[test]
    fn natural_completion_and_cancel_linearize_in_both_orders() {
        let actor = actor("completion-race");
        let completed = actor
            .run("completion-race", 1, "run-1", "40 + 2", 1024)
            .unwrap();
        let stale = completed.control();
        assert_eq!(completed.wait().unwrap().preview, "42");
        assert_eq!(stale.cancel().unwrap(), CancelOutcome::Terminal);
        assert!(actor.is_valid());

        let executing = actor
            .run(
                "completion-race",
                1,
                "run-2",
                "import time\nwhile True: time.sleep(1)",
                1024,
            )
            .unwrap();
        let control = executing.control();
        let mut state = control.state();
        while state == RunState::Scheduled {
            state = control.wait_for_change(state);
        }
        assert_eq!(state, RunState::Executing);
        assert_eq!(
            control.cancel().unwrap(),
            CancelOutcome::RequestedWhileExecuting
        );
        assert!(matches!(executing.wait(), Err(PythonError::Cancelled)));
        assert!(!actor.is_valid());
        actor.close().unwrap();
    }

    #[test]
    fn stale_control_cannot_affect_replacement_actor() {
        let first = actor("replacement");
        let old = first.run("replacement", 1, "run-1", "1", 1024).unwrap();
        let stale = old.control();
        old.wait().unwrap();
        first.close().unwrap();

        let replacement =
            PythonContextActor::open(&runtime(), "replacement".to_owned(), 2).unwrap();
        let live = replacement
            .run("replacement", 2, "run-2", "6 * 7", 1024)
            .unwrap();
        assert_eq!(stale.cancel().unwrap(), CancelOutcome::Terminal);
        assert_eq!(live.wait().unwrap().preview, "42");
        assert!(replacement.is_valid());
        replacement.close().unwrap();
    }

    #[test]
    fn concurrent_close_waits_for_one_terminal_actor() {
        let actor = actor("concurrent-close");
        let run = actor
            .run(
                "concurrent-close",
                1,
                "run-1",
                "import time\nwhile True: time.sleep(1)",
                1024,
            )
            .unwrap();
        let control = run.control();
        let mut state = control.state();
        while state == RunState::Scheduled {
            state = control.wait_for_change(state);
        }
        assert_eq!(state, RunState::Executing);
        let first = actor.clone();
        let second = actor.clone();
        let a = thread::spawn(move || first.close());
        let b = thread::spawn(move || second.close());
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
        assert!(matches!(run.wait(), Err(PythonError::Cancelled)));
        assert_eq!(control.wait_terminal(), RunTerminal::Cancelled);
    }

    #[test]
    fn dropping_last_actor_handle_cancels_and_reaps_active_run() {
        let actor = actor("drop-active");
        let run = actor
            .run(
                "drop-active",
                1,
                "run-1",
                "import time\nwhile True: time.sleep(1)",
                1024,
            )
            .unwrap();
        let control = run.control();
        let mut state = control.state();
        while state == RunState::Scheduled {
            state = control.wait_for_change(state);
        }
        assert_eq!(state, RunState::Executing);
        drop(actor);
        assert!(matches!(run.wait(), Err(PythonError::Cancelled)));
        assert_eq!(control.wait_terminal(), RunTerminal::Cancelled);
    }

    #[test]
    fn signal_failure_does_not_claim_cancel_requested() {
        let entry = Arc::new(RunEntry::new(1, true));
        entry.set(RunState::Executing);
        let shared = Arc::new(Shared {
            state: Mutex::new(SharedState {
                active: Some(Arc::clone(&entry)),
                leader: LeaderState::Reaped,
                valid: true,
                closing: false,
                next_token: 2,
                seen_runs: HashSet::from(["run-1".to_owned()]),
            }),
        });
        let control = PythonRunControl { shared, entry };
        assert!(matches!(control.cancel(), Err(PythonError::InvalidContext)));
        assert_eq!(control.state(), RunState::Executing);
    }

    #[test]
    fn idle_unexpected_exit_kills_group_before_reaping_leader() {
        let actor = actor("idle-exit");
        let child_pid_path = temporary_path("idle-child-pid");
        let source = format!(
            "import os, pathlib, subprocess, threading, time\np = subprocess.Popen(['/bin/sh', '-c', 'while :; do sleep 1; done'])\npathlib.Path({:?}).write_text(str(p.pid))\ndef die():\n    time.sleep(0.2)\n    os._exit(7)\nthreading.Thread(target=die, daemon=True).start()\n42",
            child_pid_path.to_string_lossy()
        );
        let result = actor
            .run("idle-exit", 1, "run-1", &source, 1024)
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(result.preview, "42");
        let child_pid = wait_for_pid(&child_pid_path);
        wait_until(|| !actor.is_valid());
        wait_until(|| {
            let stat = fs::read_to_string(format!("/proc/{child_pid}/stat"));
            match stat {
                Err(_) => true,
                Ok(stat) => stat.split_whitespace().nth(2) == Some("Z"),
            }
        });
        let _ = fs::remove_file(child_pid_path);
        actor.close().unwrap();
    }

    #[test]
    fn unexpected_child_exit_invalidates_context() {
        let actor = actor("unexpected-exit");
        let run = actor
            .run(
                "unexpected-exit",
                1,
                "run-1",
                "import os\nos._exit(7)",
                1024,
            )
            .unwrap();
        assert!(run.wait().is_err());
        assert!(!actor.is_valid());
        actor.close().unwrap();
    }
}
