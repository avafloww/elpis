import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RetriableError, type ChatMessage, type StandaloneCompleteOptions, type StandaloneCompleteResult } from '../llm/llm.js';
import type { ReasoningItemParam } from '../llm/responses.js';
import { sameReplayIdentity, type ReplayIdentity } from '../llm/provenance.js';
import { resolveDataLayout } from '../store/data-layout.js';

export const MOTOR_KEYS = ['Up', 'Down', 'Left', 'Right', 'space', 'f', 'Escape', 'Return', 'Tab', 'Shift_L'] as const;
const MOTOR_KEY_SET = new Set<string>(MOTOR_KEYS);
const MAX_ACTION_MS = 2_000;
const MAX_WAIT_MS = 5_000;
const MAX_STEPS = 50;

export interface MotorAction {
  keys: string[];
  durationMs: number;
  waitMs: number;
  done: boolean;
  reason: string;
  confidence?: number;
}

export interface MotorStepOptions {
  context?: string;
  cacheKey?: string;
  reasoningEffort?: string;
  retries?: number;
  /** Per provider attempt. Aborts the in-flight standalone stream, not just the caller's wait. */
  completionTimeoutMs?: number;
  traceId?: string;
  dryRun?: boolean;
  settleMs?: number;
}

export interface MotorRunOptions extends MotorStepOptions {
  maxSteps?: number;
  resume?: boolean;
}

export interface MotorControllerDeps {
  dataDirectory: string;
  completeStandalone: (messages: ChatMessage[], opts?: StandaloneCompleteOptions) => Promise<StandaloneCompleteResult>;
  screenshot: (filename: string) => Promise<{ file: string }>;
  hold: (keys: string[], durationMs: number) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Exact configured wire identity. null disables opaque reasoning replay. */
  replayIdentity?: ReplayIdentity | null;
}

interface MotorTraceStep {
  type: 'step';
  traceId: string;
  step: number;
  at: string;
  objective: string;
  frame: string;
  response: string;
  action: MotorAction;
  acted: boolean;
  actionResult?: unknown;
  actualWaitMs: number;
  latencyMs: number;
  completionAttempts: number;
  completionTimeoutMs: number;
  completionErrors?: string[];
  usage: StandaloneCompleteResult['usage'];
  requestId?: string;
  model?: string;
  providerType?: ReplayIdentity['providerType'];
  apiSurface?: ReplayIdentity['apiSurface'];
  apiEndpoint?: string;
  replaySourceId?: string;
  reasoningEffort?: string;
  reasoningItems?: ReasoningItemParam[];
  reasoningItemsIn: number;
  reasoningBytesIn: number;
  reasoningBytesOut: number;
}

const MOTOR_PROMPT = `You are a bounded video-game motor controller, not a conversational agent and not a person.
Choose exactly ONE short keyboard action from the current screenshot.
Allowed keys: ${MOTOR_KEYS.join(', ')}.
Control semantics: Up = move forward; Down = move backward; Left/Right = turn; f = fire; space = use/open; Escape = pause/back; Return = confirm menu; Tab = automap; Shift_L = run modifier.
Use at most 3 simultaneous keys. duration_ms must be 20..2000 for an action; wait_ms must be 0..5000.
If the objective is already satisfied or no safe useful action exists, set done=true with no keys and duration_ms=0.
Return ONLY one JSON object with exactly this shape:
{"keys":["Up"],"duration_ms":250,"wait_ms":100,"done":false,"reason":"short concrete reason","confidence":0.0}
Do not use markdown. Do not narrate. Do not invent keys. Do not claim success unless it is visible in the frame.`;

function finiteInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`motor action ${name} must be a finite number`);
  const number = Math.round(value);
  if (number < min || number > max) throw new Error(`motor action ${name} must be ${min}..${max}`);
  return number;
}

export function extractMotorJson(text: string): string {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('motor response contained no JSON object');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error('motor response JSON object was not closed');
}

export function parseMotorAction(text: string): MotorAction {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(extractMotorJson(text)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid motor JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('motor response must be one JSON object');
  const done = raw.done === true;
  if (raw.done !== true && raw.done !== false) throw new Error('motor action done must be boolean');
  if (!Array.isArray(raw.keys) || raw.keys.some((key) => typeof key !== 'string')) throw new Error('motor action keys must be a string array');
  const keys = [...new Set(raw.keys as string[])];
  if (keys.length > 3) throw new Error('motor action may hold at most 3 keys');
  const forbidden = keys.find((key) => !MOTOR_KEY_SET.has(key));
  if (forbidden) throw new Error(`motor action key is not allowed: ${forbidden}`);
  if (done && keys.length > 0) throw new Error('done motor action must not include keys');
  if (!done && keys.length === 0) throw new Error('non-done motor action requires at least one key');
  const durationMs = finiteInt(raw.duration_ms, 'duration_ms', done ? 0 : 20, done ? 0 : MAX_ACTION_MS);
  const waitMs = finiteInt(raw.wait_ms, 'wait_ms', 0, MAX_WAIT_MS);
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 300) {
    throw new Error('motor action reason must be 1..300 characters');
  }
  let confidence: number | undefined;
  if (raw.confidence !== undefined) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
      throw new Error('motor action confidence must be 0..1');
    }
    confidence = raw.confidence;
  }
  return { keys, durationMs, waitMs, done, reason: raw.reason.trim(), ...(confidence !== undefined ? { confidence } : {}) };
}

