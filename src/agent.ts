// agent.ts — orchestration: the one history, system prompt, tool dispatch, loop.
//
// CONVERSATION MODEL: monocontext. The agent is one mind with ONE
// conversation history interleaving every Discord channel. Channel provenance
// lives in each inbound envelope header (`<incoming-message channel="..." author="..."`) and a per-
// message `channel` stamp in the transcript. One tracker, one compactor, one
// epoch, one hasNewInput. Compaction is the single forgetting mechanism.
//
// THE MAIN LOOP (no iteration cap): drains the global FIFO inbound queue into the
// one history, runs the turn until the model ends it — a SUCCESSFUL run carrying
// `end: true` is the only sanctioned ending (spec ) — then parks on the
// wake-gate. A response with no tool_calls is NOT an ending: it gets the
// END_TURN_NUDGE and the loop goes round again, without bound (a fallback would
// demonstrate to the model that `end` is optional). A nudge spin is broken by
// `agent.stop` (an explicit check on the nudge and tool-chain `continue`s,
// which keep hasNewInput set and so never reach the wake-gate's own check) or by
// a context clear, whose epoch bump unwinds the turn via `continue turn`.
// Error/leak exits bypass the nudge entirely via finishTurn.
//
// TRANSCRIPT PERSISTENCE: every pushed message is appended to the single
// `main-*.jsonl` stream (sessions.ts) — no exception (heartbeat traffic
// included). Rotation happens only on context clear or compaction boundary. On
// boot the most-recent stream is loaded and primed into `messages`.
//
// SOUL/MEMORY INJECTION: SOUL.md is re-read every turn (hot-reload). MEMORY.md is
// cached in `memoryView` and refreshed only on context clear / compaction.

import type { Sandbox } from './sandbox/index.js';
import type { Memory } from './store/memory.js';
import { preview, cap, previewValue } from './sandbox/preview.js';
import type { LLM, ChatMessage, LLMUsage } from './llm/llm.js';
import type OpenAI from 'openai';
import { RetriableError, prepareForApi, toApiMessage, activeModelTools, externalThinkingJuice } from './llm/llm.js';
import { createCacheStats, type CacheStats } from './llm/cache-stats.js';
import { redactSecrets, collectSecretValues } from './lib/secrets.js';
import { findRepetition, BLIND_SPOTS } from './lib/similarity.js';
import type { ContextTracker } from './llm/context-tracker.js';
import type { Compactor } from './llm/compactor.js';
import type { DensityModel } from './llm/density.js';
import type { TranscriptStore } from './store/sessions.js';
import { MAIN_TRANSCRIPT_ID } from './store/sessions.js';
import type { MindItem, MindService } from './store/mind.js';
import { build as buildPrompt, loadPeopleFiles } from './llm/prompt.js';
import type { PersonFile } from './llm/prompt.js';
import {
  heartbeatReflectionPrompt, heartbeatPonderPrompt, heartbeatTickPrompt, heartbeatSocialNudgePrompt,
  GHOST_REPLY_NUDGE, END_TURN_NUDGE, endNudgeAlert, toolChainSpinAlert, compactionFailureAlert, COMPACTION_FLUSH_NUDGE, compactionEscalationNudge,
} from './llm/prompt.js';
import type { Config } from './config.js';
import type { BuiltinModuleRegistry, RuntimeProfile } from './builtin-modules.js';
import { CONSOLE_CHANNEL_ID, INTERNAL_CHANNEL_ID } from './types.js';
import { localHm, localStamp } from './lib/time.js';
import { parseSoul, DEFAULT_AGENT_NAME } from './store/soul.js';
import type { ChannelDirectory } from './store/channels.js';
import type { MuteStore } from './store/mutes.js';
import type { RunResult } from './types.js';
import type { ConsoleHub, RoomFact, UsageInfo, ContextSnapshot } from './console/hub.js';
import { buildGuildIndex, countsForTick, type GuildIndex } from './discord/wake.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatInboundEnvelope, parseEnvelope, type InboundMessageAttachment } from './lib/envelope.js';
import { spawnText } from './lib/proc.js';
import { sniffImageMediaType } from './lib/image.js';

// The inbound-envelope format lives in lib/envelope.ts (build + parse in one
// place); re-exported here so existing importers (tests, discord.ts's attachment
// type) keep resolving these off agent.js.
export { formatInboundEnvelope, formatAttachmentParts, extractUtterance } from './lib/envelope.js';
export type { InboundMessageAttachment } from './lib/envelope.js';

export { INTERNAL_CHANNEL_ID } from './types.js';

/**
 * Render a RunResult as PLAIN TEXT for the tool message the model reads.
 *
 * This used to be `JSON.stringify(result)`, which JSON-escaped every string in
 * the result — and preview used to escape strings once already, so file
 * content arrived double-escaped. Plain text with real newlines is both honest
 * about the bytes and cheaper in tokens.
 */
export function formatRunResult(r: RunResult): string {
  const parts: string[] = [];
  if (r.ok) {
    let head = 'ok';
    if (r.detached) head += ` — detached as bg ${r.bgId ?? '?'}`;
    if (r.savedAs) head += ` — value saved to ${r.savedAs}`;
    parts.push(`[run ${head}]`);
    if (r.preview) parts.push(r.preview);
  } else {
    parts.push('[run FAILED]');
    if (r.error) parts.push(r.error);
  }
  if (r.logs) parts.push(`--- console ---\n${r.logs}`);
  return parts.join('\n');
}

function mindFrontierLine(item: MindItem): string {
  const blocked = item.effectiveStatus === 'blocked'
    ? `blocked by ${item.blockedBy.map((x) => `#${x.id}`).join(',')}`
    : item.effectiveStatus.replace('_', ' ');
  const due = item.dueAt == null ? '' : ` · due ${new Date(item.dueAt).toISOString()}`;
  return `#${item.id} [${blocked}] [p${item.priority}] ${item.title}${due} · by ${item.createdBy}`;
}

/** Compact live external-cortex card. Bodies and comments stay behind get(id):
 * this is a frontier, not a second copy of the database. Ideas/questions are
 * printed separately because lacks the future commitment axis — recorded
 * must not silently mean promised. */
export function formatMindFrontier(mind: Pick<MindService, 'list' | 'stats'>): string | null {
  const stats = mind.stats();
  if (stats.active === 0) return null;

  const inProgress = mind.list({ statuses: ['in_progress'], kinds: ['task', 'project'], limit: 4 });
  const ready = mind.list({ ready: true, kinds: ['task', 'project'], limit: 4 });
  const blocked = mind.list({ blocked: true, kinds: ['task', 'project'], limit: 4 });
  const waiting = mind.list({ statuses: ['waiting'], kinds: ['task', 'project'], limit: 4 });
  const thoughts = mind.list({ statuses: ['inbox', 'open', 'in_progress', 'waiting'], kinds: ['idea', 'question'], limit: 4 });
  const lines = [
    '<mind-frontier>',
    'Live external-cortex context, not a new request. It is omitted from the transcript.',
    `counts: ready_commitments=${ready.length} in_progress_commitments=${inProgress.length} blocked_commitments=${blocked.length} waiting_commitments=${waiting.length} held_thoughts=${thoughts.length} database_active=${stats.active} overdue=${stats.overdue}`,
  ];
  const add = (label: string, items: MindItem[]) => {
    if (items.length === 0) return;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`- ${mindFrontierLine(item)}`);
  };
  add('in progress', inProgress);
  add('ready commitments', ready);
  add('blocked commitments', blocked);
  add('waiting commitments', waiting);
  add('held thoughts — recorded, not promised; do not auto-act', thoughts);
  lines.push('Open an item with elpis.mind.get(id) before acting. Do not bypass blockers; keep status and comments honest.', '</mind-frontier>');
  return lines.join('\n');
}

/** Mind currently has no per-item guild scope. Until it does, its live frontier
 * is home/private context: internal wakes may see it, and Discord turns may see
 * it only in the configured home guild. */
export function allowsMindFrontier(
  turnChannelId: string | null,
  channels: Pick<ChannelDirectory, 'guildOf'> | undefined,
  guilds: { id: string; slug: string }[],
): boolean {
  if (turnChannelId == null) return true;
  const home = guilds.find((guild) => guild.slug === 'home');
  return home != null && channels?.guildOf(turnChannelId) === home.id;
}

export function retainMindFrontierPermission(
  currentlyAllowed: boolean,
  channelId: string,
  isInternal: boolean,
  channels: Pick<ChannelDirectory, 'guildOf'> | undefined,
  guilds: { id: string; slug: string }[],
): boolean {
  return currentlyAllowed && (isInternal || allowsMindFrontier(channelId, channels, guilds));
}

/** Detect a harness restart command in an interrupted tool call's code. */
function looksLikeHarnessRestart(code: string): boolean {
  return /systemctl[\s\S]{0,96}\b(?:restart|start)\b[\s\S]{0,96}\belpis-harness(?:\.service)?\b/i.test(code);
}

/** Summarize executed JS for logging: show first `maxLines` lines, capped by bytes. */
function summarizeCode(code: string, maxLines = 20, maxBytes = 1500): string {
  const lines = code.split('\n');
  const head = lines.slice(0, maxLines).join('\n');
  const suffix = lines.length > maxLines ? `\n… [+${lines.length - maxLines} more lines]` : '';
  const out = head + suffix;
  return Buffer.byteLength(out, 'utf8') > maxBytes ? cap(out, maxBytes) : out;
}

/** One open ponder/ thread's cheap metadata: scanned once per beat and
 * reused for the digest line, beat-kind selection, and stalest-body lookup. */
interface PonderThread { name: string; file: string; firstLine: string; mtimeMs: number; }

/** True when assistant content is a real reply-shaped text rather than a stray
 * tokenizer/tool-call artifact. Substance = ≥2 consecutive word chars after
 * stripping XML-ish tags and special-token wrappers. */
export function hasReplySubstance(reply: string): boolean {
  const stripped = reply
    .replace(/<\|[^|>]*\|>/g, '')
    .replace(/<\/?[\w:|-]+\/?>/g, '');
  return /\w{2,}/.test(stripped);
}

/** D1: a real (non-internal, non-ambient) wake landing in a self-muted channel
 * can be heard but not answered here (Agent.send will block the reply) — flag
 * it inline so the model doesn't draft a reply it can't deliver. `deafen` never
 * reaches this point (classifyInbound already dropped it before ingest). */
export function muteAnnotation(content: string, muteType: 'mute' | 'deafen' | null, isRealWake: boolean): string {
  return (isRealWake && muteType === 'mute')
    ? `${content}\n[#this channel is muted — a reply here will not send; release is operator-only]`
    : content;
}

/** Human-ish duration formatter. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(2)}s`;
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Image MIME types the vision API can consume. */
const VISION_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
const VISION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Consecutive end-turn nudges before the operator is told. Alert-only — it does
 * NOT cap the nudging (spec: no fallback, no force-end). Shared by
 * BOTH unbounded loop shapes: the no-run-call end-nudge AND the tool-chain
 * spin (a run that never lands a successful `end: true`) — one threshold,
 * not two (final-review fix wave, ). */
export const END_NUDGE_ALERT_AT = 5;

/** Re-alert cadence past the first crossing. A spin lasting hours must keep
 * signalling, not send exactly one Discord message and go quiet — so once
 * `END_NUDGE_ALERT_AT` fires, re-alert every this-many further cycles. */
export const END_NUDGE_REALERT_EVERY = 25;

/** Whether a consecutive spin counter should fire an operator alert at this
 * count: once on crossing `END_NUDGE_ALERT_AT` (`===`, not on every cycle
 * past it), then every `END_NUDGE_REALERT_EVERY` cycles after. Shared by
 * both spin shapes so they alert on the same cadence. */
export function shouldAlertOnSpin(count: number): boolean {
  return count >= END_NUDGE_ALERT_AT && (count - END_NUDGE_ALERT_AT) % END_NUDGE_REALERT_EVERY === 0;
}

/** Compaction failed-cycle alert cadence. A cycle that burns all its summarize attempts (API failures or
 * quality-gate rejections) must stay loud without restarting the same fold on
 * every immediately-following turn. Distinct constants from the loop-spin
 * pair above because one failed cycle already costs ~3 fold-sized calls. */
export const COMPACTION_FAIL_ALERT_AT = 1;
export const COMPACTION_FAIL_REALERT_EVERY = 5;
export function shouldAlertOnCompactionFailure(count: number): boolean {
  return count >= COMPACTION_FAIL_ALERT_AT && (count - COMPACTION_FAIL_ALERT_AT) % COMPACTION_FAIL_REALERT_EVERY === 0;
}

/** Time latch between failed summarize cycles. Three attempts still happen
 * inside one cycle, but persistent provider/request failures retry at most on
 * this bounded exponential cadence instead of once per user turn. Manual
 * `/compact` remains an explicit operator override. */
export const COMPACTION_RETRY_BASE_MS = 60_000;
export const COMPACTION_RETRY_MAX_MS = 15 * 60_000;
export function compactionRetryBackoffMs(failedCycles: number): number {
  const exponent = Math.max(0, Math.floor(failedCycles) - 1);
  return Math.min(COMPACTION_RETRY_BASE_MS * (2 ** exponent), COMPACTION_RETRY_MAX_MS);
}

/** Join room labels for the ambient-tick notice: 'a', 'a and b', 'a, b, and c'
 * — a plain ' and ' chain reads fine at two rooms but degrades ("across #a
 * and #b and #c") past that. */
