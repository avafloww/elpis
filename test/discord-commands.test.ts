// Unit tests for the pure extracted Discord command helpers:
// buildCommandDefinitions, isAuthorizedOperator, SLASH_COMMAND_NAMES.
//
// These exercise command registration shape + the operator-auth gate WITHOUT a
// Discord client or network — the whole point of extracting them as pure
// top-level functions. Run with: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildCommandDefinitions,
  isAuthorizedOperator,
  isOwnMessage,
  isIgnoredAuthor,
  reactionVerdict,
  wakeInputFor,
  operatorGateReason,
  resolveModerationCommand,
  isMindHomeGuild,
  mindAddAmbientNotice,
  resolveMentions,
  SLASH_COMMAND_NAMES,
} from '../src/discord/discord.js';
import { makeConfig } from './helpers.js';

/** Minimal Config stub — authorization reads the canonical top-level operator id. */
const stubConfig = (discordId: string | null) =>
  makeConfig({ operator: { ...makeConfig().operator, discordId } });

// ---------- SLASH_COMMAND_NAMES ----------

test('SLASH_COMMAND_NAMES: includes clear, new, compact, exec, restart, usage, cache', () => {
  assert.ok(SLASH_COMMAND_NAMES.includes('clear'));
  assert.ok(SLASH_COMMAND_NAMES.includes('new'));
  assert.ok(SLASH_COMMAND_NAMES.includes('compact'));
  assert.ok(SLASH_COMMAND_NAMES.includes('exec'));
  assert.ok(SLASH_COMMAND_NAMES.includes('restart'));
  assert.ok(SLASH_COMMAND_NAMES.includes('usage'));
  assert.ok(SLASH_COMMAND_NAMES.includes('cache'));
  assert.ok(SLASH_COMMAND_NAMES.includes('clear-thinking'));
  assert.ok(SLASH_COMMAND_NAMES.includes('mind'));
  assert.equal(SLASH_COMMAND_NAMES.length, 13, 'exactly thirteen commands');
});

test('SLASH_COMMAND_NAMES includes the killswitch four', () => {
  for (const n of ['mute', 'unmute', 'deafen', 'undeafen']) assert.ok(SLASH_COMMAND_NAMES.includes(n as never));
});

// ---------- buildCommandDefinitions ----------

test('buildCommandDefinitions: returns exactly 13 commands', () => {
  const defs = buildCommandDefinitions();
  assert.equal(defs.length, 13);
  const names = defs.map((d) => d.name);
  assert.deepEqual(names.sort(), [
    'cache', 'clear', 'clear-thinking', 'compact', 'deafen', 'exec', 'mind', 'mute',
    'new', 'restart', 'undeafen', 'unmute', 'usage',
  ]);
});

 test('buildCommandDefinitions: /mind exposes the complete work-graph command surface', () => {
  const mind = buildCommandDefinitions().find((d) => d.name === 'mind');
  assert.ok(mind, '/mind command must be registered');
  const subcommands = mind!.options ?? [];
  assert.deepEqual(subcommands.map((x) => x.name).sort(), [
    'add', 'archive', 'comment', 'done', 'edit', 'graph', 'link', 'list', 'read', 'remind', 'start', 'unlink', 'wait',
  ]);
  const add = subcommands.find((x) => x.name === 'add')!;
  assert.ok((add.options ?? []).some((x) => x.name === 'title' && x.required));
  const list = subcommands.find((x) => x.name === 'list')!;
  const sort = (list.options ?? []).find((x) => x.name === 'sort')!;
  assert.deepEqual(new Set(sort.choices?.map((x) => x.value)), new Set([
    'created_asc', 'created_desc', 'updated_asc', 'updated_desc', 'last_comment_asc', 'last_comment_desc',
  ]));
  const read = subcommands.find((x) => x.name === 'read')!;
  assert.ok((read.options ?? []).some((x) => x.name === 'id' && x.required));
});

