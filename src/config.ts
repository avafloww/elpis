import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import {
  createLogger,
  parseLogLevel,
  type LogLevel,
  type Logger,
} from './lib/log.js';
import { BUILTIN_MODULE_IDS, type BuiltinModuleId } from './builtin-modules.js';
import {
  createLlmModelRegistry,
  legacyLlmModelRegistry,
  resolveLlmModelTarget,
  type LegacyLlmDefinition,
  type LlmModelRegistry,
  type LlmProviderDefinition,
  type LlmProviderType,
  type LlmRole,
  type ResolvedLlmTarget,
} from './llm/model-registry.js';

/** A channel's wake tier — how eagerly the agent responds in it. Later tasks
 * (the wake classifier) consume this; only parses and carries it. */
export type ChannelTier = 'direct' | 'social' | 'quiet';
export type ChannelMode = 'drop' | ChannelTier;

/** One entry in `discord.guilds`. Explicit channels override the guild's
 * receive/send defaults; omitted fields preserve the historical allowlist. */
export interface GuildConfig {
  id: string;
  slug: string;
  slashCommands: boolean;
  /** Resolve PluralKit proxy authors and suppress their deleted originals. */
  pluralKit?: boolean;
  /** Minutes-since-midnight window; wraparound allowed (start > end). null = none. */
  quietHours: { start: number; end: number } | null;
  /** IANA tz for quiet_hours; null = host tz. */
  timezone: string | null;
  /** Receive mode for unlisted channels. Absent/`drop` preserves the historical allowlist. */
  defaultTier?: ChannelMode;
  /** Hard send gate for the whole guild. false dominates every channel setting. */
  allowSend?: boolean;
  /** Send default for unlisted channels. Conservative false when omitted. */
  defaultAllowSend?: boolean;
  /** Explicit channel id → receive mode. */
  channels: Record<string, ChannelMode>;
  /** Explicit channel id → send permission. Scalar channel entries parse as true. */
  channelAllowSend?: Record<string, boolean>;
}

export interface LlmConfig extends LegacyLlmDefinition {
  completionReserveTokens: number;
  registry: LlmModelRegistry;
  registrySource: 'canonical' | 'legacy';
}

export interface Config {
  llm: LlmConfig;
  operator: {
    name: string;
    pronouns: string | null;
    discordId: string | null;
  };
  discord: {
    botToken: string;
    /** Bot application id for guild slash-command registration. Falls back to
     * the id encoded in the bot token. */
    applicationId: string;
    /** Dedicated channel for harness-level error notices. When null these are
     * LOG-ONLY — they never fall back to a public room. */
    errorChannelId: string | null;
    /** Exact raw Discord author ids dropped before any agent-visible ingress. */
    ignoredUserIds: string[];
    /** Per-message byte budget for inlining small text attachments verbatim
     * into the inbound message. 0 disables inlining. */
    attachmentInlineMaxBytes: number;
    /** Batching interval for ambient (non-direct-tier) inbound messages.
     * 0 disables batching (every message wakes the loop, today's behavior). */
    ambientTickMs: number;
    /** Whether an ambient room-context tick may send during its model turn.
     * false keeps observation/memory tools available but hard-denies every send. */
    ambientAllowSend: boolean;
    /** Custom emote/sticker registry: attach the image of a custom emote or
     * sticker the first time it is used in the current context window, so
     * the agent can read the social cue instead of guessing from the
     * `<:name:id>` markup. false disables the feature entirely. */
    emoteImages: boolean;
    /** Keyframes extracted (via ffmpeg) per ANIMATED emote/sticker so the
     * agent can comprehend the motion. 1 = attach a single static frame. */
    emoteKeyframes: number;
    /** Every guild the bot is live in, each with safe receive/send defaults
     * and optional per-channel overrides. Unlisted guilds are never heard. */
    guilds: GuildConfig[];
  };
  compaction: {
    /** Absolute token count of REAL context at which a compaction cycle is
     * triggered. Clamped at boot to the real usable window (see index.ts). */
    triggerTokens: number;
    /** Verbatim tail (tokens) kept unsummarized when compaction folds the
     * older history. Validated 0 < keep < trigger. */
    keepTokens: number;
  };
  memory: {
    /** Consolidate MEMORY.md/people files above this estimated token count. 0 disables. */
    consolidationThresholdTokens: number;
    /** Ask the consolidator to shrink below this count; must be below threshold. */
    consolidationTargetTokens: number;
  };
  heartbeat: {
    /** Interval between autonomous heartbeat wakes. 0 disables. */
    intervalMs: number;
    /** Upper bound for idle-tick backoff. */
    maxIntervalMs: number;
    /** Minimum real user messages between reflection beats. */
    reflectionMinMessages: number;
    /** Reach-out nudge after this much outbound silence. 0 disables. */
    socialNudgeMs: number;
  };
  sandbox: {
    /** Sync VM watchdog — kills synchronous runaway JS. */
    syncTimeoutMs: number;
    /** How long a turn waits before DETACHING a run's promise into bg. */
    asyncDeadlineMs: number;
    /** Hard grace from Mind closure before its persistent sandbox retires. */
    persistentRetirementGraceMs: number;
    previewMaxBytes: number;
    logMaxBytes: number;
  };
  modules: {
    /** Non-null means allowlist mode: only named built-ins are requested. */
    enabled: BuiltinModuleId[] | null;
    /** Denylist mode when enabled is null: every built-in except these is requested. */
    disabled: BuiltinModuleId[];
  };
  console: {
    enabled: boolean;
    mcpEnabled: boolean;
    port: number;
    /** Loopback-only by default — the console exposes full reasoning, every
     * conversation, and the journal. */
    host: string;
  };
  kagi: {
    /** Required by the search()/extract() sandbox globals. */
    apiKey: string | null;
  };
  bluesky: {
    /** PDS host, e.g. https://bsky.social */
    service: string;
    /** handle, e.g. agent.example.com */
    identifier: string;
    /** app password (not the account password) */
    appPassword: string;
  } | null;
  secretary: {
    /** Residence secretary is absent unless the Kubernetes-only runtime is enabled. */
    enabled: boolean;
    maxConcurrent: number;
    kubernetes: {
      namespace: string;
      template: string;
      container: string;
      brokerUrl: string | null;
      kubectlPath: string;
      context: string | null;
    };
  };
  workers: {
    /** Native workers are opt-in until a fixed-template spawn broker is configured. */
    enabled: boolean;
    /** Global cap across token-bound worker completions and active worker sessions. */
    maxConcurrent: number;
    /** Token-authenticated completion/Mind/mailbox broker listener. */
    server: {
      enabled: boolean;
      host: string;
      port: number;
    };
    /** Optional clean Git source root and bounded host artifact custody. */
    workspace: {
      sourceRoot: string | null;
      maxSourceBytes: number;
      maxArtifactBytes: number;
    };
    /** Fixed operator-owned Kubernetes worker template. */
    kubernetes: {
      enabled: boolean;
      namespace: string;
      template: string;
      container: string;
      brokerUrl: string | null;
      kubectlPath: string;
      context: string | null;
    };
  };
  /** Provider subscription-usage tracker (console rail widget + /usage). The
   * provider itself is auto-detected from llm.base_url; this section only
   * gates/paces it. */
  usageTracker: {
    /** Escape hatch: false disables polling even when a provider matches. */
    enabled: boolean;
    /** Poll cadence for the provider usage endpoint. */
    pollIntervalMs: number;
  };
  paths: {
    /** The inhabitant corpus/workspace root and sandbox cwd. Harness state lives under elpis-data/. */
    dataDirectory: string;
    /** dataDirectory/SOUL.md. Hot-reloaded into the system prompt every turn. */
    soulPath: string;
    /** dataDirectory/MEMORY.md. Re-read only at a clear/compaction boundary. */
    memoryPath: string;
    /** Harness source root, resolved at boot from import.meta.url. */
    harnessRoot: string;
  };

