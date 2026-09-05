import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, segmentSystemPrompt } from '../src/llm/prompt.js';
import { RUN_TOOL } from '../src/llm/llm.js';

const inputs = {
  soul: 'SOUL_BODY_MARKER_XYZ',
  memory: 'MEMORY_MARKER_XYZ',
  now: 'NOW_MARKER_XYZ',
  harnessRoot: '/HR',
  dataDirectory: '/DD',
  guildCount: 1,
};

test('build: sandbox documentation distinguishes ephemeral core from persistent full scope', () => {
  const full = build(inputs);
  assert.ok(
    full.includes(
      'Omitting `sandbox` creates a fresh core-only ephemeral sandbox',
    ),
  );
  assert.ok(
    full.includes(
      'Only calls selecting the same persistent sandbox share JavaScript variables',
    ),
  );
  assert.ok(full.includes('Core ephemeral runs have no `_`'));
  assert.ok(
    full.includes(
      'Reading files (including reloading AGENTS.md) needs a full sandbox',
    ),
  );
  assert.ok(
    !full.includes('executes JavaScript in a PERSISTENT sandbox that survives'),
  );
  assert.ok(
    !full.includes('Sandbox variables are shared between `run` calls.'),
  );
  assert.match(
    RUN_TOOL.function.parameters.properties.sandbox.description,
    /Mind id, unique prefix, or exact title/,
  );
});

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
  assert.ok(!full.includes('CLOVER_FACTS_XYZ'));

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

test('segmentSystemPrompt: no content is lost (every non-marker line survives)', () => {
  const full = build(inputs);
  const segs = segmentSystemPrompt(full);
  // Concatenating tiers reproduces every marker line (order differs — SOUL moved).
  for (const marker of [
    'SOUL_BODY_MARKER_XYZ',
    'MEMORY_MARKER_XYZ',
    'NOW_MARKER_XYZ',
    '## Output contract',
    '## Your Environment',
  ]) {
    assert.ok(
      segs.some((s) => s.text.includes(marker)),
      `missing: ${marker}`,
    );
  }
});

test('segmentSystemPrompt: degrades to a single stable block when markers are absent', () => {
  const segs = segmentSystemPrompt(
    'a prompt with none of the expected headings',
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0].tier, 'stable');
});
