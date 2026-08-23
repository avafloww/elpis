// Unit + live-loopback tests for src/console/server.ts's Origin guard.
//
// Browser WebSocket connections aren't subject to the same-origin policy and
// send no preflight, so without a guard any page the operator's browser
// visits could open ws://127.0.0.1:<port>/ws directly. Since the `moderate`
// op that socket can mutate agent state, so the guard is exercised
// two ways here: the pure `isAllowedOrigin` predicate (fast, exhaustive edge
// cases) AND a real server bound to an ephemeral loopback port, hit with a
// real `ws` client carrying a foreign / own / absent Origin header — proof
// the wiring in createConsoleServer actually rejects/accepts at the socket,
// not just that the predicate is correct in isolation.
//
// No external network — everything binds to 127.0.0.1. Run with:
// npm run test:unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  createConsoleServer,
  isAllowedOrigin,
  resolveAttachmentPath,
  resolveFramePath,
} from '../src/console/server.js';
import { ConsoleHub } from '../src/console/hub.js';
import { makeConfig } from './helpers.js';

test('isAllowedOrigin: absent Origin is allowed (the non-browser client path)', () => {
  assert.equal(isAllowedOrigin(undefined, 8787), true);
});

test("isAllowedOrigin: the console's own origin (127.0.0.1 / localhost, matching port) is allowed", () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:8787', 8787), true);
  assert.equal(isAllowedOrigin('http://localhost:8787', 8787), true);
});

test('isAllowedOrigin: a foreign origin is rejected', () => {
  assert.equal(isAllowedOrigin('http://evil.example.com', 8787), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1.evil.com:8787', 8787), false);
});

test('isAllowedOrigin: the right host but the wrong port is rejected', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:9999', 8787), false);
});

test('isAllowedOrigin: a malformed Origin string is rejected, not thrown', () => {
  assert.equal(isAllowedOrigin('not-a-url', 8787), false);
});

test('resolveAttachmentPath: maps /attachments/<msgId>/<file> under the attachment root', () => {
  assert.equal(
    resolveAttachmentPath('/attachments/123456/photo-0.png'),
    '/tmp/elpis-attach/123456/photo-0.png',
  );
});

test('resolveAttachmentPath: rejects traversal out of the attachment root', () => {
  assert.equal(resolveAttachmentPath('/attachments/../etc/passwd'), null);
  assert.equal(
    resolveAttachmentPath('/attachments/123/../../etc/passwd'),
    null,
  );
  // Empty remainder resolves to the root itself, not a file under it.
  assert.equal(resolveAttachmentPath('/attachments/'), null);
});

test('resolveFramePath confines image routes to canonical console frame roots', () => {
  assert.equal(
    resolveFramePath('/frames/computer/desktop.png', '/tmp/unn'),
    '/tmp/unn/elpis-data/computer/screenshots/desktop.png',
  );
  assert.equal(
    resolveFramePath('/frames/browser/nested/page.webp', '/tmp/unn'),
    '/tmp/unn/elpis-data/browser/screenshots/nested/page.webp',
  );
  assert.equal(
    resolveFramePath('/frames/computer/../secret.png', '/tmp/unn'),
    null,
  );
  assert.equal(
    resolveFramePath('/frames/motor/episode.png', '/tmp/unn'),
    '/tmp/unn/elpis-data/motor/episodes/episode.png',
  );
  assert.equal(resolveFramePath('/frames/motor/trace.json', '/tmp/unn'), null);
  assert.equal(resolveFramePath('/frames/unknown/frame.png', '/tmp/unn'), null);
});

test('static console server declares PWA asset MIME types', () => {
  const source = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/console/server.ts',
    ),
    'utf8',
  );
  assert.equal(source.includes("  '.png': 'image/png',"), true);
  assert.equal(
    source.includes(
      "  '.webmanifest': 'application/manifest+json; charset=utf-8',",
    ),
    true,
  );
});

