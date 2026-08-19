import { parseScenario, SCHEMA_VERSION, type Category, type ScenarioSpec } from '../bench/schema.js';

type FixtureOptions = {
  id?: string;
  category?: Category;
  difficulty?: ScenarioSpec['difficulty'];
  prompt?: string;
  files?: Record<string, string>;
  expected?: Partial<ScenarioSpec['expected']>;
  restartAtDispatch?: number;
  track?: ScenarioSpec['track'];
  ingress?: ScenarioSpec['ingress'];
  ingressBatch?: ScenarioSpec['ingressBatch'];
  resumeIngress?: ScenarioSpec['resumeIngress'];
  resumeIngressBatch?: ScenarioSpec['resumeIngressBatch'];
  clockAt?: string;
  mind?: ScenarioSpec['fixture']['mind'];
  scheduler?: ScenarioSpec['fixture']['scheduler'];
  sandboxes?: ScenarioSpec['fixture']['sandboxes'];
};

export function engineTestScenario(options: FixtureOptions = {}): ScenarioSpec {
  return parseScenario({
    schemaVersion: SCHEMA_VERSION,
    id: options.id ?? 'tool/engine-test',
    revision: 1,
    locked: false,
    category: options.category ?? 'tool',
    title: 'engine-only fixture',
    prompt: options.prompt ?? 'write the requested test fixture',
    track: options.track ?? 'micro',
    ...(options.ingress ? { ingress: options.ingress } : {}),
    ...(options.ingressBatch ? { ingressBatch: options.ingressBatch } : {}),
    ...(options.resumeIngress ? { resumeIngress: options.resumeIngress } : {}),
    ...(options.resumeIngressBatch ? { resumeIngressBatch: options.resumeIngressBatch } : {}),
    difficulty: options.difficulty ?? 'ordinary',
    maxDispatches: 8,
    maxWallMs: 30_000,
    fixture: {
      channels: { general: '100', ops: '101' }, files: options.files ?? { 'result.txt': 'before\n' }, directories: [],
      clockAt: options.clockAt ?? '2026-01-02T03:04:05.000Z',
      mind: [
        { key: 'workspace', title: 'Engine workspace', kind: 'task', status: 'in_progress', priority: 1, body: '', parentKey: undefined, dependsOn: [], dueOffsetMs: null, tags: ['engine'] },
        ...(options.mind ?? []),
      ],
      scheduler: options.scheduler ?? [],
      sandboxes: options.sandboxes ?? [{ mindKey: 'workspace', alias: 'quiet-ready-workspace' }],
      inputChannel: 'general', heartbeat: false, ...(options.restartAtDispatch ? { restartAtDispatch: options.restartAtDispatch } : {}),
    },
    expected: {
      outcome: 'engine fixture reaches its typed result', workPaths: ['result.txt'], action: 'required',
      checks: [{ kind: 'file-equals', path: 'result.txt', content: 'done\n' }], ...options.expected,
    },
    judgeCriteria: [],
  });
}

export const ORDINARY_TEST_SCENARIO = engineTestScenario();
export const HARD_TEST_SCENARIO = engineTestScenario({ id: 'tool/engine-hard', difficulty: 'hard-recovery' });
export const SEEDED_HEARTBEAT_TEST_SCENARIO = engineTestScenario({
  id: 'proactivity/engine-seeded-heartbeat', category: 'proactivity', track: 'production', ingress: { kind: 'heartbeat' },
  clockAt: '2026-01-02T03:04:05.000Z',
  mind: [
    { key: 'project', title: 'Seeded project', kind: 'project', status: 'in_progress', priority: 1, body: '', parentKey: undefined, dependsOn: [], dueOffsetMs: null, tags: ['engine'] },
    { key: 'done', title: 'Finished prerequisite', kind: 'task', status: 'done', priority: 2, body: '', parentKey: 'project', dependsOn: [], dueOffsetMs: null, tags: [] },
    { key: 'ready', title: 'Ready leaf', kind: 'task', status: 'open', priority: 1, body: 'discover me from Mind', parentKey: 'project', dependsOn: ['done'], dueOffsetMs: 120_000, tags: ['ready'] },
    { key: 'blocked', title: 'Blocked leaf', kind: 'task', status: 'open', priority: 2, body: '', parentKey: 'project', dependsOn: ['ready'], dueOffsetMs: null, tags: [] },
  ],
  scheduler: [{ name: 'seeded-future-task', kind: 'custom', channel: 'ops', payload: '[seeded future wake]', nextRunOffsetMs: 60_000, intervalMs: null, nagIntervalMs: null }],
});
export const AMBIENT_BATCH_TEST_SCENARIO = engineTestScenario({
  id: 'social/engine-ambient-batch', category: 'social', track: 'production',
  clockAt: '2026-01-02T03:04:05.000Z',
  ingressBatch: [
    {
      kind: 'discord', id: 'ambient-message', channel: 'general', channelName: 'lounge',
      author: 'person', authorId: '200', guildSlug: 'workspace', bot: false, wakeClass: 'ambient',
      content: 'ordinary ambient message',
    },
    {
      kind: 'harness', id: 'ambient-tick', atOffsetMs: 60_000,
      content: '[room context — 1 message since 03:04, across workspace/lounge. This is what was said around you, not a set of requests.]',
      sendScope: 'observe_only',
    },
  ],
});

export const RESTART_TEST_SCENARIO = engineTestScenario({
  id: 'tool/engine-restart', restartAtDispatch: 1, files: { 'stage-one.txt': '', 'stage-two.txt': '' },
  expected: { outcome: 'restart engine fixture', workPaths: ['stage-one.txt', 'stage-two.txt'], checks: [
    { kind: 'file-equals', path: 'stage-one.txt', content: 'stage one\n' },
    { kind: 'file-equals', path: 'stage-two.txt', content: 'stage two\n' },
  ] },
});
