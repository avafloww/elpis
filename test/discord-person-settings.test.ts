import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/db.js';
import { createDiscordPersonSettingsStore } from '../src/store/discord-person-settings.js';
import { buildGlobals } from '../src/sandbox/globals.js';

const GUILD_A = '4001';
const GUILD_B = '4002';
const USER = '6001';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'elpis-discord-person-settings-'));
}

test('Discord mention notification settings default false and remain guild scoped across restart', () => {
  const dir = tempDir();
  try {
    let db = openDatabase(dir);
    let store = createDiscordPersonSettingsStore(db);
    assert.deepEqual(store.get(GUILD_A, USER), {
      guildId: GUILD_A,
      userId: USER,
      notifyOnMention: false,
      updatedAt: null,
    });
    const enabled = store.set(GUILD_A, USER, true);
    assert.equal(enabled.notifyOnMention, true);
    assert.match(enabled.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.allowsMentionNotification(GUILD_A, USER), true);
    assert.equal(store.allowsMentionNotification(GUILD_B, USER), false);
    db.close();

    db = openDatabase(dir);
    store = createDiscordPersonSettingsStore(db);
    assert.equal(store.get(GUILD_A, USER).notifyOnMention, true);
    assert.equal(store.set(GUILD_A, USER, false).notifyOnMention, false);
    assert.equal(store.allowsMentionNotification(GUILD_A, USER), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Discord person settings reject malformed or widened identities', () => {
  const dir = tempDir();
  const db = openDatabase(dir);
  try {
    const store = createDiscordPersonSettingsStore(db);
    for (const value of ['', 'guild', '1'.repeat(21), ' 123', '1e3']) {
      assert.throws(() => store.get(value, USER), /guildId/);
      assert.throws(() => store.get(GUILD_A, value), /userId/);
    }
    assert.throws(
      () => store.set(GUILD_A, USER, 1 as unknown as boolean),
      /notifyOnMention/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resident personSettings API uses explicit primitive ids in core and full sandboxes', () => {
  for (const surface of ['core', 'full'] as const) {
    const calls: unknown[][] = [];
    const record = {
      guildId: GUILD_A,
      userId: USER,
      notifyOnMention: false,
      updatedAt: null,
    };
    const globals = buildGlobals({
      surface,
      config: {
        paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
        sandbox: {
          syncTimeoutMs: 5000,
          asyncDeadlineMs: 10000,
          persistentRetirementGraceMs: 1000,
          previewMaxBytes: 2048,
          logMaxBytes: 2048,
        },
        kagi: { apiKey: null },
        bluesky: null,
      },
      logbuf: [],
      personSettings: {
        discord: {
          get: (guildId: string, userId: string) => {
            calls.push(['get', guildId, userId]);
            return record;
          },
          set: (guildId: string, userId: string, enabled: boolean) => {
            calls.push(['set', guildId, userId, enabled]);
            return { ...record, notifyOnMention: enabled };
          },
        },
      },
    } as any);
    const api = (globals.elpis as any).personSettings.discord;
    assert.deepEqual(api.get(GUILD_A, USER), record);
    assert.equal(api.set(GUILD_A, USER, true).notifyOnMention, true);
    assert.deepEqual(calls, [
      ['get', GUILD_A, USER],
      ['set', GUILD_A, USER, true],
    ]);
    assert.throws(() => api.get('guild', USER), /guildId/);
    assert.throws(() => api.set(GUILD_A, USER, 1), /notifyOnMention/);
    assert.equal(calls.length, 2);
  }
});