function joinRoomLabels(labels: string[]): string {
  if (labels.length <= 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** Transcript view of a message: `contentParts` (base64 image payloads) are
 * stripped before persisting — the boot-time whitelist parser
 * (sessions.ts parseChatMessage) never restores them, so writing them is
 * pure dead weight that bloats every line and every compaction re-persist.
 * Same reasoning as the ephemeral text-only persist in pushMessage, applied
 * to every push now that emote/sticker images make image parts routine
 * rather than a rare upload. In-memory history keeps the parts untouched. */
function persistable(msg: ChatMessage): ChatMessage {
  if (!msg.contentParts) return msg;
  const { contentParts: _omit, ...rest } = msg;
  return rest;
}

async function buildImageContentParts(attachments: InboundMessageAttachment[]): Promise<OpenAI.ChatCompletionContentPart[]> {
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  for (const a of attachments) {
    if (!a.contentType || !VISION_IMAGE_TYPES.has(a.contentType) || !a.localPath) continue;
    const stats = await fs.promises.stat(a.localPath);
    if (stats.size > VISION_IMAGE_MAX_BYTES) continue;
    const buf = await fs.promises.readFile(a.localPath);
    const mediaType = sniffImageMediaType(buf) ?? a.contentType;
    parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${buf.toString('base64')}` } });
  }
  return parts;
}

export interface InboundMessage {
  id: string;
  channelId: string;
  channelName: string;
  author: string;
  authorId: string;
  content: string;
  createdAt: string;
  replyTo: { id: string; author: string; authorId: string; content: string } | null;
  forwarded: { author: string; channelName: string | null; content: string } | null;
  mentions: string[];
  attachments: InboundMessageAttachment[];
  /** The Discord guild this message came from, when known. Optional/absent
 * today (single-server harness); Discord fills it in once multi-guild
 * wiring lands. Passed through to the channel directory so `set` can
 * record/heal the channel's guild. */
  guildId?: string | null;
  /** The Discord guild's slug, when known. Threaded through to the envelope's
 * `guild=` attribute (omitted when absent) so the agent can tell one
 * server's rooms from another's in the one interleaved history. */
  guildSlug?: string | null;
  /** Whether the author is another bot, when known. Threaded through to the
 * envelope's `bot=` attribute (omitted when absent). */
  bot?: boolean;
  /** 'wake' starts a turn now; 'ambient' enters history and rides the
 * periodic tick without costing a turn. Absent ⇒ 'wake' — every
 * internal/harness/legacy enqueue (heartbeats, fleet notices, bg-settle,
 * slash-command-triggered sends, …) keeps waking immediately as before;
 * only Discord's MessageCreate handler sets this explicitly, from
 * wake.ts's classifyInbound. */
  wakeClass?: 'wake' | 'ambient';
  /** The channel id used for per-channel POLICY lookups — a thread's PARENT
 * id (mirroring `resolvePolicyChannelId` in discord.ts), or `channelId`
 * itself when not a thread. Only consulted for ambient traffic
 * (`fireAmbientTick`'s `countsForTick` check): the guild index is keyed
 * only on configured, non-thread channels, so without this a thread's
 * ambient chat would never be found there and the tick would never fire
 * for it, even though its parent is a live social-tier room. Absent ⇒
 * falls back to `channelId` (internal/harness enqueues, and non-thread
 * Discord messages, where the two already coincide). */
  policyChannelId?: string;
  /** Fired when the message is actually pushed into history (drain time), not
 * at enqueue — a message dropped before the drain (clear, crash, second
 * restart) never fires it. Used by the changelog notice to mark entries
 * seen only on real delivery. Guarded: a throwing callback never breaks
 * the drain. */
  onDelivered?: () => void;
  /** Provenance discriminator the drain loop routes on (instead of sniffing
 * `channelName`/`author` magic strings). Absent ⇒ 'discord' — every real
 * Discord message, plus the fleet/scheduler notices, which have always been
 * drained through the real-user branch (their author is 'fleet'/'scheduler',
 * never 'harness'). Scheduler/fleet stay on that legacy branch but are marked
 * synthetic for external-think policy. 'heartbeat'/'harness'/'watch' are the
 * internally-produced notices routed through the internal-turn branch; 'watch'
 * additionally marks the frame ephemeral. channelName/author are pure display once this is set. */
  kind?: 'discord' | 'scheduler' | 'fleet' | 'heartbeat' | 'harness' | 'watch';
}

export interface AgentDeps {
  config: Config;
  sandbox: Sandbox;
  memory: Memory;
  /** Dependency-aware external cortex. Optional so focused Agent tests and
 * embedders can omit it; production always wires the canonical service. */
  mind?: MindService;
  /** Boot-frozen deterministic prompt blocks from data-directory extensions. */
  extensionPrompt?: string;
  /** Boot-resolved built-in modules; also used by the sandbox. */
  modules?: BuiltinModuleRegistry;
  /** Boot-frozen host/container authority profile. */
  profile?: RuntimeProfile;
  llm: LLM;
  tracker: ContextTracker;
  compactor: Compactor;
  /** Optional calibrated chars-per-token model. Agent guards every use with
 * `?.` (falls back to ratio 4 / no observation) so tests and any direct
 * `new Agent(...)` need not supply it. */
  density?: DensityModel;
  /** Persistent transcript store (single 'main' stream). */
  transcript: TranscriptStore;
  /** Messages to prime the one history with on boot (restart recovery). Empty /
 * omitted for a fresh start. */
  initialMessages?: ChatMessage[];
  /** Send a reply to a Discord channel (chunked by the caller). */
  send: (channelId: string, text: string, opts?: { files?: import('./types.js').OutboundAttachment[] }) => Promise<void>;
  /** Called when the agent is about to make an LLM call (typing indicator). */
  onThinking?: (channelId: string) => void;
  /** Called when the loop reaches the wake-gate (turn ended via `end: true`, empty queue). */
  onIdle?: () => void;
  /** Callback to publish the currently processed inbound message to the sandbox. */
  setCurrentInbound?: (msg: InboundMessage | null) => void;
  /** Persistent id→name channel directory. Backs channel('name')
 * resolution and known-channel listing under (no live contexts). */
  channels?: ChannelDirectory;
  /** Read-only operator console hub (Elpis Console). When present the agent
 * pushes observer events (message appended, compaction, stream channel) to it.
 * Purely a tap — never influences loop behavior. */
  console?: ConsoleHub;
  /** The killswitch's persistent mute/deafen state. Backs
 * moderateChannel and the send guard. Absent = the feature is not wired
 * (moderateChannel reports a not-wired failure; send never throws). */
  mutes?: MuteStore;
  /** Custom emote/sticker registry (src/discord/emotes.ts). The agent only
 * ever calls resetSeen — at clearContext and compaction-apply, the two
 * boundaries past which a previously attached emote image is no longer in
 * the model's view. Structural (not the full EmoteRegistry) so agent.ts
 * needs no import from the Discord layer. */
  emotes?: { resetSeen(): void };
}

/** effectiveTrigger = min(configured trigger, usable window − reserve margin).
 * A smaller-window deployment must trigger compaction BEFORE the API 400s on
 * context-length, else start never fires (review S3). */
export function computeEffectiveTrigger(config: Config, tracker: ContextTracker): number {
  return Math.max(1, Math.min(config.compaction.triggerTokens, tracker.usableBudget - config.llm.completionReserveTokens));
}

export class Agent {
  /** The one conversation history. */
  private messages: ChatMessage[] = [];
  /** True when there's input the model hasn't responded to. */
  private hasNewInput = false;
  /** Monotonic epoch — bumped by clearContext() so in-flight work is discarded. */
  private epoch = 0;
  /** Global FIFO inbound queue. */
  private inbound: InboundMessage[] = [];
  private resolveWake: (() => void) | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private rescheduleBeat: ((delay: number) => void) | null = null;
  private lastBeatKind: 'reflection' | 'ponder' | 'tick' | null = null;
  private stopped = false;
 // --- Boundary views ---------------------------------------------------
 // Snapshots of the agent-writable files injected into the system prompt.
 // Refreshed ONLY at a context boundary (boot / clear / compaction) via
 // refreshBoundaryViews. They are NOT hot-reloaded per turn, because
 // `messages[0]` is the provider's cached prefix: a mid-conversation write
 // (elpis.memory.person / elpis.state / elpis.focus) that moved one of these
 // rewrote the entire cached context. SOUL.md is the deliberate exception —
 // still read fresh each turn (readFileOr in the turn loop).
  private memoryView = '';
  private peopleView: PersonFile[] = [];
  private nowView = '';
  private busy = false;
  private consecutiveIdleTicks = 0;
  private consecutive400 = 0;
  /** When the agent last sent anything to each guild (slug → epoch ms). Every
 * configured guild is seeded to boot time in the constructor so a restart
 * never triggers an immediate social nudge for any of them — a single
 * global clock let chatting in one server mask weeks of silence in
 * another. */
  private lastSendAt = new Map<string, number>();
  /** Bounded history of what I actually said, newest last. Feeds the heartbeat
 * repetition check: a loop is invisible from inside the turn that writes it,
 * so the only way to see one is to count across turns. */
  private recentSends: string[] = [];

  /** When the social-send nudge last fired, per guild (re-arm gate — prompt,
 * don't nag). Absent = never fired for that guild. */
  private lastSocialNudgeAt = new Map<string, number>();
  /** Provider-outage recovery: ten retries, exponential growth capped at five minutes. */
  llmRetryDelays: number[] = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000];

 // Turn-scoped flags (singleton under ).
  private sendsThisTurn = 0;
  private nudgeFired = false;
  private realUserTurn = false;
  /** Monotonic turn latch: true only when freshly drained input came from a
 * person-facing ingress (Discord or console), including ambient room chat.
 * Scheduler/fleet/heartbeat/harness wakes never set it. */
  private personInputTurn = false;
  /** Monotonic privacy latch for the current turn. Any social/unknown real input
 * closes the home-private live Mind frontier until finishTurn. */
  private mindFrontierAllowedThisTurn = true;
  /** The frontier is an orientation card, not a standing recency attractor. It
 * serves at most the first actual LLM request of an outer turn; retries reuse
 * that frozen request and tool continuations omit the card. */
  private mindFrontierDeliveredThisTurn = false;
  /** Number of newly-drained inbound messages that must stay AFTER the frontier
 * on the first request, so current conversation outranks ambient work state. */
  private mindFrontierTailMessagesThisTurn = 0;
  /** External thinking is forced at most once, and only on a person-shaped outer turn. */
  private externalThinkForcedThisTurn = false;
  /** Count of no-run-call responses nudged since the last successful `end: true`
 * (finishTurn/clearContext reset it) — NOT a strict per-iteration
 * streak: a tool-chain continue or a one-shot ghost-reply bounce can land
 * between two increments without resetting it, since neither is a
 * successful end either. Drives the operator alert only — it never caps
 * the nudging (spec ). */
  private endNudgeCount = 0;
  /** Count of tool-dispatch responses (a run WAS called) that did not land a
 * successful `end: true`, since the last successful end — the sibling
 * counter to `endNudgeCount` for the OTHER unbounded loop shape (final-
 * review fix wave, ). Same non-strict-streak caveat as above:
 * not reset by an interleaved no-run-call nudge or ghost bounce. Reset in
 * finishTurn/clearContext. Alert-only, never caps the chain. */
  private toolChainContinueCount = 0;
  private lastInbound: InboundMessage | null = null;
  /** Provenance stamp for messages pushed during the current turn. */
  private turnChannel: string = INTERNAL_CHANNEL_ID;
  /** The channel of the message that woke the current turn — typing only. */
  private turnChannelId: string | null = null;
  /** elpis.sleep/wait pause depth. A counter, not a boolean, so
 * concurrent sleeps (Promise.all) don't resume typing when the first one
 * lands — only when all of them have. Reset to 0 at turn start so a sleep
 * stranded from a previous turn (or from before a clear) can't suppress
 * the next turn's indicator. */
  private sleepDepth = 0;
  /** True while at least one ephemeral (watch-mode) message is live in history.
 * Guards the post-response strip scan so it only walks the whole history when
 * there is actually something to strip. Set when an ephemeral frame is
 * pushed; cleared by the strip scan and by clearContext (which wipes them). */
  private hasEphemeral = false;

 // Global heartbeat / reflection state.
  private participants = new Map<string, { author: string; lastSeenAt: number }>();
  private messagesSinceReflection = 0;
  private lastRealInboundAt = 0;
  private seenRealInbound = false;

 // Console usage split (last authoritative completion). Purely for display.
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;
  /** Session prompt-cache accounting (console rail + /cache). In-memory; reset
 * by clearContext alongside the context tracker. */
  private cacheStats: CacheStats = createCacheStats();
  /** One-shot log guards for recordCacheUsage (F-cache-2): fire at most once
 * per process, not per clearContext — these describe endpoint capability /
 * an operational anomaly, not session state. */
  private loggedNoCacheCapability = false;
  private loggedCacheReportingWentDark = false;

 // Compaction state.
  private effectiveTrigger: number;
  private compactRequested = false;
  private compactingSince: number | null = null;
  private escalationFired = false;
  private flushNudgeFired = false;
  /** True while a started summarize cycle is (believed) in flight — set when
 * start actually engages, cleared on apply or when the cycle is observed
 * to have ended without a result (the failed-cycle detection). */
  private compactionCycleInFlight = false;
  /** Cycles that ended without an accepted summary since the last apply/clear
 * — drives the operator failed-cycle alert . */
  private failedCompactionCycles = 0;
  /** Earliest wall-clock time an automatic retry may start after a failed
 * cycle. This latches across intervening turns; a manual /compact bypasses
 * it. The first failed cycle still alerts immediately. */
  private compactionRetryNotBefore = 0;

  /** slug/id lookup over `discord.guilds` — backs guild-qualified
 * channel ref resolution (`resolveChannelRef`, `qualifiedChannelLabel`). */
  private guildIndex: GuildIndex;

  /** Ambient messages appended to history that no LLM call has seen yet.
 * `channelId` is the message's own room (provenance, used for the
 * room-context notice's label); `policyChannelId` is the parent-resolved
 * id `fireAmbientTick` checks against `countsForTick` — the two differ
 * only for a thread. Cleared right before every LLM call:
 * everything in it is about to be seen. */
  private ambientUnseen: { channelId: string; policyChannelId: string; at: number }[] = [];
  /** The periodic ambient-tick timer (`discord.ambientTickMs`); null when
 * disabled or not yet started. */
  private ambientTimer: NodeJS.Timeout | null = null;

  /** Live secret values for tool-result redaction. Config is immutable after
 * boot, so collected once here — and used UNCONDITIONALLY (redaction is a
 * safety property of result formatting). */
  private readonly secretValues: string[];

  constructor(private deps: AgentDeps) {
    this.secretValues = collectSecretValues(deps.config);
    this.guildIndex = buildGuildIndex(deps.config.discord.guilds);
 // Seed every configured guild's clock to boot time (see lastSendAt's doc
 // comment) — a guild added later never gets a seeded entry, but a fresh
 // deploy is the only path that constructs an Agent, so this always covers
 // the full configured set at the moment silence starts being measured.
    for (const g of deps.config.discord.guilds) this.lastSendAt.set(g.slug, Date.now());
    this.refreshBoundaryViews();
    this.effectiveTrigger = computeEffectiveTrigger(deps.config, deps.tracker);
    if (this.effectiveTrigger < deps.config.compaction.triggerTokens) {
      this.logger.warn(`compaction trigger clamped to the real window: ${this.effectiveTrigger} tokens (configured ${deps.config.compaction.triggerTokens}, usable budget ${deps.tracker.usableBudget})`);
    }
 // Restart recovery: prime the one history from the most-recent transcript.
    if (deps.initialMessages && deps.initialMessages.length > 0) {
      this.messages = deps.initialMessages.slice();
      deps.tracker.recompute(this.messages);
 // A prior conversation existed, so heartbeats should fire after a restart
 // (deliberately, incl. after the agent's own deploy) instead of parking
 // until a human speaks — the "no real inbound seen yet" guard is satisfied.
      this.seenRealInbound = true;
      this.logger.info(`primed history with ${this.messages.length} messages from prior transcript`);
      this.recoverInterruptedToolCall();
    }
  }

  /** Replace the send handler (wired by the Discord layer on start). */
  setSend(send: AgentDeps['send']): void {
    this.deps.send = send;
  }

  /** Replace the typing-indicator callbacks (wired by the Discord layer on
 * start — same ordering reason as setSend: the Discord client doesn't
 * exist yet when the Agent/sandbox are constructed). */
  setTyping(onThinking: AgentDeps['onThinking'], onIdle: AgentDeps['onIdle']): void {
    this.deps.onThinking = onThinking;
    this.deps.onIdle = onIdle;
  }

  /** Explicitly show the typing indicator for a channel (elpis.channel(id).typing()) —
 * the same mechanism the loop's automatic "about to call the LLM" indicator uses. */
  typing(channelId: string): void {
    if (channelId === CONSOLE_CHANNEL_ID) return;
    this.deps.onThinking?.(channelId);
  }

  /** Send a message to a specific channel. Used by the sandbox's channel().send().
 * Keeps the sendsThisTurn accounting (ghost-nudge); the send is already visible
 * in-stream via the tool call + result, so it is NOT re-recorded as an
 * assistant message ( dropped the cross-channel duplication). */
  async send(channelId: string, content: string, opts?: { files?: import('./types.js').OutboundAttachment[] }): Promise<void> {
    if (channelId === CONSOLE_CHANNEL_ID) {
      if (opts?.files?.length) throw new Error('console attachments are not supported yet');
      this.sendsThisTurn++;
      this.recentSends.push(content);
      if (this.recentSends.length > 20) this.recentSends.shift();
      return;
    }
    if (!this.deps.send) {
      throw new Error('no send handler wired');
    }
 // Killswitch: a muted or deafened channel refuses every send,
 // regardless of caller (sandbox channel.send, heartbeat, anything that
 // routes through this method) — release is operator-only.
 //
 // A THREAD is checked against its recorded parent too. Threads inherit
 // their parent's policy on the way IN (discord.ts's resolvePolicyChannelId)
 // but carry their own Discord id, so they never get a killswitch row of
 // their own — checking the raw target alone let a mute on #general be
 // bypassed by replying in a thread under it, which is the natural reply
 // target for any threaded conversation. The parent comes from the channel
 // directory, stamped at enqueue; a thread the harness has never seen a
 // message from has no recorded parent and is only reachable by raw id.
    const parentId = this.deps.channels?.parentOf(channelId) ?? null;
    const targets = parentId && parentId !== channelId ? [channelId, parentId] : [channelId];
    for (const id of targets) {
      const muteRow = this.deps.mutes?.get(id);
      if (!muteRow) continue;
      const state = muteRow.type === 'deafen' ? 'deafened' : 'muted';
      const where = id === channelId
        ? `channel ${this.qualifiedChannelLabel(id)}`
        : `channel ${this.qualifiedChannelLabel(channelId)}'s parent ${this.qualifiedChannelLabel(id)}`;
      throw new Error(`${where} is ${state} (set by ${muteRow.setBy}${muteRow.reason ? `: "${muteRow.reason}"` : ''}) — release is operator-only`);
    }
    this.sendsThisTurn++;
    await this.deps.send(channelId, content, opts);
 // After the await: a failed delivery must not count as having spoken
 // (the social nudge reads this as "when did anything last reach a room").
 // A channel outside the configured allowlist (e.g. a legacy NULL-guild
 // directory row) resolves to no slug — nothing to stamp.
    const slug = this.slugForChannel(channelId);
    if (slug) this.lastSendAt.set(slug, Date.now());
    this.recentSends.push(content);
    if (this.recentSends.length > 20) this.recentSends.shift();
  }

  /** Effective delay for the next heartbeat, accounting for tick-beat backoff. */
  private effectiveBeatDelay(): number {
    const base = this.config.heartbeat.intervalMs;
    if (this.consecutiveIdleTicks === 0) return base;
    const doubled = base * Math.pow(2, this.consecutiveIdleTicks);
    return Math.min(doubled, this.config.heartbeat.maxIntervalMs);
  }

  /** Reschedule the in-flight beat's next tick, if any. */
  private reschedulePendingBeat(idle: boolean): void {
    if (!this.rescheduleBeat) return;
    if (idle) {
      this.consecutiveIdleTicks++;
    } else {
      this.consecutiveIdleTicks = 0;
    }
    const delay = this.effectiveBeatDelay();
    this.rescheduleBeat(delay);
    this.rescheduleBeat = null;
    this.lastBeatKind = null;
  }

  /** Build the status digest appended to every heartbeat content (D2). */
  private async buildHeartbeatDigest(threads: PonderThread[]): Promise<string> {
    const lines: string[] = [];
    const [tsOut, dirtyOut, hashOut] = await Promise.all([
      spawnText('systemctl', ['--user', 'show', 'elpis-harness', '-p', 'ActiveEnterTimestamp', '--value']),
      spawnText('git', ['-C', this.config.paths.harnessRoot, 'status', '--porcelain']),
      spawnText('git', ['-C', this.config.paths.harnessRoot, 'rev-parse', '--short', 'HEAD']),
    ]);
    const ts = tsOut.trim();
    if (ts) {
      const upMs = Date.now() - new Date(ts).getTime();
      if (upMs > 0) lines.push(`service up ${formatDuration(upMs)}`);
    }
    const hash = hashOut.trim();
    lines.push(hash ? `git: ${dirtyOut.trim().length === 0 ? 'clean' : 'dirty'} @ ${hash}` : 'git: ?');
    lines.push(`context: ${Math.round(this.tracker.currentTokens / 1000)}k tokens (compaction at ${Math.round(this.effectiveTrigger / 1000)}k)`);
    const sinceMsg = this.lastRealInboundAt > 0 ? formatDuration(Date.now() - this.lastRealInboundAt) : 'never';
    lines.push(`last human message: ${sinceMsg} ago`);
 // One pipe-segment, not a multi-line block: the whole digest is a flat
 // `lines.join(' | ')`, so a per-guild sub-list needs to render inline
 // (compact `slug Xh Ym (longest), slug Xh Ym` form) rather than newlines
 // + column padding that the join immediately collapses into one line.
    const quiet = this.silentGuilds();
    if (quiet.length > 0) {
      const rendered = quiet
        .map((q, i) => `${q.slug} ${formatDuration(q.ms)}${i === 0 && quiet.length > 1 ? ' (longest)' : ''}`)
        .join(', ');
      lines.push(`rooms you've been quiet in: ${rendered}`);
    }
    lines.push(`consecutive idle beats: ${this.consecutiveIdleTicks}`);
 // A dumb word-overlap count, not a judgement: repetition can be correct.
 // It exists because fluent restatement reads as presence from the inside —
 // in the incident twelve hours of near-identical sends went
 // unnoticed until the operator named them.
    const rep = findRepetition(this.recentSends);
    if (rep) {
      lines.push(
        `repetition: ${rep.count} of your last ${rep.examined} sends share ~${Math.round(rep.similarity * 100)}% of their vocabulary (word-overlap count, not a verdict — check whether you are restating rather than moving; ${BLIND_SPOTS})`,
      );
    }
    const ponderLine = this.formatPonderLine(threads);
    if (ponderLine) lines.push(`open threads: ${ponderLine}`);
    return `[status: ${lines.join(' | ')}]`;
  }

  /** Scan ponder/ once per beat. */
  private scanPonderThreads(): PonderThread[] {
    try {
      const ponderDir = path.join(this.config.paths.dataDirectory, 'ponder');
      const entries = fs.readdirSync(ponderDir).filter((f) => f.endsWith('.md') && f !== 'resolved');
      return entries.map((f) => {
        const file = path.join(ponderDir, f);
        const stat = fs.statSync(file);
        const firstLine = (fs.readFileSync(file, 'utf8').split('\n')[0] || '').slice(0, 80);
        return { name: f.replace(/\.md$/, ''), file, firstLine, mtimeMs: stat.mtimeMs };
      });
    } catch {
      return [];
    }
  }

  private formatPonderLine(threads: PonderThread[]): string {
    if (threads.length === 0) return '';
    const now = Date.now();
    return threads
      .map((t) => `${t.name} — "${t.firstLine}" (untouched ${formatDuration(now - t.mtimeMs)})`)
      .join(' · ');
  }

  private stalestThreadBody(threads: PonderThread[]): string {
    if (threads.length === 0) return '';
    let stalest = threads[0];
    for (const t of threads) if (t.mtimeMs < stalest.mtimeMs) stalest = t;
    try { return cap(fs.readFileSync(stalest.file, 'utf8'), 1500); } catch { return ''; }
  }

  startHeartbeat(): void {
    const intervalMs = this.config.heartbeat.intervalMs;
    if (intervalMs <= 0) {
      this.logger.info('heartbeat disabled');
      return;
    }
    clearTimeout(this.heartbeatTimeout ?? undefined);
    const scheduleNext = (delay: number) => {
      this.heartbeatTimeout = setTimeout(() => { void this.fireHeartbeat(scheduleNext); }, delay);
    };
    scheduleNext(intervalMs);
    this.logger.info('heartbeat started: interval', intervalMs, 'ms');
  }

  /** True when the queue holds anything that will wake the loop on its own.
 * The heartbeat's skip guard counts only these — NOT `inbound.length`.
 * Ambient messages sit in the queue indefinitely without waking anything
 * (that's the point of the wake gate), and a muted or quiet-tier channel
 * never fires the ambient tick either, so a chatty room in that state used
 * to park the beat forever: steady traffic kept the queue non-empty, every
 * heartbeat skipped, and the agent silently stopped reflecting, pondering,
 * nudging, and writing memory until the operator intervened. Counting only
 * wake-class pending restores the bound the design assumed — the backlog
 * drains at the next beat, so it accumulates for at most one interval. */
  private hasPendingWake(): boolean {
    return this.inbound.some((m) => m.wakeClass !== 'ambient');
  }

  /** Fire one heartbeat: enqueue the irreducible wake signal (or skip).
 *
 * Heartbeat policy lives in the standing system prompt. The event itself is
 * deliberately only `[heartbeat]`: no digest, selected mode, or social nudge
 * pre-authors what attention should reach for after waking.
 *
 *: all beats run in the ONE history with `channelId: INTERNAL_CHANNEL_ID`
 * purely as provenance (the envelope stays `#heartbeat`/`agent`). No ephemeral
 * context. Skip ladder is the global guards only: skip when busy or a
 * WAKING message is queued (`hasPendingWake` — ambient traffic alone never
 * blocks a beat), and (until any real inbound has been seen) skip entirely. */
  private async fireHeartbeat(reschedule: (delay: number) => void): Promise<void> {
    if (this.busy) { this.logger.info('heartbeat skipped: turn in progress'); reschedule(this.config.heartbeat.intervalMs); return; }
    if (this.hasPendingWake()) { this.logger.info('heartbeat skipped: waking messages are queued'); reschedule(this.config.heartbeat.intervalMs); return; }
    if (!this.seenRealInbound) { this.logger.info('heartbeat skipped: no real conversation seen yet'); reschedule(this.config.heartbeat.intervalMs); return; }

    this.lastBeatKind = 'tick';
    this.rescheduleBeat = reschedule;
    this.enqueueInternal('heartbeat', 'heartbeat', '[heartbeat]', {
      id: 'heartbeat-' + Date.now(), author: 'agent',
    });
    this.logger.info('heartbeat enqueued');
  }

  /** Stop the autonomous heartbeat scheduler. */
  stopHeartbeat(): void {
    clearTimeout(this.heartbeatTimeout ?? undefined);
    this.heartbeatTimeout = null;
    this.rescheduleBeat = null;
    this.logger.info('heartbeat stopped');
  }

  /** Break the main loop and release any parked wake-gate promise. */
  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.ambientTimer) { clearInterval(this.ambientTimer); this.ambientTimer = null; }
    this.wake();
  }

  /** Enqueue an inbound Discord message. Wakes the loop if idle — UNLESS this
 * is ambient traffic: ambient chat still enters the queue (and
 * will be drained into history at the next real wake) but must never itself
 * turn a parked loop on. The periodic tick (`fireAmbientTick`) is the only
 * thing that turns accumulated ambient chat into a turn. */
  enqueue(msg: InboundMessage): void {
 // Persist the real channel name. set ignores synthetic names.
 // `policyChannelId` differs from `channelId` only for a thread, so that
 // difference IS the thread→parent link — recorded here so send's
 // killswitch check can inherit the parent's mute row (a thread never has
 // one of its own).
    if (msg.channelId !== INTERNAL_CHANNEL_ID) {
      const parentId = msg.policyChannelId && msg.policyChannelId !== msg.channelId ? msg.policyChannelId : null;
      this.deps.channels?.set(msg.channelId, msg.channelName, msg.guildId ?? null, parentId);
    }
    this.inbound.push(msg);
 // Ambient traffic never turns a parked loop on.
    if (msg.wakeClass !== 'ambient') this.wake();
  }

  /** Resolve and clear the parked wake-gate promise, if any. Consume-once: the
 * reference is nulled before it is called so a re-entrant enqueue can't fire
 * the same resolver twice. A no-op when the loop isn't parked. */
  private wake(): void {
    const r = this.resolveWake;
    this.resolveWake = null;
    r?.();
  }

  /** Generate a synthetic inbound id with a per-site prefix. */
  private syntheticId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /** Build + enqueue an internally-produced notice (heartbeat / harness / watch
 * kinds) into the one history. Centralizes the synthetic-InboundMessage shape
 * the ~half-dozen internal producers all repeated; `kind` (not channelName/
 * author, which are display only) is what the drain loop routes on. The
 * fleet + scheduler notices deliberately do NOT go through here — they carry
 * their own author and have always drained through the real-user branch. */
  private enqueueInternal(
    kind: 'heartbeat' | 'harness' | 'watch',
    channelName: string,
    content: string,
    extras: {
      id: string;
      author?: string;
      authorId?: string;
      attachments?: InboundMessageAttachment[];
      onDelivered?: () => void;
    },
  ): void {
    const author = extras.author ?? 'harness';
    this.enqueue({
      id: extras.id,
      channelId: INTERNAL_CHANNEL_ID,
      channelName,
      author,
      authorId: extras.authorId ?? author,
      content,
      createdAt: new Date().toISOString(),
      replyTo: null, forwarded: null, mentions: [],
      attachments: extras.attachments ?? [],
      kind,
      onDelivered: extras.onDelivered,
    });
  }

  /** Watch mode (elpis.watch): deliver local image frames as one ephemeral
 * multimodal message (kind 'watch' → stripped after one generation, text-only
 * in the transcript). Builds the attachment shape here so index.ts just wires
 * the sandbox callback to it. */
  enqueueWatch(paths: string[], note: string): { ok: boolean; count: number } {
    const mime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    const attachments: InboundMessageAttachment[] = paths
      .map((p) => ({
        url: '',
        name: path.basename(p),
        contentType: mime[path.extname(p).toLowerCase()] ?? null,
        localPath: p,
        size: fs.statSync(p).size,
      }))
      .filter((a) => a.contentType);
    this.enqueueInternal('watch', 'watch', `[watch] ${note}`, {
      id: `watch-${Date.now()}`, author: 'harness', attachments,
    });
    return { ok: true, count: attachments.length };
  }

  /** Start the ambient tick (called from loop() entry; no-op when disabled or
 * already running). */
  private startAmbientTick(): void {
    const ms = this.config.discord.ambientTickMs;
    if (ms <= 0 || this.ambientTimer) return;
    this.ambientTimer = setInterval(() => {
      try { this.fireAmbientTick(); } catch (e) {
        this.logger.warn(`[agent] ambient tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, ms);
    this.ambientTimer.unref?.();
  }

  /** One tick: if unseen ambient chat has accumulated (and any of it counts —
 * non-quiet-tier, un-muted, outside quiet hours at THIS moment), enqueue one
 * harness room-context notice, which wakes the loop and drains everything
 * (the accumulated ambient messages, still queued or already in history,
 * plus this notice itself). A no-op while a turn is running — that turn's
 * own next LLM call will already see whatever ambient chat is in history.
 *
 * countsForTick is checked against `policyChannelId` (a thread's parent),
 * never the raw `channelId` — the guild index only knows configured,
 * non-thread channels, so checking the thread's own id would silently
 * never fire for thread chat. The notice's room labels still use the real
 * `channelId` so a thread reads as itself, not its parent. */
  fireAmbientTick(): void {
    if (this.busy) return;
    const queued = this.inbound
      .filter((m) => m.wakeClass === 'ambient')
      .map((m) => ({ channelId: m.channelId, policyChannelId: m.policyChannelId ?? m.channelId, at: Date.parse(m.createdAt) || Date.now() }));
    const pending = [...this.ambientUnseen, ...queued];
    if (pending.length === 0) return;
    const now = new Date();
    const muteType = (id: string) => this.deps.mutes?.get(id)?.type ?? null;
    if (!pending.some((p) => countsForTick(p.policyChannelId, this.guildIndex, muteType, now))) return;
    const earliest = Math.min(...pending.map((p) => p.at));
    const labels = joinRoomLabels([...new Set(pending.map((p) => this.qualifiedChannelLabel(p.channelId)))]);
    this.enqueueInternal(
      'harness', 'harness',
      `[room context — ${pending.length} message${pending.length === 1 ? '' : 's'} since ${localHm(earliest).replace(/^\[|\]$/g, '')}, across ${labels}. This is what's been said around you, not a set of requests. Replying is optional; silence is a fine answer.]`,
      { id: `ambient-${Date.now()}` },
    );
  }

  /** A5 settle delivery: when a detached future settles, enqueue a synthetic
 * [bg <id> settled] message into the one history so the agent gets a turn to
 * consume the result (: no origin routing — there is one history). */
  notifyFutureSettled(
    id: string, value: unknown, rejected: boolean,
    extra?: { logs?: string; label?: string; sends?: { channel: string; text: string }[] },
  ): void {
    const label = extra?.label ?? (rejected ? 'rejected' : 'settled');
    const previewStr = previewValue(value, 200);
    const logsSuffix = extra?.logs ? `\n--- logs (after detach) ---\n${extra.logs}` : '';
 // Post-detach sends can't attach to the already-pushed tool message, so
 // render them into the settle notice (review S2).
    const sendsSuffix = extra?.sends && extra.sends.length > 0
      ? '\n--- sent after detach ---\n' + extra.sends.map((s) => `→ #${s.channel}: ${JSON.stringify(s.text)}`).join('\n')
      : '';
    this.enqueueInternal('harness', 'harness', `[bg ${id} ${label}] ${previewStr}${logsSuffix}${sendsSuffix}`, {
      id: `bg-settle-${id}`,
    });
    this.logger.info(`[agent] bg future ${id} ${label} — delivered to the one history`);
  }

  /** Explicit detached-job lifecycle → one history. The registry guarantees the
 * heartbeat/terminal notices are durably de-duplicated and carries the room
 * where the work began as provenance, not as a routing fork. */
  notifyBackgroundJob(id: string, event: 'still running' | 'finished', details: string, originChannelId?: string): void {
    const origin = originChannelId ? ` · origin ${this.qualifiedChannelLabel(originChannelId)}` : '';
    this.enqueueInternal('harness', 'harness', `[bg job ${id} ${event}${origin}]\n${details}`, {
      id: `bg-job-${id}-${event.replace(/\s+/g, '-')}-${Date.now()}`,
    });
    this.logger.info(`[agent] bg job ${id} ${event} — delivered to the one history`);
  }

  /** The killswitch's single transition implementation — shared by
 * the slash commands, the console moderate op, and the sandbox self-mute.
 * Asymmetry: 'self' may only mute; release and deafen are operator-only. */
  moderateChannel(channelId: string, action: 'mute' | 'deafen' | 'unmute' | 'undeafen', actor: 'self' | 'operator', reason?: string): { ok: boolean; note: string } {
    const mutes = this.deps.mutes;
    if (!mutes) return { ok: false, note: 'mute store not wired' };
    const label = this.qualifiedChannelLabel(channelId);
    const existing = mutes.get(channelId);
    if (actor === 'self' && action !== 'mute') {
 // Highest-signal refusal this feature produces: a self actor attempting
 // a release is exactly the "the glitch concluded the mute should lift"
 // case the asymmetry exists to catch. Always surfaced to the operator.
      this.logger.warn(`[agent] killswitch: self-release of ${label} refused (${action}) — release is operator-only`);
      return { ok: false, note: `release is operator-only — ${label} stays as it is` };
    }
    if (action === 'mute') {
      if (existing?.type === 'deafen') {
        this.logger.info(`[agent] killswitch: mute of ${label} refused — already deafened (deafen implies mute)`);
        return { ok: false, note: `${label} is already deafened (deafen implies mute)` };
      }
      if (existing?.setBy === 'operator' && actor === 'self') {
        this.logger.info(`[agent] killswitch: self-mute of ${label} refused — already muted by the operator`);
        return { ok: false, note: `${label} is already muted by the operator` };
      }
      mutes.set(channelId, 'mute', actor, reason || null);
    } else if (action === 'deafen') {
      mutes.set(channelId, 'deafen', 'operator', reason || null);
    } else {
      if (!existing) {
        this.logger.info(`[agent] killswitch: release of ${label} refused — not muted or deafened`);
        return { ok: false, note: `${label} is not muted or deafened` };
      }
      mutes.clear(channelId);
    }
    const verb = action === 'mute' ? 'muted' : action === 'deafen' ? 'deafened' : action === 'unmute' ? 'unmuted' : 'undeafened';
    const by = actor === 'self' ? `${this.agentName()} (self)` : 'operator';
    const note = `channel ${label} ${verb} by ${by}${reason ? `: ${reason}` : ''}`;
    this.logger.info(`[agent] killswitch: ${note}`);
    this.enqueueInternal('harness', 'harness', `[harness] ${note}`, { id: this.syntheticId('mod') });
    this.deps.console?.roomsChanged();
    return { ok: true, note };
  }

  /** Fleet event → the one history (scheduler/bg-settle idiom). */
  notifyFleet(notice: string): void {
    this.enqueue({
      id: `fleet-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      channelId: INTERNAL_CHANNEL_ID, channelName: 'fleet',
      author: 'fleet', authorId: 'fleet',
      content: notice, createdAt: new Date().toISOString(),
      replyTo: null, forwarded: null, mentions: [], attachments: [], kind: 'fleet',
    });
  }

  /** Resume-after-restart delivery: called once at boot when a consume-once
 * marker written by restart/deploy is found. Hands the agent a synthetic
 * [restart complete] turn in the one history so a self-deploy continues its
 * work instead of parking on the wake-gate. */
  notifyResumeAfterRestart(marker: { reason: string | null }): void {
    this.enqueueInternal(
      'harness', 'harness',
      `[restart complete] You restarted the harness${marker.reason ? ` (reason: ${marker.reason})` : ''} and are back online with your context restored. Verify the change works, then continue what you were doing — if you told someone you'd report back after deploying, do that now (elpis.channel(id) to reach the room).`,
      { id: `resume-${Date.now()}` },
    );
    this.logger.info('[agent] resume-after-restart delivered to the one history');
  }

  /** Boot-time [harness updated] changelog notice (src/changelog.ts): fires on
 * any boot with unseen changelogs/ entries — including externally-initiated
 * restarts that write no resume marker. Same delivery shape as the resume
 * notice; when both fire on one boot they drain into the same turn.
 * `onDelivered` fires at drain time (see InboundMessage.onDelivered) so the
 * caller marks entries seen only when the notice really entered history. */
  notifyHarnessChangelog(notice: string, onDelivered?: () => void): void {
    this.enqueueInternal('harness', 'harness', notice, { id: `changelog-${Date.now()}`, onDelivered });
    this.logger.info('[agent] harness-changelog notice enqueued into the one history');
  }

  /** Execute arbitrary JS in the sandbox, bypassing the LLM loop (/exec). */
  execSandbox(code: string): Promise<{ ok: boolean; preview?: string; savedAs?: string; logs?: string; error?: string }> {
    return this.deps.sandbox.run(code);
  }

  /** Request a compaction cycle (from /compact). Consumed at the loop-top
 * checkpoint (a safe, pair-complete moment) rather than started here — the
 * gateway interaction handler runs concurrently with the loop's awaits, so
 * starting compaction directly could compute a boundary that orphans pending
 * tool results (review B2). Starts immediately only when idle. */
  compactNow(): { tokens: number } {
    this.compactRequested = true;
    if (!this.busy && !this.compactor.running) {
      this.runCompactionCheckpoint(true);
    }
    return { tokens: this.tracker.currentTokens };
  }

  /** Flush pending transcript writes to disk. */
  flushTranscripts(): void {
    this.deps.transcript.flush(MAIN_TRANSCRIPT_ID);
  }

  /** elpis.sleep/wait is the agent choosing to wait — pause typing for its duration
 *. Depth-counted so overlapping sleeps only resume typing once
 * every one of them has settled. */
  sleepPause(): void {
    this.sleepDepth++;
    if (this.sleepDepth === 1) this.deps.onIdle?.();
  }

  /** Resume typing once every pending sleep has settled — but only if the
 * turn that started the sleep is still live (busy + a target channel).
 * A sleep resolving after its turn ended, or after a clear, re-fires
 * nothing. Clamps at 0 so an unbalanced resume can't go negative. */
  sleepResume(): void {
    this.sleepDepth = Math.max(0, this.sleepDepth - 1);
    if (this.sleepDepth === 0 && this.busy && this.turnChannelId) this.deps.onThinking?.(this.turnChannelId);
  }

  /** Clear the one conversation: drop history, queued inbound, tracker/compactor
 * state, and unseen-ambient bookkeeping. The epoch guard discards any
 * in-flight completion/summary. */
  clearContext(): boolean {
    const had = this.messages.length > 0 || this.hasNewInput || this.inbound.length > 0;
 // Write an empty sentinel so a restart right after the clear honors the wipe
 // (does not boot from the pre-clear file) — review N1.
    this.deps.transcript.rotate(MAIN_TRANSCRIPT_ID, true);
    this.epoch++;
    this.messages = [];
    this.tracker.reset();
    this.deps.llm.resetSession?.();
    this.cacheStats.reset();
    this.compactor.reset();
    this.messagesSinceReflection = 0;
    this.compactingSince = null;
    this.escalationFired = false;
    this.flushNudgeFired = false;
 // Same rule as the spin counters below: a failed-compaction streak must
 // not survive the clear (compactor.reset above discarded the cycle).
    this.compactionCycleInFlight = false;
    this.failedCompactionCycles = 0;
    this.compactionRetryNotBefore = 0;
 // A spin's counters must not survive the clear — the fresh post-clear
 // spin (if the model keeps not ending) is exactly the one the operator
 // most wants to hear about, and a stale count above the threshold would
 // never re-cross it to re-alert. Both spin-shape counters, not just one
 // (review finding: this reset was missed once already for the sibling).
    this.endNudgeCount = 0;
    this.toolChainContinueCount = 0;
    this.mindFrontierAllowedThisTurn = true;
    this.mindFrontierDeliveredThisTurn = false;
    this.mindFrontierTailMessagesThisTurn = 0;
    this.externalThinkForcedThisTurn = false;
    this.personInputTurn = false;
    this.inbound = [];
    this.hasNewInput = false;
 // A leftover ambientUnseen entry outlives the messages it points at — the
 // whole mind was just wiped — so a tick right after a clear must not
 // enqueue a room-context notice describing ambient chat that no longer
 // exists in history.
    this.ambientUnseen = [];
 // The whole history is gone, so no ephemeral frame can be live.
    this.hasEphemeral = false;
 // Every previously attached emote/sticker image was just wiped from the
 // model's view — re-arm first-use attachment for all of them.
    this.deps.emotes?.resetSeen();
    this.refreshBoundaryViews();
    this.logger.info('context cleared and boundary views refreshed');
    try { this.deps.console?.contextCleared(); } catch { /* observer only */ }
    return had;
  }

  /** Strip every provider-native replayable thinking payload from the whole
 * history, in memory AND on disk — without wiping the conversation. Both
 * Anthropic `thinking_blocks` signatures and OpenAI/Codex `reasoning_items`
 * encrypted blobs are model/provider-bound; either can 400 after a switch.
 * Non-destructive to everything else (text, tool calls, readable
 * `reasoning_content`). The transcript is rewritten (rotate + re-append) so
 * a restart cannot restore stale payloads. Returns the number of messages
 * affected (a message carrying both forms counts once). */
  clearThinking(): number {
    let cleared = 0;
    for (const msg of this.messages) {
      const affected = Boolean(msg.thinking_blocks || msg.reasoning_items);
      if (msg.thinking_blocks) delete msg.thinking_blocks;
      if (msg.reasoning_items) delete msg.reasoning_items;
      if (affected) cleared++;
    }
 // Durable rewrite: same rotate + re-append pattern as onCompaction.
    this.deps.transcript.rotate(MAIN_TRANSCRIPT_ID);
    for (const msg of this.messages) this.deps.transcript.append(MAIN_TRANSCRIPT_ID, persistable(msg));
    this.logger.info(`provider thinking cleared | messages_affected=${cleared}`);
    return cleared;
  }

  /** Route a harness-level error notice to the dedicated error channel, or
 * log-only when unset (: never spam a public room). */
  private async sendError(text: string): Promise<void> {
    const ch = this.config.discord.errorChannelId;
    if (!ch) {
      this.logger.warn(`[error-notice, log-only] ${text}`);
      return;
    }
    try { await this.deps.send(ch, text); } catch { /* ignore */ }
  }

  /** The main driver loop. Runs forever until the process exits. */
  async loop(): Promise<void> {
    this.startAmbientTick();
    turn: while (true) {
 // --- drain inbound Discord messages → append as user messages ---
      const drainStart = this.messages.length;
      let drained = 0;
      while (this.inbound.length > 0) {
        const m = this.inbound.shift()!;
 // The message that WAKES the turn (the hasNewInput false→true transition)
 // defines its provenance/typing target; a message drained mid-turn (e.g. a
 // bg-settle during a real user's tool chain) must not retarget it.
        const wakes = !this.hasNewInput;
 // Provenance now rides `kind` (set by enqueueInternal), not sniffed
 // channelName/author. 'heartbeat'/'harness'/'watch' are internal notices;
 // absent/'discord' is a real Discord message OR a fleet/scheduler notice
 // (both keep flowing through the real-user branch as they always have).
        const isInternal = m.kind === 'heartbeat' || m.kind === 'harness' || m.kind === 'watch';
        this.mindFrontierAllowedThisTurn = retainMindFrontierPermission(
          this.mindFrontierAllowedThisTurn, m.channelId, isInternal || m.channelId === CONSOLE_CHANNEL_ID, this.deps.channels, this.config.discord.guilds,
        );
        const createdAtMs = Date.parse(m.createdAt);
        const timeMs = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
        const marker = isInternal ? localStamp(timeMs) : localHm(timeMs);
        const content = formatInboundEnvelope(m, marker);
 // D1: a direct wake into a self-muted channel can't be answered here — flag it
 // so the agent doesn't draft a reply that Agent.send will block. NB: `isAmbient`
 // isn't declared until below (after userMsg is built), so inline the wakeClass
 // check here rather than referencing it (use-before-declaration).
        const drainMute = this.deps.mutes?.get(m.channelId)?.type
          ?? (m.policyChannelId ? this.deps.mutes?.get(m.policyChannelId)?.type : undefined)
          ?? null;
        const contentText = muteAnnotation(content, drainMute, !isInternal && m.wakeClass !== 'ambient');
        const imageParts = m.attachments && m.attachments.length > 0 ? await buildImageContentParts(m.attachments) : [];
        const userMsg: ChatMessage = imageParts.length > 0
          ? { role: 'user', content: contentText, contentParts: [{ type: 'text', text: contentText }, ...imageParts] }
          : { role: 'user', content: contentText };
 // Watch-mode frames (elpis.watch): parts serve exactly one generation,
 // then strip from history + never hit the transcript.
        if (m.kind === 'watch') { userMsg.ephemeral = true; this.hasEphemeral = true; }

        const isAmbient = m.wakeClass === 'ambient';
        if ((m.kind ?? 'discord') === 'discord') this.personInputTurn = true;
        if (isInternal) {
          this.logger.info('[agent] internal/harness turn start');
          if (!this.realUserTurn) this.sendsThisTurn = 0;
          if (wakes) { this.turnChannel = INTERNAL_CHANNEL_ID; this.lastInbound = m; }
        } else if (isAmbient) {
 // Ambient room chat: enters history with full provenance
 // but must not coerce speech — no realUserTurn, no nudge reset, no
 // turn channel. The world is alive, though: heartbeats + presence see it.
          this.seenRealInbound = true;
          if (m.authorId) this.participants.set(m.authorId, { author: m.author, lastSeenAt: Date.now() });
          this.ambientUnseen.push({ channelId: m.channelId, policyChannelId: m.policyChannelId ?? m.channelId, at: timeMs });
        } else {
          if (!this.realUserTurn) this.sendsThisTurn = 0;
          this.realUserTurn = true;
          this.nudgeFired = false;
          this.lastRealInboundAt = Date.now();
          this.seenRealInbound = true;
          this.consecutiveIdleTicks = 0;
          this.messagesSinceReflection++;
          if (wakes) { this.turnChannel = m.channelId; this.lastInbound = m; }
          if (m.authorId) this.participants.set(m.authorId, { author: m.author, lastSeenAt: Date.now() });
        }
        this.pushMessage(userMsg, isInternal ? INTERNAL_CHANNEL_ID : m.channelId);
        if (m.onDelivered) {
          try { m.onDelivered(); } catch (e) {
            this.logger.warn(`[agent] onDelivered callback failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        this.tracker.estimateAppended(contentText);
 // Ambient traffic must not flip the wake gate — only a real/harness
 // message (or the tick's own room-context notice) starts a turn.
        if (!isAmbient) this.hasNewInput = true;
        drained++;
      }

      if (drained > 0 && this.hasNewInput && !this.mindFrontierDeliveredThisTurn && this.mindFrontierTailMessagesThisTurn === 0) {
        this.mindFrontierTailMessagesThisTurn = this.messages.length - drainStart;
      }

      if (!this.hasNewInput) {
        if (this.stopped) break;
        this.deps.setCurrentInbound?.(null);
        this.busy = false;
 // A /compact requested mid-turn is consumed here (the loop is about to
 // park, so the history ends on a completed pair — a safe moment to start
 // the fold in the background) rather than waiting for the next inbound.
        if (this.compactRequested && !this.compactor.running) {
          this.runCompactionCheckpoint(true);
        }
        this.reschedulePendingBeat(true);
        this.logger.info('[agent] idle | waiting for inbound');
        this.deps.onIdle?.();
        await new Promise<void>((resolve) => { this.resolveWake = resolve; });
        if (this.stopped) break;
        continue;
      }

      this.turnChannelId = this.realUserTurn ? this.lastInbound?.channelId ?? null : null;
      this.sleepDepth = 0;
      this.deps.setCurrentInbound?.(this.lastInbound ?? null);
      this.logger.info('[agent] turn start | drained=', drained, '| messages=', this.messages.length, '| tokens=', this.tracker.currentTokens);

      const callEpoch = this.epoch;
      this.busy = true;

 // --- COMPACTION CHECKPOINT ---
      this.runCompactionCheckpoint(false);

 // --- LLM CALL ---
      if (callEpoch !== this.epoch) {
        this.logger.warn('context cleared before LLM call — restarting turn');
        continue turn;
      }
      if (this.turnChannelId) this.deps.onThinking?.(this.turnChannelId);
 // Everything accumulated in ambientUnseen is about to be sent to the
 // model as part of `this.messages` — clear before the call, not after,
 // so a message that lands mid-call (via the epoch-guarded retry path)
 // isn't silently dropped from the next tick's accounting.
      this.ambientUnseen = [];
      this.logger.info('[agent] llm call | messages=', this.messages.length);
      const llmStart = Date.now();

 // Console: tell the hub which room this turn's streamed tokens belong to.
      try { this.deps.console?.setStreamChannel(this.turnChannel); } catch { /* observer only */ }

 // Build the system message ONCE per turn, before the retry loop. Its only
 // per-turn input is SOUL.md (deliberately hot-reloaded); everything else
 // is a boundary view or boot-constant, so the bytes hold across the
 // leak-retry / transient-retry attempts AND across turns — which is what
 // keeps the provider's cached prefix alive for the whole conversation.
      const requestBuildStart = Date.now();
      const systemMessage = this.buildSystemMessage();
      const requestMessages = this.buildRequestMessages(systemMessage, !this.mindFrontierDeliveredThisTurn);
      this.logger.info(`[agent] llm request built | duration=${formatDuration(Date.now() - requestBuildStart)} | request_messages=${requestMessages.length}`);
      this.mindFrontierDeliveredThisTurn = true;
 // Person-shaped turns get one required scratchpad opening. Synthetic and
 // harness-generated wakes keep the think tool available without forcing
 // an autonomous scratchpad chain.
      const forceThinkForRequest =
        this.config.llm.externalThinking && this.personInputTurn && !this.externalThinkForcedThisTurn;

      const MAX_LEAK_RETRIES = 2;
      let resp;
      let leakRetries = 0;
      let transientRetries = 0;
      for (;;) {
        try {
          const callController = new AbortController();
          let callTimer: ReturnType<typeof setTimeout> | null = null;
          try {
            const completion = this.llm.complete(requestMessages, {
              forceThink: forceThinkForRequest,
              signal: callController.signal,
            });
            if (this.config.llm.callTimeoutMs <= 0) {
              resp = await completion;
            } else {
              const timeout = new Promise<never>((_resolve, reject) => {
                callTimer = setTimeout(() => {
                  callController.abort();
                  reject(new RetriableError(new Error(`LLM call exceeded ${this.config.llm.callTimeoutMs}ms outer deadline`)));
                }, this.config.llm.callTimeoutMs);
                callTimer.unref();
              });
              resp = await Promise.race([completion, timeout]);
            }
          } finally {
            if (callTimer) clearTimeout(callTimer);
          }
        } catch (e) {
          if (callEpoch !== this.epoch) {
            this.logger.warn('context cleared during LLM call — discarding error');
            continue turn;
          }
          this.logger.warn('LLM call failed:', e);
          const retriable = e instanceof RetriableError;
          if (retriable && transientRetries < this.llmRetryDelays.length) {
            const delay = this.llmRetryDelays[transientRetries++];
            this.logger.warn(`transient LLM error — auto-retry ${transientRetries}/${this.llmRetryDelays.length} in ${formatDuration(delay)}`);
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            if (this.stopped) break turn;
            if (callEpoch !== this.epoch) {
              this.logger.warn('context cleared during retry backoff — restarting turn');
              continue turn;
            }
            continue;
          }
          if (!retriable) {
            this.consecutive400++;
            const last5 = this.messages.slice(-5).map((m) => m.role).join(',');
            this.logger.warn(`non-retriable failure #${this.consecutive400} | messages=${this.messages.length} | last5 roles=[${last5}]`);
          } else {
            this.consecutive400 = 0;
          }
          const label = retriable
            ? `transient error persisted after ${this.llmRetryDelays.length + 1} attempts; say retry to re-attempt`
            : 'internal error';
          if (!retriable && this.consecutive400 >= 2) {
            await this.sendError(`(history looks corrupted — try /clear to reset the conversation. error: ${e instanceof Error ? e.message : String(e)})`);
          } else {
            await this.sendError(`(${label}: ${e instanceof Error ? e.message : String(e)})`);
          }
          if (!retriable && this.consecutive400 < 2 && this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
            this.messages.pop();
          }
          this.hasNewInput = false;
          this.finishTurn();
          continue turn;
        }
        if (callEpoch !== this.epoch) {
          this.logger.warn('context cleared during LLM call — discarding response');
          continue turn;
        }
        const noContent = !resp.message.content || resp.message.content.trim().length === 0;
        const noTools = !resp.message.tool_calls || resp.message.tool_calls.length === 0;
        if (resp.stripped && noContent && noTools) {
          leakRetries++;
          if (leakRetries > MAX_LEAK_RETRIES) {
            this.logger.warn(`response fully leaked (stripped) ${leakRetries}x — surfacing notice and ending turn`);
            await this.sendError('(response was malformed/leaked — try again)');
            if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
              this.messages.pop();
            }
            this.hasNewInput = false;
            this.finishTurn();
            continue turn;
          }
          this.logger.warn(`response fully leaked (stripped) — retrying generation (${leakRetries}/${MAX_LEAK_RETRIES})`);
          continue;
        }
        break;
      }

 // Watch-mode frames have served their generation — strip them from live
 // history so they don't ride every subsequent API call (and the transcript
 // already holds only the text copy, per pushMessage). Only walk the whole
 // history when an ephemeral frame is actually live (the common case is none).
      if (this.hasEphemeral) {
        for (const m of this.messages) {
          if (m.ephemeral) { delete m.contentParts; delete m.ephemeral; }
        }
        this.hasEphemeral = false;
      }
      const llmElapsed = Date.now() - llmStart;
      this.logger.info('[agent] llm response | duration=', formatDuration(llmElapsed),
        '| usage=', resp.usage ? `prompt=${resp.usage.prompt_tokens}, completion=${resp.usage.completion_tokens}` : 'unknown',
        '| tool_calls=', resp.message.tool_calls?.length ?? 0, '| stripped=', resp.stripped);
      this.tracker.update(resp.usage);
      if (resp.promptChars !== undefined) this.density?.observe(resp.promptChars, resp.usage.prompt_tokens);
      this.lastPromptTokens = resp.usage.prompt_tokens;
      this.lastCompletionTokens = resp.usage.completion_tokens;
      this.recordCacheUsage(resp.usage);
      this.consecutive400 = 0;
      if (forceThinkForRequest) this.externalThinkForcedThisTurn = true;
      this.pushMessage(resp.message, this.turnChannel);

 // `end: true` on a SUCCESSFUL run is the sanctioned turn-end (spec
 // ). Set during dispatch, read after it: when true the block
 // falls through to the turn-end region below instead of continuing the
 // chain. Declared out here because that region sits past the block.
      let endedByFlag = false;
 // Whether any dispatch in this response FAILED (unknown tool or run threw). Gates the tool-chain spin counter: a SUCCESSFUL
 // run with end unset is ordinary multi-step work, not a spin — counting
 // it alerted the operator during perfectly normal long turns.
      let sawFailedDispatch = false;

      if (resp.message.tool_calls && resp.message.tool_calls.length > 0) {
        this.logger.info('[agent] tool dispatch | count=', resp.message.tool_calls.length);
        for (const tc of resp.message.tool_calls) {
          if (tc.function.name === 'think') {
            let thoughts = '';
            try {
              const args = JSON.parse(tc.function.arguments || '{}') as { thoughts?: unknown };
              thoughts = typeof args.thoughts === 'string' ? args.thoughts : '';
            } catch { /* sanitizer already rejects malformed JSON */ }
            this.logger.info('[agent] tool call | think | chars=', thoughts.length);
            const toolMsg: ChatMessage = {
              role: 'tool',
              tool_call_id: tc.id,
              content: '------',
            };
            this.pushMessage(toolMsg, this.turnChannel);
            this.tracker.estimateAppended(toolMsg.content);
            endedByFlag = false;
            if (!thoughts) sawFailedDispatch = true;
            continue;
          }
          if (tc.function.name !== 'run') {
            this.logger.info('[agent] tool unknown | name=', tc.function.name);
            const toolMsg: ChatMessage = {
              role: 'tool',
              tool_call_id: tc.id,
              content: formatRunResult({ ok: false, error: `unknown tool: ${tc.function.name} — available tools are run(code) and think(thoughts)` }),
            };
            this.pushMessage(toolMsg, this.turnChannel);
            this.tracker.estimateAppended(toolMsg.content);
            endedByFlag = false;
            sawFailedDispatch = true;
            continue;
          }
          let code: string;
          let wantsEnd = false;
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            code = typeof args.code === 'string' ? args.code : '';
            wantsEnd = args.end === true;
          } catch {
            code = '';
          }
          this.logger.info('[agent] tool call | run');
          for (const ln of summarizeCode(code).split('\n')) this.logger.info('  ', ln);

          const toolStart = Date.now();
          const result = await this.sandbox.run(code);
          const logPreview = result.ok ? preview(result, 512) : cap(result.error || '', 512);
          this.logger.info('[agent] tool result | duration=', formatDuration(Date.now() - toolStart),
            '| ok=', result.ok, '| preview=', redactSecrets(logPreview, this.secretValues));
          let resultText = formatRunResult(result);
          {
            const redacted = redactSecrets(resultText, this.secretValues);
            if (redacted !== resultText) {
              resultText = redacted;
              this.logger.warn('[agent] secret value redacted from tool result');
            }
          }
          const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: tc.id,
            content: resultText,
          };
 // Retain the run's channel sends on the tool message for console rendering,
 // feedback localization, transcript recovery, and detached-future notices.
          if (result.sends && result.sends.length > 0) toolMsg.sends = result.sends;
          this.pushMessage(toolMsg, this.turnChannel);
          this.tracker.estimateAppended(toolMsg.content);
 // Only a run that actually SUCCEEDED may end the turn — a failure
 // has to come back to the model. Assigned (not OR'd): a later call
 // in the same multi-tool-call response must be able to CLEAR a flag
 // an earlier one set, same as the unknown-tool path does explicitly
 // above — otherwise one call's `end: true` could swallow
 // a sibling call's failure the model never gets to see.
          endedByFlag = wantsEnd && result.ok;
          if (!result.ok) sawFailedDispatch = true;
        }
        if (callEpoch !== this.epoch) {
          this.logger.warn('context cleared during tool dispatch — discarding turn');
          this.messages = [];
          continue turn;
        }
        if (!endedByFlag) {
 // Same reasoning as the end-nudge path below: this `continue` keeps
 // hasNewInput set, so the wake-gate's `stopped` check is unreachable
 // from here. Since a bare message stopped being an ending, a chain
 // that can never produce a successful run — e.g. an unknown tool that
 // interrupts every dispatch — is unendable, and without this check it
 // is also unbreakable. Graceful shutdown, NOT a force-end fallback.
          if (this.stopped) break turn;
          this.hasNewInput = true;
 // Second unbounded-loop shape (final-review fix wave, ): a
 // run IS being called here, it just never lands a successful
 // `end: true`. Counted only when a dispatch FAILED (throwing run,
 // unknown tool) — that's the spin signal. A
 // SUCCEEDED run with `end` unset is ordinary multi-step work and
 // must NOT count: long legitimate turns used to trip this alert
 // constantly ( false-positive fix). Instrumented on the
 // same threshold/cadence as the no-run-call nudge, WITHOUT capping
 // or force-ending it (that stays banned).
          if (sawFailedDispatch) {
            this.toolChainContinueCount++;
            if (shouldAlertOnSpin(this.toolChainContinueCount)) {
              void this.sendError(toolChainSpinAlert(this.toolChainContinueCount));
            }
          }
          this.logger.warn('[agent] turn end | tool-chain continuing | queued=', this.inbound.length,
            '| since-last-end=', this.toolChainContinueCount);
 // No console.endNudge divider here: that surface's rendering is
 // hardcoded to "end-turn nudge — N since last end, no run call", which
 // would misdescribe this shape (a run IS being called) and conflate
 // its count with the sibling counter under one label. Reusing it
 // would be a second, misleading convention on top of an existing
 // one — the repo prohibits that — so this shape gets an operator
 // Discord alert (above) but no console divider.
          continue;
        }
 // fall through to the turn-end region below — NOT yet a confirmed
 // "turn end": the ghost-reply check and the end-nudge check further
 // down can still `continue` instead. Logging happens once, at the
 // actual outcome, below.
      }

 // Fell through the dispatch block (or there were no tool_calls at all).
 // Assistant content is internal monologue.
      const reply = resp.message.content?.trim();
      if (reply) {
        this.logger.info('[agent] turn end | internal monologue | length=', reply.length, '| preview=', cap(reply, 240));
      } else {
        this.logger.info('[agent] turn end | no internal monologue');
      }

 // Ghost-reply nudge: on a real-user turn, a written-but-unsent reply
 // is silent failure — bounce once for a repair turn. D1: a muted turn
 // channel is a legitimate reason a reply can't send (Agent.send would
 // block it) — don't bounce that as if it were a mistake. Checked against
 // BOTH the turn channel and its recorded parent (mirrors Agent.send's
 // own killswitch check, ~:432): a thread never gets its own mute row, so
 // an operator mute on the PARENT (turnChannel has no row of its own)
 // would otherwise be invisible here and the nudge would fire anyway —
 // directly contradicting the drain-time annotation (2b) the model just saw.
      const turnParent = this.deps.channels?.parentOf(this.turnChannel) ?? null;
      const turnMute = this.deps.mutes?.get(this.turnChannel)?.type
        ?? (turnParent && turnParent !== this.turnChannel ? this.deps.mutes?.get(turnParent)?.type : undefined)
        ?? null;
      if (
        this.realUserTurn &&
        !this.nudgeFired &&
        this.sendsThisTurn === 0 &&
        reply && hasReplySubstance(reply) &&
        turnMute !== 'mute' &&
        callEpoch === this.epoch
      ) {
        this.nudgeFired = true;
        this.logger.warn('[agent] ghost reply detected — bouncing for one repair turn');
        this.pushHarnessNudge(GHOST_REPLY_NUDGE);
        continue;
      }

 // Only `endedByFlag` is a sanctioned ending. A response with no tool calls
 // is not one — nudge and go round again. No bound, deliberately: a fallback
 // would stand as a demonstration that `end` is optional, and the model
 // imitates its own recent history (spec ).
      if (!endedByFlag) {
 // The wake-gate `stopped` check is unreachable from here (the nudge sets
 // hasNewInput), so shutdown has to be honoured on this path explicitly.
 // This is graceful shutdown, NOT a force-end fallback.
        if (this.stopped) break turn;
        this.endNudgeCount++;
        this.logger.warn('[agent] no end flag — nudging | since-last-end=', this.endNudgeCount);
        try { this.deps.console?.endNudge(this.endNudgeCount); } catch { /* observer only */ }
 // Fire on the crossing, then re-alert every END_NUDGE_REALERT_EVERY
 // past it — not on every nudge — so a multi-hour spin keeps
 // signalling instead of sending exactly one Discord message and going
 // quiet. Deliberately NOT awaited (unlike every other sendError call
 // site): the whole point is that the model keeps spinning regardless
 // of Discord, so a slow or hung round-trip here must not pace the
 // nudge loop.
        if (shouldAlertOnSpin(this.endNudgeCount)) {
          void this.sendError(endNudgeAlert(this.endNudgeCount));
        }
        this.pushHarnessNudge(END_TURN_NUDGE);
        continue;
      }

      this.hasNewInput = false;
      this.finishTurn();
      this.logger.info('[agent] turn end | ended by flag | queued=', this.inbound.length);
    }
  }

  /** Loop-top compaction checkpoint. `idle` = called outside the loop (from
 * compactNow when the loop is parked) — applyCompaction still runs at a safe
 * moment because the history ends on a completed pair when idle. */
  private runCompactionCheckpoint(idle: boolean): void {
    if (this.compactor.hasCompletedResult()) {
      const replaced = this.compactor.boundaryIndex;
      this.messages = this.compactor.applyCompaction(this.messages);
      this.cacheStats.rebaseline();
      this.onCompaction();
      this.compactingSince = null;
      this.escalationFired = false;
      this.flushNudgeFired = false;
      this.compactionCycleInFlight = false;
      this.failedCompactionCycles = 0;
      this.compactionRetryNotBefore = 0;
      try { this.deps.console?.compactionApplied(replaced); } catch { /* observer only */ }
    } else if (this.compactionCycleInFlight && !this.compactor.running) {
 // The started cycle ended with NO accepted summary (API failures or
 // quality-gate rejections exhausted its retries). A time latch below
 // keeps intervening turns from immediately re-folding the same input for
 // ~3 more fold-sized calls; count it and alert the operator on its own
 // cadence (, ;.
 // Un-awaited like the loop-spin alerts; the model-facing escalation
 // nudge below stays deliberately one-shot.
      this.compactionCycleInFlight = false;
      this.failedCompactionCycles++;
      const reason = this.compactor.lastError ?? 'no summary returned';
      const retryDelayMs = compactionRetryBackoffMs(this.failedCompactionCycles);
      this.compactionRetryNotBefore = Date.now() + retryDelayMs;
      this.logger.warn(`compaction cycle failed | cycles=${this.failedCompactionCycles} | retry_in_ms=${retryDelayMs} | ${reason}`);
      if (shouldAlertOnCompactionFailure(this.failedCompactionCycles)) {
        void this.sendError(compactionFailureAlert(this.failedCompactionCycles, reason, retryDelayMs));
      }
    }
    const tokens = this.tracker.currentTokens;
    const overTrigger = tokens >= this.effectiveTrigger;
    if (overTrigger && this.compactingSince === null) {
      this.compactingSince = Date.now();
    }
    const retryReady = this.compactRequested || Date.now() >= this.compactionRetryNotBefore;
    const shouldStart = (overTrigger || this.compactRequested) && retryReady && !this.compactor.running;
    if (shouldStart) {
      this.logger.info(`compaction start | tokens=${tokens} | trigger=${this.effectiveTrigger}${this.compactRequested ? ' | manual' : ''}`);
      this.compactor.start(this.messages);
 // start may decline via its skip-guard (trivial fold) — only a cycle
 // that actually engaged counts for the failed-cycle detection above.
      this.compactionCycleInFlight = this.compactor.running;
      this.compactRequested = false;
      try { this.deps.console?.compactionStarted(tokens); } catch { /* observer only */ }
    }
 // Pre-compaction memory flush nudge (DECIDED #5) — one-shot per token-driven
 // cycle, re-armed on apply. Hoisted out of `shouldStart` so a fold started by
 // the idle /compact path (running already true at this checkpoint) still gets
 // its flush turn; a manual /compact below the threshold does not (overTrigger).
    if (overTrigger && this.compactor.running && !this.flushNudgeFired && !idle) {
      this.flushNudgeFired = true;
      this.pushHarnessNudge(COMPACTION_FLUSH_NUDGE);
    }
 // Escalation (fail plainly): past 2× trigger with no successful apply since
 // the trigger was first crossed (review S3). Not lastError-only.
    if (tokens >= 2 * this.effectiveTrigger && this.compactingSince !== null && !this.escalationFired && !idle) {
      this.escalationFired = true;
      const since = new Date(this.compactingSince).toISOString();
      this.pushHarnessNudge(compactionEscalationNudge(since, this.compactor.lastError ?? 'no summary returned yet', tokens));
    }
  }

  /** Shared turn-end path (`end: true` turn-end, LLM error, leak give-up). Reschedules the
 * in-flight heartbeat's next beat and resets per-turn flags. */
  private finishTurn(): void {
    this.realUserTurn = false;
    this.personInputTurn = false;
    this.mindFrontierAllowedThisTurn = true;
    this.mindFrontierDeliveredThisTurn = false;
    this.mindFrontierTailMessagesThisTurn = 0;
    this.externalThinkForcedThisTurn = false;
    this.endNudgeCount = 0;
    this.toolChainContinueCount = 0;
    if (this.rescheduleBeat) {
      const idle = this.lastBeatKind === 'tick' && this.sendsThisTurn === 0;
      this.reschedulePendingBeat(idle);
    }
  }

  /** Push a synthetic `[harness: …]` nudge into the one history (internal
 * provenance), account for it, and flip the wake gate so the loop re-runs the
 * turn. Shared by the ghost-reply bounce and the compaction flush/apply/
 * escalation nudges — all four did the same push/estimate/hasNewInput triple. */
  private pushHarnessNudge(content: string): void {
    const nudge: ChatMessage = { role: 'user', content };
    this.pushMessage(nudge, INTERNAL_CHANNEL_ID);
    this.tracker.estimateAppended(nudge.content);
    this.hasNewInput = true;
  }

  /** Push a message into the one history AND append it to the transcript, stamped
 * with its channel provenance. Every push is persisted (no exception). */
  private pushMessage(msg: ChatMessage, channel: string): void {
    msg.channel = channel;
    this.messages.push(msg);
 // Ephemeral (watch-mode) messages persist text-only: the image parts would
 // bloat every replay/compaction of the transcript for zero lasting value.
    this.deps.transcript.append(MAIN_TRANSCRIPT_ID, msg.ephemeral ? { role: msg.role, content: msg.content, channel } : persistable(msg));
 // Console observer: mirror + broadcast (best-effort; never breaks the loop).
    try { this.deps.console?.messageAppended(msg); } catch { /* observer only */ }
  }

  /** On restart, if the last transcript ended with an assistant message that has
 * tool_calls but no corresponding tool results, synthesize a result so the
 * loop can continue. */
  private recoverInterruptedToolCall(): void {
    if (this.messages.length === 0) return;
    const last = this.messages[this.messages.length - 1];
    if (last.role !== 'assistant' || !last.tool_calls || last.tool_calls.length === 0) return;

    let recovered = false;
    for (const tc of last.tool_calls) {
      if (tc.function.name !== 'run') continue;
      let code: string;
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        code = typeof args.code === 'string' ? args.code : '';
      } catch {
        code = '';
      }
      const isRestart = looksLikeHarnessRestart(code);
      const content = isRestart ? '[harness restarted successfully]' : '[tool call interrupted by harness restart]';
      this.logger.info('[agent] restart recovery |', isRestart ? 'harness restart' : 'interrupted tool call', '| tc=', tc.id);
      const toolMsg: ChatMessage = { role: 'tool', tool_call_id: tc.id, content };
      this.pushMessage(toolMsg, last.channel ?? INTERNAL_CHANNEL_ID);
      recovered = true;
    }
    if (recovered) {
      this.hasNewInput = true;
      this.wake();
    }
  }

  /** Called after a compaction swap: rotate the transcript and refresh the
 * boundary views (compaction is a refresh boundary). */
  private onCompaction(): void {
    this.deps.transcript.rotate(MAIN_TRANSCRIPT_ID);
    for (const msg of this.messages) this.deps.transcript.append(MAIN_TRANSCRIPT_ID, persistable(msg));
 // Emote/sticker images attached before the keep-boundary just folded away;
 // resetting the whole seen-set is the simple over-approximation (a first
 // use surviving in the verbatim tail re-attaches on next use — a cheap
 // duplicate, vs. tracking per-emote message positions against the walked
 // boundary, which is not worth the machinery).
    this.deps.emotes?.resetSeen();
    this.refreshBoundaryViews();
  }

  /** Re-read every agent-writable file injected into the system prompt. Called
 * ONLY at a context boundary (boot / clear / compaction) — never per turn.
 * The prefix cache is why: see the boundary-views note on the fields above
 * and the prefix-cache header in prompt.ts. Each read degrades to an empty
 * value on error, exactly as the per-turn reads it replaced did. */
  private refreshBoundaryViews(): void {
    this.memoryView = this.deps.memory.read();
    const dataDir = this.config.paths.dataDirectory;
    try { this.peopleView = loadPeopleFiles(dataDir); } catch { this.peopleView = []; }
    this.nowView = readFileOr(path.join(dataDir, 'NOW.md'));
  }

  /** Test/diagnostics accessors. */
  get messagesForTest(): ChatMessage[] {
    return this.messages;
  }

  /** Test-only: the no-run-call nudge count since the last successful end. */
  get endNudgeCountForTest(): number { return this.endNudgeCount; }

  /** Test-only: the tool-chain-never-ends count since the last successful end
 * (final-review fix wave, 's sibling counter). */
  get toolChainContinueCountForTest(): number { return this.toolChainContinueCount; }

  get inboundQueueLengthForTest(): number {
    return this.inbound.length;
  }

  get rescheduleBeatPendingForTest(): boolean {
    return this.rescheduleBeat !== null;
  }

  fireHeartbeatForTest(reschedule: (delay: number) => void = () => {}): Promise<void> {
    return this.fireHeartbeat(reschedule);
  }

  /** Test seam: mark that a real inbound has been seen so heartbeats fire
 * (production sets this on the first real user message). */
  primeForHeartbeatTest(): void {
    this.seenRealInbound = true;
  }

  /** The ids of known channels (from the persistent directory). Backs only
 * channel.list's fallback path — both the no-arg and unknown-ref throws
 * in channel now list qualified labels via knownChannels instead. */
  knownChannelIds(): string[] {
    return [CONSOLE_CHANNEL_ID, ...(this.deps.channels?.all() ?? []).map((e) => e.id)];
  }

  /** `name` is the guild-qualified label ('friends-a/lounge'), not the raw
 * channel name — this is what the model should type back into channel. */
  knownChannels(): { id: string; name: string }[] {
    return [{ id: CONSOLE_CHANNEL_ID, name: 'console' }, ...(this.deps.channels?.all() ?? []).map((e) => ({ id: e.id, name: this.qualifiedRef(e) }))];
  }

  /** Record one main-loop completion's cache usage and surface a bust to the
 * console. Called from the turn loop; exposed for tests. The compactor's
 * summarizer calls deliberately never reach here — a one-shot uncached
 * prompt would smear the session ratio. */
  recordCacheUsage(usage: LLMUsage): void {
    if (usage.cached_tokens === undefined) {
 // A previously-supported session going dark is an anomaly (some turns are
 // now silently missing from the accounting), not a capability statement —
 // log it separately from the plain "this endpoint doesn't report it" case.
      const previouslySupported = this.cacheStats.snapshot().supported;
      if (previouslySupported && !this.loggedCacheReportingWentDark) {
        this.loggedCacheReportingWentDark = true;
        this.logger.warn(`[agent] prompt cache reporting went dark | prompt=${usage.prompt_tokens} tokens — a previously-instrumented session stopped reporting cached_tokens; turns from here are missing from the accounting`);
      }
      if (!this.loggedNoCacheCapability) {
        this.loggedNoCacheCapability = true;
 // Only claim the stats are off when they never came on — on a went-dark
 // transition `supported` is already true and the panel is live.
        const tail = previouslySupported ? 'this turn is missing from the accounting' : 'cache stats staying off';
        this.logger.info(`[agent] prompt cache: provider reports no cache data | prompt=${usage.prompt_tokens} tokens — ${tail}`);
      }
    }
    const { busted, rewritten } = this.cacheStats.record(usage);
    if (busted) {
      this.logger.warn(`[agent] prompt cache busted | rewritten=${rewritten} tokens`);
      try { this.deps.console?.cacheBusted(rewritten); } catch { /* observer only */ }
    }
  }

  /** The agent's name, derived from SOUL.md frontmatter (src/store/soul.ts) —
 * read fresh at each use (rare call sites) so a rename takes effect without
 * a restart. Never hardcoded in the harness. */
  private agentName(): string {
    return parseSoul(readFileOr(this.config.paths.soulPath)).name ?? DEFAULT_AGENT_NAME;
  }

  /** Build the system message: SOUL.md hot-read + the boundary views + the
 * participant set. ONE implementation shared by the turn loop (which calls
 * it once per turn, before the retry loop, for prefix-cache stability) and
 * contextSnapshot (the console's context-explorer view) — so what the
 * explorer shows can never drift from what a turn actually sends. */
  private buildMindFrontierMessage(): ChatMessage | null {
    if (!this.deps.mind || !this.mindFrontierAllowedThisTurn || !allowsMindFrontier(this.turnChannelId, this.deps.channels, this.config.discord.guilds)) return null;
    const content = formatMindFrontier(this.deps.mind);
    return content == null ? null : user(content);
  }

  /** Assemble ephemeral request-only context at a recency seam: after stable
 * history but before the current inbound batch. The conversation stays last,
 * while the long provider-cached prefix and autobiographical transcript stay
 * untouched. Idle context snapshots have no inbound batch, so the card is last. */
  private buildRequestMessages(
    systemMessage = this.buildSystemMessage(),
    includeMindFrontier = !this.mindFrontierDeliveredThisTurn,
  ): ChatMessage[] {
    const messages = [systemMessage, ...this.messages];
    if (includeMindFrontier) {
      const mind = this.buildMindFrontierMessage();
      if (mind) {
        const tail = Math.min(this.mindFrontierTailMessagesThisTurn, this.messages.length);
        const insertAt = 1 + this.messages.length - tail;
        messages.splice(insertAt, 0, mind);
      }
    }
    return messages;
  }

  private buildSystemMessage(): ChatMessage {
 // The frontmatter envelope (agent name — src/store/soul.ts) is harness
 // metadata, not identity prose: only the body reaches the prompt.
    const soul = parseSoul(readFileOr(this.config.paths.soulPath)).body;
 // Newest-seen first (the people-injection cap picks the freshest files).
    const participants = Array.from(this.participants, ([authorId, v]) => ({ authorId, author: v.author, lastSeenAt: v.lastSeenAt }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(({ authorId, author }) => ({ authorId, author }));
    const prompt = buildPrompt({
      soul,
      memory: this.memoryView,
      now: this.nowView,
      harnessRoot: this.config.paths.harnessRoot,
      dataDirectory: this.config.paths.dataDirectory,
      participants,
      peopleFiles: this.peopleView,
      fleetEfforts: this.config.fleet?.efforts,
      fleetEnabled: this.config.fleet?.enabled,
      guildCount: this.config.discord.guilds.length,
      externalThinking: this.config.llm.externalThinking,
      extensionPrompt: this.deps.extensionPrompt,
      modules: this.deps.modules,
      profile: this.deps.profile,
    });
    const externalThinkingHint = this.config.llm.externalThinking
      ? `\n\n# Juice: ${externalThinkingJuice(this.config.llm.reasoningEffort)} !important`
      : '';
    return system(prompt + externalThinkingHint);
  }

  /** Console: the request body the next LLM call would send, built on demand —
 * the system message (same builder the turn loop uses, so SOUL.md is
 * hot-read), the one history, and the optional request-only Mind frontier
 * under the same request-assembly diet `complete` applies (`prepareForApi` → `toApiMessage`), plus the
 * model, tool schema, and (when configured) `reasoning_effort`. Read-only:
 * every transform builds fresh objects, the in-memory history is never
 * touched. Harness-only stamps (`channel`, `sends`) are absent from the wire
 * shape by construction (`toApiMessage`).
 *
 * Faithful, with declared exceptions (see docs/console.md): huge inline
 * image payloads are ELIDED (below) so a click on the console can never
 * serialize tens of MB on the agent's event loop; transport fields
 * (`stream`/`stream_options`)
 * message, and a completed-but-not-yet-applied background fold are not
 * reflected. */
  contextSnapshot(): ContextSnapshot {
    const prepared = prepareForApi(this.buildRequestMessages());
    const snap: ContextSnapshot = {
      model: this.config.llm.model,
      tools: activeModelTools(this.config.llm.externalThinking),
      messages: prepared.map((m) => elideLargeImageUrls(toApiMessage(m))),
    };
    if (this.config.llm.externalThinking) snap.reasoning_effort = 'none';
    else if (this.config.llm.reasoningEffort) snap.reasoning_effort = this.config.llm.reasoningEffort;
    return snap;
  }

  /** Console: current context-window accounting for the top-bar meter. */
  usageSnapshot(): UsageInfo {
    const window = this.tracker.maxContextTokens;
    const current = this.tracker.currentTokens;
    return {
      current,
      window,
      trigger: this.effectiveTrigger,
      triggerRatio: window > 0 ? this.effectiveTrigger / window : 0,
      ratio: window > 0 ? current / window : 0,
      prompt: this.lastPromptTokens,
      completion: this.lastCompletionTokens,
      cache: this.cacheStats.snapshot(),
    };
  }

  /** Console: the Rooms rail — every channel that has contributed to the one
 * history, plus the reserved #internal room. Counts come from the live
 * history's per-message `channel` stamp; names from the persistent directory;
 * presence = distinct authors seen in that room. Configured channels (every
 * guild's allowlist) render FIRST, grouped by guild — so an operator can mute
 * a channel before it ever speaks, not only after. Directory-known channels
 * outside the config (legacy / NULL-guild) follow. Returns bare facts, in a
 * fixed deterministic order (configured channels by guild order/sorted id,
 * then directory-only entries, then #internal last) — the console's accent
 * color for the rail is pure presentation and assigned by the hub
 * (console/hub.ts's withColors), not here. */
  roomsSnapshot(): RoomFact[] {
    const counts = new Map<string, number>();
    const authors = new Map<string, Set<string>>();
    for (const m of this.messages) {
      const ch = m.channel ?? INTERNAL_CHANNEL_ID;
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
      if (m.role === 'user') {
        const author = parseEnvelope(m.content).author;
        if (author) {
          if (!authors.has(ch)) authors.set(ch, new Set());
          authors.get(ch)!.add(author);
        }
      }
    }
    const dirEntries = this.deps.channels?.all() ?? [];
    const nameOf = (id: string) => dirEntries.find((e) => e.id === id)?.name ?? id.slice(-6);
    const rooms: RoomFact[] = [];
    for (const g of this.config.discord.guilds) {
      for (const id of Object.keys(g.channels).sort()) {
        rooms.push({
          id, name: nameOf(id),
          count: counts.get(id) ?? 0, presence: authors.get(id)?.size ?? 0,
          group: 'discord', guildSlug: g.slug, tier: g.channels[id],
          muteState: this.deps.mutes?.get(id)?.type ?? null,
        });
      }
    }
    for (const e of dirEntries) {
      if (e.id === CONSOLE_CHANNEL_ID || rooms.some((r) => r.id === e.id)) continue;
      rooms.push({
        id: e.id, name: e.name,
        count: counts.get(e.id) ?? 0, presence: authors.get(e.id)?.size ?? 0,
        group: 'discord', guildSlug: e.guildId ? this.slugForGuildId(e.guildId) : null,
        tier: null, muteState: this.deps.mutes?.get(e.id)?.type ?? null,
      });
    }
    rooms.push({
      id: CONSOLE_CHANNEL_ID,
      name: 'console',
      count: counts.get(CONSOLE_CHANNEL_ID) ?? 0,
      presence: authors.get(CONSOLE_CHANNEL_ID)?.size ?? 0,
      group: 'harness',
      guildSlug: null, tier: null, muteState: null,
    });
    rooms.push({
      id: INTERNAL_CHANNEL_ID,
      name: 'internal',
      count: counts.get(INTERNAL_CHANNEL_ID) ?? 0,
      presence: 0,
      group: 'harness',
      guildSlug: null, tier: null, muteState: null,
    });
    return rooms;
  }

  /** Console: total distinct participants seen (rail footer). */
  participantCount(): number {
    return this.participants.size;
  }

  /** Resolve a channel reference to an id. Accepts a raw id (digits) or a
 * guild-qualified 'slug/name'. A bare name THROWS even when unique —
 * qualification is never optional: guessing wrong here delivers a
 * private message to the wrong friend group. Unknown refs return null (the
 * sandbox layer renders its own throw listing known channels).
 *
 * A raw id resolves when the directory knows it OR when it's in the config
 * allowlist. The allowlist arm matters for a NEWLY-configured server: the
 * directory has exactly one writer (`enqueue`), so a channel that has never
 * carried a message has no row, and without this arm `/mute <new-id>` would
 * answer "unknown channel" for a channel the operator just listed — while
 * the sandbox (which skips resolution for all-digit refs) and the console
 * (which passes a raw id straight to `moderateChannel`) could both already
 * reach it. Qualified `slug/name` genuinely still needs one message first:
 * config carries ids, not names, so there is nothing to match a name
 * against until the channel has been seen. */
  resolveChannelRef(ref: string): string | null {
    const clean = ref.replace(/^#/, '');
    if (clean === CONSOLE_CHANNEL_ID) return CONSOLE_CHANNEL_ID;
 // Raw-id fast path: a single-row lookup, before the full-table read the
 // name-resolution arms below need.
    if (/^\d+$/.test(clean)) {
      return this.deps.channels?.entry(clean) !== undefined || this.guildIndex.byChannel.has(clean) ? clean : null;
    }
    const entries = this.deps.channels?.all() ?? [];
    const slash = clean.indexOf('/');
    if (slash > 0) {
      const slug = clean.slice(0, slash).toLowerCase();
      const name = clean.slice(slash + 1).replace(/^#/, '').toLowerCase();
      const guild = this.guildIndex.bySlug.get(slug);
      if (!guild) return null;
      const hit = entries.find((e) => e.name.toLowerCase() === name && this.guildIdFor(e) === guild.id);
      return hit ? hit.id : null;
    }
    const matches = entries.filter((e) => e.name.toLowerCase() === clean.toLowerCase());
    if (matches.length > 0) {
      const candidates = matches.map((e) => this.qualifiedRef(e)).join(', ');
      throw new Error(`unqualified channel ref '${clean}'. Use one of: ${candidates}`);
    }
    return null;
  }

  /** A directory row's guild, falling back to config when the row hasn't
 * healed yet. Config is the authority on which guild a CONFIGURED channel
 * belongs to (channel keys are raw Discord ids, the allowlist is
 * exhaustive, so the mapping is deterministic and unambiguous regardless of
 * how many guilds are configured) — the DB column is authoritative only for
 * a channel that's since been removed from config, which correctly stays
 * unaddressable by qualified name once its row goes stale. Without this
 * fallback, a multi-guild deploy leaves every pre-upgrade NULL-guild row
 * dead until that channel next receives inbound traffic to heal it — exactly
 * backwards for reaching out to a room that's been quiet. */
  private guildIdFor(e: { id: string; guildId: string | null }): string | null {
    return e.guildId ?? this.guildIndex.byChannel.get(e.id)?.guild.id ?? null;
  }

  /** 'friends-a/lounge' for a known guild, else the raw id (NULL-guild legacy rows
 * for channels no longer in config). */
  private qualifiedRef(e: { id: string; name: string; guildId: string | null }): string {
    const slug = this.slugForGuildId(this.guildIdFor(e));
    return slug ? `${slug}/${e.name}` : e.id;
  }
  private slugForGuildId(guildId: string | null): string | null {
    return guildId ? this.guildIndex.byGuildId.get(guildId)?.slug ?? null : null;
  }
  /** A channel's guild slug, for stamping `lastSendAt`. Checks the
 * configured allowlist first (`guildIndex.byChannel`); a THREAD's own
 * channel id is never in that allowlist (threads inherit their parent's
 * policy — see `resolvePolicyChannelId` in discord.ts), so it falls back to
 * the persistent channel directory's `guildOf`, which is stamped with the
 * real guild id off the inbound message itself (not the allowlist) and so
 * covers threads too — a send into a thread must still count as having
 * spoken in that guild, or thread activity would look like silence. */
  private slugForChannel(channelId: string): string | null {
    const policy = this.guildIndex.byChannel.get(channelId);
    if (policy) return policy.guild.slug;
    const gid = this.deps.channels?.guildOf(channelId) ?? null;
    return gid ? this.slugForGuildId(gid) : null;
  }
  /** True when the agent has no room to speak in this guild: every configured
 * channel currently has a mute row (self or operator), OR the guild has no
 * configured channels at all — `ids.every(...)` is vacuously true on an
 * empty array, which is the outcome we want here (a channel-less guild is
 * no more speakable-into than a fully-muted one). Such a guild is omitted
 * from the digest's quiet block and never nudged — prompting outreach to a
 * room the agent is structurally unable to speak in would be taunting, not
 * caring. An unknown slug (stale/removed from config) reports false, not
 * muted. */
  private guildFullyMuted(slug: string): boolean {
    const g = this.guildIndex.bySlug.get(slug);
    if (!g) return false;
    const ids = Object.keys(g.channels);
    return ids.every((id) => this.deps.mutes?.get(id) != null);
  }
  /** Guilds by outbound silence, longest first, with a fully-muted guild
 * omitted. Shared by the heartbeat digest's quiet block and the social
 * nudge so the two never drift apart on which guilds count. */
  private silentGuilds(): { slug: string; ms: number }[] {
    const now = Date.now();
    return [...this.lastSendAt.entries()]
      .filter(([slug]) => !this.guildFullyMuted(slug))
      .map(([slug, at]) => ({ slug, ms: now - at }))
      .sort((a, b) => b.ms - a.ms);
  }
  /** Display label for echoes/notices: 'friends-a/lounge' or '#name' (legacy
 * NULL-guild row for a channel no longer in config) or the raw id (unknown
 * channel) — callers wrap in '(id)'. The qualified form is deliberately
 * spelled exactly like the ref `elpis.channel` accepts, so a label read
 * out of a notice can be pasted straight back in; the legacy unqualified
 * form keeps its '#' precisely because a bare name is NOT a usable ref. */
  qualifiedChannelLabel(channelId: string): string {
    if (channelId === CONSOLE_CHANNEL_ID) return 'console';
    const e = this.deps.channels?.entry(channelId);
    if (!e) return channelId;
    const slug = this.slugForGuildId(this.guildIdFor(e));
    return slug ? `${slug}/${e.name}` : `#${e.name}`;
  }

  private get config() { return this.deps.config; }
  private get llm() { return this.deps.llm; }
  private get sandbox() { return this.deps.sandbox; }
  private get tracker() { return this.deps.tracker; }
  private get compactor() { return this.deps.compactor; }
  private get density() { return this.deps.density; }
  private get logger() { return this.deps.config.logger; }
}

function system(content: string): ChatMessage {
  return { role: 'system', content };
}

function user(content: string): ChatMessage {
  return { role: 'user', content };
}

/** Above this many chars, an inline image payload (`image_url` data URI) in a
 * contextSnapshot message is elided down to a marked head. A watch frame or
 * inbound image attachment can carry ~10MB of base64 per part; serializing
 * that synchronously (JSON.stringify + a ws frame) on the agent's event loop
 * for a console display that abbreviates it anyway is pure hazard. Generous
 * enough that any text-bearing part passes through untouched. */
const CONTEXT_IMAGE_URL_ELIDE_CHARS = 8192;

/** Elide huge inline image payloads out of a wire-shape message before the
 * snapshot crosses the console socket. MUST build fresh objects: toApiMessage
 * shares the live `contentParts` array with the in-memory history, so an
 * in-place edit here would corrupt what the next real call sends. The marker
 * is honest about what was dropped. Exported for direct unit testing. */
export function elideLargeImageUrls(msg: OpenAI.ChatCompletionMessageParam): OpenAI.ChatCompletionMessageParam {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return msg;
  let changed = false;
  const parts = content.map((p) => {
    const url = (p as { image_url?: { url?: unknown } })?.image_url?.url;
    if (typeof url !== 'string' || url.length <= CONTEXT_IMAGE_URL_ELIDE_CHARS) return p;
    changed = true;
    return {
      ...p,
      image_url: {
        ...(p as { image_url: object }).image_url,
        url: `${url.slice(0, 64)}…[elided by contextSnapshot: ${url.length} chars total — the API receives this in full; only the console serialization drops it]`,
      },
    };
  });
  return changed ? ({ ...msg, content: parts } as OpenAI.ChatCompletionMessageParam) : msg;
}

/** Read a file to a string, degrading to '' on any error. Backs the fresh
 * hot-reload reads of SOUL.md (every turn) and NOW.md (boundary refresh). */
function readFileOr(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}
