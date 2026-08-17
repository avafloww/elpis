import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultConfigPath, loadConfigFile } from '../src/config.js';

test('ELPIS_CONFIG overrides the source-tree config path', () => {
  const previous = process.env.ELPIS_CONFIG;
  process.env.ELPIS_CONFIG = '/data/config.yaml';
  try { assert.equal(defaultConfigPath(), '/data/config.yaml'); }
  finally {
    if (previous === undefined) delete process.env.ELPIS_CONFIG;
    else process.env.ELPIS_CONFIG = previous;
  }
});

function configWith(modules: string): string {
  return `paths:\n  data_directory: /tmp/elpis-config-modules\nllm:\n  api_key: stub\n  base_url: http://stub\n  model: stub\ndiscord:\n  bot_token: c3R1Yg.stub.stub\n  guilds:\n    - id: '1'\n      slug: home\n      channels:\n        '2': direct\nmodules:\n${modules}\n`;
}
function load(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-modules-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, body);
  try { return loadConfigFile(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('module allowlist and denylist parse with empty-list semantics', () => {
  assert.deepEqual(load(configWith('  enabled: []')).modules, { enabled: [], disabled: [] });
  assert.deepEqual(load(configWith('  disabled: []')).modules, { enabled: null, disabled: [] });
  assert.deepEqual(load(configWith('  enabled: [browser, computer]')).modules, { enabled: ['browser', 'computer'], disabled: [] });
});

test('module allowlist and denylist are mutually exclusive even when empty', () => {
  assert.throws(() => load(configWith('  enabled: []\n  disabled: []')), /mutually exclusive/);
});

test('module selectors reject unknown and duplicate ids', () => {
  assert.throws(() => load(configWith('  enabled: [browser, nope]')), /unknown module 'nope'/);
  assert.throws(() => load(configWith('  disabled: [motor, motor]')), /duplicate module 'motor'/);
});
