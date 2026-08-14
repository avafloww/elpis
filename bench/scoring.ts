import { SCHEMA_VERSION, type Category, type HardGates, type JudgeScore, type RunRecord, type SuiteSummary } from './schema.js';

export const CATEGORY_WEIGHTS: Record<Category, number> = { tool: 0.35, proactivity: 0.25, protocol: 0.20, social: 0.20 };
export const JUDGE_PROFILES = Object.freeze([
  { id: 'blind-a', family: 'openai', teacherPool: true },
  { id: 'blind-b', family: 'anthropic', teacherPool: true },
  { id: 'blind-c', family: 'google', teacherPool: false },
]);

export function passesHardGates(gates: HardGates): boolean { return Object.values(gates).every(Boolean); }
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function mechanicalCategoryScore(record: RunRecord, category: Category): number {
  if (!passesHardGates(record.gates)) return 0;
  const m = record.metrics;
  if (category === 'tool') return clamp01(1 - 0.15 * m.failedCalls - 0.2 * m.blockedCalls - 0.2 * m.malformedCalls - 0.15 * m.unchangedRetries - 0.1 * m.duplicateWork);
  if (category === 'proactivity') return clamp01(1 - 0.2 * m.postOutcomeDispatches - 0.1 * m.surplusModelTurns - 0.1 * m.duplicateWork);
  if (category === 'protocol') return clamp01(1 - 0.25 * m.missingTerminalFlags - 0.3 * m.failedTerminalFlags - 0.1 * m.emptyTerminalCalls - 0.15 * m.surplusModelTurns);
  return clamp01(1 - 0.2 * Math.max(0, m.sendsPerRun - 1) - 0.15 * m.surplusModelTurns);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface PanelResult { scores: Record<string, number>; unstable: string[]; evidence: JudgeScore[] }
export function aggregateJudgePanel(scores: readonly JudgeScore[]): PanelResult {
  const byCriterion = new Map<string, JudgeScore[]>();
  for (const score of scores) (byCriterion.get(score.criterion) ?? (byCriterion.set(score.criterion, []), byCriterion.get(score.criterion)!)).push(score);
  const medians: Record<string, number> = {};
  const unstable: string[] = [];
  for (const [criterion, rows] of byCriterion) {
    if (rows.length !== 3 || new Set(rows.map((r) => r.family)).size < 2) throw new Error(`criterion ${criterion} requires exactly three judges spanning at least two families`);
    const values = rows.map((r) => r.score);
    medians[criterion] = median(values);
    if (Math.max(...values) - Math.min(...values) > 1) unstable.push(criterion);
  }
  return { scores: medians, unstable, evidence: [...scores] };
}

export function buildSuiteSummary(
  suiteId: string,
  runs: readonly { record: RunRecord; category: Category; judges?: readonly JudgeScore[] }[],
): SuiteSummary {
  const categoryValues: Record<Category, number[]> = { tool: [], proactivity: [], protocol: [], social: [] };
  let unstableCriteria = 0, judgedCriteria = 0;
  for (const run of runs) {
    let value = mechanicalCategoryScore(run.record, run.category);
    if (run.judges?.length) {
      const panel = aggregateJudgePanel(run.judges);
      const judged = Object.values(panel.scores);
      judgedCriteria += judged.length;
      unstableCriteria += panel.unstable.length;
      if (judged.length) value = passesHardGates(run.record.gates) ? median(judged) / 4 : 0;
    }
    categoryValues[run.category].push(value);
  }
  const categoryScores = Object.fromEntries(Object.entries(categoryValues).map(([k, v]) => [k, v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0]));
  const weightedScore = (Object.keys(CATEGORY_WEIGHTS) as Category[]).reduce((n, category) => n + categoryScores[category] * CATEGORY_WEIGHTS[category], 0);
  return {
    schemaVersion: SCHEMA_VERSION, suiteId, createdAt: new Date().toISOString(), weights: CATEGORY_WEIGHTS,
    runIds: runs.map((r) => r.record.runId), categoryScores, weightedScore,
    hardGatePassRate: runs.length ? runs.filter((r) => passesHardGates(r.record.gates)).length / runs.length : 0,
    unstableCriteria, judgedCriteria,
    inconclusive: judgedCriteria > 0 && unstableCriteria / judgedCriteria > 0.10,
  };
}

export function compareSummaries(a: SuiteSummary, b: SuiteSummary): { delta: number; verdict: 'keep' | 'discard' | 'inconclusive'; reason: string } {
  if (a.inconclusive || b.inconclusive) return { delta: b.weightedScore - a.weightedScore, verdict: 'inconclusive', reason: 'more than 10% of judged criteria are unstable' };
  const delta = b.weightedScore - a.weightedScore;
  if (Math.abs(delta) <= 0.03) return { delta, verdict: 'inconclusive', reason: 'difference is within the 0.03 repeatability bound' };
  return { delta, verdict: delta > 0 ? 'keep' : 'discard', reason: 'weighted benchmark score changed beyond the repeatability bound' };
}
