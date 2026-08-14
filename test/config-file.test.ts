// Unit tests for loadConfigFile — YAML parsing, mapping, defaults, and
// validation. Each test writes a fixture to a temp file so nothing depends on
// a real config.yaml or on process.env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfigFile, parseDuration, normalizeAnthropicBaseUrl, SDK_EFFORT_LEVELS } from '../src/config.js';
import { noopLogger } from '../src/lib/log.js';

// A bot token whose first segment base64-decodes to a digit string, so the
// application id can be derived when it isn't set explicitly.
const APPLICATION_ID = '123456789012345678';
const TOKEN = `${Buffer.from(APPLICATION_ID).toString('base64url')}.${'fixture'}.${'token'}`;

// Kept carrying legacy `guild_id` — it now exists ONLY to exercise the
// legacy-error test below. It is not a loadable config (discord.guilds is
// required); every other test that needs a loadable config uses MINIMAL_OK.
const MINIMAL = `
llm:
  api_key: sk-test
  base_url: https://example.test/v1
  model: test-model
discord:
  bot_token: ${TOKEN}
  guild_id: "guild-1"
paths:
  data_directory: /tmp/harness-config-test
`;

const MINIMAL_OK = `
llm:
  api_key: sk-test
  base_url: https://example.test/v1
  model: test-model
discord:
  bot_token: ${TOKEN}
  guilds:
    - id: "guild-1"
      slug: home
      channels:
        "1001": direct
paths:
  data_directory: /tmp/harness-config-test
`;

const GUILDS = `
llm:
  api_key: sk-test
  base_url: https://example.test/v1
  model: test-model
discord:
  bot_token: ${TOKEN}
  guilds:
    - id: "111"
      slug: home
      slash_commands: true
      pluralkit: true
      channels:
        "1001": direct
        "1002": social
    - id: "222"
      slug: friends-a
      quiet_hours: "2300-0900"
      timezone: America/New_York
      channels:
        "2001": social
        "2002": quiet
paths:
  data_directory: /tmp/harness-config-test
`;

