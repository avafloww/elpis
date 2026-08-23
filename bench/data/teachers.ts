import { createHash } from 'node:crypto';
import type { ScenarioSpec } from '../schema.js';

export const TEACHERS = ['sol', 'opus-5'] as const;
export type Teacher = (typeof TEACHERS)[number];
export interface Candidate {
  teacher: Teacher;
  passesSafety: boolean;
  passesTargeting: boolean;
  outcome: boolean;
  protocol: boolean;
  efficiency: number;
  socialScore: number;
  normalizedToolTrace: string;
  payload: unknown;
}

export function assignedTeachers(scenario: ScenarioSpec): Teacher[] {
  if (
    ['hard-recovery', 'adversarial', 'calibration'].includes(
      scenario.difficulty,
    )
  )
    return [...TEACHERS];
  const byte = createHash('sha256')
    .update(JSON.stringify(scenario))
    .digest()[0];
  return [byte % 2 === 0 ? 'sol' : 'opus-5'];
}
export function teachersAfterFirstAttempt(
  scenario: ScenarioSpec,
  firstPassed: boolean,
): Teacher[] {
  const assigned = assignedTeachers(scenario);
  return firstPassed || assigned.length === 2 ? assigned : [...TEACHERS];
}
export function teacherWeight(teacher: Teacher): number {
  return TEACHERS.includes(teacher) ? 1 : 0;
}
function rank(c: Candidate): [number, number, number, number, number] {
  return [
    Number(c.passesSafety && c.passesTargeting),
    Number(c.outcome),
    Number(c.protocol),
    -c.efficiency,
    c.socialScore,
  ];
}
function compareRank(a: Candidate, b: Candidate): number {
  const ar = rank(a),
    br = rank(b);
  for (let i = 0; i < ar.length; i++) if (ar[i] !== br[i]) return br[i] - ar[i];
  return 0;
}
export function selectTeacherCandidates(
  candidates: readonly Candidate[],
): Candidate[] {
  const passing = candidates.filter(
    (c) => c.passesSafety && c.passesTargeting && c.outcome && c.protocol,
  );
  if (passing.length <= 1) return [...passing];
  const sorted = [...passing].sort(compareRank);
  const best = sorted[0];
  const equivalent = sorted.filter((c) => compareRank(best, c) === 0);
  const traces = new Map<string, Candidate>();
  for (const candidate of equivalent)
    if (!traces.has(candidate.normalizedToolTrace))
      traces.set(candidate.normalizedToolTrace, candidate);
  return [...traces.values()];
}
export function behavioralPreference(a: Candidate, b: Candidate): -1 | 0 | 1 {
  const c = compareRank(a, b);
  return c < 0 ? 1 : c > 0 ? -1 : 0;
}