  /** Leveled logger. Tests pass `noopLogger`. */
  logger: Logger;
  /** Effective log level. */
  logLevel: LogLevel;
}

/**
 * Derive the bot application id from the token when discord.application_id is
 * not set. A Discord bot token is `<base64AppId>.<timestamp>.<hmac>` — the first
 * segment is the base64-encoded application id. Returns '' if it can't be
 * parsed (command registration will then surface a clear error).
 */
function appIdFromToken(token: string): string {
  const first = token.split('.')[0];
  if (!first) return '';
  try {
    const decoded = Buffer.from(first, 'base64').toString('utf8');
    return /^\d+$/.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

/** Resolve the harness source root from the module URL. We run compiled from
 * dist/ or via tsx from src/, so walk up from this file to the package root
 * (the directory containing package.json). */
function resolveHarnessRoot(): string {
  const here = url.fileURLToPath(import.meta.url);
  // dist/config.js → ../ ; src/config.ts → ../
  return path.resolve(path.dirname(here), '..');
}

/** Ensure the inhabitant data root exists. Harness-owned state is scaffolded
 * and migrated separately before any runtime store opens. */
export function ensureDataDirectory(dataDirectory: string): void {
  fs.mkdirSync(dataDirectory, { recursive: true });
}

// ---------------------------------------------------------------------------
// YAML config file (config.yaml)
//
// The file is nested by domain and so is `Config`, but the two are mapped
// explicitly and one-directionally rather than spread — a key only exists once
// it is named here. Accessors take dotted key paths so every error message
// names the exact key the operator has to go fix.
// YAML gives us real scalar types, so numbers/booleans are type-checked rather
// than string-parsed — a bad value is a typed error, not a silent coercion.
// ---------------------------------------------------------------------------

type YamlTree = Record<string, unknown>;

/** Default location of the config file. ELPIS_CONFIG lets immutable images keep
 * operator configuration on a writable mounted volume. */
export function defaultConfigPath(): string {
  return (
    process.env.ELPIS_CONFIG || path.join(resolveHarnessRoot(), 'config.yaml')
  );
}

/** Read a dotted key path out of the parsed tree. Returns undefined for any
 * missing segment (a missing group reads the same as a missing leaf). */
function at(tree: YamlTree, dotted: string): unknown {
  let cur: unknown = tree;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** A required string. Absent and wrongly-typed are DISTINCT diagnoses: telling
 * an operator a key is "missing" while it sits plainly in the file sends them
 * to re-read a line that looks right. */
function reqStr(tree: YamlTree, dotted: string, file: string): string {
  const v = at(tree, dotted);
  if (v === undefined || v === null) {
    throw new Error(
      `${file}: missing required key \`${dotted}\` (expected a non-empty string)`,
    );
  }
  if (typeof v !== 'string') {
    throw new Error(
      `${file}: key \`${dotted}\` must be a non-empty string (got ${Array.isArray(v) ? 'a list' : typeof v})`,
    );
  }
  if (v === '') {
    throw new Error(
      `${file}: key \`${dotted}\` is empty (expected a non-empty string)`,
    );
  }
  return v;
}

/** An optional string: absent, null, or empty all read as null. */
function optStr(tree: YamlTree, dotted: string, file: string): string | null {
  const v = at(tree, dotted);
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') {
    throw new Error(`${file}: key \`${dotted}\` must be a string or null`);
  }
  return v;
}

function numOr(
  tree: YamlTree,
  dotted: string,
  fallback: number,
  file: string,
): number {
  const v = at(tree, dotted);
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${file}: key \`${dotted}\` must be a finite number`);
  }
  return v;
}

/** An optional number: absent or null reads as null (distinct from 0). */
function optNum(tree: YamlTree, dotted: string, file: string): number | null {
  const v = at(tree, dotted);
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(
      `${file}: key \`${dotted}\` must be a finite number or null`,
    );
  }
  return v;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const TIER_VALUES = ['direct', 'social', 'quiet'] as const;
const CHANNEL_MODE_VALUES = ['drop', ...TIER_VALUES] as const;

/** Parse `quiet_hours: "HHMM-HHMM"` into minutes-since-midnight. Wraparound
 * (start > end) is legal — the consumer handles it. Absent/null = none. */
function parseQuietHours(
  raw: unknown,
  slug: string,
  f: string,
): { start: number; end: number } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{4}$/.test(raw)) {
    throw new Error(
      `${f}: guild '${slug}' \`quiet_hours\` must be "HHMM-HHMM" (e.g. "2300-0900"), got ${JSON.stringify(raw)}`,
    );
  }
  const toMin = (s: string): number => {
    const h = Number(s.slice(0, 2)),
      m = Number(s.slice(2));
    if (h > 23 || m > 59)
      throw new Error(
        `${f}: guild '${slug}' \`quiet_hours\` has an invalid time "${s}" (HHMM, 24h)`,
      );
    return h * 60 + m;
  };
  const [a, b] = raw.split('-');
  return { start: toMin(a), end: toMin(b) };
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parse `discord.guilds`: a non-empty list with safe receive/send defaults and
 * optional explicit channel overrides. Every malformed policy is a boot error. */
