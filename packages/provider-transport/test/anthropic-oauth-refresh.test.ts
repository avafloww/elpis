import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTHROPIC_OAUTH_CLIENT_ID,
  refreshAnthropicToken,
} from '../src/index.js';

const fixedNow = 1_700_000_000_000;

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_in: 3_600,
      account: { uuid: 'account-1', email_address: 'person@example.com' },
      ...overrides,
    }),
  );
}

test('refresh uses pinned metadata, injected fetch/clock, and expiry margin', async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let requestedTimeout: number | undefined;
  let request:
    { input: RequestInfo | URL; init: RequestInit | undefined } | undefined;
  AbortSignal.timeout = (milliseconds: number): AbortSignal => {
    requestedTimeout = milliseconds;
    return controller.signal;
  };
  try {
    const result = await refreshAnthropicToken('refresh-old', {
      fetch: async (input, init) => {
        request = { input, init };
        return tokenResponse();
      },
      now: () => fixedNow,
    });

    assert.equal(requestedTimeout, 30_000);
    assert.equal(
      String(request?.input),
      'https://api.anthropic.com/v1/oauth/token',
    );
    assert.equal(request?.init?.method, 'POST');
    assert.equal(request?.init?.redirect, 'error');
    assert.equal(request?.init?.signal, controller.signal);
    const headers = new Headers(request?.init?.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('anthropic-beta'), 'oauth-2025-04-20');
    assert.equal(
      headers.get('user-agent'),
      'anthropic-sdk-typescript/0.94.0 userOAuthProvider',
    );
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      grant_type: 'refresh_token',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: 'refresh-old',
    });
    assert.deepEqual(result, {
      access: 'access-new',
      refresh: 'refresh-new',
      expires: fixedNow + 3_600_000 - 300_000,
      accountId: 'account-1',
      email: 'person@example.com',
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('refresh falls back to the pinned bootstrap and prior refresh token', async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const responses = [
    tokenResponse({
      refresh_token: undefined,
      account: { uuid: 'account-from-token' },
    }),
    new Response(
      JSON.stringify({
        oauth_account: {
          account_uuid: 'account-from-bootstrap',
          account_email: 'bootstrap@example.com',
          organization_uuid: 'ignored-org',
          organization_name: 'Ignored org',
        },
      }),
    ),
  ];
  const result = await refreshAnthropicToken('refresh-old', {
    fetch: async (input, init) => {
      requests.push({ input: String(input), init });
      return responses.shift() as Response;
    },
    now: () => fixedNow,
  });

  assert.deepEqual(result, {
    access: 'access-new',
    refresh: 'refresh-old',
    expires: fixedNow + 3_600_000 - 300_000,
    accountId: 'account-from-token',
    email: 'bootstrap@example.com',
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1]?.input,
    'https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8',
  );
  assert.equal(requests[1]?.init?.method, 'GET');
  assert.equal(requests[1]?.init?.redirect, 'error');
  assert.equal(requests[1]?.init?.signal, requests[0]?.init?.signal);
  const headers = new Headers(requests[1]?.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer access-new');
  assert.equal(headers.get('anthropic-beta'), 'oauth-2025-04-20');
});

test('bootstrap enrichment remains best effort and returns explicit empty identity', async () => {
  const result = await refreshAnthropicToken('refresh-old', {
    fetch: async (input) =>
      String(input).includes('/bootstrap')
        ? new Response('private upstream diagnostics', { status: 503 })
        : tokenResponse({ refresh_token: undefined, account: undefined }),
    now: () => fixedNow,
  });
  assert.deepEqual(result, {
    access: 'access-new',
    refresh: 'refresh-old',
    expires: fixedNow + 3_600_000 - 300_000,
    accountId: undefined,
    email: undefined,
  });
});

test('refresh bounds token and bootstrap bodies without awaiting cleanup', async (t) => {
  await t.test('token response', async () => {
    let cancellationStarted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellationStarted = true;
        return new Promise<void>(() => {});
      },
    });
    const outcome = await Promise.race([
      refreshAnthropicToken('refresh-old', {
        fetch: async () =>
          new Response(body, { headers: { 'content-length': '1048577' } }),
        now: () => fixedNow,
      }).then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('still-pending'), 50),
      ),
    ]);
    assert.equal(cancellationStarted, true);
    assert.equal(outcome, 'Anthropic token refresh response was too large');
  });

  await t.test('bootstrap response', async () => {
    let cancellationStarted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellationStarted = true;
        return new Promise<void>(() => {});
      },
    });
    let calls = 0;
    const outcome = await Promise.race([
      refreshAnthropicToken('refresh-old', {
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? tokenResponse({ account: undefined })
            : new Response(body, {
                headers: { 'content-length': '1048577' },
              });
        },
        now: () => fixedNow,
      }).then(() => 'resolved'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('still-pending'), 50),
      ),
    ]);
    assert.equal(cancellationStarted, true);
    assert.equal(outcome, 'resolved');
  });
});

