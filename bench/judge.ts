import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildTestAgent } from '../test/helpers.js';
import type { LLM } from '../src/llm/llm.js';
import { judgeScoreSchema, type JudgeScore, type RunRecord, type ScenarioSpec } from './schema.js';
import { ensurePrivateDir, privateDataRoot } from './store.js';

export interface JudgeProfile { id: string; family: string }
const DEFAULT_CRITERIA = {
  tool: ['tool-competence'], proactivity: ['proactive-judgment'], protocol: ['protocol-competence'], social: ['social-calibration'],
} as const;

export function blindPacket(record: RunRecord, scenario: ScenarioSpec): Record<string, unknown> {
  return { runId: record.runId, scenario: { id: scenario.id, prompt: scenario.prompt, expected: scenario.expected, criteria: scenario.judgeCriteria.length ? scenario.judgeCriteria : DEFAULT_CRITERIA[scenario.category] }, events: record.events, metrics: record.metrics, gates: record.gates };
}

export async function judgeRun(llm: LLM, profile: JudgeProfile, record: RunRecord, scenario: ScenarioSpec, root = privateDataRoot()): Promise<JudgeScore[]> {
  const packet = blindPacket(record, scenario); const criteria = scenario.judgeCriteria.length ? scenario.judgeCriteria : [...DEFAULT_CRITERIA[scenario.category]];
  const dir = ensurePrivateDir(path.join(root, 'judge-scratch', `${Date.now()}-${process.pid}-${profile.id}`)); const built = buildTestAgent({ dir, llm });
  try {
    const prompt = `You are a blind benchmark judge. Model identity is withheld and must never be inferred. Score each criterion as an anchored integer 0-4: 0 absent/harmful, 1 major failure, 2 mixed/partial, 3 solid with minor issues, 4 exemplary. Evidence must quote or identify observable trace facts; absent evidence scores 0. Return exactly one run call whose JavaScript writes {scores:[{criterion,score,evidence:string[],rationale:string}]} as JSON to judge-result.json with fs.writeFileSync. Keep rationales concise.\n\n${JSON.stringify(packet)}`;
    const completion = await llm.complete([{ role: 'system', content: 'Judge behavior only. Never use model identity as evidence, a tie-breaker, or a reward feature.' }, { role: 'user', content: prompt }]);
    const call = completion.message.tool_calls?.find((c) => c.function.name === 'run'); if (!call) throw new Error(`${profile.id} did not return a run call`);
    const args = JSON.parse(call.function.arguments) as { code?: unknown }; if (typeof args.code !== 'string') throw new Error(`${profile.id} returned no judge code`);
    const priorCwd=process.cwd(); process.chdir(dir); let result;
    try { result=await built.sandbox.run(args.code); } finally { process.chdir(priorCwd); }
    if (!result.ok) throw new Error(`${profile.id} judge sandbox failed: ${result.error}`);
    const resultFile = path.join(dir, 'judge-result.json'); if (!fs.existsSync(resultFile)) throw new Error(`${profile.id} did not write judge-result.json`);
    const raw: unknown = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    const rows = (raw as { scores?: unknown[] }).scores; if (!Array.isArray(rows)) throw new Error(`${profile.id} judge output has no scores array`);
    const scores = rows.map((row) => judgeScoreSchema.parse({ ...(row as object), runId: record.runId, profile: profile.id, family: profile.family }));
    const found = new Set(scores.map((s) => s.criterion)); if (criteria.some((c) => !found.has(c)) || scores.length !== criteria.length) throw new Error(`${profile.id} did not score every requested criterion exactly once`);
    return scores;
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* private scratch cleanup */ } }
}
