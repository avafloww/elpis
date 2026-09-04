// Unit tests for the headless OpenAI Codex device-code OAuth flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexTokenIdentity as transportCodexTokenIdentity,
  decodeCodexJwt as transportDecodeCodexJwt,
  refreshOpenAICodexToken as transportRefreshOpenAICodexToken,
} from '@elpis/provider-transport';
import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_DEVICE_AUTH_URL,
  codexTokenIdentity,
  decodeCodexJwt,
  loginOpenAICodexDevice,
  refreshOpenAICodexToken,
} from '../src/llm/oauth/openai-codex.js';

function jwt(payload: Record<string, unknown>): string {
  const part = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `x.${part}.y`;
}

const access = jwt({
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'acct-123',
    chatgpt_plan_type: 'PRO',
  },
  'https://api.openai.com/profile': { email: 'PERSON@EXAMPLE.COM ' },
});

test('codexTokenIdentity extracts workspace, normalized email, and plan claims', () => {
  assert.deepEqual(codexTokenIdentity(access), {
    accountId: 'acct-123',
    email: 'person@example.com',
    planType: 'pro',
  });
  assert.equal(codexTokenIdentity('not-a-jwt').accountId, undefined);
});

test('resident exports the shared identity helpers unchanged', () => {
  assert.equal(codexTokenIdentity, transportCodexTokenIdentity);
  assert.equal(decodeCodexJwt, transportDecodeCodexJwt);
});

test('resident refresh wrapper preserves shared transport results and request behavior', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        access_token: access,
        refresh_token: 'refresh-new',
        expires_in: 90,
      }),
    );
  }) as typeof fetch;
  const fixedNow = 1_700_000_000_000;
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const resident = await refreshOpenAICodexToken('refresh-old', fetchFn);
    const shared = await transportRefreshOpenAICodexToken('refresh-old', {
      fetch: fetchFn,
      now: () => fixedNow,
    });
    assert.deepEqual(resident, shared);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, 'https://auth.openai.com/oauth/token');
    assert.equal(request.init?.redirect, 'error');
    assert.ok(request.init?.signal instanceof AbortSignal);
    const form = request.init?.body as URLSearchParams;
    assert.equal(form.get('client_id'), OPENAI_CODEX_CLIENT_ID);
    assert.equal(form.get('refresh_token'), 'refresh-old');
  }
});

test('device login initializes, treats 403 as pending, then exchanges server PKCE', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const replies = [
    new Response(
      JSON.stringify({
        device_auth_id: 'device-1',
        user_code: 'ABCD-EFGH',
        interval: 1,
      }),
    ),
    new Response('pending', { status: 403 }),
    new Response(
      JSON.stringify({
        authorization_code: 'auth-code',
        code_verifier: 'server-verifier',
      }),
    ),
    new Response(
      JSON.stringify({
        access_token: access,
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }),
    ),
  ];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: input.toString(), init });
    return replies.shift() as Response;
  }) as typeof fetch;
  const waits: number[] = [];
  let shown: { url: string; code: string } | undefined;

  const creds = await loginOpenAICodexDevice({
    fetchFn,
    sleepFn: async (ms) => {
      waits.push(ms);
    },
    onCode: (url, code) => {
      shown = { url, code };
    },
  });

  assert.deepEqual(shown, {
    url: OPENAI_CODEX_DEVICE_AUTH_URL,
    code: 'ABCD-EFGH',
  });
  assert.deepEqual(waits, [4000, 4000], 'server interval + 3s safety margin');
  assert.equal(creds.accountId, 'acct-123');
  assert.equal(creds.orgId, 'acct-123');
  assert.equal(creds.orgName, 'pro');
  assert.equal(creds.authorizedAt !== undefined, true);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
    client_id: OPENAI_CODEX_CLIENT_ID,
  });
  const exchange = requests[3].init?.body as URLSearchParams;
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('code_verifier'), 'server-verifier');
  assert.equal(
    exchange.get('redirect_uri'),
    'https://auth.openai.com/deviceauth/callback',
  );
});

test('refresh keeps the prior refresh token when OpenAI does not rotate it', async () => {
  let body: URLSearchParams | undefined;
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = init?.body as URLSearchParams;
    return new Response(
      JSON.stringify({ access_token: access, expires_in: 7200 }),
    );
  }) as typeof fetch;
  const creds = await refreshOpenAICodexToken('refresh-old', fetchFn);
  assert.equal(body?.get('grant_type'), 'refresh_token');
  assert.equal(body?.get('client_id'), OPENAI_CODEX_CLIENT_ID);
  assert.equal(creds.refresh, 'refresh-old');
  assert.equal(creds.accountId, 'acct-123');
});

test('refresh omits unavailable identity fields so OAuthStore preserves login workspace', async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({ access_token: 'opaque-access-token', expires_in: 7200 }),
    )) as typeof fetch;
  const creds = await refreshOpenAICodexToken('refresh-old', fetchFn);
  assert.equal('accountId' in creds, false);
  assert.equal('email' in creds, false);
});

test('device login has a bounded wait', async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1)
      return new Response(
        JSON.stringify({ device_auth_id: 'd', user_code: 'U', interval: 5 }),
      );
    return new Response('pending', { status: 404 });
  }) as typeof fetch;
  await assert.rejects(
    () =>
      loginOpenAICodexDevice({
        fetchFn,
        sleepFn: async () => {},
        maxWaitMs: 1,
      }),
    /timed out/,
  );
  assert.equal(calls, 2);
});
