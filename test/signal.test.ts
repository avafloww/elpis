import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { InboundMessage } from '../src/agent.js';
import type { SignalConfig } from '../src/config.js';
import type { CompleteResult, LLM } from '../src/llm/llm.js';
import { buildTestAgent, EMPTY_WAKE } from './helpers.js';
import { createOutboundTransportRouter } from '../src/index.js';
import {
  createSignalTransport,
  type SignalCliLike,
} from '../src/signal/signal.js';
import type { SignalCliOptions, SignalCliReceiveNotification } from '../src/signal/signal-cli.js';

const LOCAL_ACI = '00000000-0000-4000-8000-000000000001';
const BRAMBLE_ACI = '00000000-0000-4000-8000-000000000002';
const CEDAR_ACI = '00000000-0000-4000-8000-000000000003';
const BRAMBLE_ROOM = `signal:dm:${BRAMBLE_ACI}`;

function config(overrides: Partial<SignalConfig> = {}): SignalConfig {
  return {
    enabled: true,
    executable: '/opt/signal-cli/bin/signal-cli',
    dataDir: '/tmp/synthetic-signal-data',
    account: LOCAL_ACI,
    expectedVersion: '0.14.9',
    requestTimeoutMs: 12000,
    contacts: {
      bramble: {
        alias: 'bramble',
        aci: BRAMBLE_ACI,
        displayName: 'Bramble',
        receive: true,
        allowSend: true,
      },
      cedar: {
        alias: 'cedar',
        aci: CEDAR_ACI,
        displayName: 'Cedar',
        receive: false,
        allowSend: false,
      },
    },
    ...overrides,
  };
}

class FakeClient implements SignalCliLike {
  state = 'running' as const;
  readonly sends: Array<{ recipient: string; message: string }> = [];
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  stopped = false;
  version = '0.14.9';
  private receive: ((value: SignalCliReceiveNotification) => void) | null = null;
  onReceive(handler: (value: SignalCliReceiveNotification) => void): () => void {
    this.receive = handler;
    return () => {
      if (this.receive === handler) this.receive = null;
    };
  }
  onStateChange(): () => void {
    return () => {};
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    return { version: this.version };
  }
  async sendText(recipient: string, message: string) {
    this.sends.push({ recipient, message });
    return { status: 'accepted' as const };
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  emit(envelope: Record<string, unknown>): void {
    this.receive?.({ envelope });
  }
}

function harness(signalConfig = config()) {
  const client = new FakeClient();
  const created: SignalCliOptions[] = [];
  const inbound: InboundMessage[] = [];
  let muted = false;
  const transport = createSignalTransport(signalConfig, {
    enqueue: (message) => inbound.push(message),
    isMuted: () => muted,
    clientFactory: (options) => {
      created.push(options);
      return client;
    },
  });
  assert.ok(transport);
  return {
    client,
    created,
    inbound,
    transport,
    setMuted: (value: boolean) => {
      muted = value;
    },
  };
}

function oneShotLlm() {
  const capture = { calls: 0, messages: [] as Array<{ content?: string }> };
  const completed = Promise.withResolvers<void>();
  const llm = {
    client: {} as LLM['client'],
    model: 'test',
    runTool: {} as LLM['runTool'],
    complete(messages: Array<{ content?: string }>): Promise<CompleteResult> {
      capture.calls++;
      capture.messages = messages.map((message) => ({ ...message }));
      completed.resolve();
      return Promise.resolve(EMPTY_WAKE);
    },
    summarize: () => Promise.resolve('SUMMARY'),
  } as LLM;
  return { llm, capture, completed: completed.promise };
}

function directEnvelope(
  sourceUuid: string,
  message: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceUuid,
    timestamp: 1790550000123,
    dataMessage: { message, timestamp: 1790550000123, ...extra },
  };
}

test('disabled Signal creates no client or transport', () => {
  let created = 0;
  const transport = createSignalTransport(
    config({ enabled: false }),
    {
      enqueue: () => assert.fail('disabled transport cannot enqueue'),
      isMuted: () => false,
      clientFactory: () => {
        created++;
        return new FakeClient();
      },
    },
  );
  assert.equal(transport, null);
  assert.equal(created, 0);
});

test('start uses exact process config and fails closed on version mismatch', async () => {
  const ok = harness();
  await ok.transport.start();
  assert.deepEqual(ok.created, [
    {
      command: '/opt/signal-cli/bin/signal-cli',
      dataDir: '/tmp/synthetic-signal-data',
      account: LOCAL_ACI,
      requestTimeoutMs: 12000,
    },
  ]);
  assert.deepEqual(ok.client.requests, [{ method: 'version', params: {} }]);

  const mismatch = harness();
  mismatch.client.version = '0.15.0';
  await assert.rejects(mismatch.transport.start(), /version mismatch/);
  assert.equal(mismatch.client.stopped, true);
});