function parseGuilds(tree: YamlTree, f: string): GuildConfig[] {
  const raw = at(tree, 'discord.guilds');
  if (raw === undefined || raw === null) {
    throw new Error(
      `${f}: missing required key \`discord.guilds\` (a non-empty list of guild entries)`,
    );
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${f}: \`discord.guilds\` must be a non-empty list`);
  }
  const guilds: GuildConfig[] = [];
  const seenIds = new Set<string>(),
    seenSlugs = new Set<string>(),
    seenChannels = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `${f}: each \`discord.guilds\` entry must be a map with id/slug/channels`,
      );
    }
    const g = entry as Record<string, unknown>;
    const defaultTier = g.default_tier === undefined ? 'drop' : g.default_tier;
    if (
      typeof defaultTier !== 'string' ||
      !CHANNEL_MODE_VALUES.includes(defaultTier as ChannelMode)
    ) {
      throw new Error(
        `${f}: guild \`default_tier\` must be one of drop|direct|social|quiet (got ${JSON.stringify(defaultTier)})`,
      );
    }
    const allowSend = g.allow_send === undefined ? true : g.allow_send;
    if (typeof allowSend !== 'boolean') {
      throw new Error(
        `${f}: guild \`allow_send\` must be true or false (got ${JSON.stringify(allowSend)})`,
      );
    }
    const defaultAllowSend =
      g.default_allow_send === undefined ? false : g.default_allow_send;
    if (typeof defaultAllowSend !== 'boolean') {
      throw new Error(
        `${f}: guild \`default_allow_send\` must be true or false (got ${JSON.stringify(defaultAllowSend)})`,
      );
    }
    if (g.id === undefined || g.id === null || g.id === '') {
      throw new Error(`${f}: guild entry missing a non-empty string \`id\``);
    }
    if (typeof g.id !== 'string') {
      throw new Error(
        `${f}: guild \`id\` must be a quoted string (got ${typeof g.id}) — an unquoted Discord snowflake ` +
          `(e.g. \`id: 111111111111111118\`) is parsed by YAML as a number and loses precision; quote it (\`id: "111111111111111118"\`)`,
      );
    }
    const id = g.id;
    if (seenIds.has(id))
      throw new Error(`${f}: duplicate guild id "${id}" in \`discord.guilds\``);
    seenIds.add(id);
    const slug = typeof g.slug === 'string' ? g.slug : '';
    if (!SLUG_RE.test(slug))
      throw new Error(
        `${f}: guild "${id}" \`slug\` must match ^[a-z0-9][a-z0-9-]*$ (got ${JSON.stringify(g.slug)})`,
      );
    if (/^\d+$/.test(slug))
      throw new Error(
        `${f}: guild "${id}" \`slug\` must not be all digits (it would be ambiguous with a raw channel id)`,
      );
    if (seenSlugs.has(slug))
      throw new Error(
        `${f}: duplicate guild slug "${slug}" in \`discord.guilds\``,
      );
    seenSlugs.add(slug);
    const chRaw = g.channels;
    if (
      chRaw !== undefined &&
      (!chRaw || typeof chRaw !== 'object' || Array.isArray(chRaw))
    ) {
      throw new Error(
        `${f}: guild '${slug}' \`channels\` must be a map of channel ids to modes or policy objects`,
      );
    }
    const channelEntries = Object.entries(
      (chRaw ?? {}) as Record<string, unknown>,
    );
    if (channelEntries.length === 0 && defaultTier === 'drop') {
      throw new Error(
        `${f}: guild '${slug}' uses default_tier=drop and requires a non-empty \`channels\` map`,
      );
    }
    const channels: Record<string, ChannelMode> = {};
    const channelAllowSend: Record<string, boolean> = {};
    for (const [cid, rawPolicy] of channelEntries) {
      if (!/^\d+$/.test(cid))
        throw new Error(
          `${f}: guild '${slug}' channel key "${cid}" must be a raw Discord channel id (digits)`,
        );
      let tier: unknown = rawPolicy;
      let channelSend: unknown = true;
      if (
        rawPolicy &&
        typeof rawPolicy === 'object' &&
        !Array.isArray(rawPolicy)
      ) {
        const obj = rawPolicy as Record<string, unknown>;
        const unknown = Object.keys(obj).filter(
          (key) => key !== 'tier' && key !== 'allow_send',
        );
        if (unknown.length > 0)
          throw new Error(
            `${f}: guild '${slug}' channel "${cid}" has unknown policy key(s): ${unknown.join(', ')}`,
          );
        tier = obj.tier;
        channelSend = obj.allow_send === undefined ? true : obj.allow_send;
      }
      if (tier === 'muted')
        throw new Error(
          `${f}: guild '${slug}' channel "${cid}": tier \`muted\` has been renamed \`quiet\` ("mute" now refers to the killswitch)`,
        );
      if (
        typeof tier !== 'string' ||
        !CHANNEL_MODE_VALUES.includes(tier as ChannelMode)
      ) {
        throw new Error(
          `${f}: guild '${slug}' channel "${cid}" tier must be one of drop|direct|social|quiet (got ${JSON.stringify(tier)})`,
        );
      }
      if (typeof channelSend !== 'boolean') {
        throw new Error(
          `${f}: guild '${slug}' channel "${cid}" \`allow_send\` must be true or false (got ${JSON.stringify(channelSend)})`,
        );
      }
      if (seenChannels.has(cid))
        throw new Error(
          `${f}: channel id "${cid}" appears in more than one guild`,
        );
      seenChannels.add(cid);
      channels[cid] = tier as ChannelMode;
      channelAllowSend[cid] = channelSend;
    }
    const timezone =
      typeof g.timezone === 'string' && g.timezone !== '' ? g.timezone : null;
    const quietHours = parseQuietHours(g.quiet_hours, slug, f);
    if (quietHours && timezone && !validTimezone(timezone)) {
      throw new Error(
        `${f}: guild '${slug}' \`timezone\` "${timezone}" is not a valid IANA timezone name`,
      );
    }
    let slashCommands = false;
    if (g.slash_commands !== undefined && g.slash_commands !== null) {
      if (typeof g.slash_commands !== 'boolean') {
        throw new Error(
          `${f}: guild '${slug}' \`slash_commands\` must be true or false (got ${JSON.stringify(g.slash_commands)})`,
        );
      }
      slashCommands = g.slash_commands;
    }
    let pluralKit = false;
    if (g.pluralkit !== undefined && g.pluralkit !== null) {
      if (typeof g.pluralkit !== 'boolean') {
        throw new Error(
          `${f}: guild '${slug}' \`pluralkit\` must be true or false (got ${JSON.stringify(g.pluralkit)})`,
        );
      }
      pluralKit = g.pluralkit;
    }
    guilds.push({
      id,
      slug,
      slashCommands,
      pluralKit,
      quietHours,
      timezone,
      defaultTier: defaultTier as ChannelMode,
      allowSend,
      defaultAllowSend,
      channels,
      channelAllowSend,
    });
  }
  return guilds;
}

function boolOr(
  tree: YamlTree,
  dotted: string,
  fallback: boolean,
  file: string,
): boolean {
  const v = at(tree, dotted);
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') {
    throw new Error(`${file}: key \`${dotted}\` must be true or false`);
  }
  return v;
}

