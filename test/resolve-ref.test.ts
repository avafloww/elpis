// resolve-ref.test.ts — guild-qualified channel refs.
//
// resolveChannelRef('slug/name') resolves within its guild; a raw digit id
// passes through unqualified (globally unambiguous); a BARE non-numeric name
// throws even when it uniquely matches exactly one channel — qualification is
// never optional, because guessing wrong here delivers a private message to
// the wrong friend group. Unknown refs return null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestAgent, makeConfig } from './helpers.js';
import { createChannelDirectory } from '../src/store/channels.js';
import { openDatabase } from '../src/store/db.js';
import { buildGlobals } from '../src/sandbox/globals.js';
import type { GuildConfig } from '../src/config.js';

const guilds: GuildConfig[] = [
  {
    id: 'g1',
    slug: 'home',
    slashCommands: true,
    quietHours: null,
    timezone: null,
    channels: { '1001': 'direct', '1002': 'social' },
  },
  {
    id: 'g2',
    slug: 'friends-a',
    slashCommands: false,
    quietHours: null,
    timezone: null,
    channels: { '2001': 'social' },
  },
];

function buildAgentWithChannels() {
  const built = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
      const channels = createChannelDirectory(openDatabase(tmpDir), tmpDir);
      channels.set('1002', 'lounge', 'g1');
      channels.set('2001', 'lounge', 'g2');
      channels.set('1001', 'general', 'g1');
      return { channels };
    },
    tmpPrefix: 'harness-resolve-ref-',
  });
  return built;
}

// Two configured guilds, so createChannelDirectory's single-guild auto-backfill
// (src/channels.ts) never fires — these rows stay NULL-guild exactly like a
// real pre-upgrade directory on a two-server install (Fix 1's deploy-day hazard).
function buildAgentWithNullGuildRows() {
  const built = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
      const channels = createChannelDirectory(openDatabase(tmpDir), tmpDir);
      // '1002' IS in the config allowlist (guild g1/home) but its row has never
      // healed — simulates the untouched legacy row on first boot post-upgrade.
      channels.set('1002', 'lounge');
      // '9999' is NOT in the config allowlist — a NULL-guild row here has no
      // config fallback and must correctly stay unaddressable by qualified name.
      channels.set('9999', 'archived');
      return { channels };
    },
    tmpPrefix: 'harness-resolve-ref-nullguild-',
  });
  return built;
}

test('resolveChannelRef: qualified slug/name resolves within its guild', () => {
  const { agent, cleanup } = buildAgentWithChannels();
  assert.equal(agent.resolveChannelRef('home/lounge'), '1002');
  assert.equal(agent.resolveChannelRef('friends-a/lounge'), '2001');
  assert.equal(agent.resolveChannelRef('friends-a/#lounge'), '2001');
  cleanup();
});

test('resolveChannelRef: raw id passes unqualified', () => {
  const { agent, cleanup } = buildAgentWithChannels();
  assert.equal(agent.resolveChannelRef('1002'), '1002');
  cleanup();
});

test('resolveChannelRef: bare name throws even when unique, listing qualified candidates', () => {
  const { agent, cleanup } = buildAgentWithChannels();
  assert.throws(
    () => agent.resolveChannelRef('general'),
    /unqualified.*home\/general/s,
  );
  assert.throws(() => agent.resolveChannelRef('lounge'), /home\/lounge/s);
  assert.throws(() => agent.resolveChannelRef('lounge'), /friends-a\/lounge/s);
  cleanup();
});

test('resolveChannelRef: unknown name returns null; unknown slug returns null', () => {
  const { agent, cleanup } = buildAgentWithChannels();
  assert.equal(agent.resolveChannelRef('nope/lounge'), null);
  assert.equal(agent.resolveChannelRef('zzz'), null);
  cleanup();
});

// A newly-configured server's channels have no directory row until one message
// arrives (Agent.enqueue is the directory's only writer), so a raw id must
// resolve off the CONFIG allowlist too. Without it /mute answers "unknown
// channel" for a channel the operator just listed — while the sandbox (which
// skips resolution for all-digit refs) and the console (raw id straight to
// moderateChannel) can already reach it.
test('resolveChannelRef: configured-but-never-seen raw id resolves; qualified name still needs one message', () => {
  const { agent, cleanup } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => ({
      // A freshly-added second server: configured, but nothing has ever spoken
      // there, so the directory is empty.
      channels: createChannelDirectory(openDatabase(tmpDir), tmpDir),
    }),
    tmpPrefix: 'harness-resolve-ref-unseen-',
  });
  assert.equal(
    agent.resolveChannelRef('2001'),
    '2001',
    'addressable by raw id immediately',
  );
  assert.equal(
    agent.resolveChannelRef('friends-a/lounge'),
    null,
    'config carries ids, not names — a qualified name needs the channel to have carried one message',
  );
  assert.equal(
    agent.resolveChannelRef('4242'),
    null,
    'an unconfigured, unseen raw id stays unknown',
  );
  cleanup();
});