test('receive admits only configured direct text before Agent enqueue', async () => {
  const { transport, client, inbound } = harness();
  await transport.start();
  client.emit(directEnvelope('00000000-0000-4000-8000-000000000099', 'unknown-secret'));
  client.emit(directEnvelope(CEDAR_ACI, 'receive-disabled-secret'));
  client.emit(directEnvelope(LOCAL_ACI, 'self-secret'));
  client.emit({ sourceUuid: BRAMBLE_ACI, timestamp: 1, syncMessage: { sentMessage: { message: 'sync-secret' } } });
  client.emit(directEnvelope(BRAMBLE_ACI, 'group-secret', { groupInfo: {} }));
  client.emit(directEnvelope(BRAMBLE_ACI, 'attachment-secret', { attachments: [{ id: 'x' }] }));
  client.emit(directEnvelope(BRAMBLE_ACI, 'quote-secret', { quote: { id: 1 } }));
  client.emit(directEnvelope(BRAMBLE_ACI, 'hello from Signal'));

  assert.equal(inbound.length, 1);
  assert.deepEqual(inbound[0], {
    kind: 'signal',
    transport: 'signal',
    id: 'signal:bramble:1790550000123',
    channelId: BRAMBLE_ROOM,
    channelName: 'signal:bramble',
    author: 'Bramble',
    authorId: 'signal:bramble',
    content: 'hello from Signal',
    createdAt: new Date(1790550000123).toISOString(),
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    wakeClass: 'wake',
  });
  assert.equal(JSON.stringify(inbound).includes('secret'), false);
});

test('receive maps a downloaded Signal image and its caption into the shared attachment envelope', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-signal-attachments-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const attachmentsDir = join(dataDir, 'attachments');
  mkdirSync(attachmentsDir);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const localPath = join(attachmentsDir, 'remote.png');
  writeFileSync(localPath, image);

  const { transport, client, inbound } = harness(config({ dataDir }));
  await transport.start();
  client.emit(
    directEnvelope(BRAMBLE_ACI, '', {
      attachments: [
        {
          id: 'remote.png',
          filename: 'signal-photo.png',
          contentType: 'image/png',
          size: image.length,
          caption: 'caption through Signal',
        },
      ],
    }),
  );

  assert.equal(inbound.length, 1);
  assert.equal(inbound[0]?.content, 'caption through Signal');
  assert.deepEqual(inbound[0]?.attachments, [
    {
      url: 'signal:attachment:remote.png',
      name: 'signal-photo.png',
      contentType: 'image/png',
      localPath,
      size: image.length,
      inlineText: null,
    },
  ]);

  const built = buildTestAgent({ tmpPrefix: 'harness-signal-image-' });
  let loop: Promise<void> | null = null;
  t.after(async () => {
    built.agent.stop();
    try {
      await loop;
    } finally {
      built.cleanup();
    }
  });
  let idleResolve: (() => void) | null = null;
  built.agent['deps'].onIdle = () => idleResolve?.();
  loop = built.agent.loop();
  const idle = new Promise<void>((resolve) => {
    idleResolve = resolve;
  });
  built.agent.enqueue(inbound[0]!);
  await idle;
  const userMessage = built.agent.messagesForTest.find(
    (message) => message.role === 'user' && message.content.includes('caption through Signal'),
  );
  const imagePart = userMessage?.contentParts?.find(
    (part) => part.type === 'image_url',
  );
  assert.ok(imagePart && imagePart.type === 'image_url');
  assert.equal(
    imagePart.image_url.url,
    `data:image/png;base64,${image.toString('base64')}`,
  );
});

test('receive rejects escaping, symlinked, oversized, and excessive Signal attachments', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-signal-attachment-guards-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const attachmentsDir = join(dataDir, 'attachments');
  mkdirSync(attachmentsDir);
  const outside = join(dataDir, 'outside.png');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(attachmentsDir, 'linked.png'));
  const oversized = join(attachmentsDir, 'oversized.png');
  writeFileSync(oversized, '');
  truncateSync(oversized, 25 * 1024 * 1024 + 1);

  const { transport, client, inbound } = harness(config({ dataDir }));
  await transport.start();
  const attachment = (id: string) => ({
    id,
    filename: 'photo.png',
    contentType: 'image/png',
    size: 1,
    caption: 'must-not-enter',
  });
  client.emit(directEnvelope(BRAMBLE_ACI, '', { attachments: [attachment('../outside.png')] }));
  client.emit(directEnvelope(BRAMBLE_ACI, '', { attachments: [attachment('linked.png')] }));
  client.emit(directEnvelope(BRAMBLE_ACI, '', { attachments: [attachment('oversized.png')] }));
  client.emit(
    directEnvelope(BRAMBLE_ACI, '', {
      attachments: Array.from({ length: 11 }, () => attachment('missing.png')),
    }),
  );
  client.emit(directEnvelope(BRAMBLE_ACI, 'plain text still enters'));

  assert.equal(inbound.length, 1);
  assert.equal(inbound[0]?.content, 'plain text still enters');
  assert.equal(JSON.stringify(inbound).includes('must-not-enter'), false);
});

