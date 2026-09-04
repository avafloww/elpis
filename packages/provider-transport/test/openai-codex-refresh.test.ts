import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPENAI_CODEX_CLIENT_ID,
  codexTokenIdentity,
  decodeCodexJwt,
  refreshOpenAICodexToken,
} from '../src/index.js';

function jwt(payload: Record<string, unknown>): string {
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `x.${part}.y`;
}

const accessToken = jwt({
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct-123',
    chatgpt_plan_type: ' TEAM ',
  },
  'https://api.openai.com/profile': { email: ' PERSON@EXAMPLE.COM ' },
});

test('Codex JWT identity helper preserves resident claim behavior', () => {
  assert.deepEqual(codexTokenIdentity(accessToken), {
    accountId: 'acct-123',
    email: 'person@example.com',
    planType: 'team',
  });
  assert.equal(decodeCodexJwt('not-a-jwt'), null);
  assert.deepEqual(
    codexTokenIdentity(
      jwt({ 'https://api.openai.com/profile': { email: 42 } }),
      jwt({
        'https://api.openai.com/auth': { chatgpt_plan_type: ' PLUS ' },
      }),
    ),
    { accountId: undefined, email: undefined, planType: 'plus' },
  );
});

test('refresh posts the pinned form and uses injected fetch and clock', async () => {
  let request:
    { input: RequestInfo | URL; init: RequestInit | undefined } | undefined;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { input, init };
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: 'rotated-refresh',
        expires_in: 3_600,
      }),
    );
  }) as typeof fetch;

  const result = await refreshOpenAICodexToken('original-refresh', {
    fetch: fetchFn,
    now: () => 1_700_000_000_000,
  });

  assert.equal(String(request?.input), 'https://auth.openai.com/oauth/token');
  assert.equal(request?.init?.method, 'POST');
  assert.equal(request?.init?.redirect, 'error');
  assert.ok(request?.init?.signal instanceof AbortSignal);
  assert.equal(
    new Headers(request?.init?.headers).get('content-type'),
    'application/x-www-form-urlencoded',
  );
  const form = request?.init?.body as URLSearchParams;
  assert.deepEqual(
    [...form.entries()],
    [
      ['grant_type', 'refresh_token'],
      ['refresh_token', 'original-refresh'],
      ['client_id', OPENAI_CODEX_CLIENT_ID],
    ],
  );
  assert.deepEqual(result, {
    access: accessToken,
    refresh: 'rotated-refresh',
    expires: 1_700_003_600_000,
    accountId: 'acct-123',
    email: 'person@example.com',
  });
});

test('refresh retains the old token and omits unavailable identity', async () => {
  const result = await refreshOpenAICodexToken('original-refresh', {
    fetch: async () =>
      new Response(
        JSON.stringify({ access_token: 'opaque-token', expires_in: 60 }),
      ),
    now: () => 10_000,
  });
  assert.deepEqual(result, {
    access: 'opaque-token',
    refresh: 'original-refresh',
    expires: 70_000,
  });
  assert.equal('accountId' in result, false);
  assert.equal('email' in result, false);
});

test('refresh enforces a 15 second abortable request bound', async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let requestedTimeout: number | undefined;
  AbortSignal.timeout = (milliseconds: number): AbortSignal => {
    requestedTimeout = milliseconds;
    return controller.signal;
  };
  try {
    const pending = refreshOpenAICodexToken('refresh-secret', {
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.signal, controller.signal);
        controller.abort();
        return new Promise<Response>(() => {});
      }) as typeof fetch,
      now: () => 0,
    });
    await assert.rejects(pending, {
      message: 'OpenAI Codex token refresh timed out',
    });
    assert.equal(requestedTimeout, 15_000);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('refresh reads no more than the bounded response size', async () => {
  const oversized = new Uint8Array(1_048_576 + 1);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversized);
      controller.close();
    },
  });
  await assert.rejects(
    refreshOpenAICodexToken('refresh-secret', {
      fetch: async () => new Response(body),
      now: () => 0,
    }),
    { message: 'OpenAI Codex token refresh response was too large' },
  );
});

test('refresh releases an oversized declared response before rejecting it', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    refreshOpenAICodexToken('refresh-secret', {
      fetch: async () =>
        new Response(body, { headers: { 'content-length': '1048577' } }),
      now: () => 0,
    }),
    { message: 'OpenAI Codex token refresh response was too large' },
  );
  assert.equal(cancelled, true);
});

test('non-settling response cancellation cannot defeat the refresh timeout', async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let cancellationStarted = false;
  AbortSignal.timeout = () => controller.signal;
  try {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellationStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const pending = refreshOpenAICodexToken('refresh-secret', {
      fetch: async () =>
        new Response(body, { headers: { 'content-length': '1048577' } }),
      now: () => 0,
    });
    for (let index = 0; index < 10 && !cancellationStarted; index += 1)
      await Promise.resolve();
    assert.equal(cancellationStarted, true);
    controller.abort();
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('still-pending'), 50),
      ),
    ]);
    assert.equal(outcome, 'OpenAI Codex token refresh timed out');
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('refresh validates JSON, tokens, expiry, and optional identity', async (t) => {
  const invalid: Array<[string, string]> = [
    ['not JSON', 'not-json'],
    ['a JSON object', '[]'],
    ['an access token', JSON.stringify({ expires_in: 60 })],
    [
      'a positive integer expiry',
      JSON.stringify({ access_token: 'access', expires_in: -1 }),
    ],
    [
      'a supplied refresh token',
      JSON.stringify({
        access_token: 'access',
        refresh_token: null,
        expires_in: 60,
      }),
    ],
    [
      'a bounded account identity',
      JSON.stringify({
        access_token: jwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'a'.repeat(4_097),
          },
        }),
        expires_in: 60,
      }),
    ],
  ];
  for (const [name, body] of invalid) {
    await t.test(name, async () => {
      const expected =
        name === 'not JSON'
          ? 'OpenAI Codex token refresh returned invalid JSON'
          : 'OpenAI Codex token refresh returned an invalid response';
      await assert.rejects(
        refreshOpenAICodexToken('refresh-secret', {
          fetch: async () => new Response(body),
          now: () => 0,
        }),
        { message: expected },
      );
    });
  }
});

test('refresh errors are fixed and never contain response bodies or tokens', async () => {
  const responseSecret = 'response-secret-access-token';
  const refreshSecret = 'request-secret-refresh-token';
  let error: unknown;
  try {
    await refreshOpenAICodexToken(refreshSecret, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: responseSecret,
            refresh_token: refreshSecret,
          }),
          { status: 401 },
        ),
      now: () => 0,
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.equal(
    error.message,
    'OpenAI Codex token refresh failed with HTTP status 401',
  );
  assert.equal(error.message.includes(responseSecret), false);
  assert.equal(error.message.includes(refreshSecret), false);

  await assert.rejects(
    refreshOpenAICodexToken(refreshSecret, {
      fetch: async () => {
        throw new Error(`transport leaked ${refreshSecret}`);
      },
      now: () => 0,
    }),
    { message: 'OpenAI Codex token refresh request failed' },
  );
});
