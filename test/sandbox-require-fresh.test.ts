// test/sandbox-require-fresh.test.ts — require auto-busts the module cache
// for LOCAL file paths, so an on-disk helper the agent just
// rewrote is re-read on the next require rather than serving a stale export.
// Also covers the attachment-only send guard (grab-bag finding, same task
// batch): a content-less send must not throw when files are present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandbox } from '../src/sandbox/index.js';
import { buildGlobals } from '../src/sandbox/globals.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reqfresh-'));

const deps = {
  config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: '/tmp/harness-root', dataDirectory: tmp } },
  logbuf: [] as string[],
};

const sandbox = createSandbox(deps as Parameters<typeof createSandbox>[0]);

test('require() re-reads an edited local .cjs (auto cache-bust)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqfresh-'));
  const helper = path.join(dir, 'h.cjs');
  fs.writeFileSync(helper, 'module.exports = { v: 1 };');

  const r1 = await sandbox.run(`require(${JSON.stringify(helper)}).v`);
  assert.equal(r1.ok, true);
  assert.match(r1.preview ?? '', /1/);

  fs.writeFileSync(helper, 'module.exports = { v: 2 };');

  const r2 = await sandbox.run(`require(${JSON.stringify(helper)}).v`);
  assert.equal(r2.ok, true);
  assert.match(r2.preview ?? '', /2/);
});

test('require() still caches bare (node builtin) specifiers', async () => {
  const r = await sandbox.run(`typeof require('node:path').join`);
  assert.equal(r.ok, true);
  assert.match(r.preview ?? '', /function/);
});

// The ESM half of the same story: require.cache eviction is a no-op for ES
// modules, so the value IS stale and cannot be made fresh in-process. What we
// can guarantee is that the agent is TOLD — in the run's own logs, not on
// process stdout where only journalctl would see it.
test('require() warns, in the run logs, when a changed ESM file is re-required', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqesm-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const mod = path.join(dir, 'm.js');
  fs.writeFileSync(mod, 'export const v = 1;');

  const r1 = await sandbox.run(`require(${JSON.stringify(mod)}).v`);
  assert.equal(r1.ok, true);
  assert.equal(r1.logs ?? '', '', 'first require is silent');

  fs.writeFileSync(mod, 'export const v = 2;');
  fs.utimesSync(mod, new Date(), new Date(Date.now() + 2000));

  const r2 = await sandbox.run(`require(${JSON.stringify(mod)}).v`);
  assert.equal(r2.ok, true);
  assert.match(r2.logs ?? '', /STALE/, 'the warning must reach the run logs');
  assert.match(r2.logs ?? '', /subprocess/, 'and must name the workaround');
});

function buildSendHandle(sendCalls: { channelId: string; content: string }[]) {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
    send: async (channelId: string, content: string) => { sendCalls.push({ channelId, content }); },
  } as unknown as import('../src/types.js').SandboxDeps);
  const elpis = g.elpis as { channel: (id?: string) => { send: (content: unknown, opts?: { files?: { path: string; name?: string }[] }) => Promise<{ ok: boolean }> } };
  return elpis.channel('2001');
}

test("elpis.channel().send('', { files }) does not throw — attachment-only send", async () => {
  const calls: { channelId: string; content: string }[] = [];
  const handle = buildSendHandle(calls);
  const result = await handle.send('', { files: [{ path: '/tmp/x.png' }] });
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.content, '');
});

test('elpis.channel().send(undefined, { files }) does not throw — attachment-only send', async () => {
  const calls: { channelId: string; content: string }[] = [];
  const handle = buildSendHandle(calls);
  const result = await handle.send(undefined, { files: [{ path: '/tmp/x.png' }] });
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.content, '');
});

test('elpis.channel().send(undefined) still throws without files', async () => {
  const calls: { channelId: string; content: string }[] = [];
  const handle = buildSendHandle(calls);
  await assert.rejects(() => handle.send(undefined), /requires a string/);
});
