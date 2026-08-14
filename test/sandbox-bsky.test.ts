// test/sandbox-bsky.test.ts — the bsky global's config-error path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals } from '../src/sandbox/globals.js';
import { bskyPost, bskyReply, bskyLike, bskyFollow } from '../src/sandbox/bsky.js';

const baseDeps = () => ({
  config: {
    paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
    sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 },
    kagi: { apiKey: null },
    bluesky: null,
  },
  readState: () => ({}),
  writeState: () => {},
});

test('elpis.bsky.post throws a clear not-configured error without bluesky config', async () => {
  const g = buildGlobals(baseDeps() as any);
  const elpis = g.elpis as { bsky: { post: (t: string) => Promise<unknown> } };
  await assert.rejects(() => elpis.bsky.post('hi'), /not configured/i);
});


test('bsky writes facets and correct reply/engagement records', async () => {
  const calls: Array<{ path: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname.replace('/xrpc/', ''), body });
    if (url.pathname.endsWith('createSession')) {
      return new Response(JSON.stringify({ accessJwt: 'jwt', refreshJwt: 'refresh', did: 'did:plc:aster', handle: 'aster.test' }), { status: 200 });
    }
    if (url.pathname.endsWith('resolveHandle')) {
      return new Response(JSON.stringify({ did: 'did:plc:friend' }), { status: 200 });
    }
    return new Response(JSON.stringify({ uri: 'at://did:plc:aster/app.bsky.feed.post/1', cid: 'cid' }), { status: 200 });
  }) as any;
  try {
    const cfg = { service: 'https://pds.test', identifier: 'aster.test', appPassword: 'app-password' };
    const post = await bskyPost(cfg, 'hi @friend.test 🌱 https://example.com');
    assert.equal(post.cid, 'cid');
    const postRecord = calls.find(c => c.path === 'com.atproto.repo.createRecord')?.body.record;
    assert.equal(postRecord.facets.length, 2);
    assert.equal(postRecord.facets[0].features[0].did, 'did:plc:friend');
    assert.equal(postRecord.facets[0].index.byteStart, new TextEncoder().encode('hi ').length);
    assert.equal(postRecord.facets[0].index.byteEnd, new TextEncoder().encode('hi @friend.test').length);
    assert.equal(postRecord.facets[1].features[0].uri, 'https://example.com');

    await bskyReply(cfg, 'reply @friend.test', { uri: 'at://did:plc:other/app.bsky.feed.post/p', cid: 'parent' }, { uri: 'at://did:plc:root/app.bsky.feed.post/r', cid: 'root' });
    const replyRecord = calls.filter(c => c.path === 'com.atproto.repo.createRecord').at(-1)?.body.record;
    assert.deepEqual(replyRecord.reply, { root: { uri: 'at://did:plc:root/app.bsky.feed.post/r', cid: 'root' }, parent: { uri: 'at://did:plc:other/app.bsky.feed.post/p', cid: 'parent' } });
    await bskyLike(cfg, 'at://did:plc:other/app.bsky.feed.post/p', 'parent');
    assert.equal(calls.at(-1)?.body.collection, 'app.bsky.feed.like');
    await bskyFollow(cfg, 'did:plc:other');
    assert.equal(calls.at(-1)?.body.collection, 'app.bsky.graph.follow');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
