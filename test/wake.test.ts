import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuildIndex, classifyInbound, inQuietHours, countsForTick, resolveChannelPolicy } from '../src/discord/wake.js';
import type { GuildConfig } from '../src/config.js';

const guilds: GuildConfig[] = [
  { id: 'g1', slug: 'home', slashCommands: true, quietHours: null, timezone: null,
    channels: { '1001': 'direct', '1002': 'social', '1003': 'quiet' } },
  { id: 'g2', slug: 'friends-a', slashCommands: false,
    quietHours: { start: 23 * 60, end: 9 * 60 }, timezone: 'UTC',
    channels: { '2001': 'social' } },
  { id: 'g3', slug: 'friends-b', slashCommands: false,
    quietHours: { start: 0, end: 8 * 60 }, timezone: 'UTC',
    channels: { '3001': 'social' } },
  { id: 'g4', slug: 'friends-c', slashCommands: false,
    quietHours: { start: 23 * 60, end: 9 * 60 }, timezone: 'America/New_York',
    channels: { '4001': 'social' } },
];
const idx = buildGuildIndex(guilds);
const noMutes = () => null;
const human = { authorIsBot: false, mentionsMe: false, replyToMe: false };

test('wake: direct channel wakes immediately', () => {
  assert.equal(classifyInbound({ ...human, guildId: 'g1', channelId: '1001' }, idx, noMutes), 'wake');
});
test('wake: mention or reply wakes on any tier', () => {
  assert.equal(classifyInbound({ ...human, mentionsMe: true, guildId: 'g1', channelId: '1002' }, idx, noMutes), 'wake');
  assert.equal(classifyInbound({ ...human, replyToMe: true, guildId: 'g1', channelId: '1003' }, idx, noMutes), 'wake');
});
test('wake: social otherwise ambient; quiet ambient', () => {
  assert.equal(classifyInbound({ ...human, guildId: 'g1', channelId: '1002' }, idx, noMutes), 'ambient');
  assert.equal(classifyInbound({ ...human, guildId: 'g1', channelId: '1003' }, idx, noMutes), 'ambient');
});
test('wake: bots never wake immediately — even mention in a direct channel', () => {
  assert.equal(classifyInbound({ authorIsBot: true, mentionsMe: true, replyToMe: false, guildId: 'g1', channelId: '1001' }, idx, noMutes), 'ambient');
});
test('wake: killswitch deafen drops everything', () => {
  const deaf = (id: string) => (id === '1001' ? 'deafen' as const : null);
  assert.equal(classifyInbound({ ...human, mentionsMe: true, guildId: 'g1', channelId: '1001' }, idx, deaf), 'drop');
});
test('mute: direct-tier message still wakes', () => {
  const muted = () => 'mute' as const;
  assert.equal(classifyInbound({ ...human, guildId: 'g1', channelId: '1001' }, idx, muted), 'wake');
});
test('mute: @mention in a social channel still wakes', () => {
  const muted = () => 'mute' as const;
  assert.equal(classifyInbound({ ...human, mentionsMe: true, guildId: 'g1', channelId: '1002' }, idx, muted), 'wake');
});
test('mute: reply in a quiet-tier channel still wakes', () => {
  const muted = () => 'mute' as const;
  assert.equal(classifyInbound({ ...human, replyToMe: true, guildId: 'g1', channelId: '1003' }, idx, muted), 'wake');
});
test('mute: non-addressed social chatter stays ambient', () => {
  const muted = () => 'mute' as const;
  assert.equal(classifyInbound({ ...human, guildId: 'g1', channelId: '1002' }, idx, muted), 'ambient');
});
test('mute: bots still never wake immediately, even on direct tier', () => {
  const muted = () => 'mute' as const;
  assert.equal(classifyInbound({ authorIsBot: true, mentionsMe: true, replyToMe: false, guildId: 'g1', channelId: '1001' }, idx, muted), 'ambient');
});
test('deafen: everything drops, even direct-tier mention', () => {
  const deaf = () => 'deafen' as const;
  assert.equal(classifyInbound({ ...human, mentionsMe: true, guildId: 'g1', channelId: '1001' }, idx, deaf), 'drop');
});
test('wake: unlisted channel in configured guild drops; unconfigured guild drops', () => {
  assert.equal(classifyInbound({ ...human, guildId: 'g1', channelId: '9999' }, idx, noMutes), 'drop');
  assert.equal(classifyInbound({ ...human, guildId: 'nope', channelId: '1001' }, idx, noMutes), 'drop');
});
test('wake: channel claimed under the wrong (but configured) guild drops', () => {
 // '1001' is g1's channel; a message claiming g2 for it must not match g1's policy.
  assert.equal(classifyInbound({ ...human, guildId: 'g2', channelId: '1001' }, idx, noMutes), 'drop');
});
test('quietHours: wraparound window incl. midnight boundary', () => {
  const g = guilds[1];
  assert.equal(inQuietHours(g, new Date('2026-07-22T23:30:00Z')), true);
  assert.equal(inQuietHours(g, new Date('2026-07-23T00:00:00Z')), true);   // midnight inside 2300-0900
  assert.equal(inQuietHours(g, new Date('2026-07-22T12:00:00Z')), false);
  assert.equal(inQuietHours(g, new Date('2026-07-22T08:59:00Z')), true);
  assert.equal(inQuietHours(g, new Date('2026-07-22T09:00:00Z')), false);  // end exclusive
});
test('quietHours: non-wrapping window (start <= end branch)', () => {
  const g = guilds[2]; // g3: 0000-0800 UTC, no wraparound
  assert.equal(inQuietHours(g, new Date('2026-07-23T00:00:00Z')), true);   // midnight inside 0000-0800
  assert.equal(inQuietHours(g, new Date('2026-07-22T08:00:00Z')), false);  // end exclusive
});
test('quietHours: timezone conversion actually applies', () => {
  const atUtc = new Date('2026-07-22T09:00:00Z');
 // Same instant, same 2300-0900 window: read as UTC it's the (exclusive) end boundary — not
 // quiet. Read in America/New_York (EDT, UTC-4) it's 05:00 local — inside the quiet window.
 // If `timezone` were dropped from the formatter, this would also read false.
  assert.equal(inQuietHours(guilds[1], atUtc), false);   // g2: UTC
  assert.equal(inQuietHours(guilds[3], atUtc), true);    // g4: America/New_York
});
test('countsForTick: social counts; quiet-tier and muted never; quiet-hours suppress at tick time', () => {
  const now = new Date('2026-07-22T12:00:00Z');
  assert.equal(countsForTick('1002', idx, noMutes, now), true);
  assert.equal(countsForTick('1003', idx, noMutes, now), false);
  assert.equal(countsForTick('1002', idx, () => 'mute', now), false);
  assert.equal(countsForTick('2001', idx, noMutes, new Date('2026-07-22T23:30:00Z')), false);
  assert.equal(countsForTick('2001', idx, noMutes, now), true);
  assert.equal(countsForTick('1001', idx, noMutes, now), true);  // direct counts (bot-ambient case)
});

