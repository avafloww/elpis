// provenance.ts — out-of-band attribution for persisted assistant generations.
//
// This metadata is for transcript forensics and dataset construction. It must
// never become model-visible conversation content; each wire translator builds
// fresh request objects and deliberately ignores ChatMessage.provenance.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { Config } from '../config.js';
import { OPENAI_CODEX_BASE_URL } from './oauth/openai-codex.js';
import type { ChatMessage } from './llm.js';

export type ProviderType = 'openai-compatible' | 'anthropic-oauth' | 'codex-oauth';
export type ApiSurface = 'responses' | 'chat-completions' | 'anthropic-messages' | 'codex-responses';

export interface GenerationProvenance {
  providerType: ProviderType;
  model: string;
  apiSurface: ApiSurface;
  /** Canonical absolute endpoint which handled this generation. */
  apiEndpoint: string;
  reasoningEffort?: string;
  generatedAt: string;
  requestId?: string;
  harnessCommit: string;
  toolContractVersion: string;
}

export const TOOL_CONTRACT_VERSION = 'elpis-run-v3';

/** Remove every URL component which could carry authentication or unstable
 * request data. Throws for relative/invalid URLs: provenance must be exact. */
export function canonicalEndpoint(raw: string): string {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
}

/** Resolve a path beneath an OpenAI-compatible API base without accidentally
 * replacing a base path such as / or /coding/. */
export function endpointAt(baseUrl: string, suffix: string): string {
  const base = canonicalEndpoint(baseUrl);
  return canonicalEndpoint(`${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`);
}

let cachedCommit: string | undefined;
export function harnessCommit(): string {
  if (cachedCommit) return cachedCommit;
  const fromEnv = process.env.ELPIS_HARNESS_COMMIT?.trim();
  if (fromEnv) return (cachedCommit = fromEnv);
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, '..', '..');
    const value = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return (cachedCommit = value || 'unknown');
  } catch {
    return (cachedCommit = 'unknown');
  }
}

export interface ProvenanceStamp {
  providerType: ProviderType;
  model: string;
  apiSurface: ApiSurface;
  apiEndpoint: string;
  reasoningEffort?: string;
  requestId?: string;
  generatedAt?: string;
  harnessCommit?: string;
}

/** Mutates only the freshly-produced assistant message. Existing provenance is
 * replaced because a successful retry/fallback is the generation that counts. */
export function stampGeneration(message: ChatMessage, stamp: ProvenanceStamp): ChatMessage {
  message.provenance = {
    providerType: stamp.providerType,
    model: stamp.model,
    apiSurface: stamp.apiSurface,
    apiEndpoint: canonicalEndpoint(stamp.apiEndpoint),
    ...(stamp.reasoningEffort ? { reasoningEffort: stamp.reasoningEffort } : {}),
    generatedAt: stamp.generatedAt ?? new Date().toISOString(),
    ...(stamp.requestId ? { requestId: stamp.requestId } : {}),
    harnessCommit: stamp.harnessCommit ?? harnessCommit(),
    toolContractVersion: TOOL_CONTRACT_VERSION,
  };
  return message;
}

export function parseGenerationProvenance(raw: unknown): GenerationProvenance | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const providers: ProviderType[] = ['openai-compatible', 'anthropic-oauth', 'codex-oauth'];
  const surfaces: ApiSurface[] = ['responses', 'chat-completions', 'anthropic-messages', 'codex-responses'];
  if (!providers.includes(p.providerType as ProviderType) || !surfaces.includes(p.apiSurface as ApiSurface)) return undefined;
  const required = ['model', 'apiEndpoint', 'generatedAt', 'harnessCommit', 'toolContractVersion'] as const;
  if (required.some((key) => typeof p[key] !== 'string' || !(p[key] as string).length)) return undefined;
  let apiEndpoint: string;
  try { apiEndpoint = canonicalEndpoint(p.apiEndpoint as string); } catch { return undefined; }
  return {
    providerType: p.providerType as ProviderType,
    model: p.model as string,
    apiSurface: p.apiSurface as ApiSurface,
    apiEndpoint,
    ...(typeof p.reasoningEffort === 'string' ? { reasoningEffort: p.reasoningEffort } : {}),
    generatedAt: p.generatedAt as string,
    ...(typeof p.requestId === 'string' ? { requestId: p.requestId } : {}),
    harnessCommit: p.harnessCommit as string,
    toolContractVersion: p.toolContractVersion as string,
  };
}

export type ReplayIdentity = Pick<GenerationProvenance, 'providerType' | 'model' | 'apiSurface' | 'apiEndpoint'>;

/** Exact wire identity allowed to receive persisted opaque reasoning. `null`
 * means the configured surface cannot replay opaque state. */
export function replayIdentityForConfig(config: Config): ReplayIdentity | null {
  const model = config.llm.model;
  if (config.llm.providerType === 'codex-oauth') {
    return {
      providerType: 'codex-oauth', model, apiSurface: 'codex-responses',
      apiEndpoint: endpointAt(OPENAI_CODEX_BASE_URL, 'codex/responses'),
    };
  }
  if (config.llm.providerType === 'anthropic-oauth') {
    return {
      providerType: 'anthropic-oauth', model, apiSurface: 'anthropic-messages',
      apiEndpoint: endpointAt(config.llm.baseUrl, 'v1/messages'),
    };
  }
  if (config.llm.api === 'chat') return null;
  return {
    providerType: 'openai-compatible', model, apiSurface: 'responses',
    apiEndpoint: endpointAt(config.llm.baseUrl, 'responses'),
  };
}

export function sameReplayIdentity(a: ReplayIdentity | null | undefined, b: ReplayIdentity | null | undefined): boolean {
  return Boolean(
    a && b &&
    a.providerType === b.providerType &&
    a.model === b.model &&
    a.apiSurface === b.apiSurface &&
    canonicalEndpoint(a.apiEndpoint) === canonicalEndpoint(b.apiEndpoint),
  );
}

export function isTrustedOpaqueReplay(
  provenance: GenerationProvenance | undefined,
  identity: ReplayIdentity | null,
): boolean {
  return sameReplayIdentity(provenance, identity);
}