/** A list-of-non-empty-strings key; absent/null falls back to `fallback`. */
function strListOr(
  tree: YamlTree,
  dotted: string,
  fallback: string[],
  file: string,
): string[] {
  const v = at(tree, dotted);
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v))
    throw new Error(`${file}: key \`${dotted}\` must be a list of strings`);
  return v.map((item, i) => {
    if (typeof item !== 'string' || item === '') {
      throw new Error(
        `${file}: key \`${dotted}[${i}]\` must be a non-empty string`,
      );
    }
    return item;
  });
}

/** The ChatGPT subscription token is accepted only by the fixed Codex backend.
 * Pinning the complete base (origin + path) prevents a config typo or hostile
 * endpoint from receiving a high-value OAuth bearer token. */
export function normalizeCodexBaseUrl(
  raw: string | null,
  file = 'config.yaml',
): string {
  const canonical = 'https://chatgpt.com/backend-api';
  if (raw === null) return canonical;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${file}: llm.base_url must be ${canonical} for provider_type=codex-oauth`,
    );
  }
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'chatgpt.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    path !== '/backend-api'
  ) {
    throw new Error(
      `${file}: llm.base_url must be exactly ${canonical} for provider_type=codex-oauth ` +
        '(subscription tokens are never sent to custom endpoints)',
    );
  }
  return canonical;
}

function rawMap(
  value: unknown,
  key: string,
  file: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${file}: key '${key}' must be a mapping`);
  return value as Record<string, unknown>;
}

function rawString(
  map: Record<string, unknown>,
  key: string,
  dotted: string,
  file: string,
  required = false,
): string | null {
  const value = map[key];
  if (value === undefined || value === null || value === '') {
    if (required)
      throw new Error(
        `${file}: missing required key '${dotted}' (expected a non-empty string)`,
      );
    return null;
  }
  if (typeof value !== 'string')
    throw new Error(`${file}: key '${dotted}' must be a non-empty string`);
  return value;
}

