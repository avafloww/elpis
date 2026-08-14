import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPolicyDenial, nonSecretHeaders, recordPolicyDenial } from '../src/llm/policy-flight-recorder.js';
import { makeConfig } from './helpers.js';

function capture(dataDirectory: string, i = 0) {
  const config = makeConfig({ paths: { ...makeConfig().paths, dataDirectory } });
  return recordPolicyDenial(config, 'codex-responses', {
    url: 'https://chatgpt.com/backend-api/codex/responses', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: Buffer.from(`{"i":${i}}`),
  }, {
    status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":{"message":"prompt flagged for usage policy"}}'),
  }, Object.assign(new Error('HTTP 400'), { access_token: 'secret' }));
}

test('policy flight recorder detects provider denial text', () => {
  assert.equal(isPolicyDenial(new Error('prompt was flagged as potentially violating our usage policy')), true);
  assert.equal(isPolicyDenial(new Error('rate limited')), false);
});

test('policy flight recorder strips secret transport headers', () => {
  const headers = new Headers({ authorization: 'Bearer secret', cookie: 'x=y', 'chatgpt-account-id': 'secret-account', 'session_id': 'keep-me', 'content-type': 'application/json' });
  assert.deepEqual(nonSecretHeaders(headers), { 'content-type': 'application/json', session_id: 'keep-me' });
});

test('policy flight recorder writes replayable exact-byte bundle', () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-policy-flight-'));
  const record = capture(dataDirectory);
  assert.ok(record);
  const manifest = JSON.parse(fs.readFileSync(record.manifestPath, 'utf8'));
  assert.equal(fs.readFileSync(path.join(record.directory, manifest.request.bodyFile), 'utf8'), '{"i":0}');
  assert.match(fs.readFileSync(path.join(record.directory, manifest.response.bodyFile), 'utf8'), /flagged/);
  assert.equal(manifest.request.headers.authorization, undefined);
  assert.equal(manifest.error.access_token, '[redacted]');
  assert.match(manifest.replay.command, /replay-policy-denial/);
  assert.equal(fs.statSync(record.directory).mode & 0o777, 0o700);
  for (const name of ['manifest.json', 'request-body.bin', 'response-body.bin']) assert.equal(fs.statSync(path.join(record.directory, name)).mode & 0o777, 0o600);
});

test('policy flight recorder retains every bundle from the last seven days and prunes older bundles', () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-policy-retain-'));
  for (let i = 0; i < 12; i++) capture(dataDirectory, i);
  const root = path.join(dataDirectory, 'private', 'policy-denials');
  const recent = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.equal(recent.length, 12, 'no count ceiling within the retention window');
  const oldest = path.join(root, recent[0].name, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(oldest, 'utf8'));
  manifest.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(oldest, JSON.stringify(manifest));
  capture(dataDirectory, 99);
  assert.equal(fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, 12, 'one expired bundle pruned and one new bundle added');
});
