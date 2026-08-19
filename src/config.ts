import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { createLogger, parseLogLevel, type LogLevel, type Logger } from './lib/log.js';
import { BUILTIN_MODULE_IDS, type BuiltinModuleId } from './builtin-modules.js';
import {
  createLlmModelRegistry,
  legacyLlmModelRegistry,
  type LegacyLlmDefinition,
  type LlmModelRegistry,
  type LlmProviderDefinition,
  type LlmProviderType,
  type LlmRole,
} from './llm/model-registry.js';

/** The Claude Agent SDK alias slots backed by ANTHROPIC_DEFAULT_<ALIAS>_MODEL. */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type FleetModelAlias = (typeof MODEL_ALIASES)[number];

/**
 * One `fleet.models.<alias>` entry. Two YAML spellings collapse to this shape:
 *
 * opus: big-model → { name: 'big-model', context: null }
 * opus: { name: big-model, context: 262144 }
 *
 * The string shorthand is the common case (remap the alias, let the context
 * window be discovered); the mapping form pins the window explicitly and so
 * skips the `models/info` probe for any session running on that model.
 */
export interface FleetModelOverride {
  /** → ANTHROPIC_DEFAULT_<ALIAS>_MODEL. null keeps the SDK's own alias target. */
  name: string | null;
  /** Context window in tokens → CLAUDE_CODE_MAX_CONTEXT_TOKENS. null = probe. */
  context: number | null;
}

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
    /** Closed persistent sandboxes remain warm until idle for this duration. */
    persistentIdleGcMs: number;
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
  fleet: {
    /** false disables the fleet entirely: no registry is constructed, boot
 * recovery is skipped, elpis.fleet.* verbs throw a teachable error, and
 * the system prompt swaps the elpis.fleet section for a "not available —
 * do the work yourself" note. ON by default (opt-out). */
    enabled: boolean;
    /** Max concurrently-running fleet agents. */
    maxConcurrent: number;
    /** Default Claude Agent SDK model for a spawned agent. null = don't send
 * `options.model` at all — the SDK picks its own default. */
    defaultModel: string | null;
    /** Default reasoning effort for a spawned agent. null = don't send
 * `options.effort` at all — the SDK picks its own default. */
    defaultEffort: string | null;
    /** Reasoning-effort values this endpoint accepts. Defaults to the Claude
 * Agent SDK's own `EffortLevel` union; a custom endpoint can narrow or
 * rename it. `[]` = the endpoint has no effort parameter. */
    efforts: string[];
    /** API endpoint overrides for the SDK subprocess. Each null field is simply
 * not set in the child env, so the SDK falls back to its own default. */
    endpoint: {
      /** → ANTHROPIC_BASE_URL */
      baseUrl: string | null;
      /** → ANTHROPIC_API_KEY (the ONLY config path that can set it — see buildEnv). */
      apiKey: string | null;
      /** → ANTHROPIC_AUTH_TOKEN */
      authToken: string | null;
    };
    /** SDK model-alias overrides. `name` → ANTHROPIC_DEFAULT_<ALIAS>_MODEL (null
 * leaves the SDK's own alias table alone); `context` → this model's context
 * window in tokens, which SKIPS the models/info probe when a session runs
 * on it (null = probe). Both null = the alias is entirely unconfigured. */
    models: Record<FleetModelAlias, FleetModelOverride>;
    /** An idle runner exits gracefully after this long with no activity; the
 * session stays revivable via elpis.fleet.send. */
    idleTimeoutMs: number;
    /** Deletes the on-disk session dir of DISMISSED sessions this long after
 * dismissal; DB rows are kept forever. */
    reapAfterMs: number;
    /** Extra environment variables passed to every spawned agent. */
    env: Record<string, string>;
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
  return process.env.ELPIS_CONFIG || path.join(resolveHarnessRoot(), 'config.yaml');
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
    throw new Error(`${file}: missing required key \`${dotted}\` (expected a non-empty string)`);
  }
  if (typeof v !== 'string') {
    throw new Error(`${file}: key \`${dotted}\` must be a non-empty string (got ${Array.isArray(v) ? 'a list' : typeof v})`);
  }
  if (v === '') {
    throw new Error(`${file}: key \`${dotted}\` is empty (expected a non-empty string)`);
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

function numOr(tree: YamlTree, dotted: string, fallback: number, file: string): number {
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
    throw new Error(`${file}: key \`${dotted}\` must be a finite number or null`);
  }
  return v;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const TIER_VALUES = ['direct', 'social', 'quiet'] as const;
const CHANNEL_MODE_VALUES = ['drop', ...TIER_VALUES] as const;

/** Parse `quiet_hours: "HHMM-HHMM"` into minutes-since-midnight. Wraparound
 * (start > end) is legal — the consumer handles it. Absent/null = none. */
function parseQuietHours(raw: unknown, slug: string, f: string): { start: number; end: number } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{4}$/.test(raw)) {
    throw new Error(`${f}: guild '${slug}' \`quiet_hours\` must be "HHMM-HHMM" (e.g. "2300-0900"), got ${JSON.stringify(raw)}`);
  }
  const toMin = (s: string): number => {
    const h = Number(s.slice(0, 2)), m = Number(s.slice(2));
    if (h > 23 || m > 59) throw new Error(`${f}: guild '${slug}' \`quiet_hours\` has an invalid time "${s}" (HHMM, 24h)`);
    return h * 60 + m;
  };
  const [a, b] = raw.split('-');
  return { start: toMin(a), end: toMin(b) };
}

