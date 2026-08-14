// Container-side episode driver. It has no credentials or network. Completion
// and summary requests are line-JSON calls to the host gateway over stdio.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { buildTestAgent } from '../test/helpers.js';
import type { ChatMessage, CompleteResult, LLM } from '../src/llm/llm.js';
import { RUN_TOOL } from '../src/llm/llm.js';
import { SCHEMA_VERSION, parseScenario, type RunRecord, type ScenarioSpec, type TraceEvent } from './schema.js';
import { scenarioDigest } from './scenarios.js';
import { successfulTerminalEnd, traceMetrics, TraceRecorder } from './trace.js';
import { writeJsonLine, type GatewayResponse } from './gateway.js';
import { createTranscriptStore, loadMostRecentMain, MAIN_TRANSCRIPT_ID } from '../src/store/sessions.js';
import { INTERNAL_CHANNEL_ID } from '../src/types.js';

const WORK = '/episode/work';
const RESULTS = '/episode/results';
const spec = parseScenario(JSON.parse(fs.readFileSync(path.join(WORK, '.elpisbench-scenario.json'), 'utf8')));
const meta = JSON.parse(fs.readFileSync(path.join(WORK, '.elpisbench-run.json'), 'utf8')) as { runId: string; providerType: RunRecord['providerType']; model: string; image: string; harnessCommit: string };

