import * as fs from 'node:fs';
import type { Config } from './config.js';

export const RESTRICTED_SENTINEL = '/etc/elpis/restricted';

export interface RuntimeProfile {
  readonly restricted: boolean;
  readonly source: 'sentinel' | 'environment' | 'normal';
}

export const BUILTIN_MODULE_IDS = [
  'kagi',
  'bsky',
  'browser',
  'computer',
  'motor',
] as const;
export type BuiltinModuleId = (typeof BUILTIN_MODULE_IDS)[number];

export type BuiltinModuleState = 'disabled' | 'unavailable' | 'active';

export interface BuiltinModuleStatus {
  readonly id: BuiltinModuleId;
  readonly keys: readonly string[];
  readonly state: BuiltinModuleState;
  readonly reason: string | null;
}

export interface BuiltinModuleRegistry {
  readonly statuses: readonly BuiltinModuleStatus[];
  state(id: BuiltinModuleId): BuiltinModuleState;
  isSelected(id: BuiltinModuleId): boolean;
  isActive(id: BuiltinModuleId): boolean;
  reason(id: BuiltinModuleId): string | null;
}

interface ProfileDetectionOptions {
  env?: NodeJS.ProcessEnv;
  sentinelPath?: string;
  exists?: (path: string) => boolean;
}

function enabledByEnvironment(value: string | undefined): boolean {
  return (
    value === '1' ||
    value?.toLowerCase() === 'true' ||
    value?.toLowerCase() === 'yes'
  );
}

export function detectRuntimeProfile(
  options: ProfileDetectionOptions = {},
): RuntimeProfile {
  const sentinelPath = options.sentinelPath ?? RESTRICTED_SENTINEL;
  const exists = options.exists ?? fs.existsSync;
  if (exists(sentinelPath))
    return Object.freeze({ restricted: true, source: 'sentinel' });
  if (enabledByEnvironment((options.env ?? process.env).ELPIS_RESTRICTED)) {
    return Object.freeze({ restricted: true, source: 'environment' });
  }
  return Object.freeze({ restricted: false, source: 'normal' });
}

export function resolveBuiltinModules(
  config: Config,
  profile: RuntimeProfile = { restricted: false, source: 'normal' },
): BuiltinModuleRegistry {
  const policy = config.modules ?? { enabled: null, disabled: [] };
  const selected = (id: BuiltinModuleId): boolean =>
    policy.enabled !== null
      ? policy.enabled.includes(id)
      : !policy.disabled.includes(id);
  const status = (
    id: BuiltinModuleId,
    keys: string[],
    available: boolean,
    unavailableReason: string,
  ): BuiltinModuleStatus => {
    if (!selected(id))
      return {
        id,
        keys,
        state: 'disabled',
        reason: `${id} module is excluded by modules policy`,
      };
    if (!available)
      return { id, keys, state: 'unavailable', reason: unavailableReason };
    return { id, keys, state: 'active', reason: null };
  };
  const hostGuiAvailable = !profile.restricted;
  const computerActive = selected('computer') && hostGuiAvailable;
  const statuses: BuiltinModuleStatus[] = [
    status(
      'kagi',
      ['search', 'extract'],
      Boolean(config.kagi.apiKey),
      'Kagi is selected but not configured (set kagi.api_key)',
    ),
    status(
      'bsky',
      ['bsky'],
      config.bluesky !== null,
      'Bluesky is selected but not configured (set bluesky.identifier and bluesky.app_password)',
    ),
    status(
      'browser',
      ['browser'],
      hostGuiAvailable,
      'browser is selected but unavailable in the restricted runtime profile',
    ),
    status(
      'computer',
      ['computer'],
      hostGuiAvailable,
      'computer is selected but unavailable in the restricted runtime profile',
    ),
    status(
      'motor',
      ['motor'],
      computerActive,
      'motor is selected but requires an active computer module',
    ),
  ];
  const frozen = Object.freeze(
    statuses.map((entry) =>
      Object.freeze({ ...entry, keys: Object.freeze([...entry.keys]) }),
    ),
  );
  const find = (id: BuiltinModuleId) => frozen.find((entry) => entry.id === id);
  return Object.freeze({
    statuses: frozen,
    state(id: BuiltinModuleId) {
      return find(id)?.state ?? 'disabled';
    },
    isSelected(id: BuiltinModuleId) {
      return (find(id)?.state ?? 'disabled') !== 'disabled';
    },
    isActive(id: BuiltinModuleId) {
      return find(id)?.state === 'active';
    },
    reason(id: BuiltinModuleId) {
      return find(id)?.reason ?? `unknown built-in module: ${id}`;
    },
  });
}
