// console/hub.ts — the pub/sub core of the operator console (Elpis Console).
//
// The console mirrors the one monocontext history and exposes a deliberately
// bounded operator-write surface (chat, Mind, moderation). The agent, LLM stream,
// compactor, and logger push events in; the hub fans them out to every connected WebSocket
// client and answers backfill requests. There is exactly ONE socket per client
// (served at /ws by server.ts) multiplexing three views (rooms, stream, log).
//
// DISPLAY MODEL (append-only mirror): the hub keeps its own append-only `mirror`
// of serialized stream entries — every message the agent pushes, plus inline
// compaction dividers. Unlike the agent's in-memory history (which the compactor
// rebuilds from the front), the mirror is never rewritten, so entry ids are
// stable array indices forever. That makes backfill trivial (slice by id) and
// lets the client key rendered nodes by id without dupes. Compaction shows as a
// divider entry inserted in chronological order — folded messages STAY visible
// (the operator keeps the full record); the summary is context-only.
//
// Deep scroll-back below the mirror's oldest entry (history that predates this
// process, from rotated transcript files on disk) is served lazily by
// history.ts, keyed by negative ids so it always sorts before the live mirror.

import type { ChatMessage } from '../llm/llm.js';
import { parseEnvelope } from '../lib/envelope.js';
import type { LogLevel } from '../lib/log.js';
import type { ProviderUsageSnapshot } from '../llm/usage-tracker.js';
import type { CacheInfo } from '../llm/cache-stats.js';
import { parseMindId, type MindKind, type MindService, type MindStatus } from '../store/mind.js';

/** A room (Discord channel or the reserved #internal), as the agent reports
 * it — everything except the rail's accent color, which is pure presentation
 * and assigned here in the hub (see `withColors` below), not by the agent. */
export interface RoomFact {
  id: string;
  name: string;
  count: number;
  presence: number;
  group: 'discord' | 'harness';
  /** The configured guild's slug, or null for the internal room / an
 * unconfigured (legacy, NULL-guild) directory channel. */
  guildSlug: string | null;
  /** The channel's effective receive mode, or null when unconfigured / internal. */
  tier: 'drop' | 'direct' | 'social' | 'quiet' | null;
  /** Whether configuration permits outbound messages before runtime mute state. */
  allowSend: boolean;
  /** Which configuration layer denies send, or null when configuration allows it. */
  sendDeniedBy: 'guild' | 'channel' | 'default' | null;
  /** The killswitch state, or null when neither muted nor deafened. */
  muteState: 'mute' | 'deafen' | null;
}

/** A room as the rail renders it — a `RoomFact` plus its assigned accent color. */
export interface RoomInfo extends RoomFact {
  color: string;
}

/** The rail's accent-color palette, cycled in array order across rooms other
 * than #internal (see withColors). */
const ROOM_PALETTE = ['gold', 'sky', 'rose', 'violet', 'amber'];

/** Assign the rail's accent-color palette to room facts, in array order —
 * pure presentation, so it lives here rather than in agent.ts's
 * roomsSnapshot. Configured-guild channels then directory-only channels
 * cycle the palette in the order the agent already returns them (fixed guild
 * order, ids sorted within a guild for the former; the directory's own row
 * order for the latter); the reserved #internal room (group 'harness') is
 * always green rather than consuming a palette slot. Mirrors the prior
 * inline agent.ts logic byte-for-byte. */
export function withColors(rooms: RoomFact[]): RoomInfo[] {
  let i = 0;
  return rooms.map((r) => ({
    ...r,
    color: r.group === 'harness' ? 'green' : ROOM_PALETTE[i++ % ROOM_PALETTE.length],
  }));
}

/** Current context-window accounting for the top-bar meter. */
export interface UsageInfo {
  current: number;
  window: number;
  /** Absolute token count at which compaction begins (effective trigger). */
  trigger: number;
  /** trigger / window — where the amber compaction tick sits on the meter. */
  triggerRatio: number;
  ratio: number;
  prompt: number;
  completion: number;
  /** Prompt-cache accounting for the rail panel. Nested here rather than given
 * its own frame: the `usage` frame + connect snapshot already carry UsageInfo
 * and already refresh on every message append. */
  cache: CacheInfo;
}

