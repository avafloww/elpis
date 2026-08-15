import { parseScenario, SCHEMA_VERSION, type Category, type ScenarioSpec } from '../bench/schema.js';

type FixtureOptions = {
  id?: string;
  category?: Category;
  difficulty?: ScenarioSpec['difficulty'];
  prompt?: string;
  files?: Record<string, string>;
  expected?: Partial<ScenarioSpec['expected']>;
  restartAtDispatch?: number;
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
    difficulty: options.difficulty ?? 'ordinary',
    maxDispatches: 8,
    maxWallMs: 30_000,
    fixture: {
      channels: { general: '100', ops: '101' }, files: options.files ?? { 'result.txt': 'before\n' }, directories: [],
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
export const RESTART_TEST_SCENARIO = engineTestScenario({
  id: 'tool/engine-restart', restartAtDispatch: 1, files: { 'stage-one.txt': '', 'stage-two.txt': '' },
  expected: { outcome: 'restart engine fixture', workPaths: ['stage-one.txt', 'stage-two.txt'], checks: [
    { kind: 'file-equals', path: 'stage-one.txt', content: 'stage one\n' },
    { kind: 'file-equals', path: 'stage-two.txt', content: 'stage two\n' },
  ] },
});