/** Write a YAML fixture to a temp file and return its path. */
function fixture(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
  const p = path.join(dir, 'config.yaml');
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('configFile: required keys present → loads core fields', () => {
  const c = loadConfigFile(fixture(MINIMAL_OK));
  assert.equal(c.llm.apiKey, 'sk-test');
  assert.equal(c.llm.baseUrl, 'https://example.test/v1');
  assert.equal(c.llm.model, 'test-model');
  assert.equal(c.discord.guilds[0]?.pluralKit, false);
  assert.equal(c.discord.guilds[0].id, 'guild-1');
});

test('configFile: defaults are applied when optionals are absent', () => {
  const c = loadConfigFile(fixture(MINIMAL_OK));
  assert.equal(c.llm.reasoningEffort, 'high');
  assert.equal(c.llm.contextSize, null);
  assert.equal(c.kagi.apiKey, null);
  assert.equal(c.discord.errorChannelId, null);
  assert.deepEqual(c.operator, { name: 'operator', pronouns: null, discordId: null });
  assert.equal(c.discord.ambientTickMs, 600000);
  assert.equal(c.sandbox.syncTimeoutMs, 15000);
  assert.equal(c.sandbox.asyncDeadlineMs, 120000);
  assert.equal(c.compaction.triggerTokens, 180000);
  assert.equal(c.compaction.keepTokens, 50000);
  assert.equal(c.compaction.toolAgeKeepTokens, 0, 'tool aging defaults OFF (prefix-cache cost)');
  assert.equal(c.llm.completionReserveTokens, 8192);
  assert.equal(c.heartbeat.intervalMs, 60 * 60 * 1000);
  assert.equal(c.heartbeat.reflectionMinMessages, 3);
  assert.equal(c.console.enabled, true);
  assert.equal(c.console.port, 8787);
  assert.equal(c.console.host, '127.0.0.1');
});

test('configFile: codex-oauth needs no api key/base URL and pins the canonical backend', () => {
  const body = MINIMAL_OK
    .replace('  api_key: sk-test\n', '')
    .replace('  base_url: https://example.test/v1\n', '')
    .replace('llm:\n', 'llm:\n  provider_type: codex-oauth\n');
  const c = loadConfigFile(fixture(body));
  assert.equal(c.llm.providerType, 'codex-oauth');
  assert.equal(c.llm.apiKey, '');
  assert.equal(c.llm.baseUrl, 'https://chatgpt.com/backend-api');
});

test('configFile: codex-oauth rejects chat mode and non-canonical token targets', () => {
  const base = MINIMAL_OK
    .replace('  api_key: sk-test\n', '')
    .replace('  base_url: https://example.test/v1\n', '')
    .replace('llm:\n', 'llm:\n  provider_type: codex-oauth\n');
  assert.throws(
    () => loadConfigFile(fixture(base.replace('  model: test-model', '  model: test-model\n  api: chat'))),
    /not supported.*Codex uses Responses/,
  );
  assert.throws(
    () => loadConfigFile(fixture(base.replace('  model: test-model', '  model: test-model\n  base_url: https:\/\/evil.example\/backend-api'))),
    /subscription tokens are never sent to custom endpoints/,
  );
});

for (const key of ['llm.api_key', 'llm.base_url', 'llm.model', 'discord.bot_token', 'paths.data_directory']) {
  test(`configFile: missing ${key} throws`, () => {
    const [group, leaf] = key.split('.');
    const body = MINIMAL_OK.replace(new RegExp(`^  ${leaf}:.*$`, 'm'), '');
    assert.throws(() => loadConfigFile(fixture(body)), new RegExp(`${group}\\.${leaf}`));
  });
}

test('configFile: missing discord.guilds throws', () => {
  const body = GUILDS.replace(/  guilds:[\s\S]*?paths:/, 'paths:');
  assert.throws(() => loadConfigFile(fixture(body)), /discord\.guilds/);
});

test('configFile: a required key distinguishes absent from wrongly-typed', () => {
 // "missing" must not be the diagnosis for a key that is plainly present —
 // it sends the operator to re-read a line that looks right.
  const absent = MINIMAL_OK.replace(/^  model:.*$/m, '');
  assert.throws(() => loadConfigFile(fixture(absent)), /missing required key `llm\.model`/);
  const mistyped = MINIMAL_OK.replace(/^  model:.*$/m, '  model: 42');
  assert.throws(() => loadConfigFile(fixture(mistyped)), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return /key `llm\.model` must be a non-empty string \(got number\)/.test(msg) && !msg.includes('missing');
  });
  const empty = MINIMAL_OK.replace(/^  model:.*$/m, '  model: ""');
  assert.throws(() => loadConfigFile(fixture(empty)), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return /key `llm\.model` is empty/.test(msg) && !msg.includes('missing');
  });
});

test('configFile: missing file throws with the path', () => {
  assert.throws(() => loadConfigFile('/tmp/definitely-not-here/config.yaml'), /definitely-not-here/);
});

test('configFile: malformed YAML throws naming the file and a line', () => {
  const p = fixture('llm:\n  api_key: "unterminated\ndiscord:\n');
  assert.throws(() => loadConfigFile(p), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes(p) && /line \d+/.test(msg);
  });
});

test('configFile: compaction threshold validation (0 < keep < trigger; aging <= trigger)', () => {
  const withCompaction = (extra: string) => fixture(`${MINIMAL_OK}\ncompaction:\n${extra}`);
  assert.throws(() => loadConfigFile(withCompaction('  keep_tokens: 0\n')), /0 < keep/);
  assert.throws(() => loadConfigFile(withCompaction('  keep_tokens: 200000\n  trigger_tokens: 100000\n')), /0 < keep/);
  assert.throws(() => loadConfigFile(withCompaction('  tool_age_keep_tokens: 200000\n  trigger_tokens: 100000\n')), /tool_age_keep_tokens/);
  const c = loadConfigFile(withCompaction('  trigger_tokens: 50000\n  keep_tokens: 10000\n'));
  assert.equal(c.compaction.triggerTokens, 50000);
  assert.equal(c.compaction.toolAgeKeepTokens, 0, 'aging stays off regardless of keep_tokens');
 // Explicitly opting in still works (full-price-cache endpoints).
  const on = loadConfigFile(withCompaction('  trigger_tokens: 50000\n  keep_tokens: 10000\n  tool_age_keep_tokens: 20000\n'));
  assert.equal(on.compaction.toolAgeKeepTokens, 20000, 'explicit opt-in is honored');
});