test('wake: guild default tier hears unknown channels while the omitted default still drops', () => {
  const listenGuild: GuildConfig = {
    id: 'g-listen', slug: 'listen', slashCommands: false, quietHours: null, timezone: null,
    defaultTier: 'social', allowSend: true, defaultAllowSend: false,
    channels: {}, channelAllowSend: {},
  };
  const listen = buildGuildIndex([listenGuild]);
  assert.equal(classifyInbound({ ...human, guildId: 'g-listen', channelId: '9999' }, listen, noMutes), 'ambient');
  assert.equal(countsForTick('9999', listen, noMutes, new Date('2026-01-01T12:00:00Z'), 'g-listen'), true);
  assert.equal(classifyInbound({ ...human, guildId: 'g1', channelId: '9999' }, idx, noMutes), 'drop');
});

test('wake: explicit drop overrides a listen-all guild receive default', () => {
  const g: GuildConfig = {
    id: 'g', slug: 'g', slashCommands: false, quietHours: null, timezone: null,
    defaultTier: 'social', allowSend: true, defaultAllowSend: false,
    channels: { '10': 'drop' }, channelAllowSend: { '10': true },
  };
  assert.equal(classifyInbound({ ...human, guildId: 'g', channelId: '10' }, buildGuildIndex([g]), noMutes), 'drop');
});

test('policy: guild master deny dominates explicit allow; explicit channel overrides conservative default', () => {
  const base: GuildConfig = {
    id: 'g', slug: 'g', slashCommands: false, quietHours: null, timezone: null,
    defaultTier: 'social', allowSend: true, defaultAllowSend: false,
    channels: { '20': 'quiet' }, channelAllowSend: { '20': true },
  };
  const open = buildGuildIndex([base]);
  assert.equal(resolveChannelPolicy('g', '99', open)?.allowSend, false);
  assert.equal(resolveChannelPolicy('g', '99', open)?.sendDeniedBy, 'default');
  assert.equal(resolveChannelPolicy('g', '20', open)?.allowSend, true);
  const locked = buildGuildIndex([{ ...base, allowSend: false }]);
  assert.equal(resolveChannelPolicy('g', '20', locked)?.allowSend, false);
  assert.equal(resolveChannelPolicy('g', '20', locked)?.sendDeniedBy, 'guild');
});
