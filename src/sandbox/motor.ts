import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RetriableError,
  type ChatMessage,
  type StandaloneCompleteOptions,
  type StandaloneCompleteResult,
} from '../llm/llm.js';
import { resolveDataLayout } from '../store/data-layout.js';

type MotorToolName = 'click' | 'double_click' | 'drag' | 'write' | 'press' | 'scroll';
type NativeTool = Extract<NonNullable<StandaloneCompleteOptions['tools']>[number], { type: 'function' }>;
type NativeToolCall = NonNullable<StandaloneCompleteResult['toolCalls']>[number];
type EpisodeStatus = 'running' | 'awaiting_oversight' | 'needs_guidance' | 'completed' | 'interrupted' | 'budget_exhausted' | 'failed';

const ACTION_TOOLS: MotorToolName[] = ['click', 'double_click', 'drag', 'write', 'press', 'scroll'];
const ACTION_TOOL_SET = new Set<string>(ACTION_TOOLS);
const TERMINAL_STATUSES = new Set<EpisodeStatus>(['completed', 'interrupted', 'budget_exhausted', 'failed']);
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_GOAL_CHARS = 2_000;
const MAX_GUIDANCE_CHARS = 2_000;
const MAX_WRITE_CHARS = 2_000;
const MAX_EPISODES = 100;
const MAX_MESSAGES = 160;
const RECENT_SCREENSHOTS = 3;

export interface MotorAuthorityInput {
  allowedTools?: MotorToolName[];
  maxPointerActions?: number;
  maxWrites?: number;
  maxTextChars?: number;
  maxKeyPresses?: number;
  maxScrolls?: number;
}

interface MotorAuthority {
  allowedTools: MotorToolName[];
  maxPointerActions: number;
  maxWrites: number;
  maxTextChars: number;
  maxKeyPresses: number;
  maxScrolls: number;
}

export interface MotorStartOptions {
  episodeId?: string;
  dryRun?: boolean;
  maxTurns?: number;
  softTurnBudget?: number;
  hardTurnBudget?: number;
  maxWallMs?: number;
  settleMs?: number;
  completionTimeoutMs?: number;
  authority?: MotorAuthorityInput;
}

export interface MotorOversightPacket {
  episodeId: string;
  checkpointSeq: number;
  status: EpisodeStatus;
  goal: string;
  frame: string | null;
  turns: number;
  traceFile: string;
  recent: Array<{ tool: string; arguments: string; receipt: string; reasoning: string; content: string; latencyMs: number; at: string }>;
}

export interface MotorControllerDeps {
  dataDirectory: string;
  completeStandalone: (messages: ChatMessage[], opts?: StandaloneCompleteOptions) => Promise<StandaloneCompleteResult>;
  screenshot: (filename: string) => Promise<{ file: string }>;
  click: (x: number, y: number, opts?: { count?: number }) => Promise<unknown>;
  drag: (fromX: number, fromY: number, toX: number, toY: number) => Promise<unknown>;
  type: (text: string) => Promise<unknown>;
  key: (keys: string | string[]) => Promise<unknown>;
  scroll: (clicks: number) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  notifyOversight?: (packet: MotorOversightPacket) => void | Promise<void>;
}

interface EpisodeCounters {
  pointerActions: number;
  writes: number;
  textChars: number;
  keyPresses: number;
  scrolls: number;
}

interface EpisodeRecord {
  episodeId: string;
  goal: string;
  status: EpisodeStatus;
  startedAt: number;
  updatedAt: number;
  turns: number;
  checkpointSeq: number;
  lastAcknowledgedTurn: number;
  lastNotifiedTurn: number;
  frame: string | null;
  traceFile: string;
  messages: ChatMessage[];
  authority: MotorAuthority;
  counters: EpisodeCounters;
  opts: Required<Omit<MotorStartOptions, 'episodeId' | 'authority'>>;
  pendingGuidance: string | null;
  recent: Array<{ tool: string; arguments: string; receipt: string; reasoning: string; content: string; latencyMs: number; at: string }>;
  abortController: AbortController | null;
  loopRunning: boolean;
  lastError: string | null;
  runtime: MotorControllerDeps;
}