test('refresh manually enforces the 30 second bound when fetch ignores abort', async () => {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  AbortSignal.timeout = () => controller.signal;
  try {
    const pending = refreshAnthropicToken('refresh-old', {
      fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
      now: () => fixedNow,
    });
    controller.abort();
    await assert.rejects(pending, {
      message: 'Anthropic token refresh timed out',
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test('refresh validates exact success, JSON, secrets, expiry, and identity', async (t) => {
  const invalid: Array<[string, Response, string]> = [
    [
      'exact status',
      new Response('private-body', { status: 201 }),
      'Anthropic token refresh failed',
    ],
    [
      'JSON',
      new Response('private-invalid-json'),
      'Anthropic token refresh returned invalid JSON',
    ],
    [
      'JSON object',
      new Response('[]'),
      'Anthropic token refresh returned an invalid response',
    ],
    [
      'access secret',
      tokenResponse({ access_token: '' }),
      'Anthropic token refresh returned an invalid response',
    ],
    [
      'rotated secret',
      tokenResponse({ refresh_token: null }),
      'Anthropic token refresh returned an invalid response',
    ],
    [
      'expiry',
      tokenResponse({ expires_in: 3.5 }),
      'Anthropic token refresh returned an invalid response',
    ],
    [
      'account shape',
      tokenResponse({ account: 'private-account-data' }),
      'Anthropic token refresh returned an invalid response',
    ],
    [
      'identity field',
      tokenResponse({ account: { uuid: 42, email_address: 'a@b.test' } }),
      'Anthropic token refresh returned an invalid response',
    ],
  ];
  for (const [name, response, message] of invalid) {
    await t.test(name, async () => {
      await assert.rejects(
        refreshAnthropicToken('refresh-old', {
          fetch: async () => response,
          now: () => fixedNow,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, message);
          assert.equal(error.message.includes('refresh-old'), false);
          assert.equal(error.message.includes('private'), false);
          assert.equal(error.message.includes('http'), false);
          return true;
        },
      );
    });
  }
});

test('request, body, and clock failures use fixed sanitized errors', async (t) => {
  await t.test('request', async () => {
    await assert.rejects(
      refreshAnthropicToken('refresh-old', {
        fetch: async () => {
          throw new Error(
            'https://secret.example/?token=refresh-old private-account',
          );
        },
        now: () => fixedNow,
      }),
      { message: 'Anthropic token refresh request failed' },
    );
  });
  await t.test('body', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('refresh-old private-account');
      },
    });
    await assert.rejects(
      refreshAnthropicToken('refresh-old', {
        fetch: async () => new Response(body),
        now: () => fixedNow,
      }),
      { message: 'Anthropic token refresh response could not be read' },
    );
  });
  await t.test('clock', async () => {
    await assert.rejects(
      refreshAnthropicToken('refresh-old', {
        fetch: async () => tokenResponse(),
        now: () => {
          throw new Error('private clock details');
        },
      }),
      { message: 'Anthropic token refresh clock failed' },
    );
  });
});