function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Parse `discord.guilds`: a non-empty list with safe receive/send defaults and
 * optional explicit channel overrides. Every malformed policy is a boot error. */
function parseGuilds(tree: YamlTree, f: string): GuildConfig[] {
  const raw = at(tree, 'discord.guilds');
  if (raw === undefined || raw === null) {
    throw new Error(`${f}: missing required key \`discord.guilds\` (a non-empty list of guild entries)`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${f}: \`discord.guilds\` must be a non-empty list`);
  }
  const guilds: GuildConfig[] = [];
  const seenIds = new Set<string>(), seenSlugs = new Set<string>(), seenChannels = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${f}: each \`discord.guilds\` entry must be a map with id/slug/channels`);
    }
    const g = entry as Record<string, unknown>;
    const defaultTier = g.default_tier === undefined ? 'drop' : g.default_tier;
    if (typeof defaultTier !== 'string' || !CHANNEL_MODE_VALUES.includes(defaultTier as ChannelMode)) {
      throw new Error(`${f}: guild \`default_tier\` must be one of drop|direct|social|quiet (got ${JSON.stringify(defaultTier)})`);
    }
    const allowSend = g.allow_send === undefined ? true : g.allow_send;
    if (typeof allowSend !== 'boolean') {
      throw new Error(`${f}: guild \`allow_send\` must be true or false (got ${JSON.stringify(allowSend)})`);
    }
    const defaultAllowSend = g.default_allow_send === undefined ? false : g.default_allow_send;
    if (typeof defaultAllowSend !== 'boolean') {
      throw new Error(`${f}: guild \`default_allow_send\` must be true or false (got ${JSON.stringify(defaultAllowSend)})`);
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
    if (seenIds.has(id)) throw new Error(`${f}: duplicate guild id "${id}" in \`discord.guilds\``);
    seenIds.add(id);
    const slug = typeof g.slug === 'string' ? g.slug : '';
    if (!SLUG_RE.test(slug)) throw new Error(`${f}: guild "${id}" \`slug\` must match ^[a-z0-9][a-z0-9-]*$ (got ${JSON.stringify(g.slug)})`);
    if (/^\d+$/.test(slug)) throw new Error(`${f}: guild "${id}" \`slug\` must not be all digits (it would be ambiguous with a raw channel id)`);
    if (seenSlugs.has(slug)) throw new Error(`${f}: duplicate guild slug "${slug}" in \`discord.guilds\``);
    seenSlugs.add(slug);
    const chRaw = g.channels;
    if (chRaw !== undefined && (!chRaw || typeof chRaw !== 'object' || Array.isArray(chRaw))) {
      throw new Error(`${f}: guild '${slug}' \`channels\` must be a map of channel ids to modes or policy objects`);
    }
    const channelEntries = Object.entries((chRaw ?? {}) as Record<string, unknown>);
    if (channelEntries.length === 0 && defaultTier === 'drop') {
      throw new Error(`${f}: guild '${slug}' uses default_tier=drop and requires a non-empty \`channels\` map`);
    }
    const channels: Record<string, ChannelMode> = {};
    const channelAllowSend: Record<string, boolean> = {};
    for (const [cid, rawPolicy] of channelEntries) {
      if (!/^\d+$/.test(cid)) throw new Error(`${f}: guild '${slug}' channel key "${cid}" must be a raw Discord channel id (digits)`);
      let tier: unknown = rawPolicy;
      let channelSend: unknown = true;
      if (rawPolicy && typeof rawPolicy === 'object' && !Array.isArray(rawPolicy)) {
        const obj = rawPolicy as Record<string, unknown>;
        const unknown = Object.keys(obj).filter((key) => key !== 'tier' && key !== 'allow_send');
        if (unknown.length > 0) throw new Error(`${f}: guild '${slug}' channel "${cid}" has unknown policy key(s): ${unknown.join(', ')}`);
        tier = obj.tier;
        channelSend = obj.allow_send === undefined ? true : obj.allow_send;
      }
      if (tier === 'muted') throw new Error(`${f}: guild '${slug}' channel "${cid}": tier \`muted\` has been renamed \`quiet\` ("mute" now refers to the killswitch)`);
      if (typeof tier !== 'string' || !CHANNEL_MODE_VALUES.includes(tier as ChannelMode)) {
        throw new Error(`${f}: guild '${slug}' channel "${cid}" tier must be one of drop|direct|social|quiet (got ${JSON.stringify(tier)})`);
      }
      if (typeof channelSend !== 'boolean') {
        throw new Error(`${f}: guild '${slug}' channel "${cid}" \`allow_send\` must be true or false (got ${JSON.stringify(channelSend)})`);
      }
      if (seenChannels.has(cid)) throw new Error(`${f}: channel id "${cid}" appears in more than one guild`);
      seenChannels.add(cid);
      channels[cid] = tier as ChannelMode;
      channelAllowSend[cid] = channelSend;
    }
    const timezone = typeof g.timezone === 'string' && g.timezone !== '' ? g.timezone : null;
    const quietHours = parseQuietHours(g.quiet_hours, slug, f);
    if (quietHours && timezone && !validTimezone(timezone)) {
      throw new Error(`${f}: guild '${slug}' \`timezone\` "${timezone}" is not a valid IANA timezone name`);
    }
    let slashCommands = false;
    if (g.slash_commands !== undefined && g.slash_commands !== null) {
      if (typeof g.slash_commands !== 'boolean') {
        throw new Error(`${f}: guild '${slug}' \`slash_commands\` must be true or false (got ${JSON.stringify(g.slash_commands)})`);
      }
      slashCommands = g.slash_commands;
    }
    let pluralKit = false;
    if (g.pluralkit !== undefined && g.pluralkit !== null) {
      if (typeof g.pluralkit !== 'boolean') {
        throw new Error(`${f}: guild '${slug}' \`pluralkit\` must be true or false (got ${JSON.stringify(g.pluralkit)})`);
      }
      pluralKit = g.pluralkit;
    }
    guilds.push({ id, slug, slashCommands, pluralKit, quietHours, timezone, defaultTier: defaultTier as ChannelMode, allowSend, defaultAllowSend, channels, channelAllowSend });
  }
  return guilds;
}