const PRESS_KEYS: Record<string, string> = {
  ENTER: 'Return', TAB: 'Tab', ESCAPE: 'Escape', BACKSPACE: 'BackSpace', DELETE: 'Delete',
  ARROW_UP: 'Up', ARROW_DOWN: 'Down', ARROW_LEFT: 'Left', ARROW_RIGHT: 'Right',
  HOME: 'Home', END: 'End', PAGE_UP: 'Prior', PAGE_DOWN: 'Next', SPACE: 'space',
  CTRL_L: 'Control_L+l', CTRL_R: 'Control_L+r', CTRL_T: 'Control_L+t', CTRL_W: 'Control_L+w',
};

const MOTOR_SYSTEM_PROMPT = `You are a resident visual motor cortex controlling a computer through the available native tools.
Follow the scoped goal and visible interface evidence. Take exactly one short action per screenshot, then wait for the tool receipt and next observation.
Do not invent completion: call done only after success is visibly present. Use needs_guidance when the next safe action or authority is unclear.
Coordinates are normalized integers from 0 to 1000 against the exact screenshot, origin at top-left.
Tool receipts are authoritative. Prior screenshots may be replaced by [screenshot evicted]; preserve useful state in concise assistant content when needed.
Keep credentials out of reasoning, action arguments, and traces; use opaque host secret handoff when available. Never broaden the goal or authority envelope.`;

const amountSchema = { type: 'string', enum: ['small', 'medium', 'large'] } as const;
const pointProperties = {
  element: { type: 'string', minLength: 1, maxLength: 240 },
  x: { type: 'integer', minimum: 0, maximum: 1000 },
  y: { type: 'integer', minimum: 0, maximum: 1000 },
};

export const DESKTOP_MOTOR_TOOLS: NativeTool[] = [
  { type: 'function', function: { name: 'click', description: 'Click one visible interface element.', parameters: { type: 'object', additionalProperties: false, properties: pointProperties, required: ['element', 'x', 'y'] } } },
  { type: 'function', function: { name: 'double_click', description: 'Double-click one visible interface element.', parameters: { type: 'object', additionalProperties: false, properties: pointProperties, required: ['element', 'x', 'y'] } } },
  { type: 'function', function: { name: 'drag', description: 'Drag from one normalized point to another.', parameters: { type: 'object', additionalProperties: false, properties: { element: { type: 'string', minLength: 1, maxLength: 240 }, from_x: { type: 'integer', minimum: 0, maximum: 1000 }, from_y: { type: 'integer', minimum: 0, maximum: 1000 }, to_x: { type: 'integer', minimum: 0, maximum: 1000 }, to_y: { type: 'integer', minimum: 0, maximum: 1000 } }, required: ['element', 'from_x', 'from_y', 'to_x', 'to_y'] } } },
  { type: 'function', function: { name: 'write', description: 'Type text into the currently focused field.', parameters: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: MAX_WRITE_CHARS } }, required: ['text'] } } },
  { type: 'function', function: { name: 'press', description: 'Press one bounded keyboard key or shortcut.', parameters: { type: 'object', additionalProperties: false, properties: { key: { type: 'string', enum: Object.keys(PRESS_KEYS) } }, required: ['key'] } } },
  { type: 'function', function: { name: 'scroll', description: 'Scroll the current view.', parameters: { type: 'object', additionalProperties: false, properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: amountSchema }, required: ['direction', 'amount'] } } },
  { type: 'function', function: { name: 'done', description: 'Finish only when the goal is visibly complete.', parameters: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'needs_guidance', description: 'Pause and ask the supervising mind for guidance.', parameters: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['reason'] } } },
];

function finiteInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  const n = Math.round(value);
  if (n < min || n > max) throw new Error(`${label} must be ${min}..${max}`);
  return n;
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!id) throw new Error('motor episodeId must contain a letter or number');
  return id;
}

function authority(value: MotorAuthorityInput = {}): MotorAuthority {
  const rawTools = value.allowedTools ?? ACTION_TOOLS;
  if (!Array.isArray(rawTools) || rawTools.length === 0) throw new Error('motor authority.allowedTools must be a non-empty array');
  const allowedTools = [...new Set(rawTools)];
  const invalid = allowedTools.find((name) => !ACTION_TOOL_SET.has(name));
  if (invalid) throw new Error(`motor authority tool is not supported: ${invalid}`);
  return {
    allowedTools,
    maxPointerActions: finiteInt(value.maxPointerActions ?? 20, 'motor authority.maxPointerActions', 0, 200),
    maxWrites: finiteInt(value.maxWrites ?? 10, 'motor authority.maxWrites', 0, 100),
    maxTextChars: finiteInt(value.maxTextChars ?? 8_000, 'motor authority.maxTextChars', 0, 100_000),
    maxKeyPresses: finiteInt(value.maxKeyPresses ?? 20, 'motor authority.maxKeyPresses', 0, 200),
    maxScrolls: finiteInt(value.maxScrolls ?? 30, 'motor authority.maxScrolls', 0, 300),
  };
}

