// runner-core.ts — the logic of a detached fleet session host, with all SDK
// *model-loop* access injected (deps.queryFn) so tests can drive the whole
// runner over a real control socket and real files without touching the SDK or
// the network. runner.ts is the thin entry that wires the real SDK `query`.
//
// A runner drives ONE Claude Agent SDK session. It speaks the protocol.ts wire
// format two ways at once: every frame it emits is FIRST appended to
// <sessionDir>/events.jsonl (durable — survives a harness restart, and is what
// the registry replays) and THEN written to every connected control socket
// (live tail). That ordering is the durability invariant: a frame a client saw
// is always already on disk.
//
// Seq continuity ("revive"): a runner started against a sessionDir that already
// has an events.jsonl resumes its seq counter from max(existing seq)+1, so the
// frame stream stays monotonic across a crash+respawn.
//
// The mailbox tool (`message` on the `dispatcher` MCP server) and the two
// worktree hooks (WorktreeCreate/WorktreeRemove) are built here — createSdkMcpServer
// / tool / z are imported directly. `createMailboxTool` is exported so the tool
// wiring is unit-testable without MCP request plumbing: its emit closure is the
// seam.
//
// Query responses (hello, status) are socket-only handshakes — they carry the
// current seq but are NOT appended to the log and do NOT consume a seq. On a new
// connection the runner backfills the durable log so a late-connecting viewer
// deterministically sees history (including the boot `starting` frame) before
// live frames.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  frameLine,
  parseFrames,
  type RunnerConfig,
  type RunnerEndpoint,
  type RunnerFrame,
  type RunnerOp,
  type RunnerState,
} from './protocol.js';

/** Minimal user-message shape fed to the SDK's streaming-input `prompt`. */
export interface SDKUserMessageLike {
  type: 'user';
  message: { role: 'user'; content: { type: 'text'; text: string }[] };
  parent_tool_use_id: null;
  session_id: string;
}

/** What the SDK `query()` returns: an async message stream with `.interrupt()`. */
export interface AsyncSDKQueryLike extends AsyncGenerator<unknown, void> {
  interrupt(): Promise<unknown>;
}

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessageLike>;
  options: Record<string, unknown>;
}) => AsyncSDKQueryLike;

export interface RunnerDeps {
  /** Holds runner-config.json; events.jsonl/state.json/ctl.sock are created here. */
  sessionDir: string;
  config: RunnerConfig;
  /** Production wraps the SDK `query()`; tests inject a scripted fake. */
  queryFn: QueryFn;
  now?: () => number;
}

// env keys copied from the ambient process into the child's REPLACED env. The
// two ANTHROPIC secret keys are deliberately absent and additionally stripped
// after the config.env merge — a fleet session authenticates via its own means,
// never by inheriting the harness's credentials.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'NODE_ENV'];
const ENV_NEVER = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/** config.endpoint.models alias → the env var the Agent SDK reads it from. */
const ALIAS_ENV: Record<keyof RunnerEndpoint['models'], string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/** The dispatcher-mailbox guidance appended to the preset system prompt. The
 * dispatcher is named from RunnerConfig.agentName (SOUL.md frontmatter,
 * resolved harness-side); the fallback covers configs written before the
 * field existed. */
export function buildGuidance(config: RunnerConfig): string {
  const dispatcher = config.agentName ?? 'the agent running this harness';
  const parts = [
    `You are a fleet coding agent dispatched by ${dispatcher}. Use the \`message\` tool on the \`dispatcher\` MCP server to report blockers, questions, and milestones without ending your turn.`,
  ];
  if (!config.readOnly) {
    parts.push(
      config.worktree
        ? "For repo-modifying work, create and enter a git worktree (EnterWorktree) unless your dispatcher's instructions say otherwise."
        : 'Do not use worktrees — work directly in your current directory.',
    );
  }
  return parts.join('\n\n');
}

