// index.ts — the harness-side fleet registry. The single surface the sandbox
// (`elpis.fleet.*`) and index.ts boot recovery consume. It owns the lifecycle
// of detached runner processes (spawn/revive), one control socket per live
// runner, the `fleet_sessions`/`fleet_worktrees` DB rows, the notice pipeline
// (progress/turn-end/failure surfaced to the agent via `notify`), boot recovery
// (probe pids → reconnect-and-replay OR file-replay-then-mark-dead), and the
// verbs run/send/interrupt/list/status/tail/diff/dismiss.
//
// ONE frame-handler (`handleFrame`) serves live operation, socket reconnect
// replay, AND dead-runner file replay identically. For a notice-worthy frame
// (turn-end/mailbox/fatal) it notifies FIRST, then advances `delivered_seq`
// (duplicate-over-lost: a crash between the two re-notifies rather than drops).
// Worktree frames upsert `fleet_worktrees`; state frames update status. Every
// runner emits durable frames to <sessionDir>/events.jsonl AND its ctl.sock, so
// the replay offset (`delivered_seq`, subscribed as `sinceSeq`) resumes without
// a gap or a double-notify across a harness restart.
//
// Runners are DETACHED by design: dispose drops sockets + timers but never
// kills a runner. dismiss is the only path that tears a runner down, and only
// after a dirty/ahead worktree gate (unless force/keepWorktree overrides).

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { Database } from '../store/db.js';
import type { Logger } from '../lib/log.js';
import { MODEL_ALIASES, type Config, type FleetModelAlias, type FleetModelOverride } from '../config.js';
import { fetchModelContextWindow } from '../llm/llm.js';
import { isPidAlive, killTree } from '../lib/proc.js';
import { generateName, newSessionId, validateName } from './names.js';
import { frameLine, parseFrames, type RunnerConfig, type RunnerEndpoint, type RunnerFrame, type RunnerOp } from './protocol.js';
import {
  cwdDiff,
  removeWorktree,
  repoHead,
  worktreeDiff,
  worktreeState,
  type FleetWorktreeDiff,
} from './git.js';

// ---- public surface (imported by name by Tasks 12/13) ---------------------

export interface FleetOpts {
  db: Database;
  dataDirectory: string;
  harnessRoot: string;
  fleet: Config['fleet'];
  logger: Logger;
  /** -> agent.notifyFleet: how a runner's notices reach the agent's history. */
  notify: (text: string) => void;
  /** The dispatching agent's name (SOUL.md frontmatter). Read at each spawn/
 * revive so a rename takes effect without a harness restart; absent → the
 * runner's guidance falls back to a neutral phrasing. */
  agentName?: () => string;
  /** default: <harnessRoot>/dist/fleet/runner.js; tests point at the fixture. */
  runnerPath?: string;
  /** default: process.execPath. */
  nodePath?: string;
}

export interface FleetHandle {
  run(
    prompt: string,
    opts?: { name?: string; cwd?: string; model?: string | null; effort?: string | null; readOnly?: boolean; worktree?: boolean },
  ): Promise<{ id: string; name: string; cwd: string; model: string | null }>;
  send(ref: string, text: string, opts?: { readOnly?: boolean }): Promise<{ ok: boolean; note: string }>;
  interrupt(ref: string): Promise<{ ok: boolean; note: string }>;
  list(): Array<Record<string, unknown>>;
  status(ref: string): Record<string, unknown>;
  tail(ref: string, n?: number): string;
  diff(ref: string, opts?: { worktree?: string; statOnly?: boolean; paths?: string[] }): Promise<FleetDiff>;
  dismiss(ref: string, opts?: { force?: boolean; keepWorktree?: boolean }): Promise<{ ok: boolean; note: string; stranded?: unknown }>;
  recover(): void;
  dispose(): void;
}

export interface FleetDiff {
  ok: boolean;
  session: string;
  note?: string;
  worktrees: FleetWorktreeDiff[];
}

// ---- internal -------------------------------------------------------------

/** A live control-socket connection to a runner. */
interface Conn {
  socket: net.Socket;
  buf: string;
  /** saw a `state:'exited'` frame → a subsequent close is a clean exit, not a death. */
  sawExited: boolean;
  /** we initiated the teardown (dismiss/dispose) → a close is expected. */
  intentional: boolean;
}

type SessionRow = Record<string, unknown>;

const REAP_INTERVAL_MS = 3_600_000; // hourly
const LIVE_STATUSES = new Set(['spawning', 'running', 'idle']);

/** Read a NOT NULL TEXT column back as `string | null`: '' (and a legacy NULL)
 * mean "deliberately unset" — see the INSERT in run. */
function toNullable(v: unknown): string | null {
  const s = v == null ? '' : String(v);
  return s === '' ? null : s;
}

/** `(e as Error).message ?? e`, stringified — the one error-to-note formatter
 * every catch block in this file renders a failure note through. */
function errMsg(e: unknown): string {
  return String((e as Error).message ?? e);
}

/** Serialize + write one RunnerOp frame over a control socket. `op` typed as
 * RunnerOp gives call sites the same excess-property check `satisfies
 * RunnerOp` gave them at the object-literal call site — writeOp itself does
 * NOT catch, so callers keep their own try/catch (some swallow a dead-socket
 * write, some turn it into an error result). */
