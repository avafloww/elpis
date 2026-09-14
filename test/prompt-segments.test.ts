import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, segmentSystemPrompt } from '../src/llm/prompt.js';

const inputs = {
  soul: 'SOUL_BODY_MARKER_XYZ',
  memory: 'MEMORY_MARKER_XYZ',
  now: 'NOW_MARKER_XYZ',
  harnessRoot: '/HR',
  dataDirectory: '/DD',
  guildCount: 1,
};

test('segmentSystemPrompt: three tiers, SOUL relocated to the tail', () => {
  const full = build(inputs);
  const segs = segmentSystemPrompt(full);
  assert.equal(segs.length, 3);
  assert.deepEqual(
    segs.map((s) => s.tier),
    ['stable', 'boundary', 'perturn'],
  );

  // Soul content lives ONLY in the perturn (last) tier.
  assert.ok(segs[2].text.includes('SOUL_BODY_MARKER_XYZ'));
  assert.ok(!segs[0].text.includes('SOUL_BODY_MARKER_XYZ'));
  assert.ok(!segs[1].text.includes('SOUL_BODY_MARKER_XYZ'));
  assert.ok(segs[2].text.startsWith('## Your soul'));

  // Boundary views (memory/state/focus) live in the boundary tier; person
  // profiles are ordinary history messages and never enter the system string.
  assert.ok(segs[1].text.startsWith('## Current memory'));
  assert.ok(segs[1].text.includes('MEMORY_MARKER_XYZ'));

  // Stable tier carries the static bulk (tool docs) and no volatile content.
  assert.ok(segs[0].text.includes('## Output contract'));
  assert.ok(segs[0].text.includes('## Tools'));
  assert.ok(!segs[0].text.includes('MEMORY_MARKER_XYZ'));
});

test('build: catalogs skills and explains the dedicated context-load round', () => {
  const full = build({
    ...inputs,
    skills: [
      {
        name: 'release-check',
        description: 'Verify a candidate before publication',
        path: '/catalog/path-must-not-render/SKILL.md',
      },
    ],
  });
  assert.match(full, /`release-check`: Verify a candidate before publication/);
  assert.match(full, /skill call must be the only tool call/i);
  assert.match(full, /Catching the interruption cannot approve it/);
  assert.doesNotMatch(full, /catalog\/path-must-not-render/);
});

test('segmentSystemPrompt preserves the entire assembled prompt', () => {
  const full = build(inputs);
  assert.equal(
    segmentSystemPrompt(full)
      .map((segment) => segment.text)
      .join('\n\n'),
    full,
  );
});

test('identity and memory updates leave unrelated cache tiers unchanged', () => {
  const before = segmentSystemPrompt(build(inputs));
  const soulChanged = segmentSystemPrompt(
    build({ ...inputs, soul: 'RELOADED_SOUL' }),
  );
  assert.deepEqual(soulChanged.slice(0, 2), before.slice(0, 2));
  assert.match(soulChanged[2].text, /RELOADED_SOUL/);
  assert.doesNotMatch(soulChanged[2].text, /SOUL_BODY_MARKER_XYZ/);
  const memoryChanged = segmentSystemPrompt(
    build({ ...inputs, memory: 'RELOADED_MEMORY' }),
  );
  assert.deepEqual(memoryChanged[0], before[0]);
  assert.deepEqual(memoryChanged[2], before[2]);
  assert.match(memoryChanged[1].text, /RELOADED_MEMORY/);
  assert.doesNotMatch(memoryChanged[1].text, /MEMORY_MARKER_XYZ/);
});

test('segmentSystemPrompt: degrades to a single stable block when markers are absent', () => {
  const segs = segmentSystemPrompt(
    'a prompt with none of the expected headings',
  );
  assert.deepEqual(segs, [
    { tier: 'stable', text: 'a prompt with none of the expected headings' },
  ]);
});
