// wake.ts — the pure wake decision for multi-server ingest.
// classifyInbound is a pure function of (message facts, config index, mute
// state): 'wake' starts a turn now, 'ambient' enters history and rides the
// tick, 'drop' never enters the harness. Quiet hours deliberately do NOT
// appear here: direct/mention/reply wake through them, and ambient messages
// never wake directly — quiet hours only suppress the TICK, evaluated at tick
// time by countsForTick so overnight chat surfaces when the window opens.
//
// mute is silent-but-listening, not deafen-lite: a direct-tier message or an
// explicit @mention/reply still classifies 'wake' under mute (the agent can choose
// not to reply, but must be able to hear a direct address); non-addressed
// ambient chatter in a muted channel stays 'ambient' same as unmuted. Only
// 'deafen' drops ingest outright.
//
// quietHours where start === end (e.g. "0900-0900") takes the start <= end
// branch of inQuietHours, where `cur >= X && cur < X` is always false — so a
// degenerate window silently means "never quiet", not "all day". Config
// currently accepts this without complaint; rejecting it is a later concern.
//
// guild.timezone === null means the HOST timezone: inQuietHours omits the
// Intl.DateTimeFormat `timeZone` option entirely rather than defaulting to
// UTC (see src/config.ts, where the same fallback is documented).
//
// buildGuildIndex is last-wins on a duplicate channel id or guild slug across
// guilds — config validation already rejects both at parse time, so this is
// a note about the function's own contract, not a live hazard.

import type { GuildConfig, ChannelMode } from '../config.js';
import type { MuteType } from '../store/mutes.js';

export type WakeClass = 'wake' | 'ambient' | 'drop';
export type SendDeniedBy = 'guild' | 'channel' | 'default' | null;
export interface ChannelPolicy {
  guild: GuildConfig;
  tier: ChannelMode;
  allowSend: boolean;
  sendDeniedBy: SendDeniedBy;
  source: 'channel' | 'default';
}
export interface GuildIndex {
  byChannel: Map<string, ChannelPolicy>;
  byGuildId: Map<string, GuildConfig>;
  bySlug: Map<string, GuildConfig>;
}

function policyFor(
  guild: GuildConfig,
  channelId: string,
  tier: ChannelMode,
  source: 'channel' | 'default',
): ChannelPolicy {
  const guildAllows = guild.allowSend !== false;
  const localAllows =
    source === 'channel'
      ? guild.channelAllowSend?.[channelId] !== false
      : guild.defaultAllowSend === true;
  return {
    guild,
    tier,
    source,
    allowSend: guildAllows && localAllows,
    sendDeniedBy: !guildAllows ? 'guild' : localAllows ? null : source,
  };
}

export function buildGuildIndex(guilds: GuildConfig[]): GuildIndex {
  const byChannel = new Map<string, ChannelPolicy>();
  const byGuildId = new Map<string, GuildConfig>();
  const bySlug = new Map<string, GuildConfig>();
  for (const g of guilds) {
    byGuildId.set(g.id, g);
    bySlug.set(g.slug, g);
    for (const [cid, tier] of Object.entries(g.channels))
      byChannel.set(cid, policyFor(g, cid, tier, 'channel'));
  }
  return { byChannel, byGuildId, bySlug };
}

export function resolveChannelPolicy(
  guildId: string | null | undefined,
  channelId: string,
  index: GuildIndex,
): ChannelPolicy | null {
  const explicit = index.byChannel.get(channelId);
  if (explicit)
    return guildId && explicit.guild.id !== guildId ? null : explicit;
  if (!guildId) return null;
  const guild = index.byGuildId.get(guildId);
  return guild
    ? policyFor(guild, channelId, guild.defaultTier ?? 'drop', 'default')
    : null;
}

export interface WakeInput {
  guildId: string;
  channelId: string;
  authorIsBot: boolean;
  mentionsMe: boolean;
  replyToMe: boolean;
}
export type MuteLookup = (channelId: string) => MuteType | null;

export function classifyInbound(
  input: WakeInput,
  index: GuildIndex,
  muteType: MuteLookup,
): WakeClass {
  const policy = resolveChannelPolicy(input.guildId, input.channelId, index);
  if (!policy || policy.tier === 'drop') return 'drop';
  const mute = muteType(input.channelId);
  if (mute === 'deafen') return 'drop';
  if (input.authorIsBot) return 'ambient'; // agents never wake immediately (§6)
  const addressed =
    policy.tier === 'direct' || input.mentionsMe || input.replyToMe;
  // mute = silent-but-listening: a DIRECT address still wakes (the agent can choose
  // not to reply, but must be able to hear a ping); ambient chatter does not.
  // Only deafen drops ingest. ( — the old blanket
  // `if (mute) return 'ambient'` made mute behave as deafen-lite.)
  if (addressed) return 'wake';
  return 'ambient'; // social/quiet, or muted-non-addressed
}

// Keyed by timezone (the host timezone's slot key is '' since guild.timezone
// is null in that case) — inQuietHours is called once per pending ambient
// message inside a tick, and a fresh Intl.DateTimeFormat per call was
// measured ~150x slower than reusing one.
const hourMinuteFormatters = new Map<string, Intl.DateTimeFormat>();
function hourMinuteFormatter(timezone: string | null): Intl.DateTimeFormat {
  const key = timezone ?? '';
  let fmt = hourMinuteFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(timezone ? { timeZone: timezone } : {}),
    });
    hourMinuteFormatters.set(key, fmt);
  }
  return fmt;
}

export function inQuietHours(guild: GuildConfig, now: Date): boolean {
  if (!guild.quietHours) return false;
  const fmt = hourMinuteFormatter(guild.timezone);
  const [h, m] = fmt.format(now).split(':').map(Number);
  const cur = h * 60 + m;
  const { start, end } = guild.quietHours;
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Would an ambient message in this channel count toward firing the tick, right now? */
export function countsForTick(
  channelId: string,
  index: GuildIndex,
  muteType: MuteLookup,
  now: Date,
  guildId?: string | null,
): boolean {
  const policy = resolveChannelPolicy(
    guildId ?? index.byChannel.get(channelId)?.guild.id,
    channelId,
    index,
  );
  if (!policy || policy.tier === 'drop' || policy.tier === 'quiet')
    return false;
  if (muteType(channelId) !== null) return false;
  if (inQuietHours(policy.guild, now)) return false;
  return true;
}
