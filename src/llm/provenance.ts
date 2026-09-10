// provenance.ts — out-of-band attribution for persisted assistant generations.
//
// This metadata is for transcript forensics and dataset construction. It must
// never become model-visible conversation content; each wire translator builds
// fresh request objects and deliberately ignores ChatMessage.provenance.

import {
  LLM_PROXY_PATHS,
  isLlmTargetGeneration,
  type LlmTargetGeneration,
} from '@elpis/gateway-protocol';
import { parseLlmModelRef } from './model-registry.js';
import { TOOL_CONTRACT_VERSION } from './tool-contract.js';
export { TOOL_CONTRACT_VERSION } from './tool-contract.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  isResolvedGatewayConfig,
  requireMaterializedConfig,
  type RuntimeConfig,
} from '../config.js';
import { OPENAI_CODEX_BASE_URL } from './oauth/openai-codex.js';
import type { ChatMessage } from './llm.js';

// Capture boundary intrinsics before consulting untrusted transcript objects.
const intrinsicURL = URL;
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicHasOwn = Object.hasOwn;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicIncludes = Array.prototype.includes;
const intrinsicSome = Array.prototype.some;
const intrinsicStringSlice = String.prototype.slice;
const urlGetters = {
  protocol: intrinsicDescriptor(URL.prototype, 'protocol')!.get!,
  username: intrinsicDescriptor(URL.prototype, 'username')!.get!,
  password: intrinsicDescriptor(URL.prototype, 'password')!.get!,
  pathname: intrinsicDescriptor(URL.prototype, 'pathname')!.get!,
  search: intrinsicDescriptor(URL.prototype, 'search')!.get!,
  hash: intrinsicDescriptor(URL.prototype, 'hash')!.get!,
  href: intrinsicDescriptor(URL.prototype, 'href')!.get!,
  origin: intrinsicDescriptor(URL.prototype, 'origin')!.get!,
};
const urlSetters = {
  username: intrinsicDescriptor(URL.prototype, 'username')!.set!,
  password: intrinsicDescriptor(URL.prototype, 'password')!.set!,
  search: intrinsicDescriptor(URL.prototype, 'search')!.set!,
  hash: intrinsicDescriptor(URL.prototype, 'hash')!.set!,
};
const gatewayRequestPath = LLM_PROXY_PATHS.request;
function urlValue(url: URL, key: keyof typeof urlGetters): string {
  return intrinsicReflectApply(urlGetters[key], url, []);
}

interface OwnDataSlot {
  present: boolean;
  data: boolean;
  value: unknown;
}
function ownDataSlot(value: object, key: PropertyKey): OwnDataSlot {
  const descriptor = intrinsicDescriptor(value, key);
  return {
    present: descriptor !== undefined,
    data: descriptor !== undefined && intrinsicHasOwn(descriptor, 'value'),
    value:
      descriptor !== undefined && intrinsicHasOwn(descriptor, 'value')
        ? descriptor.value
        : undefined,
  };
}

export type ProviderType =
  'openai-compatible' | 'anthropic-oauth' | 'codex-oauth';
export type ApiSurface =
  'responses' | 'chat-completions' | 'anthropic-messages' | 'codex-responses';

export interface GatewayReplayIdentity {
  authority: string;
  modelRef: string;
  targetGeneration: LlmTargetGeneration;
}

/** Gateway authority is an HTTPS origin, never an upstream endpoint or token. */
export function canonicalGatewayAuthority(raw: string): string {
  const url = new intrinsicURL(raw);
  if (
    urlValue(url, 'protocol') !== 'https:' ||
    urlValue(url, 'username') ||
    urlValue(url, 'password') ||
    urlValue(url, 'pathname') !== '/' ||
    urlValue(url, 'search') ||
    urlValue(url, 'hash') ||
    urlValue(url, 'href') !== urlValue(url, 'origin') + '/'
  )
    throw new Error('Gateway replay authority must be an HTTPS origin');
  return urlValue(url, 'href');
}

