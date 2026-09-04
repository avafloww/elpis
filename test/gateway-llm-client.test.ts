import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_HEADERS,
  LLM_PROXY_LIMITS,
  LLM_PROXY_PATHS,
  createNodeCredential,
  decodeLlmProxyRequest,
  encodeLlmResponseProvenance,
  serializeLlmProxyCatalog,
  serializeLlmProxyError,
  type LlmProxyCatalog,
  type LlmProxyCatalogModel,
  type RequestId,
} from '@elpis/gateway-protocol';
import {
  GatewayLlmClient,
  GatewayLlmClientBoundaryError,
  GatewayLlmClientError,
  type GatewayLlmFetch,
  type GatewayLlmResidentStore,
} from '../src/llm/gateway-client.js';
import { GatewayResidentStateError } from '../src/store/gateway-resident.js';

const ENDPOINT = 'https://gateway.example.com';
const GENERATION = 'egt1.AAAAAAAAAAAAAAAAAAAAAA' as const;
const REQUEST_ID = 'egr1.AAAAAAAAAAAAAAAAAAAAAA' as RequestId;
const firstCredential = createNodeCredential((size) => Buffer.alloc(size, 1));
const secondCredential = createNodeCredential((size) => Buffer.alloc(size, 2));

const model: LlmProxyCatalogModel = Object.freeze({
  modelRef: 'aster/primary',
  targetGeneration: GENERATION,
  providerType: 'openai-compatible',
  model: 'aster-1',
  allowedRoutes: Object.freeze(['responses']),
  contextSize: 128_000,
  reasoningEffort: null,
  reasoningSummary: null,
  reasoningContext: null,
  toolTier: 'strong',
  externalThinking: false,
  toolContractVersion: 'aster-tools-v1',
  callTimeoutMs: 30_000,
  streamIdleTimeoutMs: 10_000,
});
const catalog: LlmProxyCatalog = Object.freeze({
  format: LLM_PROXY_FORMATS.catalog,
  revision: 7,
  models: Object.freeze([model]),
});

function snapshot(phase: 'idle' | 'active' | 'rotating' = 'active') {
  const active = phase !== 'idle';
  return Object.freeze({
    instanceId: 'egi1.AAAAAAAAAAAAAAAAAAAAAA',
    phase,
    endpoint: active ? ENDPOINT : null,
    displayName: active ? 'Aster' : null,
    requestId: phase === 'rotating' ? REQUEST_ID : null,
    activeCredentialId: active ? firstCredential.id : null,
    pendingCredentialId: phase === 'rotating' ? secondCredential.id : null,
    createdAt: 1,
    updatedAt: 1,
    enrollmentStartedAt: active ? 1 : null,
    activatedAt: active ? 1 : null,
    rotationStartedAt: phase === 'rotating' ? 1 : null,
    rotationProposedAt: null,
  });
}

