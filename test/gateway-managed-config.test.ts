import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify } from 'yaml';
import {
  loadConfigFile,
  configForLlmRef,
  configForLlmRole,
  type Config,
} from '../src/config.js';
import { createLLM, fetchContextWindow } from '../src/llm/llm.js';
import { replayIdentityForConfig } from '../src/llm/provenance.js';

// The pending state is not an executable provider fixture. It must never
// acquire synthetic credentials, an upstream endpoint, or a placeholder model.
const roles = {
  main: 'team/main',
  classifier: 'team/classifier',
  motor: null,
  secretary: null,
  compaction: null,
};
const managed = () => ({
  gateway_managed: true,
  completion_reserve_tokens: 4096,
  roles: { ...roles },
});
function load(llm: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-config-'));
  try {
    const file = path.join(root, 'fixture.yaml');
    fs.writeFileSync(
      file,
      stringify({
        llm,
        discord: {
          bot_token:
            Buffer.from('1001').toString('base64url') + '.fixture.token',
          guilds: [
            { id: 'guild-1', slug: 'home', channels: { '1001': 'direct' } },
          ],
        },
        paths: { data_directory: root },
      }),
    );
    return loadConfigFile(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const direct = {
  api_key: 'fixture-only',
  base_url: 'https://api.example.com/v1',
  model: 'model-a',
};
const canonical = {
  providers: {
    team: {
      api_key: 'fixture-only',
      base_url: 'https://api.example.com/v1',
      models: { main: { name: 'model-a' } },
    },
  },
  roles: { main: 'team/main', classifier: 'team/main' },
};

test('managed parsing retains unresolved refs and reserve without requiring enrollment', () => {
  const config = load(managed());
  assert.deepEqual(config.llm, {
    registrySource: 'gateway',
    gatewayManaged: true,
    materialization: 'pending',
    registry: null,
    completionReserveTokens: 4096,
    roles,
  });
  assert.equal(config.dashboard.remote, null);
  for (const key of [
    'apiKey',
    'baseUrl',
    'model',
    'providerType',
    'providers',
    'target',
  ]) {
    assert.equal(Object.hasOwn(config.llm, key), false, key);
  }
});
test('managed parsing preserves optional refs without resolving existence', () => {
  const selected = {
    ...roles,
    motor: 'other/motor',
    secretary: 'other/secretary',
    compaction: 'other/compaction',
  };
  assert.deepEqual(
    Reflect.get(load({ ...managed(), roles: selected }).llm, 'roles'),
    selected,
  );
});
for (const definition of [direct, canonical]) {
  test(
    'gateway_managed false preserves ' +
      (definition === direct ? 'legacy' : 'canonical') +
      ' LLM object shape',
    () => {
      const disabled = load({ ...definition, gateway_managed: false }).llm;
      assert.deepEqual(disabled, load(definition).llm);
      assert.equal(Object.hasOwn(disabled, 'gatewayManaged'), false);
    },
  );
}
for (const value of ['true', 'false', 1, 0, null, {}, []]) {
  test('gateway_managed is a strict boolean: ' + JSON.stringify(value), () => {
    assert.throws(
      () => load({ ...direct, gateway_managed: value }),
      /gateway_managed.*boolean/i,
    );
  });
}
for (const value of [null, {}, canonical.providers]) {
  test(
    'managed mode rejects providers presence: ' + JSON.stringify(value),
    () => {
      assert.throws(
        () => load({ ...managed(), providers: value }),
        /gateway.managed.*providers|providers.*gateway.managed/i,
      );
    },
  );
}
const flatKeys = [
  'provider_type',
  'api_key',
  'base_url',
  'model',
  'context_size',
  'reasoning_effort',
  'external_thinking',
  'stream_idle_timeout_ms',
  'call_timeout_ms',
  'api',
  'reasoning_summary',
  'reasoning_context',
];
for (const key of flatKeys) {
  test('managed mode rejects flat ' + key + ' even when null', () => {
    assert.throws(
      () => load({ ...managed(), [key]: null }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /gateway.managed/i);
        assert.ok(error.message.includes(key));
        return true;
      },
    );
  });
}
for (const role of ['main', 'classifier']) {
  for (const value of [undefined, null, '']) {
    test('managed ' + role + ' is required: ' + String(value), () => {
      assert.throws(
        () => load({ ...managed(), roles: { ...roles, [role]: value } }),
        new RegExp('roles\\.' + role),
      );
    });
  }
}
for (const role of Object.keys(roles)) {
  for (const value of ['model', 'team/a/b', 'Team/main', 'team/main ', 1]) {
    test(
      'managed ' + role + ' syntax is exact: ' + JSON.stringify(value),
      () => {
        assert.throws(
          () => load({ ...managed(), roles: { ...roles, [role]: value } }),
          new RegExp('roles\\.' + role),
        );
      },
    );
  }
}
test('managed mode rejects unknown roles', () => {
  assert.throws(
    () => load({ ...managed(), roles: { ...roles, helper: 'team/helper' } }),
    /unknown llm.roles.*helper/i,
  );
});

// Test refusal independently of parsing: a parser failure must not mask a
// context shortcut or accidental adapter construction at a runtime boundary.
const pending = () =>
  ({
    llm: {
      registrySource: 'gateway',
      gatewayManaged: true,
      materialization: 'pending',
      registry: null,
      completionReserveTokens: 4096,
      roles: { ...roles },
    },
  }) as unknown as Config;
const notMaterialized = /gateway.*materializ|materializ.*gateway/i;
test('pending createLLM refuses before constructing a provider', () => {
  assert.throws(() => createLLM(pending()), notMaterialized);
});
test('pending context lookup cannot return undefined via the direct size shortcut', async () => {
  await assert.rejects(fetchContextWindow(pending()), notMaterialized);
});
test('pending replay identity refuses explicitly', () => {
  assert.throws(() => replayIdentityForConfig(pending()), notMaterialized);
});
test('pending role projection refuses explicitly', () => {
  assert.throws(() => configForLlmRole(pending(), 'main'), notMaterialized);
});
test('pending ref projection refuses explicitly', () => {
  assert.throws(() => configForLlmRef(pending(), 'team/main'), notMaterialized);
});