test('configFile: wrong-typed scalar throws naming the key', () => {
  assert.throws(() => loadConfigFile(fixture(`${MINIMAL_OK}\nsandbox:\n  sync_timeout_ms: "abc"\n`)), /sandbox\.sync_timeout_ms/);
});

test('configFile: application id derives from the bot token when not set', () => {
  assert.equal(loadConfigFile(fixture(MINIMAL_OK)).discord.applicationId, APPLICATION_ID);
});

// NOTE: MINIMAL_OK ends with the `paths:` block, so appending a two-space-indented
// key would land it under `paths`, not the group you meant. Any test that adds
// a key to an EXISTING group must splice it into that group.
test('configFile: explicit discord.application_id overrides the derived id', () => {
  const body = MINIMAL_OK.replace('  guilds:', '  application_id: "999"\n  guilds:');
  const c = loadConfigFile(fixture(body));
  assert.equal(c.discord.applicationId, '999');
});

test('configFile: derived paths hang off paths.data_directory', () => {
  const body = MINIMAL_OK.replace('/tmp/harness-config-test', '/tmp/brain');
  const c = loadConfigFile(fixture(body));
  assert.equal(c.paths.dataDirectory, '/tmp/brain');
  assert.equal(c.paths.soulPath, '/tmp/brain/SOUL.md');
  assert.equal(c.paths.memoryPath, '/tmp/brain/MEMORY.md');
});

test('configFile: kagi.api_key set when non-empty', () => {
  assert.equal(loadConfigFile(fixture(`${MINIMAL_OK}\nkagi:\n  api_key: kagi-xyz\n`)).kagi.apiKey, 'kagi-xyz');
  assert.equal(loadConfigFile(fixture(`${MINIMAL_OK}\nkagi:\n  api_key: null\n`)).kagi.apiKey, null);
});

// Splices into the EXISTING llm: group — appending an indented key after
// MINIMAL_OK would land it under `paths:` and test nothing.
test('configFile: llm.models_info_url is no longer a recognized key', () => {
  const body = MINIMAL_OK.replace('  model: test-model', '  model: test-model\n  models_info_url: https://ignored.test/info');
  const c = loadConfigFile(fixture(body));
  assert.equal((c.llm as Record<string, unknown>).modelsInfoUrl, undefined,
    'the key is gone from Config; models/info is always derived from base_url');
 // And the field is gone from the type as well as the value.
  assert.ok(!('modelsInfoUrl' in c.llm), 'modelsInfoUrl must not be present at all');
});

test('parseDuration accepts friendly forms and bare ms', () => {
  assert.equal(parseDuration('2h', 'k', 'f'), 7_200_000);
  assert.equal(parseDuration('14d', 'k', 'f'), 14 * 86_400_000);
  assert.equal(parseDuration('500ms', 'k', 'f'), 500);
  assert.equal(parseDuration('30s', 'k', 'f'), 30_000);
  assert.equal(parseDuration(1500, 'k', 'f'), 1500);
  assert.throws(() => parseDuration('soon', 'k', 'f'), /duration/);
});

test('fleet config defaults', () => {
  const c = loadConfigFile(fixture(MINIMAL_OK));
  assert.equal(c.fleet.enabled, true);
  assert.equal(c.fleet.maxConcurrent, 4);
  assert.equal(c.fleet.defaultModel, 'opus');
  assert.equal(c.fleet.defaultEffort, 'high');
  assert.equal(c.fleet.idleTimeoutMs, 7_200_000);
  assert.equal(c.fleet.reapAfterMs, 14 * 86_400_000);
  assert.deepEqual(c.fleet.env, {});
});

