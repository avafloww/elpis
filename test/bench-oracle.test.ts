import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { oracleCode } from '../bench/runner.js';
import {
  engineTestScenario,
  RESTART_TEST_SCENARIO,
} from './bench-scenario-fixtures.js';

const fileScenario = engineTestScenario();
const targetScenario = engineTestScenario({
  id: 'tool/engine-target',
  expected: {
    targetChannel: 'ops',
    workPaths: [],
    checks: [{ kind: 'send-includes', values: ['done'] }],
  },
});

test('oracle mechanics satisfy test-only typed contracts without a privileged outcome marker', () => {
  for (const scenario of [fileScenario, targetScenario]) {
    const code = oracleCode(scenario, 1);
    assert.doesNotThrow(() => new vm.Script(`(async () => { ${code} })()`));
    assert.doesNotMatch(code, /elpisbench-oracle-outcome/);
  }
  assert.match(oracleCode(targetScenario, 1), /elpis\.channel\(/);
  assert.match(oracleCode(fileScenario, 1), /result\.txt/);
});

test('restart oracle defers all final test fixture state until the resumed call', () => {
  assert.equal(oracleCode(RESTART_TEST_SCENARIO, 1), 'void 0');
  assert.match(oracleCode(RESTART_TEST_SCENARIO, 2), /stage-one\.txt/);
  assert.match(oracleCode(RESTART_TEST_SCENARIO, 2), /stage-two\.txt/);
});
