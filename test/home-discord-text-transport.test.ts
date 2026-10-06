import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHomeDiscordTextTransport,
  HomeDiscordTextTransportError,
  type HomeDiscordTextRequest,
} from '../src/context/home-discord-text-transport.js';

const guildId = '123456789012345678';
const channelId = '223456789012345678';
const messageId = '323456789012345678';

function request(text = 'VISIBLE\u0000RESULT'): HomeDiscordTextRequest {
  return {
    guildId,
    channelId,
    text,
    textBytes: Buffer.byteLength(text, 'utf8'),
    textHash: createHash('sha256').update(text).digest('hex'),
    nonce: '12345678901234567890',
  };
}

function responseFor(input: HomeDiscordTextRequest): Response {
  return new Response(
    JSON.stringify({
      id: messageId,
      guild_id: input.guildId,
      channel_id: input.channelId,
      nonce: input.nonce,
      content: input.text,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

test('home Discord text transport performs one exact POST after synchronous preparation', async () => {
  const input = request();
  const order: string[] = [];
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const transport = createHomeDiscordTextTransport({
    botToken: 'synthetic-token',
    callTimeoutMs: 1_000,
    apiBase: 'https://discord.test/api/v10',
    now: () => 44,
    fetchImpl: (async (url, init) => {
      order.push('fetch');
      capturedUrl = String(url);
      capturedInit = init;
      return responseFor(input);
    }) as typeof fetch,
  });

  const evidence = await transport.send(input, () => {
    order.push('prepare');
  });

  assert.deepEqual(order, ['prepare', 'fetch']);
  assert.equal(
    capturedUrl,
    `https://discord.test/api/v10/channels/${channelId}/messages`,
  );
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.redirect, 'error');
  assert.deepEqual(JSON.parse(capturedInit?.body as string), {
    content: input.text,
    nonce: input.nonce,
    enforce_nonce: true,
    allowed_mentions: {
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    },
  });
  assert.equal(
    new Headers(capturedInit?.headers).get('authorization'),
    'Bot synthetic-token',
  );
  assert.deepEqual(evidence, {
    statusCode: 200,
    messageId,
    guildId,
    channelId,
    nonce: input.nonce,
    textBytes: input.textBytes,
    textHash: input.textHash,
    observedAt: 44,
  });
});

test('home Discord text transport rejects invalid input before preparation or network', async () => {
  let prepared = 0;
  let fetched = 0;
  const transport = createHomeDiscordTextTransport({
    botToken: 'synthetic-token',
    callTimeoutMs: 1_000,
    fetchImpl: (async () => {
      fetched += 1;
      return responseFor(request());
    }) as typeof fetch,
  });
  const input = { ...request(), textHash: '0'.repeat(64) };

  await assert.rejects(
    transport.send(input, () => {
      prepared += 1;
    }),
    (error) =>
      error instanceof HomeDiscordTextTransportError &&
      error.disposition === 'pre_dispatch_rejected' &&
      error.code === 'invalid_request',
  );
  assert.equal(prepared, 0);
  assert.equal(fetched, 0);
});

test('home Discord text transport does not dispatch when durable preparation rejects', async () => {
  let fetched = 0;
  const transport = createHomeDiscordTextTransport({
    botToken: 'synthetic-token',
    callTimeoutMs: 1_000,
    fetchImpl: (async () => {
      fetched += 1;
      return responseFor(request());
    }) as typeof fetch,
  });

  await assert.rejects(
    transport.send(request(), () => {
      throw new Error('synthetic prepare rejection');
    }),
    (error) =>
      error instanceof HomeDiscordTextTransportError &&
      error.disposition === 'pre_dispatch_rejected' &&
      error.code === 'prepare_rejected',
  );
  assert.equal(fetched, 0);
});

test('home Discord text transport treats every post-hook failure as issuance uncertain', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('synthetic transport failure');
    },
    async () => new Response('{}', { status: 429 }),
    async () =>
      new Response(
        JSON.stringify({
          id: messageId,
          guild_id: guildId,
          channel_id: '423456789012345678',
          nonce: request().nonce,
          content: request().text,
        }),
        { status: 200 },
      ),
  ]) {
    let prepared = 0;
    let fetched = 0;
    const transport = createHomeDiscordTextTransport({
      botToken: 'synthetic-token',
      callTimeoutMs: 1_000,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        fetched += 1;
        return fetchImpl(...args);
      }) as typeof fetch,
    });

    await assert.rejects(
      transport.send(request(), () => {
        prepared += 1;
      }),
      (error) =>
        error instanceof HomeDiscordTextTransportError &&
        error.disposition === 'issuance_uncertain',
    );
    assert.equal(prepared, 1);
    assert.equal(fetched, 1);
  }
});