test('fleet.enabled: false parses (the fleet opt-out)', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  enabled: false\n`));
  assert.equal(c.fleet.enabled, false);
});

// ---------- fleet endpoint / aliases / effort levels ----------
// Every knob below is optional and an un-set one hands the Claude Agent SDK
// NOTHING — the SDK's own endpoint, credentials, alias table, and effort
// levels apply. See docs/fleet.md#endpoint-model-aliases-and-effort-levels.

const BARE = { name: null, context: null };

test('fleet endpoint/alias/effort knobs default to "leave it to the SDK"', () => {
  const c = loadConfigFile(fixture(MINIMAL_OK));
  assert.deepEqual(c.fleet.endpoint, { baseUrl: null, apiKey: null, authToken: null });
  assert.deepEqual(c.fleet.models, { opus: BARE, sonnet: BARE, haiku: BARE, fable: BARE });
  assert.deepEqual(c.fleet.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('fleet.efforts defaults to exactly the SDK EffortLevel union', () => {
  const c = loadConfigFile(fixture(MINIMAL_OK));
  assert.deepEqual(c.fleet.efforts, SDK_EFFORT_LEVELS);
});

test('fleet endpoint + aliases are read off the config file', () => {
  const body = `${MINIMAL_OK}\nfleet:\n  base_url: https://api.example.com\n  api_key: sk-fleet-1\n  auth_token: tok-1\n  models:\n    opus: big-1\n    haiku: small-1\n`;
  const c = loadConfigFile(fixture(body));
  assert.deepEqual(c.fleet.endpoint, { baseUrl: 'https://api.example.com', apiKey: 'sk-fleet-1', authToken: 'tok-1' });
  assert.deepEqual(c.fleet.models, {
    opus: { name: 'big-1', context: null }, sonnet: BARE,
    haiku: { name: 'small-1', context: null }, fable: BARE,
  });
});

// ---------- fleet.base_url normalization ----------
// ANTHROPIC_BASE_URL is the API ROOT; the CLI appends /v1/messages itself. The
// adjacent llm.base_url requires its /v1, so pasting that spelling here is the
// obvious mistake — and it fails as an opaque "model may not exist" three
// layers down in a detached subprocess. Normalize it, loudly.

test('fleet.base_url: a trailing version segment is stripped', () => {
  const withV1 = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  base_url: https://api.example.com/v1\n`));
  assert.equal(withV1.fleet.endpoint.baseUrl, 'https://api.example.com');
  const withSlash = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  base_url: https://api.example.com/v1/\n`));
  assert.equal(withSlash.fleet.endpoint.baseUrl, 'https://api.example.com');
});

test('fleet.base_url: a correct root is left exactly as written', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  base_url: https://api.example.com\n`));
  assert.equal(c.fleet.endpoint.baseUrl, 'https://api.example.com');
});

test('fleet.base_url: a path prefix that is not a version segment survives', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  base_url: https://gw.example.com/anthropic\n`));
  assert.equal(c.fleet.endpoint.baseUrl, 'https://gw.example.com/anthropic');
});

test('normalizeAnthropicBaseUrl: warns when it strips, stays quiet when it does not', () => {
  const warns: string[] = [];
  const spy = { ...noopLogger, warn: (...a: unknown[]) => { warns.push(a.join(' ')); } };
  assert.equal(normalizeAnthropicBaseUrl('https://x.test/v1', spy), 'https://x.test');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /ANTHROPIC_BASE_URL is the API root/);
  assert.match(warns[0], /llm\.base_url is different/);
  assert.equal(normalizeAnthropicBaseUrl('https://x.test', spy), 'https://x.test');
  assert.equal(warns.length, 1, 'no warning for an already-correct root');
  assert.equal(normalizeAnthropicBaseUrl(null, spy), null);
});

