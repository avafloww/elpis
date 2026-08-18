// discord.ts — gateway wiring, message in/out, chunking, slash commands.
//
// - intents: Guilds, GuildMessages, MessageContent, GuildMessageReactions (the
// Message Content Intent MUST be enabled in the Discord Developer Portal or
// message.content is empty; GuildMessageReactions is not privileged). The
// client also registers partials (Message/Channel/Reaction/User) so reactions
// on OLD/uncached messages still deliver.
// - on MessageCreate: ignore the bot's OWN messages (loop guard), ignore other
// guilds, otherwise enqueue onto the agent's inbound queue and send a typing
// indicator. Messages from other bot accounts ARE processed. Mention markup
// (`<@id>`/`<@&id>`/`<#id>`) is rewritten to readable `@name`/`#name` HERE,
// at the one ingest point (resolveMentions) — a raw id tells the agent
// nothing about who was pinged, least of all whether it was themselves.
// - on MessageReactionAdd: 👍/👎 on one of the bot's OWN messages is captured
// OUT-OF-BAND via deps.feedback (elpis.db) as a good/bad signal — see the
// reactionVerdict gate. Never touches the conversation transcript or history;
// the agent does not see it. Fully guarded so a feedback failure can't disturb
// the gateway. Content-matching lives only in scripts/feedback.ts, not here.
// - outbound: chunk replies at <=1900 chars (prefer newline/whitespace splits).
// - slash commands (all reply ephemerally — visible only to the issuer):
// - /clear and /new (alias) reset the shared conversation; the next message
// in the channel starts a fresh context.
// - /clear-thinking clears ONLY stored provider-native thinking payloads
// (`thinking_blocks` + `reasoning_items`; same confirm flow as /clear) — the
// escape hatch after a model/provider switch.
// - /compact triggers an immediate compaction cycle.
// - /exec runs arbitrary JS in the agent sandbox (operator.discord_id only).
// - /restart flushes transcripts then triggers `systemctl --user restart
// elpis-harness` via a child process so the ephemeral reply is sent first.
// - /usage shows provider subscription usage (5h / weekly windows) as text
// bars (operator.discord_id only).
// - /cache shows prompt-cache hit rates and cache busts as text bars
// (operator.discord_id only).
//
// TESTABILITY: the command definitions, the operator-auth gate, and the result
// formatter are extracted as pure top-level functions (buildCommandDefinitions,
// isAuthorizedOperator, formatExecResult) so they can be unit-tested without a
// Discord client or network. The restart side-effect is injected via
// `restartHook` (defaults to the real systemctl spawn) so tests can assert the
// command is registered + gated without actually restarting the service.

import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  SlashCommandStringOption,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  type Message,
  type Guild,
} from 'discord.js';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createWriteStream, readFileSync } from 'node:fs';
import type { Agent, InboundMessage } from '../agent.js';
import type { Config } from '../config.js';
import { classifyEmoji, type FeedbackStore, type Verdict } from '../store/feedback.js';
import type { ProviderUsageSnapshot } from '../llm/usage-tracker.js';
import type { CacheInfo } from '../llm/cache-stats.js';
import { buildGuildIndex, classifyInbound, resolveChannelPolicy, type WakeInput, type GuildIndex } from './wake.js';
import type { MuteStore } from '../store/mutes.js';
import type { EmoteRegistry } from './emotes.js';
import { restartHarnessService } from '../lib/lifecycle.js';
import { sniffFileMediaType } from '../lib/image.js';
import { ATTACHMENT_DIR } from '../types.js';
import { PLURALKIT_BOT_ID, PluralKitResolver, isPluralKitCommand, pluralKitIdentity, type PluralKitMessage } from './pluralkit.js';
import { formatMindDetail, formatMindLine, parseMindId, type MindItem, type MindKind, type MindListFilter, type MindService, type MindSort, type MindStatus } from '../store/mind.js';


const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB Discord limit for non-nitro

/** Compute a stable, non-colliding local path for a Discord attachment.
 * Exported for unit testing; the index disambiguates reused filenames. */
export function attachmentLocalPath(
  baseDir: string,
  name: string,
  index: number,
): string {
  const baseName = name || 'attachment';
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  const safeName = `${stem}-${index}${ext || ''}`;
  return path.join(baseDir, safeName);
}