function writeOp(conn: Conn, op: RunnerOp): void {
  conn.socket.write(JSON.stringify(op) + '\n');
}

export function createFleet(opts: FleetOpts): FleetHandle {
  const { db, dataDirectory, harnessRoot, fleet, logger, notify } = opts;
  const runnerPath = opts.runnerPath ?? path.join(harnessRoot, 'dist', 'fleet', 'runner.js');
  const nodePath = opts.nodePath ?? process.execPath;
  const conns = new Map<string, Conn>();
  let reaper: ReturnType<typeof setInterval> | null = null;

 // ---- DB helpers (statements prepared once here — channels.ts/mutes.ts
 // idiom). `touch`'s UPDATE is the one exception: its SET clause is built
 // from the caller's patch keys, so the SQL text itself varies per call and
 // can't be prepared once.
  const getByIdStmt = db.prepare('SELECT * FROM fleet_sessions WHERE id = ?');
  const getByRefStmt = db.prepare('SELECT * FROM fleet_sessions WHERE id = ? OR name = ?');
  const allSessionsStmt = db.prepare('SELECT * FROM fleet_sessions ORDER BY created_at');
  const advanceSeqStmt = db.prepare(
    'UPDATE fleet_sessions SET delivered_seq = ?, updated_at = ? WHERE id = ? AND delivered_seq < ?',
  );
  const insertSessionStmt = db.prepare(
    `INSERT INTO fleet_sessions (id, name, cwd, status, model, effort, read_only, worktree_guidance, created_at, updated_at)
     VALUES (?, ?, ?, 'spawning', ?, ?, ?, ?, ?, ?)`,
  );
  const worktreeUpsertStmt = db.prepare(
    `INSERT INTO fleet_worktrees (session_id, name, path, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, path) DO UPDATE SET name = excluded.name, removed_at = NULL`,
  );
  const worktreeRemoveStmt = db.prepare('UPDATE fleet_worktrees SET removed_at = ? WHERE session_id = ? AND path = ?');
  const liveWorktreesStmt = db.prepare('SELECT * FROM fleet_worktrees WHERE session_id = ? AND removed_at IS NULL');
  const dismissedBeforeStmt = db.prepare('SELECT * FROM fleet_sessions WHERE status = ? AND updated_at < ?');

  function getById(id: string): SessionRow | undefined {
    return getByIdStmt.get(id) as SessionRow | undefined;
  }
  function getByRef(ref: string): SessionRow | undefined {
    return getByRefStmt.get(ref, ref) as SessionRow | undefined;
  }
  function allSessions(): SessionRow[] {
    return allSessionsStmt.all() as SessionRow[];
  }
  function touch(id: string, patch: Record<string, string | number | null>): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v); }
    sets.push('updated_at = ?'); vals.push(Date.now());
    vals.push(id);
    db.prepare(`UPDATE fleet_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  function advanceSeq(id: string, seq: number): void {
 // Monotone: never walk delivered_seq backward (frames arrive in order, but
 // a stray replay must not un-advance it).
    advanceSeqStmt.run(seq, Date.now(), id, seq);
  }
  function nameOf(id: string): string {
    const r = getById(id);
    return r ? String(r.name) : id;
  }

 // ---- a session is "live" (counts against maxConcurrent) -----------------
  function isLive(row: SessionRow): boolean {
    if (!LIVE_STATUSES.has(String(row.status))) return false;
    const pid = row.runner_pid as number | null;
    if (pid == null) return String(row.status) === 'spawning'; // mid-spawn
    return isPidAlive(pid);
  }

 // ---- notices ------------------------------------------------------------
  function turnEndNotice(name: string, f: Extract<RunnerFrame, { ev: 'turn-end' }>): string {
    const result = (f.result ?? '').slice(0, 1500);
    const cost = f.costUsd.toFixed(4);
    return `[fleet ${name} finished turn] ${result} (${f.usage.input}/${f.usage.output} tokens, ~$${cost}, ${f.turns} turns)`;
  }

 // ---- the single frame pipeline ------------------------------------------
 // Serves live operation, socket reconnect replay, AND dead-runner file replay
 // identically. Notice-worthy frames notify FIRST, then advance delivered_seq.
  function handleFrame(id: string, f: RunnerFrame): void {
    switch (f.ev) {
      case 'mailbox':
        notify(`[fleet ${nameOf(id)} says] ${f.text}`);
        advanceSeq(id, f.seq);
        break;
      case 'turn-end':
        notify(turnEndNotice(nameOf(id), f));
        touch(id, {
          status: 'idle',
          sdk_session_id: f.sdkSessionId ?? null,
          input_tokens: f.usage.input,
          output_tokens: f.usage.output,
          cost_estimate_usd: f.costUsd,
          turns: f.turns,
        });
        advanceSeq(id, f.seq);
        break;
      case 'fatal':
        notify(`[fleet ${nameOf(id)} failed] ${f.error} — elpis.fleet.send('${nameOf(id)}', …) revives it`);
        touch(id, { status: 'failed', last_error: f.error });
        advanceSeq(id, f.seq);
        break;
      case 'worktree':
        upsertWorktree(id, f);
        break;
      case 'state':
        applyState(id, f.state);
        break;
      case 'event':
      case 'hello':
        break; // events are tail-only; hello is a socket handshake, never routed here
    }
  }

  function applyState(id: string, state: string): void {
    const row = getById(id);
    if (!row || row.status === 'dismissed' || row.status === 'failed') return;
    if (state === 'running') touch(id, { status: 'running' });
    else if (state === 'idle') touch(id, { status: 'idle' });
    else if (state === 'exited') touch(id, { runner_pid: null });
 // 'starting' leaves the row as-is (run already set 'running').
  }

  function upsertWorktree(id: string, f: Extract<RunnerFrame, { ev: 'worktree' }>): void {
    const now = Date.now();
    if (f.action === 'create') {
      worktreeUpsertStmt.run(id, f.name, f.path, now);
    } else {
      worktreeRemoveStmt.run(now, id, f.path);
    }
  }

 // ---- socket client ------------------------------------------------------
 // Connect with retry (100ms, 10s cap) until `hello`, then subscribe from
 // `sinceSeq` and route every durable frame through handleFrame.
  function openConn(id: string, sockPath: string, sinceSeq: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let resolved = false;
      const attempt = (): void => {
        const socket = net.createConnection(sockPath);
        socket.setEncoding('utf8');
        const conn: Conn = { socket, buf: '', sawExited: false, intentional: false };
        socket.on('data', (chunk: string) => {
          conn.buf += chunk;
          const { frames, rest } = parseFrames(conn.buf);
          conn.buf = rest;
          for (const fr of frames) {
            const frame = fr as RunnerFrame;
            if (!resolved && frame.ev === 'hello') {
              resolved = true;
              conns.set(id, conn);
              try { writeOp(conn, { op: 'subscribe', sinceSeq }); } catch { /* dropped */ }
              resolve();
              continue; // hello is socket-only — never a durable frame
            }
            if (!resolved) continue;
            if (frame.ev === 'state' && frame.state === 'exited') conn.sawExited = true;
            handleFrame(id, frame);
          }
        });
        socket.on('error', () => {
          if (resolved) return; // a post-hello error settles via 'close'
          socket.destroy();
          if (Date.now() - started > 10_000) { reject(new Error(`fleet: timed out connecting to ${sockPath}`)); return; }
          setTimeout(attempt, 100).unref();
        });
        socket.on('close', () => {
          if (!resolved) return; // pre-hello close is handled by the retry path
          onUnexpectedClose(id, conn);
        });
      };
      attempt();
    });
  }

  function onUnexpectedClose(id: string, conn: Conn): void {
    conns.delete(id);
    if (conn.intentional || conn.sawExited) return; // teardown / clean exit
    const row = getById(id);
    if (!row || row.status === 'dismissed' || row.status === 'failed') return;
    if (isPidAlive(row.runner_pid as number | null)) return; // socket blipped but process lives
 // The runner died mid-turn: mark failed + surface a revival notice.
    touch(id, { status: 'failed', runner_pid: null });
    notify(
      `[fleet ${String(row.name)} runner died mid-turn — last activity: ${lastEventSummary(id)}. ` +
        `elpis.fleet.send('${String(row.name)}', …) revives it from the saved session]`,
    );
  }

  function sessionDirOf(id: string): string {
    return path.join(dataDirectory, 'fleet', id);
  }

  function lastEventSummary(id: string): string {
    try {
      const { frames } = parseFrames(fs.readFileSync(path.join(sessionDirOf(id), 'events.jsonl'), 'utf8'));
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i] as RunnerFrame;
        if (f.ev === 'event') return `${f.kind}: ${f.summary}`;
        if (f.ev === 'turn-end') return `turn-end: ${(f.result ?? '').slice(0, 80)}`;
        if (f.ev === 'mailbox') return `says: ${f.text.slice(0, 80)}`;
      }
    } catch { /* unreadable → unknown */ }
    return 'unknown';
  }

  /** Append a single `event` frame to <sessionDir>/events.jsonl. The registry
 * authoring a line directly is ONLY safe in the dead-pid window (no concurrent
 * runner writer): right before a revive-spawn, when the torn-down runner is
 * gone and the next one's initialSeq will read past this line. seq = max
 * existing+1, matching the runner's own counter so the stream stays monotone.
 * Returns the assigned seq, or null on read/parse error (best-effort — the
 * lift is recorded in the DB regardless). Restricted to `event` frames: the
 * only kind the registry ever authors (state/turn-end/etc. all come from the
 * runner), and handleFrame ignores `event` so it carries no status side-effect. */
  function appendEventLog(id: string, frame: Omit<Extract<RunnerFrame, { ev: 'event' }>, 'seq'>): number | null {
    const eventsFile = path.join(sessionDirOf(id), 'events.jsonl');
    let seq = 1;
    try {
      const { frames } = parseFrames(fs.readFileSync(eventsFile, 'utf8'));
      for (const f of frames) {
        const s = (f as { seq?: unknown }).seq;
        if (typeof s === 'number' && s >= seq) seq = s + 1;
      }
    } catch {
      /* no log yet / unreadable — start at 1 */
    }
    try {
      fs.appendFileSync(eventsFile, frameLine({ ...frame, seq } as RunnerFrame));
    } catch {
      /* append failure is best-effort */
    }
    return seq;
  }

  /** Tear a live runner down: graceful shutdown op over a held conn, else
 * SIGTERM the process group, escalating to SIGKILL after a grace window.
 * Waits up to `deadlineMs` for the pid to die. Mirrors dismiss's teardown
 * — a permission-change revive must kill the process first (the SDK options
 * that encode `readOnly` are baked in once per spawn). No-op when the pid is
 * already dead. Never throws. */
  async function teardownRunner(row: SessionRow, deadlineMs = 3000): Promise<void> {
    const id = String(row.id);
    const pid = row.runner_pid as number | null;
    if (!isPidAlive(pid)) return;
    const conn = conns.get(id);
    if (conn) {
      conn.intentional = true;
      try { writeOp(conn, { op: 'shutdown' }); } catch { /* dead already */ }
    } else {
      killTree(pid as number);
    }
    const deadline = Date.now() + deadlineMs;
    while (isPidAlive(pid) && Date.now() < deadline) await delay(50);
    if (isPidAlive(pid)) killTree(pid as number);
    if (conn) { try { conn.socket.destroy(); } catch { /* ignore */ } conns.delete(id); }
  }

 // ---- spawn --------------------------------------------------------------
 // 0600: runner-config.json carries `endpoint.apiKey`/`authToken` when the
 // operator configured a custom fleet endpoint. mode on writeFileSync only
 // applies at CREATE, so an existing file (revive re-writes it) is chmod'd
 // explicitly.
  function writeConfig(id: string, config: RunnerConfig): void {
    const file = path.join(sessionDirOf(id), 'runner-config.json');
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort — e.g. a filesystem without modes */ }
  }

  /** The endpoint/alias overrides every runner-config.json carries, straight
 * off config.yaml (`fleet.base_url`/`api_key`/`auth_token`/`models`). Only
 * alias NAMES travel — an alias's `context` is resolved per-session by
 * resolveContextTokens. */
  function endpointConfig(): RunnerEndpoint {
    const models = {} as Record<FleetModelAlias, string | null>;
    for (const alias of MODEL_ALIASES) models[alias] = fleet.models[alias].name;
    return { ...fleet.endpoint, models };
  }

 // ---- context window ------------------------------------------------------
 // Memoized per concrete model name. A failure caches as null too: a custom
 // endpoint that doesn't implement models/info must not be re-probed on every
 // single spawn. A harness restart re-probes.
  const contextCache = new Map<string, number | null>();

  /** The alias entry a session's `model` string refers to, by alias key first
 * (`'opus'`) then by configured target name (`'big-model'`). */
  function aliasFor(model: string): FleetModelOverride | undefined {
    const byKey = (fleet.models as Record<string, FleetModelOverride | undefined>)[model];
    if (byKey) return byKey;
    return Object.values(fleet.models).find((m) => m.name != null && m.name === model);
  }

  /**
 * Context window (tokens) for the model this session will run on, or null to
 * leave CLAUDE_CODE_MAX_CONTEXT_TOKENS unset so the SDK uses its own figure.
 *
 * An explicit `fleet.models.<alias>.context` wins and SKIPS the probe.
 * Otherwise `<fleet.base_url>/models/info` is probed via the harness's own
 * fetchModelContextWindow — the same route + shape the brain LLM's boot
 * probe uses. NEVER throws: a fleet session failing to start because a
 * context probe 404'd would be a far worse outcome than running on the SDK's
 * default window, so every failure degrades to null with a log line.
 */
  async function resolveContextTokens(model: string | null): Promise<number | null> {
    if (model == null) return null; // no model pinned → the SDK decides everything
    const alias = aliasFor(model);
    if (alias?.context != null) return alias.context;
 // The probe needs a concrete model id. An alias configured with a `context`
 // but no `name` was handled above; one with neither leaves us pointed at an
 // SDK-internal id we can't name, so there is nothing to ask about.
    const concrete = alias ? alias.name : model;
    if (concrete == null) return null;
 // models/info is an endpoint-specific route; with no custom endpoint there
 // is nothing to probe (and the stock API doesn't serve it).
    const { baseUrl, apiKey, authToken } = fleet.endpoint;
    const credential = apiKey ?? authToken;
    if (!baseUrl || !credential) return null;
    if (contextCache.has(concrete)) return contextCache.get(concrete) ?? null;
    let resolved: number | null = null;
    try {
 // fleet.base_url is the API ROOT (what ANTHROPIC_BASE_URL wants — the CLI
 // appends //messages itself), so the version segment has to be added
 // back here: models/info lives beside messages at <root>//models/info.
      resolved = await fetchModelContextWindow(`${baseUrl}/v1`, credential, concrete);
      logger.info(`[fleet] context window for ${concrete}: ${resolved} tokens`);
    } catch (e) {
      logger.warn(
        `[fleet] context window probe failed for ${concrete} (${errMsg(e)}) — ` +
          `letting the SDK use its own default; set fleet.models.<alias>.context to pin it`,
      );
    }
    contextCache.set(concrete, resolved);
    return resolved;
  }

  /** Open the log fd BEFORE spawn (bg.ts pattern), spawn detached, close fd,
 * unref. Returns the child pid. */
  function spawnRunner(id: string): number {
    const dir = sessionDirOf(id);
    const fd = fs.openSync(path.join(dir, 'runner.log'), 'a');
    const child = spawn(nodePath, [runnerPath, dir], { detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.unref();
 // A missing pid means the spawn never took — never persist 0 (isPidAlive(0)
 // would wedge as a phantom "alive" runner). Throw so the caller marks failed.
    if (child.pid === undefined) throw new Error('fleet: runner spawn produced no pid');
    return child.pid;
  }

  /** Resolve an effort against the CONFIGURED level set (`fleet.efforts`,
 * defaulting to the SDK's own union). `null` is an explicit "send no effort
 * at all"; `undefined` takes `fleet.default_effort`. */
  function normalizeEffort(e: string | null | undefined): string | null {
    if (e === null) return null;
    const v = e ?? fleet.defaultEffort;
    if (v === null) return null;
    if (!fleet.efforts.includes(v)) {
      const supported = fleet.efforts.length ? fleet.efforts.join('|') : '(none — this endpoint takes no effort parameter)';
      throw new Error(`fleet: effort must be ${supported}, got ${JSON.stringify(v)}`);
    }
    return v;
  }

 // ---- verbs --------------------------------------------------------------

  async function run(
    prompt: string,
    o: { name?: string; cwd?: string; model?: string | null; effort?: string | null; readOnly?: boolean; worktree?: boolean } = {},
  ): Promise<{ id: string; name: string; cwd: string; model: string | null }> {
    const rows = allSessions();
    const takenNames = new Set(rows.filter((r) => r.status !== 'dismissed').map((r) => String(r.name)));

    let name: string;
    if (o.name != null) {
      validateName(o.name);
      if (takenNames.has(o.name)) throw new Error(`fleet: session name '${o.name}' is already in use`);
      name = o.name;
    } else {
      name = generateName(takenNames);
    }

    const live = rows.filter(isLive);
    if (live.length >= fleet.maxConcurrent) {
      throw new Error(
        `fleet: at capacity (${live.length}/${fleet.maxConcurrent} live: ${live.map((r) => r.name).join(', ')}) — ` +
          `dismiss one before starting another`,
      );
    }

 // `null` is an explicit "send no model" (the SDK picks); `undefined` takes
 // fleet.default_model, which is itself nullable for the same reason.
    const model = o.model === undefined ? fleet.defaultModel : o.model;
    if (model !== null && (typeof model !== 'string' || model.length === 0)) {
      throw new Error('fleet: model must be a non-empty string or null');
    }
    const effort = normalizeEffort(o.effort);
    const readOnly = o.readOnly ?? false;
    const worktree = o.worktree ?? true;
    const cwd = o.cwd ?? harnessRoot;
    const id = newSessionId();
    const now = Date.now();

 // `model`/`effort` are NOT NULL columns; a deliberate "send nothing"
 // persists as '' and reads back as null (see toNullable) — no migration,
 // and an existing row's non-empty value keeps meaning exactly what it did.
    insertSessionStmt.run(id, name, cwd, model ?? '', effort ?? '', readOnly ? 1 : 0, worktree ? 1 : 0, now, now);

 // Everything from dir-create through handshake can throw (mkdir/write/spawn/
 // connect). On ANY failure mark the row failed so it never strands in the
 // transient 'spawning' status, then rethrow to the caller.
    try {
      fs.mkdirSync(sessionDirOf(id), { recursive: true });
      const config: RunnerConfig = {
        id, name, prompt, cwd, model, effort, readOnly, worktree,
        agentName: opts.agentName?.() ?? null,
        resume: null, idleTimeoutMs: fleet.idleTimeoutMs, env: fleet.env,
        endpoint: endpointConfig(),
        contextTokens: await resolveContextTokens(model),
      };
      writeConfig(id, config);
      const pid = spawnRunner(id);
      touch(id, { runner_pid: pid });
      logger.info(`[fleet] spawned ${name} (${id}) pid=${pid}`);
      await openConn(id, path.join(sessionDirOf(id), 'ctl.sock'), 0);
    } catch (e) {
      touch(id, { status: 'failed', last_error: errMsg(e) });
      throw e;
    }
    touch(id, { status: 'running' });
    return { id, name, cwd, model };
  }

  /** Resolve a usable control connection WITHOUT spawning. Returns the live
 * conn if we hold one; otherwise, when the runner PROCESS is still alive
 * (socket blipped, or recover's reconnect lost the race), reconnects and
 * replays from `delivered_seq`. Returns null ONLY when the pid is dead — the
 * sole case that warrants a revive-spawn. A reconnect failure to a live
 * runner REJECTS (never falls through to a duplicate spawn). */
  async function ensureConn(id: string): Promise<Conn | null> {
    const existing = conns.get(id);
    if (existing) return existing;
    const row = getById(id);
    if (!row) return null;
    if (!isPidAlive(row.runner_pid as number | null)) return null;
    await openConn(id, path.join(sessionDirOf(id), 'ctl.sock'), Number(row.delivered_seq ?? 0));
    return conns.get(id) ?? null;
  }

  async function send(ref: string, text: string, o: { readOnly?: boolean } = {}): Promise<{ ok: boolean; note: string }> {
    const row = getByRef(ref);
    if (!row) return { ok: false, note: `no fleet session '${ref}'` };
    const id = String(row.id);
    const name = String(row.name);
    if (row.status === 'dismissed') return { ok: false, note: `session '${name}' is dismissed — start a new session with elpis.fleet.run(...)` };

 // A readOnly override defaults to the STORED value, so it's a no-op unless
 // the caller actually passes one. `readOnly` is baked into the SDK options
 // once per spawn (permissionMode/allowedTools/guidance — see runner-core.ts),
 // so a change can only take effect at a revive-spawn, never mid-turn. That
 // means an override on a LIVE runner requires tearing it down first.
    const storedReadOnly = Number(row.read_only) === 1;
    const readOnlyOverride = o.readOnly;
    const readOnlyChanged = readOnlyOverride != null && readOnlyOverride !== storedReadOnly;

 // Refuse a mid-turn lift: the agent is working. interrupt first, then send.
 // (Only a CHANGE is gated — a no-op override is fine mid-turn.)
    if (readOnlyChanged && row.status === 'running' && isPidAlive(row.runner_pid as number | null)) {
      return {
        ok: false,
        note: `session '${name}' is mid-turn — elpis.fleet.interrupt('${name}') first, then re-send with { readOnly: false }`,
      };
    }

 // A live runner with NO permission change → deliver in-place over the
 // held-or-reconnected conn. Never spawn a duplicate while the pid is alive.
    if (!readOnlyChanged) {
      let conn: Conn | null;
      try {
        conn = await ensureConn(id);
      } catch (e) {
        return { ok: false, note: `send to '${name}' failed: runner is alive but reconnecting to it failed: ${errMsg(e)}` };
      }
      if (conn) {
        try { writeOp(conn, { op: 'send', text }); } catch (e) {
          return { ok: false, note: `send to '${name}' failed: ${errMsg(e)}` };
        }
        return { ok: true, note: `delivered to ${name}` };
      }
    }

 // From here: REVIVE. Either the pid is dead, or we're lifting readOnly on
 // an idle live runner and just tore it down (below) to make the new
 // permission take effect.
    const sdkSessionId = row.sdk_session_id as string | null;
    if (sdkSessionId == null) {
 // Dead and unrevivable — no live pid to deliver into, and nothing to
 // resume from either. A masked {ok:false} here could silently no-op a
 // revive attempt, so this is loud like elpis.git's fail contract.
      throw new Error(`elpis.fleet.send: session '${name}' has no saved SDK session and no live runner — start a new session with elpis.fleet.run(...) or pass a revivable ref`);
    }

 // If lifting on an idle LIVE runner, tear it down first — the new options
 // only take effect on a fresh spawn. (A dead pid skips this — there's
 // nothing to kill.) This is the dismiss teardown path: graceful shutdown
 // over the held conn, else SIGTERM the group, escalating to SIGKILL.
    if (readOnlyChanged) {
      await teardownRunner(row);
    }

 // Record the lift in the session event log BEFORE the respawn — the only
 // safe window for the registry to author an events.jsonl line (no
 // concurrent runner writer; the next runner's initialSeq reads past it).
 // Modeled as an `event` frame (kind 'system'): handleFrame ignores it, and
 // tail renders it as '[<seq>] system: readOnly lifted by dispatcher'.
 // Advancing delivered_seq past this point also skips any stale trailing
 // `state:exited` from the torn-down runner — so the respawn's `running`
 // state frame isn't shadowed by a dead-pid `exited`.
    if (readOnlyChanged) {
      const seq = appendEventLog(id, { ev: 'event', kind: 'system', summary: 'readOnly lifted by dispatcher' });
      if (seq != null) advanceSeq(id, seq);
    }

 // Persist the new permission so it survives a FUTURE plain revive too.
    if (readOnlyOverride != null) touch(id, { read_only: readOnlyOverride ? 1 : 0 });

 // A revive re-reads the session's ORIGINAL model/effort off its row (''
 // meaning "was deliberately unset") but takes the CURRENT endpoint config
 // and re-resolves the context window — an operator who repoints
 // fleet.base_url or pins a context shouldn't have to abandon live sessions
 // to make it take effect.
    const revivedModel = toNullable(row.model);
    const config: RunnerConfig = {
      id, name, prompt: text, cwd: String(row.cwd),
      model: revivedModel, effort: toNullable(row.effort),
      readOnly: readOnlyOverride ?? storedReadOnly, worktree: Number(row.worktree_guidance) === 1,
      agentName: opts.agentName?.() ?? null,
      resume: sdkSessionId, idleTimeoutMs: fleet.idleTimeoutMs, env: fleet.env,
      endpoint: endpointConfig(),
      contextTokens: await resolveContextTokens(revivedModel),
    };
    fs.mkdirSync(sessionDirOf(id), { recursive: true });
    writeConfig(id, config);
    const pid = spawnRunner(id);
    touch(id, { runner_pid: pid, status: 'running', last_error: null });
    logger.info(`[fleet] revived ${name} (${id}) pid=${pid}${readOnlyChanged ? ` (readOnly: ${storedReadOnly}→${config.readOnly})` : ''}`);
    try {
 // Subscribe from the CURRENT delivered_seq, not the stale `row` snapshot
 // captured at the top of send. A readOnly-lift advanced delivered_seq
 // past its event-log line (which trails the torn-down runner's
 // `state:exited`); replaying from the stale offset would re-deliver that
 // `exited` and null out the just-spawned pid via applyState.
      const sinceSeq = Number((getById(id) ?? row).delivered_seq ?? 0);
      await openConn(id, path.join(sessionDirOf(id), 'ctl.sock'), sinceSeq);
    } catch (e) {
      touch(id, { status: 'failed', last_error: errMsg(e) });
      return { ok: false, note: `revive of '${name}' failed: ${errMsg(e)}` };
    }
    return { ok: true, note: readOnlyChanged ? `revived ${name} (readOnly lifted)` : `revived ${name}` };
  }

  async function interrupt(ref: string): Promise<{ ok: boolean; note: string }> {
    const row = getByRef(ref);
    if (!row) return { ok: false, note: `no fleet session '${ref}'` };
    const conn = conns.get(String(row.id));
    if (!conn || !isPidAlive(row.runner_pid as number | null)) return { ok: false, note: `session '${String(row.name)}' is not running` };
    try { writeOp(conn, { op: 'interrupt' }); } catch (e) {
      return { ok: false, note: `interrupt failed: ${errMsg(e)}` };
    }
    return { ok: true, note: `interrupt sent to ${String(row.name)}` };
  }

  function renderRow(row: SessionRow): Record<string, unknown> {
    return {
      id: row.id, name: row.name, status: row.status, cwd: row.cwd,
      model: row.model, effort: row.effort, readOnly: Number(row.read_only) === 1,
      pid: row.runner_pid, live: isLive(row), sdkSessionId: row.sdk_session_id,
      turns: row.turns, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      costUsd: row.cost_estimate_usd, deliveredSeq: row.delivered_seq,
      lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  function list(): Array<Record<string, unknown>> {
    return allSessions().map(renderRow);
  }

  function status(ref: string): Record<string, unknown> {
    const row = getByRef(ref);
    if (!row) return { ok: false, note: `no fleet session '${ref}'` };
    return renderRow(row);
  }

  function tail(ref: string, n = 20): string {
    const row = getByRef(ref);
    if (!row) return `no fleet session '${ref}'`;
    let content = '';
    try { content = fs.readFileSync(path.join(sessionDirOf(String(row.id)), 'events.jsonl'), 'utf8'); } catch { return '(no events yet)'; }
    const { frames } = parseFrames(content);
    const lines = frames.slice(-n).map((fr) => {
      const f = fr as RunnerFrame;
      switch (f.ev) {
        case 'turn-end': return `[${f.seq}] turn-end: ${(f.result ?? '').slice(0, 200)} (${f.usage.input}/${f.usage.output} tok, ~$${f.costUsd.toFixed(4)}, ${f.turns} turns)`;
        case 'mailbox': return `[${f.seq}] says: ${f.text}`;
        case 'worktree': return `[${f.seq}] worktree ${f.action}: ${f.name ?? ''} ${f.path}`.trim();
        case 'state': return `[${f.seq}] state: ${f.state}`;
        case 'fatal': return `[${f.seq}] fatal: ${f.error}`;
        case 'event': return `[${f.seq}] ${f.kind}: ${f.summary}`;
        default: return '';
      }
    });
    return lines.filter(Boolean).join('\n');
  }

  async function diff(ref: string, o: { worktree?: string; statOnly?: boolean; paths?: string[] } = {}): Promise<FleetDiff> {
    const row = getByRef(ref);
    if (!row) return { ok: false, session: ref, note: `no fleet session '${ref}'`, worktrees: [] };
    const name = String(row.name);
    const cwd = String(row.cwd);
    const head = await repoHead(cwd);
    let wts = (liveWorktreesStmt.all(String(row.id)) as SessionRow[])
      .filter((w) => fs.existsSync(String(w.path)));
    if (o.worktree != null) {
      wts = wts.filter((w) => String(w.name) === o.worktree);
      if (wts.length === 0) return { ok: false, session: name, note: `no worktree named '${o.worktree}'`, worktrees: [] };
    }
    if (wts.length === 0) {
      const d = await cwdDiff(cwd, { statOnly: o.statOnly, paths: o.paths });
      return { ok: true, session: name, note: 'no live worktrees — showing the session cwd diff', worktrees: [d] };
    }
    const worktrees = await Promise.all(
      wts.map((w) => worktreeDiff(String(w.name ?? '(unnamed)'), String(w.path), head, { statOnly: o.statOnly, paths: o.paths })),
    );
    return { ok: true, session: name, worktrees };
  }

  async function dismiss(ref: string, o: { force?: boolean; keepWorktree?: boolean } = {}): Promise<{ ok: boolean; note: string; stranded?: unknown }> {
    const row = getByRef(ref);
    if (!row) return { ok: false, note: `no fleet session '${ref}'` };
    const id = String(row.id);
    const name = String(row.name);
    if (row.status === 'dismissed') return { ok: true, note: `session '${name}' is already dismissed` };

 // Tear the runner down first. The gate is pidAlive ALONE — a live process
 // with no held socket must still be killed, else dismiss/worktree-removal
 // could race a runner that is still writing. (Shared with send's
 // readOnly-lift path — see teardownRunner.)
    await teardownRunner(row);

    const head = await repoHead(String(row.cwd));
    const liveWts = (liveWorktreesStmt.all(id) as SessionRow[])
      .filter((w) => fs.existsSync(String(w.path)));

    if (!o.force && !o.keepWorktree) {
      const stranded: Array<Record<string, unknown>> = [];
      for (const w of liveWts) {
        const st = await worktreeState(String(w.path), head);
        if (st.dirtyFiles.length > 0 || st.aheadCount > 0) {
          stranded.push({ name: w.name, path: w.path, dirtyFiles: st.dirtyFiles, aheadCount: st.aheadCount, aheadOneline: st.aheadOneline });
        }
      }
      if (stranded.length > 0) {
        touch(id, { status: 'idle', runner_pid: null }); // session survives the refusal
        const receipts = stranded
          .map((s) => `${s.name} (${s.path}): ${(s.dirtyFiles as string[]).length} dirty file(s), ${s.aheadCount} commit(s) ahead`)
          .join('; ');
        return {
          ok: false,
          note: `refusing to dismiss '${name}' — uncommitted/unmerged work: ${receipts}. Re-run with { force: true } to discard, or { keepWorktree: true } to keep the worktrees.`,
          stranded,
        };
      }
    }

    if (o.keepWorktree) {
      touch(id, { status: 'dismissed', runner_pid: null });
      logger.info(`[fleet] dismissed ${name} (${id}), worktrees kept`);
      return { ok: true, note: `dismissed '${name}', worktrees kept` };
    }

 // force OR clean → remove each worktree, stamp removed_at.
    for (const w of liveWts) {
      try {
        await removeWorktree(String(row.cwd), String(w.path));
      } catch (e) {
        logger.info(`[fleet] worktree remove failed for ${String(w.path)}: ${errMsg(e)}`);
      }
      worktreeRemoveStmt.run(Date.now(), id, String(w.path));
    }
    touch(id, { status: 'dismissed', runner_pid: null });
    logger.info(`[fleet] dismissed ${name} (${id})`);
    return { ok: true, note: `dismissed '${name}'` };
  }

 // ---- boot recovery ------------------------------------------------------
  function recover(): void {
    for (const row of allSessions()) {
      if (row.status === 'dismissed') continue;
      const id = String(row.id);
      const pid = row.runner_pid as number | null;
      if (isPidAlive(pid)) {
 // Live runner: reconnect + replay-from-offset through the same pipeline.
        void openConn(id, path.join(sessionDirOf(id), 'ctl.sock'), Number(row.delivered_seq ?? 0)).catch((e) => {
          logger.info(`[fleet] recover: reconnect to ${String(row.name)} failed: ${errMsg(e)}`);
        });
        continue;
      }
 // Dead runner: replay undelivered frames off disk, then classify the exit.
      recoverDead(id, row);
    }
    startReaper();
  }

  function recoverDead(id: string, row: SessionRow): void {
    let frames: unknown[] = [];
    try { frames = parseFrames(fs.readFileSync(path.join(sessionDirOf(id), 'events.jsonl'), 'utf8')).frames; } catch { /* no log */ }
    const delivered = Number(row.delivered_seq ?? 0);
    let replayedFatal = false;
    for (const fr of frames) {
      const f = fr as RunnerFrame;
      const seq = (f as { seq?: unknown }).seq;
      if (typeof seq === 'number' && seq > delivered) {
        if (f.ev === 'fatal') replayedFatal = true;
        handleFrame(id, f);
      }
    }
 // Clean exit iff the tail's last state frame is 'exited' and the last
 // non-exited state before it was 'idle'.
    const states = frames.map((f) => f as RunnerFrame).filter((f) => f.ev === 'state').map((f) => (f as Extract<RunnerFrame, { ev: 'state' }>).state);
    const nonExited = states.filter((s) => s !== 'exited');
    const cleanExit = states.length > 0 && states[states.length - 1] === 'exited' && nonExited.length > 0 && nonExited[nonExited.length - 1] === 'idle';
    if (cleanExit) {
      touch(id, { status: 'idle', runner_pid: null });
      return;
    }
    touch(id, { status: 'failed', runner_pid: null });
 // A replayed fatal frame already surfaced the failure via handleFrame —
 // don't double-notify. The runner died while the harness was down, so the
 // notice drops the "mid-turn" claim it can't substantiate here.
    if (replayedFatal) return;
    notify(
      `[fleet ${String(row.name)} runner died — last activity: ${lastEventSummary(id)}. ` +
        `elpis.fleet.send('${String(row.name)}', …) revives it from the saved session]`,
    );
  }

 // ---- reaper -------------------------------------------------------------
  function startReaper(): void {
    if (reaper) return;
    reaper = setInterval(() => { try { reapOnce(); } catch { /* never throw out of the timer */ } }, REAP_INTERVAL_MS);
    reaper.unref();
  }
  function reapOnce(): void {
    const cutoff = Date.now() - fleet.reapAfterMs;
    const rows = dismissedBeforeStmt.all('dismissed', cutoff) as SessionRow[];
    for (const row of rows) {
      const dir = sessionDirOf(String(row.id));
      if (fs.existsSync(dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); logger.info(`[fleet] reaped session dir ${String(row.id)}`); } catch { /* best effort */ }
      }
    }
  }

  function dispose(): void {
    if (reaper) { clearInterval(reaper); reaper = null; }
    for (const conn of conns.values()) {
      conn.intentional = true;
      try { conn.socket.destroy(); } catch { /* ignore */ }
    }
    conns.clear();
  }

  return { run, send, interrupt, list, status, tail, diff, dismiss, recover, dispose };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