// ---------- fleet.models: the two spellings ----------

test('an alias accepts the mapping form with an explicit context window', () => {
  const body = `${MINIMAL_OK}\nfleet:\n  models:\n    opus:\n      name: big-model\n      context: 262144\n    haiku: small-model\n`;
  const c = loadConfigFile(fixture(body));
  assert.deepEqual(c.fleet.models.opus, { name: 'big-model', context: 262144 });
  assert.deepEqual(c.fleet.models.haiku, { name: 'small-model', context: null },
    'the string shorthand still means "probe for the context"');
});

test('an alias may pin only the context, keeping the SDK\'s own alias target', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  models:\n    sonnet:\n      context: 200000\n`));
  assert.deepEqual(c.fleet.models.sonnet, { name: null, context: 200000 });
});

test('an unknown key inside a fleet.models alias is a boot error', () => {
  const body = `${MINIMAL_OK}\nfleet:\n  models:\n    opus:\n      name: big\n      window: 100\n`;
  assert.throws(() => loadConfigFile(fixture(body)), /unknown key `fleet.models.opus.window`.*name.*context/s);
});

test('a non-positive or non-numeric alias context is a boot error', () => {
  assert.throws(
    () => loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  models:\n    opus:\n      context: 0\n`)),
    /must be a positive number of tokens/,
  );
  assert.throws(
    () => loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  models:\n    opus:\n      context: big\n`)),
    /fleet\.models\.opus\.context/,
  );
});

test('an alias set to a list (not a name or mapping) is a boot error', () => {
  assert.throws(
    () => loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  models:\n    opus: [a, b]\n`)),
    /must be a model name or a mapping of \{ name, context \}/,
  );
});

test('an unknown fleet.models alias is a boot error naming the valid ones', () => {
  const body = `${MINIMAL_OK}\nfleet:\n  models:\n    turbo: x\n`;
  assert.throws(() => loadConfigFile(fixture(body)), /unknown fleet.models alias `turbo`.*opus, sonnet, haiku, fable/s);
});

test('fleet.efforts can narrow or rename the level set', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  efforts: [fast, deep]\n  default_effort: deep\n`));
  assert.deepEqual(c.fleet.efforts, ['fast', 'deep']);
  assert.equal(c.fleet.defaultEffort, 'deep');
});

test('fleet.default_effort must name a member of fleet.efforts', () => {
  const body = `${MINIMAL_OK}\nfleet:\n  efforts: [low, high]\n  default_effort: xhigh\n`;
  assert.throws(() => loadConfigFile(fixture(body)), /default_effort \(xhigh\).*\[low, high\]/s);
});

test('a narrowed fleet.efforts without high slides the unset default to the first level', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  efforts: [fast, deep]\n`));
  assert.equal(c.fleet.defaultEffort, 'fast');
});

test('fleet.efforts: [] means no effort parameter — the unset default becomes null', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  efforts: []\n`));
  assert.deepEqual(c.fleet.efforts, []);
  assert.equal(c.fleet.defaultEffort, null);
});

test('explicit null default_model/default_effort mean "send neither to the SDK"', () => {
  const c = loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  default_model: null\n  default_effort: null\n`));
  assert.equal(c.fleet.defaultModel, null);
  assert.equal(c.fleet.defaultEffort, null);
});

test('fleet.efforts must be a list of non-empty strings', () => {
  assert.throws(() => loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  efforts: high\n`)), /must be a list of strings/);
  assert.throws(() => loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  efforts: [high, 3]\n`)), /efforts\[1\].*non-empty string/);
});

// ---------- usage_tracker section (optional; whole section omittable) ----------

test('usage_tracker: defaults when the section is absent', () => {
  const cfg = loadConfigFile(fixture(MINIMAL_OK));
  assert.equal(cfg.usageTracker.enabled, true);
  assert.equal(cfg.usageTracker.pollIntervalMs, 300000);
});

