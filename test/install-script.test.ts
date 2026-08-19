import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const installer = path.join(root, 'deploy', 'install.sh');

function run(args: string[]) {
  return spawnSync('bash', [installer, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 });
}

test('installer shell parses and documents authored brain seeds', () => {
  const syntax = spawnSync('bash', ['-n', installer], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--soul-file FILE/);
  assert.match(help.stdout, /--memory-file FILE/);
  assert.match(help.stdout, /never overwrite existing files/);
});

test('installer trusts only its exact operator-owned bootstrap checkout', () => {
  const source = fs.readFileSync(installer, 'utf8');
  assert.match(source, /git -c safe\.directory="\$LOCAL_SOURCE" -c safe\.directory="\$LOCAL_SOURCE\/\.git"/);
  assert.doesNotMatch(source, /git config --global[^\n]*safe\.directory/);
});

test('installer rejects a missing seed before sudo or package work', () => {
  const result = run(['--non-interactive', '--soul-file', '/definitely/missing/elpis-soul.md']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--soul-file is not a readable file/);
  assert.doesNotMatch(result.stdout + result.stderr, /Installing base packages/);
});

test('installer rejects ambiguous generated and authored SOUL inputs before sudo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-install-seed-'));
  try {
    const soul = path.join(dir, 'SOUL.md');
    fs.writeFileSync(soul, '# seed\n');
    const result = run(['--non-interactive', '--agent-name', 'Somebody', '--soul-file', soul]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--agent-name and --soul-file are mutually exclusive/);
    assert.doesNotMatch(result.stdout + result.stderr, /Installing base packages/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
