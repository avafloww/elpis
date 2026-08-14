import { parseScenario, type ScenarioSpec, type RunRecord } from './schema.js';

export interface EpisodeRunControl {
  runId: string;
  providerType: RunRecord['providerType'];
  model: string;
  image: string;
  harnessCommit: string;
}

export interface EpisodeBootstrap {
  type: 'bootstrap';
  scenario: unknown;
  run: EpisodeRunControl;
}

export function parseEpisodeBootstrap(value: unknown): { spec: ScenarioSpec; meta: EpisodeRunControl } {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'bootstrap') throw new Error('episode bootstrap missing or invalid');
  const bootstrap = value as EpisodeBootstrap;
  const spec = parseScenario(bootstrap.scenario);
  const meta = bootstrap.run;
  if (!meta || typeof meta.runId !== 'string' || typeof meta.model !== 'string' || typeof meta.image !== 'string' || typeof meta.harnessCommit !== 'string') throw new Error('episode run control missing or invalid');
  if (!['openai-compatible', 'codex-oauth', 'anthropic-oauth'].includes(meta.providerType)) throw new Error('episode provider type missing or invalid');
  return { spec, meta };
}
