import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildTestAgent } from './helpers.js';

test('shared test agents wire production read surfaces and persist Mind in SQLite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-parity-'));
  const first = buildTestAgent({ dir: root });
  const created = await first.sandbox.run(
    "elpis.channel('100').typing(); if (!Array.isArray(elpis.schedule.list())) throw new Error('schedule list unavailable'); elpis.mind.add({ title: 'survives rebuild' })",
  );
  assert.equal(created.ok, true);
  assert.equal(
    first.mind.list().some((item) => item.title === 'survives rebuild'),
    true,
  );
  first.agent.stop();
  first.scheduler.stop();
  first.db.close();

  const second = buildTestAgent({ dir: root });
  assert.equal(
    second.mind.list().some((item) => item.title === 'survives rebuild'),
    true,
  );
  const reads = await second.sandbox.run(
    '({ tasks: elpis.schedule.list().length, ready: elpis.mind.ready().length })',
  );
  assert.equal(reads.ok, true);
  second.agent.stop();
  second.scheduler.stop();
  second.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