test('send enforces exact room, contact permission, text-only options, and final mute', async () => {
  const h = harness();
  await h.transport.start();
  assert.deepEqual(await h.transport.send(BRAMBLE_ROOM, 'hello'), {
    signal: { status: 'accepted' },
  });
  assert.deepEqual(h.client.sends, [{ recipient: BRAMBLE_ACI, message: 'hello' }]);

  await assert.rejects(h.transport.send(`signal:dm:${CEDAR_ACI}`, 'no'), /allow_send=false/);
  await assert.rejects(h.transport.send('signal:dm:00000000-0000-4000-8000-000000000099', 'no'), /not configured/);
  await assert.rejects(h.transport.send(BRAMBLE_ROOM, 'no', { replyTo: '1' }), /text-only/);
  await assert.rejects(h.transport.send(BRAMBLE_ROOM, 'no', { files: [{ path: '/tmp/x' }] }), /text-only/);
  await assert.rejects(h.transport.send(BRAMBLE_ROOM, 'no', { mentions: false }), /text-only/);

  h.setMuted(true);
  await assert.rejects(h.transport.send(BRAMBLE_ROOM, 'no'), /muted/);
  assert.equal(h.client.sends.length, 1);
});

test('composition router isolates transports and preserves Discord send purpose', async () => {
  const h = harness();
  await h.transport.start();
  const discordCalls: unknown[][] = [];
  const router = createOutboundTransportRouter(
    async (...args) => {
      discordCalls.push(args);
    },
    h.transport,
  );

  assert.deepEqual(await router(BRAMBLE_ROOM, 'through Signal'), {
    signal: { status: 'accepted' },
  });
  assert.deepEqual(h.client.sends, [
    { recipient: BRAMBLE_ACI, message: 'through Signal' },
  ]);
  assert.equal(discordCalls.length, 0);

  await router(
    '1001',
    'through Discord',
    undefined,
    undefined,
    { kind: 'error-notice' },
  );
  assert.deepEqual(discordCalls, [
    ['1001', 'through Discord', undefined, undefined, { kind: 'error-notice' }],
  ]);

  assert.throws(
    () =>
      router(
        BRAMBLE_ROOM,
        'wrong authority',
        undefined,
        { kind: 'mentions-turn', channelId: BRAMBLE_ROOM } as never,
      ),
    /Discord mentions-turn authorization cannot be used for Signal delivery/,
  );
  assert.equal(h.client.sends.length, 1);
});

test('Agent keeps Signal in one FIFO without Discord directory or people-memory leakage', async () => {
  const { llm, capture, completed } = oneShotLlm();
  const built = buildTestAgent({
    llm,
    config: { signal: config() },
    tmpPrefix: 'harness-signal-agent-',
  });
  const running = built.agent.loop();
  built.agent.enqueue({
    kind: 'signal',
    transport: 'signal',
    id: 'signal:bramble:1790550000123',
    channelId: BRAMBLE_ROOM,
    channelName: 'signal:bramble',
    author: 'Bramble',
    authorId: 'signal:bramble',
    content: 'agent-signal-message',
    createdAt: new Date(1790550000123).toISOString(),
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    wakeClass: 'wake',
  });
  await completed;
  built.agent.stop();
  await running;

  const joined = capture.messages.map((message) => message.content ?? '').join('\n');
  assert.match(joined, /transport="signal"/);
  assert.match(joined, /channel="signal:bramble"/);
  assert.match(joined, /<direct-channel-action-acknowledgement>/);
  assert.match(joined, /\[send to=signal:bramble\]/);
  assert.doesNotMatch(joined, /<person-memory/);
  assert.equal(
    built.agent.knownChannels().filter((room) => room.id === BRAMBLE_ROOM).length,
    1,
    'Signal room is projected from config only, not copied into the Discord directory',
  );
  built.cleanup();
});

test('Agent enforces Signal contact send policy before shared dispatch', async () => {
  let dispatches = 0;
  const allowed = buildTestAgent({
    config: { signal: config() },
    agentDeps: {
      send: async () => {
        dispatches++;
        return { signal: { status: 'accepted' as const } };
      },
    },
    tmpPrefix: 'harness-signal-send-',
  });
  assert.deepEqual(await allowed.agent.send(BRAMBLE_ROOM, 'hello'), {
    signal: { status: 'accepted' },
  });
  assert.equal(dispatches, 1);
  allowed.cleanup();

  const deniedConfig = config();
  deniedConfig.contacts.bramble!.allowSend = false;
  const denied = buildTestAgent({
    config: { signal: deniedConfig },
    agentDeps: {
      send: async () => {
        dispatches++;
      },
    },
    tmpPrefix: 'harness-signal-send-denied-',
  });
  await assert.rejects(denied.agent.send(BRAMBLE_ROOM, 'no'), /allow_send=false/);
  assert.equal(dispatches, 1);
  denied.cleanup();
});
