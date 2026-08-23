import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRuntimeProfile,
  resolveBuiltinModules,
  RESTRICTED_SENTINEL,
} from '../src/builtin-modules.js';
import { makeConfig } from './helpers.js';

test('restricted sentinel is non-bypassable by an unset or false environment variable', () => {
  const profile = detectRuntimeProfile({
    env: { ELPIS_RESTRICTED: '0' },
    exists: (path) => path === RESTRICTED_SENTINEL,
  });
  assert.deepEqual(profile, { restricted: true, source: 'sentinel' });
});

test('restricted mode can also be explicitly enabled by environment', () => {
  assert.deepEqual(
    detectRuntimeProfile({
      env: { ELPIS_RESTRICTED: 'true' },
      exists: () => false,
    }),
    { restricted: true, source: 'environment' },
  );
  assert.deepEqual(detectRuntimeProfile({ env: {}, exists: () => false }), {
    restricted: false,
    source: 'normal',
  });
});

test('built-in modules resolve from config and credentials with dependency reasons', () => {
  const base = makeConfig({ modules: { enabled: ['motor'], disabled: [] } });
  const modules = resolveBuiltinModules(base);
  assert.equal(modules.state('kagi'), 'disabled');
  assert.match(modules.reason('kagi') ?? '', /excluded by modules policy/);
  assert.equal(modules.state('bsky'), 'disabled');
  assert.equal(modules.state('browser'), 'disabled');
  assert.match(modules.reason('browser') ?? '', /excluded by modules policy/);
  assert.equal(modules.state('computer'), 'disabled');
  assert.equal(modules.state('motor'), 'unavailable');
  assert.match(
    modules.reason('motor') ?? '',
    /requires an active computer module/,
  );

  const none = resolveBuiltinModules(
    makeConfig({ modules: { enabled: [], disabled: [] } }),
  );
  assert.equal(
    none.statuses.every((status) => status.state === 'disabled'),
    true,
  );

  const denyOne = resolveBuiltinModules(
    makeConfig({ modules: { enabled: null, disabled: ['browser'] } }),
  );
  assert.equal(denyOne.state('browser'), 'disabled');
  assert.equal(denyOne.state('computer'), 'active');

  const restricted = resolveBuiltinModules(
    makeConfig({
      modules: { enabled: ['browser', 'computer', 'motor'], disabled: [] },
    }),
    { restricted: true, source: 'sentinel' },
  );
  assert.equal(restricted.state('browser'), 'unavailable');
  assert.equal(restricted.state('computer'), 'unavailable');
  assert.equal(restricted.state('motor'), 'unavailable');

  const configured = resolveBuiltinModules(
    makeConfig({
      kagi: { apiKey: 'k' },
      bluesky: {
        service: 'https://example.invalid',
        identifier: 'agent.test',
        appPassword: 'pw',
      },
    }),
  );
  assert.equal(configured.state('kagi'), 'active');
  assert.equal(configured.state('bsky'), 'active');
  assert.equal(configured.state('browser'), 'active');
  assert.equal(configured.state('computer'), 'active');
  assert.equal(configured.state('motor'), 'active');
});
