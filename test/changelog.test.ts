// Unit tests for the harness changelog notice (changelogs/ dir → boot-time
// [harness updated] pointer message + .changelog-seen.json seen-set).
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readUnseenChangelogs, formatChangelogNotice, markChangelogsSeen } from '../src/store/changelog.js';
import { buildTestAgent, EMPTY_WAKE } from './helpers.js';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `harness-${prefix}-`));

/** Build a fake harness root with a changelogs/ dir containing the given files. */
function harnessWith(files: Record<string, string>): string {
  const root = tmp('changelog-root');
  fs.mkdirSync(path.join(root, 'changelogs'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'changelogs', name), body);
  }
  return root;
}

test('changelog: fresh data dir sees every entry, sorted by filename', () => {
  const root = harnessWith({
    '2026-07-12-b-second.md': 'second',
    '2026-07-11-a-first.md': 'first',
  });
  const unseen = readUnseenChangelogs(root, tmp('changelog-data'));
  assert.deepEqual(unseen, ['2026-07-11-a-first.md', '2026-07-12-b-second.md']);
});

test('changelog: marked-seen entries are not returned again', () => {
  const root = harnessWith({ 'a.md': 'a', 'b.md': 'b' });
  const dataDir = tmp('changelog-data');
  markChangelogsSeen(dataDir, ['a.md']);
  assert.deepEqual(readUnseenChangelogs(root, dataDir), ['b.md']);
});

test('changelog: markChangelogsSeen appends to prior seen-set', () => {
  const root = harnessWith({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
  const dataDir = tmp('changelog-data');
  markChangelogsSeen(dataDir, ['a.md']);
  markChangelogsSeen(dataDir, ['b.md']);
  assert.deepEqual(readUnseenChangelogs(root, dataDir), ['c.md']);
});

test('changelog: a backdated entry (sorts before seen ones) is still delivered', () => {
  const root = harnessWith({ '2026-07-12-later.md': 'x' });
  const dataDir = tmp('changelog-data');
  markChangelogsSeen(dataDir, ['2026-07-12-later.md']);
  fs.writeFileSync(path.join(root, 'changelogs', '2026-07-10-backdated.md'), 'y');
  assert.deepEqual(readUnseenChangelogs(root, dataDir), ['2026-07-10-backdated.md']);
});

test('changelog: missing changelogs/ dir returns [] without throwing', () => {
  assert.deepEqual(readUnseenChangelogs(tmp('changelog-empty-root'), tmp('changelog-data')), []);
});

test('changelog: non-md files are ignored', () => {
  const root = harnessWith({ 'a.md': 'a', 'README.txt': 'no', '.gitkeep': 'no' });
  assert.deepEqual(readUnseenChangelogs(root, tmp('changelog-data')), ['a.md']);
});

test('changelog: a corrupt seen file is treated as empty, not fatal', () => {
  const root = harnessWith({ 'a.md': 'a' });
  const dataDir = tmp('changelog-data');
  fs.mkdirSync(resolveDataLayout(dataDir).root, { recursive: true });
  fs.writeFileSync(resolveDataLayout(dataDir).changelogSeen, 'not json{{');
  assert.deepEqual(readUnseenChangelogs(root, dataDir), ['a.md']);
 // and marking seen over the corrupt file recovers it
  markChangelogsSeen(dataDir, ['a.md']);
  assert.deepEqual(readUnseenChangelogs(root, dataDir), []);
});

test('changelog: notice is a pointer — names every entry and shows the elpis.read() invocation', () => {
  const notice = formatChangelogNotice(['2026-07-12-changelog-system.md', '2026-07-13-x.md']);
  assert.match(notice, /^\[harness updated\]/);
  assert.match(notice, /2026-07-12-changelog-system\.md/);
  assert.match(notice, /2026-07-13-x\.md/);
  assert.match(notice, /read\(HARNESS_ROOT \+ '\/changelogs\/2026-07-12-changelog-system\.md'\)/);
});

// --- loop-level: delivery-time seen-marking -------------------------------
// Marking entries seen at enqueue time would create a silent, permanent loss
// window (a /clear, crash, or second restart while the notice is still queued
// drops it, but the seen-set already lists the entries). The contract is
// therefore: onDelivered fires only when the notice is actually pushed into
// history — never at enqueue.

test('changelog: onDelivered fires when the notice enters history, not at enqueue', async () => {
  const { promise: completed, resolve: signalDone } = Promise.withResolvers<void>();
  const llm = {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete(): Promise<CompleteResult> {
      queueMicrotask(signalDone);
      return Promise.resolve(EMPTY_WAKE);
    },
    summarize: () => Promise.resolve('SUMMARY'),
  } as LLM;
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-changelog-loop-' });
  try {
    let delivered = 0;
    agent.notifyHarnessChangelog('[harness updated] test notice', () => { delivered++; });
    assert.equal(delivered, 0, 'must NOT be marked delivered at enqueue');

    void agent.loop();
    await completed;

    assert.equal(delivered, 1, 'delivered exactly once, at drain time');
    const users = agent.messagesForTest.filter((m) => m.role === 'user');
    assert.ok(users.some((m) => m.content.includes('channel="harness"') && m.content.includes('[harness updated] test notice')),
      'the notice is in history with harness provenance');
    agent.stop();
  } finally {
    cleanup();
  }
});

test('changelog: a notice never drained is never marked delivered', () => {
  const { agent, cleanup } = buildTestAgent({ tmpPrefix: 'harness-changelog-undrained-' });
  try {
    let delivered = 0;
    agent.notifyHarnessChangelog('[harness updated] test notice', () => { delivered++; });
 // Loop never started — the boot died before the drain. The callback must
 // not have fired, so next boot re-delivers.
    assert.equal(delivered, 0);
    agent.stop();
  } finally {
    cleanup();
  }
});
