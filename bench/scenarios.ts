import { createHash } from 'node:crypto';
import type { ScenarioSpec } from './schema.js';

/** No built-in corpus is shipped. Reviewed transcript-derived worlds are private
 * inputs; an empty public corpus is preferable to answer-shaped demo scores. */
export const VALIDATED_SCENARIOS: readonly ScenarioSpec[] = Object.freeze([]);

export function scenarioDigest(spec: ScenarioSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}
