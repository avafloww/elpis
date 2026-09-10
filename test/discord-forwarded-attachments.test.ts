import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import sharp from 'sharp';
import { ATTACHMENT_DIR } from '../src/types.js';
import {
  Collection,
  Events,
  MessageReferenceType,
  type Message,
  type Attachment,
  type MessageSnapshot,
} from 'discord.js';
import { createDiscord } from '../src/discord/discord.js';
import type { Agent, InboundMessage } from '../src/agent.js';
import { formatInboundEnvelope } from '../src/lib/envelope.js';
import { buildTestAgent, makeConfig } from './helpers.js';

const file = (id: string, contentType = 'text/plain') =>
  ({
    id,
    name: 'sample.dat',
    url: 'https://example.com/' + id,
    size: contentType.startsWith('image/') ? TINY_PNG.byteLength : 4,
    contentType,
  }) as Attachment;
const collection = (files: Attachment[]) =>
  new Collection(files.map((a) => [a.id, a]));
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const snapshot = (files: Attachment[]) =>
  ({
    content: 'Forwarded sample',
    attachments: collection(files),
    mentions: {
      users: new Collection(),
      roles: new Collection(),
      channels: new Collection(),
    },
  }) as unknown as MessageSnapshot;

async function ingest(
  t: TestContext,
  direct: Attachment[],
  snap?: MessageSnapshot,
  laterSnapshots: MessageSnapshot[] = [],
) {
  const id = 'snapshot-test-' + randomUUID();
  t.after(() =>
    rm(path.join(ATTACHMENT_DIR, id), { recursive: true, force: true }),
  );
  const config = makeConfig();
  config.discord.guilds = [
    {
      id: 'g1',
      slug: 'alpha',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      channels: { '1002': 'direct' },
    },
  ];
  config.discord.attachmentInlineMaxBytes = 4;
  const received: InboundMessage[] = [];
  const { client } = createDiscord(config, {
    setSend: () => {},
    enqueue: (m: InboundMessage) => received.push(m),
  } as Agent);
  let referenceFetches = 0;
  let snapshotReads = 0;
  const message = {
    id,
    guildId: 'g1',
    channelId: '1002',
    content: '',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    author: { id: 'u1', bot: false, displayName: 'Bramble' },
    channel: {
      name: 'samples',
      isThread: () => false,
      isTextBased: () => true,
      sendTyping: async () => {},
      messages: {
        fetch: async () => {
          referenceFetches++;
          return null;
        },
      },
    },
    reference: snap
      ? { type: MessageReferenceType.Forward, messageId: 'original-fixture' }
      : null,
    mentions: {
      users: new Collection(),
      roles: new Collection(),
      channels: new Collection(),
    },
    attachments: collection(direct),
    ...(snap
      ? {
          messageSnapshots: {
            first: () => {
              snapshotReads++;
              return snap;
            },
            values: () => [snap, ...laterSnapshots].values(),
          },
        }
      : {}),
  } as unknown as Message;
  const originalFetch = globalThis.fetch;
  const downloads: string[] = [];
  globalThis.fetch = async (url) => {
    downloads.push(String(url));
    return new Response(String(url).endsWith('/image') ? TINY_PNG : 'text');
  };
  try {
    const listener = client.listeners(Events.MessageCreate)[0] as (
      m: Message,
    ) => Promise<void>;
    await listener(message);
    assert.equal(received.length, 1);
    return { inbound: received[0], downloads, referenceFetches, snapshotReads };
  } finally {
    globalThis.fetch = originalFetch;
    await client.destroy();
  }
}

test('forwarded text and image hydrate from one embedded snapshot without fetching its origin', async (t) => {
  const { inbound, downloads, referenceFetches, snapshotReads } = await ingest(
    t,
    [],
    snapshot([file('image', 'image/png')]),
  );
  assert.equal(inbound.forwarded?.content, 'Forwarded sample');
  assert.equal(inbound.forwarded?.author, 'unknown');
  assert.equal(inbound.replyTo, null);
  assert.equal(referenceFetches, 0);
  assert.equal(snapshotReads, 1);
  assert.deepEqual(downloads, ['https://example.com/image']);
  assert.equal(inbound.attachments.length, 1);
  assert.equal(inbound.attachments[0].source, 'forwarded');
  assert.equal(inbound.attachments[0].contentType, 'image/png');
  assert.ok(inbound.attachments[0].localPath);
  assert.match(formatInboundEnvelope(inbound, '[test]'), /\[forwarded\]/);
});