function boolOr(tree: YamlTree, dotted: string, fallback: boolean, file: string): boolean {
  const v = at(tree, dotted);
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') {
    throw new Error(`${file}: key \`${dotted}\` must be true or false`);
  }
  return v;
}

/** A string key that distinguishes ABSENT from an explicit `null`. Absent means
 * "no opinion, use the fallback"; explicit `null` means "deliberately unset"
 * — for the fleet SDK knobs those are different requests (inherit our default
 * vs. don't send the option to the Agent SDK at all), so they can't collapse
 * the way optStr collapses them. */
function nullableStr(tree: YamlTree, dotted: string, file: string): string | null | undefined {
  const v = at(tree, dotted);
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${file}: key \`${dotted}\` must be a string or null`);
  return v;
}

/** A list-of-non-empty-strings key; absent/null falls back to `fallback`. */
function strListOr(tree: YamlTree, dotted: string, fallback: string[], file: string): string[] {
  const v = at(tree, dotted);
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) throw new Error(`${file}: key \`${dotted}\` must be a list of strings`);
  return v.map((item, i) => {
    if (typeof item !== 'string' || item === '') {
      throw new Error(`${file}: key \`${dotted}[${i}]\` must be a non-empty string`);
    }
    return item;
  });
}

/** The Claude Agent SDK's own `EffortLevel` union — the default for
 * `fleet.efforts` so an un-configured harness accepts exactly what the SDK
 * does. Kept in sync with `EffortLevel` in the pinned sdk.d.ts. */
export const SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * One `fleet.models.<alias>` entry, accepting either spelling:
 *
 * opus: big-model (string shorthand — context probed)
 * opus: { name: big-model, context: 262144 }
 *
 * `context` alone is legal too (`opus: { context: N }`): keep the SDK's own
 * alias target but pin its window. Absent/null reads as the fully-unset entry.
 */
