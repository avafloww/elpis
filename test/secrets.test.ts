import { createEnrollmentCredential } from '@elpis/gateway-protocol';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SecretRegistry,
  collectSecretValues,
  createSecretRegistry,
  redactSecrets,
} from '../src/lib/secrets.js';
import { makeConfig } from './helpers.js';

test('collectSecretValues reads configured credentials and ignores short or absent values', () => {
  const base = makeConfig();
  const enrollmentToken = createEnrollmentCredential((size) =>
    Buffer.alloc(size, 9),
  ).token;
  const config = makeConfig({
    llm: { ...base.llm, apiKey: 'sk-llm-key-abcdefgh' },
    discord: { ...base.discord, botToken: 'bot-token-ijklmnop' },
    kagi: { apiKey: 'kagi-key-qrstuvwx' },
    dashboard: {
      local: base.dashboard.local,
      remote: { url: 'https://gateway.example', enrollmentToken },
    },
  });
  assert.deepEqual(collectSecretValues(config).sort(), [
    'bot-token-ijklmnop',
    enrollmentToken,
    'kagi-key-qrstuvwx',
    'sk-llm-key-abcdefgh',
  ].sort());
  assert.deepEqual(
    collectSecretValues(makeConfig({ kagi: { apiKey: null } })),
    [],
  );
  assert.deepEqual(
    collectSecretValues(
      makeConfig({
        llm: { ...base.llm, apiKey: 'short' },
      }),
    ),
    [],
  );
});

test('SecretRegistry changes live without exposing or echoing secret values', () => {
  const configured = 'configured-secret-abcdefgh';
  const dynamic = 'dynamic-secret-ijklmnop';
  const registry = new SecretRegistry([configured]);
  assert.equal(registry.size, 1);
  assert.deepEqual(Reflect.ownKeys(registry), []);
  assert.equal(JSON.stringify(registry), '{}');
  assert.equal(
    redactSecrets(`before ${configured} ${dynamic}`, registry),
    'before [SECRET REDACTED] dynamic-secret-ijklmnop',
  );
  assert.equal(registry.register(dynamic), true);
  assert.equal(registry.register(dynamic), false);
  assert.equal(registry.size, 2);
  assert.equal(
    redactSecrets(`after ${configured} ${dynamic}`, registry),
    'after [SECRET REDACTED] [SECRET REDACTED]',
  );
  assert.equal(registry.unregister(dynamic), true);
  assert.equal(registry.unregister(dynamic), false);
  assert.equal(redactSecrets(dynamic, registry), dynamic);
  const rejected = 'tiny';
  assert.throws(
    () => registry.register(rejected),
    (error) => error instanceof TypeError && !error.message.includes(rejected),
  );
  const fromConfig = createSecretRegistry(
    makeConfig({ kagi: { apiKey: configured } }),
  );
  assert.equal(redactSecrets(configured, fromConfig), '[SECRET REDACTED]');
  const oversized = 'x'.repeat(4097);
  assert.throws(
    () => collectSecretValues(makeConfig({ kagi: { apiKey: oversized } })),
    (error) =>
      error instanceof TypeError &&
      /redaction bound/.test(error.message) &&
      !error.message.includes(oversized),
  );
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
  const redacted = redactSecrets(text, [
    'alpha-secret-12345',
    'beta-secret-67890',
  ]);
  assert.equal(redacted, 'keys: [SECRET REDACTED] and [SECRET REDACTED]');
  assert.ok(!redacted.includes('secret-'));
});