function rawNumber(
  map: Record<string, unknown>,
  key: string,
  dotted: string,
  file: string,
): number | null {
  const value = map[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${file}: key '${dotted}' must be a finite number or null`);
  return value;
}

function rawBoolean(
  map: Record<string, unknown>,
  key: string,
  dotted: string,
  file: string,
  fallback: boolean,
): boolean {
  const value = map[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean')
    throw new Error(`${file}: key '${dotted}' must be true or false`);
  return value;
}

function providerType(
  value: string | null,
  dotted: string,
  file: string,
): LlmProviderType {
  const type = value ?? 'openai-compatible';
  if (
    type !== 'openai-compatible' &&
    type !== 'anthropic-oauth' &&
    type !== 'codex-oauth'
  ) {
    throw new Error(
      `${file}: '${dotted}' must be openai-compatible, anthropic-oauth, or codex-oauth`,
    );
  }
  return type;
}

function apiSurface(
  value: string | null,
  dotted: string,
  file: string,
): 'auto' | 'responses' | 'chat' {
  const api = value ?? 'auto';
  if (api !== 'auto' && api !== 'responses' && api !== 'chat')
    throw new Error(`${file}: '${dotted}' must be auto, responses, or chat`);
  return api;
}

function providerBaseUrl(
  type: LlmProviderType,
  configured: string | null,
  dotted: string,
  file: string,
): string {
  if (type === 'anthropic-oauth')
    return configured ?? 'https://api.anthropic.com';
  if (type === 'codex-oauth') return normalizeCodexBaseUrl(configured, file);
  if (!configured) throw new Error(`${file}: missing required key '${dotted}'`);
  return configured;
}

function projectLlmRegistry(
  registry: LlmModelRegistry,
  completionReserveTokens: number,
  source: 'canonical' | 'legacy',
): LlmConfig {
  const main = registry.targets.main;
  return {
    providerType: main.provider.providerType,
    apiKey: main.provider.apiKey,
    baseUrl: main.provider.baseUrl,
    model: main.name,
    contextSize: main.contextSize,
    reasoningEffort: main.reasoningEffort,
    externalThinking: main.provider.externalThinking,
    streamIdleTimeoutMs: main.provider.streamIdleTimeoutMs,
    callTimeoutMs: main.provider.callTimeoutMs,
    api: main.provider.api,
    reasoningSummary: main.reasoningSummary,
    reasoningContext: main.reasoningContext,
    completionReserveTokens,
    registry,
    registrySource: source,
  };
}

export function configForLlmTarget(
  config: Config,
  target: ResolvedLlmTarget,
): Config {
  return {
    ...config,
    llm: {
      ...config.llm,
      providerType: target.provider.providerType,
      apiKey: target.provider.apiKey,
      baseUrl: target.provider.baseUrl,
      model: target.name,
      contextSize: target.contextSize,
      reasoningEffort: target.reasoningEffort,
      externalThinking: target.provider.externalThinking,
      streamIdleTimeoutMs: target.provider.streamIdleTimeoutMs,
      callTimeoutMs: target.provider.callTimeoutMs,
      api: target.provider.api,
      reasoningSummary: target.reasoningSummary,
      reasoningContext: target.reasoningContext,
    },
  };
}

export function configForLlmRef(config: Config, ref: string): Config {
  return configForLlmTarget(
    config,
    resolveLlmModelTarget(config.llm.registry, ref, 'config: worker model'),
  );
}

export function configForLlmRole(config: Config, role: LlmRole): Config {
  const target = config.llm.registry.targets[role];
  if (!target) throw new Error(`config: llm.roles.${role} is not configured`);
  return configForLlmTarget(config, target);
}

function parseLlmConfig(
  tree: YamlTree,
  file: string,
  logger: Logger,
): LlmConfig {
  const completionReserveTokens = numOr(
    tree,
    'llm.completion_reserve_tokens',
    8192,
    file,
  );
  const canonical =
    at(tree, 'llm.providers') !== undefined ||
    at(tree, 'llm.roles') !== undefined;
  if (!canonical) {
    const type = providerType(
      optStr(tree, 'llm.provider_type', file),
      'llm.provider_type',
      file,
    );
    const oauth = type !== 'openai-compatible';
    const api = apiSurface(optStr(tree, 'llm.api', file), 'llm.api', file);
    if (type === 'codex-oauth' && api === 'chat')
      throw new Error(
        `${file}: llm.api=chat is not supported for provider_type=codex-oauth (Codex uses Responses)`,
      );
    const configuredBaseUrl = optStr(tree, 'llm.base_url', file);
    const externalThinking = boolOr(tree, 'llm.external_thinking', false, file);
    if (externalThinking && type !== 'codex-oauth')
      throw new Error(
        `${file}: llm.external_thinking currently requires llm.provider_type=codex-oauth`,
      );
    const legacy: LegacyLlmDefinition = {
      providerType: type,
      apiKey: oauth
        ? (optStr(tree, 'llm.api_key', file) ?? '')
        : reqStr(tree, 'llm.api_key', file),
      baseUrl: providerBaseUrl(type, configuredBaseUrl, 'llm.base_url', file),
      model: reqStr(tree, 'llm.model', file),
      contextSize: optNum(tree, 'llm.context_size', file),
      reasoningEffort: optStr(tree, 'llm.reasoning_effort', file) ?? 'high',
      externalThinking,
      streamIdleTimeoutMs: numOr(
        tree,
        'llm.stream_idle_timeout_ms',
        externalThinking ? 60_000 : 180_000,
        file,
      ),
      callTimeoutMs: numOr(
        tree,
        'llm.call_timeout_ms',
        externalThinking ? 120_000 : 1_200_000,
        file,
      ),
      api,
      reasoningSummary: optStr(tree, 'llm.reasoning_summary', file),
      reasoningContext: optStr(tree, 'llm.reasoning_context', file),
    };
    logger.warn(
      'config: legacy flat llm keys are deprecated; migrate to llm.providers + llm.roles',
    );
    return projectLlmRegistry(
      legacyLlmModelRegistry(legacy, { motorEnabled: true }),
      completionReserveTokens,
      'legacy',
    );
  }

  const legacyKeys = [
    'provider_type',
    'api_key',
    'base_url',
    'model',
    'context_size',
    'reasoning_effort',
    'external_thinking',
    'stream_idle_timeout_ms',
    'call_timeout_ms',
    'api',
    'reasoning_summary',
    'reasoning_context',
  ];
  const mixed = legacyKeys.filter(
    (key) => at(tree, `llm.${key}`) !== undefined,
  );
  if (mixed.length > 0)
    throw new Error(
      `${file}: canonical llm.providers/roles cannot be mixed with legacy llm keys: ${mixed.join(', ')}`,
    );
  const providersRaw = rawMap(at(tree, 'llm.providers'), 'llm.providers', file);
  const providers: Record<string, LlmProviderDefinition> = {};
  for (const [providerId, value] of Object.entries(providersRaw)) {
    const dotted = `llm.providers.${providerId}`;
    const raw = rawMap(value, dotted, file);
    const allowed = new Set([
      'provider_type',
      'api_key',
      'base_url',
      'api',
      'external_thinking',
      'stream_idle_timeout_ms',
      'call_timeout_ms',
      'models',
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length)
      throw new Error(
        `${file}: unknown key(s) under '${dotted}': ${unknown.join(', ')}`,
      );
    const type = providerType(
      rawString(raw, 'provider_type', `${dotted}.provider_type`, file),
      `${dotted}.provider_type`,
      file,
    );
    const api = apiSurface(
      rawString(raw, 'api', `${dotted}.api`, file),
      `${dotted}.api`,
      file,
    );
    if (type === 'codex-oauth' && api === 'chat')
      throw new Error(
        `${file}: '${dotted}.api=chat' is not supported for codex-oauth`,
      );
    const externalThinking = rawBoolean(
      raw,
      'external_thinking',
      `${dotted}.external_thinking`,
      file,
      false,
    );
    const configuredBaseUrl = rawString(
      raw,
      'base_url',
      `${dotted}.base_url`,
      file,
    );
    const modelsRaw = rawMap(raw.models, `${dotted}.models`, file);
    const models: LlmProviderDefinition['models'] = {};
    for (const [modelId, modelValue] of Object.entries(modelsRaw)) {
      const modelDotted = `${dotted}.models.${modelId}`;
      const model = rawMap(modelValue, modelDotted, file);
      const modelAllowed = new Set([
        'name',
        'context_size',
        'reasoning_effort',
        'reasoning_summary',
        'reasoning_context',
      ]);
      const modelUnknown = Object.keys(model).filter(
        (key) => !modelAllowed.has(key),
      );
      if (modelUnknown.length)
        throw new Error(
          `${file}: unknown key(s) under '${modelDotted}': ${modelUnknown.join(', ')}`,
        );
      models[modelId] = {
        name: rawString(model, 'name', `${modelDotted}.name`, file, true)!,
        contextSize: rawNumber(
          model,
          'context_size',
          `${modelDotted}.context_size`,
          file,
        ),
        reasoningEffort:
          rawString(
            model,
            'reasoning_effort',
            `${modelDotted}.reasoning_effort`,
            file,
          ) ?? 'high',
        reasoningSummary: rawString(
          model,
          'reasoning_summary',
          `${modelDotted}.reasoning_summary`,
          file,
        ),
        reasoningContext: rawString(
          model,
          'reasoning_context',
          `${modelDotted}.reasoning_context`,
          file,
        ),
      };
    }
    providers[providerId] = {
      providerType: type,
      apiKey:
        type === 'openai-compatible'
          ? rawString(raw, 'api_key', `${dotted}.api_key`, file, true)!
          : (rawString(raw, 'api_key', `${dotted}.api_key`, file) ?? ''),
      baseUrl: providerBaseUrl(
        type,
        configuredBaseUrl,
        `${dotted}.base_url`,
        file,
      ),
      api,
      externalThinking,
      streamIdleTimeoutMs:
        rawNumber(
          raw,
          'stream_idle_timeout_ms',
          `${dotted}.stream_idle_timeout_ms`,
          file,
        ) ?? (externalThinking ? 60_000 : 180_000),
      callTimeoutMs:
        rawNumber(raw, 'call_timeout_ms', `${dotted}.call_timeout_ms`, file) ??
        (externalThinking ? 120_000 : 1_200_000),
      models,
    };
  }
  const rolesRaw = rawMap(at(tree, 'llm.roles'), 'llm.roles', file);
  const unknownRoles = Object.keys(rolesRaw).filter(
    (key) =>
      key !== 'main' &&
      key !== 'classifier' &&
      key !== 'motor' &&
      key !== 'secretary',
  );
  if (unknownRoles.length)
    throw new Error(
      `${file}: unknown llm.roles key(s): ${unknownRoles.join(', ')}`,
    );
  const registry = createLlmModelRegistry({
    providers,
    roles: {
      main: rawString(rolesRaw, 'main', 'llm.roles.main', file, true)!,
      classifier: rawString(
        rolesRaw,
        'classifier',
        'llm.roles.classifier',
        file,
        true,
      )!,
      motor: rawString(rolesRaw, 'motor', 'llm.roles.motor', file),
      secretary: rawString(rolesRaw, 'secretary', 'llm.roles.secretary', file),
    },
  });
  return projectLlmRegistry(registry, completionReserveTokens, 'canonical');
}

const DUR_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a "friendly duration": a bare number of milliseconds, or a string
 * like "30s" / "2h" / "14d" (suffixes ms/s/m/h/d). Exported for tests and for
 * reuse by any future duration-shaped key. */
export function parseDuration(
  v: unknown,
  dotted: string,
  file: string,
): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(v.trim());
    if (m) return Math.round(parseFloat(m[1]) * DUR_UNITS[m[2]]);
  }
  throw new Error(
    `${file}: key \`${dotted}\` must be a duration like "30s", "2h", "14d" (or a number of milliseconds)`,
  );
}