function modelOverride(tree: YamlTree, dotted: string, file: string): FleetModelOverride {
  const v = at(tree, dotted);
  if (v === undefined || v === null || v === '') return { name: null, context: null };
  if (typeof v === 'string') return { name: v, context: null };
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${file}: key \`${dotted}\` must be a model name or a mapping of { name, context }`);
  }
  for (const k of Object.keys(v as Record<string, unknown>)) {
    if (k !== 'name' && k !== 'context') {
      throw new Error(`${file}: unknown key \`${dotted}.${k}\` (expected \`name\` and/or \`context\`)`);
    }
  }
  const context = optNum(tree, `${dotted}.context`, file);
  if (context !== null && !(context > 0)) {
    throw new Error(`${file}: key \`${dotted}.context\` must be a positive number of tokens`);
  }
  return { name: optStr(tree, `${dotted}.name`, file), context };
}

/**
 * Normalize `fleet.base_url` to the shape `ANTHROPIC_BASE_URL` actually wants:
 * the API ROOT, with no version segment. The Claude CLI appends `//messages`
 * itself, so a base ending in `/` produces `///messages` — a 404 the CLI
 * surfaces as the deeply unhelpful "There's an issue with the selected model
 * (…). It may not exist or you may not have access to it."
 *
 * That trailing `/` is the single most likely mistake here, because the
 * adjacent `llm.base_url` key REQUIRES it (an OpenAI-compatible client posts to
 * `<base>/chat/completions`, so its base carries the version). Two neighbouring
 * URL keys with opposite conventions is a trap, so rather than let it fail
 * three layers down inside a detached subprocess, strip it and say so loudly.
 * Warn-and-normalize, never silent: the operator still learns their file is
 * wrong, but a fleet-only typo doesn't have to take the harness down at boot.
 */
export function normalizeAnthropicBaseUrl(url: string | null, logger?: Logger): string | null {
  if (url === null) return null;
  const trimmed = url.replace(/\/+$/, '');
  const stripped = trimmed.replace(/\/v\d+$/, '');
  if (stripped !== trimmed) {
    logger?.warn(
      `config: fleet.base_url ended in a version segment ('${url}') — using '${stripped}'. ` +
        `ANTHROPIC_BASE_URL is the API root; the Claude CLI appends /v1/messages itself. ` +
        `(llm.base_url is different — that one does need its /v1.)`,
    );
  }
  return stripped === '' ? null : stripped;
}

/** The ChatGPT subscription token is accepted only by the fixed Codex backend.
 * Pinning the complete base (origin + path) prevents a config typo or hostile
 * endpoint from receiving a high-value OAuth bearer token. */
export function normalizeCodexBaseUrl(raw: string | null, file = 'config.yaml'): string {
  const canonical = 'https://chatgpt.com/backend-api';
  if (raw === null) return canonical;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${file}: llm.base_url must be ${canonical} for provider_type=codex-oauth`);
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

function rawMap(value: unknown, key: string, file: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: key '${key}' must be a mapping`);
  return value as Record<string, unknown>;
}

function rawString(map: Record<string, unknown>, key: string, dotted: string, file: string, required = false): string | null {
  const value = map[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${file}: missing required key '${dotted}' (expected a non-empty string)`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${file}: key '${dotted}' must be a non-empty string`);
  return value;
}

function rawNumber(map: Record<string, unknown>, key: string, dotted: string, file: string): number | null {
  const value = map[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${file}: key '${dotted}' must be a finite number or null`);
  return value;
}

function rawBoolean(map: Record<string, unknown>, key: string, dotted: string, file: string, fallback: boolean): boolean {
  const value = map[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${file}: key '${dotted}' must be true or false`);
  return value;
}

function providerType(value: string | null, dotted: string, file: string): LlmProviderType {
  const type = value ?? 'openai-compatible';
  if (type !== 'openai-compatible' && type !== 'anthropic-oauth' && type !== 'codex-oauth') {
    throw new Error(`${file}: '${dotted}' must be openai-compatible, anthropic-oauth, or codex-oauth`);
  }
  return type;
}

function apiSurface(value: string | null, dotted: string, file: string): 'auto' | 'responses' | 'chat' {
  const api = value ?? 'auto';
  if (api !== 'auto' && api !== 'responses' && api !== 'chat') throw new Error(`${file}: '${dotted}' must be auto, responses, or chat`);
  return api;
}

function providerBaseUrl(type: LlmProviderType, configured: string | null, dotted: string, file: string): string {
  if (type === 'anthropic-oauth') return configured ?? 'https://api.anthropic.com';
  if (type === 'codex-oauth') return normalizeCodexBaseUrl(configured, file);
  if (!configured) throw new Error(`${file}: missing required key '${dotted}'`);
  return configured;
}

