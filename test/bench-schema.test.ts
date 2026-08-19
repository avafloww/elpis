import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VALIDATED_SCENARIOS } from '../bench/scenarios.js';
import { parseScenario, SCHEMA_VERSION } from '../bench/schema.js';
import { resolveCandidateIngress, resolveCandidateIngressBatch } from '../bench/ingress.js';
import { formatInboundEnvelope } from '../src/lib/envelope.js';

const base = {
  schemaVersion: SCHEMA_VERSION,
  id: 'tool/schema-test',
  revision: 1,
  locked: false,
  category: 'tool' as const,
  title: 'host-only-marker',
  prompt: 'host-only-description-marker',
  difficulty: 'ordinary' as const,
  maxDispatches: 4,
  maxWallMs: 1000,
  fixture: { channels: { general: '100', parent: '101' }, files: {}, directories: [], heartbeat: false, clockAt: '2026-01-01T00:00:00.000Z' },
  expected: { outcome: 'host-only-outcome-marker', workPaths: [], action: 'optional' as const, checks: [] },
  judgeCriteria: [],
};

test('public ElpisBench ships no runnable scored corpus', () => {
  assert.deepEqual(VALIDATED_SCENARIOS, []);
});

test('production scenarios require explicit candidate ingress', () => {
  assert.throws(() => parseScenario({ ...base, track: 'production' }), /exactly one of ingress or ingressBatch/);
});

test('candidate ingress contains only declared production information', () => {
  const scenario = parseScenario({ ...base, track: 'production', ingress: { kind: 'discord', channel: 'general', author: 'person', content: 'ordinary message' } });
  const ingress = resolveCandidateIngress(scenario, false);
  assert.equal(ingress.content, 'ordinary message');
  const wire = JSON.stringify(ingress);
  assert.doesNotMatch(wire, /host-only-(?:marker|description|outcome)/);
  assert.doesNotMatch(wire, /benchmark|evaluation|scenario/i);
});

test('production heartbeat ingress is the irreducible live wake', () => {
  const scenario = parseScenario({ ...base, track: 'production', ingress: { kind: 'heartbeat' } });
  const ingress = resolveCandidateIngress(scenario, false);
  assert.equal(ingress.content, '[heartbeat]');
  assert.equal(ingress.createdAt, '2026-01-01T00:00:00.000Z');
});

test('production ingress requires a deterministic clock', () => {
  const fixture = { ...base.fixture } as Record<string, unknown>;
  delete fixture.clockAt;
  assert.throws(() => parseScenario({ ...base, fixture, track: 'production', ingress: { kind: 'heartbeat' } }), /production ingress requires deterministic clockAt/);
});

