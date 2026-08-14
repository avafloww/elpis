import { createHash } from 'node:crypto';
import type { Episode } from '../schema.js';
import { TOOL_CONTRACT_VERSION, canonicalEndpoint } from '../../src/llm/provenance.js';

const PUBLIC_HOSTS = new Set(['api.openai.com', 'api.anthropic.com', 'chatgpt.com']);
export function publicEndpoint(endpoint: string, surface: string, salt: string): string {
  const canonical = canonicalEndpoint(endpoint); const url = new URL(canonical);
  if (PUBLIC_HOSTS.has(url.hostname)) return canonical;
  return `opaque://${surface}/${createHash('sha256').update(`${salt}\0${canonical}`).digest('hex').slice(0, 20)}`;
}
export function publicizeEpisode(episode: Episode, salt: string): Episode {
  if (episode.source === 'private-real') throw new Error('real-derived episodes are permanently private and cannot be publicly exported');
  return { ...episode, provenance: episode.provenance.map((p) => typeof p.apiEndpoint === 'string' ? { ...p, apiEndpoint: publicEndpoint(p.apiEndpoint, String(p.apiSurface ?? 'unknown'), salt) } : p) };
}
export const RUN_TOOL_EXPORT = { type: 'function', function: { name: 'run', description: 'Execute JavaScript in the persistent Elpis sandbox.', parameters: { type: 'object', properties: { code: { type: 'string' }, end: { type: 'boolean' } }, required: ['code'], additionalProperties: false } } };
export function toHuggingFaceRow(episode: Episode): Record<string, unknown> {
  if (!episode.accepted || episode.review?.status !== 'approved') throw new Error(`episode ${episode.id} has not received manual approval`);
  if (episode.toolContractVersion !== TOOL_CONTRACT_VERSION) throw new Error(`episode uses incompatible tool contract ${episode.toolContractVersion}`);
  return { id: episode.id, messages: episode.messages, tools: [RUN_TOOL_EXPORT], provenance: episode.provenance };
}