/** The exact API request body the next turn would send, as built on demand by
 * `Agent.contextSnapshot` for the context-explorer view: model + tool schema
 * + the dieted message array (system message first), every message already in
 * wire shape (`toApiMessage` — no harness-only `channel`/`sends` stamps).
 * `reasoning_effort` appears only when the endpoint is configured for it.
 * The hub treats the contents as opaque — it serializes, never interprets. */
export interface ContextSnapshot {
  model: string;
  reasoning_effort?: string;
  tools: unknown[];
  messages: unknown[];
}

/** Static-ish header metadata (git hash, uptime, model, bot tag). */
export interface MetaInfo {
  gitHash: string;
  treeClean: boolean;
  uptimeMs: number;
  model: string;
  botTag: string;
}

export interface LogLine {
  ts: number;
  level: Exclude<LogLevel, 'silent'>;
  msg: string;
}

/** One serialized stream entry as the client renders it. `id` is the stable
 * append-only index (negative for on-disk archived backfill). */
export interface StreamEntry {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'think-result' | 'summary' | 'notice' | 'system' | 'compaction' | 'cleared' | 'cachebust' | 'endnudge';
  role: string;
  channel: string;
  content: string;
  reasoning_content?: string;
  /** For assistant turns: executable run calls remain action cards. */
  toolCalls?: { id: string; code: string }[];
  tool_call_id?: string;
  sends?: { channel: string; text: string }[];
  /** Author + display fields parsed from a user envelope, when present. */
  author?: string;
  /** Epoch ms; live entries are stamped now, historical ones parsed from the
 * envelope `(ISO)` header when available, else null. */
  ts: number | null;
  /** Compaction dividers carry the folded count. */
  replaced?: number;
  /** Cache-bust dividers carry the rewritten (lost-prefix) token count. */
  rewritten?: number;
  /** End-nudge dividers carry the consecutive nudge count. */
  count?: number;
}

/** Accessors the hub reads on demand (wired by index.ts from the live agent). */
export interface HubSources {
  usage: () => UsageInfo;
  rooms: () => RoomFact[];
  /** Total distinct participants seen (rail footer). */
  participants: () => number;
  meta: () => Promise<MetaInfo> | MetaInfo;
  /** Read a page of archived (pre-process, on-disk) history strictly older than
 * the mirror's oldest live entry. `beforeArchivedId` is the negative id the
 * client last received (or 0 for the first archived page). */
  archived: (beforeArchivedId: number, limit: number) => StreamEntry[];
  /** Provider subscription-usage snapshot (rail bars); null when inactive. */
  subUsage: () => ProviderUsageSnapshot | null;
  /** The current context window as the next LLM call would send it (the
 * context-explorer view). On-demand and read-only, like the other sources;
 * absent when unwired (the op then answers with context: null). */
  context?: () => ContextSnapshot;
  /** The console's write operation: the killswitch, delegated to
 * Agent.moderateChannel with actor 'operator'. Absent when moderation isn't
 * wired (e.g. no mute store) — the op handler then no-ops. */
  moderate?: (channelId: string, action: 'mute' | 'deafen' | 'unmute' | 'undeafen', reason?: string) => { ok: boolean; note: string };
  /** Durable dependency-aware work graph. Unlike the conversation mirror this
 * is intentionally mutable through same-origin console operations. */
  mind?: MindService;
  /** Enqueue operator-authored console speech into the one agent history. */
  chat?: (input: { nonce: string; content: string }) => { ok: boolean; note: string };
}

/** Minimal shape of a connected client the hub talks to (a ws.WebSocket). */
export interface HubClient {
  send(data: string): void;
  readonly closed: boolean;
}

const LOG_RING_CAP = 600;
const SNAPSHOT_MESSAGES = 60;
const BACKFILL_PAGE = 40;
/** Context-explorer requests inside this window are answered from the last
 * built snapshot instead of rebuilding (see sendContext). */
