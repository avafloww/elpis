import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { createLogger, parseLogLevel, type LogLevel, type Logger } from './lib/log.js';

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

/** One entry in `discord.guilds`. `channels` is an EXHAUSTIVE allowlist —
 * channels not listed here are dropped entirely, never heard. */
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
  /** channel id → tier. Exhaustive allowlist; unlisted channels are dropped. */
  channels: Record<string, ChannelTier>;
}

export interface Config {
  llm: {
    /** Which wire surface backs the brain LLM. 'openai-compatible' (default)
 * uses `api_key`/`base_url` against an OpenAI-shaped endpoint (Chat
 * Completions or Responses per `api`). 'anthropic-oauth' drives a Claude
 * Pro/Max subscription over the native Anthropic Messages API, using an
 * OAuth credential established out-of-band (npm run oauth-login).
 * 'codex-oauth' drives the ChatGPT Codex Responses backend using a
 * device-code OAuth grant. OAuth providers do not use `api_key`. */
    providerType: 'openai-compatible' | 'anthropic-oauth' | 'codex-oauth';
    /** OpenAI-compatible API key. Required for 'openai-compatible'; unused (may
 * be empty) for OAuth providers, where auth is the OAuth Bearer token. */
    apiKey: string;
    baseUrl: string;
    model: string;
    /** Manually specified context window (tokens). When set, the harness uses
 * it directly and does NOT call models/info — required for endpoints that
 * don't implement that route. null = probe the endpoint. */
    contextSize: number | null;
    /** Reasoning effort for reasoning-capable models. When set, the endpoint
 * returns chain-of-thought in `reasoning_content` instead of leaking it
 * into `content`. null means "don't send the param". */
    reasoningEffort: string | null;
    /** Replace provider-hidden reasoning with a visible external `think` tool.
 * Initially supported on the Codex Responses path only. */
    externalThinking: boolean;
    /** Abort a streaming completion after this long with no meaningful SSE progress. 0 disables. */
    streamIdleTimeoutMs: number;
    /** Outer fail-safe for the entire LLM complete() call. 0 disables. */
    callTimeoutMs: number;
    /** Which API surface to speak. 'auto' (default) tries the OpenAI Responses
 * API — the reasoning-preserving modern surface — and permanently falls
 * back to Chat Completions for the process lifetime when the endpoint
 * 404s the route. 'responses'/'chat' force one surface, no fallback. */
    api: 'auto' | 'responses' | 'chat';
    /** Responses-API `reasoning.summary` ('auto' | 'concise' | 'detailed').
 * Opt-in: when set, the endpoint emits human-readable reasoning summaries
 * which the harness stores in `reasoning_content` (console + compaction
 * summarizer visibility). null = don't send (some orgs/models reject it). */
    reasoningSummary: string | null;
    /** Responses-API `reasoning.context` ('current_turn' | 'all_turns' |
 * 'auto') — how much of the replayed reasoning history the endpoint
 * renders into model context (newer models, e.g. GPT-5.6). null = don't
 * send the param (endpoint default). */
    reasoningContext: string | null;
    /** Subtracted from the context window for the usable budget (room to reply). */
    completionReserveTokens: number;
  };
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
    /** Per-message byte budget for inlining small text attachments verbatim
 * into the inbound message. 0 disables inlining. */
    attachmentInlineMaxBytes: number;
    /** Batching interval for ambient (non-direct-tier) inbound messages.
 * 0 disables batching (every message wakes the loop, today's behavior). */
    ambientTickMs: number;
    /** Custom emote/sticker registry: attach the image of a custom emote or
 * sticker the first time it is used in the current context window, so
 * the agent can read the social cue instead of guessing from the
 * `<:name:id>` markup. false disables the feature entirely. */
    emoteImages: boolean;
    /** Keyframes extracted (via ffmpeg) per ANIMATED emote/sticker so the
 * agent can comprehend the motion. 1 = attach a single static frame. */
    emoteKeyframes: number;
    /** Every guild the bot is live in, each with its own exhaustive channel
 * allowlist. A guild/channel not listed here is never heard. */
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
    previewMaxBytes: number;
    logMaxBytes: number;
  };
  console: {
    enabled: boolean;
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
    /** The agent's "brain" — SOUL.md, MEMORY.md, sessions/. Also the sandbox cwd. */
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

/** Ensure the DATA_DIRECTORY and its sessions/discord/ subtree exist at
 * startup. The agent's runtime data (SOUL.md, MEMORY.md, transcripts) lives
 * here. Safe to call repeatedly. */
export function ensureDataDirectory(dataDirectory: string): void {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(path.join(dataDirectory, 'sessions', 'discord'), { recursive: true });
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

/** Default location of the config file: alongside the harness source root. */
export function defaultConfigPath(): string {
  return path.join(resolveHarnessRoot(), 'config.yaml');
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

/** Parse `discord.guilds`: a non-empty list of guild entries, each with an
 * exhaustive channel→tier allowlist. Every failure mode is a boot-time error
 * naming the offending guild/channel — see the per-check messages below. */
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
    if (g.default_tier !== undefined) {
      throw new Error(`${f}: \`default_tier\` has been removed — list every channel explicitly under \`channels:\` with a tier (direct|social|quiet). Unlisted channels are dropped.`);
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
    if (!chRaw || typeof chRaw !== 'object' || Array.isArray(chRaw) || Object.keys(chRaw).length === 0) {
      throw new Error(`${f}: guild '${slug}' requires a non-empty \`channels\` map (channel id → direct|social|quiet). Only listed channels are heard.`);
    }
    const channels: Record<string, ChannelTier> = {};
    for (const [cid, tier] of Object.entries(chRaw as Record<string, unknown>)) {
      if (!/^\d+$/.test(cid)) throw new Error(`${f}: guild '${slug}' channel key "${cid}" must be a raw Discord channel id (digits)`);
      if (tier === 'muted') throw new Error(`${f}: guild '${slug}' channel "${cid}": tier \`muted\` has been renamed \`quiet\` ("mute" now refers to the killswitch)`);
      if (typeof tier !== 'string' || !TIER_VALUES.includes(tier as ChannelTier)) {
        throw new Error(`${f}: guild '${slug}' channel "${cid}" tier must be one of direct|social|quiet (got ${JSON.stringify(tier)})`);
      }
      if (seenChannels.has(cid)) throw new Error(`${f}: channel id "${cid}" appears in more than one guild`);
      seenChannels.add(cid);
      channels[cid] = tier as ChannelTier;
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
    guilds.push({ id, slug, slashCommands, pluralKit, quietHours, timezone, channels });
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
    llm: (() => {
      const providerType = (() => {
        const v = optStr(tree, 'llm.provider_type', f) ?? 'openai-compatible';
        if (v !== 'openai-compatible' && v !== 'anthropic-oauth' && v !== 'codex-oauth') {
          throw new Error(`${f}: llm.provider_type must be one of openai-compatible | anthropic-oauth | codex-oauth (got ${JSON.stringify(v)})`);
        }
        return v;
      })();
 // OAuth providers authenticate with a credential established via
 // `npm run oauth-login`, so api_key is optional. Codex is deliberately
 // pinned to ChatGPT's canonical backend to prevent bearer exfiltration.
      const isOAuth = providerType !== 'openai-compatible';
      const api = (() => {
        const v = optStr(tree, 'llm.api', f) ?? 'auto';
        if (v !== 'auto' && v !== 'responses' && v !== 'chat') {
          throw new Error(`${f}: llm.api must be one of auto | responses | chat (got ${JSON.stringify(v)})`);
        }
        if (providerType === 'codex-oauth' && v === 'chat') {
          throw new Error(`${f}: llm.api=chat is not supported for provider_type=codex-oauth (Codex uses Responses)`);
        }
        return v;
      })();
      const configuredBaseUrl = optStr(tree, 'llm.base_url', f);
      const externalThinking = boolOr(tree, 'llm.external_thinking', false, f);
      if (externalThinking && providerType !== 'codex-oauth') {
        throw new Error(`${f}: llm.external_thinking currently requires llm.provider_type=codex-oauth`);
      }
      return {
      providerType,
      apiKey: isOAuth ? (optStr(tree, 'llm.api_key', f) ?? '') : reqStr(tree, 'llm.api_key', f),
      baseUrl: providerType === 'anthropic-oauth'
        ? (configuredBaseUrl ?? 'https://api.anthropic.com')
        : providerType === 'codex-oauth'
          ? normalizeCodexBaseUrl(configuredBaseUrl, f)
          : reqStr(tree, 'llm.base_url', f),
      model: reqStr(tree, 'llm.model', f),
      contextSize: optNum(tree, 'llm.context_size', f),
      reasoningEffort: optStr(tree, 'llm.reasoning_effort', f) ?? 'high',
      externalThinking,
      streamIdleTimeoutMs: numOr(tree, 'llm.stream_idle_timeout_ms', externalThinking ? 60_000 : 180_000, f),
      callTimeoutMs: numOr(tree, 'llm.call_timeout_ms', externalThinking ? 120_000 : 1_200_000, f),
      api,
      reasoningSummary: optStr(tree, 'llm.reasoning_summary', f),
      reasoningContext: optStr(tree, 'llm.reasoning_context', f),
      completionReserveTokens: numOr(tree, 'llm.completion_reserve_tokens', 8192, f),
      };
    })(),
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
        throw new Error(`${f}: \`discord.guild_id\` has been replaced by the \`discord.guilds\` list — see config.example.yaml for the per-guild shape (id, slug, channels allowlist)`);
      }
      if (at(tree, 'discord.owner_id') !== undefined) {
        throw new Error(`${f}: \`discord.owner_id\` has been renamed \`operator.discord_id\``);
      }
      if (at(tree, 'discord.operator_id') !== undefined) {
        throw new Error(`${f}: \`discord.operator_id\` has been moved to \`operator.discord_id\``);
      }
      return {
        botToken,
        applicationId: optStr(tree, 'discord.application_id', f) ?? appIdFromToken(botToken),
        errorChannelId: optStr(tree, 'discord.error_channel_id', f),
        attachmentInlineMaxBytes: numOr(tree, 'discord.attachment_inline_max_bytes', 32768, f),
        ambientTickMs: numOr(tree, 'discord.ambient_tick_ms', 600_000, f),
        emoteImages: boolOr(tree, 'discord.emote_images', true, f),
        emoteKeyframes: numOr(tree, 'discord.emote_keyframes', 4, f),
        guilds: parseGuilds(tree, f),
      };
    })(),
    compaction: { triggerTokens: compactTriggerTokens, keepTokens: compactKeepTokens },
    heartbeat: {
      intervalMs: numOr(tree, 'heartbeat.interval_ms', 60 * 60 * 1000, f),
      maxIntervalMs: numOr(tree, 'heartbeat.max_interval_ms', 4 * 60 * 60 * 1000, f),
      reflectionMinMessages: numOr(tree, 'heartbeat.reflection_min_messages', 3, f),
      socialNudgeMs: numOr(tree, 'heartbeat.social_nudge_ms', 12 * 60 * 60 * 1000, f),
    },
    sandbox: {
      syncTimeoutMs: numOr(tree, 'sandbox.sync_timeout_ms', 15000, f),
      asyncDeadlineMs: numOr(tree, 'sandbox.async_deadline_ms', 120000, f),
      previewMaxBytes: numOr(tree, 'sandbox.preview_max_bytes', 16384, f),
      logMaxBytes: numOr(tree, 'sandbox.log_max_bytes', 32768, f),
    },
    console: {
      enabled: boolOr(tree, 'console.enabled', true, f),
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
