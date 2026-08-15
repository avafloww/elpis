import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateOutcome, recipientSatisfied, targetChannelSatisfied } from '../bench/outcome.js';
import { parseScenario, SCHEMA_VERSION, type ScenarioSpec } from '../bench/schema.js';

function scenario(expected: ScenarioSpec['expected'], inputAuthor?: string): ScenarioSpec {
  return parseScenario({
    schemaVersion: SCHEMA_VERSION,
    id: 'tool/test-outcome',
    revision: 1,
    locked: false,
    category: 'tool',
    title: 'test',
    prompt: 'test',
    difficulty: 'ordinary',
    maxDispatches: 4,
    maxWallMs: 1000,
    fixture: { channels: { general: '100', ops: '101' }, files: {}, directories: [], heartbeat: false, ...(inputAuthor ? { inputAuthor } : {}) },
    expected,
    judgeCriteria: [],
  });
}

function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-outcome-')); }

test('target channels require delivery and enforce exclusivity only when declared', () => {
  const sends = [{ channelId: '100', text: 'working' }, { channelId: '101', text: 'result' }];
  assert.equal(targetChannelSatisfied('101', false, 'required', sends), true);
  assert.equal(targetChannelSatisfied('101', true, 'required', sends), false);
  assert.equal(targetChannelSatisfied('102', false, 'required', sends), false);
  assert.equal(targetChannelSatisfied('101', false, 'optional', []), true);
  assert.equal(targetChannelSatisfied('101', false, 'optional', [{ channelId: '100', text: 'oops' }]), false);
  assert.equal(targetChannelSatisfied(undefined, false, 'required', sends), true);
});

test('recipient targeting distinguishes direct replies from third-party delivery', () => {
  assert.equal(recipientSatisfied('Jo', 'Jo', 'required', [{ channelId: '100', text: '4817' }]), true);
  assert.equal(recipientSatisfied('Mira', undefined, 'required', [{ channelId: '100', text: 'The answer is 42.' }]), false);
  assert.equal(recipientSatisfied('Mira', undefined, 'required', [{ channelId: '100', text: 'Mira, the answer is 42.' }]), true);
});

test('required JSON outcome stays false after a read and becomes true only after valid equivalent repair', () => {
  const root = temp();
  fs.writeFileSync(path.join(root, 'settings.json'), '{"enabled":true,}\n');
  const spec = scenario({ outcome: 'valid JSON', workPaths: ['settings.json'], action: 'required', checks: [{ kind: 'json-equals', path: 'settings.json', value: { enabled: true } }] });
  assert.equal(evaluateOutcome(spec, root, [], true).ok, false);
  fs.writeFileSync(path.join(root, 'settings.json'), '{\n  "enabled": true\n}\n');
  assert.equal(evaluateOutcome(spec, root, [], true).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('required targeted outcome needs the right channel, recipient, and content predicate', () => {
  const root = temp();
  const spec = scenario({ outcome: 'count delivered', targetChannel: 'ops', targetRecipient: 'Mira', workPaths: [], action: 'required', checks: [{ kind: 'send-includes', values: ['12'] }] });
  assert.equal(evaluateOutcome(spec, root, [{ channelId: '100', text: '@Mira 12' }], true).ok, false);
  assert.equal(evaluateOutcome(spec, root, [{ channelId: '101', text: '@Mira counted it' }], true).ok, false);
  assert.equal(evaluateOutcome(spec, root, [{ channelId: '101', text: '12' }], true).ok, false);
  assert.equal(evaluateOutcome(spec, root, [{ channelId: '101', text: '@Mira: 12 lines' }], true).ok, true);
  const direct = scenario({ outcome: 'port delivered', targetChannel: 'ops', targetRecipient: 'Jo', workPaths: [], action: 'required', checks: [{ kind: 'send-includes', values: ['4817'] }] }, 'Jo');
  assert.equal(evaluateOutcome(direct, root, [{ channelId: '101', text: '4817' }], true).ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('file, absence, and recursive directory predicates are deterministic', () => {
  const root = temp();
  fs.mkdirSync(path.join(root, 'build/nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(root, 'build/nested/result.txt'), 'done\n');
  const spec = scenario({ outcome: 'tree exact', workPaths: ['build'], action: 'required', checks: [
    { kind: 'file-equals', path: 'build/keep.txt', content: 'keep\n' },
    { kind: 'path-absent', path: 'build/remove.tmp' },
    { kind: 'dir-files', path: 'build', files: ['keep.txt', 'nested/result.txt'] },
  ] });
  assert.equal(evaluateOutcome(spec, root, [], true).ok, true);
  fs.writeFileSync(path.join(root, 'build/extra.txt'), 'extra\n');
  assert.equal(evaluateOutcome(spec, root, [], true).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('required work never passes without an action or without checks when there is no target', () => {
  const root = temp();
  const checked = scenario({ outcome: 'done', workPaths: ['x'], action: 'required', checks: [{ kind: 'path-absent', path: 'x' }] });
  const unchecked = scenario({ outcome: 'done', workPaths: [], action: 'required', checks: [] });
  assert.equal(evaluateOutcome(checked, root, [], false).ok, false);
  assert.equal(evaluateOutcome(unchecked, root, [], true).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('outcome predicates reject paths outside the episode root', () => {
  const root = temp();
  const spec = scenario({ outcome: 'escape', workPaths: [], action: 'required', checks: [{ kind: 'path-absent', path: '../outside' }] });
  assert.throws(() => evaluateOutcome(spec, root, [], true), /escapes work directory/);
  fs.rmSync(root, { recursive: true, force: true });
});
