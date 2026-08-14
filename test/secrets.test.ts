import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSecretValues, redactSecrets } from '../src/lib/secrets.js';
import { makeConfig } from './helpers.js';

test('collectSecretValues reads configured credentials and ignores short or absent values', () => {
  const base = makeConfig();
  const config = makeConfig({
    llm: { ...base.llm, apiKey: 'sk-llm-key-abcdefgh' },
    discord: { ...base.discord, botToken: 'bot-token-ijklmnop' },
    kagi: { apiKey: 'kagi-key-qrstuvwx' },
  });
  assert.deepEqual(
    collectSecretValues(config).sort(),
    ['bot-token-ijklmnop', 'kagi-key-qrstuvwx', 'sk-llm-key-abcdefgh'],
  );
  assert.deepEqual(collectSecretValues(makeConfig({ kagi: { apiKey: null } })), []);
  assert.deepEqual(collectSecretValues(makeConfig({
    llm: { ...base.llm, apiKey: 'short' },
  })), []);
});

test('collectSecretValues never treats process.env as credential configuration', () => {
  process.env.KAGI_API_KEY = 'env-only-secret-12345';
  try {
    assert.deepEqual(collectSecretValues(makeConfig()), []);
  } finally {
    delete process.env.KAGI_API_KEY;
  }
});

test('redactSecrets replaces every configured secret before text is exposed', () => {
  const text = 'keys: alpha-secret-12345 and beta-secret-67890';
  const redacted = redactSecrets(text, ['alpha-secret-12345', 'beta-secret-67890']);
  assert.equal(redacted, 'keys: [SECRET REDACTED] and [SECRET REDACTED]');
  assert.ok(!redacted.includes('secret-'));
});