/** Download a Discord attachment to disk and return the absolute local path. */
export async function downloadAttachment(
  attachment: { url: string; name: string; size: number; id?: string },
  messageId: string,
  index: number,
  log: { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void },
): Promise<string | null> {
  const baseDir = path.join(ATTACHMENT_DIR, messageId);
  await mkdir(baseDir, { recursive: true });
 // Discord may reuse filenames (e.g. "image.png") for multiple attachments
 // in the same message, so append an index to keep them distinct.
  const localPath = attachmentLocalPath(baseDir, attachment.name, index);

  try {
    const res = await fetch(attachment.url, { headers: { 'User-Agent': 'elpis/0.1' } });
    if (!res.ok || !res.body) {
      log.warn(`downloadAttachment: ${attachment.name} HTTP ${res.status}`);
      return null;
    }
    if (attachment.size > ATTACHMENT_MAX_BYTES) {
      log.warn(`downloadAttachment: skipping ${attachment.name}: ${attachment.size} bytes exceeds limit`);
      return null;
    }
    const file = createWriteStream(localPath);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      file.write(chunk);
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve());
      file.on('error', reject);
    });
    log.info(`downloadAttachment: saved ${attachment.name} to ${localPath}`);
    return localPath;
  } catch (e) {
    log.warn(`downloadAttachment: failed ${attachment.name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Reconcile a Discord attachment's declared content type with what the
 * downloaded bytes actually are. Only corrects WITHIN images (declared
 * image/* + recognized image bytes) — a null or non-image declared type is
 * returned untouched, so which attachments inline as text vs. attach as
 * images never changes; only a wrong image label does (the 
 * webp-over-PNG mislabel). Pure; exported for tests. */
export function resolveAttachmentContentType(declared: string | null, sniffed: string | null): string | null {
  if (!declared || !/^image\//i.test(declared) || !sniffed) return declared;
  return sniffed;
}

/** Content types eligible for verbatim inlining into the inbound message:
 * any text/* plus JSON. The whole point of a text attachment is its text —
 * making the agent spend a tool call (and fight the preview cap) to read a
 * quiz/snippet/config the user explicitly sent was the single biggest
 * friction in the observed quiz-turn transcript. Pure; exported for tests. */
export function isInlinableAttachmentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^text\//i.test(contentType) || /^application\/json\b/i.test(contentType);
}

/** Guard a candidate inline body: reject content that would break the
 * <attachment-content> framing (a literal closing tag) or that is binary
 * mislabeled as text (NUL bytes). Returns the text to inline, or null to
 * fall back to path-only. Pure; exported for tests. */
export function guardInlineText(text: string): string | null {
  if (text.includes('</attachment-content>')) return null;
  if (text.includes('\u0000')) return null;
  return text;
}

async function buildInboundAttachments(
  message: Message,
  inlineBudgetBytes: number,
  log: { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void },
): Promise<import('../agent.js').InboundMessageAttachment[]> {
  const attachments = [...message.attachments.values()];
 // The downloads themselves are independent network fetches, so run them
 // concurrently. The inline-budget decision below is NOT independent — it's
 // a per-MESSAGE cumulative budget that must be spent in the message's
 // original attachment order — so that part stays a sequential pass over
 // the completed results.
  const localPaths = await Promise.all(
    attachments.map((a, index) =>
      downloadAttachment({ url: a.url, name: a.name, size: a.size, id: a.id }, message.id, index, log),
    ),
  );

  const out: import('../agent.js').InboundMessageAttachment[] = [];
 // Per-MESSAGE budget: a message with several small text files inlines them
 // until the budget is spent; the rest stay path-only. Bounds the context
 // cost of any single inbound regardless of attachment count.
  let inlineRemaining = inlineBudgetBytes;
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const localPath = localPaths[i];
    let contentType = a.contentType;
    if (localPath && contentType && /^image\//i.test(contentType)) {
      const sniffed = await sniffFileMediaType(localPath);
      const resolved = resolveAttachmentContentType(contentType, sniffed);
      if (resolved !== contentType) {
        log.info(`buildInboundAttachments: ${a.name}: declared ${contentType} but bytes are ${resolved} — using sniffed type`);
        contentType = resolved;
      }
    }
    let inlineText: string | null = null;
    if (localPath && isInlinableAttachmentType(a.contentType) && a.size <= inlineRemaining) {
      try {
        inlineText = guardInlineText(readFileSync(localPath, 'utf8'));
        if (inlineText !== null) inlineRemaining -= a.size;
      } catch (e) {
        log.warn(`buildInboundAttachments: inline read failed for ${a.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.push({
      url: a.url,
      name: a.name,
      contentType,
      localPath,
      size: a.size,
      inlineText,
    });
  }
  return out;
}

const CHUNK_MAX = 1900;

/** Split text into <=1900-char chunks, preferring newline then whitespace breaks. */
export function chunkText(text: string, max = CHUNK_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export interface DiscordWiring {
  client: Client;
  start(): Promise<void>;
  /** Start (or restart) the repeating "<agent> is typing…" indicator for a
 * channel — the Agent's onThinking hook (via agent.setTyping) and the
 * sandbox's channel(id).typing both drive this. See the TEMPORARY BODGE
 * note in createDiscord for the current first-guild gate. */
  typing(channelId: string): void;
  /** Stop the indicator (agent idle / turn end). */
  stopTyping(): void;
}

/** Names of every slash command this harness registers. Kept in sync with
 * buildCommandDefinitions and the InteractionCreate handler. */
export const SLASH_COMMAND_NAMES = [
  'clear', 'new', 'clear-thinking', 'compact', 'exec', 'restart', 'usage', 'cache',
  'mute', 'unmute', 'deafen', 'undeafen', 'mind',
] as const;
export type SlashCommandName = (typeof SLASH_COMMAND_NAMES)[number];

/** Custom-ids for the /clear confirmation buttons, namespaced by the invoking
 * user id so a different user can't confirm someone else's wipe. Pure; tested. */
export function clearConfirmCustomId(userId: string): string { return `clear-confirm:${userId}`; }
export function clearCancelCustomId(userId: string): string { return `clear-cancel:${userId}`; }
/** Custom-ids for the /clear-thinking confirmation buttons, namespaced by user
 * id (same pattern as /clear). Pure; tested. */
export function clearThinkingConfirmCustomId(userId: string): string { return `clear-thinking-confirm:${userId}`; }
export function clearThinkingCancelCustomId(userId: string): string { return `clear-thinking-cancel:${userId}`; }

/** Build the guild slash-command definitions as REST JSON. Pure; tested. */
export function buildCommandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Wipe the agent\'s entire working memory (all channels) after a confirmation')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('new')
      .setDescription('Alias of /clear — wipe the agent\'s entire working memory after a confirmation')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clear-thinking')
      .setDescription('Clear stored provider thinking payloads after a model/provider switch')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('compact')
      .setDescription('Trigger a compaction cycle (non-destructive summarize of older context)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('exec')
      .setDescription('Execute arbitrary JS in the agent sandbox (operator only)')
      .addStringOption((option: SlashCommandStringOption) =>
        option
          .setName('code')
          .setDescription('JavaScript code to run')
          .setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('restart')
      .setDescription('Flush transcripts and restart the harness service (operator only)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('usage')
      .setDescription('Show provider subscription usage (5h / weekly windows) (operator only)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('cache')
      .setDescription('Show prompt-cache hit rates and cache busts (operator only)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('mind')
      .setDescription('Read and tend the private dependency-aware work graph')
      .addSubcommand((s) => s.setName('list').setDescription('List work')
        .addStringOption((o) => o.setName('view').setDescription('Which slice').addChoices(
          { name: 'ready', value: 'ready' }, { name: 'active', value: 'active' }, { name: 'blocked', value: 'blocked' },
          { name: 'waiting', value: 'waiting' }, { name: 'done', value: 'done' }, { name: 'overdue', value: 'overdue' },
          { name: 'inbox', value: 'inbox' }, { name: 'all', value: 'all' },
        ))
        .addStringOption((o) => o.setName('sort').setDescription('Ordering (default: recently updated)').addChoices(
          { name: 'updated · newest first', value: 'updated_desc' }, { name: 'updated · oldest first', value: 'updated_asc' },
          { name: 'created · newest first', value: 'created_desc' }, { name: 'created · oldest first', value: 'created_asc' },
          { name: 'last comment · newest first', value: 'last_comment_desc' }, { name: 'last comment · oldest first', value: 'last_comment_asc' },
        ))
        .addStringOption((o) => o.setName('query').setDescription('Search title, body, and comments'))
        .addIntegerOption((o) => o.setName('limit').setDescription('Maximum rows (1–30)').setMinValue(1).setMaxValue(30)))
      .addSubcommand((s) => s.setName('read').setDescription('Read one item with dependencies, comments, and reminders')
        .addStringOption((o) => o.setName('id').setDescription('Item id (#12 or m-12)').setRequired(true)))
      .addSubcommand((s) => s.setName('add').setDescription('Add an item')
        .addStringOption((o) => o.setName('title').setDescription('Short action or idea').setRequired(true))
        .addStringOption((o) => o.setName('details').setDescription('Body / acceptance notes'))
        .addStringOption((o) => o.setName('kind').setDescription('Item kind').addChoices(
          { name: 'task', value: 'task' }, { name: 'project', value: 'project' }, { name: 'idea', value: 'idea' },
          { name: 'question', value: 'question' }, { name: 'reminder', value: 'reminder' },
        ))
        .addIntegerOption((o) => o.setName('priority').setDescription('0 none · 1 low · 2 normal · 3 high · 4 urgent').setMinValue(0).setMaxValue(4))
        .addStringOption((o) => o.setName('depends_on').setDescription('Comma-separated prerequisite ids'))
        .addStringOption((o) => o.setName('parent').setDescription('Parent project/item id'))
        .addStringOption((o) => o.setName('due').setDescription('ISO date/time'))
        .addStringOption((o) => o.setName('remind').setDescription('ISO date/time for a scheduler wake'))
        .addStringOption((o) => o.setName('tags').setDescription('Comma-separated tags')))
      .addSubcommand((s) => s.setName('edit').setDescription('Edit an item')
        .addStringOption((o) => o.setName('id').setDescription('Item id').setRequired(true))
        .addStringOption((o) => o.setName('title').setDescription('Replacement title'))
        .addStringOption((o) => o.setName('details').setDescription('Replacement body'))
        .addStringOption((o) => o.setName('status').setDescription('Workflow status').addChoices(
          { name: 'inbox', value: 'inbox' }, { name: 'open', value: 'open' }, { name: 'in progress', value: 'in_progress' },
          { name: 'waiting', value: 'waiting' }, { name: 'done', value: 'done' }, { name: 'cancelled', value: 'cancelled' },
        ))
        .addIntegerOption((o) => o.setName('priority').setDescription('0–4').setMinValue(0).setMaxValue(4))
        .addStringOption((o) => o.setName('due').setDescription('ISO date/time, or clear'))
        .addStringOption((o) => o.setName('tags').setDescription('Replacement comma-separated tags')))
      .addSubcommand((s) => s.setName('done').setDescription('Complete an item')
        .addStringOption((o) => o.setName('id').setDescription('Item id').setRequired(true))
        .addStringOption((o) => o.setName('comment').setDescription('Closing note')))
      .addSubcommand((s) => s.setName('start').setDescription('Mark an item in progress')
        .addStringOption((o) => o.setName('id').setDescription('Item id').setRequired(true)))
      .addSubcommand((s) => s.setName('wait').setDescription('Mark an item waiting')
        .addStringOption((o) => o.setName('id').setDescription('Item id').setRequired(true))
        .addStringOption((o) => o.setName('comment').setDescription('What it is waiting on')))
      .addSubcommand((s) => s.setName('comment').setDescription('Append a comment')
        .addStringOption((o) => o.setName('id').setDescription('Item id').setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription('Comment').setRequired(true)))
      .addSubcommand((s) => s.setName('link').setDescription('Make one item depend on another')
        .addStringOption((o) => o.setName('id').setDescription('Blocked item').setRequired(true))
        .addStringOption((o) => o.setName('depends_on').setDescription('Prerequisite item').setRequired(true)))
      .addSubcommand((s) => s.setName('unlink').setDescription('Remove a dependency')
        .addStringOption((o) => o.setName('id').setDescription('Dependent item').setRequired(true))
        .addStringOption((o) => o.setName('depends_on').setDescription('Prerequisite item').setRequired(true)))
      .addSubcommand((s) => s.setName('remind').setDescription('Schedule a wake for an item')
        .addStringOption((o) => o.setName('id').setDescription('Item id').setRequired(true))
        .addStringOption((o) => o.setName('when').setDescription('ISO date/time').setRequired(true)))
      .addSubcommand((s) => s.setName('graph').setDescription('Show the nearby dependency/hierarchy graph')
        .addStringOption((o) => o.setName('id').setDescription('Root item').setRequired(true))
        .addIntegerOption((o) => o.setName('depth').setDescription('Traversal depth (1–8)').setMinValue(1).setMaxValue(8)))
      .addSubcommand((s) => s.setName('archive').setDescription('Soft-archive an item')
        .addStringOption((o) => o.setName('id').setDescription('Item id').setRequired(true)))
      .toJSON(),
    new SlashCommandBuilder().setName('mute')
      .setDescription('Operator: mute a channel — the agent keeps hearing it but cannot speak there')
      .addStringOption((o: SlashCommandStringOption) => o.setName('channel').setDescription('Qualified ref (friends-a/lounge) or raw id').setRequired(true))
      .addStringOption((o: SlashCommandStringOption) => o.setName('reason').setDescription('Why — logged and shown to the agent').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('unmute')
      .setDescription('Operator: release a mute')
      .addStringOption((o: SlashCommandStringOption) => o.setName('channel').setDescription('Qualified ref (friends-a/lounge) or raw id').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder().setName('deafen')
      .setDescription('Operator: deafen a channel — it stops entering the agent\'s context entirely (implies mute)')
      .addStringOption((o: SlashCommandStringOption) => o.setName('channel').setDescription('Qualified ref (friends-a/lounge) or raw id').setRequired(true))
      .addStringOption((o: SlashCommandStringOption) => o.setName('reason').setDescription('Why — logged and shown to the agent').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder().setName('undeafen')
      .setDescription('Operator: release a deafen')
      .addStringOption((o: SlashCommandStringOption) => o.setName('channel').setDescription('Qualified ref (friends-a/lounge) or raw id').setRequired(true))
      .toJSON(),
  ];
}

/** True if this message is the bot's own — the loop guard. We ignore only
 * our own messages (preventing self-reply loops); other bot accounts are
 * processed normally. Returns false when the bot's user id isn't known yet
 * (client not ready), in which case the caller should NOT skip (it's safer
 * to process a possible self-message once than to drop a real one). Pure +
 * synchronous for tests. */
export function isOwnMessage(botUserId: string | undefined, authorId: string): boolean {
  return botUserId !== undefined && botUserId === authorId;
}

/** Assemble the wake-classifier input from gateway facts (pure, testable).
 * `mentionsMe` checks the mentioned-user-id LIST for THIS bot's id — a
 * message that @-mentions some other bot must not count. Only this bot
 * sets the flag; mentions of other bots remain ordinary input.
 *
 * `botUserId` is `undefined` when the client isn't ready yet. Unlike
 * `isOwnMessage` (which fails toward SKIPPING a possible self-message once,
 * never dropping a real one), an unresolved bot id here must fail TOWARD
 * waking: any mention or reply is treated as possibly-us rather than
 * silently downgrading a direct address to ambient. Being woken
 * unnecessarily is cheap; missing someone addressing the bot directly is the
 * exact failure this classifier exists to avoid. */
export function wakeInputFor(
  guildId: string,
  channelId: string,
  authorIsBot: boolean,
  mentionedUserIds: string[],
  replyToAuthorId: string | null,
  botUserId: string | undefined,
): WakeInput {
  return {
    guildId, channelId, authorIsBot,
    mentionsMe: botUserId === undefined ? mentionedUserIds.length > 0 : mentionedUserIds.includes(botUserId),
    replyToMe: botUserId === undefined ? replyToAuthorId !== null : replyToAuthorId === botUserId,
  };
}

/** Resolve the channel id used for every per-channel POLICY lookup (allowlist
 * tier, killswitch mute/deafen, drop-logging, the ambient_tick_ms=0 escape
 * hatch): a thread/forum post inherits its PARENT channel's policy — the
 * operator's decision is that a thread is a sub-conversation of a room that
 * was already approved, not a new room, so muting/allowlisting `#general`
 * covers its threads too. A non-thread, or a thread whose parent id isn't
 * resolvable (e.g. an uncached parent), falls back to its own channel id —
 * which then either matches the allowlist directly or drops as unlisted, the
 * same as before threads were handled at all. Pure; exported for tests. */
export function resolvePolicyChannelId(
  channelId: string,
  isThread: boolean,
  parentId: string | null,
): string {
  return isThread && parentId ? parentId : channelId;
}

/** Resolve which configured guild a channel or thread belongs to, for the
 * typing-indicator gate (see `createDiscord`'s `typing`/`typingGuildId`
 * below) — WITHOUT a network fetch. A plain configured channel resolves
 * directly off the guild index; a THREAD is resolved via its parent id
 * (`threadParent`, backed in production by the client's already-populated
 * channel cache, never a live fetch) checked against the index the same way
 * — the same "a thread inherits its parent's policy" idea
 * `resolvePolicyChannelId` uses at ingest, just for the typing gate instead
 * of the allowlist. Returns null when unresolvable (uncached thread,
 * unconfigured channel); callers treat null as "don't type". `threadParent`
 * is injected so this stays pure and unit-testable without a live Client.
 * Pure; exported for tests. */
export function resolveTypingGuildId(
  channelId: string,
  index: GuildIndex,
  threadParent: (channelId: string) => string | null,
): string | null {
  const direct = index.byChannel.get(channelId);
  if (direct) return direct.guild.id;
  const parentId = threadParent(channelId);
  return parentId ? index.byChannel.get(parentId)?.guild.id ?? null : null;
}

/** Human-readable `.name` off a channel-ish object, duck-typed the same way
 * the rest of this file narrows discord.js channel unions. `'unknown'` when
 * absent (uncached partial, DM, or a null parent). Pure; exported for tests. */
export function channelDisplayName(ch: unknown): string {
  return ch !== null && typeof ch === 'object' && 'name' in ch && typeof (ch as { name?: unknown }).name === 'string'
    ? (ch as { name: string }).name
    : 'unknown';
}

/** Names Discord already attached to an inbound message, keyed by id — the
 * lookup tables `resolveMentions` rewrites markup against. */
export interface MentionNames {
  users?: Map<string, string>;
  roles?: Map<string, string>;
  channels?: Map<string, string>;
}

/** Rewrite Discord's raw mention markup (`<@id>`, `<@!id>`, `<@&id>`, `<#id>`)
 * to the readable `@name` / `#name` form. On the wire a body arrives as
 * `<@111111111111111103> do mentions work too?`, which tells the agent
 * nothing about WHO was pinged — least of all whether it was themselves.
 * Names come from what the gateway already delivered with the message
 * (`message.mentions.*`), so nothing is fetched; an id with no name in hand
 * is left as raw markup rather than guessed at. Pure; exported for tests. */
export function resolveMentions(content: string, names: MentionNames): string {
 // No snowflake length guard: a substitution only happens when the id is in a
 // table Discord itself populated, so unknown markup falls through untouched
 // regardless of its shape.
  return content.replace(/<(@[!&]?|#)(\d+)>/g, (raw: string, kind: string, id: string) => {
    if (kind === '#') {
      const name = names.channels?.get(id);
      return name ? `#${name}` : raw;
    }
    if (kind === '@&') {
      const name = names.roles?.get(id);
      return name ? `@${name}` : raw;
    }
    const name = names.users?.get(id);
    return name ? `@${name}` : raw;
  });
}

/** The reverse of `resolveMentions`: rewrite outbound `@Name` tokens to
 * Discord's `<@id>` markup for names the guild's member directory already
 * knows about, so a mention the agent writes as prose actually pings. Only
 * an EXACT key match in `nameToId` converts — `@aster` becomes `<@123>` only
 * when `'aster'` is a key; a typo or someone not in the directory is left as
 * plain text rather than guessed at (same conservatism as the inbound
 * direction). The `@` must sit at the start of the string or after
 * whitespace, so an email-ish `a@b.com` or a code-spanned handle is never
 * mangled — this is a best-effort word-boundary check, not code-fence-aware.
 * Pure; exported for tests. */
export function applyOutboundMentions(text: string, nameToId: Map<string, string>): string {
  if (nameToId.size === 0) return text;
  return text.replace(/(?<=^|\s)@([A-Za-z0-9_]+)\b/g, (raw: string, name: string) => {
    const id = nameToId.get(name);
    return id ? `<@${id}>` : raw;
  });
}

/** Reverse name→id directory for `applyOutboundMentions`, scoped to one
 * guild. Sourced from `guild.members.cache` — LIMITATION: this harness does
 * not request the privileged GuildMembers intent, so the cache only holds
 * members discord.js has already seen (message authors, mention targets,
 * the bot itself), not the guild's full roster. A member who hasn't spoken
 * since boot simply won't resolve; that's an acceptable degrade (falls back
 * to plain `@name` text) rather than a reason to block this on requesting a
 * new intent. Pure given a `Guild`; exported for tests. */
export function outboundMentionDirectory(guild: Guild | null | undefined): Map<string, string> {
  const dir = new Map<string, string>();
  if (!guild) return dir;
  for (const member of guild.members.cache.values()) {
    const name = member.displayName || member.user.username;
    if (name) dir.set(name, member.id);
  }
  return dir;
}

/** A `Collection`/array of mention targets → an id→name map. Duck-typed and
 * absence-tolerant on purpose: this runs inside the sole MessageCreate ingest
 * path, where a TypeError on an unexpected shape would silently drop the
 * message entirely — a missing collection costs unresolved markup, nothing
 * more. */
function nameMap<T extends { id: string }>(coll: unknown, name: (x: T) => string): Map<string, string> {
  const items = coll as { map?: (fn: (x: T) => [string, string]) => [string, string][] } | undefined;
  if (!items || typeof items.map !== 'function') return new Map();
  return new Map(items.map((x: T): [string, string] => [x.id, name(x)]));
}

/** `MentionNames` off a live discord.js message. User names use the same
 * `displayName || username` expression as the envelope's `author` field, so a
 * mention of someone reads identically to that person speaking. */
function mentionNamesFor(message: Message): MentionNames {
  const m = message?.mentions;
  if (!m) return {};
  return {
    users: nameMap<{ id: string; displayName?: string; username?: string }>(m.users, (u) => u.displayName || u.username || 'unknown'),
    roles: nameMap<{ id: string; name: string }>(m.roles, (r) => r.name),
    channels: nameMap<{ id: string }>(m.channels, (c) => channelDisplayName(c)),
  };
}

/** True if this Discord user id is authorized to run slash commands — EVERY
 * slash command is operator-gated (see the top of the InteractionCreate
 * handler). Returns false when operator.discord_id is unset (commands are
 * disabled entirely) or the id doesn't match. Pure + synchronous for tests. */
export function isAuthorizedOperator(config: Config, userId: string): boolean {
  return config.operator.discordId !== null && config.operator.discordId === userId;
}

/** The ephemeral reply for a non-operator hitting the (single, hoisted)
 * operator gate: a distinct "disabled" message when operator.discord_id is
 * unset entirely vs. "not authorized" when it's set to someone else. Shared
 * by all eleven slash commands. Pure; exported for tests. */
export function operatorGateReason(config: Config, name: string): string {
  return config.operator.discordId
    ? 'You are not authorized to use this command.'
    : `/${name} is disabled (operator.discord_id not set).`;
}

/** Minimal shape of `Agent` the killswitch commands need — narrowed so the
 * resolution logic below is unit-testable without constructing a real Agent. */
interface ModerationAgent {
  resolveChannelRef(ref: string): string | null;
  moderateChannel(
    channelId: string,
    action: 'mute' | 'unmute' | 'deafen' | 'undeafen',
    actor: 'operator',
    reason?: string,
  ): { ok: boolean; note: string };
}

/** Resolve a /mute /unmute /deafen /undeafen invocation to its ephemeral
 * reply text: resolve `ref` via `agent.resolveChannelRef` and forward to
 * `agent.moderateChannel` — the single implementation of every killswitch
 * transition (see docs/architecture.md's "the killswitch" section). Folds
 * the two channel-resolution failure modes into the same `{ ok: false, note }`
 * shape `moderateChannel` itself returns, so the caller has one path:
 * - an unqualified bare ref (e.g. "lounge" ambiguous across guilds) THROWS
 * from resolveChannelRef with a message listing the legal qualified
 * candidates — that message IS the reply, verbatim, not a generic failure.
 * - a ref that resolves to nothing (`null`, no throw) gets a generic
 * "unknown channel" reply pointing at the qualified-ref syntax.
 * Pure over the two injected agent calls; exported for tests. */
export function resolveModerationCommand(
  agent: ModerationAgent,
  action: 'mute' | 'unmute' | 'deafen' | 'undeafen',
  ref: string,
  reason?: string,
): { ok: boolean; note: string } {
  ref = ref.trim();
  let channelId: string | null = null;
  let err: string | null = null;
  try {
    channelId = agent.resolveChannelRef(ref);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  if (!channelId) {
    return { ok: false, note: err ?? `unknown channel "${ref}" — use a qualified ref like friends-a/lounge or a raw id` };
  }
  return agent.moderateChannel(channelId, action, 'operator', reason);
}

/** Decide whether a Discord reaction is feedback, and its verdict. Returns null
 * to IGNORE: the client isn't ready, the bot is reacting to itself, the reacted
 * message wasn't authored by the bot, or the emoji isn't 👍/👎. Pure; tested. */
export function reactionVerdict(args: {
  botUserId: string | undefined;
  reactorId: string;
  messageAuthorId: string | undefined;
  emojiName: string | null;
}): Verdict | null {
  const { botUserId, reactorId, messageAuthorId, emojiName } = args;
  if (botUserId === undefined) return null;      // client not ready
  if (reactorId === botUserId) return null;      // ignore our own reactions
  if (messageAuthorId !== botUserId) return null; // only feedback on the bot's messages
  return classifyEmoji(emojiName);
}

/** Triple-backtick fence, spelled via char codes so it isn't itself parsed as
 * a code fence inside this source file's own comments/strings. Shared by
 * every ephemeral reply renderer below. */
const FENCE = String.fromCharCode(96, 96, 96);

/** Render a 0..1 ratio as a 10-cell ▓/░ text bar, clamped. Shared by
 * formatUsageBars (quota-used ratio — full is bad) and formatCacheBars
 * (cache-hit ratio — full is good); the polarity meaning is the caller's
 * concern, the cell math is identical at both sites. */
function tenCellBar(ratio: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

/** Format a sandbox RunResult for the /exec ephemeral reply. */
function formatExecResult(result: { ok: boolean; preview?: string; savedAs?: string; logs?: string; error?: string }): string {
  const parts: string[] = [];
  parts.push(result.ok ? '✅ ok' : '❌ error');
  if (result.preview !== undefined) {
    parts.push(FENCE + '\n' + result.preview + '\n' + FENCE);
  }
  if (result.savedAs) {
    parts.push('saved as: ' + result.savedAs);
  }
  if (result.logs) {
    parts.push('logs:' + '\n' + FENCE + '\n' + result.logs + '\n' + FENCE);
  }
  if (result.error) {
    parts.push('error:' + '\n' + FENCE + '\n' + result.error + '\n' + FENCE);
  }
  const joined = parts.join('\n\n');
  if (joined.length <= 1900) return joined;
  return joined.slice(0, 1900 - 3) + '...';
}

/** Humanize a millisecond delta for reset countdowns ("6d 18h", "5h 0m", "3m"). */
function formatDelta(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

/** Render a ProviderUsageSnapshot as monospace text bars for the /usage reply.
 * Pure (clock injected) so it is unit-testable without Discord. */
export function formatUsageBars(snap: ProviderUsageSnapshot | null, now: number = Date.now()): string {
  if (!snap) return 'usage tracking not active for the current endpoint.';
  const lines: string[] = [`${snap.label} usage${snap.error ? ' (stale, fetch failed)' : ''}`];
  if (snap.windows.length === 0) lines.push('no usage data available.');
  for (const w of snap.windows) {
    const pct = Math.round(w.usedPct);
    const bar = tenCellBar(w.usedPct / 100);
    let reset = '';
    if (w.resetAt) {
      const dt = Date.parse(w.resetAt) - now;
      reset = dt <= 0 ? '   resetting…' : `   resets in ${formatDelta(dt)}`;
    }
    lines.push(`${w.label.padEnd(4)} ${bar} ${String(pct).padStart(3)}%${reset}`);
  }
  return FENCE + '\n' + lines.join('\n') + '\n' + FENCE;
}

/** Render CacheInfo as monospace text bars for the /cache reply. Pure — cache
 * stats carry no time component, so unlike formatUsageBars there is no clock to
 * inject. NOTE the inverted bar polarity vs /usage: there a full bar is bad
 * (quota spent), here a full bar is good (cache hit rate). Both rows are
 * labeled and the commands are separate, so this is documented, not designed
 * around. */
export function formatCacheBars(cache: CacheInfo | null): string {
  const wrap = (body: string) => FENCE + '\n' + body + '\n' + FENCE;
  if (!cache) {
    return wrap('prompt cache: not reported by the current endpoint.');
  }
  if (cache.turns === 0) {
    return wrap('prompt cache: no completions recorded yet.');
  }
  if (!cache.supported) {
    return wrap('prompt cache: not reported by the current endpoint.');
  }
  const bar = tenCellBar;
  const exact = (n: number) => n.toLocaleString('en-US');
  /** Session sums run to millions; abbreviate them like the console rail does. */
  const brief = (n: number) => {
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    return exact(n);
  };
  const row = (label: string, r: number, cached: number, fresh: number, fmt: (n: number) => string) =>
    `${label.padEnd(4)} ${bar(r)} ${String(Math.round(r * 100)).padStart(3)}%   ` +
    `cached ${fmt(cached)} · new ${fmt(fresh)}`;
  const lines = [
    'prompt cache',
    row('last', cache.lastRatio, cache.lastCached, cache.lastNew, exact),
    row('sess', cache.totalRatio, cache.totalCached, cache.totalNew, brief),
  ];
  if (cache.bustCount > 0) {
    lines.push(`${cache.bustCount} bust${cache.bustCount === 1 ? '' : 's'} · ${cache.bustTokens.toLocaleString('en-US')} rewritten`);
  }
  return wrap(lines.join('\n'));
}

/** Run an interaction reply/editReply/deferReply call, logging (rather than
 * throwing out of the InteractionCreate handler) if it fails — an expired
 * interaction token or a gateway blip must not take down command handling.
 * `fn` performs the actual call(s); some commands need more than one
 * (deferReply then editReply) under the same catch, so this takes a thunk
 * rather than a fixed payload. `name` identifies the command in the warn
 * message. */
async function safeReply(
  log: { warn: (...a: unknown[]) => void },
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.warn(`failed to reply to /${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function isMindHomeGuild(config: Config, guildId: string): boolean {
  return config.discord.guilds.some((guild) => guild.id === guildId && guild.slug === 'home');
}

function parseDiscordMindTime(value: string, field: string): number {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error(`${field} must be an ISO date/time`);
  return at;
}

function parseDiscordMindIds(value: string | null): number[] {
  if (!value?.trim()) return [];
  return value.split(',').map((part) => parseMindId(part.trim()));
}

function truncateMindReply(value: string): string {
  return value.length <= 1950 ? value : value.slice(0, 1920) + '\n… (open the dashboard for the full record)';
}

export function formatMindList(items: ReturnType<MindService['list']>, heading = 'mind'): string {
  if (items.length === 0) return `${heading}: nothing here.`;
  return truncateMindReply(`${heading} · ${items.length}\n${items.map(formatMindLine).join('\n')}`);
}

export function mindAddAmbientNotice(item: MindItem, source: {
  channelId: string;
  policyChannelId?: string;
  channelName: string;
  guildId: string;
  guildSlug: string;
  createdAt?: string;
}): InboundMessage {
  return {
    id: `mind-add-${item.id}-${Date.now()}`,
    channelId: source.channelId,
    policyChannelId: source.policyChannelId ?? source.channelId,
    channelName: source.channelName,
    guildId: source.guildId,
    guildSlug: source.guildSlug,
    author: 'mind',
    authorId: 'mind',
    bot: true,
    content: `[mind item added via /mind]\n${formatMindLine(item)}`,
    createdAt: source.createdAt ?? new Date().toISOString(),
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    wakeClass: 'ambient',
  };
}

export function createDiscord(
  config: Config,
  agent: Agent,
  deps?: {
    restartHook?: () => void;
    feedback?: FeedbackStore;
    /** Fresh-fetches the provider usage snapshot (wired to tracker.fetchNow()).
 * Absent/null result ⇒ tracking inactive for the current endpoint. */
    usage?: () => Promise<ProviderUsageSnapshot | null>;
    /** Killswitch mute/deafen state, consulted by the wake classifier. */
    mutes?: MuteStore;
    /** Private dependency-aware work graph, exposed through /mind in home only. */
    mind?: MindService;
    /** Custom emote/sticker registry (first-use-per-context-window image
 * attachment). Absent = feature disabled; ingest attaches nothing. */
    emotes?: EmoteRegistry;
  },
): DiscordWiring {
  const log = config.logger;
  const restartHook = deps?.restartHook ?? defaultRestartHook(config);
 // Built once — never per message. Unlisted guilds still fail closed; channel
 // channels listed in a guild's `channels` map reach the classifier at all.
  const guildIndex = buildGuildIndex(config.discord.guilds);
  const pluralKit = new PluralKitResolver();
 // Unlisted-channel and deafened-channel drops are logged once per
 // `<policyChannelId>:<reason>` per boot — the log line is how the operator
 // discovers channel ids to add, so it must name the channel/guild readably
 // rather than being silent, but it must not spam on every message in a
 // repeatedly dropped channel. Keying on the RESOLVED policy channel id (a
 // thread's parent, not the thread itself) means every thread under one
 // unlisted/deafened parent collapses into a single entry instead of
 // growing unboundedly over a long uptime; keying on `reason` too means a
 // mute→unmute→re-mute cycle (or a channel dropped for one reason today and
 // another tomorrow) still logs each distinct reason rather than going
 // silent after the first.
  const droppedLogged = new Set<string>();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

  client.on(Events.ClientReady, () => {
    log.info(`discord client ready: ${client.user?.tag ?? 'unknown'}`);
  });

 // ---- typing indicator (the ONE implementation — see docs/architecture.md's
 // "Discord typing indicator" section). Two callers: the wake-time immediate
 // shot below (MessageCreate) and the Agent's onThinking hook (wired via
 // agent.setTyping once this wiring exists — index.ts), both funneling
 // through the same gate and the same repeating mechanism.
 //
 // TEMPORARY BODGE: the indicator misbehaves on secondary
 // guilds, so it's restricted to the FIRST configured guild — ONE gate now
 // (this constant), resolved via the guild index rather than a live
 // channels.fetch. Remove `typingGuildId` and its call sites below to
 // restore typing everywhere once the underlying bug is diagnosed.
  const typingGuildId = config.discord.guilds[0]?.id ?? null;
  /** A THREAD's parent, resolved from the client's cache ONLY — discord.js
 * already caches every channel of a joined guild off the gateway's
 * GUILD_CREATE, well before any typing is needed — never a live fetch, so
 * an uncached id (ephemeral DM, gateway hiccup, or — in tests — no live
 * gateway at all) resolves to null rather than hitting the network. */
  const threadParentOf = (channelId: string): string | null => {
    const ch = client.channels.cache.get(channelId);
    return ch && 'isThread' in ch && typeof (ch as { isThread?: () => boolean }).isThread === 'function' &&
      (ch as { isThread: () => boolean }).isThread()
      ? ((ch as { parentId: string | null }).parentId ?? null)
      : null;
  };
  /** Fire sendTyping() once on an already-resolved channel-ish object,
 * swallowing errors — a channel may be ephemeral, deleted, or the gateway
 * may be hiccuping, none of which should be fatal. */
  const fireTypingOn = async (ch: unknown): Promise<void> => {
    try {
      if (ch && typeof ch === 'object' && 'isTextBased' in ch &&
          (ch as { isTextBased: () => boolean }).isTextBased() && 'sendTyping' in ch) {
        await (ch as { sendTyping: () => Promise<void> }).sendTyping();
      }
    } catch { /* non-fatal */ }
  };
  let typingInterval: NodeJS.Timeout | null = null;
  const stopTyping = (): void => {
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
  };
  /** Start (or restart) the repeating indicator for channelId: fires
 * immediately, then every 8s (Discord's own indicator lasts ~10s) until
 * stopTyping. The gate is resolved ONCE at start (not re-checked per
 * tick — the efficiency win over the old per-tick channels.fetch), and the
 * channel is resolved from the cache once too and reused across ticks. */
  const typing = (channelId: string): void => {
    stopTyping();
    const resolvedGuildId = resolveTypingGuildId(channelId, guildIndex, threadParentOf);
    if (resolvedGuildId !== typingGuildId) return;
    const policyChannelId = threadParentOf(channelId) ?? channelId;
    if (resolveChannelPolicy(resolvedGuildId, policyChannelId, guildIndex)?.allowSend !== true) return;
    const ch = client.channels.cache.get(channelId);
    const fire = () => fireTypingOn(ch);
    fire();
    typingInterval = setInterval(fire, 8000);
  };

  client.on(Events.MessageCreate, async (message: Message) => {
 // ignore the bot's OWN messages — prevents self-reply loops. Other bot
 // accounts are allowed through so the agent can react to them.
    if (isOwnMessage(client.user?.id, message.author.id)) return;
 // DMs/group DMs have no guild — the gateway is guild-intents-only (no
 // DM support; classifyInbound's WakeInput has no representation for one),
 // so route them out before they ever reach the classifier.
    if (!message.guildId) return;

 // Threads/forum posts carry their own channel id, distinct from their
 // parent — resolvePolicyChannelId maps to the parent for every
 // per-channel POLICY decision below (receive mode, mute/deafen, drop
 // logging, the ambient_tick_ms=0 escape hatch). The thread's own id/name
 // is kept separately (`channel`/`channelName` below) for the enqueued
 // message's provenance — that's genuinely where the message was.
    const channel = message.channel;
    const threadParentId = channel.isThread() ? channel.parentId : null;
    const policyChannelId = resolvePolicyChannelId(message.channelId, channel.isThread(), threadParentId);
    const policyChannelName = channel.isThread() ? channelDisplayName(channel.parent) : channelDisplayName(channel);

    const guild = guildIndex.byGuildId.get(message.guildId);
    if (!guild) return;
    const policy = resolveChannelPolicy(message.guildId, policyChannelId, guildIndex);
    if (!policy || policy.tier === 'drop') {
      const key = `${policyChannelId}:config-drop`;
      if (!droppedLogged.has(key)) {
        droppedLogged.add(key);
        log.info(`dropping #${policyChannelName} (${policyChannelId}) in ${guild.slug} — receive mode is drop`);
      }
      return;
    }

    if (policy.guild.pluralKit && (isPluralKitCommand(message.content) || message.author.id === PLURALKIT_BOT_ID)) return;

    let pkInfo: PluralKitMessage | null = null;
    if (policy.guild.pluralKit) {
      try {
        pkInfo = await pluralKit.resolve(message.id, message.author.bot !== true && message.webhookId === null);
      } catch (e) {
        log.warn(`PluralKit lookup failed for ${message.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (pkInfo?.original === message.id) {
      log.debug(`suppressing PluralKit original ${message.id} (proxy ${pkInfo.id})`);
      return;
    }

    const fallbackAuthor = message.author.displayName || message.author.username;
    const identity = pkInfo ? pluralKitIdentity(pkInfo, fallbackAuthor) : { author: fallbackAuthor, authorId: message.author.id };
    const authorIsBot = pkInfo ? false : message.author.bot === true;
    log.debug(`inbound message #${message.channelId} <${identity.author}>: ${message.content.slice(0, 120)}`);

    const channelName = channelDisplayName(channel);

 // The reply-to fetch happens BEFORE classification — replyToMe feeds the
 // wake decision, so the classifier can't run until this resolves.
    const replyTo = await (async () => {
      const replyToId = message.reference?.messageId;
      if (!replyToId) return null;
      try {
        const ch = message.channel;
        const ref = ch.isTextBased() && 'messages' in ch
          ? await ch.messages.fetch(replyToId)
          : null;
        if (!ref) return null;
        const refFallback = ref.author.displayName || ref.author.username;
        let refIdentity = { author: refFallback, authorId: ref.author.id };
        if (policy.guild.pluralKit) {
          try {
            const refPk = await pluralKit.resolve(ref.id);
            if (refPk) refIdentity = pluralKitIdentity(refPk, refFallback);
          } catch (e) {
            log.warn(`PluralKit reply lookup failed for ${ref.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return {
          id: ref.id,
          author: refIdentity.author,
          authorId: refIdentity.authorId,
          content: resolveMentions(ref.content, mentionNamesFor(ref)),
        };
      } catch {
        return null;
      }
    })();

    const muteType = (id: string) => deps?.mutes?.get(id)?.type ?? null;
    const input = wakeInputFor(message.guildId, policyChannelId, authorIsBot,
      message.mentions.users.map((u) => u.id), replyTo?.authorId ?? null, client.user?.id);
    let cls = classifyInbound(input, guildIndex, muteType);
    if (cls === 'drop') {
 // classifyInbound returns 'drop' for two different reasons: a
 // killswitch deafen on the resolved channel, or the channel being
 // configured under a DIFFERENT guild than this message's guildId
 // claims (channel ids are globally unique on real Discord, so that
 // branch is defense-in-depth rather than a live case — but it must
 // not be mislabeled "deafened" when it does fire). Match the unlisted
 // line's readable format and report the actual reason.
      const wrongGuild = policy.guild.id !== message.guildId;
      const key = `${policyChannelId}:${wrongGuild ? 'wrong-guild' : 'deafened'}`;
      if (!droppedLogged.has(key)) {
        droppedLogged.add(key);
        if (wrongGuild) {
          log.info(`dropping #${policyChannelName} (${policyChannelId}) — claimed by guild ${message.guildId} but configured under ${policy.guild.slug}`);
        } else {
          log.info(`dropping #${policyChannelName} (${policyChannelId}) in ${policy.guild.slug} — deafened`);
        }
      }
      return;
    }
 // Escape hatch: batching disabled (ambient_tick_ms: 0) → every non-drop
 // message wakes, matching today's behavior — but a killswitch-muted
 // channel (or its thread parent) must still NEVER wake, so re-check
 // muteType directly here rather than trusting the classifier's 'ambient'
 // downgrade alone.
    if (config.discord.ambientTickMs === 0 && cls === 'ambient' && muteType(policyChannelId) === null) {
      cls = 'wake';
    }

 // enqueue onto the agent's inbound queue (the loop drains it — we do NOT
 // handle messages synchronously per-event; the loop is a single driver).
 // Ambient messages still enter history in full; they just don't wake a
 // turn — restraint lives in wakeClass, not in prompt instructions.
    agent.enqueue({
      id: message.id,
      channelId: message.channelId,
      channelName,
      author: identity.author,
      authorId: identity.authorId,
 // Mention markup is rewritten to readable names HERE, at the single
 // ingest point, so history/transcript/console all carry the same body.
      content: resolveMentions(message.content, mentionNamesFor(message)),
      createdAt: message.createdAt.toISOString(),
      replyTo,
      forwarded: (() => {
            const snaps = (message as unknown as { messageSnapshots?: { first?: () => { author?: { displayName?: string; username?: string }; channel?: { name?: string }; content?: string } | null } }).messageSnapshots;
            const snap = snaps?.first?.() ?? null;
            return snap
              ? {
                  author: snap.author?.displayName || snap.author?.username || 'unknown',
                  channelName: snap.channel?.name || null,
                  content: resolveMentions(snap.content ?? '', mentionNamesFor(snap as unknown as Message)),
                }
              : null;
          })(),
      mentions: [
        ...message.mentions.users.map((u) => `@${u.displayName || u.username}`),
        ...message.mentions.roles.map((r) => `@${r.name}`),
      ],
 // Regular attachments first, then any first-use custom emote/sticker
 // images (src/discord/emotes.ts) — both ride the same envelope +
 // image-content-part pipeline. collect never throws (warn + skip
 // inside) and runs on the RAW content: mention rewriting doesn't touch
 // emote markup, and the sticker list comes off the gateway message.
      attachments: [
        ...await buildInboundAttachments(message, config.discord.attachmentInlineMaxBytes, log),
        ...(deps?.emotes
          ? await deps.emotes.collect({
              content: message.content,
 // absence-tolerant like mentionNamesFor: a partial message's
 // missing collection must cost the sticker, not the message.
              stickers: [...(message.stickers?.values() ?? [])].map((s) => ({ id: s.id, name: s.name, format: s.format })),
            })
          : []),
      ],
      guildId: message.guildId,
      guildSlug: policy.guild.slug,
      bot: authorIsBot,
      kind: 'discord',
      wakeClass: cls,
 // The resolved POLICY channel (a thread's parent) — Agent.fireAmbientTick
 // checks countsForTick against this, never the message's own channelId,
 // since the guild index only knows configured, non-thread channels.
      policyChannelId,
    });

 // The typing indicator fires ONLY on immediate-wake events — showing
 // "<agent> is typing…" while friends chat among themselves would be the most
 // visible possible form of an annoying bot and undercut the wake gate. A
 // single non-repeating shot here (Discord's own indicator lasts ~10s)
 // covers the gap until the loop's onThinking hook (agent.ts) starts the
 // proper repeating indicator once it actually begins the LLM call — reuses
 // the channel object already in hand (no cache/fetch needed) and the SAME
 // gate constant (typingGuildId) the repeating typing above uses.
    if (cls === 'wake' && policy.guild.id === typingGuildId && policy.allowSend) {
      fireTypingOn(channel);
    }
  });

 // Feedback capture: 👍/👎 on one of the bot's OWN messages is recorded
 // out-of-band (elpis.db feedback table) as a good/bad signal for later review.
 // Never touches the conversation transcript or the agent's history. Fully
 // guarded — a feedback failure must never disturb the gateway or the loop.
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.id === client.user?.id) return; // ignore our own reactions early
 // Old/uncached messages arrive partial — hydrate before inspecting.
      if (reaction.partial) { await reaction.fetch(); }
      if (reaction.message.partial) { await reaction.message.fetch(); }
      if (user.partial) { try { await user.fetch(); } catch { /* name falls back below */ } }
      const msg = reaction.message;
      if (!msg.guildId || !config.discord.guilds.some((g) => g.id === msg.guildId)) return;
      const verdict = reactionVerdict({
        botUserId: client.user?.id,
        reactorId: user.id,
        messageAuthorId: msg.author?.id,
        emojiName: reaction.emoji.name,
      });
      if (!verdict) return;
      if (!deps?.feedback) return;
      const channel = msg.channel;
      const channelName =
        'name' in channel && typeof channel.name === 'string' ? channel.name : null;
      deps.feedback.recordReaction({
        verdict,
        reactedAt: new Date().toISOString(),
        emoji: reaction.emoji.name ?? '',
        reactorId: user.id,
        reactorName: user.displayName || user.username || null,
        isOwner: isAuthorizedOperator(config, user.id),
        discordMessageId: msg.id,
        channelId: msg.channelId,
        channelName,
        messageContent: msg.content ?? '',
      });
      log.info(`feedback ${verdict} on #${msg.channelId} msg ${msg.id} from <${user.id}>`);
    } catch (e) {
      log.warn(`reaction handler failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guildId || !config.discord.guilds.some((g) => g.id === interaction.guildId)) return;
    const name = interaction.commandName as SlashCommandName;
    if (!SLASH_COMMAND_NAMES.includes(name)) return;

    log.info(`slash command /${name} from <${interaction.user.id}>`);

 // Every slash command is operator-gated — hoisted here so it covers all
 // uniformly (there is exactly one gate; do not add per-command
 // checks below). Defense in depth: a guild opts into `slash_commands: true`
 // independently of who's a member of it, so this is what stops a mistaken
 // opt-in on a friend server from exposing a destructive command (/clear
 // wipes the agent's entire working memory) to that server's members. A distinct
 // "disabled" message vs. "not authorized" — see operatorGateReason — and
 // note the deliberate consequence: if operator.discord_id is ever unset,
 // /clear, /new and /compact become unusable by ANYONE rather than usable
 // by everyone as before. For commands that wipe working memory, failing
 // closed is correct.
    if (!isAuthorizedOperator(config, interaction.user.id)) {
      await safeReply(log, name, () =>
        interaction.reply({ content: operatorGateReason(config, name), flags: MessageFlags.Ephemeral }));
      return;
    }

    if (name === 'mind') {
      if (!isMindHomeGuild(config, interaction.guildId)) {
        await safeReply(log, name, () => interaction.reply({ content: 'Mind is private to the home guild.', flags: MessageFlags.Ephemeral }));
        return;
      }
      if (!deps?.mind) {
        await safeReply(log, name, () => interaction.reply({ content: 'Mind is not wired in this harness.', flags: MessageFlags.Ephemeral }));
        return;
      }
      const mind = deps.mind;
      const actor = `discord:${interaction.user.username}`;
      try {
        const sub = interaction.options.getSubcommand(true);
        const id = () => parseMindId(interaction.options.getString('id', true));
        let content: string;
        if (sub === 'list') {
          const view = interaction.options.getString('view') ?? 'ready';
          const filter: MindListFilter = {
            query: interaction.options.getString('query') ?? undefined,
            sort: (interaction.options.getString('sort') ?? 'updated_desc') as MindSort,
            limit: interaction.options.getInteger('limit') ?? 20,
          };
          if (view === 'ready') filter.ready = true;
          else if (view === 'blocked') filter.blocked = true;
          else if (view === 'waiting') filter.statuses = ['waiting'];
          else if (view === 'done') filter.statuses = ['done'];
          else if (view === 'overdue') filter.overdue = true;
          else if (view === 'inbox') filter.statuses = ['inbox'];
          else if (view === 'active') filter.statuses = ['inbox', 'open', 'in_progress', 'waiting'];
          else if (view === 'all') filter.includeArchived = true;
          content = formatMindList(mind.list(filter), `mind · ${view}`);
        } else if (sub === 'read') {
          const item = mind.get(id());
          if (!item) throw new Error('item not found');
          content = truncateMindReply(formatMindDetail(item));
        } else if (sub === 'add') {
          const dueRaw = interaction.options.getString('due');
          const remindRaw = interaction.options.getString('remind');
          const item = mind.create({
            title: interaction.options.getString('title', true),
            body: interaction.options.getString('details') ?? undefined,
            kind: (interaction.options.getString('kind') ?? undefined) as MindKind | undefined,
            priority: interaction.options.getInteger('priority') ?? undefined,
            parentId: interaction.options.getString('parent') ? parseMindId(interaction.options.getString('parent')!) : undefined,
            dependsOn: parseDiscordMindIds(interaction.options.getString('depends_on')),
            dueAt: dueRaw ? parseDiscordMindTime(dueRaw, 'due') : undefined,
            remindAt: remindRaw ? parseDiscordMindTime(remindRaw, 'remind') : undefined,
            reminderChannelId: interaction.channelId,
            tags: interaction.options.getString('tags')?.split(',').map((x) => x.trim()).filter(Boolean),
            actor,
          });
          const guild = config.discord.guilds.find((g) => g.id === interaction.guildId)!;
          const policyChannelId = interaction.channel?.isThread()
            ? interaction.channel.parentId ?? interaction.channelId
            : interaction.channelId;
          agent.enqueue(mindAddAmbientNotice(item, {
            channelId: interaction.channelId,
            policyChannelId,
            channelName: channelDisplayName(interaction.channel),
            guildId: interaction.guildId,
            guildSlug: guild.slug,
          }));
          content = `added\n${formatMindLine(item)}`;
        } else if (sub === 'edit') {
          const patch: Parameters<MindService['update']>[1] = {};
          const title = interaction.options.getString('title'); if (title !== null) patch.title = title;
          const details = interaction.options.getString('details'); if (details !== null) patch.body = details;
          const status = interaction.options.getString('status'); if (status !== null) patch.status = status as MindStatus;
          const priority = interaction.options.getInteger('priority'); if (priority !== null) patch.priority = priority;
          const due = interaction.options.getString('due'); if (due !== null) patch.dueAt = due.toLowerCase() === 'clear' ? null : parseDiscordMindTime(due, 'due');
          const tags = interaction.options.getString('tags'); if (tags !== null) patch.tags = tags.split(',').map((x) => x.trim()).filter(Boolean);
          content = `updated\n${formatMindLine(mind.update(id(), patch, actor))}`;
        } else if (sub === 'done' || sub === 'start' || sub === 'wait') {
          const itemId = id();
          const comment = interaction.options.getString('comment');
          if (comment) mind.addComment(itemId, comment, actor);
          const status: MindStatus = sub === 'done' ? 'done' : sub === 'start' ? 'in_progress' : 'waiting';
          content = `${sub}\n${formatMindLine(mind.setStatus(itemId, status, actor))}`;
        } else if (sub === 'comment') {
          const itemId = id();
          const comment = mind.addComment(itemId, interaction.options.getString('text', true), actor);
          content = `comment c#${comment.id} added to #${itemId}`;
        } else if (sub === 'link' || sub === 'unlink') {
          const itemId = id();
          const dep = parseMindId(interaction.options.getString('depends_on', true));
          const item = sub === 'link' ? mind.addDependency(itemId, dep, actor) : mind.removeDependency(itemId, dep, actor);
          content = `${sub === 'link' ? 'linked' : 'unlinked'}\n${formatMindLine(item)}`;
        } else if (sub === 'remind') {
          const itemId = id();
          const reminder = mind.addReminder(itemId, parseDiscordMindTime(interaction.options.getString('when', true), 'when'), actor, interaction.channelId);
          content = `reminder r#${reminder.id} scheduled for #${itemId} at ${new Date(reminder.fireAt).toISOString()}`;
        } else if (sub === 'graph') {
          const graph = mind.graph(id(), interaction.options.getInteger('depth') ?? 4);
          content = truncateMindReply(`mind graph · root #${graph.rootId}\n${graph.nodes.map(formatMindLine).join('\n')}\n\nedges\n${graph.edges.map((e) => `#${e.from} —${e.type}→ #${e.to}`).join('\n') || '(none)'}`);
        } else if (sub === 'archive') {
          content = `archived\n${formatMindLine(mind.archive(id(), actor))}`;
        } else {
          throw new Error(`unknown mind subcommand ${sub}`);
        }
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch (error) {
        await safeReply(log, name, () => interaction.reply({ content: `Mind: ${error instanceof Error ? error.message : String(error)}`, flags: MessageFlags.Ephemeral }));
      }
      return;
    }

 // /clear and /new wipe the WHOLE mind ( monocontext), so they require an
 // explicit confirmation: an ephemeral embed + Confirm/Cancel buttons. The
 // button press is re-checked against the invoking user id; a ~30s collector
 // timeout auto-cancels. Only on confirm: agent.clearContext.
    if (name === 'clear' || name === 'new') {
      const uid = interaction.user.id;
      const embed = new EmbedBuilder()
        .setTitle('Wipe the agent\'s working memory?')
        .setDescription(
          'This wipes the agent\'s entire working memory across ALL servers and channels — not just this ' +
          'one. It is one continuous history. Files (MEMORY.md, people/, ponder/, NOW.md) survive; ' +
          'the live conversation does not.',
        );
      const confirm = new ButtonBuilder().setCustomId(clearConfirmCustomId(uid)).setLabel('Wipe').setStyle(ButtonStyle.Danger);
      const cancel = new ButtonBuilder().setCustomId(clearCancelCustomId(uid)).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);
      try {
        const reply = await interaction.reply({
          embeds: [embed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true,
        });
        const msg = reply.resource?.message;
        if (!msg) return;
        const press = await msg.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.user.id === uid,
          time: 30_000,
        }).catch(() => null);
        const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          ButtonBuilder.from(confirm).setDisabled(true),
          ButtonBuilder.from(cancel).setDisabled(true),
        );
        if (press && press.customId === clearConfirmCustomId(uid)) {
          agent.clearContext();
          await press.update({ content: 'Working memory wiped.', embeds: [], components: [disabledRow] });
        } else if (press) {
          await press.update({ content: 'Cancelled — nothing was wiped.', embeds: [], components: [disabledRow] });
        } else {
          await interaction.editReply({ content: 'Confirmation timed out — nothing was wiped.', embeds: [], components: [disabledRow] });
        }
      } catch (e) {
        log.warn(`failed to run /${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

 // /clear-thinking strips ONLY stored provider-native thinking payloads
 // (Anthropic thinking_blocks + OpenAI reasoning_items) from the whole
 // history — the escape hatch after a model/provider switch, whose old
 // signatures/blobs would otherwise 400 on replay. Same confirm-button flow
 // as /clear; non-destructive to the conversation.
    if (name === 'clear-thinking') {
      const uid = interaction.user.id;
      const embed = new EmbedBuilder()
        .setTitle('Clear stored provider thinking?')
        .setDescription(
          'This removes the agent\'s stored native thinking payloads (Anthropic thinking blocks and ' +
          'OpenAI/Codex encrypted reasoning items) from the whole history, in memory and on disk. The ' +
          'conversation, memory, readable reasoning, and tool history are untouched. Use it after switching ' +
          'models or providers, when old signatures are no longer valid.',
        );
      const confirm = new ButtonBuilder().setCustomId(clearThinkingConfirmCustomId(uid)).setLabel('Clear thinking').setStyle(ButtonStyle.Danger);
      const cancel = new ButtonBuilder().setCustomId(clearThinkingCancelCustomId(uid)).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);
      try {
        const reply = await interaction.reply({
          embeds: [embed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true,
        });
        const msg = reply.resource?.message;
        if (!msg) return;
        const press = await msg.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.user.id === uid,
          time: 30_000,
        }).catch(() => null);
        const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          ButtonBuilder.from(confirm).setDisabled(true),
          ButtonBuilder.from(cancel).setDisabled(true),
        );
        if (press && press.customId === clearThinkingConfirmCustomId(uid)) {
          const n = agent.clearThinking();
          await press.update({ content: `Provider thinking cleared (${n} message${n === 1 ? '' : 's'} affected).`, embeds: [], components: [disabledRow] });
        } else if (press) {
          await press.update({ content: 'Cancelled — nothing was cleared.', embeds: [], components: [disabledRow] });
        } else {
          await interaction.editReply({ content: 'Confirmation timed out — nothing was cleared.', embeds: [], components: [disabledRow] });
        }
      } catch (e) {
        log.warn(`failed to run /${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

 // /compact triggers a compaction cycle (non-destructive). Consumed at the
 // loop-top checkpoint (or immediately when idle) — never started here
 // directly (that could orphan pending tool results, review B2).
    if (name === 'compact') {
      const { tokens } = agent.compactNow();
      await safeReply(log, name, () =>
        interaction.reply({
          content: `Compaction requested — it starts at the next checkpoint; currently ${tokens} tokens.`,
          flags: MessageFlags.Ephemeral,
        }));
      return;
    }

 // killswitch commands: /mute /unmute /deafen /undeafen — operator gate
 // already applied above. Agent.moderateChannel is the SINGLE
 // implementation of every transition (also used by the console's
 // moderate button and the sandbox self-mute); this handler only resolves
 // the channel ref and forwards to it — see docs/architecture.md's "the
 // killswitch" section.
    if (name === 'mute' || name === 'unmute' || name === 'deafen' || name === 'undeafen') {
      const ref = interaction.options.getString('channel', true);
 // Only mute/deafen declare a `reason` option — unmute/undeafen don't, so
 // don't read it for them (reading an undeclared option happens to return
 // null today, but that's incidental, not a contract to lean on).
      const reason = (name === 'mute' || name === 'deafen')
        ? (interaction.options.getString('reason') ?? undefined)
        : undefined;
      const result = resolveModerationCommand(agent, name, ref, reason);
      await safeReply(log, name, () => interaction.reply({ content: result.note, flags: MessageFlags.Ephemeral }));
      return;
    }

 // /exec, /restart, /usage and /cache — operator gate already applied above.
    if (name === 'usage') {
      await safeReply(log, name, async () => {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const snap = deps?.usage ? await deps.usage() : null;
        await interaction.editReply({ content: formatUsageBars(snap) });
      });
      return;
    }

    if (name === 'cache') {
      await safeReply(log, name, () =>
        interaction.reply({
          content: formatCacheBars(agent.usageSnapshot().cache),
          flags: MessageFlags.Ephemeral,
        }));
      return;
    }

    if (name === 'exec') {
      const code = interaction.options.getString('code') ?? '';
      if (!code.trim()) {
        await safeReply(log, name, () => interaction.reply({ content: 'No code provided.', flags: MessageFlags.Ephemeral }));
        return;
      }
      log.debug(`/exec code: ${code.split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);
      const result = await agent.execSandbox(code);
      const out = formatExecResult(result);
      await safeReply(log, name, () => interaction.reply({ content: out, flags: MessageFlags.Ephemeral }));
      return;
    }

    if (name === 'restart') {
 // Flush the transcript so the on-disk record is complete before the
 // process is killed. The reply is sent first (ephemeral) so the operator
 // sees confirmation before the connection drops.
      await safeReply(log, name, () =>
        interaction.reply({ content: 'Restarting harness — back in a moment…', flags: MessageFlags.Ephemeral }));
      log.info('/restart: flushing transcripts and triggering service restart');
      try {
        agent.flushTranscripts();
      } catch (e) {
        log.warn(`/restart: transcript flush failed: ${e instanceof Error ? e.message : String(e)}`);
      }
 // Defer the actual restart to the next tick so the reply has a chance to
 // flush over the gateway before the process exits.
      setTimeout(() => {
        try {
          restartHook();
        } catch (e) {
          log.error(`/restart: restart hook threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }, 500);
      return;
    }
  });

 // wire agent.send → channel.send with chunking. isTextBased narrows to a
 // union that still includes non-sendable partials, so re-check 'send' at
 // runtime — the only fully type-safe narrowing discord.js v14 offers here.
  const send = async (channelId: string, text: string, opts?: { files?: { path: string; name?: string }[] }) => {
    log.debug(`outbound send #${channelId} (${text.length} chars)`);
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;
    const isThread = 'isThread' in channel && typeof channel.isThread === 'function' && channel.isThread();
    const parentId = isThread && 'parentId' in channel ? channel.parentId : null;
    const policyChannelId = resolvePolicyChannelId(channelId, isThread, typeof parentId === 'string' ? parentId : null);
    const guildId = 'guildId' in channel && typeof channel.guildId === 'string' ? channel.guildId : null;
    const configPolicy = resolveChannelPolicy(guildId, policyChannelId, guildIndex);
    if (configPolicy && !configPolicy.allowSend) {
      throw new Error(`sending to #${channelDisplayName(channel)} is disabled by configuration (${configPolicy.sendDeniedBy} allow_send=false)`);
    }
 // Rewrite @Name → <@id> against the target channel's own guild directory
 // (a DM/uncached channel has no 'guild' — outboundMentionDirectory(null)
 // is a no-op map, so text passes through unchanged).
    const guild = 'guild' in channel ? (channel.guild as Guild | undefined) : undefined;
    const outboundText = applyOutboundMentions(text, outboundMentionDirectory(guild));
    const chunks = chunkText(outboundText);
    const attachments = (opts?.files || []).map((f) => {
      const name = f.name || path.basename(f.path);
      return new AttachmentBuilder(f.path, { name });
    });
    for (let i = 0; i < chunks.length; i++) {
      const payload: { content: string; files?: AttachmentBuilder[] } = { content: chunks[i] };
      if (i === 0 && attachments.length > 0) payload.files = attachments;
      await channel.send(payload);
    }
  };

 // wire the agent's send → channel.send with chunking
  agent.setSend(send);

  return {
    client,
    async start(): Promise<void> {
      await client.login(config.discord.botToken);
      await registerSlashCommands(config);
    },
    typing,
    stopTyping,
  };
}

/** The real /restart side effect: spawn `systemctl --user restart elpis-harness`
 * detached so it survives this process's exit. Uses spawn (not spawnSync) so
 * the gateway has time to flush the ephemeral reply. */
function defaultRestartHook(config: Config): () => void {
  const log = config.logger;
  return () => {
    log.info('/restart: executing systemctl --user restart elpis-harness');
    const child = restartHarnessService();
    child.on('error', (e: Error) => {
      log.error(`/restart: systemctl spawn failed: ${e.message}`);
    });
  };
}

/**
 * Register the guild slash commands. Guild-scoped registration is instant (no
 * propagation delay) and avoids the 1-hour global cache. Idempotent — re-running
 * overwrites in place.
 */
async function registerSlashCommands(config: Config): Promise<void> {
  const commands = buildCommandDefinitions();
  const rest = new REST({ version: '10' }).setToken(config.discord.botToken);
  const optedIn = config.discord.guilds.filter((x) => x.slashCommands);
  if (optedIn.length === 0) {
    config.logger.info('slash command registration: no guild has `slash_commands: true` set — skipping registration entirely');
    return;
  }
  for (const g of optedIn) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.discord.applicationId, g.id), { body: commands });
      config.logger.info(`registered slash commands: ${SLASH_COMMAND_NAMES.join(', ')} (guild ${g.id})`);
    } catch (e) {
      config.logger.warn(`slash command registration failed for guild ${g.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
