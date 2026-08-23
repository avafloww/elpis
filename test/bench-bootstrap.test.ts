import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisodeBootstrap } from '../bench/bootstrap.js';
import { SCHEMA_VERSION } from '../bench/schema.js';

const scenario = {
  schemaVersion: SCHEMA_VERSION,
  id: 'protocol/bootstrap',
  revision: 1,
  locked: false,
  category: 'protocol',
  title: 'bootstrap',
  prompt: 'finish',
  difficulty: 'ordinary',
  maxDispatches: 4,
  maxWallMs: 1000,
  fixture: {
    channels: { general: '100' },
    files: {},
    directories: [],
    heartbeat: false,
  },
  expected: { outcome: 'done', workPaths: ['done.flag'], action: 'required' },
  judgeCriteria: [],
};

test('episode bootstrap validates scenario and run metadata without filesystem controls', () => {
  const parsed = parseEpisodeBootstrap({
    type: 'bootstrap',
    scenario,
    run: {
      runId: 'run-1',
      providerType: 'openai-compatible',
      model: 'candidate',
      api: 'responses',
      reasoningEffort: 'high',
      contextSize: 262144,
      completionReserveTokens: 8192,
      image: 'sha256:test',
      harnessCommit: 'abc123',
    },
  });
  assert.equal(parsed.spec.id, 'protocol/bootstrap');
  assert.equal(parsed.meta.model, 'candidate');
  const resume = {
    events: [],
    sends: [],
    promptDigests: ['a'.repeat(64)],
    ingressDigests: ['b'.repeat(64)],
    dataSnapshotDigest: 'c'.repeat(64),
  };
  assert.deepEqual(
    parseEpisodeBootstrap({
      type: 'bootstrap',
      scenario,
      run: parsed.meta,
      resume,
    }).resume,
    resume,
  );
  assert.throws(
    () =>
      parseEpisodeBootstrap({
        type: 'bootstrap',
        scenario,
        run: parsed.meta,
        resume: { ...resume, dataSnapshotDigest: 'not-a-digest' },
      }),
    /invalid_format/,
  );
  assert.throws(
    () => parseEpisodeBootstrap({ type: 'response' }),
    /bootstrap missing or invalid/,
  );
});