const CONTEXT_THROTTLE_MS = 1000;
/** Bounded in-RAM mirror. Entry ids are MONOTONIC (never array indices), so
 * eviction from the front keeps ids stable and backfill math simple. Beyond this
 * many entries the oldest in-session entries drop out of RAM (still on disk /
 * journald); pre-boot history stays reachable via the archived reader. 5000
 * covers any realistic single-session run while bounding memory for a service
 * meant to run for weeks. */
const MIRROR_CAP = 5000;

export class ConsoleHub {
  private mirror: StreamEntry[] = [];
  /** Monotonic entry-id counter (survives eviction — ids are stable forever). */
  private nextId = 0;
  private logs: LogLine[] = [];
  private clients = new Set<HubClient>();
  private sources: HubSources | null = null;
  /** Monotonic id for the active streaming turn (one at a time — the loop is
 * serial). Bumped at each stream start. */
  private streamId = 0;
  private streamActive = false;
  private streamContent = '';
  private streamReasoning = '';
  /** Tool call ids whose fixed separator results are cognition plumbing, not Thread entries. */
  private thinkCallIds = new Set<string>();
  private chatNonces = new Set<string>();
  private chatNonceOrder: string[] = [];

  constructor(initial: ChatMessage[] = []) {
    for (const m of initial) this.pushEntry(this.serialize(m, 0, null));
  }

  /** Append a serialized entry with the next monotonic id, evicting the oldest
 * when the mirror exceeds MIRROR_CAP. Overwrites the entry's id. Returns it. */
  private pushEntry(entry: StreamEntry): StreamEntry {
    entry.id = this.nextId++;
    this.mirror.push(entry);
    if (this.mirror.length > MIRROR_CAP) this.mirror.shift();
    return entry;
  }

  /** The id of the mirror's oldest retained entry (or nextId when empty). */
  private mirrorBase(): number {
    return this.mirror.length > 0 ? this.mirror[0].id : this.nextId;
  }

  /** Whether any pre-boot archived history exists (cheap 1-item probe). */
  private archivedAny(): boolean {
    try { return (this.sources?.archived(0, 1).length ?? 0) > 0; } catch { return false; }
  }

  attach(sources: HubSources): void {
    this.sources = sources;
  }

 // ---- inbound events (from agent / llm / logger) ----

  /** A message was pushed to the one history. Mirror + broadcast. */
  messageAppended(msg: ChatMessage): void {
    const entry = this.pushEntry(this.serialize(msg, 0, Date.now()));
    this.lastContext = null;
    this.broadcast({ t: 'message', msg: entry });
 // A completed pair / new content changes the fill + per-room counts; refresh
 // both so the meter and the Rooms rail don't go stale between inbound drains.
    this.usageChanged();
    this.roomsChanged();
  }

  /** A compaction cycle just applied — insert an inline divider and refresh the
 * meter (the fold dropped real context). Folded messages stay visible. */
  compactionApplied(replaced: number): void {
    const entry = this.pushEntry({
      id: 0, kind: 'compaction', role: 'system', channel: 'internal',
      content: '', ts: Date.now(), replaced,
    });
    this.lastContext = null;
    this.broadcast({ t: 'message', msg: entry });
    this.usageChanged();
  }

  /** A turn lost cached prefix — insert an inline divider so the operator can see
 * which turn paid for it. Same idiom as compactionApplied: mirror-only (never
 * transcript-persisted), so busts do not survive a restart or appear in
 * archived backfill. Does NOT refresh the meter — no context was added. */
  cacheBusted(rewritten: number): void {
    const entry = this.pushEntry({
      id: 0, kind: 'cachebust', role: 'system', channel: 'internal',
      content: '', ts: Date.now(), rewritten,
    });
    this.broadcast({ t: 'message', msg: entry });
  }

  /** The model returned a response with no run call and was nudged. Mirror-only,
 * same idiom as cacheBusted: never transcript-persisted, so it does not appear
 * in archived backfill. Does NOT refresh the meter. */
  endNudge(count: number): void {
    const entry = this.pushEntry({
      id: 0, kind: 'endnudge', role: 'system', channel: 'internal',
      content: '', ts: Date.now(), count,
    });
    this.broadcast({ t: 'message', msg: entry });
  }