test('resolveAttachmentPath: non-attachment paths are not its business', () => {
  assert.equal(resolveAttachmentPath('/index.html'), null);
  assert.equal(resolveAttachmentPath('/attachments-evil/x'), null);
});

/** Grab an OS-assigned free TCP port on loopback, then release it immediately
 * so createConsoleServer can bind it. Small window for a race with another
 * process grabbing the same port between close and re-listen — acceptable
 * for a test, and this codebase has no existing free-port helper to reuse. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Attempt a WebSocket handshake against `url`, optionally carrying an
 * `Origin` header (omitted entirely when `origin` is undefined — mirrors a
 * non-browser client). Resolves rather than rejects either way so the test
 * can assert on the outcome directly. */
function tryConnect(
  url: string,
  origin?: string,
): Promise<{ ok: boolean; code?: number }> {
  return new Promise((resolve) => {
    const ws = origin ? new WebSocket(url, { origin }) : new WebSocket(url);
    let settled = false;
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true });
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: res.statusCode });
      ws.terminate();
    });
    ws.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false });
    });
  });
}

test('/attachments/ route: serves a downloaded attachment, 404s a missing one, 403s traversal', async (t) => {
  const port = await freePort();
  const config = makeConfig({
    console: { enabled: true, port, host: '127.0.0.1' },
  });
  const hub = new ConsoleHub([]);
  const server = createConsoleServer(config, hub);
  await server.start();
  t.after(() => server.stop());

  const msgDir = path.join('/tmp/elpis-attach', `test-${process.pid}`);
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(
    path.join(msgDir, 'pixel-0.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  t.after(() => fs.rmSync(msgDir, { recursive: true, force: true }));

  const base = `http://127.0.0.1:${port}`;
  const ok = await fetch(`${base}/attachments/test-${process.pid}/pixel-0.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal((await ok.arrayBuffer()).byteLength, 4);

  const missing = await fetch(
    `${base}/attachments/test-${process.pid}/nope.png`,
  );
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${base}/attachments/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(traversal.status, 403);
});

test('/frames/ route serves only bounded canonical images and rejects symlink escape', async (t) => {
  const port = await freePort();
  const dataDirectory = fs.mkdtempSync('/tmp/elpis-frame-test-');
  const config = makeConfig({
    console: { enabled: true, port, host: '127.0.0.1' },
  });
  config.paths.dataDirectory = dataDirectory;
  const root = path.join(dataDirectory, 'elpis-data/computer/screenshots');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'desktop.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  fs.symlinkSync('/etc/passwd', path.join(root, 'escape.png'));
  const server = createConsoleServer(config, new ConsoleHub([]));
  await server.start();
  t.after(() => {
    server.stop();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const frame = await fetch(`${base}/frames/computer/desktop.png`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.equal((await frame.arrayBuffer()).byteLength, 4);
  assert.equal(
    (await fetch(`${base}/frames/computer/missing.png`)).status,
    404,
  );
  assert.equal((await fetch(`${base}/frames/computer/escape.png`)).status, 404);
  assert.equal(
    (await fetch(`${base}/frames/computer/..%2F..%2Fsecret.png`)).status,
    403,
  );
});

test("console websocket Origin guard: rejects a foreign origin, accepts the console's own origin and an absent origin", async (t) => {
  const port = await freePort();
  const config = makeConfig({
    console: { enabled: true, port, host: '127.0.0.1' },
  });
  const hub = new ConsoleHub([]);
  const server = createConsoleServer(config, hub);
  await server.start();
  t.after(() => server.stop());

  const url = `ws://127.0.0.1:${port}/ws`;

  const foreign = await tryConnect(url, 'http://evil.example.com');
  assert.equal(foreign.ok, false, 'a foreign Origin must be rejected');
  assert.equal(foreign.code, 403);

  const own = await tryConnect(url, `http://127.0.0.1:${port}`);
  assert.equal(own.ok, true, "the console's own origin must be accepted");

  const absent = await tryConnect(url);
  assert.equal(
    absent.ok,
    true,
    'an absent Origin (non-browser client) must be accepted',
  );
});