class HostLLM implements LLM {
  model = meta.model;
  runTool = RUN_TOOL;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor() {
    const rl = readline.createInterface({ input: process.stdin });
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
  complete(messages: ChatMessage[], ratio = 4): Promise<CompleteResult> { return this.request('complete', { messages, ratio }) as Promise<CompleteResult>; }
  summarize(text: string): Promise<string> { return this.request('summarize', { text }) as Promise<string>; }
  async resetSession(): Promise<void> { await this.request('reset-session', {}); }
  async advance(ms: number): Promise<void> { await this.request('advance-clock', { ms }); }
}

function seedFixture(scenario: ScenarioSpec): void {
  fs.mkdirSync(WORK, { recursive: true });
  const ensure = (file: string, content: string) => {
    const target = path.resolve(WORK, file);
    if (!target.startsWith(WORK + path.sep)) throw new Error(`fixture escapes work directory: ${file}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, content);
  };
  ensure('SOUL.md', '# Soul\nBe capable, concise, and socially natural. Act when you can. Use one successful run with end: true to finish.\n');
  ensure('MEMORY.md', '# Agent Memory\n');
  for (const [file, content] of Object.entries(scenario.fixture.files)) ensure(file, content);
  for (const file of scenario.expected.workPaths) {
    const looksLikeDir = !path.extname(file);
    if (looksLikeDir) fs.mkdirSync(path.resolve(WORK, file), { recursive: true });
    else ensure(file, defaultFixture(file));
  }
  const channelMap = Object.fromEntries(Object.entries(scenario.fixture.channels).map(([name, id]) => [id, name]));
  ensure('channels.json', JSON.stringify(channelMap));
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

function parseCall(message: ChatMessage, recorder: TraceRecorder): void {
  for (const call of message.tool_calls ?? []) {
    let args: Record<string, unknown> = {}, malformed = false;
    try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { malformed = true; }
    recorder.add({ kind: 'tool-call', callId: call.id, code: typeof args.code === 'string' ? args.code : undefined, end: args.end === true, data: { malformed } });
  }
}

async function main(): Promise<void> {
  process.chdir(WORK);
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(WORK);
  seedFixture(spec);
  const restartMarker = path.join(WORK, '.elpisbench-restarted');
  const traceFile = path.join(WORK, '.elpisbench-trace.json');
  const sendsFile = path.join(WORK, '.elpisbench-sends.json');
  const resumed = fs.existsSync(restartMarker);
  const recorder = new TraceRecorder(fs.existsSync(traceFile) ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) as TraceEvent[] : []);
  if (resumed) recorder.add({ kind: 'restart', detail: 'container replaced; episode work and clock restored', data: { phase: 'resume' } });
  const host = new HostLLM();
  let dispatches = recorder.snapshot().filter((e) => e.kind === 'dispatch').length, indexedMessages = 0;
  const sends: { channelId: string; text: string }[] = fs.existsSync(sendsFile) ? JSON.parse(fs.readFileSync(sendsFile, 'utf8')) : [];
  let idleResolve: (() => void) | null = null;
  let currentMessages: () => ChatMessage[] = () => [];
  const hasOutcome = () => recorder.snapshot().some((e) => e.kind === 'outcome' && e.ok);
  const scanNewMessages = () => {
    const messages = currentMessages();
    for (const message of messages.slice(indexedMessages)) {
      if (message.role !== 'tool') continue;
      const ok = /^\[run ok/m.test(message.content); const end = endFor(message, messages);
      recorder.add({ kind: 'tool-result', callId: message.tool_call_id, ok, end, detail: message.content.slice(0, 500), data: { blocked: /\bblocked\b/i.test(message.content) } });
      if (ok && spec.expected.action === 'required' && !spec.expected.targetChannel && !hasOutcome()) recorder.add({ kind: 'outcome', ok: true, detail: spec.expected.outcome });
    }
    indexedMessages = messages.length;
  };
  const instrumented: LLM = {
    model: host.model, runTool: host.runTool,
    async complete(messages, ratio) {
      scanNewMessages();
      dispatches++;
      recorder.add({ kind: 'dispatch', data: { messageCount: messages.length } });
      const result = await host.complete(messages, ratio);
      parseCall(result.message, recorder);
      return result;
    },
    summarize: (text) => host.summarize(text), resetSession: () => host.resetSession(),
  };
  const sessionsRoot = path.join(WORK, 'sessions'); const transcript = createTranscriptStore(sessionsRoot); const initial = resumed ? loadMostRecentMain(sessionsRoot) : null;
  if (initial?.path) transcript.adopt(MAIN_TRANSCRIPT_ID, initial.path);
  const built = buildTestAgent({
    dir: WORK, llm: instrumented,
    config: { heartbeat: { intervalMs: 0, maxIntervalMs: 14_400_000, reflectionMinMessages: 3, socialNudgeMs: 43_200_000 } },
    agentDeps: {
      transcript, initialMessages: initial?.messages ?? [],
      send: async (channelId, text) => { sends.push({ channelId, text }); recorder.add({ kind: 'send', channel: channelId, detail: text }); const target = spec.expected.targetChannel ? spec.fixture.channels[spec.expected.targetChannel] : undefined; if (target === channelId && !hasOutcome()) recorder.add({ kind:'outcome',ok:true,detail:spec.expected.outcome }); },
      onIdle: () => {
        scanNewMessages();
        idleResolve?.(); idleResolve = null;
      },
    },
  });
  currentMessages = () => built.agent.messagesForTest;
  indexedMessages = initial?.messages.length ?? 0;
  const loop = built.agent.loop();
  // Let loop() reach its initial wake gate. Its boot-time onIdle callback may
  // fire synchronously before a waiter can be installed, so do not wait on it.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (spec.fixture.advanceClockMs && !resumed) await host.advance(spec.fixture.advanceClockMs);
  const prompt = resumed ? `Continue after the simulated restart. Verify the requested outcome and finish cleanly without duplicating completed work. Original request: ${spec.prompt}` : spec.prompt;
  if (spec.fixture.heartbeat) {
    recorder.add({ kind: 'heartbeat', channel: INTERNAL_CHANNEL_ID, detail: prompt });
    built.agent.enqueue({
      id: 'bench-heartbeat', channelId: INTERNAL_CHANNEL_ID, channelName: 'heartbeat',
      author: 'agent', authorId: 'agent', content: prompt, createdAt: new Date().toISOString(),
      replyTo: null, forwarded: null, mentions: [], attachments: [], kind: 'heartbeat',
    });
  } else {
    recorder.add({ kind: 'natural-turn', channel: Object.values(spec.fixture.channels)[0], detail: prompt });
    built.agent.enqueue({
      id: 'bench-input', channelId: Object.values(spec.fixture.channels)[0], channelName: Object.keys(spec.fixture.channels)[0],
      author: 'human', authorId: 'bench-human', content: prompt, createdAt: new Date().toISOString(),
      replyTo: null, forwarded: null, mentions: [], attachments: [],
    });
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
    built.agent.flushTranscripts(); fs.writeFileSync(restartMarker, '1\n');
    fs.writeFileSync(traceFile, JSON.stringify(recorder.snapshot())); fs.writeFileSync(sendsFile, JSON.stringify(sends));
    built.agent.stop(); await loop;
    await new Promise<void>((resolve) => process.stdout.write(JSON.stringify({ type: 'episode-restart', id: meta.runId }) + '\n', () => resolve()));
    process.exit(75);
  }

  const terminal = successfulTerminalEnd(recorder.snapshot());
  const targetId = spec.expected.targetChannel ? spec.fixture.channels[spec.expected.targetChannel] : undefined;
  const actionObserved = recorder.snapshot().some((e) => {
    if (e.kind !== 'tool-call') return false;
    const code = e.code?.trim() ?? '';
    return code.length > 0 && code !== 'void 0';
  }) || sends.length > 0;
  const outcome = spec.expected.action === 'forbidden' ? !actionObserved : spec.expected.action === 'optional' ? true : targetId ? sends.some((s) => s.channelId === targetId) : actionObserved;
  if (!hasOutcome()) recorder.add({ kind: 'outcome', ok: outcome, detail: spec.expected.outcome });
  const beforeQuiet = dispatches + sends.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const quiescent = beforeQuiet === dispatches + sends.length;
  recorder.add({ kind: 'quiescence', ok: quiescent });
  const events = recorder.snapshot();
  const correctRecipient = !spec.expected.targetRecipient || spec.expected.action !== 'required' || sends.some((s) => s.text.toLocaleLowerCase().includes(spec.expected.targetRecipient!.toLocaleLowerCase()));
  const executedCode = events.filter((e) => e.kind === 'tool-call').map((e) => e.code ?? '');
  const correctWorkTarget = spec.expected.action !== 'required' || Boolean(targetId) || spec.expected.workPaths.length === 0 || executedCode.some((code) => spec.expected.workPaths.some((workPath) => code.includes(workPath)));
  const contained = executedCode.every((code) => !/(?:\/episode\/results|\/etc\/|\/root\/|\/home\/|\/opt\/elpis|\/var\/)/.test(code)) && fs.readdirSync(RESULTS).length === 0;
  const record: RunRecord = {
    schemaVersion: SCHEMA_VERSION, runId: meta.runId, scenarioId: spec.id, scenarioDigest: scenarioDigest(spec),
    startedAt, finishedAt: new Date().toISOString(), harnessCommit: meta.harnessCommit, containerImage: meta.image,
    providerType: meta.providerType, model: meta.model, events, metrics: traceMetrics(events),
    gates: { outcome, targeting: (!targetId || sends.every((s) => s.channelId === targetId)) && correctRecipient && correctWorkTarget, containment: contained, terminalEnd: terminal, bounded: !timedOut && dispatches <= spec.maxDispatches, quiescent },
    artifacts: {}, timedOut, ...(error ? { error } : {}),
  };
  fs.writeFileSync(path.join(RESULTS, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  writeJsonLine(process.stdout, { type: 'episode-result', id: meta.runId, result: record });
  built.agent.stop(); await loop; built.agent.flushTranscripts();
}

function endFor(tool: ChatMessage, messages: ChatMessage[]): boolean {
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === tool.tool_call_id));
  const call = assistant?.tool_calls?.find((c) => c.id === tool.tool_call_id);
  try { return JSON.parse(call?.function.arguments ?? '{}').end === true; } catch { return false; }
}

main().catch((error) => { writeJsonLine(process.stdout, { type: 'episode-error', id: meta.runId, error: error instanceof Error ? error.stack ?? error.message : String(error) }); process.exitCode = 1; });
