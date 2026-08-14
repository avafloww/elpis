// moderation.test.ts — the killswitch's single transition implementation
// Agent.moderateChannel asymmetry under test: 'self' may
// only mute; release ('unmute'/'undeafen') and 'deafen' are operator-only, and
// a self actor can never override an existing operator row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildTestAgent, makeConfig } from './helpers.js';
import { createMuteStore, type MuteStore } from '../src/store/mutes.js';
import { createChannelDirectory } from '../src/store/channels.js';
import { openDatabase } from '../src/store/db.js';
import type { GuildConfig } from '../src/config.js';
import type { Agent } from '../src/agent.js';

const guilds: GuildConfig[] = [
  { id: 'g2', slug: 'friends-a', slashCommands: false, quietHours: null, timezone: null,
    channels: { '2001': 'social' } },
];

function build() {
  let mutesRef!: MuteStore;
  const built = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
 // The self-moderation notice names the agent from SOUL.md frontmatter —
 // written here (over the helper's bare '# Soul') to test the derivation.
      fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '---\nname: Echo\n---\n\n# Soul\n');
      const db = openDatabase(tmpDir);
      const mutes = createMuteStore(db);
      mutesRef = mutes;
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('2001', 'lounge', 'g2');
      return { mutes, channels };
    },
    tmpPrefix: 'harness-moderation-',
  });
  return { ...built, mutes: mutesRef };
}

/** The last internal-provenance ([harness] ...) message drained into history. */
function lastInternalNotice(agent: Agent): string {
  const users = agent.messagesForTest.filter(
    (m) => m.role === 'user' && m.content.includes('channel="harness"') && m.content.includes('author="harness"'),
  );
  return users[users.length - 1]?.content ?? '';
}

test('moderate: self-mute writes a self row and appends an internal notice', async () => {
  const { agent, mutes, cleanup } = build();

  const r = agent.moderateChannel('2001', 'mute', 'self', 'asked to stop');
  assert.equal(r.ok, true);
  assert.equal(mutes.get('2001')!.setBy, 'self');

  void agent.loop();
  await new Promise((res) => setTimeout(res, 20));
  assert.match(lastInternalNotice(agent), /friends-a\/lounge muted by Echo \(self\): asked to stop/);
  agent.stop();
  cleanup();
});

test('moderate: send to a muted channel throws with reason and release note', async () => {
  const { agent, cleanup } = build();

  agent.moderateChannel('2001', 'mute', 'self', 'asked to stop');
  await assert.rejects(() => agent.send('2001', 'hi'), /muted.*asked to stop.*release is operator-only/s);
  agent.stop();
  cleanup();
});

// A thread inherits its parent's policy on the way IN (resolvePolicyChannelId)
// but has its own Discord channel id and never gets a mute row of its own. If
// send checked the raw target only, muting #general would leave every thread
// under it wide open — and a thread is the natural reply target for any
// threaded conversation, so the bypass is the DEFAULT path, not an edge case.
// The parent link is recorded by enqueue (policyChannelId → channels.set).
test('moderate: a mute on a parent channel holds for a send into its thread', async () => {
  const { agent, mutes, sent, cleanup } = build();

 // A thread message as discord.ts builds it: the thread's own id/name for
 // provenance, the PARENT id for policy.
  agent.enqueue({
    id: 'm1', channelId: '2050', channelName: 'side-quest', author: 'ana', authorId: 'u1',
    content: 'over here', createdAt: new Date().toISOString(),
    replyTo: null, forwarded: null, mentions: [], attachments: [],
    guildId: 'g2', wakeClass: 'ambient', policyChannelId: '2001',
  });

  agent.moderateChannel('2001', 'mute', 'operator', 'quiet please');
  await assert.rejects(
    () => agent.send('2050', 'hi'),
    /parent.*muted.*quiet please.*release is operator-only/s,
  );
  assert.equal(sent.length, 0, 'nothing reached Discord');
  assert.equal(mutes.get('2050'), null, 'the block comes from the parent — the thread has no row of its own');

 // Releasing the parent releases the thread with it.
  agent.moderateChannel('2001', 'unmute', 'operator');
  await agent.send('2050', 'hi');
  assert.equal(sent.length, 1);

  agent.stop();
  cleanup();
});

test('moderate: self cannot release, self cannot override operator row', () => {
  const { agent, mutes, cleanup } = build();

  agent.moderateChannel('2001', 'mute', 'operator', 'op call');
  assert.equal(agent.moderateChannel('2001', 'mute', 'self').ok, false);
  assert.equal(agent.moderateChannel('2001', 'unmute', 'self').ok, false);
  assert.equal(mutes.get('2001')!.setBy, 'operator');
  cleanup();
});

test('moderate: deafen is operator-only, implies mute, replaces mute row', () => {
  const { agent, mutes, cleanup } = build();

  assert.equal(agent.moderateChannel('2001', 'deafen', 'self').ok, false);
  agent.moderateChannel('2001', 'mute', 'self');
  agent.moderateChannel('2001', 'deafen', 'operator', 'funky');
  assert.equal(mutes.get('2001')!.type, 'deafen');
  assert.equal(agent.moderateChannel('2001', 'mute', 'self').ok, false); // already deafened note
  cleanup();
});

test('moderate: operator release clears; release of a clean channel reports not-muted', () => {
  const { agent, mutes, cleanup } = build();

  agent.moderateChannel('2001', 'mute', 'self');
  assert.equal(agent.moderateChannel('2001', 'unmute', 'operator').ok, true);
  assert.equal(mutes.get('2001'), null);
  assert.equal(agent.moderateChannel('2001', 'unmute', 'operator').ok, false);
  cleanup();
});

test('moderate: unmute clears a deafen row (deafen implies mute, one row either verb releases)', () => {
  const { agent, mutes, cleanup } = build();

  agent.moderateChannel('2001', 'deafen', 'operator', 'noisy');
  assert.equal(mutes.get('2001')!.type, 'deafen');
  assert.equal(agent.moderateChannel('2001', 'unmute', 'operator').ok, true);
  assert.equal(mutes.get('2001'), null);
  cleanup();
});

test('roomsSnapshot: a configured-but-never-spoken-in channel still renders, carrying guildSlug/tier/muteState', () => {
  const localGuilds: GuildConfig[] = [
    { id: 'g3', slug: 'quiet-town', slashCommands: false, quietHours: null, timezone: null,
      channels: { '3001': 'quiet' } },
  ];
  const { agent, cleanup } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds: localGuilds } },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const mutes = createMuteStore(db);
      const channels = createChannelDirectory(db, tmpDir, localGuilds);
 // deliberately never call channels.set('3001', ...) — it has never been spoken in
      return { mutes, channels };
    },
    tmpPrefix: 'harness-rooms-',
  });

  const rooms = agent.roomsSnapshot();
  const room = rooms.find((r) => r.id === '3001');
  assert.ok(room, 'configured-but-never-spoken channel still renders');
  assert.equal(room!.guildSlug, 'quiet-town');
  assert.equal(room!.tier, 'quiet');
  assert.equal(room!.muteState, null);
  assert.equal(room!.count, 0);

  agent.moderateChannel('3001', 'deafen', 'operator');
  assert.equal(agent.roomsSnapshot().find((r) => r.id === '3001')!.muteState, 'deafen');

  const internal = rooms.find((r) => r.group === 'harness');
  assert.ok(internal, 'internal room present');
  assert.equal(internal!.guildSlug, null);
  assert.equal(internal!.tier, null);
  assert.equal(internal!.muteState, null);

  cleanup();
});
