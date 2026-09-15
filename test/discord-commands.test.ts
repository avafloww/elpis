// Unit tests for the pure extracted Discord command helpers:
// buildCommandDefinitions, isAuthorizedOperator, and routing helpers.
//
// Command shapes and authorization helpers run directly; ingress gates also
// exercise registered Discord listeners without logging in or using the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Events, type Message } from 'discord.js';
import type { Agent, InboundMessage } from '../src/agent.js';
import {
  buildCommandDefinitions,
  createDiscord,
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

// ---------- buildCommandDefinitions ----------

test('buildCommandDefinitions: returns exactly 15 commands', () => {
  const defs = buildCommandDefinitions();
  assert.equal(defs.length, 15);
  const names = defs.map((d) => d.name);
  assert.deepEqual(names.sort(), [
    'cache',
    'clear',
    'clear-thinking',
    'compact',
    'deafen',
    'exec',
    'join',
    'leave',
    'mind',
    'mute',
    'new',
    'restart',
    'undeafen',
    'unmute',
    'usage',
  ]);
});

test('buildCommandDefinitions: /mind exposes the complete work-graph command surface', () => {
  const mind = buildCommandDefinitions().find((d) => d.name === 'mind');
  assert.ok(mind, '/mind command must be registered');
  const subcommands = mind!.options ?? [];
  assert.deepEqual(subcommands.map((x) => x.name).sort(), [
    'add',
    'archive',
    'comment',
    'done',
    'edit',
    'graph',
    'link',
    'list',
    'read',
    'remind',
    'start',
    'unlink',
    'wait',
  ]);
  const add = subcommands.find((x) => x.name === 'add')!;
  assert.ok((add.options ?? []).some((x) => x.name === 'title' && x.required));
  const list = subcommands.find((x) => x.name === 'list')!;
  const sort = (list.options ?? []).find((x) => x.name === 'sort')!;
  assert.deepEqual(
    new Set(sort.choices?.map((x) => x.value)),
    new Set([
      'created_asc',
      'created_desc',
      'updated_asc',
      'updated_desc',
      'last_comment_asc',
      'last_comment_desc',
    ]),
  );
  const read = subcommands.find((x) => x.name === 'read')!;
  assert.ok((read.options ?? []).some((x) => x.name === 'id' && x.required));
});

test('mindAddAmbientNotice: queues a generic home-private ambient notice without an immediate wake class', () => {
  const notice = mindAddAmbientNotice(
    {
      id: 42,
      title: 'A thought arrived',
      body: '',
      kind: 'idea',
      status: 'open',
      effectiveStatus: 'open',
      priority: 2,
      parentId: null,
      dueAt: null,
      createdBy: 'discord:bramble',
      createdAt: 1,
      updatedAt: 1,
      lastCommentAt: null,
      closedAt: null,
      archivedAt: null,
      tags: ['thought'],
      blockedBy: [],
      blocks: [],
      childCount: 0,
      commentCount: 0,
      reminderCount: 0,
    },
    {
      channelId: 'thread',
      policyChannelId: 'home-parent',
      channelName: 'ideas',
      guildId: 'g-home',
      guildSlug: 'home',
      createdAt: '2026-08-11T00:00:00Z',
    },
  );
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
  const home = makeConfig({
    discord: { ...base.discord, guilds: [{ ...guild, slug: 'home' }] },
  });
  assert.equal(isMindHomeGuild(home, guild.id), true);
  const notHome = makeConfig({
    discord: { ...base.discord, guilds: [{ ...guild, slug: 'friends' }] },
  });
  assert.equal(isMindHomeGuild(notHome, guild.id), false);
  assert.equal(isMindHomeGuild(home, 'unknown-guild'), false);
});

test('commands: mute/unmute/deafen/undeafen are defined with a channel option', () => {
  const defs = buildCommandDefinitions();
  for (const name of ['mute', 'unmute', 'deafen', 'undeafen']) {
    const d = defs.find((x) => x.name === name);
    assert.ok(d, `${name} missing`);
    const opts =
      (d as { options?: { name: string; required?: boolean }[] }).options ?? [];
    assert.ok(opts.some((o) => o.name === 'channel' && o.required));
  }
  assert.ok(
    buildCommandDefinitions()
      .find((x) => x.name === 'mute')!
      .options!.some((o: { name: string }) => o.name === 'reason'),
  );
});

test('commands: /deafen also takes an optional reason; /unmute and /undeafen do not', () => {
  const defs = buildCommandDefinitions();
  const deafen = defs.find((x) => x.name === 'deafen')!;
  assert.ok((deafen.options ?? []).some((o) => o.name === 'reason'));
  for (const name of ['unmute', 'undeafen']) {
    const d = defs.find((x) => x.name === name)!;
    assert.ok(
      !(d.options ?? []).some((o) => o.name === 'reason'),
      `/${name} should not take a reason`,
    );
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
    assert.equal(
      (cmd!.options ?? []).length,
      0,
      `/${cmdName} is global, no options`,
    );
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
    assert.equal(
      isAuthorizedOperator(config, 'someone-else'),
      false,
      `${name}: non-operator must be refused`,
    );
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
    assert.equal(
      isAuthorizedOperator(config, 'anyone'),
      false,
      `${name}: must be refused when unset`,
    );
    const reason = operatorGateReason(config, name);
    assert.equal(
      reason,
      `/${name} is disabled (operator.discord_id not set).`,
      `${name}: wrong disabled message`,
    );
    assert.doesNotMatch(
      reason,
      /not authorized/,
      `${name}: disabled case must not read as "not authorized"`,
    );
  }
});

test("/clear: refused for a non-operator (previously ungated — /clear and /new wipe ALL of the agent's working memory)", () => {
  const config = stubConfig('the-operator-id');
  assert.equal(isAuthorizedOperator(config, 'random-guild-member'), false);
  assert.equal(
    operatorGateReason(config, 'clear'),
    'You are not authorized to use this command.',
  );
});

test('/clear: unset operator.discord_id produces the "disabled" message, not "not authorized"', () => {
  const config = stubConfig(null);
  assert.equal(
    operatorGateReason(config, 'clear'),
    '/clear is disabled (operator.discord_id not set).',
  );
});

test('/new and /compact: also refused for a non-operator (previously ungated)', () => {
  const config = stubConfig('the-operator-id');
  for (const name of ['new', 'compact'] as const) {
    assert.equal(
      isAuthorizedOperator(config, 'random-guild-member'),
      false,
      `${name}`,
    );
    assert.equal(
      operatorGateReason(config, name),
      'You are not authorized to use this command.',
      `${name}`,
    );
  }
});

// ---------- ignored author gate (silent pre-ingress filter) ----------

test('isIgnoredAuthor: exact configured ids are dropped and other bots remain visible', () => {
  const ignored = new Set(['222']);
  assert.equal(isIgnoredAuthor(ignored, '222'), true);
  assert.equal(isIgnoredAuthor(ignored, '111'), false);
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
  const input = wakeInputFor(
    'g1',
    'c1',
    false,
    ['other-bot-id'],
    null,
    'bot-id',
  );
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
  const mentioned = wakeInputFor(
    'g1',
    'c1',
    false,
    ['some-user-id'],
    null,
    undefined,
  );
  assert.equal(mentioned.mentionsMe, true);
  const repliedTo = wakeInputFor(
    'g1',
    'c1',
    false,
    [],
    'some-user-id',
    undefined,
  );
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
  assert.equal(
    resolvePolicyChannelId('thread-1', true, 'parent-1'),
    'parent-1',
  );
});

test('resolvePolicyChannelId: a non-thread resolves to its own id, ignoring any parentId', async () => {
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  assert.equal(resolvePolicyChannelId('chan-1', false, 'irrelevant'), 'chan-1');
});

test('resolvePolicyChannelId: a thread with no resolvable parent id falls back to its own id', async () => {
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  assert.equal(
    resolvePolicyChannelId('thread-orphan', true, null),
    'thread-orphan',
  );
});

test('channelDisplayName: reads .name off a duck-typed channel object; "unknown" when absent/null', async () => {
  const { channelDisplayName } = await import('../src/discord/discord.js');
  assert.equal(channelDisplayName({ name: 'general' }), 'general');
  assert.equal(channelDisplayName(null), 'unknown');
  assert.equal(channelDisplayName({}), 'unknown');
  assert.equal(channelDisplayName({ name: 123 }), 'unknown');
});

test('thread inheritance: a message in a thread under an allowlisted channel classifies per the PARENT tier', async () => {
  const { buildGuildIndex, classifyInbound } =
    await import('../src/discord/wake.js');
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  const idx = buildGuildIndex([
    {
      id: 'g1',
      slug: 'home',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      channels: { '1002': 'social' },
    },
  ]);
  const noMutes = () => null;
  // A thread's own id ('thread-in-1002') is NOT listed anywhere — only its
  // parent ('1002') is. Without inheritance this would drop as unlisted.
  const policyChannelId = resolvePolicyChannelId(
    'thread-in-1002',
    true,
    '1002',
  );
  assert.equal(policyChannelId, '1002');
  const cls = classifyInbound(
    {
      guildId: 'g1',
      channelId: policyChannelId,
      authorIsBot: false,
      mentionsMe: false,
      replyToMe: false,
    },
    idx,
    noMutes,
  );
  assert.equal(
    cls,
    'ambient',
    'social tier, no mention/reply — same as a direct post in #general would get',
  );
});

test('thread inheritance: a message in a thread whose parent is NOT allowlisted still drops', async () => {
  const { buildGuildIndex, classifyInbound } =
    await import('../src/discord/wake.js');
  const { resolvePolicyChannelId } = await import('../src/discord/discord.js');
  const idx = buildGuildIndex([
    {
      id: 'g1',
      slug: 'home',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      channels: { '1002': 'social' },
    },
  ]);
  const noMutes = () => null;
  const policyChannelId = resolvePolicyChannelId(
    'thread-in-9999',
    true,
    '9999',
  ); // '9999' unlisted
  assert.equal(policyChannelId, '9999');
  const cls = classifyInbound(
    {
      guildId: 'g1',
      channelId: policyChannelId,
      authorIsBot: false,
      mentionsMe: false,
      replyToMe: false,
    },
    idx,
    noMutes,
  );
  assert.equal(cls, 'drop');
});

// ---------- attachment inlining: pure gates (isInlinableAttachmentType, guardInlineText) ----------

test('isInlinableAttachmentType: text/* and application/json inline; binary and null do not', async () => {
  const { isInlinableAttachmentType } =
    await import('../src/discord/discord.js');
  assert.equal(isInlinableAttachmentType('text/plain; charset=utf-8'), true);
  assert.equal(isInlinableAttachmentType('text/markdown'), true);
  assert.equal(isInlinableAttachmentType('application/json'), true);
  assert.equal(
    isInlinableAttachmentType('application/json; charset=utf-8'),
    true,
  );
  assert.equal(isInlinableAttachmentType('image/png'), false);
  assert.equal(isInlinableAttachmentType('application/octet-stream'), false);
  assert.equal(isInlinableAttachmentType('application/jsonp-ish'), false);
  assert.equal(isInlinableAttachmentType(null), false);
});

test('guardInlineText: passes plain text through verbatim', async () => {
  const { guardInlineText } = await import('../src/discord/discord.js');
  assert.equal(
    guardInlineText('# Quiz\r\nQ1: pick one'),
    '# Quiz\r\nQ1: pick one',
  );
});

test('guardInlineText: rejects a literal closing tag (framing injection) and NUL bytes (mislabeled binary)', async () => {
  const { guardInlineText } = await import('../src/discord/discord.js');
  assert.equal(guardInlineText('before </attachment-content> after'), null);
  const withNul = 'bin' + String.fromCharCode(0) + 'ary';
  assert.equal(guardInlineText(withNul), null);
});

// ---------- reactionVerdict (pure feedback gate) ----------

test("reactionVerdict: 👍/👎 on the bot's own message from another user → verdict", () => {
  assert.equal(
    reactionVerdict({
      botUserId: 'bot',
      reactorId: 'u1',
      messageAuthorId: 'bot',
      emojiName: '👍',
    }),
    'good',
  );
  assert.equal(
    reactionVerdict({
      botUserId: 'bot',
      reactorId: 'u1',
      messageAuthorId: 'bot',
      emojiName: '👎',
    }),
    'bad',
  );
});

test('reactionVerdict: ignores the bot reacting to itself', () => {
  assert.equal(
    reactionVerdict({
      botUserId: 'bot',
      reactorId: 'bot',
      messageAuthorId: 'bot',
      emojiName: '👍',
    }),
    null,
  );
});

test('reactionVerdict: ignores reactions on messages the bot did not author', () => {
  assert.equal(
    reactionVerdict({
      botUserId: 'bot',
      reactorId: 'u1',
      messageAuthorId: 'u2',
      emojiName: '👍',
    }),
    null,
  );
});

test('reactionVerdict: ignores non-👍/👎 emoji and an unknown bot id', () => {
  assert.equal(
    reactionVerdict({
      botUserId: 'bot',
      reactorId: 'u1',
      messageAuthorId: 'bot',
      emojiName: '❤️',
    }),
    null,
  );
  assert.equal(
    reactionVerdict({
      botUserId: undefined,
      reactorId: 'u1',
      messageAuthorId: 'bot',
      emojiName: '👍',
    }),
    null,
  );
});

// ---------- /usage: formatUsageBars (pure renderer) ----------

test('formatUsageBars: bars, percents, relative resets', async () => {
  const { formatUsageBars } = await import('../src/discord/discord.js');
  const now = Date.parse('2026-07-22T00:36:03.000Z');
  const snap = {
    provider: 'kimi',
    label: 'Kimi',
    fetchedAt: '2026-07-22T00:00:00.000Z',
    error: null,
    windows: [
      {
        id: '5h',
        label: '5h',
        usedPct: 4,
        resetAt: '2026-07-22T05:36:03.631117Z',
      },
      {
        id: '7d',
        label: '7d',
        usedPct: 21,
        resetAt: '2026-07-28T19:36:03.631117Z',
      },
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
    provider: 'kimi',
    label: 'Kimi',
    fetchedAt: '',
    error: 'HTTP 500',
    windows: [
      {
        id: '5h',
        label: '5h',
        usedPct: 95,
        resetAt: '2026-07-22T05:36:03.631117Z',
      },
    ],
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
  lastCached: 70_800,
  lastNew: 4_429,
  lastRatio: 70_800 / 75_229,
  totalCached: 1_420_000,
  totalNew: 193_000,
  totalRatio: 1_420_000 / 1_613_000,
  bustCount: 3,
  bustTokens: 47_312,
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
  assert.ok(
    out.startsWith('```') && out.trimEnd().endsWith('```'),
    'wrapped in a code fence',
  );
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
  assert.match(
    operatorGateReason(disabled, 'mute'),
    /disabled.*operator.discord_id not set/,
  );
  assert.equal(
    operatorGateReason(notYou, 'mute'),
    'You are not authorized to use this command.',
  );
});

test('operatorGateReason: the disabled message names the specific command', () => {
  assert.match(
    operatorGateReason(stubConfig(null), 'deafen'),
    /^\/deafen is disabled/,
  );
  assert.match(
    operatorGateReason(stubConfig(null), 'unmute'),
    /^\/unmute is disabled/,
  );
});

test('resolveModerationCommand: resolves the ref then forwards to moderateChannel', () => {
  const calls: unknown[] = [];
  const agent = {
    resolveChannelRef: (ref: string) =>
      ref === 'friends-a/lounge' ? 'chan-1' : null,
    moderateChannel: (
      channelId: string,
      action: string,
      actor: string,
      reason?: string,
    ) => {
      calls.push({ channelId, action, actor, reason });
      return { ok: true, note: 'channel #lounge muted by operator' };
    },
  };
  const result = resolveModerationCommand(
    agent,
    'mute',
    'friends-a/lounge',
    'noisy',
  );
  assert.deepEqual(calls, [
    { channelId: 'chan-1', action: 'mute', actor: 'operator', reason: 'noisy' },
  ]);
  assert.deepEqual(result, {
    ok: true,
    note: 'channel #lounge muted by operator',
  });
});

test("resolveModerationCommand: an unqualified bare ref surfaces the throw's candidate-list guidance verbatim", () => {
  const agent = {
    resolveChannelRef: (_ref: string): string | null => {
      throw new Error(
        `unqualified channel ref 'lounge'. Use one of: home/lounge, friends-a/lounge`,
      );
    },
    moderateChannel: () => {
      throw new Error('must not be called');
    },
  };
  const result = resolveModerationCommand(agent, 'mute', 'lounge');
  assert.equal(result.ok, false);
  assert.equal(
    result.note,
    `unqualified channel ref 'lounge'. Use one of: home/lounge, friends-a/lounge`,
  );
});

test('resolveModerationCommand: an unknown ref (resolves to null, no throw) gets a generic guidance message', () => {
  const agent = {
    resolveChannelRef: () => null,
    moderateChannel: () => {
      throw new Error('must not be called');
    },
  };
  const result = resolveModerationCommand(agent, 'unmute', 'nonexistent/room');
  assert.equal(result.ok, false);
  assert.match(result.note, /unknown channel "nonexistent\/room"/);
  assert.match(
    result.note,
    /friends-a\/lounge/,
    'shows a qualified-ref example',
  );
});

test('resolveModerationCommand: reason is optional and omitted when not given', () => {
  const calls: unknown[] = [];
  const agent = {
    resolveChannelRef: () => 'chan-1',
    moderateChannel: (
      channelId: string,
      action: string,
      actor: string,
      reason?: string,
    ) => {
      calls.push(reason);
      return { ok: true, note: 'ok' };
    },
  };
  resolveModerationCommand(agent, 'undeafen', 'chan-1');
  assert.deepEqual(calls, [undefined]);
});

// ---------- resolveMentions (raw markup -> readable names) ----------

const NAMES = {
  users: new Map([
    ['111111111111111103', 'Aster'],
    ['22222222222222222', 'Bramble'],
  ]),
  roles: new Map([['33333333333333333', 'friends']]),
  channels: new Map([['44444444444444444', 'lounge']]),
};

test('resolveMentions: a user mention becomes @displayName', () => {
  assert.equal(
    resolveMentions('<@111111111111111103> do mentions work too?', NAMES),
    '@Aster do mentions work too?',
  );
});

test('resolveMentions: the legacy nickname form <@!id> resolves the same way', () => {
  assert.equal(
    resolveMentions('hi <@!22222222222222222>', NAMES),
    'hi @Bramble',
  );
});

test('resolveMentions: role and channel markup resolve too', () => {
  assert.equal(
    resolveMentions(
      '<@&33333333333333333> meet in <#44444444444444444>',
      NAMES,
    ),
    '@friends meet in #lounge',
  );
});

test('resolveMentions: an id with no name in hand is left as raw markup, never guessed', () => {
  assert.equal(
    resolveMentions('<@99999999999999999> hi', NAMES),
    '<@99999999999999999> hi',
  );
  assert.equal(
    resolveMentions('<#99999999999999999>', NAMES),
    '<#99999999999999999>',
  );
});

test('resolveMentions: several mentions in one body all resolve', () => {
  assert.equal(
    resolveMentions(
      '<@111111111111111103> and <@22222222222222222> both',
      NAMES,
    ),
    '@Aster and @Bramble both',
  );
});

test('resolveMentions: mentionless content and empty name tables are untouched', () => {
  assert.equal(resolveMentions('no mentions here', NAMES), 'no mentions here');
  assert.equal(
    resolveMentions('<@111111111111111103>', {}),
    '<@111111111111111103>',
  );
});

test('resolveMentions: non-mention angle-bracket text is not mangled', () => {
  assert.equal(
    resolveMentions('a <b> c <@notanid> d', NAMES),
    'a <b> c <@notanid> d',
  );
});

test('mentions-turn Discord authorization restricts even otherwise-sendable targets', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const config = makeConfig();
  config.discord.guilds = [
    {
      id: 'g1',
      slug: 'example',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      defaultTier: 'mentions',
      allowSend: true,
      defaultAllowSend: false,
      channels: { '102': 'direct', '103': 'mentions', '104': 'social' },
      channelAllowSend: { '102': true, '103': false, '104': true },
    },
    {
      id: 'g2',
      slug: 'denied',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      defaultTier: 'drop',
      allowSend: false,
      defaultAllowSend: false,
      channels: { '200': 'mentions' },
      channelAllowSend: { '200': true },
    },
  ];
  let send!: Parameters<Agent['setSend']>[0];
  type Authorization = {
    kind: 'mentions-turn';
    channelId: string;
    guildId: string;
    isCurrent: () => boolean;
  };
  let issueAuthorization!: (
    channelId: string,
    guildId: string,
    isCurrent: () => boolean,
  ) => Authorization;
  const agent = {
    setSend: (fn: typeof send) => {
      send = fn;
    },
    setOutboundSendAuthorizationIssuer: (fn: typeof issueAuthorization) => {
      issueAuthorization = fn;
    },
    enqueue: () => {},
  } as unknown as Agent;
  const activeMutes = new Map<string, 'mute' | 'deafen'>();
  const mutes = {
    get: (channelId: string) => {
      const type = activeMutes.get(channelId);
      return type
        ? {
            channelId,
            type,
            setBy: 'operator' as const,
            reason: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          }
        : null;
    },
  } as never;
  let captureSpeechEnabled = false;
  let speechCaptures = 0;
  let speechEffects = 0;
  const voice = {
    channelId: null,
    join: async () => {},
    leave: () => {},
    speak: async (text: string) => ({
      status: 'played' as const,
      transcript: text,
      playedMs: 0,
    }),
    captureSpeech: () => {
      if (!captureSpeechEnabled) return null;
      speechCaptures++;
      return async (text: string) => {
        speechEffects++;
        return {
          status: 'played' as const,
          transcript: text,
          playedMs: 0,
        };
      };
    },
  } as never;
  const wiring = createDiscord(config, agent, { mutes, voice });
  t.after(() => {
    wiring.stopTyping();
    wiring.client.destroy();
  });
  let exactTyping = 0;
  let otherTyping = 0;
  let otherwiseSendableTyping = 0;
  let exactSends = 0;
  let expireDuringChunkedSend = false;
  let otherSends = 0;
  let otherwiseSendableSends = 0;
  let socialSends = 0;
  let explicitDeniedSends = 0;
  let guildDeniedSends = 0;
  wiring.client.channels.cache.set('100', {
    guildId: 'g1',
    isThread: () => false,
    isTextBased: () => true,
    sendTyping: async () => {
      exactTyping++;
    },
    send: async () => {
      exactSends++;
      if (expireDuringChunkedSend) current = false;
    },
  } as never);
  wiring.client.channels.cache.set('101', {
    guildId: 'g1',
    isThread: () => false,
    isTextBased: () => true,
    sendTyping: async () => {
      otherTyping++;
    },
    send: async () => {
      otherSends++;
    },
  } as never);
  wiring.client.channels.cache.set('102', {
    guildId: 'g1',
    isThread: () => false,
    isTextBased: () => true,
    sendTyping: async () => {
      otherwiseSendableTyping++;
    },
    send: async () => {
      otherwiseSendableSends++;
    },
  } as never);
  wiring.client.channels.cache.set('103', {
    guildId: 'g1',
    isThread: () => false,
    isTextBased: () => true,
    send: async () => {
      explicitDeniedSends++;
    },
  } as never);
  wiring.client.channels.cache.set('104', {
    guildId: 'g1',
    isThread: () => false,
    isTextBased: () => true,
    send: async () => {
      socialSends++;
    },
  } as never);
  wiring.client.channels.cache.set('200', {
    guildId: 'g2',
    isThread: () => false,
    isTextBased: () => true,
    send: async () => {
      guildDeniedSends++;
    },
  } as never);

  let fetchCalls = 0;
  let fetchGate:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  t.mock.method(wiring.client.channels, 'fetch', async (channelId) => {
    fetchCalls++;
    const gate = fetchGate;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    return wiring.client.channels.cache.get(channelId);
  });

  let current = true;
  const authorization = issueAuthorization('100', 'g1', () => current);
  const typing = wiring.typing as (
    channelId: string,
    authorization?: typeof authorization,
  ) => void;
  typing('100');
  typing('101', authorization);
  typing('102');
  typing('102', { ...authorization });
  typing('102', authorization);
  typing('100', { ...authorization, guildId: 'wrong-guild' });
  typing('100', authorization);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  activeMutes.set('100', 'deafen');
  t.mock.timers.tick(8_000);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  activeMutes.clear();
  assert.equal(exactTyping, 1, 'a mute stops the next repeating effect');

  typing('100', authorization);
  current = false;
  t.mock.timers.tick(8_000);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(exactTyping, 2, 'revocation stops the next repeating effect');
  current = true;
  const sendAuthorization = issueAuthorization('100', 'g1', () => current);

  await assert.rejects(
    send('102', 'omitted active capability'),
    /active mentions-turn authorization.*required/i,
  );
  await assert.rejects(
    send('102', 'forged active capability', undefined, {
      ...sendAuthorization,
    }),
    /active mentions-turn authorization.*required/i,
  );
  await assert.rejects(
    send('100', 'wrong guild', undefined, {
      ...sendAuthorization,
      guildId: 'wrong-guild',
    }),
    /active mentions-turn authorization.*required/i,
  );
  await assert.rejects(
    send('102', 'otherwise sendable room', undefined, sendAuthorization),
    /mentions-turn authorization.*exact channel/i,
  );
  await assert.rejects(
    send('101', 'wrong room', undefined, sendAuthorization),
    /mentions-turn authorization.*exact channel/i,
  );
  await assert.rejects(
    send('100', 'forged lookalike', undefined, { ...sendAuthorization }),
    /active mentions-turn authorization.*required/i,
  );
  await send('100', 'exact room', undefined, sendAuthorization);

  assert.equal(exactTyping, 2);
  assert.equal(otherTyping, 0);
  assert.equal(otherwiseSendableTyping, 0);
  assert.equal(exactSends, 1);
  assert.equal(otherSends, 0);
  assert.equal(otherwiseSendableSends, 0);

  fetchGate = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const staleSend = send(
    '100',
    'stale after fetch',
    undefined,
    sendAuthorization,
  );
  await fetchGate.entered.promise;
  current = false;
  fetchGate.release.resolve();
  await assert.rejects(staleSend, /authorization.*expired/i);
  assert.equal(exactSends, 1);

  captureSpeechEnabled = true;
  const fetchesBeforeLateContinuation = fetchCalls;
  const capturesBeforeLateContinuation = speechCaptures;
  const effectsBeforeLateContinuation = speechEffects;
  await assert.rejects(
    send(
      '100',
      'stale continuation at exact source',
      { files: [{ path: '/tmp/must-not-be-read' }] },
      sendAuthorization,
    ),
    /authorization.*expired/i,
  );
  typing('100', sendAuthorization);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(fetchCalls, fetchesBeforeLateContinuation);
  assert.equal(exactSends, 1);
  assert.equal(speechCaptures, capturesBeforeLateContinuation);
  assert.equal(speechEffects, effectsBeforeLateContinuation);
  assert.equal(exactTyping, 2);
  captureSpeechEnabled = false;

  current = true;
  const laterAuthorization = issueAuthorization('100', 'g1', () => current);
  captureSpeechEnabled = true;
  const fetchesBeforeLaterScope = fetchCalls;
  const capturesBeforeLaterScope = speechCaptures;
  await assert.rejects(
    send(
      '100',
      'stale continuation during later scope',
      { files: [{ path: '/tmp/must-not-be-read' }] },
      sendAuthorization,
    ),
    /active mentions-turn authorization.*required/i,
  );
  typing('100', sendAuthorization);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(fetchCalls, fetchesBeforeLaterScope);
  assert.equal(exactSends, 1);
  assert.equal(speechCaptures, capturesBeforeLaterScope);
  assert.equal(speechEffects, effectsBeforeLateContinuation);
  assert.equal(exactTyping, 2);
  assert.equal(laterAuthorization.isCurrent(), true);
  captureSpeechEnabled = false;

  current = true;
  issueAuthorization('100', 'g1', () => current);
  captureSpeechEnabled = true;
  fetchGate = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const fetchesBeforeOmittedRace = fetchCalls;
  const omittedExpirySend = send('102', 'omitted expiry downgrade');
  current = false;
  fetchGate.release.resolve();
  await assert.rejects(
    omittedExpirySend,
    /active mentions-turn authorization.*required/i,
  );
  assert.equal(fetchCalls, fetchesBeforeOmittedRace);
  assert.equal(otherwiseSendableSends, 0);
  assert.equal(speechCaptures, 0);
  assert.equal(speechEffects, 0);
  captureSpeechEnabled = false;

  current = true;
  const mutedAuthorization = issueAuthorization('100', 'g1', () => current);
  fetchGate = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const mutedSend = send(
    '100',
    'muted after fetch',
    undefined,
    mutedAuthorization,
  );
  await fetchGate.entered.promise;
  activeMutes.set('100', 'mute');
  fetchGate.release.resolve();
  await assert.rejects(mutedSend, /muted/i);
  assert.equal(exactSends, 1);

  activeMutes.clear();
  current = false;
  await send('102', 'direct after scope expiry');
  await send('104', 'social after scope expiry');
  assert.equal(otherwiseSendableSends, 1);
  assert.equal(socialSends, 1);

  captureSpeechEnabled = true;
  fetchGate = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const fetchesBeforeScopeChange = fetchCalls;
  const crossScopeSend = send('102', 'scope changes during fetch');
  let replacementCurrent = true;
  issueAuthorization('100', 'g1', () => replacementCurrent);
  replacementCurrent = false;
  fetchGate.release.resolve();
  await assert.rejects(crossScopeSend, /authorization scope changed/i);
  assert.equal(fetchCalls, fetchesBeforeScopeChange + 1);
  assert.equal(otherwiseSendableSends, 1);
  assert.equal(speechCaptures, 1);
  assert.equal(speechEffects, 0);
  captureSpeechEnabled = false;

  current = true;
  const chunkAuthorization = issueAuthorization('100', 'g1', () => current);
  expireDuringChunkedSend = true;
  await assert.rejects(
    send('100', 'x'.repeat(3_000), undefined, chunkAuthorization),
    /authorization.*expired/i,
  );
  expireDuringChunkedSend = false;
  assert.equal(exactSends, 2, 'only the first message chunk left Discord');

  const explicitDenied = issueAuthorization('103', 'g1', () => true);
  await assert.rejects(
    send('103', 'explicit denial', undefined, explicitDenied),
    /channel allow_send=false/i,
  );
  const guildDenied = issueAuthorization('200', 'g2', () => true);
  await assert.rejects(
    send('200', 'guild denial', undefined, guildDenied),
    /guild allow_send=false/i,
  );
  const throwing = issueAuthorization('100', 'g1', () => {
    throw new Error('validator fault');
  });
  await assert.rejects(
    send('100', 'throwing validator', undefined, throwing),
    /authorization.*expired/i,
  );
  assert.equal(explicitDeniedSends, 0);
  assert.equal(guildDeniedSends, 0);
});

test('ignored authors cannot enter message, reply, or reaction paths', async (t) => {
  const received: InboundMessage[] = [];
  const feedback: unknown[] = [];
  const config = makeConfig();
  config.discord.ignoredUserIds = ['222'];
  config.discord.guilds = [
    {
      id: 'g1',
      slug: 'example',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      channels: { '100': 'direct' },
    },
  ];
  const debug = t.mock.method(config.logger, 'debug');
  const warn = t.mock.method(config.logger, 'warn');
  const { client } = createDiscord(
    config,
    {
      setSend: () => {},
      enqueue: (message: InboundMessage) => received.push(message),
    } as unknown as Agent,
    {
      feedback: {
        recordReaction: (entry: unknown) => feedback.push(entry),
      } as never,
    },
  );
  t.after(() => client.destroy());
  Object.defineProperty(client, 'user', {
    value: { id: '999' },
    configurable: true,
  });
  const onMessage = client.listeners(Events.MessageCreate)[0] as (
    message: Message,
  ) => Promise<void>;
  const onReaction = client.listeners(Events.MessageReactionAdd)[0] as (
    ...args: any[]
  ) => Promise<void>;
  const onReactionRemove = client.listeners(
    Events.MessageReactionRemove,
  )[0] as (...args: any[]) => Promise<void>;
  assert.ok(onReactionRemove, 'feedback remove listener is registered');
  const downstream = t.mock.fn(() => {
    throw new Error('ignored input reached downstream work');
  });
  const ignored = {
    author: { id: '222' },
    get guildId() {
      return downstream();
    },
  };
  await onMessage(ignored as unknown as Message);
  const ignoredReaction = {
    get partial() {
      return downstream();
    },
    get message() {
      return downstream();
    },
    get emoji() {
      return downstream();
    },
  };
  await onReaction(ignoredReaction, { id: '222' });
  await onReactionRemove(ignoredReaction, { id: '222' });
  assert.equal(downstream.mock.callCount(), 0);
  assert.equal(debug.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(received, []);
  assert.deepEqual(feedback, []);

  let replyAuthor = '222';
  const message = {
    id: 'message-1',
    guildId: 'g1',
    channelId: '100',
    content: 'Allowed message',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    author: { id: '111', bot: false, displayName: 'Bramble' },
    channel: {
      name: 'example',
      isThread: () => false,
      isTextBased: () => true,
      sendTyping: async () => {},
      messages: {
        fetch: async () => ({
          id: 'reply-1',
          author: { id: replyAuthor, displayName: 'Clover' },
          content: 'Reply content',
        }),
      },
    },
    reference: { messageId: 'reply-1' },
    mentions: {
      users: new Collection(),
      roles: new Collection(),
      channels: new Collection(),
    },
    attachments: new Collection(),
  } as unknown as Message;
  await onMessage(message);
  assert.equal(
    received.length,
    1,
    'the same listener still ingests allowed messages',
  );
  assert.equal(received[0].content, 'Allowed message');
  assert.equal(received[0].replyTo, null, 'ignored reply authors are withheld');
  replyAuthor = '333';
  await onMessage(message);
  assert.equal(received[1].replyTo?.content, 'Reply content');

  let hydrated = 0;
  const reaction = {
    partial: true,
    fetch: async () => {
      hydrated++;
    },
    message: { ...message, author: { id: '999' } },
    emoji: { name: '👍' },
  };
  await onReaction(reaction, { id: '222' });
  assert.equal(hydrated, 0);
  assert.deepEqual(feedback, []);
  await onReaction(reaction, { id: '111', displayName: 'Bramble' });
  assert.equal(hydrated, 1);
  assert.equal(
    feedback.length,
    1,
    'the same listener still records allowed reactions',
  );
});

test('feedback removal retracts the exact reaction with controls hidden and without reaction hydration', async (t) => {
  const config = makeConfig();
  config.discord.guilds = [
    {
      id: 'g1',
      slug: 'example',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      channels: { '100': 'direct' },
      feedbackReactions: false,
      channelFeedbackReactions: { '100': false },
    },
  ];

  const retractions: Array<{
    discordMessageId: string;
    reactorId: string;
    emoji: string;
  }> = [];
  const { client } = createDiscord(
    config,
    { setSend: () => {}, enqueue: () => {} } as unknown as Agent,
    {
      feedback: {
        recordReaction: () => {},
        retractReaction: (key: {
          discordMessageId: string;
          reactorId: string;
          emoji: string;
        }) => {
          retractions.push(key);
          return 1;
        },
      } as never,
    },
  );
  t.after(() => client.destroy());
  Object.defineProperty(client, 'user', {
    value: { id: '999' },
    configurable: true,
  });

  const removeListener = client.listeners(Events.MessageReactionRemove)[0];
  assert.ok(
    removeListener,
    'createDiscord must register a MessageReactionRemove listener',
  );
  const onRemove = removeListener as (...args: any[]) => Promise<void>;

  let reactionFetches = 0;
  let messageFetches = 0;
  const partialMessage: any = {
    id: 'message-1',
    guildId: 'g1',
    channelId: '100',
    partial: true,
    content: 'A bot-authored answer',
    channel: { name: 'general' },
    fetch: async () => {
      messageFetches++;
      partialMessage.partial = false;
      partialMessage.author = { id: '999', bot: true };
      return partialMessage;
    },
  };
  const removedReaction = {
    partial: true,
    // Discord may no longer be able to fetch a reaction after its removal.
    // The remove path has enough key data and must never call this edge.
    fetch: async () => {
      reactionFetches++;
      throw new Error('removed reaction no longer exists');
    },
    message: partialMessage,
    emoji: { name: '👍' },
  };
  await onRemove(removedReaction, {
    id: '111',
    partial: false,
    displayName: 'Bramble',
  });

  assert.equal(reactionFetches, 0);
  assert.equal(messageFetches, 1, 'only the partial message is hydrated');
  assert.deepEqual(retractions, [
    {
      discordMessageId: 'message-1',
      reactorId: '111',
      emoji: '👍',
    },
  ]);

  const fullReaction = (emoji: string, authorId: string) => ({
    partial: false,
    message: {
      id: 'message-1',
      guildId: 'g1',
      channelId: '100',
      partial: false,
      author: { id: authorId, bot: authorId === '999' },
      content: 'A message',
      channel: { name: 'general' },
    },
    emoji: { name: emoji },
  });
  await onRemove(fullReaction('👍', '999'), { id: '999', partial: false });
  await onRemove(fullReaction('❤️', '999'), { id: '111', partial: false });
  await onRemove(fullReaction('👎', 'human-author'), {
    id: '111',
    partial: false,
  });
  assert.equal(
    retractions.length,
    1,
    'bot self-removals, irrelevant emoji, and non-bot messages stay ignored',
  );
});

test('feedback add and remove are serialized in arrival order for one exact key', async (t) => {
  const config = makeConfig();
  config.discord.guilds = [
    {
      id: 'g1',
      slug: 'example',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      channels: { '100': 'direct' },
      feedbackReactions: false,
    },
  ];

  type Key = {
    discordMessageId: string;
    reactorId: string;
    emoji: string;
  };
  const projection: Key[] = [];
  const operations: string[] = [];
  const { client } = createDiscord(
    config,
    { setSend: () => {}, enqueue: () => {} } as unknown as Agent,
    {
      feedback: {
        recordReaction: (event: Key) => {
          operations.push('add');
          projection.push({
            discordMessageId: event.discordMessageId,
            reactorId: event.reactorId,
            emoji: event.emoji,
          });
        },
        retractReaction: (key: Key) => {
          operations.push('remove');
          let deleted = 0;
          for (let i = projection.length - 1; i >= 0; i--) {
            const row = projection[i];
            if (
              row.discordMessageId === key.discordMessageId &&
              row.reactorId === key.reactorId &&
              row.emoji === key.emoji
            ) {
              projection.splice(i, 1);
              deleted++;
            }
          }
          return deleted;
        },
      } as never,
    },
  );
  t.after(() => client.destroy());
  Object.defineProperty(client, 'user', {
    value: { id: '999' },
    configurable: true,
  });

  const addListener = client.listeners(Events.MessageReactionAdd)[0];
  const removeListener = client.listeners(Events.MessageReactionRemove)[0];
  assert.ok(addListener, 'precondition: add listener is registered');
  assert.ok(
    removeListener,
    'createDiscord must register a MessageReactionRemove listener',
  );
  const onAdd = addListener as (...args: any[]) => Promise<void>;
  const onRemove = removeListener as (...args: any[]) => Promise<void>;

  const hydrationEntered = Promise.withResolvers<void>();
  const releaseHydration = Promise.withResolvers<void>();
  const message = {
    id: 'message-race',
    guildId: 'g1',
    channelId: '100',
    partial: false,
    author: { id: '999', bot: true },
    content: 'Race-sensitive answer',
    channel: { name: 'general' },
  };
  const addReaction: any = {
    partial: true,
    message,
    emoji: { name: '👍' },
    fetch: async () => {
      hydrationEntered.resolve();
      await releaseHydration.promise;
      addReaction.partial = false;
      return addReaction;
    },
  };
  const removeReaction = {
    partial: false,
    message,
    emoji: { name: '👍' },
  };
  const user = { id: '111', partial: false, displayName: 'Bramble' };

  const addDone = onAdd(addReaction, user);
  await hydrationEntered.promise;
  // Arrival order is add then remove. Do not await remove here: a correctly
  // serialized remove waits behind the add's controlled hydration.
  const removeDone = onRemove(removeReaction, user);
  releaseHydration.resolve();
  await Promise.all([addDone, removeDone]);

  assert.deepEqual(
    operations,
    ['add', 'remove'],
    'the exact key must execute in listener arrival order',
  );
  assert.deepEqual(
    projection,
    [],
    'a fast remove must not leave a stale add after hydration completes',
  );
});
