import type { GenerationProvenance } from '../../src/llm/provenance.js';

export type AttributionConfidence = 'exact' | 'high' | 'medium' | 'unknown';
export interface ModelEpoch {
  id: string;
  processId: string;
  startedAt: string;
  endedAt?: string;
  providerType?: GenerationProvenance['providerType'];
  model?: string;
  apiSurface?: GenerationProvenance['apiSurface'];
  apiEndpoint?: string;
  confidence: Exclude<AttributionConfidence, 'exact'>;
  source: 'journal' | 'manual' | 'unresolved';
}
export interface JournalLine {
  at: string;
  processId: string;
  message: string;
}

const routePattern =
  /provider=(openai-compatible|anthropic-oauth|codex-oauth).*?model=([^ |]+).*?surface=(responses|chat-completions|anthropic-messages|codex-responses).*?endpoint=(https?:\/\/\S+)/;
export function epochsFromJournal(lines: readonly JournalLine[]): ModelEpoch[] {
  const epochs: ModelEpoch[] = [];
  for (const line of [...lines].sort((a, b) => a.at.localeCompare(b.at))) {
    const match = routePattern.exec(line.message);
    if (!match) continue;
    const prior = [...epochs]
      .reverse()
      .find((e) => e.processId === line.processId && !e.endedAt);
    if (prior) prior.endedAt = line.at;
    epochs.push({
      id: `${line.processId}:${line.at}`,
      processId: line.processId,
      startedAt: line.at,
      providerType: match[1] as ModelEpoch['providerType'],
      model: match[2],
      apiSurface: match[3] as ModelEpoch['apiSurface'],
      apiEndpoint: match[4],
      confidence: 'high',
      source: 'journal',
    });
  }
  return epochs;
}

export function attributeGeneration(
  generatedAt: string | undefined,
  provenance: GenerationProvenance | undefined,
  epochs: readonly ModelEpoch[],
): {
  confidence: AttributionConfidence;
  provenance?: GenerationProvenance;
  epoch?: ModelEpoch;
} {
  if (provenance) return { confidence: 'exact', provenance };
  if (!generatedAt) return { confidence: 'unknown' };
  const at = Date.parse(generatedAt);
  if (!Number.isFinite(at)) return { confidence: 'unknown' };
  const matches = epochs.filter(
    (e) =>
      Date.parse(e.startedAt) <= at &&
      (!e.endedAt || at < Date.parse(e.endedAt)),
  );
  return matches.length === 1
    ? { confidence: matches[0].confidence, epoch: matches[0] }
    : { confidence: 'unknown' };
}

export function qualifiesForModelSpecificMining(
  confidence: AttributionConfidence,
): boolean {
  return confidence === 'exact' || confidence === 'high';
}
