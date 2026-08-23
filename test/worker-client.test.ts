import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { WorkerHttpClient } from '../src/worker/client.js';

const token = 't'.repeat(43);
const sessionId = 'wrk-a1b2c3d4';
const binding = {
  sessionId,
  worker: 'worker:quiet-otter',
  modelRef: 'provider/model',
  mindId: 'elm-a1b2c3d4',
  runtime: 'kubernetes',
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('worker HTTP client speaks exact bound completion, Mind, and mailbox protocols', async () => {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const responses = [
    reply({
      protocol: 1,
      binding,
      item: {
        id: binding.mindId,
        title: 'bounded task',
        body: 'do one thing',
        status: 'in_progress',
        dependencies: [],
        comments: [],
      },
    }),
    reply({
      protocol: 1,
      binding,
      messages: [
        {
          id: 9,
          sessionId,
          direction: 'dispatcher_to_worker',
          kind: 'message',
          messageKey: 'guide-1',
          sender: 'dispatcher',
          body: 'keep evidence',
          createdAt: 1,
          acknowledgedAt: null,
        },
      ],
    }),
    reply({ protocol: 1, acknowledged: 1 }),
    reply({
      protocol: 1,
      binding,
      result: {
        message: { role: 'assistant', content: 'done' },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        stripped: false,
      },
    }),
    reply({
      protocol: 1,
      message: {
        id: 10,
        sessionId,
        direction: 'worker_to_dispatcher',
        kind: 'finish',
        messageKey: 'finish-key',
        sender: 'worker:quiet-otter',
        body: 'done',
        createdAt: 2,
        acknowledgedAt: null,
      },
    }),
  ];
  const client = new WorkerHttpClient({
    brokerUrl: 'https://broker.example.com',
    token,
    sessionId,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        init: init ?? {},
        body: JSON.parse(String(init?.body)),
      });
      return responses.shift()!;
    },
  });

  assert.equal((await client.getMandate()).id, binding.mindId);
  assert.deepEqual(await client.pullGuidance(), [
    { id: 9, sender: 'dispatcher', body: 'keep evidence' },
  ]);
  await client.acknowledgeGuidance([9]);
  assert.equal(
    (await client.complete([{ role: 'user', content: 'work' }])).message
      .content,
    'done',
  );
  await client.finish('finish-key', 'done');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/v1/mind',
      '/v1/mailbox',
      '/v1/mailbox',
      '/v1/complete',
      '/v1/mailbox',
    ].map((route) => `https://broker.example.com${route}`),
  );
  for (const call of calls) {
    assert.equal(
      (call.init.headers as Record<string, string>).authorization,
      `Bearer ${token}`,
    );
    assert.equal(call.init.redirect, 'error');
    assert.equal(Object.hasOwn(call.body, 'modelRef'), false);
    assert.equal(Object.hasOwn(call.body, 'mindId'), false);
    assert.equal(Object.hasOwn(call.body, 'sessionId'), false);
  }
});

test('worker HTTP client verifies source bytes and bound artifact receipts', async () => {
  const sourceData = Buffer.from('tracked source archive');
  const sourceSha256 = createHash('sha256').update(sourceData).digest('hex');
  const artifactData = Buffer.from('compressed patch bytes');
  const artifactSha256 = createHash('sha256')
    .update(artifactData)
    .digest('hex');
  const calls: Array<{ url: string; body: any }> = [];
  const responses = [
    reply({
      protocol: 1,
      binding,
      source: {
        revision: 'a'.repeat(40),
        sha256: sourceSha256,
        sizeBytes: sourceData.length,
        encoding: 'base64',
        data: sourceData.toString('base64'),
      },
    }),
    reply({
      protocol: 1,
      artifact: {
        sessionId,
        key: 'workspace.patch.gz',
        kind: 'unified_patch_gzip',
        sourceSha256,
        sha256: artifactSha256,
        sizeBytes: artifactData.length,
        createdAt: 1234,
      },
    }),
  ];
  const client = new WorkerHttpClient({
    brokerUrl: 'https://broker.example.com',
    token,
    sessionId,
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return responses.shift()!;
    },
  });
  const source = await client.getWorkspaceSource();
  assert.deepEqual(source?.data, sourceData);
  const artifact = await client.putWorkspaceArtifact({
    key: 'workspace.patch.gz',
    kind: 'unified_patch_gzip',
    sourceSha256,
    data: artifactData,
  });
  assert.equal(artifact.sha256, artifactSha256);
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/v1/workspace', '/v1/workspace'].map(
      (route) => `https://broker.example.com${route}`,
    ),
  );
  assert.equal(calls[1].body.sha256, artifactSha256);
  for (const call of calls) {
    assert.equal(Object.hasOwn(call.body, 'sessionId'), false);
    assert.equal(Object.hasOwn(call.body, 'modelRef'), false);
    assert.equal(Object.hasOwn(call.body, 'mindId'), false);
  }

  const tampered = new WorkerHttpClient({
    brokerUrl: 'https://broker.example.com',
    token,
    sessionId,
    fetch: async () =>
      reply({
        protocol: 1,
        binding,
        source: {
          revision: 'a'.repeat(40),
          sha256: '0'.repeat(64),
          sizeBytes: sourceData.length,
          encoding: 'base64',
          data: sourceData.toString('base64'),
        },
      }),
  });
  await assert.rejects(
    () => tampered.getWorkspaceSource(),
    /source failed verification/,
  );
});

test('worker HTTP client rejects binding substitution and credentials in broker URL', async () => {
  assert.throws(
    () =>
      new WorkerHttpClient({
        brokerUrl: 'https://user:pass@broker.example.com',
        token,
        sessionId,
      }),
    /credential-free/,
  );
  const client = new WorkerHttpClient({
    brokerUrl: 'https://broker.example.com',
    token,
    sessionId,
    fetch: async () =>
      reply({
        protocol: 1,
        binding: { ...binding, sessionId: 'wrk-deadbeef' },
        result: {
          message: { role: 'assistant', content: 'wrong' },
          usage: {},
        },
      }),
  });
  await assert.rejects(
    () => client.complete([{ role: 'user', content: 'work' }]),
    /different session binding/,
  );
});