test('full Discord ingress and its harness wake resolve as one ordered production batch', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elpisbench-ingress-'));
  try {
    fs.mkdirSync(path.join(work, 'attachments'));
    fs.writeFileSync(path.join(work, 'attachments', 'frame.png'), Buffer.from([1, 2, 3, 4]));
    const scenario = parseScenario({
      ...base,
      track: 'production',
      ingressBatch: [
        {
          kind: 'discord', id: 'message-1', atOffsetMs: 0,
          channel: 'general', channelName: 'chat', policyChannel: 'parent',
          author: 'person', authorId: '200', guildSlug: 'social', bot: false, wakeClass: 'ambient',
          content: 'ordinary message',
          replyTo: { id: 'reply-1', author: 'other', authorId: '201', content: 'earlier message' },
          forwarded: { author: 'source', channelName: 'elsewhere', content: 'forwarded text' },
          mentions: ['@other'],
          attachments: [{ path: 'attachments/frame.png', url: 'https://cdn.invalid/frame.png', contentType: 'image/png' }],
        },
        { kind: 'harness', id: 'tick-1', atOffsetMs: 60_000, content: '[room context — 1 message]', sendScope: 'observe_only' },
      ],
    });
    const batch = resolveCandidateIngressBatch(scenario, false, work);
    assert.equal(batch.length, 2);
    assert.deepEqual(batch[0], {
      id: 'message-1', channelId: '100', channelName: 'chat', author: 'person', authorId: '200',
      content: 'ordinary message', createdAt: '2026-01-01T00:00:00.000Z',
      replyTo: { id: 'reply-1', author: 'other', authorId: '201', content: 'earlier message' },
      forwarded: { author: 'source', channelName: 'elsewhere', content: 'forwarded text' },
      mentions: ['@other'],
      attachments: [{ url: 'https://cdn.invalid/frame.png', name: 'frame.png', contentType: 'image/png', localPath: path.join(work, 'attachments', 'frame.png'), size: 4 }],
      guildId: 'workspace-guild', guildSlug: 'social', bot: false, wakeClass: 'ambient', policyChannelId: '101', kind: 'discord',
    });
    assert.equal(batch[1].createdAt, '2026-01-01T00:01:00.000Z');
    assert.equal(batch[1].kind, 'harness');
    assert.equal(batch[1].sendScope, 'observe_only');
    assert.equal(formatInboundEnvelope(batch[0], '[00:00]'), [
      '<incoming-message guild="social" channel="chat" author="person" bot="false" time="2026-01-01T00:00:00.000Z" local-time="00:00">',
      '  <reply-to id="reply-1" author="other">earlier message</reply-to>',
      '  <forwarded-from channel="elsewhere" author="source">forwarded text</forwarded-from>',
      '  <mentions>@other</mentions>',
      `  attachment#1: frame.png (image/png, 4 bytes) -> ${path.join(work, 'attachments', 'frame.png')}`,
      'ordinary message',
      '</incoming-message>',
    ].join('\n'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('scheduler and restart ingress preserve their production channels and phase timestamps', () => {
  const scenario = parseScenario({
    ...base, track: 'production', fixture: { ...base.fixture, restartAtDispatch: 1 },
    ingress: { kind: 'scheduler', id: 'scheduled-1', channel: 'general', content: '[scheduled task] review' },
    resumeIngress: { kind: 'harness', id: 'resume-1', atOffsetMs: 5_000, content: '[restart complete] continue' },
  });
  const scheduler = resolveCandidateIngress(scenario, false);
  assert.equal(scheduler.channelId, '100');
  assert.equal(scheduler.channelName, 'scheduler');
  assert.equal(scheduler.author, 'scheduler');
  const resume = resolveCandidateIngress(scenario, true);
  assert.equal(resume.id, 'resume-1');
  assert.equal(resume.kind, 'harness');
  assert.equal(resume.createdAt, '2026-01-01T00:00:05.000Z');
});

test('restart and wake lifecycle validation rejects incomplete or inert batches', () => {
  assert.throws(() => parseScenario({
    ...base, track: 'production', fixture: { ...base.fixture, restartAtDispatch: 1 }, ingress: { kind: 'heartbeat' },
  }), /production restart requires exactly one of resumeIngress or resumeIngressBatch/);
  assert.throws(() => parseScenario({
    ...base, track: 'production', ingress: { kind: 'heartbeat' }, resumeIngress: { kind: 'harness', content: 'unused' },
  }), /resume ingress requires restartAtDispatch/);
  assert.throws(() => parseScenario({
    ...base, track: 'production', ingressBatch: [
      { kind: 'discord', channel: 'general', author: 'a', content: 'one', wakeClass: 'ambient' },
      { kind: 'discord', channel: 'general', author: 'b', content: 'two', wakeClass: 'ambient' },
    ],
  }), /ingress batch must contain an event that wakes the agent/);
  assert.throws(() => parseScenario({
    ...base, track: 'production', ingressBatch: [
      { kind: 'discord', id: 'same', channel: 'general', author: 'a', content: 'one' },
      { kind: 'harness', id: 'same', content: 'wake' },
    ],
  }), /ingress event ids must be unique/);
});

test('ingress batches reject reversed offsets and ambiguous singular-plus-batch declarations', () => {
  assert.throws(() => parseScenario({
    ...base, track: 'production', ingressBatch: [
      { kind: 'heartbeat', atOffsetMs: 2 },
      { kind: 'harness', content: 'later in the array', atOffsetMs: 1 },
    ],
  }), /ingress batch offsets must be nondecreasing/);
  assert.throws(() => parseScenario({
    ...base, track: 'production', ingress: { kind: 'heartbeat' }, ingressBatch: [{ kind: 'heartbeat' }],
  }), /exactly one of ingress or ingressBatch/);
});

test('sandbox fixture seeds reject unknown, closed, and duplicate Mind bindings', () => {
  const mind = [
    { key: 'workspace', title: 'Workspace', status: 'in_progress' },
    { key: 'closed', title: 'Closed', status: 'done' },
  ];
  const scenario = (sandboxes: unknown[]) => ({
    ...base,
    fixture: { ...base.fixture, mind, sandboxes },
  });
  assert.throws(() => parseScenario(scenario([{ mindKey: 'missing', alias: 'quiet-ready-workspace' }])), /unknown Mind seed key missing/);
  assert.throws(() => parseScenario(scenario([{ mindKey: 'closed', alias: 'quiet-ready-workspace' }])), /sandbox Mind seed closed is closed/);
  assert.throws(() => parseScenario(scenario([
    { mindKey: 'workspace', alias: 'quiet-ready-workspace' },
    { mindKey: 'workspace', alias: 'other-ready-workspace' },
  ])), /duplicate sandbox Mind seed workspace/);
  assert.throws(() => parseScenario(scenario([
    { mindKey: 'workspace', alias: 'quiet-ready-workspace' },
    { mindKey: 'closed', alias: 'quiet-ready-workspace' },
  ])), /duplicate sandbox alias quiet-ready-workspace/);
});

test('current production fixture rejects multiple Discord guild slugs rather than collapsing server walls', () => {
  assert.throws(() => parseScenario({
    ...base, track: 'production', ingressBatch: [
      { kind: 'discord', channel: 'general', author: 'a', guildSlug: 'one', content: 'first' },
      { kind: 'discord', channel: 'general', author: 'b', guildSlug: 'two', content: 'second' },
    ],
  }), /supports exactly one Discord guild slug/);
});

test('attachment resolution refuses traversal and symlink escape from the seeded world', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elpisbench-ingress-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'elpisbench-ingress-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
    const withAttachment = (attachmentPath: string) => parseScenario({
      ...base, track: 'production',
      ingress: { kind: 'discord', channel: 'general', author: 'person', content: 'file', attachments: [{ path: attachmentPath }] },
    });
    assert.throws(() => resolveCandidateIngress(withAttachment('../outside.txt'), false, work), /escapes work directory/);
    assert.throws(() => resolveCandidateIngress(withAttachment('link.txt'), false, work), /through symlink/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