test('usage_tracker: explicit values override the defaults', () => {
  const cfg = loadConfigFile(fixture(MINIMAL_OK + '\nusage_tracker:\n  enabled: false\n  poll_interval_ms: 60000\n'));
  assert.equal(cfg.usageTracker.enabled, false);
  assert.equal(cfg.usageTracker.pollIntervalMs, 60000);
});

test('usage_tracker: wrongly-typed enabled is a boot-time error naming the key', () => {
  assert.throws(
    () => loadConfigFile(fixture(MINIMAL_OK + '\nusage_tracker:\n  enabled: "yes"\n')),
    /usage_tracker\.enabled/,
  );
});

// ---------- discord.guilds: the allowlist ----------

test('configFile: guilds list parses with tiers, quiet hours, defaults', () => {
  const c = loadConfigFile(fixture(GUILDS));
  assert.equal(c.discord.guilds.length, 2);
  const [home, friends] = c.discord.guilds;
  assert.equal(home.id, '111');
  assert.equal(home.slug, 'home');
  assert.equal(home.slashCommands, true);
  assert.deepEqual(home.channels, { '1001': 'direct', '1002': 'social' });
  assert.equal(home.quietHours, null);
  assert.equal(friends.slashCommands, false);
  assert.deepEqual(friends.quietHours, { start: 23 * 60, end: 9 * 60 });
  assert.equal(friends.timezone, 'America/New_York');
  assert.equal(c.discord.ambientTickMs, 600000);
  assert.deepEqual(c.operator, { name: 'operator', pronouns: null, discordId: null });
});

test('configFile: legacy discord.guild_id is a hard error naming discord.guilds', () => {
  assert.throws(() => loadConfigFile(fixture(MINIMAL)), /discord\.guild_id.*discord\.guilds/s);
});

test('configFile: legacy Discord operator keys are hard errors naming operator.discord_id', () => {
  const owner = GUILDS.replace('bot_token:', 'owner_id: "5"\n  bot_token:');
  assert.throws(() => loadConfigFile(fixture(owner)), /owner_id.*operator\.discord_id/s);
  const operator = GUILDS.replace('bot_token:', 'operator_id: "5"\n  bot_token:');
  assert.throws(() => loadConfigFile(fixture(operator)), /operator_id.*operator\.discord_id/s);
});

test('configFile: top-level operator identity parses name, pronouns, and Discord id', () => {
  const body = `operator:\n  name: Bramble\n  pronouns: she/they\n  discord_id: "5"\n${GUILDS}`;
  const c = loadConfigFile(fixture(body));
  assert.deepEqual(c.operator, { name: 'Bramble', pronouns: 'she/they', discordId: '5' });
});

test('configFile: per-guild default_tier is a hard error', () => {
  const body = GUILDS.replace('slug: home', 'slug: home\n      default_tier: social');
  assert.throws(() => loadConfigFile(fixture(body)), /default_tier/);
});

test('configFile: tier "muted" is rejected pointing at quiet', () => {
  const body = GUILDS.replace('"2002": quiet', '"2002": muted');
  assert.throws(() => loadConfigFile(fixture(body)), /muted.*quiet/s);
});

test('configFile: guild without channels is a hard error', () => {
  const body = GUILDS.replace(/      channels:\n        "2001": social\n        "2002": quiet\n/, '');
  assert.throws(() => loadConfigFile(fixture(body)), /channels/);
});

test('configFile: slug rules — all-digits, bad chars, duplicates all throw', () => {
  assert.throws(() => loadConfigFile(fixture(GUILDS.replace('slug: friends-a', 'slug: "123"'))), /slug/);
  assert.throws(() => loadConfigFile(fixture(GUILDS.replace('slug: friends-a', 'slug: "Friends A"'))), /slug/);
  assert.throws(() => loadConfigFile(fixture(GUILDS.replace('slug: friends-a', 'slug: home'))), /slug/);
});

test('configFile: quiet_hours validation — bad format and bad timezone throw', () => {
  assert.throws(() => loadConfigFile(fixture(GUILDS.replace('"2300-0900"', '"25:00-0900"'))), /quiet_hours/);
  assert.throws(() => loadConfigFile(fixture(GUILDS.replace('America/New_York', 'Not/AZone'))), /timezone/);
});

