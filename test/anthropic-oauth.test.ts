import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refreshAnthropicToken as transportRefreshAnthropicToken } from '@elpis/provider-transport';
import {
  ANTHROPIC_REDIRECT_URI,
  refreshAnthropicToken,
  startAnthropicLogin,
} from '../src/llm/oauth/anthropic.js';

test('interactive Anthropic authorization remains resident-owned', () => {
  const login = startAnthropicLogin();
  const url = new URL(login.url);
  assert.equal(url.origin, 'https://claude.ai');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), ANTHROPIC_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), login.pkce.challenge);
  assert.equal(url.searchParams.get('state'), login.state);
  assert.ok(login.pkce.verifier.length > 0);
});

test('resident refresh wrapper preserves shared result and bootstrap wire behavior', async () => {
  const fixedNow = 1_700_000_000_000;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (String(input).includes('/bootstrap')) {
      return new Response(
        JSON.stringify({
          oauth_account: {
            account_uuid: 'bootstrap-account',
            account_email: 'bootstrap@example.com',
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        access_token: 'access-new',
        expires_in: 3_600,
        account: { uuid: 'token-account' },
      }),
    );
  }) as typeof fetch;

  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  globalThis.fetch = fetchFn;
  Date.now = () => fixedNow;
  try {
    const resident = await refreshAnthropicToken('refresh-old');
    const shared = await transportRefreshAnthropicToken('refresh-old', {
      fetch: fetchFn,
      now: () => fixedNow,
    });
    assert.deepEqual(resident, shared);
    assert.deepEqual(resident, {
      access: 'access-new',
      refresh: 'refresh-old',
      expires: fixedNow + 3_600_000 - 300_000,
      accountId: 'token-account',
      email: 'bootstrap@example.com',
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }

  assert.equal(requests.length, 4);
  for (let index = 0; index < requests.length; index += 2) {
    const token = requests[index];
    const bootstrap = requests[index + 1];
    assert.equal(token?.url, 'https://api.anthropic.com/v1/oauth/token');
    assert.equal(token?.init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(token?.init?.body)), {
      grant_type: 'refresh_token',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      refresh_token: 'refresh-old',
    });
    assert.equal(
      bootstrap?.url,
      'https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8',
    );
    assert.equal(bootstrap?.init?.redirect, 'error');
    assert.equal(
      new Headers(bootstrap?.init?.headers).get('authorization'),
      'Bearer access-new',
    );
  }
});
