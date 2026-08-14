// protocol.ts — wire protocol shared by the fleet runner process and the
// harness-side registry. A runner is a detached child process driving a
// Claude Agent SDK session; it speaks this protocol two ways at once: every
// frame it emits is both appended to <sessionDir>/events.jsonl (durable,
// survives a harness restart) AND written to its control socket (live tail).
// Both are newline-delimited JSON (ndjson) — one JSON object per line.
//
// RunnerOp is the inbound half: what the harness can ask a running session
// to do over the socket (subscribe to the frame stream, send it a message,
// interrupt, ask for status, or shut down).
//
// A fresh connection receives ONLY a `hello` frame (which carries the runner's
// current seq); it then sends `{op:'subscribe', sinceSeq}` and the runner
// replays every durable frame with seq > sinceSeq followed by live frames from
// that point on. Until it subscribes a client receives no live frames — the
// offset handshake lets a reconnecting client resume without a gap or a
// duplicate (`sinceSeq: 0` requests the full log).
//
// parseFrames is deliberately lenient: a line that fails to JSON.parse is
// SKIPPED rather than thrown. events.jsonl is an append-only log a reader may
// open mid-write (the writer's last line can be a torn partial write across a
// process crash or a concurrent read); a single corrupt line must never take
// down the reader or wedge replay of everything after it. Frame shapes are
// NOT validated here — callers get `unknown[]` and narrow with their own
// type guards.

export type RunnerState = 'starting' | 'running' | 'idle' | 'exited';

export type RunnerOp =
  | { op: 'subscribe'; sinceSeq: number }
  | { op: 'send'; text: string }
  | { op: 'interrupt' }
  | { op: 'status' }
  | { op: 'shutdown' };

export type RunnerFrame =
  | { ev: 'hello'; id: string; pid: number; seq: number; state: RunnerState }
  | { ev: 'event'; seq: number; kind: 'assistant' | 'system' | 'tool' | 'other'; summary: string }
  | { ev: 'mailbox'; seq: number; text: string }
  | {
      ev: 'turn-end';
      seq: number;
      result: string;
      isError: boolean;
      usage: { input: number; output: number };
      costUsd: number;
      turns: number;
      sdkSessionId: string | null;
    }
  | { ev: 'worktree'; seq: number; action: 'create' | 'remove'; name: string | null; path: string }
  | { ev: 'state'; seq: number; state: RunnerState }
  | { ev: 'fatal'; seq: number; error: string };

/**
 * Endpoint + model-alias overrides for the SDK subprocess, sourced from
 * `fleet.base_url` / `fleet.api_key` / `fleet.auth_token` / `fleet.models` in
 * config.yaml. Every field is nullable and a null field is simply NOT SET in
 * the child env — an un-configured harness hands the Agent SDK nothing and it
 * uses its own endpoint, credentials, and alias table. See buildEnv.
 */
export interface RunnerEndpoint {
  /** → ANTHROPIC_BASE_URL */
  baseUrl: string | null;
  /** → ANTHROPIC_API_KEY */
  apiKey: string | null;
  /** → ANTHROPIC_AUTH_TOKEN */
  authToken: string | null;
  /** → ANTHROPIC_DEFAULT_<ALIAS>_MODEL, per alias. Names only — an alias's
 * `context` is not sent here; it is resolved harness-side into
 * RunnerConfig.contextTokens for the ONE model this session runs. */
  models: { opus: string | null; sonnet: string | null; haiku: string | null; fable: string | null };
}

/** Written by the harness as <sessionDir>/runner-config.json before spawning a
 * runner. May carry an API key (`endpoint.apiKey`), so the registry writes it
 * 0600 — see writeConfig in index.ts. */
export interface RunnerConfig {
  id: string;
  name: string;
  /** Initial prompt (fresh run) or pending message (revive-with-send). */
  prompt: string | null;
  cwd: string;
  /** null → `options.model` is not sent; the SDK picks its own default. */
  model: string | null;
  /** Validated against `fleet.efforts` harness-side, so it is a free string
 * here (a custom endpoint may name its levels differently). null →
 * `options.effort` is not sent. */
  effort: string | null;
  readOnly: boolean;
  /** false → the runner emits an affirmative "don't use worktrees" line. */
  worktree: boolean;
  /** The dispatching agent's name (SOUL.md frontmatter, resolved harness-side
 * at spawn) — rendered into the runner's dispatch guidance. Optional so a
 * runner-config.json written before this field existed still parses. */
  agentName?: string | null;
  /** SDK session id to resume, if any. */
  resume: string | null;
  idleTimeoutMs: number;
  /** fleet.env from config, merged over the allowlist base. */
  env: Record<string, string>;
  /** Endpoint/credential/alias overrides applied AFTER the env scrub. */
  endpoint: RunnerEndpoint;
  /**
 * Context window (tokens) for THIS session's model → CLAUDE_CODE_MAX_CONTEXT_TOKENS.
 * Resolved ONCE harness-side at spawn (an explicit `fleet.models.<alias>.context`,
 * else a `models/info` probe), not a mirror of config: the env var is
 * process-wide for the SDK subprocess, so it describes the one model the
 * session starts on. null = don't set it; the SDK uses its own figure.
 */
  contextTokens: number | null;
}

/** Serialize one frame as a single ndjson line (JSON + trailing '\n'). */
export function frameLine(f: RunnerFrame): string {
  return JSON.stringify(f) + '\n';
}

/**
 * Split a buffer of ndjson text into complete parsed frames plus the
 * trailing partial line (if the buffer doesn't end on a newline). A line
 * that fails to JSON.parse is silently skipped — see header for why.
 */
export function parseFrames(buf: string): { frames: unknown[]; rest: string } {
  const lines = buf.split('\n');
  const rest = lines.pop() ?? '';
  const frames: unknown[] = [];
  for (const line of lines) {
    if (line === '') continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
 // Skip a torn/corrupt line — never throw out of a streaming parse.
    }
  }
  return { frames, rest };
}