function projectLlmRegistry(registry: LlmModelRegistry, completionReserveTokens: number, source: 'canonical' | 'legacy'): LlmConfig {
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

export function configForLlmRole(config: Config, role: LlmRole): Config {
  const target = config.llm.registry.targets[role];
  if (!target) throw new Error(`config: llm.roles.${role} is not configured`);
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

function parseLlmConfig(tree: YamlTree, file: string, logger: Logger): LlmConfig {
  const completionReserveTokens = numOr(tree, 'llm.completion_reserve_tokens', 8192, file);
  const canonical = at(tree, 'llm.providers') !== undefined || at(tree, 'llm.roles') !== undefined;
  if (!canonical) {
    const type = providerType(optStr(tree, 'llm.provider_type', file), 'llm.provider_type', file);
    const oauth = type !== 'openai-compatible';
    const api = apiSurface(optStr(tree, 'llm.api', file), 'llm.api', file);
    if (type === 'codex-oauth' && api === 'chat') throw new Error(`${file}: llm.api=chat is not supported for provider_type=codex-oauth (Codex uses Responses)`);
    const configuredBaseUrl = optStr(tree, 'llm.base_url', file);
    const externalThinking = boolOr(tree, 'llm.external_thinking', false, file);
    if (externalThinking && type !== 'codex-oauth') throw new Error(`${file}: llm.external_thinking currently requires llm.provider_type=codex-oauth`);
    const legacy: LegacyLlmDefinition = {
      providerType: type,
      apiKey: oauth ? (optStr(tree, 'llm.api_key', file) ?? '') : reqStr(tree, 'llm.api_key', file),
      baseUrl: providerBaseUrl(type, configuredBaseUrl, 'llm.base_url', file),
      model: reqStr(tree, 'llm.model', file),
      contextSize: optNum(tree, 'llm.context_size', file),
      reasoningEffort: optStr(tree, 'llm.reasoning_effort', file) ?? 'high',
      externalThinking,
      streamIdleTimeoutMs: numOr(tree, 'llm.stream_idle_timeout_ms', externalThinking ? 60_000 : 180_000, file),
      callTimeoutMs: numOr(tree, 'llm.call_timeout_ms', externalThinking ? 120_000 : 1_200_000, file),
      api,
      reasoningSummary: optStr(tree, 'llm.reasoning_summary', file),
      reasoningContext: optStr(tree, 'llm.reasoning_context', file),
    };
    logger.warn('config: legacy flat llm keys are deprecated; migrate to llm.providers + llm.roles');
    return projectLlmRegistry(legacyLlmModelRegistry(legacy, { motorEnabled: true }), completionReserveTokens, 'legacy');
  }

  const legacyKeys = ['provider_type','api_key','base_url','model','context_size','reasoning_effort','external_thinking','stream_idle_timeout_ms','call_timeout_ms','api','reasoning_summary','reasoning_context'];
  const mixed = legacyKeys.filter((key) => at(tree, `llm.${key}`) !== undefined);
  if (mixed.length > 0) throw new Error(`${file}: canonical llm.providers/roles cannot be mixed with legacy llm keys: ${mixed.join(', ')}`);
  const providersRaw = rawMap(at(tree, 'llm.providers'), 'llm.providers', file);
  const providers: Record<string, LlmProviderDefinition> = {};
  for (const [providerId, value] of Object.entries(providersRaw)) {
    const dotted = `llm.providers.${providerId}`;
    const raw = rawMap(value, dotted, file);
    const allowed = new Set(['provider_type','api_key','base_url','api','external_thinking','stream_idle_timeout_ms','call_timeout_ms','models']);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length) throw new Error(`${file}: unknown key(s) under '${dotted}': ${unknown.join(', ')}`);
    const type = providerType(rawString(raw, 'provider_type', `${dotted}.provider_type`, file), `${dotted}.provider_type`, file);
    const api = apiSurface(rawString(raw, 'api', `${dotted}.api`, file), `${dotted}.api`, file);
    if (type === 'codex-oauth' && api === 'chat') throw new Error(`${file}: '${dotted}.api=chat' is not supported for codex-oauth`);
    const externalThinking = rawBoolean(raw, 'external_thinking', `${dotted}.external_thinking`, file, false);
    const configuredBaseUrl = rawString(raw, 'base_url', `${dotted}.base_url`, file);
    const modelsRaw = rawMap(raw.models, `${dotted}.models`, file);
    const models: LlmProviderDefinition['models'] = {};
    for (const [modelId, modelValue] of Object.entries(modelsRaw)) {
      const modelDotted = `${dotted}.models.${modelId}`;
      const model = rawMap(modelValue, modelDotted, file);
      const modelAllowed = new Set(['name','context_size','reasoning_effort','reasoning_summary','reasoning_context']);
      const modelUnknown = Object.keys(model).filter((key) => !modelAllowed.has(key));
      if (modelUnknown.length) throw new Error(`${file}: unknown key(s) under '${modelDotted}': ${modelUnknown.join(', ')}`);
      models[modelId] = {
        name: rawString(model, 'name', `${modelDotted}.name`, file, true)!,
        contextSize: rawNumber(model, 'context_size', `${modelDotted}.context_size`, file),
        reasoningEffort: rawString(model, 'reasoning_effort', `${modelDotted}.reasoning_effort`, file) ?? 'high',
        reasoningSummary: rawString(model, 'reasoning_summary', `${modelDotted}.reasoning_summary`, file),
        reasoningContext: rawString(model, 'reasoning_context', `${modelDotted}.reasoning_context`, file),
      };
    }
    providers[providerId] = {
      providerType: type,
      apiKey: type === 'openai-compatible' ? rawString(raw, 'api_key', `${dotted}.api_key`, file, true)! : (rawString(raw, 'api_key', `${dotted}.api_key`, file) ?? ''),
      baseUrl: providerBaseUrl(type, configuredBaseUrl, `${dotted}.base_url`, file),
      api,
      externalThinking,
      streamIdleTimeoutMs: rawNumber(raw, 'stream_idle_timeout_ms', `${dotted}.stream_idle_timeout_ms`, file) ?? (externalThinking ? 60_000 : 180_000),
      callTimeoutMs: rawNumber(raw, 'call_timeout_ms', `${dotted}.call_timeout_ms`, file) ?? (externalThinking ? 120_000 : 1_200_000),
      models,
    };
  }
  const rolesRaw = rawMap(at(tree, 'llm.roles'), 'llm.roles', file);
  const unknownRoles = Object.keys(rolesRaw).filter((key) => key !== 'main' && key !== 'classifier' && key !== 'motor');
  if (unknownRoles.length) throw new Error(`${file}: unknown llm.roles key(s): ${unknownRoles.join(', ')}`);
  const registry = createLlmModelRegistry({providers, roles: {
    main: rawString(rolesRaw, 'main', 'llm.roles.main', file, true)!,
    classifier: rawString(rolesRaw, 'classifier', 'llm.roles.classifier', file, true)!,
    motor: rawString(rolesRaw, 'motor', 'llm.roles.motor', file),
  }});
  return projectLlmRegistry(registry, completionReserveTokens, 'canonical');
}

const DUR_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse a "friendly duration": a bare number of milliseconds, or a string
 * like "30s" / "2h" / "14d" (suffixes ms/s/m/h/d). Exported for tests and for
 * reuse by any future duration-shaped key. */
export function parseDuration(v: unknown, dotted: string, file: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(v.trim());
    if (m) return Math.round(parseFloat(m[1]) * DUR_UNITS[m[2]]);
  }
  throw new Error(`${file}: key \`${dotted}\` must be a duration like "30s", "2h", "14d" (or a number of milliseconds)`);
}

