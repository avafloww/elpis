import { z } from 'zod';
import { parseScenario, traceEventSchema, type ScenarioSpec, type RunRecord } from './schema.js';

export interface EpisodeRunControl {
  runId: string;
  providerType: RunRecord['providerType'];
  model: string;
  api: 'auto' | 'responses' | 'chat';
  reasoningEffort: string | null;
  contextSize: number | null;
  completionReserveTokens: number;
  image: string;
  harnessCommit: string;
}

export const episodeResumeStateSchema = z.object({
  events: z.array(traceEventSchema),
  sends: z.array(z.object({ channelId: z.string(), text: z.string() })),
  promptDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  ingressDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  dataSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EpisodeResumeState = z.infer<typeof episodeResumeStateSchema>;

export interface EpisodeBootstrap {
  type: 'bootstrap';
  scenario: unknown;
  run: EpisodeRunControl;
  resume?: EpisodeResumeState;
}

export function parseEpisodeBootstrap(value: unknown): { spec: ScenarioSpec; meta: EpisodeRunControl; resume?: EpisodeResumeState } {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'bootstrap') throw new Error('episode bootstrap missing or invalid');
  const bootstrap = value as EpisodeBootstrap;
  const spec = parseScenario(bootstrap.scenario);
  const meta = bootstrap.run;
  if (!meta || typeof meta.runId !== 'string' || typeof meta.model !== 'string' || typeof meta.image !== 'string' || typeof meta.harnessCommit !== 'string') throw new Error('episode run control missing or invalid');
  if (!['openai-compatible', 'codex-oauth', 'anthropic-oauth'].includes(meta.providerType)) throw new Error('episode provider type missing or invalid');
  if (!['auto', 'responses', 'chat'].includes(meta.api)) throw new Error('episode API surface missing or invalid');
  if (meta.reasoningEffort !== null && typeof meta.reasoningEffort !== 'string') throw new Error('episode reasoning effort missing or invalid');
  if (meta.contextSize !== null && (!Number.isInteger(meta.contextSize) || meta.contextSize <= 0)) throw new Error('episode context size missing or invalid');
  if (!Number.isInteger(meta.completionReserveTokens) || meta.completionReserveTokens <= 0) throw new Error('episode completion reserve missing or invalid');
  const resume = bootstrap.resume === undefined ? undefined : episodeResumeStateSchema.parse(bootstrap.resume);
  return { spec, meta, ...(resume ? { resume } : {}) };
}