test('roomsSnapshot: reserved console room is not duplicated by its directory row', () => {
  const built = buildTestAgent({
    agentDeps: ({ tmpDir }) => {
      const channels = createChannelDirectory(openDatabase(tmpDir), tmpDir);
      channels.set('console', 'console');
      return { channels };
    },
    tmpPrefix: 'harness-console-room-',
  });
  assert.equal(
    built.agent.roomsSnapshot().filter((room) => room.id === 'console').length,
    1,
  );
  built.cleanup();
});

test('knownChannels: labels are guild-qualified', () => {
  const { agent, cleanup } = buildAgentWithChannels();
  const names = agent
    .knownChannels()
    .map((c) => c.name)
    .sort();
  assert.deepEqual(names, [
    'console',
    'friends-a/lounge',
    'home/general',
    'home/lounge',
  ]);
  assert.equal(agent.resolveChannelRef('console'), 'console');
  assert.equal(agent.qualifiedChannelLabel('console'), 'console');
  cleanup();
});

// Fix 1: a directory row's guildId is NULL, but the channel IS in the config
// allowlist — resolveChannelRef must fall back to the config guild index
// (guildIndex.byChannel) rather than requiring the row to have healed first.
// Deploy-day-critical: a multi-guild install backfills nothing at boot (only a
// single-configured-guild install does), so every pre-upgrade row starts here.
test('resolveChannelRef: NULL-guild row for a CONFIGURED channel resolves via the config fallback (Fix 1)', () => {
  const { agent, cleanup } = buildAgentWithNullGuildRows();
  assert.equal(agent.resolveChannelRef('home/lounge'), '1002');
  cleanup();
});

test('knownChannels: a NULL-guild row for a CONFIGURED channel renders a qualified label via the config fallback (Fix 1)', () => {
  const { agent, cleanup } = buildAgentWithNullGuildRows();
  const entry = agent.knownChannels().find((c) => c.id === '1002');
  assert.equal(entry?.name, 'home/lounge');
  cleanup();
});

// A NULL-guild row for a channel NOT in the config allowlist has no config
// fallback (it's a legacy row for a channel since removed from config) — it
// correctly stays unaddressable by qualified name and renders its raw id.
test('resolveChannelRef: NULL-guild row for an UNCONFIGURED channel stays unaddressable by qualified name', () => {
  const { agent, cleanup } = buildAgentWithNullGuildRows();
  assert.equal(agent.resolveChannelRef('home/archived'), null);
  cleanup();
});

test('knownChannels/qualifiedChannelLabel: a NULL-guild row for an UNCONFIGURED channel renders its raw id', () => {
  const { agent, cleanup } = buildAgentWithNullGuildRows();
  const entry = agent.knownChannels().find((c) => c.id === '9999');
  assert.equal(entry?.name, '9999');
  assert.equal(agent.qualifiedChannelLabel('9999'), '#archived');
  cleanup();
});

// Fix 6: the delivered-echo label shape end to end, through the actual
// elpis.channel(ref).send global (not just the agent-side label helper).
test('elpis.channel().send(): delivered-echo renders the guild-qualified label end to end', async () => {
  const { agent, cleanup } = buildAgentWithChannels();
  const g = buildGlobals({
    config: {
      paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
      sandbox: {
        syncTimeoutMs: 5000,
        asyncDeadlineMs: 10000,
        previewMaxBytes: 2048,
        logMaxBytes: 2048,
      },
      kagi: { apiKey: null },
    },
    resolveChannel: (ref: string) => agent.resolveChannelRef(ref),
    channelLabel: (id: string) => agent.qualifiedChannelLabel(id),
    send: async () => {},
  } as Parameters<typeof buildGlobals>[0]);
  const elpis = g.elpis as {
    channel: (ref: string) => {
      send: (t: string) => Promise<{ note: string }>;
    };
  };
  const res = await elpis.channel('home/lounge').send('hi');
  assert.match(res.note, /message delivered to home\/lounge \(1002\)/);
  cleanup();
});

test('elpis.channel().send(): delivered-echo for an unknown channel id renders it once, not twice (Fix 3)', async () => {
  const { agent, cleanup } = buildAgentWithChannels();
  const g = buildGlobals({
    config: {
      paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
      sandbox: {
        syncTimeoutMs: 5000,
        asyncDeadlineMs: 10000,
        previewMaxBytes: 2048,
        logMaxBytes: 2048,
      },
      kagi: { apiKey: null },
    },
    resolveChannel: (ref: string) => agent.resolveChannelRef(ref),
    channelLabel: (id: string) => agent.qualifiedChannelLabel(id),
    send: async () => {},
  } as Parameters<typeof buildGlobals>[0]);
  const elpis = g.elpis as {
    channel: (ref: string) => {
      send: (t: string) => Promise<{ note: string }>;
    };
  };
  const res = await elpis.channel('999999').send('hi');
  assert.match(res.note, /delivered to 999999\./);
  assert.doesNotMatch(res.note, /999999 \(999999\)/);
  cleanup();
});
