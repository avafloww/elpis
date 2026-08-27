import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('test preload removes its one owned temp root at process exit', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-probe-'));
  try {
    const preload = path.resolve('test/temp-root.mjs');
    const env = { ...process.env, TMPDIR: outer, TMP: outer, TEMP: outer };
    delete env.ELPIS_TEST_RUN_TMP;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        '--eval',
        'process.stdout.write(process.env.ELPIS_TEST_RUN_TMP)',
      ],
      { env, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^.+\/elpis-test-run-[A-Za-z0-9_-]+$/);
    assert.equal(fs.existsSync(child.stdout), false);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
