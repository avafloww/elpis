// Unit tests for src/channels.ts — the persistent id→name directory, now
// backed by agent.db (channels table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import { createChannelDirectory } from '../src/store/channels.js';
import { buildTestAgent } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-channels-'));
}

test('records real names and persists them across a reload', () => {
  const dir = tmpDir();
  const d1 = createChannelDirectory(openDatabase(dir), dir);
  d1.set('111', 'unnamed-agent');
  d1.set('222', 'harness-work');
  assert.equal(d1.get('111'), 'unnamed-agent');

 // A fresh directory over a fresh handle reads the same rows back.
  const d2 = createChannelDirectory(openDatabase(dir), dir);
  assert.equal(d2.get('111'), 'unnamed-agent');
  assert.equal(d2.get('222'), 'harness-work');
  assert.deepEqual(
    d2.all().map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: '111', name: 'unnamed-agent' }, { id: '222', name: 'harness-work' }],
  );
});

test('ignores synthetic/placeholder names so a heartbeat cannot clobber a real name', () => {
  const dir = tmpDir();
  const d = createChannelDirectory(openDatabase(dir), dir);
  d.set('111', 'unnamed-agent');
  d.set('111', 'heartbeat');
  d.set('111', 'recovered');
  d.set('111', 'scheduler'); // scheduler wakes carry the task's REAL channelId — must not clobber (2026-07-22 #aster mislabel)
  d.set('111', 'fleet');
  d.set('111', 'harness');
  d.set('222', 'unknown');
  d.set('333', '');
  assert.equal(d.get('111'), 'unnamed-agent', 'real name is preserved');
  assert.equal(d.get('222'), undefined, "'unknown' is not recorded");
  assert.equal(d.get('333'), undefined, 'empty name is not recorded');
});

test('one-time imports a legacy channels.json when the table is empty', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify({ '111': 'general', '222': 'unknown' }));
  const d = createChannelDirectory(openDatabase(dir), dir);
  assert.equal(d.get('111'), 'general', 'real legacy name imported');
  assert.equal(d.get('222'), undefined, 'placeholder legacy name skipped');
});

test('malformed channels.json degrades to empty instead of throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'channels.json'), '{ not valid json');
  const d = createChannelDirectory(openDatabase(dir), dir);
  assert.deepEqual(d.all(), []);
  d.set('111', 'ok');
  assert.equal(d.get('111'), 'ok');
});

test('channels: set records guild id and all() returns entries', () => {
  const dir = tmpDir();
  const d = createChannelDirectory(openDatabase(dir), dir);
  d.set('100', 'general', 'g1');
  assert.deepEqual(d.all(), [{ id: '100', name: 'general', guildId: 'g1', parentId: null }]);
  assert.equal(d.guildOf('100'), 'g1');
  assert.equal(d.parentOf('100'), null);
});

// A thread's row carries the channel it inherits policy from. Agent.send
// reads it back so a mute on the parent holds inside the thread.
test('channels: parent id records, persists, heals, and never downgrades to null', () => {
  const dir = tmpDir();
  const d = createChannelDirectory(openDatabase(dir), dir);
  d.set('500', 'a-thread', 'g1');              // seen before the parent was known
  assert.equal(d.parentOf('500'), null);
  d.set('500', 'a-thread', 'g1', '100');       // heals
  assert.equal(d.parentOf('500'), '100');
  d.set('500', 'a-thread', 'g1');              // absent parent must NOT null it back
  assert.equal(d.parentOf('500'), '100');
  d.set('500', 'renamed-thread', 'g1');        // name change forces the upsert
  assert.equal(d.parentOf('500'), '100', 'a name-only update must not null the parent');

  const reloaded = createChannelDirectory(openDatabase(dir), dir);
  assert.equal(reloaded.parentOf('500'), '100');
  assert.deepEqual(reloaded.all(), [{ id: '500', name: 'renamed-thread', guildId: 'g1', parentId: '100' }]);
});

test('channels: NULL guild heals on next set, never downgrades to null', () => {
  const dir = tmpDir();
  const d = createChannelDirectory(openDatabase(dir), dir);
  d.set('100', 'general');                   // legacy-style, no guild
  assert.equal(d.guildOf('100'), null);
  d.set('100', 'general', 'g1');              // heals
  assert.equal(d.guildOf('100'), 'g1');
  d.set('100', 'general');                    // absent guild must NOT null it back
  assert.equal(d.guildOf('100'), 'g1');
  d.set('100', 'renamed');                    // name change forces the upsert (skips the early return)
  assert.equal(d.guildOf('100'), 'g1', 'a name-only update must not null the guild');
});

test('channels: two configured guilds leave a legacy NULL-guild row alone', () => {
  const dir = tmpDir();
  const db = openDatabase(dir); // migrations create the (empty) channels table
 // seed a row without a guild (as the v4->v5 migration would leave one), then
 // re-create the directory with TWO configured guilds — ambiguous, so no backfill.
  db.prepare(`INSERT INTO channels (id, name, updated_at) VALUES ('7', 'old', '2026-01-01')`).run();
  const dir2 = createChannelDirectory(db, dir, [{ id: 'g1' }, { id: 'g2' }]);
  assert.equal(dir2.guildOf('7'), null);
});

test('channels: single configured guild backfills legacy NULL rows at creation', () => {
  const dir = tmpDir();
  const db = openDatabase(dir); // migrations create the (empty) channels table
 // seed a row without a guild (as the v4->v5 migration would leave one), then
 // re-create the directory with exactly one configured guild.
  db.prepare(`INSERT INTO channels (id, name, updated_at) VALUES ('7', 'old', '2026-01-01')`).run();
  const dir2 = createChannelDirectory(db, dir, [{ id: 'g1' }]);
  assert.equal(dir2.guildOf('7'), 'g1');
});

test('shared test agents expose production-style qualified channel names', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify({ '100': 'general', '101': 'ops' }));
  const built = buildTestAgent({ dir });
  const listed = await built.sandbox.run("elpis.channel.list().map((entry) => entry.name).join(',')");
  const named = await built.sandbox.run("elpis.channel('stub/ops').name === 'ops'");
  assert.equal(listed.ok, true);
  assert.match(listed.preview, /console,stub\/general,stub\/ops/);
  assert.equal(named.ok, true);
  assert.equal(named.preview, 'true');
  fs.rmSync(dir, { recursive: true, force: true });
});
