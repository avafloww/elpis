import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OAuthCredentialManager,
  oauthCredentialsEqual,
  type OAuthCredentialStorage,
  type OAuthCredentials,
} from '../src/index.js';

class MemoryStorage implements OAuthCredentialStorage {
  readonly location = 'memory oauth fixture';
  value: OAuthCredentials | undefined;
  readonly writes: OAuthCredentials[] = [];

  read(): OAuthCredentials | undefined {
    return this.value === undefined ? undefined : { ...this.value };
  }

  write(value: OAuthCredentials): void {
    this.value = { ...value };
    this.writes.push({ ...value });
  }

  compareAndWrite(
    expected: OAuthCredentials,
    replacement: OAuthCredentials,
  ): boolean {
    if (
      this.value === undefined ||
      !oauthCredentialsEqual(this.value, expected)
    )
      return false;
    this.write(replacement);
    return true;
  }
}

const current: OAuthCredentials = {
  access: 'access-0',
  refresh: 'refresh-0',
  expires: 100_000,
  accountId: 'account-1',
  orgId: 'org-1',
  authorizedAt: 500,
};

test('returns a current access token without refreshing', async () => {
  const storage = new MemoryStorage();
  storage.value = current;
  let refreshes = 0;
  const manager = new OAuthCredentialManager({
    storage,
    now: () => 1_000,
    refresh: async () => {
      refreshes += 1;
      return current;
    },
  });

  assert.equal(await manager.getAccessToken(), 'access-0');
  assert.equal(refreshes, 0);
  assert.equal(storage.writes.length, 0);
  assert.equal(manager.isLoggedIn(), true);
});

test('refreshes near expiry and merges provider-omitted identity fields', async () => {
  const storage = new MemoryStorage();
  storage.value = { ...current, expires: 1_500 };
  const manager = new OAuthCredentialManager({
    storage,
    now: () => 1_000,
    refreshSkewMs: 1_000,
    refresh: async (refreshToken) => {
      assert.equal(refreshToken, 'refresh-0');
      return {
        access: 'access-1',
        refresh: 'refresh-1',
        expires: 20_000,
      };
    },
  });

  assert.equal(await manager.getAccessToken(), 'access-1');
  assert.deepEqual(storage.value, {
    ...current,
    access: 'access-1',
    refresh: 'refresh-1',
    expires: 20_000,
  });
  assert.equal(storage.writes.length, 1);
});

test('force refresh is a no-op when no credential exists', async () => {
  const storage = new MemoryStorage();
  let refreshes = 0;
  const manager = new OAuthCredentialManager({
    storage,
    refresh: async () => {
      refreshes += 1;
      return current;
    },
  });

  assert.equal(manager.read(), undefined);
  assert.equal(manager.isLoggedIn(), false);
  await manager.forceRefresh();
  assert.equal(refreshes, 0);
  await assert.rejects(
    () => manager.getAccessToken(),
    /no OAuth credential in memory oauth fixture/,
  );
});

test('concurrent refresh calls share one in-flight provider request', async () => {
  const storage = new MemoryStorage();
  storage.value = { ...current, expires: 1_500 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshes = 0;
  const manager = new OAuthCredentialManager({
    storage,
    now: () => 1_000,
    refreshSkewMs: 1_000,
    refresh: async () => {
      refreshes += 1;
      await gate;
      return { ...current, access: 'access-1', expires: 20_000 };
    },
  });

  const calls = [
    manager.getAccessToken(),
    manager.getAccessToken(),
    manager.forceRefresh(),
  ];
  await Promise.resolve();
  assert.equal(refreshes, 1);
  release();
  const [first, second] = await Promise.all(calls);
  assert.equal(first, 'access-1');
  assert.equal(second, 'access-1');
  assert.equal(storage.writes.length, 1);
});

test('a newer credential write wins over an older in-flight refresh', async () => {
  const storage = new MemoryStorage();
  storage.value = { ...current, expires: 1_500 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new OAuthCredentialManager({
    storage,
    now: () => 1_000,
    refreshSkewMs: 1_000,
    refresh: async () => {
      await gate;
      return {
        ...current,
        access: 'stale-refresh-access',
        refresh: 'stale-refresh-token',
        expires: 20_000,
      };
    },
  });

  const refreshing = manager.getAccessToken();
  await Promise.resolve();
  manager.write({
    ...current,
    access: 'new-login-access',
    refresh: 'new-login-refresh',
    expires: 30_000,
  });
  release();

  assert.equal(await refreshing, 'new-login-access');
  assert.equal(storage.value?.access, 'new-login-access');
  assert.equal(storage.value?.refresh, 'new-login-refresh');
});

test('rejects malformed credentials from writes and storage without exposing values', () => {
  const storage = new MemoryStorage();
  const manager = new OAuthCredentialManager({
    storage,
    refresh: async () => current,
  });
  const malformed = [
    { ...current, access: '' },
    { ...current, refresh: '' },
    { ...current, expires: Number.NaN },
    { ...current, expires: -1 },
    { ...current, authorizedAt: 1.5 },
    { ...current, accountId: 42 },
    { ...current, surprise: 'not part of the credential contract' },
  ];

  for (const value of malformed) {
    assert.throws(
      () => manager.write(value as unknown as OAuthCredentials),
      (error: unknown) =>
        error instanceof TypeError &&
        /OAuth credential/.test(error.message) &&
        !error.message.includes('access-0') &&
        !error.message.includes('refresh-0'),
    );
  }

  storage.value = malformed[0] as OAuthCredentials;
  assert.throws(() => manager.read(), /OAuth credential/);
});

test('rejects a malformed refresh result without replacing stored credentials', async () => {
  const storage = new MemoryStorage();
  storage.value = { ...current, expires: 1_500 };
  const manager = new OAuthCredentialManager({
    storage,
    now: () => 1_000,
    refreshSkewMs: 1_000,
    refresh: async () => ({
      ...current,
      access: '',
      refresh: 'malformed-refresh-result',
      expires: 20_000,
    }),
  });

  await assert.rejects(() => manager.getAccessToken(), /OAuth credential/);
  assert.equal(storage.value.access, 'access-0');
  assert.equal(storage.writes.length, 0);
});

test('a failed refresh releases the single-flight latch for a later retry', async () => {
  const storage = new MemoryStorage();
  storage.value = { ...current, expires: 1_500 };
  let attempts = 0;
  const manager = new OAuthCredentialManager({
    storage,
    now: () => 1_000,
    refreshSkewMs: 1_000,
    refresh: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic refresh failure');
      return { ...current, access: 'access-2', expires: 20_000 };
    },
  });

  await assert.rejects(
    () => manager.getAccessToken(),
    /synthetic refresh failure/,
  );
  assert.equal(await manager.getAccessToken(), 'access-2');
  assert.equal(attempts, 2);
});