function strictObject(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} arguments must be one object`);
  const obj = value as Record<string, unknown>;
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} arguments must contain exactly ${expected.join(', ')}`);
  }
  return obj;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be 1..${max} characters`);
  return value;
}

function normalized(value: unknown, label: string): number {
  return finiteInt(value, label, 0, 1000);
}

function pngDimensions(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file).subarray(0, 24);
  if (header.length < 24 || header.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('motor screenshot must be a PNG');
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) throw new Error(`motor screenshot dimensions are invalid: ${width}x${height}`);
  return { width, height };
}

function pixel(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, Math.round((value / 1000) * size)));
}

function dataUrl(file: string): string {
  const stat = fs.statSync(file);
  if (stat.size > MAX_SCREENSHOT_BYTES) throw new Error(`motor screenshot exceeds 10MB (${stat.size} bytes)`);
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

export function trimMotorImages(messages: ChatMessage[], keep = RECENT_SCREENSHOTS): void {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const parts = messages[index].contentParts;
    if (!parts) continue;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      if (parts[partIndex]?.type !== 'image_url') continue;
      seen++;
      if (seen > keep) parts[partIndex] = { type: 'text', text: '[screenshot evicted]' };
    }
  }
}

export function parseMotorToolCall(toolCalls: StandaloneCompleteResult['toolCalls']): { call: NativeToolCall; args: Record<string, unknown> } {
  if (!toolCalls || toolCalls.length !== 1) throw new Error('motor model must return exactly one native tool call');
  const call = toolCalls[0];
  if (!call.id || call.type !== 'function' || !call.function.name) throw new Error('motor tool call is malformed');
  let args: unknown;
  try { args = JSON.parse(call.function.arguments || '{}'); }
  catch (error) { throw new Error(`motor tool arguments are invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('motor tool arguments must be one object');
  return { call, args: args as Record<string, unknown> };
}

function toolsFor(scope: MotorAuthority): NativeTool[] {
  return DESKTOP_MOTOR_TOOLS.filter((tool) => {
    const name = tool.function.name;
    return name === 'done' || name === 'needs_guidance' || scope.allowedTools.includes(name as MotorToolName);
  });
}

function snapshot(episode: EpisodeRecord) {
  return {
    episodeId: episode.episodeId,
    goal: episode.goal,
    status: episode.status,
    checkpointSeq: episode.checkpointSeq,
    turns: episode.turns,
    startedAt: new Date(episode.startedAt).toISOString(),
    updatedAt: new Date(episode.updatedAt).toISOString(),
    frame: episode.frame,
    traceFile: episode.traceFile,
    counters: { ...episode.counters },
    authority: { ...episode.authority, allowedTools: [...episode.authority.allowedTools] },
    recent: [...episode.recent],
    lastError: episode.lastError,
  };
}