/** A duration key: absent/null falls back to `fallbackMs`. */
function durOr(
  tree: YamlTree,
  dotted: string,
  fallbackMs: number,
  file: string,
): number {
  const v = at(tree, dotted);
  if (v === undefined || v === null) return fallbackMs;
  return parseDuration(v, dotted, file);
}

/**
 * Load and validate `config.yaml`. Throws on a missing file, a YAML parse
 * error (with line/column), a missing required key, a wrongly-typed value, or
 * a violated compaction invariant. Boot-time failure is deliberately fatal —
 * a half-configured agent is worse than one that refuses to start.
 */
export function loadConfigFile(filePath: string = defaultConfigPath()): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(
      `Config file not readable: ${filePath} — ${e instanceof Error ? e.message : String(e)}. ` +
        `Copy config.example.yaml to config.yaml and fill it in.`,
    );
  }

  let tree: YamlTree;
  try {
    tree = (parseYaml(raw) ?? {}) as YamlTree;
  } catch (e) {
    const pos =
      e instanceof YAMLParseError && e.linePos?.[0]
        ? ` (line ${e.linePos[0].line}, column ${e.linePos[0].col})`
        : '';
    throw new Error(
      `Config parse error in ${filePath}${pos}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof tree !== 'object' || Array.isArray(tree)) {
    throw new Error(
      `Config parse error in ${filePath}: top level must be a mapping`,
    );
  }

  const f = filePath;
  const dataDirectory = path.resolve(reqStr(tree, 'paths.data_directory', f));
  const harnessRoot = resolveHarnessRoot();
  const logLevel = parseLogLevel(optStr(tree, 'log_level', f) ?? undefined);
  const logger = createLogger(logLevel);
  const botToken = reqStr(tree, 'discord.bot_token', f);

  // Compaction thresholds: validate 0 < keep < trigger.
  const compactTriggerTokens = numOr(
    tree,
    'compaction.trigger_tokens',
    180000,
    f,
  );
  const compactKeepTokens = numOr(tree, 'compaction.keep_tokens', 50000, f);
  if (!(compactKeepTokens > 0 && compactKeepTokens < compactTriggerTokens)) {
    throw new Error(
      `${f}: compaction.keep_tokens (${compactKeepTokens}) must satisfy 0 < keep < compaction.trigger_tokens (${compactTriggerTokens})`,
    );
  }

  if (at(tree, 'fleet') !== undefined) {
    throw new Error(
      `${f}: legacy \`fleet\` configuration was removed; use the native \`workers\` section`,
    );
  }

  const llm = parseLlmConfig(tree, f, logger);
  return {
    llm,
    operator: (() => {
      const name = optStr(tree, 'operator.name', f) ?? 'operator';
      if (!name.trim())
        throw new Error(`${f}: key \`operator.name\` must not be empty`);
      return {
        name,
        pronouns: optStr(tree, 'operator.pronouns', f),
        discordId: optStr(tree, 'operator.discord_id', f),
      };
    })(),
    discord: (() => {
      if (at(tree, 'discord.guild_id') !== undefined) {
        throw new Error(
          `${f}: \`discord.guild_id\` has been replaced by the \`discord.guilds\` list — see config.example.yaml for the per-guild shape (id, slug, receive/send policy)`,
        );
      }
      if (at(tree, 'discord.owner_id') !== undefined) {
        throw new Error(
          `${f}: \`discord.owner_id\` has been renamed \`operator.discord_id\``,
        );
      }
      if (at(tree, 'discord.operator_id') !== undefined) {
        throw new Error(
          `${f}: \`discord.operator_id\` has been moved to \`operator.discord_id\``,
        );
      }
      const ignoredUserIds = strListOr(tree, 'discord.ignored_user_ids', [], f);
      for (const [i, id] of ignoredUserIds.entries()) {
        if (!/^\d+$/.test(id))
          throw new Error(
            `${f}: key \`discord.ignored_user_ids[${i}]\` must be a raw Discord user id (digits)`,
          );
      }
      return {
        botToken,
        applicationId:
          optStr(tree, 'discord.application_id', f) ?? appIdFromToken(botToken),
        errorChannelId: optStr(tree, 'discord.error_channel_id', f),
        ignoredUserIds: [...new Set(ignoredUserIds)],
        attachmentInlineMaxBytes: numOr(
          tree,
          'discord.attachment_inline_max_bytes',
          32768,
          f,
        ),
        ambientTickMs: numOr(tree, 'discord.ambient_tick_ms', 600_000, f),
        ambientAllowSend: boolOr(tree, 'discord.ambient_allow_send', true, f),
        emoteImages: boolOr(tree, 'discord.emote_images', true, f),
        emoteKeyframes: numOr(tree, 'discord.emote_keyframes', 4, f),
        guilds: parseGuilds(tree, f),
      };
    })(),
    compaction: {
      triggerTokens: compactTriggerTokens,
      keepTokens: compactKeepTokens,
    },
    memory: (() => {
      const consolidationThresholdTokens = numOr(
        tree,
        'memory.consolidation_threshold_tokens',
        32_000,
        f,
      );
      const defaultTarget =
        consolidationThresholdTokens > 0
          ? Math.min(
              24_000,
              Math.max(1, Math.floor(consolidationThresholdTokens * 0.75)),
            )
          : 24_000;
      const consolidationTargetTokens = numOr(
        tree,
        'memory.consolidation_target_tokens',
        defaultTarget,
        f,
      );
      if (
        !Number.isInteger(consolidationThresholdTokens) ||
        consolidationThresholdTokens < 0
      ) {
        throw new Error(
          `${f}: memory.consolidation_threshold_tokens must be a non-negative integer (0 disables)`,
        );
      }
      if (
        !Number.isInteger(consolidationTargetTokens) ||
        consolidationTargetTokens <= 0
      ) {
        throw new Error(
          `${f}: memory.consolidation_target_tokens must be a positive integer`,
        );
      }
      if (
        consolidationThresholdTokens > 0 &&
        consolidationTargetTokens >= consolidationThresholdTokens
      ) {
        throw new Error(
          `${f}: memory.consolidation_target_tokens must be below memory.consolidation_threshold_tokens`,
        );
      }
      return { consolidationThresholdTokens, consolidationTargetTokens };
    })(),
    heartbeat: {
      intervalMs: numOr(tree, 'heartbeat.interval_ms', 60 * 60 * 1000, f),
      maxIntervalMs: numOr(
        tree,
        'heartbeat.max_interval_ms',
        4 * 60 * 60 * 1000,
        f,
      ),
      reflectionMinMessages: numOr(
        tree,
        'heartbeat.reflection_min_messages',
        3,
        f,
      ),
      socialNudgeMs: numOr(
        tree,
        'heartbeat.social_nudge_ms',
        12 * 60 * 60 * 1000,
        f,
      ),
    },
    sandbox: {
      syncTimeoutMs: numOr(tree, 'sandbox.sync_timeout_ms', 15000, f),
      asyncDeadlineMs: numOr(tree, 'sandbox.async_deadline_ms', 120000, f),
      persistentRetirementGraceMs: (() => {
        const currentKey = 'sandbox.persistent_retirement_grace_ms';
        const legacyKey = 'sandbox.persistent_idle_gc_ms';
        const current = at(tree, currentKey);
        const legacy = at(tree, legacyKey);
        if (current !== undefined && legacy !== undefined) {
          throw new Error(
            `${f}: ${currentKey} and legacy ${legacyKey} are mutually exclusive`,
          );
        }
        const key = legacy !== undefined ? legacyKey : currentKey;
        const value = numOr(tree, key, 10 * 60 * 1000, f);
        if (!Number.isInteger(value) || value < 0)
          throw new Error(`${f}: ${key} must be a non-negative integer`);
        return value;
      })(),
      previewMaxBytes: numOr(tree, 'sandbox.preview_max_bytes', 16384, f),
      logMaxBytes: numOr(tree, 'sandbox.log_max_bytes', 32768, f),
    },
    modules: (() => {
      const enabledPresent = at(tree, 'modules.enabled') !== undefined;
      const disabledPresent = at(tree, 'modules.disabled') !== undefined;
      if (enabledPresent && disabledPresent) {
        throw new Error(
          `${f}: \`modules.enabled\` and \`modules.disabled\` are mutually exclusive`,
        );
      }
      const validate = (key: 'enabled' | 'disabled'): BuiltinModuleId[] => {
        const values = strListOr(tree, `modules.${key}`, [], f);
        const seen = new Set<string>();
        return values.map((value, index) => {
          if (!(BUILTIN_MODULE_IDS as readonly string[]).includes(value)) {
            throw new Error(
              `${f}: key \`modules.${key}[${index}]\` names unknown module '${value}' (expected one of: ${BUILTIN_MODULE_IDS.join(', ')})`,
            );
          }
          if (seen.has(value))
            throw new Error(
              `${f}: key \`modules.${key}\` contains duplicate module '${value}'`,
            );
          seen.add(value);
          return value as BuiltinModuleId;
        });
      };
      return enabledPresent
        ? { enabled: validate('enabled'), disabled: [] }
        : {
            enabled: null,
            disabled: disabledPresent ? validate('disabled') : [],
          };
    })(),
    console: {
      enabled: boolOr(tree, 'console.enabled', true, f),
      mcpEnabled: boolOr(tree, 'console.mcp_enabled', false, f),
      port: numOr(tree, 'console.port', 8787, f),
      host: optStr(tree, 'console.host', f) ?? '127.0.0.1',
    },
    kagi: { apiKey: optStr(tree, 'kagi.api_key', f) },
    bluesky: (() => {
      const id = optStr(tree, 'bluesky.identifier', f);
      const pw = optStr(tree, 'bluesky.app_password', f);
      if (!id || !pw) return null;
      return {
        service: optStr(tree, 'bluesky.service', f) ?? 'https://bsky.social',
        identifier: id,
        appPassword: pw,
      };
    })(),
    workers: (() => {
      const raw = at(tree, 'workers');
      if (
        raw !== undefined &&
        (!raw || typeof raw !== 'object' || Array.isArray(raw))
      )
        throw new Error(`${f}: workers must be a mapping`);
      const mapping = (raw ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(mapping).filter(
        (key) =>
          ![
            'enabled',
            'max_concurrent',
            'server',
            'workspace',
            'kubernetes',
          ].includes(key),
      );
      if (unknown.length)
        throw new Error(`${f}: unknown workers key(s): ${unknown.join(', ')}`);
      for (const [pathKey, allowed] of [
        ['workers.server', ['enabled', 'host', 'port']],
        [
          'workers.workspace',
          ['source_root', 'max_source_bytes', 'max_artifact_bytes'],
        ],
        [
          'workers.kubernetes',
          [
            'enabled',
            'namespace',
            'template',
            'container',
            'broker_url',
            'kubectl_path',
            'context',
          ],
        ],
      ] as const) {
        const nested = at(tree, pathKey);
        if (nested === undefined) continue;
        if (!nested || typeof nested !== 'object' || Array.isArray(nested))
          throw new Error(`${f}: ${pathKey} must be a mapping`);
        const nestedUnknown = Object.keys(nested).filter(
          (key) => !(allowed as readonly string[]).includes(key),
        );
        if (nestedUnknown.length)
          throw new Error(
            `${f}: unknown ${pathKey} key(s): ${nestedUnknown.join(', ')}`,
          );
      }
      const enabled = boolOr(tree, 'workers.enabled', false, f);
      const maxConcurrent = numOr(tree, 'workers.max_concurrent', 4, f);
      if (
        !Number.isInteger(maxConcurrent) ||
        maxConcurrent < 1 ||
        maxConcurrent > 128
      )
        throw new Error(
          `${f}: workers.max_concurrent must be an integer from 1 to 128`,
        );
      const port = numOr(tree, 'workers.server.port', 8790, f);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error(
          `${f}: workers.server.port must be an integer from 1 to 65535`,
        );
      const server = {
        enabled: boolOr(tree, 'workers.server.enabled', false, f),
        host: optStr(tree, 'workers.server.host', f) ?? '127.0.0.1',
        port,
      };
      const sourceRoot = optStr(tree, 'workers.workspace.source_root', f);
      if (sourceRoot !== null && !path.isAbsolute(sourceRoot))
        throw new Error(
          `${f}: workers.workspace.source_root must be an absolute path`,
        );
      const maxSourceBytes = numOr(
        tree,
        'workers.workspace.max_source_bytes',
        8 * 1024 * 1024,
        f,
      );
      const maxArtifactBytes = numOr(
        tree,
        'workers.workspace.max_artifact_bytes',
        8 * 1024 * 1024,
        f,
      );
      for (const [key, value] of [
        ['max_source_bytes', maxSourceBytes],
        ['max_artifact_bytes', maxArtifactBytes],
      ] as const) {
        if (
          !Number.isSafeInteger(value) ||
          value < 1024 ||
          value > 64 * 1024 * 1024
        )
          throw new Error(
            `${f}: workers.workspace.${key} must be an integer from 1024 to 67108864`,
          );
      }
      const workspace = { sourceRoot, maxSourceBytes, maxArtifactBytes };
      const kubernetesEnabled = boolOr(
        tree,
        'workers.kubernetes.enabled',
        false,
        f,
      );
      const kubernetes = {
        enabled: kubernetesEnabled,
        namespace:
          optStr(tree, 'workers.kubernetes.namespace', f) ?? 'elpis-workers',
        template:
          optStr(tree, 'workers.kubernetes.template', f) ?? 'elpis-worker',
        container: optStr(tree, 'workers.kubernetes.container', f) ?? 'worker',
        brokerUrl: optStr(tree, 'workers.kubernetes.broker_url', f),
        kubectlPath:
          optStr(tree, 'workers.kubernetes.kubectl_path', f) ?? 'kubectl',
        context: optStr(tree, 'workers.kubernetes.context', f),
      };
      const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
      for (const [key, value] of [
        ['namespace', kubernetes.namespace],
        ['template', kubernetes.template],
        ['container', kubernetes.container],
      ] as const) {
        if (!dnsLabel.test(value) || value.length > 63)
          throw new Error(
            `${f}: workers.kubernetes.${key} must be a Kubernetes DNS label`,
          );
      }
      if (!kubernetes.kubectlPath)
        throw new Error(
          `${f}: workers.kubernetes.kubectl_path must not be empty`,
        );
      if (kubernetes.brokerUrl !== null) {
        let broker: URL;
        try {
          broker = new URL(kubernetes.brokerUrl);
        } catch {
          throw new Error(
            `${f}: workers.kubernetes.broker_url must be an absolute http(s) origin`,
          );
        }
        if (
          (broker.protocol !== 'http:' && broker.protocol !== 'https:') ||
          broker.username ||
          broker.password ||
          broker.search ||
          broker.hash ||
          (broker.pathname !== '/' && broker.pathname !== '')
        )
          throw new Error(
            `${f}: workers.kubernetes.broker_url must be a credential-free http(s) origin`,
          );
        kubernetes.brokerUrl = broker.origin;
      }
      if (kubernetesEnabled) {
        if (!enabled)
          throw new Error(
            `${f}: workers.kubernetes.enabled requires workers.enabled`,
          );
        if (!server.enabled)
          throw new Error(
            `${f}: workers.kubernetes.enabled requires workers.server.enabled`,
          );
        if (!kubernetes.brokerUrl)
          throw new Error(
            `${f}: workers.kubernetes.enabled requires workers.kubernetes.broker_url`,
          );
      }
      return { enabled, maxConcurrent, server, workspace, kubernetes };
    })(),
    secretary: (() => {
      const raw = at(tree, 'secretary');
      if (
        raw !== undefined &&
        (!raw || typeof raw !== 'object' || Array.isArray(raw))
      )
        throw new Error(`${f}: secretary must be a mapping`);
      const mapping = (raw ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(mapping).filter(
        (key) => !['enabled', 'max_concurrent', 'kubernetes'].includes(key),
      );
      if (unknown.length)
        throw new Error(
          `${f}: unknown secretary key(s): ${unknown.join(', ')}`,
        );
      const kubernetesRaw = at(tree, 'secretary.kubernetes');
      if (
        kubernetesRaw !== undefined &&
        (!kubernetesRaw ||
          typeof kubernetesRaw !== 'object' ||
          Array.isArray(kubernetesRaw))
      )
        throw new Error(`${f}: secretary.kubernetes must be a mapping`);
      const kubernetesMapping = (kubernetesRaw ?? {}) as Record<
        string,
        unknown
      >;
      const kubernetesUnknown = Object.keys(kubernetesMapping).filter(
        (key) =>
          ![
            'namespace',
            'template',
            'container',
            'broker_url',
            'kubectl_path',
            'context',
          ].includes(key),
      );
      if (kubernetesUnknown.length)
        throw new Error(
          `${f}: unknown secretary.kubernetes key(s): ${kubernetesUnknown.join(', ')}`,
        );
      const enabled = boolOr(tree, 'secretary.enabled', false, f);
      const maxConcurrent = numOr(tree, 'secretary.max_concurrent', 1, f);
      if (
        !Number.isInteger(maxConcurrent) ||
        maxConcurrent < 1 ||
        maxConcurrent > 32
      )
        throw new Error(
          `${f}: secretary.max_concurrent must be an integer from 1 to 32`,
        );
      const kubernetes = {
        namespace:
          optStr(tree, 'secretary.kubernetes.namespace', f) ??
          'elpis-residence',
        template:
          optStr(tree, 'secretary.kubernetes.template', f) ?? 'elpis-secretary',
        container:
          optStr(tree, 'secretary.kubernetes.container', f) ?? 'secretary',
        brokerUrl: optStr(tree, 'secretary.kubernetes.broker_url', f),
        kubectlPath:
          optStr(tree, 'secretary.kubernetes.kubectl_path', f) ?? 'kubectl',
        context: optStr(tree, 'secretary.kubernetes.context', f),
      };
      const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
      for (const [key, value] of [
        ['namespace', kubernetes.namespace],
        ['template', kubernetes.template],
        ['container', kubernetes.container],
      ] as const)
        if (!dnsLabel.test(value) || value.length > 63)
          throw new Error(
            `${f}: secretary.kubernetes.${key} must be a Kubernetes DNS label`,
          );
      if (!kubernetes.kubectlPath)
        throw new Error(
          `${f}: secretary.kubernetes.kubectl_path must not be empty`,
        );
      if (kubernetes.brokerUrl !== null) {
        let broker: URL;
        try {
          broker = new URL(kubernetes.brokerUrl);
        } catch {
          throw new Error(
            `${f}: secretary.kubernetes.broker_url must be an absolute http(s) origin`,
          );
        }
        if (
          (broker.protocol !== 'http:' && broker.protocol !== 'https:') ||
          broker.username ||
          broker.password ||
          broker.search ||
          broker.hash ||
          (broker.pathname !== '/' && broker.pathname !== '')
        )
          throw new Error(
            `${f}: secretary.kubernetes.broker_url must be a credential-free http(s) origin`,
          );
        kubernetes.brokerUrl = broker.origin;
      }
      if (enabled) {
        if (!llm.registry.roles.secretary)
          throw new Error(
            `${f}: secretary.enabled requires llm.roles.secretary`,
          );
        if (!boolOr(tree, 'workers.server.enabled', false, f))
          throw new Error(
            `${f}: secretary.enabled requires workers.server.enabled`,
          );
        if (!kubernetes.brokerUrl)
          throw new Error(
            `${f}: secretary.enabled requires secretary.kubernetes.broker_url`,
          );
      }
      return { enabled, maxConcurrent, kubernetes };
    })(),
    usageTracker: {
      enabled: boolOr(tree, 'usage_tracker.enabled', true, f),
      pollIntervalMs: numOr(tree, 'usage_tracker.poll_interval_ms', 300000, f),
    },
    paths: {
      dataDirectory,
      soulPath: path.join(dataDirectory, 'SOUL.md'),
      memoryPath: path.join(dataDirectory, 'MEMORY.md'),
      harnessRoot,
    },
    logger,
    logLevel,
  };
}
