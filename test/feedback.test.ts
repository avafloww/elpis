// Unit tests for src/feedback.ts — out-of-band feedback capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import {
  createFeedbackStore,
  classifyEmoji,
  type FeedbackEvent,
} from '../src/store/feedback.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-feedback-'));
}

test('classifyEmoji maps only 👍/👎', () => {
  assert.equal(classifyEmoji('👍'), 'good');
  assert.equal(classifyEmoji('👎'), 'bad');
  assert.equal(classifyEmoji('❤️'), null);
  assert.equal(classifyEmoji(null), null);
});

test('recordReaction inserts a feedback row', () => {
  const db = openDatabase(tmpDir());
  const store = createFeedbackStore(db);
  const ev: FeedbackEvent = {
    verdict: 'good',
    reactedAt: '2026-07-13T12:00:00Z',
    emoji: '👍',
    reactorId: 'u1',
    reactorName: 'Clover',
    isOwner: true,
    discordMessageId: 'm1',
    channelId: 'c1',
    channelName: 'general',
    messageContent: 'Tomatoes 18–24 in apart.',
  };
  store.recordReaction(ev);
  const row = db
    .prepare('SELECT * FROM feedback WHERE discord_message_id = ?')
    .get('m1') as Record<string, unknown>;
  assert.equal(row.verdict, 'good');
  assert.equal(row.emoji, '👍');
  assert.equal(row.reactor_id, 'u1');
  assert.equal(row.reactor_name, 'Clover');
  assert.equal(row.is_owner, 1);
  assert.equal(row.channel_name, 'general');
  assert.equal(row.message_content, 'Tomatoes 18–24 in apart.');
  db.close();
});

test('recordReaction stores nullable fields as NULL and is_owner=0', () => {
  const db = openDatabase(tmpDir());
  const store = createFeedbackStore(db);
  store.recordReaction({
    verdict: 'bad',
    reactedAt: '2026-07-13T12:00:00Z',
    emoji: '👎',
    reactorId: 'u2',
    reactorName: null,
    isOwner: false,
    discordMessageId: 'm2',
    channelId: 'c1',
    channelName: null,
    messageContent: 'oops',
  });
  const row = db
    .prepare(
      'SELECT reactor_name, channel_name, is_owner FROM feedback WHERE discord_message_id = ?',
    )
    .get('m2') as Record<string, unknown>;
  assert.equal(row.reactor_name, null);
  assert.equal(row.channel_name, null);
  assert.equal(row.is_owner, 0);
  db.close();
});

test('retractReaction deletes every exact-key duplicate and nothing else', () => {
  const db = openDatabase(tmpDir());
  const store = createFeedbackStore(db);
  const base: FeedbackEvent = {
    verdict: 'good',
    reactedAt: '2026-07-13T12:00:00Z',
    emoji: '👍',
    reactorId: 'u1',
    reactorName: 'Clover',
    isOwner: false,
    discordMessageId: 'm1',
    channelId: 'c1',
    channelName: 'general',
    messageContent: 'A useful answer.',
  };

  // Historical add events may contain duplicates. Retraction is a current-state
  // correction, so one remove event must clear all duplicates for its exact
  // Discord message + reactor + emoji key.
  store.recordReaction(base);
  store.recordReaction({ ...base, reactedAt: '2026-07-13T12:01:00Z' });
  store.recordReaction({ ...base, verdict: 'bad', emoji: '👎' });
  store.recordReaction({ ...base, reactorId: 'u2' });
  store.recordReaction({ ...base, discordMessageId: 'm2' });

  assert.equal(
    store.retractReaction({
      discordMessageId: 'm1',
      reactorId: 'u1',
      emoji: '👍',
    }),
    2,
  );

  const survivors = (
    db
      .prepare(
        'SELECT discord_message_id, reactor_id, emoji FROM feedback ORDER BY discord_message_id, reactor_id, emoji',
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row }));
  assert.deepEqual(survivors, [
    { discord_message_id: 'm1', reactor_id: 'u1', emoji: '👎' },
    { discord_message_id: 'm1', reactor_id: 'u2', emoji: '👍' },
    { discord_message_id: 'm2', reactor_id: 'u1', emoji: '👍' },
  ]);

  assert.equal(
    store.retractReaction({
      discordMessageId: 'm1',
      reactorId: 'u1',
      emoji: '👍',
    }),
    0,
    'a repeated Discord remove is an idempotent no-op',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM feedback').get().count,
    3,
  );
  db.close();
});