/** A duration key: absent/null falls back to `fallbackMs`. */
function durOr(tree: YamlTree, dotted: string, fallbackMs: number, file: string): number {
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
    const pos = e instanceof YAMLParseError && e.linePos?.[0]
      ? ` (line ${e.linePos[0].line}, column ${e.linePos[0].col})`
      : '';
    throw new Error(`Config parse error in ${filePath}${pos}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof tree !== 'object' || Array.isArray(tree)) {
    throw new Error(`Config parse error in ${filePath}: top level must be a mapping`);
  }

  const f = filePath;
  const dataDirectory = path.resolve(reqStr(tree, 'paths.data_directory', f));
  const harnessRoot = resolveHarnessRoot();
  const logLevel = parseLogLevel(optStr(tree, 'log_level', f) ?? undefined);
  const logger = createLogger(logLevel);
  const botToken = reqStr(tree, 'discord.bot_token', f);

 // Compaction thresholds: validate 0 < keep < trigger.
  const compactTriggerTokens = numOr(tree, 'compaction.trigger_tokens', 180000, f);
  const compactKeepTokens = numOr(tree, 'compaction.keep_tokens', 50000, f);
  if (!(compactKeepTokens > 0 && compactKeepTokens < compactTriggerTokens)) {
    throw new Error(`${f}: compaction.keep_tokens (${compactKeepTokens}) must satisfy 0 < keep < compaction.trigger_tokens (${compactTriggerTokens})`);
  }

 // fleet.efforts gates fleet.default_effort below, so it has to be resolved
 // before the object literal. Unset → exactly the SDK's own EffortLevel union.
  const fleetEfforts = strListOr(tree, 'fleet.efforts', SDK_EFFORT_LEVELS, f);
  const fleetDefaultModel = nullableStr(tree, 'fleet.default_model', f);
  const fleetBaseUrl = normalizeAnthropicBaseUrl(optStr(tree, 'fleet.base_url', f), logger);

  return {
    llm: parseLlmConfig(tree, f, logger),
    operator: (() => {
      const name = optStr(tree, 'operator.name', f) ?? 'operator';
      if (!name.trim()) throw new Error(`${f}: key \`operator.name\` must not be empty`);
      return {
        name,
        pronouns: optStr(tree, 'operator.pronouns', f),
        discordId: optStr(tree, 'operator.discord_id', f),
      };
    })(),
    discord: (() => {
      if (at(tree, 'discord.guild_id') !== undefined) {
        throw new Error(`${f}: \`discord.guild_id\` has been replaced by the \`discord.guilds\` list — see config.example.yaml for the per-guild shape (id, slug, receive/send policy)`);
      }
      if (at(tree, 'discord.owner_id') !== undefined) {
        throw new Error(`${f}: \`discord.owner_id\` has been renamed \`operator.discord_id\``);
      }
      if (at(tree, 'discord.operator_id') !== undefined) {
        throw new Error(`${f}: \`discord.operator_id\` has been moved to \`operator.discord_id\``);
      }
      const ignoredUserIds = strListOr(tree, 'discord.ignored_user_ids', [], f);
      for (const [i, id] of ignoredUserIds.entries()) {
        if (!/^\d+$/.test(id)) throw new Error(`${f}: key \`discord.ignored_user_ids[${i}]\` must be a raw Discord user id (digits)`);
      }
      return {
        botToken,
        applicationId: optStr(tree, 'discord.application_id', f) ?? appIdFromToken(botToken),
        errorChannelId: optStr(tree, 'discord.error_channel_id', f),
        ignoredUserIds: [...new Set(ignoredUserIds)],
        attachmentInlineMaxBytes: numOr(tree, 'discord.attachment_inline_max_bytes', 32768, f),
        ambientTickMs: numOr(tree, 'discord.ambient_tick_ms', 600_000, f),
        ambientAllowSend: boolOr(tree, 'discord.ambient_allow_send', true, f),
        emoteImages: boolOr(tree, 'discord.emote_images', true, f),
        emoteKeyframes: numOr(tree, 'discord.emote_keyframes', 4, f),
        guilds: parseGuilds(tree, f),
      };
    })(),
    compaction: { triggerTokens: compactTriggerTokens, keepTokens: compactKeepTokens },
    memory: (() => {
      const consolidationThresholdTokens = numOr(tree, 'memory.consolidation_threshold_tokens', 32_000, f);
      const defaultTarget = consolidationThresholdTokens > 0 ? Math.min(24_000, Math.max(1, Math.floor(consolidationThresholdTokens * 0.75))) : 24_000;
      const consolidationTargetTokens = numOr(tree, 'memory.consolidation_target_tokens', defaultTarget, f);
      if (!Number.isInteger(consolidationThresholdTokens) || consolidationThresholdTokens < 0) {
        throw new Error(`${f}: memory.consolidation_threshold_tokens must be a non-negative integer (0 disables)`);
      }
      if (!Number.isInteger(consolidationTargetTokens) || consolidationTargetTokens <= 0) {
        throw new Error(`${f}: memory.consolidation_target_tokens must be a positive integer`);
      }
      if (consolidationThresholdTokens > 0 && consolidationTargetTokens >= consolidationThresholdTokens) {
        throw new Error(`${f}: memory.consolidation_target_tokens must be below memory.consolidation_threshold_tokens`);
      }
      return { consolidationThresholdTokens, consolidationTargetTokens };
    })(),
    heartbeat: {
      intervalMs: numOr(tree, 'heartbeat.interval_ms', 60 * 60 * 1000, f),
      maxIntervalMs: numOr(tree, 'heartbeat.max_interval_ms', 4 * 60 * 60 * 1000, f),
      reflectionMinMessages: numOr(tree, 'heartbeat.reflection_min_messages', 3, f),
      socialNudgeMs: numOr(tree, 'heartbeat.social_nudge_ms', 12 * 60 * 60 * 1000, f),
    },
    sandbox: {
      syncTimeoutMs: numOr(tree, 'sandbox.sync_timeout_ms', 15000, f),
      asyncDeadlineMs: numOr(tree, 'sandbox.async_deadline_ms', 120000, f),
      persistentIdleGcMs: (() => {
        const value = numOr(tree, 'sandbox.persistent_idle_gc_ms', 24 * 60 * 60 * 1000, f);
        if (value < 0) throw new Error(`${f}: sandbox.persistent_idle_gc_ms must be non-negative`);
        return value;
      })(),
      previewMaxBytes: numOr(tree, 'sandbox.preview_max_bytes', 16384, f),
      logMaxBytes: numOr(tree, 'sandbox.log_max_bytes', 32768, f),
    },
    modules: (() => {
      const enabledPresent = at(tree, 'modules.enabled') !== undefined;
      const disabledPresent = at(tree, 'modules.disabled') !== undefined;
      if (enabledPresent && disabledPresent) {
        throw new Error(`${f}: \`modules.enabled\` and \`modules.disabled\` are mutually exclusive`);
      }
      const validate = (key: 'enabled' | 'disabled'): BuiltinModuleId[] => {
        const values = strListOr(tree, `modules.${key}`, [], f);
        const seen = new Set<string>();
        return values.map((value, index) => {
          if (!(BUILTIN_MODULE_IDS as readonly string[]).includes(value)) {
            throw new Error(`${f}: key \`modules.${key}[${index}]\` names unknown module '${value}' (expected one of: ${BUILTIN_MODULE_IDS.join(', ')})`);
          }
          if (seen.has(value)) throw new Error(`${f}: key \`modules.${key}\` contains duplicate module '${value}'`);
          seen.add(value);
          return value as BuiltinModuleId;
        });
      };
      return enabledPresent
        ? { enabled: validate('enabled'), disabled: [] }
        : { enabled: null, disabled: disabledPresent ? validate('disabled') : [] };
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
      return { service: optStr(tree, 'bluesky.service', f) ?? 'https://bsky.social', identifier: id, appPassword: pw };
    })(),
    fleet: {
      enabled: boolOr(tree, 'fleet.enabled', true, f),
      maxConcurrent: numOr(tree, 'fleet.max_concurrent', 4, f),
 // Absent → our documented default ('opus'/'high'); explicit null → the
 // option is not sent to the Agent SDK at all. `default_effort` must name
 // a member of `efforts`, so a narrowed endpoint can't be handed a value
 // it doesn't support; when `efforts` omits 'high' (or is empty) the
 // fallback slides to the first supported level rather than erroring on
 // an operator who never set the key.
      defaultModel: fleetDefaultModel === undefined ? 'opus' : fleetDefaultModel,
      defaultEffort: (() => {
        const raw = nullableStr(tree, 'fleet.default_effort', f);
        if (raw === null) return null;
        if (raw === undefined) return fleetEfforts.includes('high') ? 'high' : (fleetEfforts[0] ?? null);
        if (!fleetEfforts.includes(raw)) {
          throw new Error(
            `${f}: fleet.default_effort (${raw}) must be one of fleet.efforts [${fleetEfforts.join(', ')}] or null`,
          );
        }
        return raw;
      })(),
      efforts: fleetEfforts,
      endpoint: {
        baseUrl: fleetBaseUrl,
        apiKey: optStr(tree, 'fleet.api_key', f),
        authToken: optStr(tree, 'fleet.auth_token', f),
      },
      models: (() => {
        const v = at(tree, 'fleet.models') ?? {};
        if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${f}: fleet.models must be a mapping`);
        for (const k of Object.keys(v as Record<string, unknown>)) {
          if (!(MODEL_ALIASES as readonly string[]).includes(k)) {
            throw new Error(`${f}: unknown fleet.models alias \`${k}\` (expected one of ${MODEL_ALIASES.join(', ')})`);
          }
        }
        const out = {} as Record<FleetModelAlias, FleetModelOverride>;
        for (const k of MODEL_ALIASES) out[k] = modelOverride(tree, `fleet.models.${k}`, f);
        return out;
      })(),
      idleTimeoutMs: durOr(tree, 'fleet.idle_timeout', 2 * 3_600_000, f),
      reapAfterMs: durOr(tree, 'fleet.reap_after', 14 * 86_400_000, f),
      env: (() => {
        const v = at(tree, 'fleet.env') ?? {};
        if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${f}: fleet.env must be a mapping`);
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (typeof val !== 'string') throw new Error(`${f}: fleet.env.${k} must be a string`);
        }
        return v as Record<string, string>;
      })(),
    },
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
