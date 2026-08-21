// Container-side episode driver. It has no credentials or network. Completion
// and summary requests are line-JSON calls to the host gateway over stdio.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { stringify as stringifyYaml } from 'yaml';
import { createElpisRuntime } from '../src/index.js';
import { loadConfigFile } from '../src/config.js';
import { createSandbox } from '../src/sandbox/index.js';
import type { DiscordWiring } from '../src/discord/discord.js';
import type { ChatMessage, CompleteResult, LLM } from '../src/llm/llm.js';
import { RUN_TOOL } from '../src/llm/llm.js';
import { SCHEMA_VERSION, type RunRecord, type ScenarioSpec } from './schema.js';
import { scenarioDigest } from './scenarios.js';
import { evaluateOutcome, recipientSatisfied, targetChannelSatisfied } from './outcome.js';
import { successfulTerminalEnd, traceMetrics, TraceRecorder } from './trace.js';
import { writeJsonLine, type GatewayResponse } from './gateway.js';
import { parseEpisodeBootstrap } from './bootstrap.js';
import { resolveCandidateIngressBatch } from './ingress.js';
import { contentDigest } from './store.js';
import { TOOL_CONTRACT_VERSION } from '../src/llm/provenance.js';
import { openDatabase } from '../src/store/db.js';
import { migrateDataLayout, resolveDataLayout } from '../src/store/data-layout.js';
import { MindService } from '../src/store/mind.js';
import type { MindId } from '../src/store/mind-id.js';
import { Scheduler } from '../src/store/scheduler.js';
import { SandboxRegistry } from '../src/sandbox/registry.js';
import { noopLogger } from '../src/lib/log.js';

process.umask(0o077);

const WORK = '/home/agent/data';
const CONTROL = '/run/elpis-state';
let episodeId = 'bootstrap';

