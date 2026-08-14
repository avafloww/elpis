import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/store/db.js';
import { OAuthStore, type OAuthCredentials } from '../src/llm/oauth/store.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return db;
}

const base: OAuthCredentials = { access: 'A0', refresh: 'R0', expires: Date.now() + 3_600_000, orgId: 'org1', authorizedAt: 1000 };

test('store: write persists and read round-trips', () => {
  const db = freshDb();
  const store = new OAuthStore(db, 'anthropic', async () => base);
  store.write(base);
  const got = new OAuthStore(db, 'anthropic', async () => base).read();
  assert.equal(got?.access, 'A0');
  assert.equal(got?.refresh, 'R0');
  assert.equal(got?.expires, base.expires);
  assert.equal(got?.orgId, 'org1');
  assert.equal(got?.authorizedAt, 1000);
  assert.equal(got?.email, undefined);
  assert.ok(new OAuthStore(db, 'anthropic', async () => base).isLoggedIn());
});

test('store: absent row reads as not-logged-in', () => {
  const store = new OAuthStore(freshDb(), 'anthropic', async () => base);
  assert.equal(store.read(), undefined);
  assert.equal(store.isLoggedIn(), false);
});

test('store: providers are isolated by key (codex reuse)', () => {
  const db = freshDb();
  new OAuthStore(db, 'anthropic', async () => base).write(base);
  const codex = new OAuthStore(db, 'openai-codex', async () => base);
  assert.equal(codex.isLoggedIn(), false);
  codex.write({ access: 'CX', refresh: 'CXR', expires: Date.now() + 1000 });
  assert.equal(new OAuthStore(db, 'anthropic', async () => base).read()?.access, 'A0');
  assert.equal(new OAuthStore(db, 'openai-codex', async () => base).read()?.access, 'CX');
});

test('store: getAccessToken returns current token when far from expiry', async () => {
  const db = freshDb();
  let refreshes = 0;
  const store = new OAuthStore(db, 'anthropic', async () => { refreshes++; return base; });
  store.write(base);
  assert.equal(await store.getAccessToken(), 'A0');
  assert.equal(refreshes, 0);
});

test('store: refreshes near expiry, persists rotated token, merges over stored', async () => {
  const db = freshDb();
  const expiring: OAuthCredentials = { ...base, access: 'A0', refresh: 'R0', expires: Date.now() + 1000 };
  const store = new OAuthStore(db, 'anthropic', async (rt) => {
    assert.equal(rt, 'R0');
 // Refresh omits org (fixed at login) — the store must preserve it.
    return { access: 'A1', refresh: 'R1', expires: Date.now() + 3_600_000 };
  });
  store.write(expiring);
  assert.equal(await store.getAccessToken(), 'A1');
  const persisted = new OAuthStore(db, 'anthropic', async () => base).read();
  assert.equal(persisted?.access, 'A1');
  assert.equal(persisted?.refresh, 'R1');
  assert.equal(persisted?.orgId, 'org1'); // preserved from the stored record
  assert.equal(persisted?.authorizedAt, 1000);
});

test('store: concurrent getAccessToken single-flights the refresh', async () => {
  const db = freshDb();
  const expiring: OAuthCredentials = { ...base, expires: Date.now() + 1000 };
  let refreshes = 0;
  const store = new OAuthStore(db, 'anthropic', async () => {
    refreshes++;
    await new Promise((r) => setTimeout(r, 20));
    return { access: 'A1', refresh: 'R1', expires: Date.now() + 3_600_000 };
  });
  store.write(expiring);
  const tokens = await Promise.all([store.getAccessToken(), store.getAccessToken(), store.getAccessToken()]);
  assert.deepEqual(tokens, ['A1', 'A1', 'A1']);
  assert.equal(refreshes, 1);
});

test('store: getAccessToken throws when not logged in', async () => {
  const store = new OAuthStore(freshDb(), 'anthropic', async () => base);
  await assert.rejects(() => store.getAccessToken(), /no OAuth credential/);
});
