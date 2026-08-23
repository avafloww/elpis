import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OAuthStore } from '../src/llm/oauth/store.js';
import { recordPolicyDenial } from '../src/llm/policy-flight-recorder.js';
import { replayPolicyDenial } from '../src/llm/policy-denial-replay.js';
import { makeConfig } from './helpers.js';

function fakeStore() {
  return {
    location: 'fake',
    read: () => ({
      access: 'fresh',
      refresh: 'r',
      expires: Date.now() + 60_000,
      accountId: 'fresh-account',
    }),
    getAccessToken: async () => 'fresh',
    forceRefresh: async () => {},
  } as unknown as OAuthStore;
}

function bundle() {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-policy-replay-'),
  );
  const config = makeConfig({
    paths: { ...makeConfig().paths, dataDirectory },
  });
  const body = Buffer.from(
    '{"model":"gpt-5.6-sol","input":[{"role":"user","content":"harmless"}]}',
  );
  const record = recordPolicyDenial(
    config,
    'codex-responses',
    {
      url: 'https://chatgpt.com/backend-api/codex/responses',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        session_id: 'original-session',
        conversation_id: 'original-session',
        'x-client-request-id': 'original-session',
        'x-openai-internal-codex-responses-lite': 'true',
      },
      body,
    },
    {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"error":{"message":"flagged for usage policy"}}'),
    },
    new Error('flagged for usage policy'),
  );
  assert.ok(record);
  return { config, record, body };
}

test('policy denial replay resends exact body/session with fresh auth and appends result', async () => {
  const { config, record, body } = bundle();
  let seenBody = Buffer.alloc(0);
  let seenHeaders = new Headers();
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenBody = Buffer.from(init?.body as Uint8Array);
    seenHeaders = new Headers(init?.headers);
    return new Response(
      '{"error":{"message":"still flagged for usage policy"}}',
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const result = await replayPolicyDenial(
    config,
    fakeStore(),
    record.directory,
    fetchFn,
  );
  assert.deepEqual(seenBody, body);
  assert.equal(seenHeaders.get('session_id'), 'original-session');
  assert.equal(seenHeaders.get('authorization'), 'Bearer fresh');
  assert.equal(seenHeaders.get('chatgpt-account-id'), 'fresh-account');
  assert.equal(result.status, 400);
  assert.equal(result.reproducesPolicyDenial, true);
  assert.equal(
    JSON.parse(fs.readFileSync(result.resultPath, 'utf8')).preservedSessionId,
    'original-session',
  );
  assert.equal(
    fs.existsSync(path.join(record.directory, 'manifest.json')),
    true,
  );
});

test('policy denial replay refuses a tampered request before network access', async () => {
  const { config, record } = bundle();
  fs.appendFileSync(
    path.join(record.directory, 'request-body.bin'),
    'tampered',
  );
  let networkCalls = 0;
  await assert.rejects(
    () =>
      replayPolicyDenial(config, fakeStore(), record.directory, (async () => {
        networkCalls++;
        return new Response();
      }) as typeof fetch),
    /hash mismatch/,
  );
  assert.equal(networkCalls, 0);
});