/**
 * Build the child env, in four ordered layers:
 *
 * 1. allowlist base copied out of the harness's own `process.env`
 * 2. `fleet.env` from config.yaml, merged over it
 * 3. the ANTHROPIC secrets stripped UNCONDITIONALLY — neither the inherited
 * harness env nor `fleet.env` can hand the model subprocess a credential
 * 4. the dedicated `fleet.*` endpoint block applied LAST
 *
 * Step 3 before step 4 is the whole point: the harness's own credentials can
 * never reach a fleet session by inheritance or by an `env:` entry, but an
 * operator who deliberately fills in `fleet.api_key` / `fleet.auth_token` gets
 * exactly that key — a separate, explicitly-typed credential for the fleet
 * endpoint, not the harness's brain-LLM key leaking downward. A null field is left
 * unset entirely so the SDK falls back to its own default.
 */
export function buildEnv(config: RunnerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, config.env);
  for (const k of ENV_NEVER) delete env[k];

  const ep = config.endpoint;
  if (ep) {
    if (ep.baseUrl) env.ANTHROPIC_BASE_URL = ep.baseUrl;
    if (ep.apiKey) env.ANTHROPIC_API_KEY = ep.apiKey;
    if (ep.authToken) env.ANTHROPIC_AUTH_TOKEN = ep.authToken;
    for (const [alias, varName] of Object.entries(ALIAS_ENV) as [keyof RunnerEndpoint['models'], string][]) {
      const v = ep.models?.[alias];
      if (v) env[varName] = v;
    }
  }
 // Resolved harness-side for this session's model (explicit config or a
 // models/info probe). Process-wide for the subprocess, hence one value.
  if (config.contextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(config.contextTokens);
  return env;
}

/**
 * The dispatcher `message` tool. `emitMailbox` is the seam: in production it
 * appends+broadcasts a mailbox frame; in tests it's a spy. Returns the ack the
 * model sees. Does not end the turn.
 */
export function createMailboxTool(emitMailbox: (text: string) => void) {
  return tool(
    'message',
    'Send a short message to your dispatcher (progress, blockers, questions). Does not end your turn.',
    { text: z.string() },
    async ({ text }) => {
      emitMailbox(text);
      return { content: [{ type: 'text' as const, text: 'delivered to dispatcher' }] };
    },
  );
}

/** Highest seq in an existing events.jsonl, +1; 1 when none/unreadable. */
function initialSeq(eventsPath: string): number {
  try {
    const { frames } = parseFrames(fs.readFileSync(eventsPath, 'utf8'));
    let max = 0;
    for (const f of frames) {
      const s = (f as { seq?: unknown }).seq;
      if (typeof s === 'number' && s > max) max = s;
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/** `git worktree list --porcelain` in cwd → absolute worktree paths ([] on any error). */
function listWorktrees(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim());
  } catch {
    return [];
  }
}

function repoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return cwd;
  }
}

/** An async queue that feeds the SDK streaming-input `prompt` iterable. */
class InputQueue {
  private items: SDKUserMessageLike[] = [];
  private resolvers: ((r: IteratorResult<SDKUserMessageLike>) => void)[] = [];
  private closed = false;

  get length(): number {
    return this.items.length;
  }

  push(text: string): void {
    const msg: SDKUserMessageLike = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    };
    const r = this.resolvers.shift();
    if (r) r({ value: msg, done: false });
    else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length) this.resolvers.shift()!({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessageLike> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessageLike>>((res) => this.resolvers.push(res));
      if (next.done) return;
      yield next.value;
    }
  }
}

/**
 * Run a detached fleet session. Resolves on graceful shutdown (shutdown op or
 * idle timeout); rejects if the model loop throws (after emitting a `fatal`
 * frame). runner.ts maps the rejection to exit 1.
 */