  /** The one history was wiped (/clear, /new). Insert a "context cleared" divider
 * so the operator's view stays honest (rail counts drop to zero); the mirror
 * keeps the prior entries visible above the divider as an archaeological tail. */
  contextCleared(): void {
    const entry = this.pushEntry({
      id: 0, kind: 'cleared', role: 'system', channel: 'internal',
      content: '', ts: Date.now(),
    });
    this.lastContext = null;
    this.broadcast({ t: 'message', msg: entry });
    this.usageChanged();
    this.roomsChanged();
  }

  compactionStarted(tokens: number): void {
    this.broadcast({ t: 'compaction', phase: 'started', tokens, at: Date.now() });
  }

  /** The channel the current turn streams into — set by the agent before each
 * LLM call so the LLM can push deltas without knowing Discord provenance. */
  private streamChannel = 'internal';
  setStreamChannel(channel: string): void {
    this.streamChannel = channel || 'internal';
  }

  /** Begin the live streaming bubble. Bumps the
 * stream id so the client discards any partial from a prior attempt. */
  streamStart(): void {
    this.streamId++;
    this.streamActive = true;
    this.streamContent = '';
    this.streamReasoning = '';
    this.broadcast({ t: 'streamStart', streamId: this.streamId, channel: this.streamChannel });
  }

  /** Streaming assistant delta (content or reasoning). Best-effort — the LLM path
 * guards the call, so a broken client never interrupts generation. */
  streamDelta(kind: 'content' | 'reasoning', text: string): void {
    if (!text) return;
    if (kind === 'content') this.streamContent += text;
    else this.streamReasoning += text;
    this.broadcast({ t: 'delta', streamId: this.streamId, channel: this.streamChannel, kind, text });
  }

  /** The streamed turn finished (naturally, aborted, or errored). Lets the client
 * drop a dangling "streaming…" bubble even when no assistant message follows
 * (e.g. a terminal LLM error). Emitted from a `finally` in the LLM path. */
  streamEnd(): void {
    this.streamActive = false;
    this.streamContent = '';
    this.streamReasoning = '';
    this.broadcast({ t: 'streamEnd', streamId: this.streamId });
  }

  /** Context usage changed (after an authoritative completion or a compaction).
 * With no connected clients there's no one to render the meter for — skip
 * the source snapshot (`sources.usage` can walk agent state) as well as
 * the broadcast; a later-connecting client gets a correct usage figure from
 * `sendSnapshot`, which calls `sources.usage` itself. */
  usageChanged(): void {
    if (!this.sources || this.clients.size === 0) return;
    this.broadcast({ t: 'usage', usage: this.sources.usage() });
  }

  /** The provider subscription-usage snapshot changed (a poll completed). Same
 * zero-client skip as usageChanged — a later-connecting client's snapshot
 * calls `sources.subUsage` directly. */
  subUsageChanged(): void {
    if (!this.sources || this.clients.size === 0) return;
    this.broadcast({ t: 'subUsage', usage: this.sources.subUsage() });
  }

  /** Same zero-client skip: `sources.rooms()`/`sources.participants()` are the
 * cost, and a later-connecting client's snapshot recomputes them fresh. */
  roomsChanged(): void {
    if (!this.sources || this.clients.size === 0) return;
    this.broadcast({ t: 'rooms', rooms: withColors(this.sources.rooms()), participants: this.sources.participants() });
  }

  logLine(level: Exclude<LogLevel, 'silent'>, msg: string): void {
    const line: LogLine = { ts: Date.now(), level, msg };
    this.logs.push(line);
    if (this.logs.length > LOG_RING_CAP) this.logs.shift();
    this.broadcast({ t: 'log', line });
  }

 // ---- client lifecycle ----

  async addClient(client: HubClient): Promise<void> {
    this.clients.add(client);
    await this.sendSnapshot(client);
  }

  removeClient(client: HubClient): void {
    this.clients.delete(client);
  }

