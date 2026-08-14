// Unit tests for src/fleet/runner-core.ts. Drives runRunner in-process with a
// scripted fake queryFn (no real SDK / no network), over a real unix control
// socket and real files under os.tmpdir. Each of the runner's 10 behavior
// contract points (plus the mailbox tool and the worktree hooks) gets a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { RunnerConfig } from '../src/fleet/protocol.js';
import { runRunner, createMailboxTool, buildEnv, type QueryFn } from '../src/fleet/runner-core.js';

// ---- helpers ---------------------------------------------------------------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkdir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runner-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

const sock = (dir: string) => path.join(dir, 'ctl.sock');
const eventsPath = (dir: string) => path.join(dir, 'events.jsonl');

function cfg(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    id: 's1', name: 'sess', prompt: null, cwd: process.cwd(), model: 'claude-x',
    effort: 'medium', readOnly: false, worktree: true, resume: null,
    idleTimeoutMs: 0, env: {},
    endpoint: { baseUrl: null, apiKey: null, authToken: null, models: NO_ALIASES },
    contextTokens: null,
    ...over,
  };
}

const NO_ALIASES = { opus: null, sonnet: null, haiku: null, fable: null };

async function waitForFile(p: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(p)) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for ' + p);
    await delay(10);
  }
}

async function waitUntil(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await delay(10);
  }
}

function readFrames(dir: string): any[] {
  const raw = fs.readFileSync(eventsPath(dir), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A live control-socket client that collects inbound frames and can send ops.
function connect(sockPath: string) {
  const socket = net.createConnection(sockPath);
  socket.setEncoding('utf8');
  const frames: any[] = [];
  let buf = '';
  const listeners: (() => void)[] = [];
  socket.on('data', (chunk: string) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) { if (!p) continue; try { frames.push(JSON.parse(p)); } catch { /* skip */ } }
    listeners.forEach((l) => l());
  });
  return {
    socket,
    frames,
    send(op: unknown) { socket.write(JSON.stringify(op) + '\n'); },
    subscribe(sinceSeq = 0) { socket.write(JSON.stringify({ op: 'subscribe', sinceSeq }) + '\n'); },
    waitFor(pred: (f: any[]) => boolean, ms = 3000): Promise<void> {
      return new Promise<void>((res, rej) => {
        const check = () => { if (pred(frames)) { cleanup(); res(); } };
        const to = setTimeout(() => { cleanup(); rej(new Error('socket waitFor timed out; frames=' + JSON.stringify(frames))); }, ms);
        const cleanup = () => { clearTimeout(to); const i = listeners.indexOf(check); if (i >= 0) listeners.splice(i, 1); };
        listeners.push(check);
        check();
      });
    },
    close() { socket.destroy(); },
  };
}

// A programmable async channel: the test controls exactly what the model loop
// yields (push), when it ends (end), and whether it throws (fail).
class Chan<T> {
  private q: T[] = [];
  private pending: { res: (r: IteratorResult<T>) => void; rej: (e: unknown) => void }[] = [];
  private ended = false;
  private err: unknown = null;
  push(v: T) { const p = this.pending.shift(); if (p) p.res({ value: v, done: false }); else this.q.push(v); }
  end() { this.ended = true; while (this.pending.length) this.pending.shift()!.res({ value: undefined as never, done: true }); }
  fail(e: unknown) { this.err = e; const p = this.pending.shift(); if (p) p.rej(e); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.q.length) { yield this.q.shift()!; continue; }
      if (this.err) throw this.err;
      if (this.ended) return;
      const v = await new Promise<IteratorResult<T>>((res, rej) => this.pending.push({ res, rej }));
      if (v.done) return;
      yield v.value;
    }
  }
}

function makeFake() {
  const record = { options: null as any, received: [] as string[], interrupts: 0 };
  const out = new Chan<any>();
  const queryFn: QueryFn = ({ prompt, options }) => {
    record.options = options;
 // Drain user messages so `send`/initial-prompt delivery is observable.
    void (async () => {
      try { for await (const um of prompt) record.received.push(um.message.content[0].text); } catch { /* ended */ }
    })();
    const gen = (async function* () { for await (const m of out) yield m; })();
    (gen as any).interrupt = async () => { record.interrupts++; };
    return gen as any;
  };
  return { queryFn, record, out };
}

