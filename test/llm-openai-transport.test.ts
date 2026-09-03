import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import test from 'node:test';
import { createLLM } from '../src/llm/llm.js';
import { makeConfig } from './helpers.js';

const REAL_KEY = 'resident-real-key';
const SENTINEL = 'elpis-transport-owned';

function openaiConfig(baseUrl: string) {
  const base = makeConfig();
  return makeConfig({
    llm: {
      ...base.llm,
      providerType: 'openai-compatible',
      apiKey: REAL_KEY,
      baseUrl,
      model: 'wire-model',
      api: 'responses',
    },
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function serve(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> | void,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('resident Responses SDK keeps the real key behind the pinned fetch', async () => {
  let seenBody = '';
  let seenAuthorization: string | undefined;
  const payload = {
    type: 'response.completed',
    response: {
      id: 'resp-wire',
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
  const server = await serve(async (request, response) => {
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.method, 'POST');
    seenAuthorization = request.headers.authorization;
    seenBody = await readBody(request);
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': 'req-wire',
    });
    response.end(
      `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`,
    );
  });
  try {
    const llm = createLLM(openaiConfig(server.baseUrl));
    assert.equal(llm.client?.apiKey, SENTINEL);
    const stream = await llm.client!.responses.create(
      { model: 'wire-model', input: 'hello', stream: true },
      { maxRetries: 0 },
    );
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);

    assert.deepEqual(events, [payload]);
    assert.equal(seenAuthorization, `Bearer ${REAL_KEY}`);
    assert.equal(requestBody(seenBody).model, 'wire-model');
    assert.equal(requestBody(seenBody).input, 'hello');
    assert.equal(requestBody(seenBody).stream, true);
    assert.doesNotMatch(seenBody, /resident-real-key|elpis-transport-owned/);
  } finally {
    await server.close();
  }
});

test('resident Responses transport propagates abort to the network request', async () => {
  let resolveReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    resolveReceived = resolve;
  });
  let resolveSocketClosed!: () => void;
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  let seenAuthorization: string | undefined;
  const server = await serve(async (request) => {
    seenAuthorization = request.headers.authorization;
    await readBody(request);
    request.socket.once('close', resolveSocketClosed);
    resolveReceived();
  });
  try {
    const llm = createLLM(openaiConfig(server.baseUrl));
    const controller = new AbortController();
    const pending = llm.client!.responses.create(
      { model: 'wire-model', input: 'wait', stream: true },
      { maxRetries: 0, signal: controller.signal },
    );
    await received;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(pending);
    const closed = await Promise.race([
      socketClosed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assert.equal(closed, true);
    assert.equal(seenAuthorization, `Bearer ${REAL_KEY}`);
  } finally {
    await server.close();
  }
});

test('resident Responses transport refuses redirects before credential replay', async () => {
  let sourceCalls = 0;
  let redirectedCalls = 0;
  const server = await serve((request, response) => {
    if (request.url === '/v1/responses') {
      sourceCalls += 1;
      response.writeHead(307, { location: '/stolen' }).end();
      return;
    }
    if (request.url === '/stolen') {
      redirectedCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response.writeHead(404).end();
  });
  try {
    const llm = createLLM(openaiConfig(server.baseUrl));
    await assert.rejects(
      llm.client!.responses.create(
        { model: 'wire-model', input: 'redirect', stream: false },
        { maxRetries: 0 },
      ),
    );
    assert.equal(sourceCalls, 1);
    assert.equal(redirectedCalls, 0);
  } finally {
    await server.close();
  }
});

function requestBody(serialized: string): Record<string, unknown> {
  return JSON.parse(serialized) as Record<string, unknown>;
}
