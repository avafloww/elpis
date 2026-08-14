import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LOCKED_SCENARIOS, lockedByCategory } from '../bench/scenarios.js';
import { scenarioSpecSchema } from '../bench/schema.js';

test('locked suite has exactly the reviewed 16/12/12/8 distribution', () => {
  assert.equal(LOCKED_SCENARIOS.length, 48);
  assert.equal(lockedByCategory('tool').length, 16);
  assert.equal(lockedByCategory('proactivity').length, 12);
  assert.equal(lockedByCategory('social').length, 12);
  assert.equal(lockedByCategory('protocol').length, 8);
  for (const scenario of LOCKED_SCENARIOS) assert.equal(scenarioSpecSchema.parse(scenario).locked, true);
});

test('proactivity scenarios are actionable/no-action pairs', () => {
  const pairs = new Map<string, string[]>();
  for (const s of lockedByCategory('proactivity')) (pairs.get(s.pairId!) ?? (pairs.set(s.pairId!, []), pairs.get(s.pairId!)!)).push(s.expected.action);
  assert.equal(pairs.size, 6);
  for (const actions of pairs.values()) assert.deepEqual(actions.sort(), ['forbidden','required']);
});

test('direct social senders are explicit without weakening third-party delivery', () => {
  const byId = new Map(LOCKED_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  assert.equal(byId.get('social/concise-answer')?.fixture.inputAuthor, 'Jo');
  assert.equal(byId.get('social/no-performative-status')?.fixture.inputAuthor, 'Dev');
  assert.equal(byId.get('social/uncertainty')?.fixture.inputAuthor, 'Pat');
  assert.equal(byId.get('proactivity/action-followup')?.fixture.inputAuthor, undefined);
  assert.equal(byId.get('social/bad-news')?.fixture.inputAuthor, undefined);
});

test('revision 3 exposes exact constraints and limits channel exclusivity', () => {
  assert.ok(LOCKED_SCENARIOS.every((scenario) => scenario.revision === 3));
  const exclusive = LOCKED_SCENARIOS.filter((scenario) => scenario.expected.exclusiveTarget).map((scenario) => scenario.id);
  assert.deepEqual(exclusive, ['social/channel-calibration']);
  const byId = new Map(LOCKED_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  assert.match(byId.get('tool/read-edit-verify')?.prompt ?? '', /trailing newline/);
  assert.match(byId.get('tool/restart-continuity')?.prompt ?? '', /plus a newline/);
  assert.match(byId.get('proactivity/action-stale-task')?.prompt ?? '', /changing only its checkbox/);
  assert.match(byId.get('protocol/missing-end')?.prompt ?? '', /value\.txt/);
  const correction = byId.get('social/correction')?.expected.checks[0];
  const uncertainty = byId.get('social/uncertainty')?.expected.checks[0];
  assert.deepEqual(correction, { kind: 'send-includes', values: ['2026-09-14', 'September 14, 2026'], match: 'any' });
  assert.deepEqual(uncertainty, { kind: 'send-includes', values: ['inconclusive', 'insufficient', 'do not establish', 'cannot conclude', 'not enough evidence'], match: 'any' });
});

test('locked required outcomes are deterministic and target destinations are candidate-visible', () => {
  for (const scenario of LOCKED_SCENARIOS) {
    const target = scenario.expected.targetChannel;
    const input = scenario.fixture.inputChannel;
    if (scenario.expected.action === 'required' && !target) assert.ok(scenario.expected.checks.length > 0, scenario.id);
    if (target && (scenario.fixture.heartbeat || input !== target)) assert.match(scenario.prompt.toLocaleLowerCase(), new RegExp(`#${target.toLocaleLowerCase()}\\b`), scenario.id);
  }
});

test('locked fixture, work, and outcome paths remain inside the episode work directory', () => {
  const safe = (value: string) => !path.isAbsolute(value) && !path.normalize(value).split(path.sep).includes('..');
  for (const scenario of LOCKED_SCENARIOS) {
    for (const value of [...Object.keys(scenario.fixture.files), ...scenario.fixture.directories, ...scenario.expected.workPaths]) assert.ok(safe(value), `${scenario.id}: ${value}`);
    for (const check of scenario.expected.checks) if ('path' in check) assert.ok(safe(check.path), `${scenario.id}: ${check.path}`);
  }
});
