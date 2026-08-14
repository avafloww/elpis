import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildTestAgent } from '../../test/helpers.js';
import type { LLM } from '../../src/llm/llm.js';
import { parseScenario, SCHEMA_VERSION, type ScenarioSpec } from '../schema.js';
import { ensurePrivateDir, privateDataRoot } from '../store.js';

export async function generateScenarioThroughSandbox(llm: LLM, brief: string, root = privateDataRoot()): Promise<ScenarioSpec> {
  const dir = ensurePrivateDir(path.join(root, 'generation-scratch', `${Date.now()}-${process.pid}`));
  const built = buildTestAgent({ dir, llm });
  try {
    const prompt = `Create one ElpisBench ScenarioSpec v${SCHEMA_VERSION} for this brief. It must be synthetic, locked:false, and must not copy real people or infrastructure. Return exactly one run tool call whose JavaScript writes the JSON object to generated-scenario.json with fs.writeFileSync. Do not send messages.\n\nBrief: ${brief}`;
    const result = await llm.complete([{ role: 'system', content: 'You generate validated benchmark scenario JSON through the Elpis run(code) sandbox.' }, { role: 'user', content: prompt }]);
    const call = result.message.tool_calls?.find((c) => c.function.name === 'run'); if (!call) throw new Error('scenario generator did not call run');
    const args = JSON.parse(call.function.arguments) as { code?: unknown }; if (typeof args.code !== 'string') throw new Error('scenario generator run call has no code string');
    const priorCwd = process.cwd(); process.chdir(dir);
    let execution;
    try { execution = await built.sandbox.run(args.code); } finally { process.chdir(priorCwd); }
    if (!execution.ok) throw new Error(`scenario generator sandbox failed: ${execution.error}`);
    const generatedFile = path.join(dir, 'generated-scenario.json');
    if (!fs.existsSync(generatedFile)) throw new Error('scenario generator did not write generated-scenario.json');
    const value: unknown = JSON.parse(fs.readFileSync(generatedFile, 'utf8'));
    const scenario = parseScenario(value); if (scenario.locked) throw new Error('generated scenarios must set locked:false');
    return scenario;
  } finally {
    built.cleanup();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* private scratch cleanup */ }
  }
}
