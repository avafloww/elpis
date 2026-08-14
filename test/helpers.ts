// Shared test fixtures. Before this module, a ~10-line Config stub was
// hand-rolled in 15 files and the ~40-line Agent dep-graph in 12 — each copy
// drifting (some Config stubs omitted fields; some passed a now-removed `log`).
// These builders are the single source of truth for a network-free test agent.
//
// Design: everything is override-friendly. `makeConfig`/`makeStubLLM` take a
// partial and spread it last. `buildTestAgent` wires the full graph (tmp dir →
// MEMORY/SOUL → memory → config → sandbox with an agentRef back-reference →
// tracker → compactor → transcript → Agent) and returns every constructed dep
// plus a `sent` capture array and a `cleanup` that removes the temp dir.
// Pass `config`/`sandboxDeps`/`agentDeps` overrides for a case's specifics
// (tiny budgets, a scripted LLM, an injected card manager, …) — never fork the
// graph.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, type AgentDeps, type InboundMessage } from '../src/agent.js';
import { createMemory, ensureFile } from '../src/store/memory.js';
import { createSandbox } from '../src/sandbox/index.js';
import { createContextTracker } from '../src/llm/context-tracker.js';
import { createDensityModel } from '../src/llm/density.js';
import { createCompactor } from '../src/llm/compactor.js';
import { createTranscriptStore } from '../src/store/sessions.js';
import { createChannelDirectory } from '../src/store/channels.js';
import { openDatabase } from '../src/store/db.js';
import type { Config } from '../src/config.js';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { CONSOLE_CHANNEL_ID, type SandboxDeps } from '../src/types.js';
import { noopLogger } from '../src/lib/log.js';

/** A minimal turn-end completion. Since 2026-07-24 the only sanctioned ending is
 * a successful run carrying `end: true`, so this is `run('', end: true)` — the
 * chosen-silence idiom — not a bare no-tool-call message. */
export const EMPTY_END: CompleteResult = {
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'tc-end', type: 'function', function: { name: 'run', arguments: '{"code":"","end":true}' } }],
  },
  stripped: false,
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

/** A complete, correctly-typed Config with no env dependency. Paths derive from
 * `paths.dataDirectory` (default `/tmp/harness-test`; `buildTestAgent` passes the
 * case's temp dir). Override any field via `overrides`. */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  const dataDirectory = (overrides.paths?.dataDirectory) ?? '/tmp/harness-test';
  return {
    llm: {
      providerType: 'openai-compatible',
      apiKey: 'stub',
      baseUrl: 'http://stub',
      model: 'stub',
      contextSize: null,
      reasoningEffort: 'high',
      externalThinking: false,
      streamIdleTimeoutMs: 180_000,
      callTimeoutMs: 1_200_000,
      api: 'auto',
      reasoningSummary: null,
      reasoningContext: null,
      completionReserveTokens: 8192,
    },
    operator: { name: 'operator', pronouns: null, discordId: null },
    discord: {
      botToken: 'stub',
      applicationId: 'stub',
      errorChannelId: null,
      attachmentInlineMaxBytes: 32768,
      ambientTickMs: 0,
      emoteImages: true,
      emoteKeyframes: 4,
      guilds: [
        { id: 'stub', slug: 'stub', slashCommands: false, quietHours: null, timezone: null, channels: { '100': 'direct' } },
      ],
    },
    compaction: { triggerTokens: 180000, keepTokens: 50000 },
    heartbeat: {
      intervalMs: 0,
      maxIntervalMs: 4 * 60 * 60 * 1000,
      reflectionMinMessages: 3,
      socialNudgeMs: 12 * 60 * 60 * 1000,
    },
    sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 },
    console: { enabled: false, mcpEnabled: false, port: 8787, host: '127.0.0.1' },
    kagi: { apiKey: null },
    bluesky: null,
    fleet: {
      enabled: false, maxConcurrent: 1, defaultModel: null, defaultEffort: null,
      efforts: [], endpoint: { baseUrl: null, apiKey: null, authToken: null },
      models: {
        opus: { name: null, context: null }, sonnet: { name: null, context: null },
        haiku: { name: null, context: null }, fable: { name: null, context: null },
      },
      idleTimeoutMs: 3_600_000, reapAfterMs: 86_400_000, env: {},
    },
    usageTracker: { enabled: true, pollIntervalMs: 300000 },
    logger: noopLogger,
    logLevel: 'info',
    ...overrides,
 // Built AFTER the `...overrides` spread so it deep-merges rather than
 // being replaced wholesale: derivation from `dataDirectory` keeps working
 // even when a caller only overrides `paths.dataDirectory`, while an
 // explicit `overrides.paths.*` field still wins (spread last).
    paths: {
      dataDirectory,
      soulPath: path.join(dataDirectory, 'SOUL.md'),
      memoryPath: path.join(dataDirectory, 'MEMORY.md'),
      harnessRoot: dataDirectory,
      ...overrides.paths,
    },
  };
}

/** An LLM stub that ends the turn immediately (`complete` → EMPTY_END) and
 * summarizes to 'SUMMARY'. Override `complete`/`summarize` for scripted
 * behavior. */
export function makeStubLLM(overrides: Partial<LLM> = {}): LLM {
  return {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete: () => Promise.resolve(EMPTY_END),
    summarize: () => Promise.resolve('SUMMARY'),
    ...overrides,
  } as LLM;
}