  /** Handle a client→server frame: backfill requests, or the ONE write op
 * (`moderate`, ). */
  handleClientMessage(client: HubClient, raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'backfill') this.sendBackfill(client, m);
    if (m.t === 'moderate') this.handleModerate(client, m);
    if (m.t === 'context') this.sendContext(client, m);
    if (m.t === 'mind') this.handleMind(client, m);
    if (m.t === 'chat') this.handleChat(client, m);
  }

  private handleChat(client: HubClient, m: { nonce?: unknown; content?: unknown }): void {
    const nonce = typeof m.nonce === 'string' ? m.nonce : '';
    const content = typeof m.content === 'string' ? m.content : '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)) {
      this.safeSend(client, { t: 'chatResult', nonce, ok: false, note: 'invalid message nonce' });
      return;
    }
    if (!content.trim()) {
      this.safeSend(client, { t: 'chatResult', nonce, ok: false, note: 'message is empty' });
      return;
    }
    if (Buffer.byteLength(content, 'utf8') > 32768) {
      this.safeSend(client, { t: 'chatResult', nonce, ok: false, note: 'message exceeds 32 KiB' });
      return;
    }
    if (this.chatNonces.has(nonce)) {
      this.safeSend(client, { t: 'chatResult', nonce, ok: true, note: 'message already accepted' });
      return;
    }
    if (!this.sources?.chat) {
      this.safeSend(client, { t: 'chatResult', nonce, ok: false, note: 'console chat unavailable' });
      return;
    }
    try {
      const result = this.sources.chat({ nonce, content });
      if (result.ok) {
        this.chatNonces.add(nonce);
        this.chatNonceOrder.push(nonce);
        if (this.chatNonceOrder.length > 500) {
          const oldest = this.chatNonceOrder.shift();
          if (oldest) this.chatNonces.delete(oldest);
        }
      }
      this.safeSend(client, { t: 'chatResult', nonce, ...result });
    } catch (error) {
      this.safeSend(client, { t: 'chatResult', nonce, ok: false, note: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The most recent context snapshot + when it was built — the CONTEXT_THROTTLE_MS
 * cache. Unlike backfill (bounded by page size), a context build walks the
 * whole history and reads SOUL.md synchronously on the agent's event loop, and
 * the SPA auto-refires the request on every reconnect while the explorer is
 * open — so a flapping socket must not amplify into a build per flap. */
  private lastContext: { at: number; context: ContextSnapshot | null } | null = null;

  /** Answer a context-explorer request with the current context window as the
 * next LLM call would send it. Pure read (request/response on this socket,
 * like backfill — the view refreshes on demand, not via broadcast). The
 * source walks live agent state and reads SOUL.md, so a failure degrades to
 * `context: null` rather than ever reaching the loop; requests within
 * CONTEXT_THROTTLE_MS of the last build are answered from that build. */
  private sendContext(client: HubClient, req: { reqId?: number }): void {
    const now = Date.now();
    let context: ContextSnapshot | null;
    if (this.lastContext && now - this.lastContext.at < CONTEXT_THROTTLE_MS) {
      context = this.lastContext.context;
    } else {
      try { context = this.sources?.context?.() ?? null; } catch { context = null; }
      this.lastContext = { at: now, context };
    }
    this.safeSend(client, { t: 'context', reqId: req.reqId ?? 0, context });
  }

  /** The console's write operation: killswitch moderation, delegated to
 * the same Agent.moderateChannel the slash commands use. Everything else on
 * this socket remains observation. */
  private handleModerate(client: HubClient, m: { channelId?: unknown; action?: unknown; reason?: unknown }): void {
    const ACTIONS = ['mute', 'deafen', 'unmute', 'undeafen'] as const;
    const action = ACTIONS.find((a) => a === m.action);
 // A malformed frame (unknown action, missing/non-string channelId) stays
 // silent — the client sent garbage, not a real request. Moderation being
 // unwired is different: it's a well-formed request the operator sent
 // through a live button, so it gets a reply (Fix 4).
    if (!action || typeof m.channelId !== 'string') return;
    if (!this.sources?.moderate) {
      this.safeSend(client, { t: 'moderateResult', ok: false, note: 'moderation unavailable' });
      return;
    }
    const reason = typeof m.reason === 'string' && m.reason !== '' ? m.reason : undefined;
    const r = this.sources.moderate(m.channelId, action, reason);
    this.safeSend(client, { t: 'moderateResult', ok: r.ok, note: r.note });
 // No roomsChanged here: Agent.moderateChannel already broadcasts on a
 // successful transition, and a refused one changed nothing.
  }

  /** Broadcast the authoritative work-graph list after any adapter mutates it. */
  mindChanged(): void {
    if (!this.sources?.mind || this.clients.size === 0) return;
    this.broadcast(this.mindSnapshotPayload());
  }

  private mindSnapshotPayload(reqId = 0): Record<string, unknown> {
    const mind = this.sources?.mind;
    if (!mind) return { t: 'mindSnapshot', reqId, available: false, stats: null, items: [] };
    try {
      return { t: 'mindSnapshot', reqId, available: true, stats: mind.stats(), items: mind.list({ includeArchived: true, limit: 500 }) };
    } catch (error) {
      return { t: 'mindSnapshot', reqId, available: false, stats: null, items: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private handleMind(client: HubClient, m: Record<string, unknown>): void {
    const mind = this.sources?.mind;
    const reqId = typeof m.reqId === 'number' ? m.reqId : 0;
    const op = typeof m.op === 'string' ? m.op : '';
    if (!mind) { this.safeSend(client, { t: 'mindResult', reqId, op, ok: false, error: 'mind unavailable' }); return; }
    try {
      if (op === 'snapshot') { this.safeSend(client, this.mindSnapshotPayload(reqId)); return; }
      if (op === 'get') {
        const item = mind.get(parseMindId(m.id));
        if (!item) throw new Error(`no item #${parseMindId(m.id)}`);
        this.safeSend(client, { t: 'mindDetail', reqId, item });
        return;
      }
      let result: unknown;
      if (op === 'create') {
        const item = typeof m.item === 'object' && m.item !== null ? m.item as Record<string, unknown> : {};
        result = mind.create({
          title: item.title as string, body: item.body as string | undefined, kind: item.kind as MindKind | undefined,
          status: item.status as MindStatus | undefined, priority: item.priority as number | undefined,
          parentId: item.parentId == null ? null : parseMindId(item.parentId),
          dueAt: item.dueAt == null ? null : Number(item.dueAt),
          tags: Array.isArray(item.tags) ? item.tags.map(String) : undefined,
          dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(parseMindId) : undefined,
          remindAt: item.remindAt == null ? null : Number(item.remindAt),
          reminderChannelId: typeof item.channelId === 'string' ? item.channelId : null,
          actor: 'console',
        });
      } else if (op === 'update') {
        const patch = typeof m.patch === 'object' && m.patch !== null ? m.patch as Record<string, unknown> : {};
        result = mind.update(parseMindId(m.id), {
          ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
          ...(patch.body !== undefined ? { body: String(patch.body) } : {}),
          ...(patch.kind !== undefined ? { kind: patch.kind as MindKind } : {}),
          ...(patch.status !== undefined ? { status: patch.status as MindStatus } : {}),
          ...(patch.priority !== undefined ? { priority: Number(patch.priority) } : {}),
          ...(patch.parentId !== undefined ? { parentId: patch.parentId == null ? null : parseMindId(patch.parentId) } : {}),
          ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt == null ? null : Number(patch.dueAt) } : {}),
          ...(patch.tags !== undefined ? { tags: Array.isArray(patch.tags) ? patch.tags.map(String) : [] } : {}),
        }, 'console');
      } else if (op === 'status') result = mind.setStatus(parseMindId(m.id), String(m.status) as MindStatus, 'console');
      else if (op === 'archive') result = mind.archive(parseMindId(m.id), 'console');
      else if (op === 'restore') result = mind.restore(parseMindId(m.id), 'console');
      else if (op === 'comment') result = mind.addComment(parseMindId(m.id), String(m.body ?? ''), 'console');
      else if (op === 'updateComment') result = mind.updateComment(Number(m.commentId), String(m.body ?? ''), 'console');
      else if (op === 'deleteComment') result = mind.deleteComment(Number(m.commentId), 'console');
      else if (op === 'link') result = mind.addDependency(parseMindId(m.id), parseMindId(m.dependsOn), 'console');
      else if (op === 'unlink') result = mind.removeDependency(parseMindId(m.id), parseMindId(m.dependsOn), 'console');
      else if (op === 'remind') result = mind.addReminder(parseMindId(m.id), Number(m.at), 'console', typeof m.channelId === 'string' ? m.channelId : null);
      else if (op === 'snoozeReminder') result = mind.snoozeReminder(Number(m.reminderId), Number(m.at), 'console');
      else if (op === 'cancelReminder') result = mind.cancelReminder(Number(m.reminderId), 'console');
      else if (op === 'graph') result = mind.graph(parseMindId(m.id), typeof m.depth === 'number' ? m.depth : undefined);
      else throw new Error(`unknown mind operation ${JSON.stringify(op)}`);
      this.safeSend(client, { t: 'mindResult', reqId, op, ok: true, result });
    } catch (error) {
      this.safeSend(client, { t: 'mindResult', reqId, op, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

 // ---- snapshot + backfill ----

  private async sendSnapshot(client: HubClient): Promise<void> {
    const start = Math.max(0, this.mirror.length - SNAPSHOT_MESSAGES);
    const messages = this.mirror.slice(start);
    let meta: MetaInfo | null = null;
    try { meta = this.sources ? await this.sources.meta() : null; } catch { meta = null; }
    this.safeSend(client, {
      t: 'snapshot',
      usage: this.sources?.usage() ?? null,
      subUsage: this.sources?.subUsage() ?? null,
      rooms: withColors(this.sources?.rooms() ?? []),
      participants: this.sources?.participants() ?? 0,
      meta,
      messages,
      stream: this.streamActive ? {
        streamId: this.streamId, channel: this.streamChannel,
        content: this.streamContent, reasoning: this.streamReasoning,
      } : null,
      oldestId: messages.length > 0 ? messages[0].id : this.nextId,
 // hasMore reflects BOTH earlier mirror entries AND on-disk archived history,
 // so a small mirror (e.g. right after a restart) still offers scroll-back.
      hasMore: start > 0 || this.archivedAny(),
      logs: this.logs,
      mind: this.sources?.mind ? this.mindSnapshotPayload() : null,
    });
  }

  private sendBackfill(client: HubClient, req: { reqId?: number; beforeId?: number }): void {
    const base = this.mirrorBase();
    const beforeId = typeof req.beforeId === 'number' ? req.beforeId : this.nextId;
    let messages: StreamEntry[];
    let oldestId: number;
    let hasMore: boolean;
    if (beforeId > base) {
 // Inside the retained mirror. ids are monotonic; map id → array position
 // via the base offset (eviction shifts the base, not the ids).
      const end = Math.min(beforeId - base, this.mirror.length);
      const start = Math.max(0, end - BACKFILL_PAGE);
      messages = this.mirror.slice(start, end);
      oldestId = messages.length > 0 ? messages[0].id : beforeId;
      hasMore = start > 0 || this.archivedAny();
    } else {
 // At/below the retained window: page into on-disk archived history (negative
 // ids). A positive beforeId here means the caller reached the mirror's base
 // (or an evicted gap) — start from the newest archived page (arg 0).
      const archBefore = beforeId <= 0 ? beforeId : 0;
      messages = this.sources?.archived(archBefore, BACKFILL_PAGE) ?? [];
      oldestId = messages.length > 0 ? messages[0].id : beforeId;
      hasMore = messages.length === BACKFILL_PAGE;
    }
    this.safeSend(client, { t: 'history', reqId: req.reqId ?? 0, messages, oldestId, hasMore });
  }

  private serialize(msg: ChatMessage, id: number, ts: number | null): StreamEntry {
    const entry = serializeMessage(msg, id, ts);
    for (const call of msg.tool_calls ?? []) {
      if (call.function.name === 'think') this.thinkCallIds.add(call.id);
    }
    if (msg.role === 'tool' && msg.tool_call_id && this.thinkCallIds.delete(msg.tool_call_id)) {
      entry.kind = 'think-result';
    }
    return entry;
  }

 // ---- fan-out ----

  private broadcast(payload: unknown): void {
 // Nothing to fan out to and no fan-out state to update (the loop below
 // only ever prunes disconnected clients out of `clients`, which is already
 // empty) — skip serializing the payload. Every caller's own state that
 // must keep advancing regardless of clients (mirror entries, `nextId`, the
 // log ring, `streamId`) is updated by the caller BEFORE it calls broadcast,
 // so this early return never skips anything besides the wire write.
    if (this.clients.size === 0) return;
    const data = JSON.stringify(payload);
    for (const c of this.clients) {
      if (c.closed) { this.clients.delete(c); continue; }
      try { c.send(data); } catch { this.clients.delete(c); }
    }
  }

  private safeSend(client: HubClient, payload: unknown): void {
    try { client.send(JSON.stringify(payload)); } catch { this.clients.delete(client); }
  }
}

const SUMMARY_PREFIX = '=== Summary of earlier conversation';
const NOTICE_MARK = '[harness: context compacted';

/** Serialize one ChatMessage into a StreamEntry with a fixed id + timestamp.
 * Shared by the live mirror and the on-disk archived reader (history.ts). */
export function serializeMessage(msg: ChatMessage, id: number, ts: number | null): StreamEntry {
  const kind = classifyMessage(msg);
  const entry: StreamEntry = {
    id, kind, role: msg.role, channel: msg.channel ?? 'internal',
    content: msg.content ?? '', ts,
  };
  const thoughtParts: string[] = [];
  if (msg.reasoning_content) thoughtParts.push(msg.reasoning_content);
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const runCalls: { id: string; code: string }[] = [];
    for (const tc of msg.tool_calls) {
      if (tc.function.name === 'think') {
        try {
          const parsed = JSON.parse(tc.function.arguments || '{}') as { thoughts?: unknown };
          if (typeof parsed.thoughts === 'string' && parsed.thoughts) thoughtParts.push(parsed.thoughts);
        } catch { /* malformed args remain absent; sanitizer normally rejects them */ }
      } else if (tc.function.name === 'run') {
        runCalls.push({ id: tc.id, code: extractCode(tc.function.arguments) });
      }
    }
    if (runCalls.length > 0) entry.toolCalls = runCalls;
  }
  if (thoughtParts.length > 0) entry.reasoning_content = thoughtParts.join('\n\n');
  if (msg.tool_call_id) entry.tool_call_id = msg.tool_call_id;
  if (msg.sends && msg.sends.length > 0) entry.sends = msg.sends;
  if (msg.role === 'user') {
    const parsed = parseEnvelope(msg.content);
    if (parsed.author) entry.author = parsed.author;
    if (ts === null && parsed.ts !== null) entry.ts = parsed.ts;
  }
  return entry;
}

/** Classify a ChatMessage into a render kind. */
export function classifyMessage(msg: ChatMessage): StreamEntry['kind'] {
  if (msg.role === 'tool') return 'tool';
  if (msg.role === 'assistant') return 'assistant';
  if (msg.role === 'system') {
    return msg.content.startsWith(SUMMARY_PREFIX) ? 'summary' : 'system';
  }
 // user
  if (msg.content.startsWith(NOTICE_MARK)) return 'notice';
  return 'user';
}

/** Pull `code` out of a tool call's JSON arguments string; tolerant of malformed
 * JSON (returns the raw string as a fallback so the operator still sees it). */
export function extractCode(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || '{}');
    if (parsed && typeof parsed.code === 'string') return parsed.code;
  } catch {
 // fall through
  }
  return argumentsJson || '';
}

// The envelope parser lives in lib/envelope.ts (one home for the format, build
// + parse). Re-exported here so existing importers (console tests, the SPA-drift
// guard) keep resolving parseEnvelope off the hub.
export { parseEnvelope } from '../lib/envelope.js';