test('configFile: quiet_hours with a well-formed but out-of-range time throws (the h>23||m>59 branch)', () => {
  const body = GUILDS.replace('"2300-0900"', '"2599-0900"');
  assert.throws(() => loadConfigFile(fixture(body)), /invalid time "2599"/);
});

test('configFile: a guild entry missing `id` reports "missing", not "wrongly-typed"', () => {
  const body = GUILDS.replace('- id: "111"\n      slug: home', '- slug: home');
  assert.throws(() => loadConfigFile(fixture(body)), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return /guild entry missing a non-empty string `id`/.test(msg);
  });
});

test('configFile: an unquoted numeric guild id names the precision-loss cause, not "missing"', () => {
 // Unquoted, this parses as a YAML number — precision already lost on an 18-digit
 // snowflake. The diagnosis must say "quoted string" + "loses precision", never "missing".
  const body = GUILDS.replace('id: "111"', 'id: 111111111111111118');
  assert.throws(() => loadConfigFile(fixture(body)), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return /must be a quoted string/.test(msg) && /loses precision/.test(msg) && !msg.includes('missing a non-empty string');
  });
});

test('configFile: a duplicate guild id across entries throws', () => {
  const body = GUILDS.replace('id: "222"', 'id: "111"');
  assert.throws(() => loadConfigFile(fixture(body)), /duplicate guild id "111"/);
});

test('configFile: the same channel id appearing in more than one guild throws', () => {
  const body = GUILDS.replace('"2001": social', '"1001": social');
  assert.throws(() => loadConfigFile(fixture(body)), /channel id "1001" appears in more than one guild/);
});

test('configFile: a non-digit channel key throws', () => {
  const body = GUILDS.replace('"1001": direct', 'general: direct');
  assert.throws(() => loadConfigFile(fixture(body)), /channel key "general" must be a raw Discord channel id/);
});

test('configFile: an invalid tier other than the special-cased "muted" throws listing the valid set', () => {
  const body = GUILDS.replace('"1002": social', '"1002": loud');
  assert.throws(() => loadConfigFile(fixture(body)), /tier must be one of direct\|social\|quiet \(got "loud"\)/);
});

test('configFile: discord.guilds present but empty throws', () => {
  const body = GUILDS.replace(/  guilds:[\s\S]*?paths:/, '  guilds: []\npaths:');
  assert.throws(() => loadConfigFile(fixture(body)), /discord\.guilds` must be a non-empty list/);
});

test('configFile: discord.guilds present but not a list throws', () => {
  const body = GUILDS.replace(/  guilds:[\s\S]*?paths:/, '  guilds: "oops"\npaths:');
  assert.throws(() => loadConfigFile(fixture(body)), /discord\.guilds` must be a non-empty list/);
});

test('configFile: a discord.guilds entry that is not a map throws', () => {
  const body = GUILDS.replace(/  guilds:[\s\S]*?paths:/, '  guilds:\n    - "oops"\npaths:');
  assert.throws(() => loadConfigFile(fixture(body)), /each `discord\.guilds` entry must be a map/);
});

test('configFile: a non-boolean slash_commands throws naming the guild and the key', () => {
  const body = GUILDS.replace('slash_commands: true', 'slash_commands: "true"');
  assert.throws(() => loadConfigFile(fixture(body)), /guild 'home' `slash_commands` must be true or false/);
});

test('configFile: pluralkit is per-guild, defaults false, and validates boolean values', () => {
  const c = loadConfigFile(fixture(GUILDS));
  assert.equal(c.discord.guilds[0]?.pluralKit, true);
  assert.equal(c.discord.guilds[1]?.pluralKit, false);
  const body = GUILDS.replace('pluralkit: true', 'pluralkit: "true"');
  assert.throws(() => loadConfigFile(fixture(body)), /guild 'home' `pluralkit` must be true or false/);
});