function store(
  token: () => string = () => firstCredential.token,
  phase: 'idle' | 'active' | 'rotating' = 'active',
): GatewayLlmResidentStore {
  const state = snapshot(phase);
  return {
    read: () => state,
    activeNodeToken: token,
  };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function client(fetch: GatewayLlmFetch, authority = store()): GatewayLlmClient {
  return new GatewayLlmClient({
    store: authority,
    fetch,
    randomBytes: () => Buffer.alloc(16),
  });
}

function proxyError(
  code: 'unauthorized' | 'upstream_unavailable' | 'internal_error',
  requestId?: RequestId,
): string {
  return serializeLlmProxyError({
    format: LLM_PROXY_FORMATS.error,
    code,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function dispatchInput(
  payload = Buffer.from('{"model":"aster-1","input":"hello"}'),
) {
  return {
    model,
    route: 'responses' as const,
    transport: { kind: 'none' as const },
    payload,
  };
}

describe('GatewayLlmClient catalog boundary', () => {
  it('uses the exact canonical route, node auth, bounded strict codec, and no redirects', async () => {
    let calls = 0;
    const result = await client(async (target, init) => {
      calls += 1;
      assert.equal(target, ENDPOINT + LLM_PROXY_PATHS.catalog);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      const headers = new Headers(init.headers);
      assert.equal(
        headers.get('authorization'),
        'Bearer ' + firstCredential.token,
      );
      assert.equal(headers.get('accept'), 'application/json');
      assert.equal(headers.get('accept-encoding'), 'identity');
      assert.deepEqual([...headers.keys()].sort(), [
        'accept',
        'accept-encoding',
        'authorization',
      ]);
      return jsonResponse(serializeLlmProxyCatalog(catalog));
    }).fetchCatalog();
    assert.equal(calls, 1);
    assert.deepEqual(result, catalog);
    assert.throws(() => (result.models as LlmProxyCatalogModel[]).push(model));
  });

  it('fails closed on resident auth state before network', async () => {
    let calls = 0;
    const boundary = client(
      async () => {
        calls += 1;
        throw new Error('must not run');
      },
      store(() => {
        throw new GatewayResidentStateError('invalid_state');
      }, 'active'),
    );
    await assert.rejects(boundary.fetchCatalog(), (error: unknown) => {
      assert.ok(error instanceof GatewayResidentStateError);
      assert.equal(error.code, 'invalid_state');
      return true;
    });
    assert.equal(calls, 0);
  });

  it('normalizes snapshot-read failures before network access', async () => {
    const secret = firstCredential.token + '@' + ENDPOINT;
    let calls = 0;
    const boundary = client(
      async () => {
        calls += 1;
        throw new Error('must not run');
      },
      {
        read: () => {
          throw new Error(secret);
        },
        activeNodeToken: () => firstCredential.token,
      },
    );
    await assert.rejects(boundary.fetchCatalog(), (error: unknown) => {
      assert.ok(error instanceof GatewayResidentStateError);
      assert.equal(error.code, 'corrupt_state');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(calls, 0);
  });

  it('reads the active token separately for each call', async () => {
    let current = firstCredential.token;
    let reads = 0;
    const seen: string[] = [];
    const boundary = client(
      async (_target, init) => {
        seen.push(new Headers(init.headers).get('authorization')!);
        return jsonResponse(serializeLlmProxyCatalog(catalog));
      },
      store(() => {
        reads += 1;
        return current;
      }),
    );
    await boundary.fetchCatalog();
    current = secondCredential.token;
    await boundary.fetchCatalog();
    assert.equal(reads, 2);
    assert.deepEqual(seen, [
      'Bearer ' + firstCredential.token,
      'Bearer ' + secondCredential.token,
    ]);
  });
});

describe('GatewayLlmClient request boundary', () => {
  it('serializes the exact envelope, digest and an owned payload copy', async () => {
    const payload = Buffer.from('{"model":"aster-1","input":"hello"}');
    const original = Buffer.from(payload);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let decoded: ReturnType<typeof decodeLlmProxyRequest> | undefined;
    const boundary = client(async (target, init) => {
      assert.equal(target, ENDPOINT + LLM_PROXY_PATHS.request);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(
        new Headers(init.headers).get('content-type'),
        'application/json',
      );
      assert.equal(
        new Headers(init.headers).get('authorization'),
        'Bearer ' + firstCredential.token,
      );
      decoded = decodeLlmProxyRequest(init.body as string);
      await waiting;
      const provenance = encodeLlmResponseProvenance({
        format: LLM_PROXY_FORMATS.responseProvenance,
        requestId: decoded.requestId,
        modelRef: decoded.modelRef,
        targetGeneration: decoded.targetGeneration,
        route: decoded.route,
        status: 201,
        headers: [],
      });
      return new Response('ok', {
        status: 201,
        headers: { [LLM_PROXY_HEADERS.provenance]: provenance },
      });
    });
    const attempt = boundary.dispatch(dispatchInput(payload));
    payload.fill(0);
    release();
    await attempt;
    assert.ok(decoded);
    assert.equal(decoded.requestId, REQUEST_ID);
    assert.equal(decoded.modelRef, model.modelRef);
    assert.equal(decoded.targetGeneration, model.targetGeneration);
    assert.equal(decoded.route, 'responses');
    assert.deepEqual(decoded.transport, { kind: 'none' });
    assert.deepEqual(Buffer.from(decoded.payload), original);
    assert.notStrictEqual(decoded.payload, payload);
    assert.equal(decoded.byteLength, original.byteLength);
    assert.equal(
      decoded.sha256,
      'f1db3b02bccd7736a4f7506cde53188285e00cc4d1c2b5a40b6aa63177b75f1f',
    );
  });

  it('owns one route snapshot and rejects accessor-backed dispatch input', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutable = {
      ...dispatchInput(),
      route: 'responses' as 'responses' | 'messages',
    };
    const boundary = client(async (_target, init) => {
      const request = decodeLlmProxyRequest(init.body as string);
      await waiting;
      return new Response('ok', {
        status: 200,
        headers: {
          [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
            format: LLM_PROXY_FORMATS.responseProvenance,
            requestId: request.requestId,
            modelRef: request.modelRef,
            targetGeneration: request.targetGeneration,
            route: request.route,
            status: 200,
            headers: [],
          }),
        },
      });
    });
    const attempt = boundary.dispatch(mutable);
    mutable.route = 'messages';
    release();
    assert.equal((await attempt).status, 200);

    let calls = 0;
    let routeReads = 0;
    const accessorInput = {
      model,
      payload: Buffer.from('{}'),
      transport: { kind: 'none' as const },
      get route() {
        routeReads += 1;
        return routeReads === 1
          ? ('responses' as const)
          : ('messages' as const);
      },
    };
    await assert.rejects(
      client(async () => {
        calls += 1;
        throw new Error('must not run');
      }).dispatch(accessorInput),
      GatewayLlmClientBoundaryError,
    );
    assert.equal(calls, 0);
    assert.equal(routeReads, 0);
  });

  it('returns the original raw body stream with only provenance-safe status and headers', async () => {
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('raw-provider-bytes'));
        controller.close();
      },
    });
    let gatewayResponse!: Response;
    const boundary = client(async (_target, init) => {
      const request = decodeLlmProxyRequest(init.body as string);
      const provenance = encodeLlmResponseProvenance({
        format: LLM_PROXY_FORMATS.responseProvenance,
        requestId: request.requestId,
        modelRef: request.modelRef,
        targetGeneration: request.targetGeneration,
        route: request.route,
        status: 429,
        headers: [
          { name: 'content-type', value: 'application/x-aster-stream' },
          { name: 'x-request-id', value: 'provider-example-id' },
        ],
      });
      gatewayResponse = new Response(raw, {
        status: 429,
        headers: {
          [LLM_PROXY_HEADERS.provenance]: provenance,
          authorization: 'Bearer should-not-escape',
          'set-cookie': 'secret=value',
          'x-gateway-private': 'hidden',
        },
      });
      return gatewayResponse;
    });
    const response = await boundary.dispatch(dispatchInput());
    assert.equal(response.status, 429);
    assert.strictEqual(response.body, gatewayResponse.body);
    assert.equal(
      response.headers.get('content-type'),
      'application/x-aster-stream',
    );
    assert.equal(response.headers.get('x-request-id'), 'provider-example-id');
    assert.deepEqual(
      [...response.headers.keys()],
      ['content-type', 'x-request-id'],
    );
    assert.equal(await response.text(), 'raw-provider-bytes');
  });

  it('cancels raw bodies for malformed, mismatched, and missing provenance', async () => {
    for (const kind of ['malformed', 'mismatched', 'missing'] as const) {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
      });
      const boundary = client(async (_target, init) => {
        const request = decodeLlmProxyRequest(init.body as string);
        const headers = new Headers({
          'content-type': 'application/octet-stream',
        });
        if (kind === 'malformed')
          headers.set(LLM_PROXY_HEADERS.provenance, 'not+base64url');
        if (kind === 'mismatched')
          headers.set(
            LLM_PROXY_HEADERS.provenance,
            encodeLlmResponseProvenance({
              format: LLM_PROXY_FORMATS.responseProvenance,
              requestId: request.requestId,
              modelRef: request.modelRef,
              targetGeneration: request.targetGeneration,
              route: request.route,
              status: 201,
              headers: [],
            }),
          );
        return new Response(body, { status: 200, headers });
      });
      await assert.rejects(
        boundary.dispatch(dispatchInput()),
        GatewayLlmClientBoundaryError,
      );
      await Promise.resolve();
      assert.equal(cancelled, 1, kind);
    }
  });

  it('rejects malformed redirect and response type metadata before decoding errors', async () => {
    for (const metadata of [
      { redirected: 'false', type: 'basic' },
      { redirected: false, type: 'mystery' },
    ]) {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            Buffer.from(proxyError('internal_error', REQUEST_ID)),
          );
        },
        cancel() {
          cancelled += 1;
        },
      });
      const response = {
        ...metadata,
        url: '',
        status: 500,
        headers: new Headers({
          'content-type': 'application/json; charset=utf-8',
        }),
        body,
      } as unknown as Response;
      await assert.rejects(
        client(async () => response).dispatch(dispatchInput()),
        GatewayLlmClientBoundaryError,
      );
      await Promise.resolve();
      assert.equal(cancelled, 1);
    }
  });

  it('rejects malformed response status without leaking or accepting an error envelope', async () => {
    const secret = firstCredential.token + '@' + ENDPOINT;
    let throwingCancelled = 0;
    const throwing = client(async (_target, init) => {
      const request = decodeLlmProxyRequest(init.body as string);
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          throwingCancelled += 1;
        },
      });
      const headers = new Headers({
        [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
          format: LLM_PROXY_FORMATS.responseProvenance,
          requestId: request.requestId,
          modelRef: request.modelRef,
          targetGeneration: request.targetGeneration,
          route: request.route,
          status: 200,
          headers: [],
        }),
      });
      return {
        redirected: false,
        type: 'basic',
        url: '',
        headers,
        body,
        get status() {
          throw new Error(secret);
        },
      } as unknown as Response;
    });
    await assert.rejects(
      throwing.dispatch(dispatchInput()),
      (error: unknown) => {
        assert.ok(error instanceof GatewayLlmClientBoundaryError);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    await Promise.resolve();
    assert.equal(throwingCancelled, 1);

    let nanCancelled = 0;
    const nanStatus = client(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            Buffer.from(proxyError('internal_error', REQUEST_ID)),
          );
          controller.close();
        },
        cancel() {
          nanCancelled += 1;
        },
      });
      return {
        redirected: false,
        type: 'basic',
        url: '',
        status: Number.NaN,
        headers: new Headers({
          'content-type': 'application/json; charset=utf-8',
        }),
        body,
      } as unknown as Response;
    });
    await assert.rejects(
      nanStatus.dispatch(dispatchInput()),
      GatewayLlmClientBoundaryError,
    );
    await Promise.resolve();
    assert.equal(nanCancelled, 1);
  });

  it('makes an abort during response status inspection win and cancel the body', async () => {
    const controller = new AbortController();
    const reason = new DOMException(
      'cancelled during response inspection',
      'AbortError',
    );
    const secret = firstCredential.token + '@' + ENDPOINT;
    let cancelled = 0;
    const boundary = client(async (_target, init) => {
      const request = decodeLlmProxyRequest(init.body as string);
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
      });
      return {
        redirected: false,
        type: 'basic',
        url: '',
        get status() {
          controller.abort(reason);
          throw new Error(secret);
        },
        headers: new Headers({
          [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
            format: LLM_PROXY_FORMATS.responseProvenance,
            requestId: request.requestId,
            modelRef: request.modelRef,
            targetGeneration: request.targetGeneration,
            route: request.route,
            status: 200,
            headers: [],
          }),
        }),
        body,
      } as unknown as Response;
    });
    await assert.rejects(
      boundary.dispatch(dispatchInput(), controller.signal),
      (error) => error === reason,
    );
    await Promise.resolve();
    assert.equal(cancelled, 1);
  });

  it('makes an abort from a null body getter outrank boundary failure', async () => {
    const controller = new AbortController();
    const reason = new DOMException(
      'cancelled during body inspection',
      'AbortError',
    );
    const response = {
      redirected: false,
      type: 'basic',
      url: '',
      status: 500,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
      }),
      get body() {
        controller.abort(reason);
        return null;
      },
    } as unknown as Response;
    await assert.rejects(
      client(async () => response).dispatch(dispatchInput(), controller.signal),
      (error) => error === reason,
    );
  });

  it('rejects non-boolean completion and safely assimilates cancellation', async () => {
    const canonical = Buffer.from(proxyError('internal_error', REQUEST_ID));
    let reads = 0;
    let cancelled = 0;
    let constructorReads = 0;
    const reader = {
      read() {
        reads += 1;
        if (reads === 1)
          return Promise.resolve({ done: false, value: canonical });
        return Promise.resolve({ done: 'yes', value: undefined });
      },
      cancel() {
        cancelled += 1;
        const result = new Promise<void>(() => undefined);
        Object.defineProperty(result, 'constructor', {
          configurable: false,
          get() {
            constructorReads += 1;
            throw new Error(firstCredential.token + '@' + ENDPOINT);
          },
        });
        return result;
      },
      releaseLock() {},
    };
    const response = {
      redirected: false,
      type: 'basic',
      url: '',
      status: 500,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
      }),
      body: { getReader: () => reader },
    } as unknown as Response;
    await assert.rejects(
      client(async () => response).dispatch(dispatchInput()),
      GatewayLlmClientBoundaryError,
    );
    await Promise.resolve();
    assert.equal(cancelled, 0);
    assert.equal(constructorReads, 0);
  });

  it('makes a synchronous read abort win over fulfilled read results', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled during read', 'AbortError');
    const canonical = Buffer.from(proxyError('internal_error', REQUEST_ID));
    let reads = 0;
    let cancelled = 0;
    const reader = {
      read() {
        reads += 1;
        if (reads === 1) {
          controller.abort(reason);
          return Promise.resolve({ done: false, value: canonical });
        }
        return Promise.resolve({ done: true, value: undefined });
      },
      cancel() {
        cancelled += 1;
        return Promise.resolve();
      },
      releaseLock() {},
    };
    const response = {
      redirected: false,
      type: 'basic',
      url: '',
      status: 500,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
      }),
      body: { getReader: () => reader },
    } as unknown as Response;
    await assert.rejects(
      client(async () => response).dispatch(dispatchInput(), controller.signal),
      (error) => error === reason,
    );
    assert.equal(cancelled, 0);
  });

  it('makes an abort from the completion getter win over buffered bytes', async () => {
    const controller = new AbortController();
    const reason = new DOMException(
      'cancelled during completion',
      'AbortError',
    );
    const canonical = Buffer.from(proxyError('internal_error', REQUEST_ID));
    let reads = 0;
    let cancelled = 0;
    const reader = {
      read() {
        reads += 1;
        if (reads === 1)
          return Promise.resolve({ done: false, value: canonical });
        return Promise.resolve({
          get done() {
            controller.abort(reason);
            return true;
          },
          value: undefined,
        });
      },
      cancel() {
        cancelled += 1;
        return Promise.resolve();
      },
      releaseLock() {},
    };
    const response = {
      redirected: false,
      type: 'basic',
      url: '',
      status: 500,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
      }),
      body: { getReader: () => reader },
    } as unknown as Response;
    await assert.rejects(
      client(async () => response).dispatch(dispatchInput(), controller.signal),
      (error) => error === reason,
    );
    assert.equal(cancelled, 0);
  });

  it('uses intrinsic releaseLock instead of a branded reader override', async () => {
    const canonical = Buffer.from(proxyError('internal_error', REQUEST_ID));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(canonical);
        controller.close();
      },
    });
    const reader = stream.getReader();
    let releaseCalls = 0;
    Object.defineProperty(reader, 'releaseLock', {
      value() {
        releaseCalls += 1;
        return Promise.resolve();
      },
    });
    Object.defineProperty(stream, 'getReader', {
      value: () => reader,
    });
    const response = {
      redirected: false,
      type: 'basic',
      url: '',
      status: 500,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
      }),
      body: stream,
    } as unknown as Response;
    await assert.rejects(
      client(async () => response).dispatch(dispatchInput()),
      GatewayLlmClientError,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(releaseCalls, 0);
  });

  it('rejects content-length mismatch after a complete reader sequence', async () => {
    const reader = {
      read: () => Promise.resolve({ done: true, value: undefined }),
      cancel() {
        throw new Error('untrusted cancel must not run');
      },
      releaseLock() {},
    };
    const response = {
      redirected: false,
      type: 'basic',
      url: '',
      status: 500,
      headers: new Headers({
        'content-type': 'application/json; charset=utf-8',
        'content-length': '1',
      }),
      body: { getReader: () => reader },
    } as unknown as Response;
    await assert.rejects(
      client(async () => response).dispatch(dispatchInput()),
      GatewayLlmClientBoundaryError,
    );
  });

  it('cancels malformed body chunks without reflecting property errors', async () => {
    const secret = firstCredential.token + '@' + ENDPOINT;
    let cancelled = 0;
    const malformedChunk = new Proxy(new Uint8Array([1]), {
      get(target, key) {
        if (key === 'byteLength') throw new Error(secret);
        return Reflect.get(target, key, target);
      },
    });
    const boundary = client(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(malformedChunk);
            },
            cancel() {
              cancelled += 1;
            },
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
    );
    await assert.rejects(
      boundary.dispatch(dispatchInput()),
      (error: unknown) => {
        assert.ok(error instanceof GatewayLlmClientBoundaryError);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    await Promise.resolve();
    assert.equal(cancelled, 1);
  });

  it('strictly exposes canonical Gateway errors and rejects oversized errors', async () => {
    const canonical = client(async (_target, init) => {
      const request = decodeLlmProxyRequest(init.body as string);
      return jsonResponse(
        proxyError('upstream_unavailable', request.requestId),
        502,
      );
    });
    await assert.rejects(
      canonical.dispatch(dispatchInput()),
      (error: unknown) => {
        assert.ok(error instanceof GatewayLlmClientError);
        assert.equal(error.message, 'gateway LLM request failed');
        assert.equal(error.code, 'upstream_unavailable');
        assert.equal(error.requestId, REQUEST_ID);
        assert.equal('status' in error, false);
        assert.equal(error.message.includes(ENDPOINT), false);
        assert.equal(error.message.includes(firstCredential.token), false);
        return true;
      },
    );

    let cancelled = 0;
    const oversized = client(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new Uint8Array(LLM_PROXY_LIMITS.errorBodyBytes + 1),
              );
            },
            cancel() {
              cancelled += 1;
            },
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
    );
    await assert.rejects(
      oversized.dispatch(dispatchInput()),
      GatewayLlmClientBoundaryError,
    );
    await Promise.resolve();
    assert.equal(cancelled, 1);
  });

  it('makes synchronous fetch abort outrank its thrown error', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled inside fetch', 'AbortError');
    const secret = firstCredential.token + '@' + ENDPOINT;
    const hostileFetch = (() => {
      controller.abort(reason);
      throw new Error(secret);
    }) as unknown as GatewayLlmFetch;
    await assert.rejects(
      client(hostileFetch).fetchCatalog(controller.signal),
      (error) => error === reason,
    );
  });

  it('rejects a native fetch Promise with poisoned constructor without invoking it', async () => {
    const controller = new AbortController();
    const reason = new DOMException(
      'cancelled at poisoned handoff',
      'AbortError',
    );
    let constructorReads = 0;
    const responsePromise = Promise.resolve(new Response('late'));
    Object.defineProperty(responsePromise, 'constructor', {
      configurable: false,
      get() {
        constructorReads += 1;
        throw new Error(firstCredential.token + '@' + ENDPOINT);
      },
    });
    const hostileFetch = (() => {
      controller.abort(reason);
      return responsePromise;
    }) as unknown as GatewayLlmFetch;
    await assert.rejects(
      client(hostileFetch).fetchCatalog(controller.signal),
      (error) => error === reason,
    );
    assert.equal(constructorReads, 0);
  });

  it('preserves abort and cancellation for a native Promise with hostile then', async () => {
    const controller = new AbortController();
    const reason = new DOMException(
      'cancelled at native fetch handoff',
      'AbortError',
    );
    const secret = firstCredential.token + '@' + ENDPOINT;
    let cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
      }),
      {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
    const responsePromise = Promise.resolve(response);
    Object.defineProperty(responsePromise, 'then', {
      value() {
        throw new Error(secret);
      },
    });
    const hostileFetch = (() => {
      controller.abort(reason);
      return responsePromise;
    }) as unknown as GatewayLlmFetch;
    await assert.rejects(
      client(hostileFetch).fetchCatalog(controller.signal),
      (error) => error === reason,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelled, 1);
  });

  it('preserves the caller abort when fetch returns a throwing thenable', async () => {
    const controller = new AbortController();
    const reason = new DOMException('cancelled at fetch handoff', 'AbortError');
    const secret = firstCredential.token + '@' + ENDPOINT;
    let calls = 0;
    const hostileFetch = ((_target: string, init: RequestInit) => {
      calls += 1;
      assert.strictEqual(init.signal, controller.signal);
      controller.abort(reason);
      return {
        then() {
          throw new Error(secret);
        },
      };
    }) as unknown as GatewayLlmFetch;
    await assert.rejects(
      client(hostileFetch).fetchCatalog(controller.signal),
      (error) => error === reason,
    );
    assert.equal(calls, 1);
  });

  it('propagates abort, performs no retries, and does not reflect transport secrets', async () => {
    const controller = new AbortController();
    let calls = 0;
    let passedSignal: AbortSignal | null | undefined;
    const boundary = client(async (_target, init) => {
      calls += 1;
      passedSignal = init.signal;
      await new Promise((_resolve, reject) =>
        init.signal!.addEventListener(
          'abort',
          () => reject(init.signal!.reason),
          { once: true },
        ),
      );
      throw new Error('unreachable');
    });
    const reason = new DOMException(
      'cancelled by example caller',
      'AbortError',
    );
    const attempt = boundary.dispatch(dispatchInput(), controller.signal);
    controller.abort(reason);
    await assert.rejects(attempt, (error) => error === reason);
    assert.strictEqual(passedSignal, controller.signal);
    assert.equal(calls, 1);

    const secret = firstCredential.token + '@' + ENDPOINT;
    const failed = client(async () => {
      calls += 1;
      throw new Error(secret);
    });
    await assert.rejects(failed.fetchCatalog(), (error: unknown) => {
      assert.ok(error instanceof GatewayLlmClientBoundaryError);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(firstCredential.token), false);
      assert.equal(error.message.includes(ENDPOINT), false);
      return true;
    });
    assert.equal(calls, 2);
  });
});