function parseGatewayReplayIdentity(
  raw: unknown,
): GatewayReplayIdentity | undefined {
  try {
    if (!raw || typeof raw !== 'object' || intrinsicArrayIsArray(raw))
      return undefined;
    if (intrinsicReflectOwnKeys(raw).length !== 3) return undefined;
    const authority = intrinsicDescriptor(raw, 'authority');
    const modelRef = intrinsicDescriptor(raw, 'modelRef');
    const generation = intrinsicDescriptor(raw, 'targetGeneration');
    if (
      !authority ||
      !modelRef ||
      !generation ||
      !intrinsicHasOwn(authority, 'value') ||
      !intrinsicHasOwn(modelRef, 'value') ||
      !intrinsicHasOwn(generation, 'value') ||
      typeof authority.value !== 'string' ||
      typeof modelRef.value !== 'string' ||
      !isLlmTargetGeneration(generation.value)
    )
      return undefined;
    parseLlmModelRef(modelRef.value);
    return {
      authority: canonicalGatewayAuthority(authority.value),
      modelRef: modelRef.value,
      targetGeneration: generation.value,
    };
  } catch {
    return undefined;
  }
}

/** Managed endpoints must already be exact: never strip credentials or unstable
 * URL components to turn a mismatched persisted identity into a trusted one. */
function replayEndpoint(raw: string, gateway?: GatewayReplayIdentity): string {
  if (!gateway) return canonicalEndpoint(raw);
  const expected = new intrinsicURL(gatewayRequestPath, gateway.authority);
  if (raw !== urlValue(expected, 'href'))
    throw new Error('Invalid Gateway replay identity endpoint');
  return raw;
}

export interface GenerationProvenance {
  gateway?: GatewayReplayIdentity;
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

/** Remove every URL component which could carry authentication or unstable
 * request data. Throws for relative/invalid URLs: provenance must be exact. */
export function canonicalEndpoint(raw: string): string {
  const url = new intrinsicURL(raw);
  intrinsicReflectApply(urlSetters.username, url, ['']);
  intrinsicReflectApply(urlSetters.password, url, ['']);
  intrinsicReflectApply(urlSetters.search, url, ['']);
  intrinsicReflectApply(urlSetters.hash, url, ['']);
  const href = urlValue(url, 'href');
  return urlValue(url, 'pathname') !== '/' && href[href.length - 1] === '/'
    ? intrinsicReflectApply(intrinsicStringSlice, href, [0, -1])
    : href;
}

function trimSlashes(value: string, edge: 'start' | 'end'): string {
  let from = 0;
  let to = value.length;
  if (edge === 'start') {
    while (from < to && value[from] === '/') from++;
  } else {
    while (to > from && value[to - 1] === '/') to--;
  }
  return intrinsicReflectApply(intrinsicStringSlice, value, [from, to]);
}

/** Resolve a path beneath an OpenAI-compatible API base without accidentally
 * replacing a base path such as / or /coding/. */
export function endpointAt(baseUrl: string, suffix: string): string {
  const base = canonicalEndpoint(baseUrl);
  return canonicalEndpoint(
    `${trimSlashes(base, 'end')}/${trimSlashes(suffix, 'start')}`,
  );
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
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return (cachedCommit = value || 'unknown');
  } catch {
    return (cachedCommit = 'unknown');
  }
}