function initMsg() { return { type: 'system', subtype: 'init', session_id: 'sdk-123', model: 'claude-x', cwd: '/x', tools: [] }; }
function asstMsg(text: string) { return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: 'sdk-123', uuid: 'a1' }; }
function resultMsg(over: Record<string, unknown> = {}) {
  return {
    type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2,
    total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn',
    session_id: 'sdk-123', uuid: 'u1', ...over,
  };
}

// The SDK's `type:'system'` family (other than `init`). `thinking_tokens`
// fires once per thinking-delta chunk on reasoning models — the spam source.
// `status` (compacting/requesting) and `api_retry` carry real signal.
function thinkingTokensMsg(over: Record<string, unknown> = {}) {
  return { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42, estimated_tokens_delta: 5, session_id: 'sdk-123', uuid: 't1', ...over };
}
function statusMsg(status: string, over: Record<string, unknown> = {}) {
  return { type: 'system', subtype: 'status', status, session_id: 'sdk-123', uuid: 's1', ...over };
}
function apiRetryMsg(over: Record<string, unknown> = {}) {
  return { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 500, error_status: 429, error: { message: 'rate limited' }, session_id: 'sdk-123', uuid: 'r1', ...over };
}

function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

function makeRepo(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runner-repo-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'a@test.com']);
  git(root, ['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'hi\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

// ---- tests -----------------------------------------------------------------

// Contract 1: boot writes hello + starting.
test('boot: a connecting client receives hello + starting frames', async (t) => {
  const dir = mkdir(t);
  const { queryFn } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  await c.waitFor((f) => f.some((x) => x.ev === 'hello'));
  const hello = c.frames.find((x) => x.ev === 'hello');
  assert.equal(hello.id, 's1');
  assert.equal(typeof hello.pid, 'number');
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'state' && x.state === 'starting'));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract (offset handshake): no live frames until subscribe; subscribe(0)
// replays the whole durable log with no duplicate seqs.
test('a connecting client receives only hello until it subscribes', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  await c.waitFor((f) => f.some((x) => x.ev === 'hello'));
 // Live activity happens, but an unsubscribed client must not see any of it.
  out.push(initMsg());
  out.push(resultMsg());
  await delay(150);
  assert.ok(c.frames.every((x) => x.ev === 'hello'), 'only hello before subscribe: ' + JSON.stringify(c.frames));
 // Subscribe from 0 → full durable replay (starting/running/... turn-end).
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'turn-end') && f.some((x) => x.ev === 'state' && x.state === 'starting'));
  const seqs = c.frames.filter((x) => x.ev !== 'hello').map((x) => x.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seqs across replay + live: ' + JSON.stringify(seqs));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 2: initial prompt is enqueued to the model iterable.
test('initial prompt is enqueued to the model iterable', async (t) => {
  const dir = mkdir(t);
  const { queryFn, record } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg({ prompt: 'hello world' }), queryFn });
  await waitForFile(sock(dir));
  await waitUntil(() => record.received.includes('hello world'));
  const c = connect(sock(dir));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 3: options passed to queryFn (writable session).
test('options match the contract for a writable, worktree session', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'secret-should-not-leak';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const dir = mkdir(t);
  const { queryFn, record } = makeFake();
  const run = runRunner({
    sessionDir: dir,
    config: cfg({ readOnly: false, worktree: true, model: 'claude-y', effort: 'high', resume: 'r1', env: { FOO: 'bar' } }),
    queryFn,
  });
  await waitForFile(sock(dir));
  await waitUntil(() => record.options != null);
  const o = record.options;
  assert.equal(o.model, 'claude-y');
  assert.equal(o.effort, 'high');
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowedTools, undefined);
  assert.equal(o.resume, 'r1');
  assert.deepEqual(o.settingSources, ['project']);
  assert.equal(o.env.FOO, 'bar');
  assert.equal(o.env.PATH, process.env.PATH);
  assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(o.systemPrompt.type, 'preset');
  assert.equal(o.systemPrompt.preset, 'claude_code');
  assert.match(o.systemPrompt.append, /dispatcher/);
  assert.match(o.systemPrompt.append, /EnterWorktree/);
  assert.ok(o.mcpServers.dispatcher);
  assert.ok(Array.isArray(o.hooks.WorktreeCreate));
  assert.ok(Array.isArray(o.hooks.WorktreeRemove));
  const c = connect(sock(dir));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// ---- endpoint / alias / effort overrides (buildEnv layering) ---------------
// The unit under test is buildEnv's four-layer order: allowlist base →
// fleet.env → unconditional ANTHROPIC scrub → the explicit fleet endpoint
// block. Only the last layer may set a credential.

test('buildEnv: an unset endpoint hands the SDK nothing (no ANTHROPIC_* at all)', () => {
  process.env.ANTHROPIC_API_KEY = 'harness-secret';
  process.env.ANTHROPIC_AUTH_TOKEN = 'harness-token';
  try {
    const env = buildEnv(cfg());
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
    assert.equal(env.PATH, process.env.PATH, 'allowlist base still applies');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test('buildEnv: the configured endpoint block sets base_url/key/token', () => {
  const env = buildEnv(cfg({
    endpoint: { baseUrl: 'https://api.example.com', apiKey: 'sk-fleet', authToken: 'tok', models: NO_ALIASES },
  }));
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.example.com');
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-fleet');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok');
});

test('buildEnv: model aliases map to ANTHROPIC_DEFAULT_<ALIAS>_MODEL, nulls omitted', () => {
  const env = buildEnv(cfg({
    endpoint: {
      baseUrl: null, apiKey: null, authToken: null,
      models: { opus: 'big-1', sonnet: null, haiku: 'small-1', fable: 'story-1' },
    },
  }));
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big-1');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small-1');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'story-1');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined, 'a null alias is left to the SDK');
});

test('buildEnv: the harness key never survives, but the explicit fleet key does', () => {
  process.env.ANTHROPIC_API_KEY = 'harness-secret';
  try {
 // fleet.env still cannot smuggle a credential through — layer 3 scrubs it.
    const viaEnv = buildEnv(cfg({ env: { ANTHROPIC_API_KEY: 'sneaky', ANTHROPIC_AUTH_TOKEN: 'sneaky2' } }));
    assert.equal(viaEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(viaEnv.ANTHROPIC_AUTH_TOKEN, undefined);
 // ...and the dedicated block wins over both the inherited and fleet.env values.
    const viaEndpoint = buildEnv(cfg({
      env: { ANTHROPIC_API_KEY: 'sneaky' },
      endpoint: { baseUrl: null, apiKey: 'sk-fleet', authToken: null, models: NO_ALIASES },
    }));
    assert.equal(viaEndpoint.ANTHROPIC_API_KEY, 'sk-fleet');
    assert.notEqual(viaEndpoint.ANTHROPIC_API_KEY, 'harness-secret');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('buildEnv: contextTokens becomes CLAUDE_CODE_MAX_CONTEXT_TOKENS; null omits it', () => {
  assert.equal(buildEnv(cfg({ contextTokens: 262144 })).CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
  assert.equal(buildEnv(cfg({ contextTokens: null })).CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test('buildEnv: a pre-endpoint runner-config.json (no endpoint field) still builds', () => {
  const legacy = cfg();
  delete (legacy as Partial<RunnerConfig>).endpoint;
  const env = buildEnv(legacy);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('null model/effort are OMITTED from the SDK options, not sent as undefined', async (t) => {
  const dir = mkdir(t);
  const { queryFn, record } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg({ model: null, effort: null }), queryFn });
  await waitForFile(sock(dir));
  await waitUntil(() => record.options != null);
  const o = record.options;
  assert.ok(!('model' in o), 'model must not be present at all');
  assert.ok(!('effort' in o), 'effort must not be present at all');
  const c = connect(sock(dir));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

test('a custom endpoint effort string is passed through verbatim', async (t) => {
  const dir = mkdir(t);
  const { queryFn, record } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg({ effort: 'deep' }), queryFn });
  await waitForFile(sock(dir));
  await waitUntil(() => record.options != null);
  assert.equal(record.options.effort, 'deep');
  const c = connect(sock(dir));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 3 (read-only variant): dontAsk + allowedTools + no-worktree guidance.
test('options match the contract for a read-only session', async (t) => {
  const dir = mkdir(t);
  const { queryFn, record } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg({ readOnly: true, worktree: false }), queryFn });
  await waitForFile(sock(dir));
  await waitUntil(() => record.options != null);
  const o = record.options;
  assert.equal(o.permissionMode, 'dontAsk');
  assert.deepEqual(o.allowedTools, ['Read', 'Glob', 'Grep']);
  assert.match(o.systemPrompt.append, /dispatcher/);
  assert.doesNotMatch(o.systemPrompt.append, /EnterWorktree/);
  assert.doesNotMatch(o.systemPrompt.append, /Do not use worktrees/);
  const c = connect(sock(dir));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 2/7: a send op mid-run is yielded to the model iterable.
test('a send op mid-run is yielded to the model iterable', async (t) => {
  const dir = mkdir(t);
  const { queryFn, record } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  c.send({ op: 'send', text: 'yo' });
  await waitUntil(() => record.received.includes('yo'));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 5: result → turn-end frame on socket AND in events.jsonl w/ seq.
test('a result message produces a turn-end frame on the socket and in events.jsonl', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'state' && x.state === 'starting'));
  out.push(initMsg());
  out.push(asstMsg('working on it'));
  out.push(resultMsg());
  await c.waitFor((f) => f.some((x) => x.ev === 'turn-end'));
  const te = c.frames.find((x) => x.ev === 'turn-end');
  assert.equal(te.result, 'done');
  assert.equal(te.isError, false);
  assert.deepEqual(te.usage, { input: 10, output: 5 });
  assert.equal(te.costUsd, 0.01);
  assert.equal(te.turns, 2);
  assert.equal(te.sdkSessionId, 'sdk-123');
 // Present in the durable log, and seqs are strictly increasing (durability).
  const frames = readFrames(dir);
  const fileTe = frames.find((x) => x.ev === 'turn-end');
  assert.ok(fileTe, 'turn-end must be in events.jsonl');
  const seqs = frames.map((x) => x.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'seqs strictly increase');
 // Assistant summary frame captured the text.
  const asst = frames.find((x) => x.ev === 'event' && x.kind === 'assistant');
  assert.match(asst.summary, /working on it/);
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// SDK message filtering: thinking_tokens is dropped (the event-log spam source),
// status/api_retry stay visible with a subtype-labeled summary, and unknown
// types are still logged (with their subtype when present).
test('system/thinking_tokens produces no event frame (spam suppression)', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'state' && x.state === 'starting'));
  out.push(initMsg());
 // A burst of thinking-delta chunks — previously one identical 'other: system'
 // line each.
  for (let i = 0; i < 50; i++) out.push(thinkingTokensMsg({ estimated_tokens: i }));
  out.push(resultMsg());
  await c.waitFor((f) => f.some((x) => x.ev === 'turn-end'));
  const frames = readFrames(dir);
  const thinkingEvents = frames.filter((f) => f.ev === 'event' && (f.summary === 'system' || /thinking_tokens/.test(f.summary)));
  assert.equal(thinkingEvents.length, 0, 'thinking_tokens must produce no event frames, got: ' + JSON.stringify(thinkingEvents));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

test('system/status emits a subtype-labeled event (compacting visible)', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'state' && x.state === 'starting'));
  out.push(initMsg());
  out.push(statusMsg('compacting', { compact_result: 'success' }));
  out.push(statusMsg('requesting'));
  out.push(resultMsg());
  await c.waitFor((f) => f.some((x) => x.ev === 'turn-end'));
  const frames = readFrames(dir);
  const compacting = frames.find((f) => f.ev === 'event' && f.kind === 'system' && /compacting/.test(f.summary));
  assert.ok(compacting, 'expected a system/status: compacting event');
  assert.match(compacting.summary, /system\/status: compacting: success/);
  const requesting = frames.find((f) => f.ev === 'event' && f.kind === 'system' && /requesting/.test(f.summary));
  assert.ok(requesting, 'expected a system/status: requesting event');
  assert.match(requesting.summary, /system\/status: requesting/);
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

test('system/api_retry emits a subtype-labeled event with attempt + http status', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'state' && x.state === 'starting'));
  out.push(initMsg());
  out.push(apiRetryMsg());
  out.push(resultMsg());
  await c.waitFor((f) => f.some((x) => x.ev === 'turn-end'));
  const frames = readFrames(dir);
  const retry = frames.find((f) => f.ev === 'event' && f.kind === 'system' && /api_retry/.test(f.summary));
  assert.ok(retry, 'expected a system/api_retry event');
  assert.match(retry.summary, /system\/api_retry: attempt 2\/5 http 429/);
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

test('an unknown SDK type is still logged, with subtype when present', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'state' && x.state === 'starting'));
  out.push(initMsg());
  out.push({ type: 'something_new', subtype: 'beta', session_id: 'sdk-123' });
  out.push({ type: 'orphan' });
  out.push(resultMsg());
  await c.waitFor((f) => f.some((x) => x.ev === 'turn-end'));
  const frames = readFrames(dir);
  const withSub = frames.find((f) => f.ev === 'event' && f.kind === 'other' && f.summary === 'something_new/beta');
  assert.ok(withSub, 'expected an other event with type/subtype, got: ' + JSON.stringify(frames.filter((f) => f.ev === 'event' && f.kind === 'other')));
  const bare = frames.find((f) => f.ev === 'event' && f.kind === 'other' && f.summary === 'orphan');
  assert.ok(bare, 'expected an other event with bare type, got: ' + JSON.stringify(frames.filter((f) => f.ev === 'event' && f.kind === 'other')));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 1: revive continuity — seq resumes from max(existing)+1.
test('revive: seq resumes from the max seq found in an existing events.jsonl', async (t) => {
  const dir = mkdir(t);
  const seeded = [
    { ev: 'state', seq: 1, state: 'starting' },
    { ev: 'state', seq: 2, state: 'running' },
    { ev: 'state', seq: 3, state: 'idle' },
  ];
  fs.writeFileSync(eventsPath(dir), seeded.map((f) => JSON.stringify(f) + '\n').join(''));
  const { queryFn } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  await waitUntil(() => readFrames(dir).some((f) => f.seq >= 4));
  const fresh = readFrames(dir).filter((f) => f.seq >= 4);
  assert.equal(fresh[0].seq, 4);
  assert.equal(fresh[0].ev, 'state');
  assert.equal(fresh[0].state, 'starting');
  const c = connect(sock(dir));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 7: shutdown op → graceful resolve.
test('shutdown op resolves runRunner and writes an exited frame', async (t) => {
  const dir = mkdir(t);
  const { queryFn } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  const c = connect(sock(dir));
  c.subscribe(0);
  await c.waitFor((f) => f.some((x) => x.ev === 'state' && x.state === 'starting'));
  c.send({ op: 'shutdown' });
  await run; // resolves
  c.close();
  assert.ok(readFrames(dir).some((f) => f.ev === 'state' && f.state === 'exited'));
});

// Important 1: the SDK generator ending on its own must resolve runRunner even
// with no idle timeout — otherwise the detached process orphans on ctl.sock.
test('natural generator completion resolves runRunner (no idle timeout needed)', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg({ idleTimeoutMs: 0 }), queryFn });
  await waitForFile(sock(dir));
  out.push(resultMsg());
  out.end(); // SDK-side termination: the model loop completes on its own
  await run; // resolves with no shutdown op and no idle timer
  assert.ok(readFrames(dir).some((f) => f.ev === 'state' && f.state === 'exited'));
});

// Contract 7 (interrupt op): reaches the live query's interrupt.
test('an interrupt op invokes the query interrupt while the pump is live', async (t) => {
  const dir = mkdir(t);
  const { queryFn, record, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  out.push(initMsg()); // pump is live, consuming from the generator
  const c = connect(sock(dir));
  await c.waitFor((f) => f.some((x) => x.ev === 'hello'));
  c.send({ op: 'interrupt' });
  await waitUntil(() => record.interrupts >= 1);
  assert.ok(record.interrupts >= 1);
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 8: idle timeout → graceful resolve after a turn-end with empty queue.
test('idle timeout resolves runRunner after a turn-end with an empty input queue', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg({ idleTimeoutMs: 50 }), queryFn });
  await waitForFile(sock(dir));
  out.push(resultMsg()); // turn-end → arms the idle timer (queue empty)
  await run; // resolves via idle timeout
  assert.ok(readFrames(dir).some((f) => f.ev === 'state' && f.state === 'exited'));
});

// Contract 9: a throw from the pump → fatal frame + rejected promise.
test('a throw from the model loop yields a fatal frame and rejects runRunner', async (t) => {
  const dir = mkdir(t);
  const { queryFn, out } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg(), queryFn });
  await waitForFile(sock(dir));
  out.fail(new Error('boom'));
  await assert.rejects(run, /boom/);
  const fatal = readFrames(dir).find((f) => f.ev === 'fatal');
  assert.ok(fatal, 'fatal frame must be logged');
  assert.match(fatal.error, /boom/);
});

// Contract 6: WorktreeCreate/WorktreeRemove hooks emit worktree frames.
test('worktree hooks emit create/remove frames with resolved paths', async (t) => {
  const repo = makeRepo(t);
  const dir = mkdir(t);
  const { queryFn, record } = makeFake();
  const run = runRunner({ sessionDir: dir, config: cfg({ cwd: repo }), queryFn });
  await waitForFile(sock(dir));
  await waitUntil(() => record.options != null);
  const wtPath = path.join(repo, '.claude', 'worktrees', 'feature-x');
  git(repo, ['worktree', 'add', '-q', '-b', 'feat', wtPath]);
  const opts = { signal: new AbortController().signal };
  const createCb = record.options.hooks.WorktreeCreate[0].hooks[0];
  const createOut = await createCb({ hook_event_name: 'WorktreeCreate', name: 'feature-x', cwd: repo, session_id: '', transcript_path: '' }, undefined, opts);
  assert.deepEqual(createOut, { continue: true });
  const c = connect(sock(dir));
  c.subscribe(0); // replay delivers the already-logged create frame
  await c.waitFor((f) => f.some((x) => x.ev === 'worktree' && x.action === 'create'));
  const wf = c.frames.find((x) => x.ev === 'worktree' && x.action === 'create');
  assert.equal(wf.name, 'feature-x');
  assert.equal(wf.path, wtPath);
  const removeCb = record.options.hooks.WorktreeRemove[0].hooks[0];
  const removeOut = await removeCb({ hook_event_name: 'WorktreeRemove', worktree_path: wtPath, cwd: repo, session_id: '', transcript_path: '' }, undefined, opts);
  assert.deepEqual(removeOut, { continue: true });
  await c.waitFor((f) => f.some((x) => x.ev === 'worktree' && x.action === 'remove' && x.path === wtPath));
  c.send({ op: 'shutdown' });
  await run;
  c.close();
});

// Contract 4: the dispatcher mailbox tool.
test('createMailboxTool emits a mailbox frame and returns the delivered ack', async () => {
  const emitted: string[] = [];
  const def = createMailboxTool((text) => emitted.push(text));
  assert.equal(def.name, 'message');
  const res = await def.handler({ text: 'blocked on X' }, {});
  assert.deepEqual(emitted, ['blocked on X']);
  assert.deepEqual(res, { content: [{ type: 'text', text: 'delivered to dispatcher' }] });
});
