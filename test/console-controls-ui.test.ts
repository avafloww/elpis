import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "../src/console/public");

function read(name: string): string {
  return fs.readFileSync(path.join(publicDir, name), "utf8");
}

test("rough operations strip exposes real worker and secretary lanes", () => {
  const html = read("index.html");
  assert.match(html, /unfinished operations/);
  assert.match(html, /id="worker-root"/);
  assert.match(html, /id="secretary-root"/);
  assert.match(html, /id="worker-sessions"/);
  assert.match(html, /id="secretary-sessions"/);
});

test("console controls use the one request-correlated websocket contract", () => {
  const app = read("app.js");
  assert.match(app, /JSON\.stringify\(\{ t: 'control', lane, op, reqId,/);
  assert.match(app, /case 'controlResult': applyControlResult\(m\)/);
  assert.match(app, /controlSend\('worker', 'snapshot'\)/);
  assert.match(app, /controlSend\('secretary', 'snapshot'\)/);
  assert.match(app, /window\.confirm\(`Dismiss /);
  assert.match(app, /window\.confirm\(`Close and revoke /);
});

test("console operations UI displays receipts but has no secret or local-path control", () => {
  const app = read("app.js");
  const html = read("index.html");
  const controls = app.slice(app.indexOf("const controlState"), app.indexOf("function applyMindSnapshot"));
  assert.match(controls, /a\.sha256 \|\| a\.digest/);
  assert.doesNotMatch(html, /token|credential|artifact path/i);
  assert.doesNotMatch(controls, /secretKey|rawToken|relativePath|localPath/);
});
