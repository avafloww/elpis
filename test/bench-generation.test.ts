import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateScenarioThroughSandbox } from '../bench/data/generate.js';
import { makeStubLLM } from './helpers.js';
import { engineTestScenario } from './bench-scenario-fixtures.js';

test('synthetic scenario generation is parsed from an actual Elpis sandbox result', async () => {
  const generated = {
    ...engineTestScenario(),
    id: 'tool/generated-fixture',
    locked: false,
  };
  const llm = makeStubLLM({
    complete: async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'g',
            type: 'function',
            function: {
              name: 'run',
              arguments: JSON.stringify({
                code: `fs.writeFileSync('generated-scenario.json', JSON.stringify(${JSON.stringify(generated)}))`,
                end: true,
              }),
            },
          },
        ],
      },
      stripped: false,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-generate-'));
  try {
    const scenario = await generateScenarioThroughSandbox(llm, 'brief', root);
    assert.equal(scenario.id, 'tool/generated-fixture');
    assert.equal(scenario.locked, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