export interface ProvenanceStamp {
  gateway?: GatewayReplayIdentity;
  toolContractVersion?: string;
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
export function stampGeneration(
  message: ChatMessage,
  stamp: ProvenanceStamp,
): ChatMessage {
  const gatewaySlot = ownDataSlot(stamp, 'gateway');
  const toolContractSlot = ownDataSlot(stamp, 'toolContractVersion');
  if (gatewaySlot.present && !gatewaySlot.data)
    throw new Error('Invalid Gateway replay identity');
  if (toolContractSlot.present && !toolContractSlot.data)
    throw new Error('Invalid tool contract version');
  stamp = {
    providerType: stamp.providerType,
    model: stamp.model,
    apiSurface: stamp.apiSurface,
    apiEndpoint: stamp.apiEndpoint,
    toolContractVersion: toolContractSlot.present
      ? (toolContractSlot.value as string | undefined)
      : undefined,
    reasoningEffort: stamp.reasoningEffort,
    generatedAt: stamp.generatedAt,
    harnessCommit: stamp.harnessCommit,
    requestId: stamp.requestId,
  };
  const toolContractVersion =
    stamp.toolContractVersion === undefined
      ? TOOL_CONTRACT_VERSION
      : stamp.toolContractVersion;
  if (typeof toolContractVersion !== 'string' || !toolContractVersion)
    throw new Error('Invalid tool contract version');
  const gateway = gatewaySlot.present
    ? parseGatewayReplayIdentity(gatewaySlot.value)
    : undefined;
  if (gatewaySlot.present && !gateway)
    throw new Error('Invalid Gateway replay identity');
  const apiEndpoint = replayEndpoint(stamp.apiEndpoint, gateway);
  message.provenance = {
    ...(gateway ? { gateway } : {}),
    providerType: stamp.providerType,
    model: stamp.model,
    apiSurface: stamp.apiSurface,
    apiEndpoint,
    ...(stamp.reasoningEffort
      ? { reasoningEffort: stamp.reasoningEffort }
      : {}),
    generatedAt: stamp.generatedAt ?? new Date().toISOString(),
    ...(stamp.requestId ? { requestId: stamp.requestId } : {}),
    harnessCommit: stamp.harnessCommit ?? harnessCommit(),
    toolContractVersion,
  };
  return message;
}

export function parseGenerationProvenance(
  raw: unknown,
): GenerationProvenance | undefined {
  try {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const value = raw as Record<string, unknown>;
    const slots = {
      providerType: ownDataSlot(value, 'providerType'),
      model: ownDataSlot(value, 'model'),
      apiSurface: ownDataSlot(value, 'apiSurface'),
      apiEndpoint: ownDataSlot(value, 'apiEndpoint'),
      gateway: ownDataSlot(value, 'gateway'),
      toolContractVersion: ownDataSlot(value, 'toolContractVersion'),
      reasoningEffort: ownDataSlot(value, 'reasoningEffort'),
      generatedAt: ownDataSlot(value, 'generatedAt'),
      harnessCommit: ownDataSlot(value, 'harnessCommit'),
      requestId: ownDataSlot(value, 'requestId'),
    };
    const knownSlots = [
      slots.providerType,
      slots.model,
      slots.apiSurface,
      slots.apiEndpoint,
      slots.gateway,
      slots.toolContractVersion,
      slots.reasoningEffort,
      slots.generatedAt,
      slots.harnessCommit,
      slots.requestId,
    ];
    if (
      intrinsicReflectApply(intrinsicSome, knownSlots, [
        (slot: OwnDataSlot) => slot.present && !slot.data,
      ]) ||
      !slots.providerType.present ||
      !slots.model.present ||
      !slots.apiSurface.present ||
      !slots.apiEndpoint.present ||
      !slots.toolContractVersion.present ||
      !slots.generatedAt.present ||
      !slots.harnessCommit.present
    )
      return undefined;
    const p = {
      providerType: slots.providerType.value,
      model: slots.model.value,
      apiSurface: slots.apiSurface.value,
      apiEndpoint: slots.apiEndpoint.value,
      gateway: slots.gateway.value,
      toolContractVersion: slots.toolContractVersion.value,
      reasoningEffort: slots.reasoningEffort.value,
      generatedAt: slots.generatedAt.value,
      harnessCommit: slots.harnessCommit.value,
      requestId: slots.requestId.value,
    };
    const hasGateway = slots.gateway.present;
    const providers: ProviderType[] = [
      'openai-compatible',
      'anthropic-oauth',
      'codex-oauth',
    ];
    const surfaces: ApiSurface[] = [
      'responses',
      'chat-completions',
      'anthropic-messages',
      'codex-responses',
    ];
    if (
      !intrinsicReflectApply(intrinsicIncludes, providers, [p.providerType]) ||
      !intrinsicReflectApply(intrinsicIncludes, surfaces, [p.apiSurface])
    )
      return undefined;
    const required = [
      'model',
      'apiEndpoint',
      'generatedAt',
      'harnessCommit',
      'toolContractVersion',
    ] as const;
    if (
      intrinsicReflectApply(intrinsicSome, required, [
        (key: (typeof required)[number]) =>
          typeof p[key] !== 'string' || !(p[key] as string).length,
      ])
    )
      return undefined;
    const gateway = hasGateway
      ? parseGatewayReplayIdentity(p.gateway)
      : undefined;
    if (hasGateway && !gateway) return undefined;
    let apiEndpoint: string;
    try {
      apiEndpoint = replayEndpoint(p.apiEndpoint as string, gateway);
    } catch {
      return undefined;
    }
    return {
      ...(gateway ? { gateway } : {}),
      providerType: p.providerType as ProviderType,
      model: p.model as string,
      apiSurface: p.apiSurface as ApiSurface,
      apiEndpoint,
      ...(typeof p.reasoningEffort === 'string'
        ? { reasoningEffort: p.reasoningEffort }
        : {}),
      generatedAt: p.generatedAt as string,
      ...(typeof p.requestId === 'string' ? { requestId: p.requestId } : {}),
      harnessCommit: p.harnessCommit as string,
      toolContractVersion: p.toolContractVersion as string,
    };
  } catch {
    return undefined;
  }
}

export type ReplayIdentity = Pick<
  GenerationProvenance,
  | 'providerType'
  | 'model'
  | 'apiSurface'
  | 'apiEndpoint'
  | 'toolContractVersion'
  | 'gateway'
>;

/** Exact wire identity allowed to receive persisted opaque reasoning. `null`
 * means the configured surface cannot replay opaque state. */
export function replayIdentityForConfig(
  parsed: RuntimeConfig,
): ReplayIdentity | null {
  if (isResolvedGatewayConfig(parsed)) {
    const target = parsed.llm.target;
    if (target.apiSurface === 'chat-completions') return null;
    if (target.apiSurface === null || target.route === null)
      throw new Error('Gateway model has no executable replay surface');
    const authority = canonicalGatewayAuthority(parsed.llm.gatewayAuthority);
    const endpoint = new intrinsicURL(gatewayRequestPath, authority);
    return {
      toolContractVersion: target.toolContractVersion,
      providerType: target.providerType,
      model: target.model,
      apiSurface: target.apiSurface,
      apiEndpoint: urlValue(endpoint, 'href'),
      gateway: {
        authority,
        modelRef: target.modelRef,
        targetGeneration: target.targetGeneration,
      },
    };
  }
  const config = requireMaterializedConfig(parsed);
  const model = config.llm.model;
  if (config.llm.providerType === 'codex-oauth') {
    return {
      toolContractVersion: TOOL_CONTRACT_VERSION,
      providerType: 'codex-oauth',
      model,
      apiSurface: 'codex-responses',
      apiEndpoint: endpointAt(OPENAI_CODEX_BASE_URL, 'codex/responses'),
    };
  }
  if (config.llm.providerType === 'anthropic-oauth') {
    return {
      toolContractVersion: TOOL_CONTRACT_VERSION,
      providerType: 'anthropic-oauth',
      model,
      apiSurface: 'anthropic-messages',
      apiEndpoint: endpointAt(config.llm.baseUrl, 'v1/messages'),
    };
  }
  if (config.llm.api === 'chat') return null;
  return {
    toolContractVersion: TOOL_CONTRACT_VERSION,
    providerType: 'openai-compatible',
    model,
    apiSurface: 'responses',
    apiEndpoint: endpointAt(config.llm.baseUrl, 'responses'),
  };
}

export function sameReplayIdentity(
  a: ReplayIdentity | null | undefined,
  b: ReplayIdentity | null | undefined,
): boolean {
  try {
    if (!a || !b) return false;
    const aSlots = {
      providerType: ownDataSlot(a, 'providerType'),
      model: ownDataSlot(a, 'model'),
      apiSurface: ownDataSlot(a, 'apiSurface'),
      apiEndpoint: ownDataSlot(a, 'apiEndpoint'),
      toolContractVersion: ownDataSlot(a, 'toolContractVersion'),
      gateway: ownDataSlot(a, 'gateway'),
    };
    const bSlots = {
      providerType: ownDataSlot(b, 'providerType'),
      model: ownDataSlot(b, 'model'),
      apiSurface: ownDataSlot(b, 'apiSurface'),
      apiEndpoint: ownDataSlot(b, 'apiEndpoint'),
      toolContractVersion: ownDataSlot(b, 'toolContractVersion'),
      gateway: ownDataSlot(b, 'gateway'),
    };
    const required = [
      'providerType',
      'model',
      'apiSurface',
      'apiEndpoint',
      'toolContractVersion',
    ] as const;
    if (
      intrinsicReflectApply(intrinsicSome, required, [
        (key: (typeof required)[number]) =>
          !aSlots[key].present ||
          !aSlots[key].data ||
          !bSlots[key].present ||
          !bSlots[key].data,
      ]) ||
      (aSlots.gateway.present && !aSlots.gateway.data) ||
      (bSlots.gateway.present && !bSlots.gateway.data)
    )
      return false;
    const aHasGateway = aSlots.gateway.present;
    const bHasGateway = bSlots.gateway.present;
    const aGateway = aSlots.gateway.value;
    const bGateway = bSlots.gateway.value;
    a = {
      providerType: aSlots.providerType.value as ProviderType,
      model: aSlots.model.value as string,
      apiSurface: aSlots.apiSurface.value as ApiSurface,
      apiEndpoint: aSlots.apiEndpoint.value as string,
      toolContractVersion: aSlots.toolContractVersion.value as string,
    };
    b = {
      providerType: bSlots.providerType.value as ProviderType,
      model: bSlots.model.value as string,
      apiSurface: bSlots.apiSurface.value as ApiSurface,
      apiEndpoint: bSlots.apiEndpoint.value as string,
      toolContractVersion: bSlots.toolContractVersion.value as string,
    };
    if (
      typeof a.toolContractVersion !== 'string' ||
      !a.toolContractVersion ||
      typeof b.toolContractVersion !== 'string' ||
      !b.toolContractVersion
    )
      return false;
    const ag = aHasGateway ? parseGatewayReplayIdentity(aGateway) : undefined;
    const bg = bHasGateway ? parseGatewayReplayIdentity(bGateway) : undefined;
    if ((aHasGateway && !ag) || (bHasGateway && !bg)) return false;
    if ((ag !== undefined) !== (bg !== undefined)) return false;
    if (
      ag &&
      bg &&
      (ag.authority !== bg.authority ||
        ag.modelRef !== bg.modelRef ||
        ag.targetGeneration !== bg.targetGeneration)
    )
      return false;
    try {
      return (
        a.providerType === b.providerType &&
        a.model === b.model &&
        a.apiSurface === b.apiSurface &&
        a.toolContractVersion === b.toolContractVersion &&
        replayEndpoint(a.apiEndpoint, ag) === replayEndpoint(b.apiEndpoint, bg)
      );
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export function isTrustedOpaqueReplay(
  provenance: GenerationProvenance | undefined,
  identity: ReplayIdentity | null,
): boolean {
  return sameReplayIdentity(provenance, identity);
}
