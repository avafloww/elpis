// Unit tests for participant-scoped people/ injection into the system prompt
//, plus the prefix-cache stability guarantees the section
// has to hold (the missing-file note and the render order must not move
// between turns — see the prefix-cache header in src/prompt.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPeopleSection, loadPeopleFiles, build } from '../src/llm/prompt.js';

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-inject-'));
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  return dir;
}

function writePerson(dir: string, slug: string, ids: string[], facts: string): void {
  const idsStr = ids.length ? `[${ids.join(', ')}]` : '[]';
  fs.writeFileSync(
    path.join(dir, 'people', `${slug}.md`),
    `---\nname: ${slug}\nids: ${idsStr}\n---\n\n- [2026-07-02] ${facts}\n`,
  );
}

/** The agent's boundary view: load once, then render per turn. */
const section = (dir: string, participants: Array<{ authorId: string; author: string }>): string =>
  buildPeopleSection(loadPeopleFiles(dir), participants);

test('people-injection: injects a participant file matched by frontmatter id', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'wants identity in herself');
  writePerson(dir, 'rowan', ['discord:222'], 'unrelated person');
  const s = section(dir, [{ authorId: '111', author: 'Bramble' }]);
  assert.match(s, /people\/bramble\.md/);
  assert.match(s, /wants identity in herself/);
 // rowan is not a participant → not injected
  assert.doesNotMatch(s, /people\/rowan\.md/);
});

test('people-injection: falls back to slug match when no id matches', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'clover', [], 'puppygirl headmate');
  const s = section(dir, [{ authorId: '999', author: 'Clover' }]);
  assert.match(s, /people\/clover\.md/);
  assert.match(s, /puppygirl headmate/);
});

test('people-injection: participants with no file are named in the note', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'known person');
  const s = section(dir, [{ authorId: '333', author: 'New Person' }]);
  assert.match(s, /no people\/ file yet for: new-person/);
  assert.match(s, /memory\.person\('new-person'/);
});

test('people-injection: the note is slug-sorted and stable regardless of who spoke last', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'known person');
  const files = loadPeopleFiles(dir);
 // Same participant SET, different most-recent speaker (what the agent's
 // lastSeenAt sort produces on alternating turns). This used to flip the note
 // on and off and rewrite the whole cached prefix.
  const clover = { authorId: '1', author: 'Clover' };
  const abe = { authorId: '2', author: 'Abe' };
  const bramble = { authorId: '111', author: 'Bramble' };
  const a = buildPeopleSection(files, [clover, abe, bramble]);
  const b = buildPeopleSection(files, [abe, bramble, clover]);
  const c = buildPeopleSection(files, [bramble, clover, abe]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.match(a, /no people\/ file yet for: abe, clover/);
});

test('people-injection: a heartbeat renders the same section as a user turn', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'known person');
  const files = loadPeopleFiles(dir);
  const participants = [{ authorId: '111', author: 'Bramble' }, { authorId: '2', author: 'Abe' }];
 // Heartbeats have no current speaker; the section must not change for it.
  assert.equal(buildPeopleSection(files, participants), buildPeopleSection(files, participants));
  assert.match(buildPeopleSection(files, participants), /no people\/ file yet for: abe/);
});

test('people-injection: caps total content, newest-modified wins', () => {
  const dir = tmpDataDir();
  const big = 'x'.repeat(3000);
 // Two participants both with big files; only the newest fits under the 4k cap.
  writePerson(dir, 'older', ['discord:1'], big);
  writePerson(dir, 'newer', ['discord:2'], big);
  const now = Date.now();
  fs.utimesSync(path.join(dir, 'people', 'older.md'), new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(path.join(dir, 'people', 'newer.md'), new Date(now), new Date(now));
  const s = section(dir, [{ authorId: '1', author: 'older' }, { authorId: '2', author: 'newer' }]);
  assert.match(s, /people\/newer\.md/);
  assert.doesNotMatch(s, /people\/older\.md/);
  assert.match(s, /omitted to bound prompt size/);
});

test('people-injection: blocks render slug-sorted, not mtime-sorted', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'abe', ['discord:1'], 'a');
  writePerson(dir, 'clover', ['discord:2'], 'z');
 // Make clover the newest — selection order, but NOT render order.
  const now = Date.now();
  fs.utimesSync(path.join(dir, 'people', 'abe.md'), new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(path.join(dir, 'people', 'clover.md'), new Date(now), new Date(now));
  const s = section(dir, [{ authorId: '1', author: 'abe' }, { authorId: '2', author: 'clover' }]);
  assert.ok(s.indexOf('people/abe.md') < s.indexOf('people/clover.md'), 'blocks should be slug-sorted');
});

test('people-injection: no participants degrades to injecting every file', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'a');
  writePerson(dir, 'rowan', ['discord:222'], 'b');
  const s = section(dir, []);
  assert.match(s, /people\/bramble\.md/);
  assert.match(s, /people\/rowan\.md/);
});

test('people-injection: build() embeds the People here section', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'a durable fact');
  const prompt = build({
    soul: '', memory: '', now: '', harnessRoot: '/x', dataDirectory: dir,
    participants: [{ authorId: '111', author: 'Bramble' }],
    peopleFiles: loadPeopleFiles(dir),
  });
  assert.match(prompt, /## People here/);
  assert.match(prompt, /a durable fact/);
});

test('people-injection: build() is byte-stable across turns for a fixed snapshot', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'a durable fact');
  const files = loadPeopleFiles(dir);
  const inputs = {
    soul: '# soul\n', memory: 'mem', now: 'focus', state: { mood: 'ok' },
    harnessRoot: '/x', dataDirectory: dir, peopleFiles: files,
  };
  const turnA = build({ ...inputs, participants: [{ authorId: '111', author: 'Bramble' }, { authorId: '2', author: 'Abe' }] });
  const turnB = build({ ...inputs, participants: [{ authorId: '2', author: 'Abe' }, { authorId: '111', author: 'Bramble' }] });
  assert.equal(turnA, turnB, 'system prompt must not move when only speaker order changes');
});