function safeTraceId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!safe) throw new Error('motor traceId must contain a letter or number');
  return safe;
}

function imageMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  throw new Error(`motor screenshot has unsupported image extension: ${ext || '(none)'}`);
}

function readTrace(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) throw new Error(`motor trace does not exist: ${file}`);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error(`motor trace line ${index + 1} is invalid JSON`); }
  });
}

export function createMotorController(deps: MotorControllerDeps): Record<string, unknown> {
  const tracesDir = path.join(resolveDataLayout(deps.dataDirectory).motor, 'traces');
  fs.mkdirSync(tracesDir, { recursive: true, mode: 0o700 });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const sourceFile = path.join(tracesDir, '.source-id');
  let replaySourceSecret: string;
  try {
    replaySourceSecret = fs.readFileSync(sourceFile, 'utf8').trim();
    if (!/^[0-9a-f-]{36}$/i.test(replaySourceSecret)) throw new Error('invalid motor source id');
  } catch {
    replaySourceSecret = randomUUID();
    fs.writeFileSync(sourceFile, `${replaySourceSecret}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const replaySourceId = createHash('sha256').update(`elpis-motor:${replaySourceSecret}`).digest('hex');

  const tracePath = (traceId: string) => path.join(tracesDir, `${safeTraceId(traceId)}.jsonl`);
  const append = (file: string, event: Record<string, unknown>) => {
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  };

  const takeStep = async (
    objectiveValue: string,
    opts: MotorStepOptions,
    traceId: string,
    step: number,
    recentActions: MotorAction[],
    priorTurn?: {
      response: string;
      replayIdentity?: ReplayIdentity;
      replaySourceId?: string;
      reasoningItems?: ReasoningItemParam[];
    },
  ): Promise<MotorTraceStep> => {
    if (typeof objectiveValue !== 'string' || !objectiveValue.trim() || objectiveValue.length > 2_000) {
      throw new Error('elpis.motor: objective must be a non-empty string up to 2000 characters');
    }
    if (opts.context !== undefined && (typeof opts.context !== 'string' || opts.context.length > 4_000)) {
      throw new Error('elpis.motor: context must be a string up to 4000 characters');
    }
    const file = tracePath(traceId);
    const frame = path.join(tracesDir, `${safeTraceId(traceId)}-${String(step).padStart(4, '0')}.png`);
    await deps.screenshot(frame);
    const stat = fs.statSync(frame);
    if (stat.size > 10 * 1024 * 1024) throw new Error(`elpis.motor: screenshot exceeds 10MB (${stat.size} bytes)`);
    const dataUrl = `data:${imageMime(frame)};base64,${fs.readFileSync(frame).toString('base64')}`;
    const recent = recentActions.slice(-6).map((action, index) => `${index + 1}. ${action.keys.join('+') || 'done'} ${action.durationMs}ms — ${action.reason}`).join('\n');
    const text = [
      `Objective: ${objectiveValue.trim()}`,
      opts.context ? `Operator context: ${opts.context}` : '',
      recent ? `Recent actions (oldest first):\n${recent}` : 'Recent actions: none',
      'Choose the next single action from this frame.',
    ].filter(Boolean).join('\n\n');
    const expectedIdentity = deps.replayIdentity ?? null;
    const trustedPrior = priorTurn?.replaySourceId === replaySourceId &&
      sameReplayIdentity(priorTurn?.replayIdentity, expectedIdentity);
    const replayReasoningItems = trustedPrior ? priorTurn?.reasoningItems : undefined;
    const reasoningBytes = (items: ReasoningItemParam[] | undefined) => (items ?? []).reduce((sum, item) => sum + (typeof item.encrypted_content === 'string' ? item.encrypted_content.length : 0), 0);
    const messages: ChatMessage[] = [{ role: 'system', content: MOTOR_PROMPT }];
    if (replayReasoningItems?.length) {
      messages.push({
        role: 'assistant',
        content: priorTurn?.response ?? '',
        reasoning_items: replayReasoningItems,
      });
    }
    messages.push({
      role: 'user', content: text,
      contentParts: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
      ],
    });
    const started = now();
    let completion: StandaloneCompleteResult | undefined;
    const maxRetries = finiteInt(opts.retries ?? 2, 'retries', 0, 5);
    const completionTimeoutMs = finiteInt(opts.completionTimeoutMs ?? 30_000, 'completionTimeoutMs', 20, 300_000);
    const completionErrors: string[] = [];
    let completionAttempts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      completionAttempts++;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), completionTimeoutMs);
      try {
        completion = await deps.completeStandalone(messages, {
          cacheKey: opts.cacheKey ?? `motor-${safeTraceId(traceId)}`,
          ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
          signal: controller.signal,
        });
        break;
      } catch (rawError) {
        const error = controller.signal.aborted
          ? new RetriableError(new Error(`motor completion timed out after ${completionTimeoutMs}ms`))
          : rawError;
        const message = error instanceof Error ? error.message : String(error);
        completionErrors.push(message);
        if (controller.signal.aborted || !(error instanceof RetriableError) || attempt === maxRetries) {
          append(file, { type: 'error', traceId, step, at: new Date(now()).toISOString(), frame, stage: 'complete', completionAttempts, completionTimeoutMs, completionErrors, error: message });
          throw error;
        }
        await sleep(Math.min(500 * (2 ** attempt), 2_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!completion) throw new Error('elpis.motor: completion retry loop ended without a result');
    if (completion.content.length > 16_384) {
      const error = new Error(`motor response exceeded 16384 characters (${completion.content.length})`);
      append(file, { type: 'error', traceId, step, at: new Date(now()).toISOString(), frame, stage: 'validate', responseChars: completion.content.length, usage: completion.usage, error: error.message });
      throw error;
    }
    let action: MotorAction;
    try {
      action = parseMotorAction(completion.content);
    } catch (error) {
      append(file, { type: 'error', traceId, step, at: new Date(now()).toISOString(), frame, stage: 'validate', response: completion.content, usage: completion.usage, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    let actionResult: unknown;
    const acted = !opts.dryRun && !action.done;
    try {
      if (acted) actionResult = await deps.hold(action.keys, action.durationMs);
      const settleMs = finiteInt(opts.settleMs ?? 100, 'settleMs', 0, MAX_WAIT_MS);
      const actualWaitMs = action.waitMs + settleMs;
      if (acted && actualWaitMs > 0) await sleep(actualWaitMs);
      const event: MotorTraceStep = {
        type: 'step', traceId, step, at: new Date(now()).toISOString(), objective: objectiveValue.trim(), frame,
        response: completion.content, action, acted, ...(actionResult !== undefined ? { actionResult } : {}),
        actualWaitMs, latencyMs: Math.max(0, now() - started), completionAttempts, completionTimeoutMs,
        ...(completionErrors.length > 0 ? { completionErrors } : {}), usage: completion.usage,
        ...(completion.requestId ? { requestId: completion.requestId } : {}),
        ...(completion.model ? { model: completion.model } : {}),
        ...(completion.providerType ? { providerType: completion.providerType } : {}),
        ...(completion.apiSurface ? { apiSurface: completion.apiSurface } : {}),
        ...(completion.apiEndpoint ? { apiEndpoint: completion.apiEndpoint } : {}),
        ...(sameReplayIdentity(completion.providerType && completion.model && completion.apiSurface && completion.apiEndpoint ? {
          providerType: completion.providerType, model: completion.model,
          apiSurface: completion.apiSurface, apiEndpoint: completion.apiEndpoint,
        } : null, expectedIdentity) ? { replaySourceId } : {}),
        ...(completion.reasoningEffort ? { reasoningEffort: completion.reasoningEffort } : {}),
        ...(completion.reasoningItems ? { reasoningItems: completion.reasoningItems } : {}),
        reasoningItemsIn: replayReasoningItems?.length ?? 0,
        reasoningBytesIn: reasoningBytes(replayReasoningItems),
        reasoningBytesOut: reasoningBytes(completion.reasoningItems),
      };
      append(file, event as unknown as Record<string, unknown>);
      return event;
    } catch (error) {
      append(file, { type: 'error', traceId, step, at: new Date(now()).toISOString(), frame, stage: 'act', response: completion.content, action, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  return {
    keys: [...MOTOR_KEYS],
    step: async (objective: string, opts: MotorStepOptions = {}) => {
      const traceId = safeTraceId(opts.traceId ?? `motor-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      const file = tracePath(traceId);
      const events = fs.existsSync(file) ? readTrace(file) : [];
      const prior = events.filter((event) => event.type === 'step');
      const recent = prior.map((event) => parseMotorAction(String(event.response ?? '')));
      const priorTurn = prior.at(-1) as Record<string, unknown> | undefined;
      const event = await takeStep(objective, opts, traceId, events.length, recent, priorTurn ? {
        response: String(priorTurn.response ?? ''),
        replayIdentity: typeof priorTurn.providerType === 'string' && typeof priorTurn.model === 'string' &&
          typeof priorTurn.apiSurface === 'string' && typeof priorTurn.apiEndpoint === 'string'
          ? {
            providerType: priorTurn.providerType as ReplayIdentity['providerType'],
            model: priorTurn.model,
            apiSurface: priorTurn.apiSurface as ReplayIdentity['apiSurface'],
            apiEndpoint: priorTurn.apiEndpoint,
          }
          : undefined,
        replaySourceId: typeof priorTurn.replaySourceId === 'string' ? priorTurn.replaySourceId : undefined,
        reasoningItems: Array.isArray(priorTurn.reasoningItems) ? priorTurn.reasoningItems as ReasoningItemParam[] : undefined,
      } : undefined);
      return { ...event, traceFile: file };
    },
    run: async (objective: string, opts: MotorRunOptions = {}) => {
      const maxSteps = finiteInt(opts.maxSteps ?? 10, 'maxSteps', 1, MAX_STEPS);
      if (opts.resume && !opts.traceId) throw new Error('elpis.motor.run: resume requires traceId');
      const traceId = safeTraceId(opts.traceId ?? `motor-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      const file = tracePath(traceId);
      const exists = fs.existsSync(file);
      if (exists && !opts.resume) throw new Error(`elpis.motor.run: trace already exists: ${file}`);
      if (!exists && opts.resume) throw new Error(`elpis.motor.run: cannot resume missing trace: ${file}`);
      const history = exists ? readTrace(file) : [];
      const priorSteps = history.filter((event) => event.type === 'step')
        .map((event) => parseMotorAction(String(event.response ?? '')));
      if (priorSteps.at(-1)?.done) return { ok: true, traceId, traceFile: file, done: true, resumedFrom: history.length, steps: [] };
      const steps: MotorTraceStep[] = [];
      const startStep = history.length;
      for (let offset = 0; offset < maxSteps; offset++) {
        const previous = steps.at(-1) ?? history.filter((event) => event.type === 'step').at(-1);
        const event = await takeStep(
          objective, opts, traceId, startStep + offset, [...priorSteps, ...steps.map((item) => item.action)],
          previous ? {
            response: String(previous.response ?? ''),
            replayIdentity: typeof previous.providerType === 'string' && typeof previous.model === 'string' &&
              typeof previous.apiSurface === 'string' && typeof previous.apiEndpoint === 'string'
              ? {
                providerType: previous.providerType as ReplayIdentity['providerType'],
                model: previous.model,
                apiSurface: previous.apiSurface as ReplayIdentity['apiSurface'],
                apiEndpoint: previous.apiEndpoint,
              }
              : undefined,
            replaySourceId: typeof previous.replaySourceId === 'string' ? previous.replaySourceId : undefined,
            reasoningItems: Array.isArray(previous.reasoningItems) ? previous.reasoningItems as ReasoningItemParam[] : undefined,
          } : undefined,
        );
        steps.push(event);
        if (event.action.done) break;
      }
      return { ok: true, traceId, traceFile: file, done: steps.at(-1)?.action.done ?? false, resumedFrom: startStep, steps };
    },
    replay: async (traceFileValue: string, opts: { execute?: boolean } = {}) => {
      const file = path.resolve(traceFileValue);
      if (!file.startsWith(`${path.resolve(tracesDir)}${path.sep}`)) throw new Error('elpis.motor.replay: trace must be under DATA_DIR/elpis-data/motor/traces');
      const events = readTrace(file).filter((event) => event.type === 'step');
      if (events.length > MAX_STEPS) throw new Error(`elpis.motor.replay: trace exceeds ${MAX_STEPS} steps`);
      const actions = events.map((event) => parseMotorAction(String(event.response ?? '')));
      if (opts.execute) {
        for (const action of actions) {
          if (action.done) break;
          await deps.hold(action.keys, action.durationMs);
          if (action.waitMs > 0) await sleep(action.waitMs);
        }
      }
      return { ok: true, traceFile: file, execute: opts.execute === true, actions };
    },
    list: (limitValue = 20) => {
      const limit = finiteInt(limitValue, 'limit', 1, 100);
      return fs.readdirSync(tracesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => {
          const file = path.join(tracesDir, entry.name);
          const stat = fs.statSync(file);
          return { traceId: entry.name.slice(0, -6), file, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        .slice(0, limit);
    },
  };
}
