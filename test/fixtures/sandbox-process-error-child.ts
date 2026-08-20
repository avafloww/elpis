import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSandbox } from '../../src/sandbox/index.js';
import { routeRunProcessError } from '../../src/sandbox/globals.js';
import type { SandboxLateProcessError } from '../../src/types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-process-event-'));
const portFile = path.join(dir, 'port');
const late: SandboxLateProcessError[] = [];
const globalErrors: Error[] = [];

process.on('uncaughtException', (error) => {
  if (routeRunProcessError('uncaughtException', error)) return;
  globalErrors.push(error);
});

const sandbox = createSandbox({
  config: {
    sandbox: { syncTimeoutMs: 1_000, asyncDeadlineMs: 1_000, persistentRetirementGraceMs: 1_000, previewMaxBytes: 2_048, logMaxBytes: 2_048 },
    kagi: { apiKey: null },
    bluesky: null,
    paths: { harnessRoot: dir, dataDirectory: dir },
  },
  memory: { read: () => '', append: () => undefined, overwrite: () => undefined },
  logbuf: [],
  onLateProcessError: (event) => late.push(event),
} as Parameters<typeof createSandbox>[0]);

const started = await sandbox.run(`
  globalThis.leakedServer = require('node:http').createServer(() => {
    throw new Error('missing temporary preview');
  });
  await new Promise(resolve => leakedServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(${JSON.stringify(portFile)}, String(leakedServer.address().port));
  'ready'
`);
assert.equal(started.ok, true);
const port = Number(fs.readFileSync(portFile, 'utf8'));

async function hit(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', () => resolve());
    request.setTimeout(150, () => { request.destroy(); resolve(); });
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

await hit();
await hit();
assert.equal(late.length, 1);
assert.equal(late[0]?.kind, 'uncaughtException');
assert.match(String((late[0]?.error as Error)?.message), /missing temporary preview/);
assert.equal(globalErrors.length, 0);

const closed = await sandbox.run(`await new Promise(resolve => leakedServer.close(resolve)); 'closed'`);
assert.equal(closed.ok, true);

setImmediate(() => { throw new Error('real harness fault'); });
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(globalErrors.length, 1);
assert.match(globalErrors[0]!.message, /real harness fault/);

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ late: late.length, global: globalErrors.length, closed: closed.ok }));