function append(file: string, event: Record<string, unknown>): void {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function oversightPacket(episode: EpisodeRecord): MotorOversightPacket {
  return {
    episodeId: episode.episodeId,
    checkpointSeq: episode.checkpointSeq,
    status: episode.status,
    goal: episode.goal,
    frame: episode.frame,
    turns: episode.turns,
    traceFile: episode.traceFile,
    recent: [...episode.recent],
  };
}

interface ResidentController {
  api: Record<string, unknown>;
  updateDeps(deps: MotorControllerDeps): void;
}

const RESIDENTS = new Map<string, ResidentController>();

function buildResident(initialDeps: MotorControllerDeps): ResidentController {
  let deps = initialDeps;
  const now = () => (deps.now ?? Date.now)();
  const episodeNow = (episode: EpisodeRecord) => (episode.runtime.now ?? Date.now)();
  const episodeSleep = (episode: EpisodeRecord, ms: number) => (episode.runtime.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))))(ms);
  const episodesDir = path.join(resolveDataLayout(deps.dataDirectory).motor, 'episodes');
  fs.mkdirSync(episodesDir, { recursive: true, mode: 0o700 });
  const episodes = new Map<string, EpisodeRecord>();

  const getEpisode = (episodeId: string): EpisodeRecord => {
    const episode = episodes.get(safeId(episodeId));
    if (!episode) throw new Error(`elpis.motor: unknown episode ${episodeId}`);
    return episode;
  };

  const notify = (episode: EpisodeRecord) => {
    if (!episode.runtime.notifyOversight) return;
    Promise.resolve(episode.runtime.notifyOversight(oversightPacket(episode))).catch((error) => {
      append(episode.traceFile, { type: 'oversight_notification_error', at: new Date(episodeNow(episode)).toISOString(), error: error instanceof Error ? error.message : String(error) });
    });
  };

  const execute = async (episode: EpisodeRecord, name: string, argsValue: Record<string, unknown>, dimensions: { width: number; height: number }): Promise<{ receipt: string; terminal?: EpisodeStatus }> => {
    if (name === 'done') {
      const args = strictObject(argsValue, name, ['summary']);
      const summary = boundedText(args.summary, 'done summary', 500);
      return { receipt: `complete: ${summary}`, terminal: 'completed' };
    }
    if (name === 'needs_guidance') {
      const args = strictObject(argsValue, name, ['reason']);
      const reason = boundedText(args.reason, 'guidance reason', 500);
      return { receipt: `paused for guidance: ${reason}`, terminal: 'needs_guidance' };
    }
    if (!episode.authority.allowedTools.includes(name as MotorToolName)) throw new Error(`motor action is outside authority: ${name}`);

    let result: unknown;
    if (name === 'click' || name === 'double_click') {
      const args = strictObject(argsValue, name, ['element', 'x', 'y']);
      const element = boundedText(args.element, `${name} element`, 240);
      const x = normalized(args.x, `${name} x`), y = normalized(args.y, `${name} y`);
      if (episode.counters.pointerActions >= episode.authority.maxPointerActions) throw new Error('motor pointer-action authority exhausted');
      episode.counters.pointerActions++;
      if (!episode.opts.dryRun) result = await episode.runtime.click(pixel(x, dimensions.width), pixel(y, dimensions.height), { count: name === 'double_click' ? 2 : 1 });
      return { receipt: JSON.stringify({ ok: true, action: name, element, x, y, dryRun: episode.opts.dryRun, result }) };
    }
    if (name === 'drag') {
      const args = strictObject(argsValue, name, ['element', 'from_x', 'from_y', 'to_x', 'to_y']);
      const element = boundedText(args.element, 'drag element', 240);
      const fromX = normalized(args.from_x, 'drag from_x'), fromY = normalized(args.from_y, 'drag from_y');
      const toX = normalized(args.to_x, 'drag to_x'), toY = normalized(args.to_y, 'drag to_y');
      if (episode.counters.pointerActions >= episode.authority.maxPointerActions) throw new Error('motor pointer-action authority exhausted');
      episode.counters.pointerActions++;
      if (!episode.opts.dryRun) result = await episode.runtime.drag(pixel(fromX, dimensions.width), pixel(fromY, dimensions.height), pixel(toX, dimensions.width), pixel(toY, dimensions.height));
      return { receipt: JSON.stringify({ ok: true, action: name, element, fromX, fromY, toX, toY, dryRun: episode.opts.dryRun, result }) };
    }
    if (name === 'write') {
      const args = strictObject(argsValue, name, ['text']);
      const text = boundedText(args.text, 'write text', MAX_WRITE_CHARS);
      if (episode.counters.writes >= episode.authority.maxWrites) throw new Error('motor write authority exhausted');
      if (episode.counters.textChars + text.length > episode.authority.maxTextChars) throw new Error('motor text-character authority exhausted');
      episode.counters.writes++;
      episode.counters.textChars += text.length;
      if (!episode.opts.dryRun) result = await episode.runtime.type(text);
      return { receipt: JSON.stringify({ ok: true, action: name, length: text.length, dryRun: episode.opts.dryRun, result }) };
    }
    if (name === 'press') {
      const args = strictObject(argsValue, name, ['key']);
      const keyName = boundedText(args.key, 'press key', 40);
      const key = PRESS_KEYS[keyName];
      if (!key) throw new Error(`motor key is not allowed: ${keyName}`);
      if (episode.counters.keyPresses >= episode.authority.maxKeyPresses) throw new Error('motor key-press authority exhausted');
      episode.counters.keyPresses++;
      if (!episode.opts.dryRun) result = await episode.runtime.key(key);
      return { receipt: JSON.stringify({ ok: true, action: name, key: keyName, dryRun: episode.opts.dryRun, result }) };
    }
    if (name === 'scroll') {
      const args = strictObject(argsValue, name, ['direction', 'amount']);
      if (args.direction !== 'up' && args.direction !== 'down') throw new Error('scroll direction must be up or down');
      if (args.amount !== 'small' && args.amount !== 'medium' && args.amount !== 'large') throw new Error('scroll amount must be small, medium, or large');
      if (episode.counters.scrolls >= episode.authority.maxScrolls) throw new Error('motor scroll authority exhausted');
      episode.counters.scrolls++;
      const clicks = { small: 3, medium: 6, large: 10 }[args.amount];
      const signed = args.direction === 'down' ? clicks : -clicks;
      if (!episode.opts.dryRun) result = await episode.runtime.scroll(signed);
      return { receipt: JSON.stringify({ ok: true, action: name, direction: args.direction, amount: args.amount, dryRun: episode.opts.dryRun, result }) };
    }
    throw new Error(`motor returned unknown tool: ${name}`);
  };

  const complete = async (episode: EpisodeRecord): Promise<StandaloneCompleteResult> => {
    const errors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      episode.abortController = controller;
      const timeout = setTimeout(() => controller.abort(), episode.opts.completionTimeoutMs);
      try {
        return await episode.runtime.completeStandalone(episode.messages, {
          cacheKey: `motor-${episode.episodeId}`,
          reasoningEffort: 'medium',
          tools: toolsFor(episode.authority),
          toolChoice: 'required',
          temperature: 0.8,
          topP: 0.95,
          topK: 20,
          maxTokens: 512,
          chatTemplateKwargs: { enable_thinking: true },
          allowHistoricalToolMessages: true,
          signal: controller.signal,
        });
      } catch (error) {
        const message = controller.signal.aborted ? `motor completion timed out after ${episode.opts.completionTimeoutMs}ms` : error instanceof Error ? error.message : String(error);
        errors.push(message);
        if (controller.signal.aborted || !(error instanceof RetriableError) || attempt === 1) throw new Error(errors.join(' | '));
        await episodeSleep(episode, 500);
      } finally {
        clearTimeout(timeout);
        if (episode.abortController === controller) episode.abortController = null;
      }
    }
    throw new Error('motor completion retry loop ended unexpectedly');
  };

  const runEpisode = async (episode: EpisodeRecord): Promise<void> => {
    if (episode.loopRunning || episode.status !== 'running') return;
    episode.loopRunning = true;
    try {
      while (episode.status === 'running') {
        const elapsed = episodeNow(episode) - episode.startedAt;
        if (episode.turns >= episode.opts.maxTurns || elapsed >= episode.opts.maxWallMs) {
          episode.status = 'budget_exhausted';
          episode.updatedAt = episodeNow(episode);
          append(episode.traceFile, { type: 'budget_exhausted', at: new Date(episode.updatedAt).toISOString(), turns: episode.turns, elapsedMs: elapsed });
          notify(episode);
          break;
        }
        if (episode.turns - episode.lastAcknowledgedTurn >= episode.opts.hardTurnBudget) {
          episode.status = 'awaiting_oversight';
          episode.updatedAt = episodeNow(episode);
          append(episode.traceFile, { type: 'awaiting_oversight', at: new Date(episode.updatedAt).toISOString(), checkpointSeq: episode.checkpointSeq, turns: episode.turns });
          notify(episode);
          break;
        }

        const frame = path.join(episodesDir, `${episode.episodeId}-${String(episode.turns).padStart(4, '0')}.png`);
        await episode.runtime.screenshot(frame);
        const dimensions = pngDimensions(frame);
        episode.frame = frame;
        const guidance = episode.pendingGuidance;
        episode.pendingGuidance = null;
        const text = `<observation>\nGoal: ${episode.goal}\n${guidance ? `Supervisor guidance: ${guidance}\n` : ''}Current interface screenshot. Continue from visible state and authoritative tool receipts.\n`;
        episode.messages.push({
          role: 'user',
          content: `${text}[screenshot]\n</observation>`,
          contentParts: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: dataUrl(frame), detail: 'auto' } },
            { type: 'text', text: '\n</observation>' },
          ],
        });
        trimMotorImages(episode.messages);
        if (episode.messages.length > MAX_MESSAGES) throw new Error(`motor episode exceeded ${MAX_MESSAGES} messages`);

        const started = episodeNow(episode);
        const completion = await complete(episode);
        if ((episode.status as EpisodeStatus) === 'interrupted') break;
        const { call, args } = parseMotorToolCall(completion.toolCalls);
        const outcome = await execute(episode, call.function.name, args, dimensions);
        episode.messages.push({ role: 'assistant', content: completion.content ?? '', tool_calls: [call] });
        episode.messages.push({ role: 'tool', content: outcome.receipt, tool_call_id: call.id });
        episode.turns++;
        episode.checkpointSeq++;
        episode.updatedAt = episodeNow(episode);
        const recent = {
          tool: call.function.name,
          arguments: call.function.arguments.slice(0, 1_000),
          receipt: outcome.receipt.slice(0, 1_000),
          reasoning: (completion.reasoningContent ?? '').slice(0, 2_000),
          content: (completion.content ?? '').slice(0, 500),
          latencyMs: Math.max(0, episode.updatedAt - started),
          at: new Date(episode.updatedAt).toISOString(),
        };
        episode.recent = [...episode.recent, recent].slice(-4);
        append(episode.traceFile, {
          type: 'turn', at: recent.at, episodeId: episode.episodeId, turn: episode.turns - 1,
          checkpointSeq: episode.checkpointSeq, frame, dimensions, call, receipt: outcome.receipt,
          reasoning: completion.reasoningContent ?? null, content: completion.content ?? '', usage: completion.usage,
          latencyMs: Math.max(0, episode.updatedAt - started), model: completion.model,
          providerType: completion.providerType, apiSurface: completion.apiSurface, apiEndpoint: completion.apiEndpoint,
        });
        if (outcome.terminal) {
          episode.status = outcome.terminal;
          append(episode.traceFile, { type: outcome.terminal, at: recent.at, checkpointSeq: episode.checkpointSeq, receipt: outcome.receipt });
          notify(episode);
          break;
        }
        if (episode.turns - episode.lastNotifiedTurn >= episode.opts.softTurnBudget) {
          episode.lastNotifiedTurn = episode.turns;
          notify(episode);
        }
        if (episode.opts.settleMs > 0) await episodeSleep(episode, episode.opts.settleMs);
      }
    } catch (error) {
      if (episode.status !== 'interrupted') {
        episode.status = 'failed';
        episode.lastError = error instanceof Error ? error.message : String(error);
        episode.updatedAt = episodeNow(episode);
        append(episode.traceFile, { type: 'failed', at: new Date(episode.updatedAt).toISOString(), checkpointSeq: episode.checkpointSeq, error: episode.lastError });
        notify(episode);
      }
    } finally {
      episode.loopRunning = false;
      episode.abortController = null;
    }
  };

  const resume = (episode: EpisodeRecord, checkpointSeq: number, guidance: string | null) => {
    if (checkpointSeq !== episode.checkpointSeq) throw new Error(`elpis.motor: stale checkpoint ${checkpointSeq}; current is ${episode.checkpointSeq}`);
    if (TERMINAL_STATUSES.has(episode.status)) throw new Error(`elpis.motor: episode is terminal (${episode.status})`);
    if (guidance !== null) episode.pendingGuidance = boundedText(guidance, 'motor guidance', MAX_GUIDANCE_CHARS);
    episode.lastAcknowledgedTurn = episode.turns;
    episode.lastNotifiedTurn = episode.turns;
    episode.status = 'running';
    episode.updatedAt = episodeNow(episode);
    append(episode.traceFile, { type: guidance === null ? 'continue' : 'guidance', at: new Date(episode.updatedAt).toISOString(), checkpointSeq, ...(guidance !== null ? { guidance: episode.pendingGuidance } : {}) });
    queueMicrotask(() => void runEpisode(episode));
    return snapshot(episode);
  };

  const api: Record<string, unknown> = {
    start: (goalValue: string, opts: MotorStartOptions = {}) => {
      const goal = boundedText(goalValue, 'elpis.motor goal', MAX_GOAL_CHARS).trim();
      const active = [...episodes.values()].find((episode) => episode.status === 'running' || episode.status === 'awaiting_oversight' || episode.status === 'needs_guidance');
      if (active) throw new Error(`elpis.motor: episode ${active.episodeId} is already active (${active.status})`);
      if (episodes.size >= MAX_EPISODES) {
        const removable = [...episodes.values()].filter((episode) => TERMINAL_STATUSES.has(episode.status)).sort((a, b) => a.updatedAt - b.updatedAt);
        for (const episode of removable.slice(0, episodes.size - MAX_EPISODES + 1)) episodes.delete(episode.episodeId);
      }
      const episodeId = safeId(opts.episodeId ?? `motor-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
      if (episodes.has(episodeId) || fs.existsSync(path.join(episodesDir, `${episodeId}.jsonl`))) throw new Error(`elpis.motor: episode already exists: ${episodeId}`);
      const startedAt = now();
      const softTurnBudget = finiteInt(opts.softTurnBudget ?? 8, 'motor softTurnBudget', 1, 100);
      const hardTurnBudget = finiteInt(opts.hardTurnBudget ?? 12, 'motor hardTurnBudget', 2, 200);
      if (hardTurnBudget <= softTurnBudget) throw new Error('motor hardTurnBudget must exceed softTurnBudget');
      const record: EpisodeRecord = {
        episodeId, goal, status: 'running', startedAt, updatedAt: startedAt, turns: 0, checkpointSeq: 0,
        lastAcknowledgedTurn: 0, lastNotifiedTurn: 0, frame: null,
        traceFile: path.join(episodesDir, `${episodeId}.jsonl`),
        messages: [{ role: 'system', content: `${MOTOR_SYSTEM_PROMPT}\n\nScoped goal: ${goal}` }],
        authority: authority(opts.authority), counters: { pointerActions: 0, writes: 0, textChars: 0, keyPresses: 0, scrolls: 0 },
        opts: {
          dryRun: opts.dryRun === true,
          maxTurns: finiteInt(opts.maxTurns ?? 40, 'motor maxTurns', 1, 200),
          softTurnBudget, hardTurnBudget,
          maxWallMs: finiteInt(opts.maxWallMs ?? 300_000, 'motor maxWallMs', 1_000, 3_600_000),
          settleMs: finiteInt(opts.settleMs ?? 250, 'motor settleMs', 0, 5_000),
          completionTimeoutMs: finiteInt(opts.completionTimeoutMs ?? 30_000, 'motor completionTimeoutMs', 100, 300_000),
        },
        pendingGuidance: null, recent: [], abortController: null, loopRunning: false, lastError: null,
        runtime: deps,
      };
      episodes.set(episodeId, record);
      append(record.traceFile, { type: 'start', at: new Date(startedAt).toISOString(), episodeId, goal, authority: record.authority, options: record.opts });
      queueMicrotask(() => void runEpisode(record));
      return snapshot(record);
    },
    status: (episodeId?: string) => episodeId ? snapshot(getEpisode(episodeId)) : [...episodes.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(snapshot),
    guide: (episodeId: string, checkpointSeq: number, guidance: string) => resume(getEpisode(episodeId), finiteInt(checkpointSeq, 'motor checkpointSeq', 0, Number.MAX_SAFE_INTEGER), guidance),
    continue: (episodeId: string, checkpointSeq: number) => resume(getEpisode(episodeId), finiteInt(checkpointSeq, 'motor checkpointSeq', 0, Number.MAX_SAFE_INTEGER), null),
    interrupt: (episodeId: string, checkpointSeq?: number) => {
      const episode = getEpisode(episodeId);
      if (checkpointSeq !== undefined && finiteInt(checkpointSeq, 'motor checkpointSeq', 0, Number.MAX_SAFE_INTEGER) !== episode.checkpointSeq) throw new Error(`elpis.motor: stale checkpoint ${checkpointSeq}; current is ${episode.checkpointSeq}`);
      if (TERMINAL_STATUSES.has(episode.status)) return snapshot(episode);
      episode.status = 'interrupted';
      episode.updatedAt = episodeNow(episode);
      episode.abortController?.abort();
      append(episode.traceFile, { type: 'interrupted', at: new Date(episode.updatedAt).toISOString(), checkpointSeq: episode.checkpointSeq });
      return snapshot(episode);
    },
  };

  return { api, updateDeps(value) { deps = value; } };
}

export function createMotorController(deps: MotorControllerDeps): Record<string, unknown> {
  const key = path.resolve(deps.dataDirectory);
  const existing = RESIDENTS.get(key);
  if (existing) {
    existing.updateDeps(deps);
    return existing.api;
  }
  const resident = buildResident(deps);
  RESIDENTS.set(key, resident);
  return resident.api;
}