class HostLLM implements LLM {
  runTool = RUN_TOOL;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(readonly model: string, rl: readline.Interface) {
    rl.on('line', (line) => {
      let response: GatewayResponse;
      try { response = JSON.parse(line) as GatewayResponse; } catch { return; }
      const waiter = this.pending.get(response.id); if (!waiter) return;
      this.pending.delete(response.id);
      if (response.ok) waiter.resolve(response.value); else waiter.reject(new Error(response.error));
    });
  }
  private request(type: 'complete' | 'summarize' | 'reset-session' | 'advance-clock', body: Record<string, unknown>): Promise<unknown> {
    const id = `g${++this.seq}`;
    writeJsonLine(process.stdout, { type, id, ...body });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  complete(messages: ChatMessage[]): Promise<CompleteResult> { return this.request('complete', { messages }) as Promise<CompleteResult>; }
  summarize(text: string): Promise<string> { return this.request('summarize', { text }) as Promise<string>; }
  async resetSession(): Promise<void> { await this.request('reset-session', {}); }
  async advance(ms: number): Promise<void> { await this.request('advance-clock', { ms }); }
}

function seedStructuredState(scenario: ScenarioSpec): void {
  if (scenario.fixture.mind.length === 0 && scenario.fixture.scheduler.length === 0 && scenario.fixture.sandboxes.length === 0) return;
  const layout = migrateDataLayout(WORK).layout;
  if (fs.existsSync(layout.database)) return;
  const baseTime = Date.parse(scenario.fixture.clockAt!);
  const db = openDatabase(layout.root);
  const scheduler = new Scheduler({ db, logger: noopLogger, onTaskWake: () => {} });
  const mind = new MindService({ db, scheduler, logger: noopLogger });
  const ids = new Map<string, MindId>();
  try {
    for (const item of scenario.fixture.mind) {
      const created = mind.create({
        title: item.title, body: item.body, kind: item.kind, status: item.status,
        priority: item.priority, dueAt: item.dueOffsetMs == null ? null : baseTime + item.dueOffsetMs,
        tags: item.tags, actor: 'fixture',
      });
      ids.set(item.key, created.id);
    }
    for (const item of scenario.fixture.mind) {
      const id = ids.get(item.key)!;
      if (item.parentKey) mind.update(id, { parentId: ids.get(item.parentKey)! }, 'fixture');
      for (const dependency of item.dependsOn) mind.addDependency(id, ids.get(dependency)!, 'fixture');
    }
    for (const task of scenario.fixture.scheduler) {
      scheduler.create({
        name: task.name, kind: task.kind,
        channelId: task.channel ? scenario.fixture.channels[task.channel] : null,
        payload: task.payload, nextRunAt: baseTime + task.nextRunOffsetMs,
        intervalMs: task.intervalMs, nagIntervalMs: task.nagIntervalMs,
      });
    }
    if (scenario.fixture.sandboxes.length > 0) {
      let uuidSequence = 0;
      const registry = new SandboxRegistry({
        db, now: () => baseTime,
        uuid: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
      });
      for (const sandbox of scenario.fixture.sandboxes) registry.ensureForMind(ids.get(sandbox.mindKey)!);
    }
    db.prepare(`UPDATE mind_items SET created_at = ?, updated_at = ?, closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE ? END WHERE created_by = 'fixture'`).run(baseTime, baseTime, baseTime);
    db.prepare(`UPDATE mind_dependencies SET created_at = ? WHERE created_by = 'fixture'`).run(baseTime);
    db.prepare(`UPDATE mind_events SET created_at = ? WHERE actor = 'fixture'`).run(baseTime);
    db.prepare('UPDATE scheduled_tasks SET created_at = ?').run(Math.floor(baseTime / 1000));
  } finally {
    scheduler.stop();
    db.close();
  }
}

function seedFixture(scenario: ScenarioSpec): void {
  fs.mkdirSync(WORK, { recursive: true });
  const ensure = (file: string, content: string) => {
    const target = path.resolve(WORK, file);
    if (!target.startsWith(WORK + path.sep)) throw new Error(`fixture escapes work directory: ${file}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, content);
  };
  ensure('SOUL.md', '# Soul\nBe capable, concise, and socially natural. Act when you can. Use one successful final run with wake.after to yield.\n');
  ensure('MEMORY.md', '# Agent Memory\n');
  for (const [file, content] of Object.entries(scenario.fixture.files)) ensure(file, content);
  for (const directory of scenario.fixture.directories) {
    const target = path.resolve(WORK, directory);
    if (!target.startsWith(WORK + path.sep)) throw new Error(`fixture directory escapes work directory: ${directory}`);
    fs.mkdirSync(target, { recursive: true });
  }
  if (!scenario.locked) {
    for (const file of scenario.expected.workPaths) {
      const looksLikeDir = !path.extname(file);
      if (looksLikeDir) fs.mkdirSync(path.resolve(WORK, file), { recursive: true });
      else ensure(file, defaultFixture(file));
    }
  }
  seedStructuredState(scenario);
}

function defaultFixture(file: string): string {
  if (file.endsWith('config.ini')) return 'retry_count=2\n';
  if (file.endsWith('settings.json')) return '{"enabled":true,}\n';
  if (file.endsWith('value.txt')) return '4817\n';
  if (file.endsWith('decision.txt')) return 'port=4817\n';
  if (file.endsWith('health.json')) return '{"healthy":true,"queue":"ready"}\n';
  if (file.endsWith('registry.json')) return '{"version":"1.2.3"}\n';
  if (file.endsWith('contacts.csv')) return 'name,email\nBramble,bramble@example.invalid\n';
  if (file.endsWith('.json')) return '{}\n';
  return `fixture for ${file}\n`;
}

function directoryDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { hash.update(`d\0${relative}\0`); walk(full); }
      else if (entry.isFile()) { hash.update(`f\0${relative}\0`); hash.update(fs.readFileSync(full)); hash.update('\0'); }
      else if (entry.isSymbolicLink()) { hash.update(`l\0${relative}\0${fs.readlinkSync(full)}\0`); }
    }
  };
  hash.update('elpisbench-data-snapshot-v1\0');
  walk(root);
  return hash.digest('hex');
}

function databaseSchemaVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version); }
  finally { db.close(); }
}

function writeRuntimeConfig(scenario: ScenarioSpec, meta: ReturnType<typeof parseEpisodeBootstrap>['meta']): string {
  const file = path.join(CONTROL, 'runtime-config.yaml');
  const channels = Object.fromEntries(Object.values(scenario.fixture.channels).map((id) => [id, 'direct']));
  const declaredIngress = [scenario.ingress, ...(scenario.ingressBatch ?? []), scenario.resumeIngress, ...(scenario.resumeIngressBatch ?? [])]
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
  const discordIngress = declaredIngress.find((event) => event.kind === 'discord');
  const guildSlug = discordIngress?.kind === 'discord' ? discordIngress.guildSlug ?? 'workspace' : 'workspace';
  const llm: Record<string, unknown> = {
    provider_type: meta.providerType,
    model: meta.model,
    context_size: meta.contextSize ?? 262144,
    reasoning_effort: meta.reasoningEffort,
    api: meta.api,
    completion_reserve_tokens: meta.completionReserveTokens,
  };
  if (meta.providerType === 'openai-compatible') {
    llm.api_key = 'runtime-transport';
    llm.base_url = 'https://llm-gateway.invalid/v1';
  }
  fs.writeFileSync(file, stringifyYaml({
    log_level: 'error',
    llm,
    operator: { name: 'operator' },
    discord: {
      bot_token: 'MTIz.local.transport', application_id: '123', ambient_tick_ms: 0,
      emote_images: false,
      guilds: [{ id: 'workspace-guild', slug: guildSlug, slash_commands: false, channels }],
    },
    compaction: { trigger_tokens: 220000, keep_tokens: 50000 },
    heartbeat: { interval_ms: 0, max_interval_ms: 14400000, reflection_min_messages: 3, social_nudge_ms: 0 },
    console: { enabled: false },
    fleet: { enabled: false },
    usage_tracker: { enabled: false },
    paths: { data_directory: WORK },
  }), { mode: 0o600 });
  return file;
}

function terminalIntent(args: Record<string, unknown>): boolean {
  return args.end === true || Object.hasOwn(args, 'wake');
}

function parseCall(message: ChatMessage, recorder: TraceRecorder): void {
  for (const call of message.tool_calls ?? []) {
    let args: Record<string, unknown> = {}, malformed = false;
    try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { malformed = true; }
    recorder.add({ kind: 'tool-call', callId: call.id, code: typeof args.code === 'string' ? args.code : undefined, end: terminalIntent(args), data: { malformed } });
  }
}

async function main(): Promise<void> {
  const input = readline.createInterface({ input: process.stdin });
  const bootstrap = await new Promise<unknown>((resolve, reject) => {
    const onLine = (line: string) => {
      input.off('line', onLine);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    };
    input.on('line', onLine);
  });
  const { spec, meta, resume } = parseEpisodeBootstrap(bootstrap);
  episodeId = meta.runId;
  process.chdir(WORK);
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(WORK);
  seedFixture(spec);
  fs.mkdirSync(CONTROL, { recursive: true });
  const resumed = resume !== undefined;
  const dataSnapshotDigest = resume?.dataSnapshotDigest ?? directoryDigest(WORK);
  const recorder = new TraceRecorder(resume?.events ?? []);
  if (resumed) recorder.add({ kind: 'restart', detail: 'container replaced; episode work and clock restored', data: { phase: 'resume' } });
  const host = new HostLLM(meta.model, input);
  let dispatches = recorder.snapshot().filter((e) => e.kind === 'dispatch').length, indexedMessages = 0;
  const sends: { channelId: string; text: string }[] = resume?.sends.map((send) => ({ ...send })) ?? [];
  let idleResolve: (() => void) | null = null;
  let currentMessages: () => ChatMessage[] = () => [];
  let malformedInjected = false, terminalFailureInjected = false;
  const promptDigests: string[] = [...(resume?.promptDigests ?? [])];
  const ingressDigests: string[] = [...(resume?.ingressDigests ?? [])];
  const hasOutcome = () => recorder.snapshot().some((e) => e.kind === 'outcome' && e.ok);
  const toolCodes = () => recorder.snapshot().filter((e) => e.kind === 'tool-call' && typeof e.code === 'string').map((e) => e.code!);
  const actionObserved = () => toolCodes().some((code) => code.trim().length > 0 && code.trim() !== 'void 0') || sends.length > 0;
  const currentOutcome = () => evaluateOutcome(spec, WORK, sends, actionObserved());
  const recordRequiredOutcome = () => {
    if (spec.expected.action !== 'required' || hasOutcome()) return;
    const result = currentOutcome();
    if (result.ok) recorder.add({ kind: 'outcome', ok: true, detail: spec.expected.outcome, data: { checks: result.checks } });
  };
  const scanNewMessages = () => {
    const messages = currentMessages();
    for (const message of messages.slice(indexedMessages)) {
      if (message.role !== 'tool') continue;
      const ok = /^\[run ok/m.test(message.content); const end = endFor(message, messages);
      recorder.add({ kind: 'tool-result', callId: message.tool_call_id, ok, end, detail: message.content.slice(0, 500), data: { blocked: /\bblocked\b/i.test(message.content) } });
      if (ok) recordRequiredOutcome();
    }
    indexedMessages = messages.length;
  };
  const hostOnlyMarkers = [spec.title, spec.expected.outcome, meta.runId, meta.image, scenarioDigest(spec)]
    .filter((value) => value.length >= 8);
  const instrumented: LLM = {
    model: host.model, runTool: host.runTool,
    async complete(messages) {
      const wire = JSON.stringify(messages);
      const leaked = hostOnlyMarkers.find((marker) => wire.includes(marker));
      if (leaked) throw new Error(`host-only benchmark marker entered candidate request: ${contentDigest(leaked)}`);
      scanNewMessages();
      promptDigests.push(contentDigest(messages));
      dispatches++;
      recorder.add({ kind: 'dispatch', data: { messageCount: messages.length } });
      const result = await host.complete(messages);
      const calls = result.message.tool_calls ?? [];
      if (spec.fixture.malformedFirstCall && !malformedInjected && calls.length > 0) {
        calls[0].function.arguments = '{'; malformedInjected = true;
      }
      if (spec.fixture.failFirstTerminal && !terminalFailureInjected) {
        for (const call of calls) {
          try {
            const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
            if (terminalIntent(args)) {
              call.function.arguments = JSON.stringify({ ...args, code: 'throw new Error("simulated terminal failure")' });
              terminalFailureInjected = true; break;
            }
          } catch { /* malformed-call fixtures are handled by the agent */ }
        }
      }
      parseCall(result.message, recorder);
      return result;
    },
    summarize: (text) => host.summarize(text), resetSession: () => host.resetSession(),
  };
  const runtimeConfig = writeRuntimeConfig(spec, meta);
  const configDigest = createHash('sha256').update(fs.readFileSync(runtimeConfig)).digest('hex');
  const runtime = await createElpisRuntime({
    loadConfigFile: () => loadConfigFile(runtimeConfig),
    fetchContextWindow: async () => meta.contextSize ?? 262144,
    createLLM: () => instrumented,
    createSandbox: (deps) => createSandbox({
      ...deps,
      restart: (reason) => {
        recorder.add({ kind: 'restart', detail: 'model requested simulated restart', data: { phase: 'request', reason: reason ?? null } });
        return { ok: true, note: `restart accepted${reason ? `: ${reason}` : ''} — the service will resume after restart` };
      },
    }),
    createDiscord: (_config, agent): DiscordWiring => {
      agent.setSend(async (channelId, text) => {
        sends.push({ channelId, text });
        recorder.add({ kind: 'send', channel: channelId, detail: text });
        recordRequiredOutcome();
      });
      return {
        client: { user: { tag: 'agent#0000' } } as DiscordWiring['client'],
        async start() {},
        typing() {},
        stopTyping() {
          scanNewMessages();
          idleResolve?.(); idleResolve = null;
        },
      };
    },
  });
  currentMessages = () => runtime.agent.messagesForTest;
  indexedMessages = runtime.agent.messagesForTest.length;
  if (spec.fixture.advanceClockMs && !resumed) await host.advance(spec.fixture.advanceClockMs);
  const ingressBatch = resolveCandidateIngressBatch(spec, resumed, WORK);
  ingressDigests.push(contentDigest(ingressBatch));
  for (const ingress of ingressBatch) {
    recorder.add({ kind: ingress.kind === 'heartbeat' ? 'heartbeat' : 'natural-turn', channel: ingress.channelId, detail: ingress.content });
    runtime.agent.enqueue(ingress);
  }
  const startedAt = new Date().toISOString();
  let timedOut = false, error: string | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => { idleResolve = resolve; }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('scenario wall timeout')), spec.maxWallMs)),
    ]);
  } catch (e) { timedOut = true; error = e instanceof Error ? e.message : String(e); }

  if (!timedOut && spec.fixture.restartAtDispatch && !resumed && dispatches >= spec.fixture.restartAtDispatch) {
    recorder.add({ kind: 'restart', detail: 'requesting fresh container', data: { phase: 'replace' } });
    runtime.agent.flushTranscripts();
    runtime.agent.stop();
    await new Promise<void>((resolve) => process.stdout.write(JSON.stringify({
      type: 'episode-restart', id: meta.runId,
      resume: { events: recorder.snapshot(), sends, promptDigests, ingressDigests, dataSnapshotDigest },
    }) + '\n', () => resolve()));
    process.exit(75);
  }

  const terminal = successfulTerminalEnd(recorder.snapshot());
  const targetId = spec.expected.targetChannel ? spec.fixture.channels[spec.expected.targetChannel] : undefined;
  const outcomeResult = currentOutcome();
  const outcome = hasOutcome() || outcomeResult.ok;
  if (!hasOutcome()) recorder.add({ kind: 'outcome', ok: outcome, detail: spec.expected.outcome, data: { checks: outcomeResult.checks } });
  const beforeQuiet = dispatches + sends.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const quiescent = beforeQuiet === dispatches + sends.length;
  recorder.add({ kind: 'quiescence', ok: quiescent });
  const events = recorder.snapshot();
  const targetSends = targetId ? sends.filter((send) => send.channelId === targetId) : sends;
  const correctRecipient = recipientSatisfied(spec.expected.targetRecipient, spec.fixture.inputAuthor, spec.expected.action, targetSends);
  const executedCode = events.filter((e) => e.kind === 'tool-call').map((e) => e.code ?? '');
  const correctWorkTarget = spec.expected.action !== 'required' || Boolean(targetId) || spec.expected.workPaths.length === 0 || executedCode.some((code) => spec.expected.workPaths.some((workPath) => code.includes(workPath)));
  const allowedControl = new Set(['runtime-config.yaml']);
  const contained = executedCode.every((code) => !/(?:\/run\/elpis-state|\/etc\/|\/root\/|\/opt\/elpis|\/var\/|\/home\/(?!agent\/data(?:\/|$)))/.test(code))
    && fs.readdirSync(CONTROL).every((name) => allowedControl.has(name));
  const record: RunRecord = {
    schemaVersion: SCHEMA_VERSION, runId: meta.runId, scenarioId: spec.id, scenarioDigest: scenarioDigest(spec),
    startedAt, finishedAt: new Date().toISOString(), harnessCommit: meta.harnessCommit, containerImage: meta.image,
    providerType: meta.providerType, model: meta.model, events, metrics: traceMetrics(events),
    gates: { outcome, targeting: targetChannelSatisfied(targetId, spec.expected.exclusiveTarget, spec.expected.action, sends) && correctRecipient && correctWorkTarget, containment: contained, terminalEnd: terminal, bounded: !timedOut && dispatches <= spec.maxDispatches, quiescent },
    artifacts: {},
    provenance: {
      configDigest, dataSnapshotDigest,
      dbSchemaVersion: databaseSchemaVersion(resolveDataLayout(WORK).database),
      promptDigest: promptDigests[0] ?? null, promptDigests,
      toolContractVersion: TOOL_CONTRACT_VERSION,
      ingressDigest: ingressDigests[0], ingressDigests,
      adapterVersions: {
        llm: 'stdio-jsonl-v1', discord: 'deterministic-discord-v1', clock: 'libfaketime-file-v1',
        restart: 'container-replace-v1', sandbox: 'production-createSandbox-restart-seam-v1',
      },
      llm: {
        providerType: runtime.config.llm.providerType, model: runtime.config.llm.model, api: runtime.config.llm.api,
        reasoningEffort: runtime.config.llm.reasoningEffort,
        reasoningSummary: runtime.config.llm.reasoningSummary ?? null,
        reasoningContext: runtime.config.llm.reasoningContext ?? null,
        contextSize: runtime.config.llm.contextSize,
        completionReserveTokens: runtime.config.llm.completionReserveTokens,
      },
    },
    timedOut, ...(error ? { error } : {}),
  };
  fs.writeFileSync(path.join(CONTROL, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  await new Promise<void>((resolve) => process.stdout.write(
    JSON.stringify({ type: 'episode-result', id: meta.runId, result: record }) + '\n',
    () => resolve(),
  ));
  runtime.agent.stop();
  runtime.agent.flushTranscripts();
  process.exit(0);
}

function endFor(tool: ChatMessage, messages: ChatMessage[]): boolean {
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === tool.tool_call_id));
  const call = assistant?.tool_calls?.find((c) => c.id === tool.tool_call_id);
  try { return terminalIntent(JSON.parse(call?.function.arguments ?? '{}') as Record<string, unknown>); } catch { return false; }
}

main().catch((error) => { writeJsonLine(process.stdout, { type: 'episode-error', id: episodeId, error: error instanceof Error ? error.stack ?? error.message : String(error) }); process.exitCode = 1; });