test('mindAddAmbientNotice: queues a generic home-private ambient notice without an immediate wake class', () => {
  const notice = mindAddAmbientNotice({
    id: 42, title: 'A thought arrived', body: '', kind: 'idea', status: 'open', effectiveStatus: 'open',
    priority: 2, parentId: null, dueAt: null, createdBy: 'discord:bramble', createdAt: 1, updatedAt: 1,
    lastCommentAt: null, closedAt: null, archivedAt: null, tags: ['thought'], blockedBy: [], blocks: [],
    childCount: 0, commentCount: 0, reminderCount: 0,
  }, { channelId: 'thread', policyChannelId: 'home-parent', channelName: 'ideas', guildId: 'g-home', guildSlug: 'home', createdAt: '2026-08-11T00:00:00Z' });
  assert.equal(notice.wakeClass, 'ambient');
  assert.equal(notice.author, 'mind');
  assert.equal(notice.bot, true);
  assert.equal(notice.policyChannelId, 'home-parent');
  assert.match(notice.content, /#42.*A thought arrived/);
});

test('isMindHomeGuild: requires an explicitly home-slugged configured guild', () => {

  const base = makeConfig();
  const guild = base.discord.guilds[0];
  assert.ok(guild, 'test config must include a guild');
  const home = makeConfig({ discord: { ...base.discord, guilds: [{ ...guild, slug: 'home' }] } });
  assert.equal(isMindHomeGuild(home, guild.id), true);
  const notHome = makeConfig({ discord: { ...base.discord, guilds: [{ ...guild, slug: 'friends' }] } });
  assert.equal(isMindHomeGuild(notHome, guild.id), false);
  assert.equal(isMindHomeGuild(home, 'unknown-guild'), false);
});

test('commands: mute/unmute/deafen/undeafen are defined with a channel option', () => {
  const defs = buildCommandDefinitions();
  for (const name of ['mute', 'unmute', 'deafen', 'undeafen']) {
    const d = defs.find((x) => x.name === name);
    assert.ok(d, `${name} missing`);
    const opts = (d as { options?: { name: string; required?: boolean }[] }).options ?? [];
    assert.ok(opts.some((o) => o.name === 'channel' && o.required));
  }
  assert.ok(buildCommandDefinitions().find((x) => x.name === 'mute')!.options!.some((o: { name: string }) => o.name === 'reason'));
});

test('commands: /deafen also takes an optional reason; /unmute and /undeafen do not', () => {
  const defs = buildCommandDefinitions();
  const deafen = defs.find((x) => x.name === 'deafen')!;
  assert.ok((deafen.options ?? []).some((o) => o.name === 'reason'));
  for (const name of ['unmute', 'undeafen']) {
    const d = defs.find((x) => x.name === name)!;
    assert.ok(!(d.options ?? []).some((o) => o.name === 'reason'), `/${name} should not take a reason`);
  }
});

test('buildCommandDefinitions: /exec has a required "code" string option', () => {
  const defs = buildCommandDefinitions();
  const exec = defs.find((d) => d.name === 'exec');
  assert.ok(exec, '/exec command must be registered');
  const options = exec!.options ?? [];
  const codeOption = options.find((o) => o.name === 'code');
  assert.ok(codeOption, '/exec must have a "code" option');
  assert.equal(codeOption!.type, 3, 'option type 3 = STRING');
  assert.equal(codeOption!.required, true, 'code option must be required');
});

test('buildCommandDefinitions: /clear, /new and /compact take no options (V1 global)', () => {
  const defs = buildCommandDefinitions();
  for (const cmdName of ['clear', 'new', 'compact']) {
    const cmd = defs.find((d) => d.name === cmdName);
    assert.ok(cmd, `/${cmdName} command must be registered`);
    assert.equal((cmd!.options ?? []).length, 0, `/${cmdName} is global, no options`);
  }
});

test('buildCommandDefinitions: /restart exists with no required options', () => {
  const defs = buildCommandDefinitions();
  const restart = defs.find((d) => d.name === 'restart');
  assert.ok(restart, '/restart command must be registered');
  const required = (restart!.options ?? []).filter((o) => o.required);
  assert.equal(required.length, 0, '/restart takes no required options');
});

// ---------- isAuthorizedOperator ----------

test('isAuthorizedOperator: true when userId matches operator.discordId', () => {
  const config = stubConfig('123456789');
  assert.equal(isAuthorizedOperator(config, '123456789'), true);
});

test('isAuthorizedOperator: false when userId does not match', () => {
  const config = stubConfig('123456789');
  assert.equal(isAuthorizedOperator(config, '987654321'), false);
});

test('isAuthorizedOperator: false when operator.discordId is null (command disabled)', () => {
  const config = stubConfig(null);
  assert.equal(isAuthorizedOperator(config, '123456789'), false);
 // Even an empty-string id shouldn't match null.
  assert.equal(isAuthorizedOperator(config, ''), false);
});

// ---------- every slash command is behind the ONE operator gate ----------
//
// The InteractionCreate handler hoists a single `isAuthorizedOperator` +
// `operatorGateReason` check above ALL command dispatch (src/discord.ts) —
// there is no per-command gate anymore. /clear and /new used to be reachable
// by anyone (they wipe the agent's entire working memory across every server);
// /compact too. These tests pin that down at the level of the shared gate
// functions the handler calls, table-driven over SLASH_COMMAND_NAMES so a
// future command added to that list without being covered by the gate can't
// silently regress this.

test('every SLASH_COMMAND_NAMES entry: a non-operator is refused, not authorized', () => {
  const config = stubConfig('the-operator-id');
  for (const name of SLASH_COMMAND_NAMES) {
    assert.equal(isAuthorizedOperator(config, 'someone-else'), false, `${name}: non-operator must be refused`);
    assert.equal(
      operatorGateReason(config, name),
      'You are not authorized to use this command.',
      `${name}: wrong non-operator gate message`,
    );
  }
});

test('every SLASH_COMMAND_NAMES entry: unset operator.discord_id disables the command (distinct message), not "not authorized"', () => {
  const config = stubConfig(null);
  for (const name of SLASH_COMMAND_NAMES) {
    assert.equal(isAuthorizedOperator(config, 'anyone'), false, `${name}: must be refused when unset`);
    const reason = operatorGateReason(config, name);
    assert.equal(reason, `/${name} is disabled (operator.discord_id not set).`, `${name}: wrong disabled message`);
    assert.doesNotMatch(reason, /not authorized/, `${name}: disabled case must not read as "not authorized"`);
  }
});

test('/clear: refused for a non-operator (previously ungated — /clear and /new wipe ALL of the agent\'s working memory)', () => {
  const config = stubConfig('the-operator-id');
  assert.equal(isAuthorizedOperator(config, 'random-guild-member'), false);
  assert.equal(operatorGateReason(config, 'clear'), 'You are not authorized to use this command.');
});

test('/clear: unset operator.discord_id produces the "disabled" message, not "not authorized"', () => {
  const config = stubConfig(null);
  assert.equal(operatorGateReason(config, 'clear'), '/clear is disabled (operator.discord_id not set).');
});

test('/new and /compact: also refused for a non-operator (previously ungated)', () => {
  const config = stubConfig('the-operator-id');
  for (const name of ['new', 'compact'] as const) {
    assert.equal(isAuthorizedOperator(config, 'random-guild-member'), false, `${name}`);
    assert.equal(operatorGateReason(config, name), 'You are not authorized to use this command.', `${name}`);
  }
});

// ---------- ignored author gate (silent pre-ingress filter) ----------

test('isIgnoredAuthor: exact configured ids are dropped and other bots remain visible', () => {
  const ignored = new Set(['222']);
  assert.equal(isIgnoredAuthor(ignored, '222'), true);
  assert.equal(isIgnoredAuthor(ignored, '111'), false);
});

test('ignored authors are gated before every agent-visible message or reaction side effect', () => {
  const source = fs.readFileSync(new URL('../src/discord/discord.ts', import.meta.url), 'utf8');
  const messageStart = source.indexOf('client.on(Events.MessageCreate');
  const reactionStart = source.indexOf('client.on(Events.MessageReactionAdd', messageStart);
  const messageBody = source.slice(messageStart, reactionStart);
  const ignored = messageBody.indexOf('isIgnoredAuthor(ignoredUserIds, message.author.id)');
  assert.ok(ignored >= 0);
  for (const marker of ['isOwnMessage(', 'pluralKit.resolve(', 'log.debug(`inbound message', 'ch.messages.fetch(', 'buildInboundAttachments(']) {
    const position = messageBody.indexOf(marker);
    assert.ok(position > ignored, `${marker} must remain after the ignored-author gate`);
  }
  assert.match(messageBody, /if \(!ref \|\| isIgnoredAuthor\(ignoredUserIds, ref\.author\.id\)\) return null/);

  const reactionBody = source.slice(reactionStart);
  const reactionIgnored = reactionBody.indexOf('isIgnoredAuthor(ignoredUserIds, user.id)');
  assert.ok(reactionIgnored >= 0);
  assert.ok(reactionBody.indexOf('reaction.fetch()') > reactionIgnored);
  assert.ok(reactionBody.indexOf('recordReaction(') > reactionIgnored);
});

// ---------- isOwnMessage (loop guard: self only, other bots allowed) ----------

test('isOwnMessage: true when author id matches the bot user id', () => {
  assert.equal(isOwnMessage('111', '111'), true);
});

test('isOwnMessage: false for another bot account (allowed through)', () => {
 // A different bot account must NOT be skipped — only the bot's own messages are.
  assert.equal(isOwnMessage('111', '222'), false);
});

test('isOwnMessage: false when bot user id is not yet known (client not ready)', () => {
 // Safer to process a possible self-message once than to drop a real one.
  assert.equal(isOwnMessage(undefined, '111'), false);
  assert.equal(isOwnMessage(undefined, undefined), false);
});

// ---------- wakeInputFor (pure classification-input assembly) ----------

test('wakeInputFor: mention of the bot sets mentionsMe true', () => {
  const input = wakeInputFor('g1', 'c1', false, ['bot-id'], null, 'bot-id');
  assert.equal(input.mentionsMe, true);
});

test('wakeInputFor: mention of a DIFFERENT bot does not set mentionsMe', () => {
 // A message that @-mentions some OTHER bot must not be mistaken for a
 // mention of the bot — a comparable harness had this bug: any mentioned bot
 // (not specifically THIS bot) set the flag.
  const input = wakeInputFor('g1', 'c1', false, ['other-bot-id'], null, 'bot-id');
  assert.equal(input.mentionsMe, false);
});

test('wakeInputFor: no mentions at all leaves mentionsMe false', () => {
  const input = wakeInputFor('g1', 'c1', false, [], null, 'bot-id');
  assert.equal(input.mentionsMe, false);
});

test('wakeInputFor: reply to the bot sets replyToMe true', () => {
  const input = wakeInputFor('g1', 'c1', false, [], 'bot-id', 'bot-id');
  assert.equal(input.replyToMe, true);
});

test('wakeInputFor: reply to a different author does not set replyToMe', () => {
  const input = wakeInputFor('g1', 'c1', false, [], 'other-user-id', 'bot-id');
  assert.equal(input.replyToMe, false);
});

test('wakeInputFor: no reply (null) leaves replyToMe false', () => {
  const input = wakeInputFor('g1', 'c1', false, [], null, 'bot-id');
  assert.equal(input.replyToMe, false);
});

test('wakeInputFor: passes guildId, channelId and authorIsBot through verbatim', () => {
  const input = wakeInputFor('g1', 'c1', true, [], null, 'bot-id');
  assert.equal(input.guildId, 'g1');
  assert.equal(input.channelId, 'c1');
  assert.equal(input.authorIsBot, true);
});

test('wakeInputFor: unknown bot id (client not ready) fails TOWARD waking — a mention or reply still counts', () => {
 // Fix 4: passing '' as botUserId made mentionsMe/replyToMe unconditionally
 // false (nothing ever equals ''), silently downgrading a direct @mention to
 // ambient. undefined must instead treat any mention/reply as possibly-us.
  const mentioned = wakeInputFor('g1', 'c1', false, ['some-user-id'], null, undefined);
  assert.equal(mentioned.mentionsMe, true);
  const repliedTo = wakeInputFor('g1', 'c1', false, [], 'some-user-id', undefined);
  assert.equal(repliedTo.replyToMe, true);
});

test('wakeInputFor: unknown bot id with no mention/reply present stays false (nothing to fail toward)', () => {
  const input = wakeInputFor('g1', 'c1', false, [], null, undefined);
  assert.equal(input.mentionsMe, false);
  assert.equal(input.replyToMe, false);
});

// ---------- resolvePolicyChannelId + channelDisplayName (thread → parent policy inheritance) ----------

test('resolvePolicyChannelId: a thread resolves to its parent id', async () => {
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  assert.equal(resolvePolicyChannelId('thread-1', true, 'parent-1'), 'parent-1');
});

test('resolvePolicyChannelId: a non-thread resolves to its own id, ignoring any parentId', async () => {
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  assert.equal(resolvePolicyChannelId('chan-1', false, 'irrelevant'), 'chan-1');
});

test('resolvePolicyChannelId: a thread with no resolvable parent id falls back to its own id', async () => {
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  assert.equal(resolvePolicyChannelId('thread-orphan', true, null), 'thread-orphan');
});

test('channelDisplayName: reads .name off a duck-typed channel object; "unknown" when absent/null', async () => {
  const { channelDisplayName } = await import('../src/discord/discord.js');
  assert.equal(channelDisplayName({ name: 'general' }), 'general');
  assert.equal(channelDisplayName(null), 'unknown');
  assert.equal(channelDisplayName({}), 'unknown');
  assert.equal(channelDisplayName({ name: 123 }), 'unknown');
});

test('thread inheritance: a message in a thread under an allowlisted channel classifies per the PARENT tier', async () => {
  const { buildGuildIndex, classifyInbound } = await import('../src/discord/wake.js');
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  const idx = buildGuildIndex([
    { id: 'g1', slug: 'home', slashCommands: false, quietHours: null, timezone: null,
      channels: { '1002': 'social' } },
  ]);
  const noMutes = () => null;
 // A thread's own id ('thread-in-1002') is NOT listed anywhere — only its
 // parent ('1002') is. Without inheritance this would drop as unlisted.
  const policyChannelId = resolvePolicyChannelId('thread-in-1002', true, '1002');
  assert.equal(policyChannelId, '1002');
  const cls = classifyInbound(
    { guildId: 'g1', channelId: policyChannelId, authorIsBot: false, mentionsMe: false, replyToMe: false },
    idx, noMutes,
  );
  assert.equal(cls, 'ambient', 'social tier, no mention/reply — same as a direct post in #general would get');
});

test('thread inheritance: a message in a thread whose parent is NOT allowlisted still drops', async () => {
  const { buildGuildIndex, classifyInbound } = await import('../src/discord/wake.js');
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  const idx = buildGuildIndex([
    { id: 'g1', slug: 'home', slashCommands: false, quietHours: null, timezone: null,
      channels: { '1002': 'social' } },
  ]);
  const noMutes = () => null;
  const policyChannelId = resolvePolicyChannelId('thread-in-9999', true, '9999'); // '9999' unlisted
  assert.equal(policyChannelId, '9999');
  const cls = classifyInbound(
    { guildId: 'g1', channelId: policyChannelId, authorIsBot: false, mentionsMe: false, replyToMe: false },
    idx, noMutes,
  );
  assert.equal(cls, 'drop');
});

// ---------- attachment inlining: pure gates (isInlinableAttachmentType, guardInlineText) ----------

test('isInlinableAttachmentType: text/* and application/json inline; binary and null do not', async () => {
  const { isInlinableAttachmentType } = await import('../src/discord/discord.js');
  assert.equal(isInlinableAttachmentType('text/plain; charset=utf-8'), true);
  assert.equal(isInlinableAttachmentType('text/markdown'), true);
  assert.equal(isInlinableAttachmentType('application/json'), true);
  assert.equal(isInlinableAttachmentType('application/json; charset=utf-8'), true);
  assert.equal(isInlinableAttachmentType('image/png'), false);
  assert.equal(isInlinableAttachmentType('application/octet-stream'), false);
  assert.equal(isInlinableAttachmentType('application/jsonp-ish'), false);
  assert.equal(isInlinableAttachmentType(null), false);
});

test('guardInlineText: passes plain text through verbatim', async () => {
  const { guardInlineText } = await import('../src/discord/discord.js');
  assert.equal(guardInlineText('# Quiz\r\nQ1: pick one'), '# Quiz\r\nQ1: pick one');
});

test('guardInlineText: rejects a literal closing tag (framing injection) and NUL bytes (mislabeled binary)', async () => {
  const { guardInlineText } = await import('../src/discord/discord.js');
  assert.equal(guardInlineText('before </attachment-content> after'), null);
  const withNul = 'bin' + String.fromCharCode(0) + 'ary';
  assert.equal(guardInlineText(withNul), null);
});

// ---------- reactionVerdict (pure feedback gate) ----------

test('reactionVerdict: 👍/👎 on the bot\'s own message from another user → verdict', () => {
  assert.equal(reactionVerdict({ botUserId: 'bot', reactorId: 'u1', messageAuthorId: 'bot', emojiName: '👍' }), 'good');
  assert.equal(reactionVerdict({ botUserId: 'bot', reactorId: 'u1', messageAuthorId: 'bot', emojiName: '👎' }), 'bad');
});

test('reactionVerdict: ignores the bot reacting to itself', () => {
  assert.equal(reactionVerdict({ botUserId: 'bot', reactorId: 'bot', messageAuthorId: 'bot', emojiName: '👍' }), null);
});

test('reactionVerdict: ignores reactions on messages the bot did not author', () => {
  assert.equal(reactionVerdict({ botUserId: 'bot', reactorId: 'u1', messageAuthorId: 'u2', emojiName: '👍' }), null);
});

test('reactionVerdict: ignores non-👍/👎 emoji and an unknown bot id', () => {
  assert.equal(reactionVerdict({ botUserId: 'bot', reactorId: 'u1', messageAuthorId: 'bot', emojiName: '❤️' }), null);
  assert.equal(reactionVerdict({ botUserId: undefined, reactorId: 'u1', messageAuthorId: 'bot', emojiName: '👍' }), null);
});

// ---------- /usage: formatUsageBars (pure renderer) ----------

test('formatUsageBars: bars, percents, relative resets', async () => {
  const { formatUsageBars } = await import('../src/discord/discord.js');
  const now = Date.parse('2026-07-22T00:36:03.000Z');
  const snap = {
    provider: 'kimi', label: 'Kimi', fetchedAt: '2026-07-22T00:00:00.000Z', error: null,
    windows: [
      { id: '5h', label: '5h', usedPct: 4, resetAt: '2026-07-22T05:36:03.631117Z' },
      { id: '7d', label: '7d', usedPct: 21, resetAt: '2026-07-28T19:36:03.631117Z' },
    ],
  };
  const out = formatUsageBars(snap, now);
  assert.match(out, /Kimi usage/);
  assert.match(out, /5h\s+░+.*4%.*resets in 5h 0m/s);
  assert.match(out, /7d\s+▓▓░+.*21%.*resets in 6d 19h/s);
});

test('formatUsageBars: null snapshot → inactive message; error → stale note; past reset → resetting', async () => {
  const { formatUsageBars } = await import('../src/discord/discord.js');
  assert.match(formatUsageBars(null), /not active/);
  const now = Date.parse('2026-07-22T06:00:00.000Z');
  const stale = {
    provider: 'kimi', label: 'Kimi', fetchedAt: '', error: 'HTTP 500',
    windows: [{ id: '5h', label: '5h', usedPct: 95, resetAt: '2026-07-22T05:36:03.631117Z' }],
  };
  const out = formatUsageBars(stale, now);
  assert.match(out, /stale, fetch failed/);
  assert.match(out, /resetting…/);
  assert.match(out, /▓{10}|▓{9}░/, 'bar nearly full at 95%');
});

test('buildCommandDefinitions: /usage takes no options', () => {
  const defs = buildCommandDefinitions();
  const usage = defs.find((d) => d.name === 'usage');
  assert.ok(usage, '/usage command must be registered');
  assert.equal((usage!.options ?? []).length, 0);
});

// ---------- /cache: formatCacheBars (pure renderer) ----------

import { formatCacheBars } from '../src/discord/discord.js';
import { createCacheStats } from '../src/llm/cache-stats.js';
import type { CacheInfo } from '../src/llm/cache-stats.js';

const cacheInfo = (o: Partial<CacheInfo> = {}): CacheInfo => ({
  supported: true,
  lastCached: 70_800, lastNew: 4_429, lastRatio: 70_800 / 75_229,
  totalCached: 1_420_000, totalNew: 193_000, totalRatio: 1_420_000 / 1_613_000,
  bustCount: 3, bustTokens: 47_312,
  turns: 12,
  ...o,
});

test('formatCacheBars: renders both rows, percentages and the bust line', () => {
  const out = formatCacheBars(cacheInfo());
  assert.match(out, /prompt cache/);
  assert.match(out, /last/);
  assert.match(out, /sess/);
  assert.match(out, /94%/);
  assert.match(out, /88%/);
  assert.match(out, /70,800/);
  assert.match(out, /3 busts/);
  assert.match(out, /47,312/);
  assert.ok(out.startsWith('```') && out.trimEnd().endsWith('```'), 'wrapped in a code fence');
});

test('formatCacheBars: null or unsupported reports the endpoint does not report it', () => {
  for (const arg of [null, cacheInfo({ supported: false })]) {
    const out = formatCacheBars(arg);
    assert.match(out, /not reported/i);
    assert.doesNotMatch(out, /▓/, 'no bars when there is nothing to show');
  }
});

test('formatCacheBars: a fresh boot (no completions yet) says so, not "not reported"', () => {
 // A real createCacheStats snapshot before any record call — this is the
 // actual post-boot/post-restart/post-clear state, not a hand-built one.
  const out = formatCacheBars(createCacheStats().snapshot());
  assert.match(out, /no completions recorded yet/i);
  assert.doesNotMatch(out, /not reported/i);
});

test('formatCacheBars: completions recorded but the endpoint never reports cache data', () => {
  const out = formatCacheBars(cacheInfo({ supported: false, turns: 5 }));
  assert.match(out, /not reported/i);
  assert.doesNotMatch(out, /no completions recorded yet/i);
});

test('formatCacheBars: omits the bust line when there are no busts', () => {
  const out = formatCacheBars(cacheInfo({ bustCount: 0, bustTokens: 0 }));
  assert.doesNotMatch(out, /bust/i);
  assert.match(out, /94%/, 'the bars still render');
});

// ---------- killswitch slash commands: /mute /unmute /deafen /undeafen ----------

test('operatorGateReason: distinct message when operator_id is unset (disabled) vs set to someone else', () => {
  const disabled = stubConfig(null);
  const notYou = stubConfig('123456789');
  assert.match(operatorGateReason(disabled, 'mute'), /disabled.*operator.discord_id not set/);
  assert.equal(operatorGateReason(notYou, 'mute'), 'You are not authorized to use this command.');
});

test('operatorGateReason: the disabled message names the specific command', () => {
  assert.match(operatorGateReason(stubConfig(null), 'deafen'), /^\/deafen is disabled/);
  assert.match(operatorGateReason(stubConfig(null), 'unmute'), /^\/unmute is disabled/);
});

test('resolveModerationCommand: resolves the ref then forwards to moderateChannel', () => {
  const calls: unknown[] = [];
  const agent = {
    resolveChannelRef: (ref: string) => (ref === 'friends-a/lounge' ? 'chan-1' : null),
    moderateChannel: (channelId: string, action: string, actor: string, reason?: string) => {
      calls.push({ channelId, action, actor, reason });
      return { ok: true, note: 'channel #lounge muted by operator' };
    },
  };
  const result = resolveModerationCommand(agent, 'mute', 'friends-a/lounge', 'noisy');
  assert.deepEqual(calls, [{ channelId: 'chan-1', action: 'mute', actor: 'operator', reason: 'noisy' }]);
  assert.deepEqual(result, { ok: true, note: 'channel #lounge muted by operator' });
});

test('resolveModerationCommand: an unqualified bare ref surfaces the throw\'s candidate-list guidance verbatim', () => {
  const agent = {
    resolveChannelRef: (_ref: string): string | null => {
      throw new Error(`unqualified channel ref 'lounge'. Use one of: home/lounge, friends-a/lounge`);
    },
    moderateChannel: () => { throw new Error('must not be called'); },
  };
  const result = resolveModerationCommand(agent, 'mute', 'lounge');
  assert.equal(result.ok, false);
  assert.equal(result.note, `unqualified channel ref 'lounge'. Use one of: home/lounge, friends-a/lounge`);
});

test('resolveModerationCommand: an unknown ref (resolves to null, no throw) gets a generic guidance message', () => {
  const agent = {
    resolveChannelRef: () => null,
    moderateChannel: () => { throw new Error('must not be called'); },
  };
  const result = resolveModerationCommand(agent, 'unmute', 'nonexistent/room');
  assert.equal(result.ok, false);
  assert.match(result.note, /unknown channel "nonexistent\/room"/);
  assert.match(result.note, /friends-a\/lounge/, 'shows a qualified-ref example');
});

test('resolveModerationCommand: reason is optional and omitted when not given', () => {
  const calls: unknown[] = [];
  const agent = {
    resolveChannelRef: () => 'chan-1',
    moderateChannel: (channelId: string, action: string, actor: string, reason?: string) => {
      calls.push(reason);
      return { ok: true, note: 'ok' };
    },
  };
  resolveModerationCommand(agent, 'undeafen', 'chan-1');
  assert.deepEqual(calls, [undefined]);
});

// ---------- resolveMentions (raw markup -> readable names) ----------

const NAMES = {
  users: new Map([['111111111111111103', 'Echo'], ['22222222222222222', 'clover']]),
  roles: new Map([['33333333333333333', 'friends']]),
  channels: new Map([['44444444444444444', 'agent-zoo']]),
};

test('resolveMentions: a user mention becomes @displayName', () => {
  assert.equal(
    resolveMentions('<@111111111111111103> do mentions work too?', NAMES),
    '@Echo do mentions work too?',
  );
});

test('resolveMentions: the legacy nickname form <@!id> resolves the same way', () => {
  assert.equal(resolveMentions('hi <@!22222222222222222>', NAMES), 'hi @clover');
});

test('resolveMentions: role and channel markup resolve too', () => {
  assert.equal(
    resolveMentions('<@&33333333333333333> meet in <#44444444444444444>', NAMES),
    '@friends meet in #agent-zoo',
  );
});

test('resolveMentions: an id with no name in hand is left as raw markup, never guessed', () => {
  assert.equal(resolveMentions('<@99999999999999999> hi', NAMES), '<@99999999999999999> hi');
  assert.equal(resolveMentions('<#99999999999999999>', NAMES), '<#99999999999999999>');
});

test('resolveMentions: several mentions in one body all resolve', () => {
  assert.equal(
    resolveMentions('<@111111111111111103> and <@22222222222222222> both', NAMES),
    '@Echo and @clover both',
  );
});

test('resolveMentions: mentionless content and empty name tables are untouched', () => {
  assert.equal(resolveMentions('no mentions here', NAMES), 'no mentions here');
  assert.equal(resolveMentions('<@111111111111111103>', {}), '<@111111111111111103>');
});

test('resolveMentions: non-mention angle-bracket text is not mangled', () => {
  assert.equal(resolveMentions('a <b> c <@notanid> d', NAMES), 'a <b> c <@notanid> d');
});