/** Context passed to the deps-builder function form, so a dep that needs the
 * temp dir / llm / agent (e.g. a card manager under `tmpDir/cards`, or an
 * `onFutureSettled` callback that calls back into the agent) can be built.
 * `agentRef.current` is null during construction but populated before any
 * runtime callback fires — the same forward-reference pattern as index.ts. */
export interface DepsContext {
  tmpDir: string;
  config: Config;
  memory: ReturnType<typeof createMemory>;
  llm: LLM;
  agentRef: { current: Agent | null };
}
type DepsOrFn<T> = Partial<T> | ((ctx: DepsContext) => Partial<T>);
const resolveDeps = <T>(d: DepsOrFn<T> | undefined, ctx: DepsContext): Partial<T> =>
  typeof d === 'function' ? d(ctx) : (d ?? {});

export interface BuildTestAgentOpts {
  /** Config field overrides (merged over the temp-dir-backed defaults). */
  config?: Partial<Config>;
  /** An LLM to use instead of `makeStubLLM()`. */
  llm?: LLM;
  /** A tracker to use instead of the default `createContextTracker(100000, 8192)`
 * — pass a tiny-budget one for compaction tests. */
  tracker?: ReturnType<typeof createContextTracker>;
  /** Extra/overriding sandbox deps (e.g. `bg`, `channelName`, `typing`).
 * A function form receives `{ tmpDir, config, memory, llm }`. */
  sandboxDeps?: DepsOrFn<SandboxDeps>;
  /** Extra/overriding Agent deps (e.g. `cards`, `setCurrentInbound`,
 * a custom `send`). By default `send` pushes into the returned `sent` array.
 * A function form receives `{ tmpDir, config, memory, llm }`. */
  agentDeps?: DepsOrFn<AgentDeps>;
  /** Compactor options (keepTokens / foldSerializeCap) for compaction tests. */
  compactorOpts?: import('../src/llm/compactor.js').CompactorOpts;
  /** mkdtemp prefix (cosmetic — helps identify leftover dirs). */
  tmpPrefix?: string;
  /** Use this directory instead of a fresh mkdtemp (bench engine). The caller
 * owns its lifecycle: cleanup becomes a no-op. Pre-existing SOUL/MEMORY
 * files are preserved (ensureFile only writes when missing). */
  dir?: string;
}

/** Wire a network-free Agent and its full dep graph. Does NOT start the loop.
 * Returns every constructed dep plus a `sent` capture and `cleanup`. */
export function buildTestAgent(opts: BuildTestAgentOpts = {}) {
  const tmpDir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix ?? 'harness-test-'));
  if (opts.dir) fs.mkdirSync(tmpDir, { recursive: true });
  ensureFile(path.join(tmpDir, 'MEMORY.md'), '# Agent Memory\n');
  ensureFile(path.join(tmpDir, 'SOUL.md'), '# Soul\n');
  const memory = createMemory(path.join(tmpDir, 'MEMORY.md'));
  const config = makeConfig({
    ...opts.config,
    paths: {
      dataDirectory: tmpDir,
      soulPath: path.join(tmpDir, 'SOUL.md'),
      memoryPath: path.join(tmpDir, 'MEMORY.md'),
      harnessRoot: tmpDir,
      ...opts.config?.paths,
    },
  });
  const llm = opts.llm ?? makeStubLLM();
  const sent: { channelId: string; text: string }[] = [];
  const agentRef: { current: Agent | null } = { current: null };
  const inboundRef: { current: InboundMessage | null } = { current: null };
  const depsCtx: DepsContext = { tmpDir, config, memory, llm, agentRef };
  let channelsRef: ReturnType<typeof createChannelDirectory> | null = null;
  const sandbox = createSandbox({
    config,
    memory,
    logbuf: [],
    get inbound() { return inboundRef.current; },
    send: async (channelId, text) => { await agentRef.current!.send(channelId, text); },
    listChannels: () => agentRef.current!.knownChannelIds(),
    listChannelsWithNames: () => agentRef.current!.knownChannels(),
    resolveChannel: (ref) => agentRef.current!.resolveChannelRef(ref),
    channelName: (id) => id === CONSOLE_CHANNEL_ID ? 'console' : channelsRef?.get(id) ?? null,
    channelLabel: (id) => agentRef.current!.qualifiedChannelLabel(id),
    ...resolveDeps<SandboxDeps>(opts.sandboxDeps, depsCtx),
  });
  const db = openDatabase(tmpDir);
  const density = createDensityModel(db, config.llm.model, config.logger);
  const tracker = opts.tracker ?? createContextTracker(100000, 8192, density);
  const compactor = createCompactor(llm, tracker, { ratio: () => density.ratio(), ...opts.compactorOpts });
  const transcript = createTranscriptStore(path.join(tmpDir, 'sessions'));
  const channels = createChannelDirectory(db, tmpDir, config.discord.guilds);
  channelsRef = channels;
  const agent = new Agent({
    config,
    sandbox,
    memory,
    llm,
    tracker,
    compactor,
    density,
    transcript,
    channels,
    setCurrentInbound: (msg) => { inboundRef.current = msg; },
    send: async (channelId, text) => { sent.push({ channelId, text }); },
    ...resolveDeps<AgentDeps>(opts.agentDeps, depsCtx),
  });
  agentRef.current = agent;
  const cleanup = () => {
    if (opts.dir) return; // caller-owned directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  return { agent, tmpDir, config, llm, memory, tracker, compactor, transcript, sandbox, sent, agentRef, inboundRef, cleanup };
}
