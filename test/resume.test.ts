// Unit tests for the resume-after-restart marker (deploy/restart → boot
// continuity). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearResumeMarker, writeResumeMarker, consumeResumeMarker } from '../src/store/resume.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-resume-'));

test('resume: write → consume round-trips the reason (V1: no channel)', () => {
  const dir = tmp();
  writeResumeMarker(dir, 'testing the git helper');
  const m = consumeResumeMarker(dir);
  assert.ok(m, 'marker must be found');
  assert.equal(m!.reason, 'testing the git helper');
});

test('resume: clear removes a pending marker after a failed restart request', () => {
  const dir = tmp();
  writeResumeMarker(dir, 'failed request');
  clearResumeMarker(dir);
  assert.equal(consumeResumeMarker(dir), null);
});

test('resume: marker is consume-once (second read returns null)', () => {
  const dir = tmp();
  writeResumeMarker(dir, 'x');
  assert.ok(consumeResumeMarker(dir));
  assert.equal(consumeResumeMarker(dir), null, 'a consumed marker must not replay');
  assert.ok(!fs.existsSync(resolveDataLayout(dir).resumeMarker));
});

test('resume: a stale marker (older than maxAge) is discarded', () => {
  const dir = tmp();
  fs.mkdirSync(resolveDataLayout(dir).root, { recursive: true });
  const file = resolveDataLayout(dir).resumeMarker;
  fs.writeFileSync(file, JSON.stringify({
    reason: null,
    at: new Date(Date.now() - 20 * 60_000).toISOString(),
  }));
  assert.equal(consumeResumeMarker(dir), null, 'stale marker must be dropped');
  assert.ok(!fs.existsSync(file), 'stale marker is still consumed (deleted)');
});

test('resume: malformed marker returns null', () => {
  const dir = tmp();
  fs.mkdirSync(resolveDataLayout(dir).root, { recursive: true });
  fs.writeFileSync(resolveDataLayout(dir).resumeMarker, 'not json{{');
  assert.equal(consumeResumeMarker(dir), null);
});

test('resume: no marker at all returns null without touching the dir', () => {
  assert.equal(consumeResumeMarker(tmp()), null);
});