test('forwarded image reaches agent history as decodable vision content', async (t) => {
  const { inbound } = await ingest(
    t,
    [],
    snapshot([file('image', 'image/png')]),
  );
  const { agent, cleanup } = buildTestAgent({
    tmpPrefix: 'forwarded-attachment-vision-',
  });
  let loop: Promise<void> | null = null;
  t.after(async () => {
    agent.stop();
    try {
      await loop;
    } finally {
      cleanup();
    }
  });
  let idleResolve: (() => void) | null = null;
  agent['deps'].onIdle = () => idleResolve?.();
  loop = agent.loop();
  const idle = new Promise<void>((resolve) => {
    idleResolve = resolve;
  });
  agent.enqueue(inbound);
  await idle;

  const userMessage = agent.messagesForTest.find(
    (message) =>
      message.role === 'user' && message.content.includes('Forwarded sample'),
  );
  const imagePart = userMessage?.contentParts?.find(
    (part) => part.type === 'image_url',
  );
  assert.ok(imagePart && imagePart.type === 'image_url');
  const match = /^data:image\/png;base64,(.+)$/.exec(imagePart.image_url.url);
  assert.ok(match);
  const decoded = await sharp(Buffer.from(match[1], 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 1);
  assert.equal(decoded.info.height, 1);
  assert.equal(decoded.info.channels, 4);
  assert.equal(decoded.data.byteLength, 4);
});

test('direct-only attachment hydration and envelope remain unchanged', async (t) => {
  const { inbound } = await ingest(t, [file('direct')]);
  const a = inbound.attachments[0];
  assert.equal(a.source, undefined); // absence retains the legacy direct representation
  assert.equal(a.inlineText, 'text');
  assert.equal(inbound.forwarded, null);
  assert.match(a.localPath!, /sample-0.dat$/);
  assert.doesNotMatch(
    formatInboundEnvelope(inbound, '[test]'),
    /source="forwarded"|\[forwarded\]/,
  );
});

test('mixed direct and forwarded files preserve order, distinct paths, and shared inline budget', async (t) => {
  const { inbound, downloads } = await ingest(
    t,
    [file('direct')],
    snapshot([file('forwarded')]),
  );
  assert.deepEqual(downloads, [
    'https://example.com/direct',
    'https://example.com/forwarded',
  ]);
  const [direct, forwarded] = inbound.attachments;
  assert.equal(direct.inlineText, 'text');
  assert.equal(forwarded.inlineText, null);
  assert.equal(forwarded.source, 'forwarded');
  assert.notEqual(direct.localPath, forwarded.localPath);
  assert.match(forwarded.localPath!, /sample-1.dat$/);
  assert.equal(await readFile(forwarded.localPath!, 'utf8'), 'text');
});

test('absent snapshot and no direct attachments remain empty', async (t) => {
  const { inbound, downloads } = await ingest(t, []);
  assert.equal(inbound.forwarded, null);
  assert.deepEqual(inbound.attachments, []);
  assert.deepEqual(downloads, []);
});

test('forwarded text and attachments select only the first snapshot', async (t) => {
  const first = snapshot([file('first')]);
  const later = { ...snapshot([file('later')]), content: 'Later sample' };
  const { inbound, downloads, referenceFetches, snapshotReads } = await ingest(
    t,
    [],
    first,
    [later],
  );
  assert.equal(inbound.forwarded?.content, 'Forwarded sample');
  assert.deepEqual(downloads, ['https://example.com/first']);
  assert.equal(inbound.attachments.length, 1);
  assert.equal(inbound.attachments[0].url, 'https://example.com/first');
  assert.equal(inbound.attachments[0].source, 'forwarded');
  assert.equal(referenceFetches, 0);
  assert.equal(snapshotReads, 1);
});

test('forwarded text file retains provenance on its inline body', async (t) => {
  const { inbound } = await ingest(t, [], snapshot([file('forwarded')]));
  assert.equal(inbound.attachments[0].inlineText, 'text');
  assert.match(
    formatInboundEnvelope(inbound, '[test]'),
    /<attachment-content name="sample.dat" source="forwarded">text<\/attachment-content>/,
  );
});