export async function runRunner(deps: RunnerDeps): Promise<void> {
  const { sessionDir, config, queryFn } = deps;
  const now = deps.now ?? Date.now;
  const eventsFile = path.join(sessionDir, 'events.jsonl');
  const stateFile = path.join(sessionDir, 'state.json');
  const sockPath = path.join(sessionDir, 'ctl.sock');

  let seq = initialSeq(eventsFile);
  let state: RunnerState = 'starting';
  let sdkSessionId: string | null = config.resume ?? null;
  const worktrees: string[] = [];
  const usage = { input: 0, output: 0, costUsd: 0, turns: 0 };

 // `sockets` holds every open connection (subscribed or not) so teardown can
 // destroy them all — an untracked open socket would keep server.close from
 // ever firing. A socket in `clients` is subscribed and fully caught up — it
 // receives live frames directly. A socket in `buffering` is mid-subscribe
 // (its durable replay is in flight): live frames emitted during the async
 // file read are parked in its buffer and flushed (de-duped by seq) once the
 // replay lands.
  const sockets = new Set<net.Socket>();
  const clients = new Set<net.Socket>();
  const buffering = new Map<net.Socket, string[]>();
  const queue = new InputQueue();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let currentQuery: AsyncSDKQueryLike | null = null;
  let finished = false;
  let done = false;

  let resolveRun!: () => void;
  let rejectRun!: (e: unknown) => void;
  const runPromise = new Promise<void>((res, rej) => {
    resolveRun = res;
    rejectRun = rej;
  });

  const bootWorktrees = listWorktrees(config.cwd);

  function writeStateJson(): void {
    const snap = {
      state,
      sdkSessionId,
      seq,
      worktrees: [...worktrees],
      usage: { ...usage },
      updatedAt: now(),
    };
    try {
      fs.writeFileSync(stateFile, JSON.stringify(snap) + '\n');
    } catch {
      /* state.json is best-effort — a write failure never takes down the runner */
    }
  }

 // Durability first: append to the log, THEN fan out to sockets. The append is
 // guarded — an ENOSPC (or any fs error) must NEVER throw out of emit: a
 // throw here on the fatal path would escape as an unhandled rejection and
 // orphan the runner holding ctl.sock. On append failure we degrade to
 // broadcast-only.
  function emit(frame: RunnerFrame): void {
    const line = frameLine(frame);
    try {
      fs.appendFileSync(eventsFile, line);
    } catch {
      /* durability lost — degrade to broadcast-only, never throw */
    }
    for (const c of clients) {
      try {
        c.write(line);
      } catch {
        /* a broken socket is dropped on its own 'error'/'close' */
      }
    }
 // Mid-subscribe sockets buffer live frames until their replay flushes.
    for (const buf of buffering.values()) buf.push(line);
  }

  function setState(s: RunnerState): void {
    state = s;
    emit({ ev: 'state', seq: seq++, state: s });
    writeStateJson();
  }

  function clearIdle(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdle(): void {
    clearIdle();
    if (config.idleTimeoutMs > 0) idleTimer = setTimeout(() => void finish(), config.idleTimeoutMs);
  }

  async function closeServerAndSockets(): Promise<void> {
    queue.close();
 // Stop the model loop best-effort, but NEVER await it: the SDK Query exposes
 // a synchronous close that kills the subprocess; a bare async generator
 // parked on an await would make `.return` hang forever, so we only
 // fire-and-forget it. A parked generator holds no live handle, so it can't
 // keep the process alive once the server + sockets are gone.
    const q = currentQuery as unknown as { close?: () => void; return?: (v?: unknown) => unknown } | null;
    try {
      if (typeof q?.close === 'function') q.close();
      else void q?.return?.(undefined);
    } catch {
      /* best effort */
    }
    for (const c of sockets) {
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
    clients.clear();
    buffering.clear();
    await new Promise<void>((res) => server.close(() => res()));
  }

 // finish and fail are the two terminal paths — graceful exit vs a fatal
 // model-loop error — and differ only in whether a `fatal` frame is emitted
 // before the shared exit sequence and whether runPromise resolves or
 // rejects. `failure` is wrapped so an explicit `undefined` error still takes
 // the failure branch (distinguishing "no error" from "errored with
 // undefined" — an edge case, but terminate must not guess).
  async function terminate(failure?: { err: unknown }): Promise<void> {
    if (finished) return;
    finished = true;
    done = true;
    clearIdle();
    if (failure) {
      const { err } = failure;
      emit({ ev: 'fatal', seq: seq++, error: err instanceof Error ? err.message : String(err) });
    }
    setState('exited');
    await closeServerAndSockets();
    if (failure) rejectRun(failure.err);
    else resolveRun();
  }

  async function finish(): Promise<void> {
    await terminate();
  }

  async function fail(err: unknown): Promise<void> {
    await terminate({ err });
  }

  function emitWorktree(action: 'create' | 'remove', name: string | null, wtPath: string): void {
    if (action === 'create') {
      if (!worktrees.includes(wtPath)) worktrees.push(wtPath);
    } else {
      const i = worktrees.indexOf(wtPath);
      if (i >= 0) worktrees.splice(i, 1);
    }
    emit({ ev: 'worktree', seq: seq++, action, name, path: wtPath });
    writeStateJson();
  }

 // Resolve the path of a just-created worktree: diff the live list against the
 // boot snapshot (prefer a fresh entry whose basename matches `name`), else a
 // name-match against the full list, else the conventional layout path.
  function resolveCreatedWorktree(name: string): string {
    const current = listWorktrees(config.cwd);
    const fresh = current.filter((p) => !bootWorktrees.includes(p));
    const freshByName = fresh.find((p) => path.basename(p) === name);
    if (freshByName) return freshByName;
    if (fresh.length === 1) return fresh[0];
    const anyByName = current.find((p) => path.basename(p) === name);
    if (anyByName) return anyByName;
    return path.join(repoRoot(config.cwd), '.claude', 'worktrees', name);
  }

  function assistantSummary(msg: Record<string, unknown>): string {
    const message = msg.message as { content?: unknown } | undefined;
    const content = message?.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content
        .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
        .map((b) => String((b as { text?: unknown }).text ?? ''))
        .join(' ');
    } else if (typeof content === 'string') {
      text = content;
    }
    return text.slice(0, 200);
  }

 // Terse human label for a non-init `system` message's subtype — keeps the
 // genuinely useful system events (status/api_retry/...) visible in the tail
 // while distinguishing them from each other. Only the high-volume chatter
 // (thinking_tokens — one per thinking-delta chunk on reasoning models) is
 // dropped outright; see handleMessage.
  function systemDetail(msg: Record<string, unknown>): string {
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'system';
    let detail = '';
    if (subtype === 'status') {
 // SDKStatusMessage: status is 'compacting'|'requesting'|null; a compact
 // attempt also carries a compact_result/compact_error pair.
      const status = typeof msg.status === 'string' ? msg.status : '';
      const result = typeof msg.compact_result === 'string' ? msg.compact_result : '';
      detail = [status, result].filter(Boolean).join(': ');
    } else if (subtype === 'api_retry') {
      const attempt = typeof msg.attempt === 'number' ? msg.attempt : '';
      const max = typeof msg.max_retries === 'number' ? msg.max_retries : '';
      const http = typeof msg.error_status === 'number' ? msg.error_status : '';
      detail = [attempt !== '' ? `attempt ${attempt}/${max || '?'}` : '', http !== '' ? `http ${http}` : '']
        .filter(Boolean).join(' ');
    }
    return `system/${subtype}${detail ? `: ${detail}` : ''}`;
  }

  function handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;

    if (m.type === 'system' && m.subtype === 'init') {
      if (typeof m.session_id === 'string') sdkSessionId = m.session_id;
      const model = typeof m.model === 'string' ? m.model : '';
      emit({ ev: 'event', seq: seq++, kind: 'system', summary: `init ${model}`.trim() });
      writeStateJson();
      return;
    }
    if (m.type === 'assistant') {
      emit({ ev: 'event', seq: seq++, kind: 'assistant', summary: assistantSummary(m) });
      return;
    }
    if (m.type === 'result') {
      const isError = Boolean(m.is_error);
      const result =
        m.subtype === 'success'
          ? String(m.result ?? '')
          : (Array.isArray(m.errors) ? (m.errors as unknown[]).join('\n') : '') ||
            `[${String(m.subtype)}${m.stop_reason ? `: ${String(m.stop_reason)}` : ''}]`;
      const u = (m.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      usage.input = u.input_tokens ?? 0;
      usage.output = u.output_tokens ?? 0;
      usage.costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0;
      usage.turns = typeof m.num_turns === 'number' ? m.num_turns : 0;
      if (typeof m.session_id === 'string') sdkSessionId = m.session_id;
      emit({
        ev: 'turn-end',
        seq: seq++,
        result,
        isError,
        usage: { input: usage.input, output: usage.output },
        costUsd: usage.costUsd,
        turns: usage.turns,
        sdkSessionId,
      });
      setState('idle');
      if (queue.length === 0) armIdle();
      return;
    }
    if (m.type === 'stream_event') return; // partials are noise — skip
 // The SDK emits a large `type:'system'` family. `init` is handled above;
 // `thinking_tokens` is per-thinking-delta-chunk spinner progress (fires
 // constantly on reasoning models — it flooded the log with identical
 // 'other: system' lines), so drop it like a stream_event partial. The
 // remaining subtypes (status / api_retry / ...) carry useful signal, so
 // keep them but label the subtype so they're distinguishable in the tail.
    if (m.type === 'system') {
      if (m.subtype === 'thinking_tokens') return; // noise — see above
      emit({ ev: 'event', seq: seq++, kind: 'system', summary: systemDetail(m) });
      return;
    }
 // Truly unknown type: still log it, but include the subtype when present so
 // a future SDK message doesn't collapse back into one opaque string.
    const t = typeof m.type === 'string' ? m.type : 'other';
    const sub = typeof m.subtype === 'string' ? `/${m.subtype}` : '';
    emit({ ev: 'event', seq: seq++, kind: 'other', summary: `${t}${sub}` });
  }

 // Offset-handshake replay: park live frames while reading the durable log
 // once (off the hot path), replay frames with seq > sinceSeq, then flush the
 // parked live frames de-duped by seq, then go fully live. All work after the
 // single await is synchronous, so no frame can interleave — no gap, no dupe.
  async function handleSubscribe(sock: net.Socket, sinceSeq: number): Promise<void> {
    if (clients.has(sock) || buffering.has(sock)) return; // idempotent
    const since = typeof sinceSeq === 'number' ? sinceSeq : 0;
    const buffer: string[] = [];
    buffering.set(sock, buffer);
    let content = '';
    try {
      content = await fs.promises.readFile(eventsFile, 'utf8');
    } catch {
      /* no durable log yet / unreadable → nothing to replay */
    }
    if (!buffering.has(sock)) return; // socket hung up during the read
    const sentSeqs = new Set<number>();
    for (const fr of parseFrames(content).frames) {
      const s = (fr as { seq?: unknown }).seq;
      if (typeof s === 'number' && s > since) {
        try {
          sock.write(frameLine(fr as RunnerFrame));
        } catch {
          /* dropped on its own error/close */
        }
        sentSeqs.add(s);
      }
    }
    for (const line of buffer) {
      let s: unknown;
      try {
        s = (JSON.parse(line) as { seq?: unknown }).seq;
      } catch {
        s = undefined;
      }
      if (typeof s === 'number' && s > since && !sentSeqs.has(s)) {
        try {
          sock.write(line);
        } catch {
          /* dropped */
        }
      }
    }
    buffering.delete(sock);
    clients.add(sock);
  }

  function handleOp(op: RunnerOp, sock: net.Socket): void {
    switch (op.op) {
      case 'subscribe':
        void handleSubscribe(sock, op.sinceSeq);
        break;
      case 'send':
        clearIdle();
        if (state === 'idle') setState('running');
        queue.push(op.text);
        break;
      case 'interrupt':
        void currentQuery?.interrupt().catch(() => {});
        break;
      case 'status':
 // Query response: socket-only, reports current seq, not appended/logged.
        try {
          sock.write(frameLine({ ev: 'state', seq, state }));
        } catch {
          /* ignore */
        }
        break;
      case 'shutdown':
        void finish();
        break;
    }
  }

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
 // A fresh connection gets ONLY hello (carrying the current seq). No live
 // frames flow until the client sends `{op:'subscribe', sinceSeq}` — see
 // handleSubscribe. This keeps the durable-log read off the hot path and
 // lets a reconnecting client resume from an offset without a gap or dupe.
    try {
      sock.write(frameLine({ ev: 'hello', id: config.id, pid: process.pid, seq, state }));
    } catch {
      /* a client that hangs up mid-greeting is fine */
    }
    sockets.add(sock);
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const { frames, rest } = parseFrames(buf);
      buf = rest;
      for (const fr of frames) {
        if (fr && typeof fr === 'object' && typeof (fr as { op?: unknown }).op === 'string') {
          handleOp(fr as RunnerOp, sock);
        }
      }
    });
    const onSockGone = (): void => {
      sockets.delete(sock);
      clients.delete(sock);
      buffering.delete(sock);
    };
    sock.on('close', onSockGone);
    sock.on('error', onSockGone);
  });

  const dispatcher = createSdkMcpServer({
    name: 'dispatcher',
    version: '1.0.0',
    tools: [createMailboxTool((text) => emit({ ev: 'mailbox', seq: seq++, text }))],
  });

  const hooks = {
    WorktreeCreate: [
      {
        hooks: [
          async (input: unknown) => {
            const name = (input as { name?: unknown })?.name;
            const nm = typeof name === 'string' ? name : null;
            emitWorktree('create', nm, resolveCreatedWorktree(nm ?? ''));
            return { continue: true };
          },
        ],
      },
    ],
    WorktreeRemove: [
      {
        hooks: [
          async (input: unknown) => {
            const p = (input as { worktree_path?: unknown })?.worktree_path;
            emitWorktree('remove', null, typeof p === 'string' ? p : '');
            return { continue: true };
          },
        ],
      },
    ],
  };

 // `model`/`effort` are OMITTED (not set to undefined) when config leaves them
 // null, so an un-configured harness hands the SDK no opinion at all and it
 // applies its own defaults — and a custom endpoint with no effort parameter
 // never receives one.
  const options: Record<string, unknown> = {
    cwd: config.cwd,
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    env: buildEnv(config),
    permissionMode: config.readOnly ? 'dontAsk' : 'bypassPermissions',
    allowedTools: config.readOnly ? ['Read', 'Glob', 'Grep'] : undefined,
    resume: config.resume ?? undefined,
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: buildGuidance(config) },
    mcpServers: { dispatcher },
    hooks,
  };

  async function pump(): Promise<void> {
    try {
      currentQuery = queryFn({ prompt: queue, options });
      setState('running');
      for await (const msg of currentQuery) {
        if (done) break;
        handleMessage(msg);
      }
 // The SDK generator ended on its own (SDK-side termination / CLI exit).
 // Nothing else will settle runPromise — take the graceful finish path so
 // the detached process doesn't orphan holding ctl.sock.
      if (!finished) await finish();
    } catch (err) {
      await fail(err);
    }
  }

 // Boot: clear a stale socket, append the `starting` frame, then listen.
  try {
    fs.rmSync(sockPath, { force: true });
  } catch {
    /* nothing to remove */
  }
  await new Promise<void>((res, rej) => {
    const onErr = (e: unknown) => rej(e);
    server.once('error', onErr);
    server.listen(sockPath, () => {
      server.removeListener('error', onErr);
      res();
    });
  });
  setState('starting');
  if (config.prompt) queue.push(config.prompt);
  void pump();
  return runPromise;
}
