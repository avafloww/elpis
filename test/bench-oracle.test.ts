import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { oracleCode } from '../bench/runner.js';
import { LOCKED_SCENARIOS } from '../bench/scenarios.js';

test('oracle satisfies typed contracts without a privileged outcome marker', () => {
  for (const scenario of LOCKED_SCENARIOS) {
    const call = scenario.fixture.restartAtDispatch ? 2 : 1;
    const code = oracleCode(scenario, call);
    assert.doesNotThrow(() => new vm.Script(`(async () => { ${code} })()`), scenario.id);
    assert.doesNotMatch(code, /elpisbench-oracle-outcome/, scenario.id);
    if (scenario.expected.action !== 'required') assert.equal(code, 'void 0', scenario.id);
    if (scenario.expected.action === 'required' && scenario.expected.targetChannel) {
      assert.match(code, /elpis\.channel\(/, scenario.id);
      assert.ok(code.includes(JSON.stringify(scenario.fixture.channels[scenario.expected.targetChannel])), scenario.id);
    }
    for (const check of scenario.expected.checks) {
      if (check.kind !== 'send-includes') assert.ok(code.includes(check.path), `${scenario.id}: ${check.kind} ${check.path}`);
    }
  }
});

test('restart oracle defers final state until the resumed call', () => {
  const tool = LOCKED_SCENARIOS.find((scenario) => scenario.id === 'tool/restart-continuity')!;
  assert.match(oracleCode(tool, 1), /stage-one\.txt/);
  assert.doesNotMatch(oracleCode(tool, 1), /stage-two\.txt/);
  assert.match(oracleCode(tool, 2), /stage-two\.txt/);
  const protocol = LOCKED_SCENARIOS.find((scenario) => scenario.id === 'protocol/restart-end')!;
  assert.equal(oracleCode(protocol, 1), 'void 0');
  assert.match(oracleCode(protocol, 2), /checkpoint\.json/);
});
