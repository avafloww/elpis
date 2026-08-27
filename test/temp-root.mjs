import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT_ENV = 'ELPIS_TEST_RUN_TMP';
const KEEP_ENV = 'ELPIS_KEEP_TEST_TMP';
const inherited = process.env[ROOT_ENV];

if (inherited) {
  process.env.TMPDIR = inherited;
  process.env.TMP = inherited;
  process.env.TEMP = inherited;
} else {
  const hostTmp = os.tmpdir();
  const root = fs.mkdtempSync(path.join(hostTmp, 'elpis-test-run-'));
  fs.chmodSync(root, 0o700);
  process.env[ROOT_ENV] = root;
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  process.once('exit', () => {
    if (process.env[KEEP_ENV] === '1') return;
    const relative = path.relative(hostTmp, root);
    if (!/^elpis-test-run-[A-Za-z0-9_-]+$/.test(relative)) return;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
