import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import type { InboundMessage } from '../src/agent.js';
import { ContextGraphShadowRecorder } from '../src/context/shadow.js';
import { ContextGraphStore } from '../src/store/context-graph.js';
import { openDatabase } from '../src/store/db.js';
import { buildTestAgent } from './helpers.js';

function fixture(): {
  directory: string;
  database: DatabaseSync;
  recorder: ContextGraphShadowRecorder;
} {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-context-shadow-'),
  );
  const database = openDatabase(directory);
  return {
    directory,
    database,
    recorder: new ContextGraphShadowRecorder(new ContextGraphStore(database)),
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'message-1',
    channelId: 'channel-a',
    channelName: 'room-a',
    guildId: 'guild-a',
    guildSlug: 'example',
    author: 'Bramble',
    authorId: 'person-a',
    content: 'world A canary',
    createdAt: '2026-01-02T03:04:05.000Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    kind: 'discord',
    ...overrides,
  };
}

test('shadow ingress routes before recording and is idempotent by source identity', () => {
  const value = fixture();
  try {
    const message = inbound();
    const first = value.recorder.recordInbound(message);
    const repeated = value.recorder.recordInbound(message);
    assert.equal(repeated.sequence, first.sequence);
    assert.equal(first.worldId, 'world:discord:guild:guild-a');
    assert.equal(first.kind, 'inbound:discord');
    assert.deepEqual(JSON.parse(first.payloadJson), {
      schemaVersion: 1,
      id: 'message-1',
      source: null,
      transport: null,
      kind: 'discord',
      channelId: 'channel-a',
      channelName: 'room-a',
      guildId: 'guild-a',
      guildSlug: 'example',
      policyChannelId: null,
      originWorldId: null,
      author: 'Bramble',
      authorId: 'person-a',
      bot: false,
      content: 'world A canary',
      createdAt: '2026-01-02T03:04:05.000Z',
      replyTo: null,
      forwarded: null,
      mentions: [],
      attachments: [],
      wakeClass: 'wake',
      sendScope: null,
      sends: null,
    });
    const count = value.database
      .prepare('SELECT count(*) AS count FROM context_world_events')
      .get() as { count: number };
    assert.equal(count.count, 1);
    assert.throws(
      () => value.recorder.recordInbound({ ...message, content: 'changed' }),
      /context event identity conflict/,
    );
  } finally {
    value.database.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test('shadow ingress keeps malformed source timestamps idempotent', () => {
  const { database, recorder } = fixture();
  try {
    const message = inbound({ createdAt: 'not-a-timestamp' });
    const first = recorder.recordInbound(message);
    const repeated = recorder.recordInbound(message);
    assert.equal(first.occurredAt, 0);
    assert.deepEqual(repeated, first);
  } finally {
    database.close();
  }
});

test('Agent.enqueue attaches the durable graph identity before FIFO drain', () => {
  const built = buildTestAgent({
    agentDeps: ({ db }) => ({
      contextGraphShadow: new ContextGraphShadowRecorder(
        new ContextGraphStore(db),
      ),
    }),
  });
  try {
    const message = inbound();
    built.agent.enqueue(message);
    assert.deepEqual(message.contextGraphLineage, {
      worldId: 'world:discord:guild:guild-a',
      eventId: message.contextGraphLineage?.eventId,
      sequence: 1,
    });
    assert.match(
      message.contextGraphLineage?.eventId ?? '',
      /^event:ingress:[0-9a-f]{64}$/,
    );
  } finally {
    built.scheduler.stop();
    built.db.close();
    built.cleanup();
  }
});

test('shadow ingress keeps Signal contacts separate and honors trusted origin worlds', () => {
  const value = fixture();
  try {
    const signal = value.recorder.recordInbound(
      inbound({
        id: 'signal-1',
        channelId: 'signal:bramble',
        channelName: 'bramble',
        guildId: undefined,
        guildSlug: undefined,
        kind: 'signal',
        transport: 'signal',
      }),
    );
    assert.equal(signal.worldId, 'world:signal:signal%3Abramble');

    const synthetic = value.recorder.recordInbound(
      inbound({
        id: 'job-1',
        channelId: '__internal__',
        channelName: 'harness',
        guildId: undefined,
        guildSlug: undefined,
        kind: 'harness',
        originWorldId: 'world:discord:guild:guild-a',
      }),
    );
    assert.equal(synthetic.worldId, 'world:discord:guild:guild-a');
  } finally {
    value.database.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
