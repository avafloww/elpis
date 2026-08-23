import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLURALKIT_BOT_ID,
  PLURALKIT_REQUEST_TIMEOUT_MS,
  PluralKitResolver,
  isPluralKitCommand,
  pluralKitIdentity,
} from '../src/discord/pluralkit.js';

test('official PluralKit bot id stays distinct from proxy webhook authors', () => {
  assert.equal(PLURALKIT_BOT_ID, '466378653216014359');
  assert.notEqual(PLURALKIT_BOT_ID, '111111111111111108');
});

test('PluralKit API requests allow proxy latency without hanging inbound forever', () => {
  assert.equal(PLURALKIT_REQUEST_TIMEOUT_MS, 5000);
});

test('isPluralKitCommand recognizes PK commands without swallowing ordinary text', () => {
  assert.equal(isPluralKitCommand('pk;member new Clover'), true);
  assert.equal(isPluralKitCommand('  PK;system'), true);
  assert.equal(isPluralKitCommand('talking about pk; commands'), false);
  assert.equal(isPluralKitCommand('pk :3'), false);
});

const info = {
  id: 'proxy-1',
  original: 'original-1',
  sender: 'discord-user-1',
  member: { name: 'Clover', display_name: 'Clover :3' },
};

test('pluralKitIdentity uses member display name while retaining the system sender id', () => {
  assert.deepEqual(pluralKitIdentity(info, 'webhook'), {
    author: 'Clover :3',
    authorId: 'discord-user-1',
  });
});

test('PluralKitResolver caches one response under proxy and original ids', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(JSON.stringify(info), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const resolver = new PluralKitResolver(fetcher, 'https://pk.test/v2', 0);
  assert.deepEqual(await resolver.resolve('proxy-1'), info);
  assert.deepEqual(await resolver.resolve('original-1'), info);
  assert.equal(calls, 1);
});

test('PluralKitResolver returns null for a non-PK message', async () => {
  const resolver = new PluralKitResolver(
    async () => new Response('', { status: 404 }),
    'https://pk.test/v2',
    0,
  );
  assert.equal(await resolver.resolve('ordinary-1'), null);
});

test('PluralKitResolver rejects malformed successful responses', async () => {
  const resolver = new PluralKitResolver(
    async () =>
      new Response(JSON.stringify({ id: 'proxy-1' }), { status: 200 }),
    'https://pk.test/v2',
    0,
  );
  await assert.rejects(
    () => resolver.resolve('proxy-1'),
    /omitted id\/original\/sender/,
  );
});
