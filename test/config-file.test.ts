// Unit tests for loadConfigFile — YAML parsing, mapping, defaults, and
// validation. Each test writes a fixture to a temp file so nothing depends on
// a real config.yaml or on process.env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  configForLlmRef,
  configForLlmRole,
  loadConfigFile,
  parseDuration,
} from '../src/config.js';
import { createEnrollmentCredential } from '@elpis/gateway-protocol';
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

const CANONICAL_OK = `
llm:
  completion_reserve_tokens: 4096
  providers:
    openrouter:
      provider_type: openai-compatible
      api_key: sk-test
      base_url: https://example.test/v1
      api: responses
      models:
        sol:
          name: openai/gpt-5.6-sol
          context_size: 272000
          reasoning_effort: high
          reasoning_context: all_turns
          tool_tier: strong
        motor:
          name: openai/gpt-5.6-mini
          context_size: 128000
          reasoning_effort: low
          tool_tier: weak
        secretary:
          name: openai/gpt-5.6-secretary
          context_size: 64000
          reasoning_effort: medium
  roles:
    main: openrouter/sol
    classifier: openrouter/sol
    motor: openrouter/motor
    secretary: openrouter/secretary
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

test('configFile: canonical provider/model registry resolves roles and projects main compatibility fields', () => {
  const c = loadConfigFile(fixture(CANONICAL_OK));
  assert.equal(c.llm.registrySource, 'canonical');
  assert.equal(c.llm.registry.roles.main, 'openrouter/sol');
  assert.equal(c.llm.registry.targets.classifier.ref, 'openrouter/sol');
  assert.equal(c.llm.registry.targets.motor?.name, 'openai/gpt-5.6-mini');
  assert.equal(c.llm.model, 'openai/gpt-5.6-sol');
  assert.equal(c.llm.contextSize, 272000);
  assert.equal(c.llm.api, 'responses');
  assert.equal(c.llm.completionReserveTokens, 4096);
  assert.equal(c.llm.registry.targets.main.toolTier, 'strong');
  assert.equal(c.llm.registry.targets.motor?.toolTier, 'weak');
  assert.equal(c.llm.registry.targets.secretary?.toolTier, null);
  const motor = configForLlmRole(c, 'motor');
  assert.equal(motor.llm.model, 'openai/gpt-5.6-mini');
  assert.equal(motor.llm.reasoningEffort, 'low');
  assert.equal(motor.llm.registry, c.llm.registry);
  const workerTarget = configForLlmRef(c, 'openrouter/motor');
  assert.equal(workerTarget.llm.model, 'openai/gpt-5.6-mini');
  assert.equal(workerTarget.llm.contextSize, 128000);
  assert.throws(
    () => configForLlmRef(c, 'openrouter/missing'),
    /config: worker model references unknown model/,
  );
});

test('configFile: optional secretary role resolves and fails closed when absent', () => {
  const configured = loadConfigFile(fixture(CANONICAL_OK));
  assert.equal(
    configured.llm.registry.targets.secretary?.name,
    'openai/gpt-5.6-secretary',
  );
  assert.equal(
    configForLlmRole(configured, 'secretary').llm.model,
    'openai/gpt-5.6-secretary',
  );

  const absent = loadConfigFile(
    fixture(CANONICAL_OK.replace('    secretary: openrouter/secretary\n', '')),
  );
  assert.equal(absent.llm.registry.roles.secretary, null);
  assert.equal(absent.llm.registry.targets.secretary, null);
  assert.throws(
    () => configForLlmRole(absent, 'secretary'),
    /llm\.roles\.secretary is not configured/,
  );
});

test('configFile: tool tiers are optional, strict, and unique', () => {
  const invalid = CANONICAL_OK.replace('tool_tier: weak', 'tool_tier: enormous');
  assert.throws(
    () => loadConfigFile(fixture(invalid)),
    /tool_tier.*weak, medium, or strong/,
  );
  const duplicate = CANONICAL_OK.replace(
    'tool_tier: weak',
    'tool_tier: strong',
  );
  assert.throws(
    () => loadConfigFile(fixture(duplicate)),
    /tool tier strong is assigned to both openrouter\/sol and openrouter\/motor/,
  );
  const omitted = loadConfigFile(
    fixture(CANONICAL_OK.replaceAll(/\n\s+tool_tier: (?:weak|strong)/g, '')),
  );
  assert.equal(omitted.llm.registry.targets.main.toolTier, null);
  assert.equal(omitted.llm.registry.targets.motor?.toolTier, null);
});

test('configFile: canonical roles reject unknown keys', () => {
  const unknown = CANONICAL_OK.replace(
    '    secretary: openrouter/secretary',
    '    secretary: openrouter/secretary\n    scribe: openrouter/secretary',
  );
  assert.throws(
    () => loadConfigFile(fixture(unknown)),
    /unknown llm\.roles key\(s\): scribe/,
  );
});

test('configFile: canonical and legacy llm shapes cannot be mixed', () => {
  const mixed = CANONICAL_OK.replace(
    '  completion_reserve_tokens:',
    '  model: accidental-wire-name\n  completion_reserve_tokens:',
  );
  assert.throws(() => loadConfigFile(fixture(mixed)), /cannot be mixed.*model/);
});

test('configFile: canonical roles must reference configured provider-local model ids', () => {
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          CANONICAL_OK.replace(
            'classifier: openrouter/sol',
            'classifier: missing/sol',
          ),
        ),
      ),
    /unknown provider/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          CANONICAL_OK.replace(
            'classifier: openrouter/sol',
            'classifier: openrouter/missing',
          ),
        ),
      ),
    /unknown model/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(CANONICAL_OK.replace('    classifier: openrouter/sol\n', '')),
      ),
    /llm.roles.classifier/,
  );
});

test('configFile: required keys present → loads core fields', () => {
  const c = loadConfigFile(fixture(MINIMAL_OK));
  assert.equal(c.llm.apiKey, 'sk-test');
  assert.equal(c.llm.baseUrl, 'https://example.test/v1');
  assert.equal(c.llm.model, 'test-model');
  assert.equal(c.discord.guilds[0]?.pluralKit, false);
  assert.equal(c.discord.guilds[0].id, 'guild-1');
});

test('configFile: ignored Discord user ids are digit-only and deduplicated', () => {
  const configured = MINIMAL_OK.replace(
    '  bot_token:',
    '  ignored_user_ids: ["111", "222", "111"]\n  bot_token:',
  );
  assert.deepEqual(loadConfigFile(fixture(configured)).discord.ignoredUserIds, [
    '111',
    '222',
  ]);
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          MINIMAL_OK.replace(
            '  bot_token:',
            '  ignored_user_ids: nope\n  bot_token:',
          ),
        ),
      ),
    /must be a list of strings/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          MINIMAL_OK.replace(
            '  bot_token:',
            '  ignored_user_ids: ["not-an-id"]\n  bot_token:',
          ),
        ),
      ),
    /raw Discord user id \(digits\)/,
  );
});

test('configFile: ambient send permission is independently configurable', () => {
  const c = loadConfigFile(
    fixture(
      MINIMAL_OK.replace(
        '  bot_token:',
        '  ambient_allow_send: false\n  bot_token:',
      ),
    ),
  );
  assert.equal(c.discord.ambientAllowSend, false);
});

test('configFile: defaults are applied when optionals are absent', () => {
  const c = loadConfigFile(fixture(MINIMAL_OK));
  assert.equal(c.llm.reasoningEffort, 'high');
  assert.equal(c.llm.contextSize, null);
  assert.equal(c.kagi.apiKey, null);
  assert.equal(c.discord.errorChannelId, null);
  assert.deepEqual(c.discord.ignoredUserIds, []);
  assert.deepEqual(c.operator, {
    name: 'operator',
    pronouns: null,
    discordId: null,
  });
  assert.equal(c.discord.ambientTickMs, 600000);
  assert.equal(c.discord.ambientAllowSend, true);
  assert.equal(c.sandbox.syncTimeoutMs, 15000);
  assert.equal(c.sandbox.asyncDeadlineMs, 120000);
  assert.equal(c.sandbox.persistentRetirementGraceMs, 10 * 60 * 1000);
  assert.equal(c.compaction.triggerTokens, 180000);
  assert.equal(c.compaction.keepTokens, 50000);
  assert.deepEqual(c.memory, {
    consolidationThresholdTokens: 32000,
    consolidationTargetTokens: 24000,
  });
  assert.equal(c.llm.completionReserveTokens, 8192);
  assert.equal(c.heartbeat.intervalMs, 60 * 60 * 1000);
  assert.equal(c.heartbeat.reflectionMinMessages, 3);
  assert.equal(c.console.enabled, true);
  assert.equal(c.console.mcpEnabled, false);
  assert.equal(c.console.port, 8787);
  assert.equal(c.console.host, '127.0.0.1');
  assert.strictEqual(c.console, c.dashboard.local);
  assert.equal(c.dashboard.remote, null);
});

test('configFile: memory consolidation threshold is configurable and validated', () => {
  const c = loadConfigFile(
    fixture(
      MINIMAL_OK +
        '\nmemory:\n  consolidation_threshold_tokens: 48000\n  consolidation_target_tokens: 30000\n',
    ),
  );
  assert.deepEqual(c.memory, {
    consolidationThresholdTokens: 48000,
    consolidationTargetTokens: 30000,
  });
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          MINIMAL_OK +
            '\nmemory:\n  consolidation_threshold_tokens: 12000\n  consolidation_target_tokens: 12000\n',
        ),
      ),
    /target_tokens must be below/,
  );
  assert.deepEqual(
    loadConfigFile(
      fixture(
        MINIMAL_OK + '\nmemory:\n  consolidation_threshold_tokens: 16000\n',
      ),
    ).memory,
    { consolidationThresholdTokens: 16000, consolidationTargetTokens: 12000 },
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          MINIMAL_OK + '\nmemory:\n  consolidation_threshold_tokens: -1\n',
        ),
      ),
    /non-negative integer/,
  );
});

test('configFile: legacy console maps to the object-identical local dashboard', () => {
  const c = loadConfigFile(
    fixture(MINIMAL_OK + '\nconsole:\n  enabled: true\n  mcp_enabled: true\n'),
  );
  assert.equal(c.console.mcpEnabled, true);
  assert.strictEqual(c.console, c.dashboard.local);
  assert.equal(c.dashboard.remote, null);
});

test('configFile: canonical dashboard local and remote parse without a second authority', () => {
  const token = createEnrollmentCredential((size) => Buffer.alloc(size, 7)).token;
  const c = loadConfigFile(
    fixture(
      MINIMAL_OK +
        `\ndashboard:\n  local:\n    enabled: false\n    mcp_enabled: true\n    port: 9000\n    host: 0.0.0.0\n  remote:\n    url: https://gateway.example\n    enrollment_token: ${JSON.stringify(token)}\n`,
    ),
  );
  assert.deepEqual(c.dashboard.local, {
    enabled: false,
    mcpEnabled: true,
    port: 9000,
    host: '0.0.0.0',
  });
  assert.strictEqual(c.console, c.dashboard.local);
  assert.deepEqual(c.dashboard.remote, {
    url: 'https://gateway.example',
    enrollmentToken: token,
  });
});

test('configFile: dashboard and legacy console are mutually exclusive exact mappings', () => {
  assert.throws(
    () =>
      loadConfigFile(
        fixture(MINIMAL_OK + '\nconsole:\n  enabled: true\ndashboard:\n  local: {}\n'),
      ),
    /dashboard.*legacy `console`.*mutually exclusive/,
  );
  for (const body of [
    '\ndashboard: nope\n',
    '\ndashboard:\n  wrong: true\n',
    '\ndashboard:\n  local: nope\n',
    '\ndashboard:\n  local:\n    wrong: true\n',
    '\ndashboard:\n  remote: []\n',
    '\ndashboard:\n  remote:\n    url: https://gateway.example\n    wrong: true\n',
    '\nconsole:\n  wrong: true\n',
  ])
    assert.throws(() => loadConfigFile(fixture(MINIMAL_OK + body)), /(mapping|unknown key)/);
});

test('configFile: remote endpoint and enrollment token are canonical and non-echoing', () => {
  for (const url of [
    'http://gateway.example',
    'https://gateway.example/',
    'https://gateway.example/path',
    'https://user@gateway.example',
    'https://gateway.example?query=1',
    'https://gateway.example:443',
  ])
    assert.throws(
      () =>
        loadConfigFile(
          fixture(MINIMAL_OK + `\ndashboard:\n  remote:\n    url: ${url}\n`),
        ),
      /canonical credential-free HTTPS origin/,
    );
  const malformed = `ege1.${'A'.repeat(22)}.${'secret-material-that-must-never-echo'.repeat(2)}`;
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          MINIMAL_OK +
            `\ndashboard:\n  remote:\n    url: https://gateway.example\n    enrollment_token: ${JSON.stringify(malformed)}\n`,
        ),
      ),
    (error) =>
      error instanceof Error &&
      /exact ege1 enrollment token/.test(error.message) &&
      !error.message.includes(malformed),
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(MINIMAL_OK + '\ndashboard:\n  local: null\n  remote: null\n'),
      ),
    /dashboard\.local.*must be a mapping/,
  );
  const c = loadConfigFile(
    fixture(MINIMAL_OK + '\ndashboard:\n  remote: null\n'),
  );
  assert.strictEqual(c.console, c.dashboard.local);
  assert.equal(c.dashboard.remote, null);
});

test('configFile: codex-oauth needs no api key/base URL and pins the canonical backend', () => {
  const body = MINIMAL_OK.replace('  api_key: sk-test\n', '')
    .replace('  base_url: https://example.test/v1\n', '')
    .replace('llm:\n', 'llm:\n  provider_type: codex-oauth\n');
  const c = loadConfigFile(fixture(body));
  assert.equal(c.llm.providerType, 'codex-oauth');
  assert.equal(c.llm.apiKey, '');
  assert.equal(c.llm.baseUrl, 'https://chatgpt.com/backend-api');
});

test('configFile: codex-oauth rejects chat mode and non-canonical token targets', () => {
  const base = MINIMAL_OK.replace('  api_key: sk-test\n', '')
    .replace('  base_url: https://example.test/v1\n', '')
    .replace('llm:\n', 'llm:\n  provider_type: codex-oauth\n');
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          base.replace(
            '  model: test-model',
            '  model: test-model\n  api: chat',
          ),
        ),
      ),
    /not supported.*Codex uses Responses/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          base.replace(
            '  model: test-model',
            '  model: test-model\n  base_url: https:\/\/evil.example\/backend-api',
          ),
        ),
      ),
    /subscription tokens are never sent to custom endpoints/,
  );
});

for (const key of [
  'llm.api_key',
  'llm.base_url',
  'llm.model',
  'discord.bot_token',
  'paths.data_directory',
]) {
  test(`configFile: missing ${key} throws`, () => {
    const [group, leaf] = key.split('.');
    const body = MINIMAL_OK.replace(new RegExp(`^  ${leaf}:.*$`, 'm'), '');
    assert.throws(
      () => loadConfigFile(fixture(body)),
      new RegExp(`${group}\\.${leaf}`),
    );
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
  assert.throws(
    () => loadConfigFile(fixture(absent)),
    /missing required key `llm\.model`/,
  );
  const mistyped = MINIMAL_OK.replace(/^  model:.*$/m, '  model: 42');
  assert.throws(
    () => loadConfigFile(fixture(mistyped)),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return (
        /key `llm\.model` must be a non-empty string \(got number\)/.test(
          msg,
        ) && !msg.includes('missing')
      );
    },
  );
  const empty = MINIMAL_OK.replace(/^  model:.*$/m, '  model: ""');
  assert.throws(
    () => loadConfigFile(fixture(empty)),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /key `llm\.model` is empty/.test(msg) && !msg.includes('missing');
    },
  );
});

test('configFile: missing file throws with the path', () => {
  assert.throws(
    () => loadConfigFile('/tmp/definitely-not-here/config.yaml'),
    /definitely-not-here/,
  );
});

test('configFile: malformed YAML throws naming the file and a line', () => {
  const p = fixture('llm:\n  api_key: "unterminated\ndiscord:\n');
  assert.throws(
    () => loadConfigFile(p),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.includes(p) && /line \d+/.test(msg);
    },
  );
});

test('configFile: compaction threshold validation (0 < keep < trigger)', () => {
  const withCompaction = (extra: string) =>
    fixture(`${MINIMAL_OK}\ncompaction:\n${extra}`);
  assert.throws(
    () => loadConfigFile(withCompaction('  keep_tokens: 0\n')),
    /0 < keep/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        withCompaction('  keep_tokens: 200000\n  trigger_tokens: 100000\n'),
      ),
    /0 < keep/,
  );
  const c = loadConfigFile(
    withCompaction('  trigger_tokens: 50000\n  keep_tokens: 10000\n'),
  );
  assert.equal(c.compaction.triggerTokens, 50000);
});

test('configFile: sandbox retirement grace is configurable with a bounded legacy alias', () => {
  const current = loadConfigFile(
    fixture(
      `${MINIMAL_OK}\nsandbox:\n  persistent_retirement_grace_ms: 4321\n`,
    ),
  );
  assert.equal(current.sandbox.persistentRetirementGraceMs, 4321);
  const legacy = loadConfigFile(
    fixture(`${MINIMAL_OK}\nsandbox:\n  persistent_idle_gc_ms: 9876\n`),
  );
  assert.equal(legacy.sandbox.persistentRetirementGraceMs, 9876);
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          `${MINIMAL_OK}\nsandbox:\n  persistent_retirement_grace_ms: "abc"\n`,
        ),
      ),
    /sandbox\.persistent_retirement_grace_ms/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          `${MINIMAL_OK}\nsandbox:\n  persistent_retirement_grace_ms: -1\n`,
        ),
      ),
    /non-negative integer/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          `${MINIMAL_OK}\nsandbox:\n  persistent_retirement_grace_ms: 1\n  persistent_idle_gc_ms: 2\n`,
        ),
      ),
    /mutually exclusive/,
  );
});

test('configFile: wrong-typed scalar throws naming the key', () => {
  assert.throws(
    () =>
      loadConfigFile(
        fixture(`${MINIMAL_OK}\nsandbox:\n  sync_timeout_ms: "abc"\n`),
      ),
    /sandbox\.sync_timeout_ms/,
  );
});

test('configFile: application id derives from the bot token when not set', () => {
  assert.equal(
    loadConfigFile(fixture(MINIMAL_OK)).discord.applicationId,
    APPLICATION_ID,
  );
});

// NOTE: MINIMAL_OK ends with the `paths:` block, so appending a two-space-indented
// key would land it under `paths`, not the group you meant. Any test that adds
// a key to an EXISTING group must splice it into that group.
test('configFile: explicit discord.application_id overrides the derived id', () => {
  const body = MINIMAL_OK.replace(
    '  guilds:',
    '  application_id: "999"\n  guilds:',
  );
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
  assert.equal(
    loadConfigFile(fixture(`${MINIMAL_OK}\nkagi:\n  api_key: kagi-xyz\n`)).kagi
      .apiKey,
    'kagi-xyz',
  );
  assert.equal(
    loadConfigFile(fixture(`${MINIMAL_OK}\nkagi:\n  api_key: null\n`)).kagi
      .apiKey,
    null,
  );
});

// Splices into the EXISTING llm: group — appending an indented key after
// MINIMAL_OK would land it under `paths:` and test nothing.
test('configFile: llm.models_info_url is no longer a recognized key', () => {
  const body = MINIMAL_OK.replace(
    '  model: test-model',
    '  model: test-model\n  models_info_url: https://ignored.test/info',
  );
  const c = loadConfigFile(fixture(body));
  assert.equal(
    (c.llm as Record<string, unknown>).modelsInfoUrl,
    undefined,
    'the key is gone from Config; models/info is always derived from base_url',
  );
  // And the field is gone from the type as well as the value.
  assert.ok(
    !('modelsInfoUrl' in c.llm),
    'modelsInfoUrl must not be present at all',
  );
});

test('parseDuration accepts friendly forms and bare ms', () => {
  assert.equal(parseDuration('2h', 'k', 'f'), 7_200_000);
  assert.equal(parseDuration('14d', 'k', 'f'), 14 * 86_400_000);
  assert.equal(parseDuration('500ms', 'k', 'f'), 500);
  assert.equal(parseDuration('30s', 'k', 'f'), 30_000);
  assert.equal(parseDuration(1500, 'k', 'f'), 1500);
  assert.throws(() => parseDuration('soon', 'k', 'f'), /duration/);
});

test('native workers default disabled with a loopback broker', () => {
  const config = loadConfigFile(fixture(MINIMAL_OK));
  assert.deepEqual(config.workers, {
    enabled: false,
    maxConcurrent: 4,
    server: { enabled: false, host: '127.0.0.1', port: 8790 },
    workspace: {
      sourceRoot: null,
      maxSourceBytes: 8 * 1024 * 1024,
      maxArtifactBytes: 8 * 1024 * 1024,
    },
    kubernetes: {
      enabled: false,
      namespace: 'elpis-workers',
      template: 'elpis-worker',
      container: 'worker',
      brokerUrl: null,
      kubectlPath: 'kubectl',
      context: null,
    },
  });
});

test('native worker server configuration is explicit and bounded', () => {
  const config = loadConfigFile(
    fixture(
      `${MINIMAL_OK}\nworkers:\n  enabled: true\n  max_concurrent: 8\n  server:\n    enabled: true\n    host: 10.42.0.1\n    port: 18890\n`,
    ),
  );
  assert.deepEqual(config.workers, {
    enabled: true,
    maxConcurrent: 8,
    server: { enabled: true, host: '10.42.0.1', port: 18890 },
    workspace: {
      sourceRoot: null,
      maxSourceBytes: 8 * 1024 * 1024,
      maxArtifactBytes: 8 * 1024 * 1024,
    },
    kubernetes: {
      enabled: false,
      namespace: 'elpis-workers',
      template: 'elpis-worker',
      container: 'worker',
      brokerUrl: null,
      kubectlPath: 'kubectl',
      context: null,
    },
  });
  assert.throws(
    () =>
      loadConfigFile(fixture(`${MINIMAL_OK}\nworkers:\n  max_concurrent: 0\n`)),
    /workers\.max_concurrent must be an integer from 1 to 128/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(`${MINIMAL_OK}\nworkers:\n  server:\n    port: 70000\n`),
      ),
    /workers\.server\.port must be an integer from 1 to 65535/,
  );
  const workspace = loadConfigFile(
    fixture(
      `${MINIMAL_OK}\nworkers:\n  workspace:\n    source_root: /srv/elpis\n    max_source_bytes: 1048576\n    max_artifact_bytes: 2097152\n`,
    ),
  );
  assert.deepEqual(workspace.workers.workspace, {
    sourceRoot: '/srv/elpis',
    maxSourceBytes: 1048576,
    maxArtifactBytes: 2097152,
  });
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          `${MINIMAL_OK}\nworkers:\n  workspace:\n    source_root: relative/path\n`,
        ),
      ),
    /workers\.workspace\.source_root must be an absolute path/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          `${MINIMAL_OK}\nworkers:\n  workspace:\n    max_source_bytes: 1\n`,
        ),
      ),
    /workers\.workspace\.max_source_bytes must be an integer/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(`${MINIMAL_OK}\nworkers:\n  workspace:\n    mount: escape\n`),
      ),
    /unknown workers\.workspace key.*mount/,
  );
});

test('Kubernetes workers require a fixed brokered template configuration', () => {
  const body = `${MINIMAL_OK}\nworkers:\n  enabled: true\n  server:\n    enabled: true\n  kubernetes:\n    enabled: true\n    namespace: bounded-workers\n    template: fixed-worker\n    container: worker\n    broker_url: https://worker-broker.example.com\n    context: bounded-context\n`;
  const config = loadConfigFile(fixture(body));
  assert.deepEqual(config.workers.kubernetes, {
    enabled: true,
    namespace: 'bounded-workers',
    template: 'fixed-worker',
    container: 'worker',
    brokerUrl: 'https://worker-broker.example.com',
    kubectlPath: 'kubectl',
    context: 'bounded-context',
  });
  for (const invalid of [
    `${MINIMAL_OK}\nworkers:\n  kubernetes:\n    enabled: true\n    broker_url: https://worker-broker.example.com\n`,
    `${MINIMAL_OK}\nworkers:\n  enabled: true\n  kubernetes:\n    enabled: true\n    broker_url: https://worker-broker.example.com\n`,
    `${MINIMAL_OK}\nworkers:\n  enabled: true\n  server:\n    enabled: true\n  kubernetes:\n    enabled: true\n`,
    `${MINIMAL_OK}\nworkers:\n  enabled: true\n  server:\n    enabled: true\n  kubernetes:\n    enabled: true\n    broker_url: https://user:pass@worker-broker.example.com\n`,
  ])
    assert.throws(
      () => loadConfigFile(fixture(invalid)),
      /workers\.kubernetes/,
    );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(`${MINIMAL_OK}\nworkers:\n  kubernetes:\n    image: escape\n`),
      ),
    /unknown workers\.kubernetes key.*image/,
  );
});

test('legacy fleet configuration is rejected without an alias', () => {
  assert.throws(
    () => loadConfigFile(fixture(`${MINIMAL_OK}\nfleet:\n  enabled: false\n`)),
    /legacy `fleet` configuration was removed.*`workers`/,
  );
});

test('secretary defaults disabled and enabling requires the bounded Kubernetes broker', () => {
  const absent = loadConfigFile(fixture(MINIMAL_OK));
  assert.deepEqual(absent.secretary, {
    enabled: false,
    maxConcurrent: 1,
    kubernetes: {
      namespace: 'elpis-residence',
      template: 'elpis-secretary',
      container: 'secretary',
      brokerUrl: null,
      kubectlPath: 'kubectl',
      context: null,
    },
  });

  const configured = loadConfigFile(
    fixture(
      `${CANONICAL_OK}\nworkers:\n  server:\n    enabled: true\nsecretary:\n  enabled: true\n  max_concurrent: 2\n  kubernetes:\n    namespace: bounded-residence\n    template: fixed-secretary\n    container: secretary\n    broker_url: https://secretary-broker.example.com\n    context: residence-context\n`,
    ),
  );
  assert.deepEqual(configured.secretary, {
    enabled: true,
    maxConcurrent: 2,
    kubernetes: {
      namespace: 'bounded-residence',
      template: 'fixed-secretary',
      container: 'secretary',
      brokerUrl: 'https://secretary-broker.example.com',
      kubectlPath: 'kubectl',
      context: 'residence-context',
    },
  });

  for (const invalid of [
    `${CANONICAL_OK}\nsecretary:\n  enabled: true\n  kubernetes:\n    broker_url: https://secretary-broker.example.com\n`,
    `${CANONICAL_OK.replace('    secretary: openrouter/secretary\n', '')}\nworkers:\n  server:\n    enabled: true\nsecretary:\n  enabled: true\n  kubernetes:\n    broker_url: https://secretary-broker.example.com\n`,
    `${CANONICAL_OK}\nworkers:\n  server:\n    enabled: true\nsecretary:\n  enabled: true\n`,
    `${CANONICAL_OK}\nworkers:\n  server:\n    enabled: true\nsecretary:\n  enabled: true\n  kubernetes:\n    broker_url: https://user:pass@secretary-broker.example.com\n`,
    `${CANONICAL_OK}\nsecretary:\n  max_concurrent: 0\n`,
  ])
    assert.throws(() => loadConfigFile(fixture(invalid)), /secretary/);
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          `${CANONICAL_OK}\nsecretary:\n  kubernetes:\n    image: escape\n`,
        ),
      ),
    /unknown secretary\.kubernetes key.*image/,
  );
});

// ---------- usage_tracker section (optional; whole section omittable) ----------

test('usage_tracker: defaults when the section is absent', () => {
  const cfg = loadConfigFile(fixture(MINIMAL_OK));
  assert.equal(cfg.usageTracker.enabled, true);
  assert.equal(cfg.usageTracker.pollIntervalMs, 300000);
});

test('usage_tracker: explicit values override the defaults', () => {
  const cfg = loadConfigFile(
    fixture(
      MINIMAL_OK +
        '\nusage_tracker:\n  enabled: false\n  poll_interval_ms: 60000\n',
    ),
  );
  assert.equal(cfg.usageTracker.enabled, false);
  assert.equal(cfg.usageTracker.pollIntervalMs, 60000);
});

test('usage_tracker: wrongly-typed enabled is a boot-time error naming the key', () => {
  assert.throws(
    () =>
      loadConfigFile(
        fixture(MINIMAL_OK + '\nusage_tracker:\n  enabled: "yes"\n'),
      ),
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
  assert.equal(home.defaultTier, 'drop');
  assert.equal(home.allowSend, true);
  assert.equal(home.defaultAllowSend, false);
  assert.deepEqual(home.channelAllowSend, { '1001': true, '1002': true });
  assert.equal(home.quietHours, null);
  assert.equal(friends.slashCommands, false);
  assert.deepEqual(friends.quietHours, { start: 23 * 60, end: 9 * 60 });
  assert.equal(friends.timezone, 'America/New_York');
  assert.equal(c.discord.ambientTickMs, 600000);
  assert.deepEqual(c.operator, {
    name: 'operator',
    pronouns: null,
    discordId: null,
  });
});

test('configFile: legacy discord.guild_id is a hard error naming discord.guilds', () => {
  assert.throws(
    () => loadConfigFile(fixture(MINIMAL)),
    /discord\.guild_id.*discord\.guilds/s,
  );
});

test('configFile: legacy Discord operator keys are hard errors naming operator.discord_id', () => {
  const owner = GUILDS.replace('bot_token:', 'owner_id: "5"\n  bot_token:');
  assert.throws(
    () => loadConfigFile(fixture(owner)),
    /owner_id.*operator\.discord_id/s,
  );
  const operator = GUILDS.replace(
    'bot_token:',
    'operator_id: "5"\n  bot_token:',
  );
  assert.throws(
    () => loadConfigFile(fixture(operator)),
    /operator_id.*operator\.discord_id/s,
  );
});

test('configFile: top-level operator identity parses name, pronouns, and Discord id', () => {
  const body = `operator:\n  name: Bramble\n  pronouns: she/they\n  discord_id: "5"\n${GUILDS}`;
  const c = loadConfigFile(fixture(body));
  assert.deepEqual(c.operator, {
    name: 'Bramble',
    pronouns: 'she/they',
    discordId: '5',
  });
});

test('configFile: guild receive/send defaults and channel object overrides parse', () => {
  const body = GUILDS.replace(
    'slug: home',
    'slug: home\n      default_tier: social\n      default_allow_send: false\n      allow_send: true',
  ).replace(
    '        "1002": social',
    '        "1002":\n          tier: drop\n          allow_send: false',
  );
  const home = loadConfigFile(fixture(body)).discord.guilds[0];
  assert.equal(home.defaultTier, 'social');
  assert.equal(home.allowSend, true);
  assert.equal(home.defaultAllowSend, false);
  assert.deepEqual(home.channels, { '1001': 'direct', '1002': 'drop' });
  assert.deepEqual(home.channelAllowSend, { '1001': true, '1002': false });
});

test('configFile: guild/channel send policy fields are strict booleans', () => {
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          GUILDS.replace('slug: home', 'slug: home\n      allow_send: nope'),
        ),
      ),
    /allow_send.*true or false/s,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(
          GUILDS.replace(
            '"1002": social',
            '"1002":\n          tier: social\n          allow_send: nope',
          ),
        ),
      ),
    /allow_send.*true or false/s,
  );
});

test('configFile: tier "muted" is rejected pointing at quiet', () => {
  const body = GUILDS.replace('"2002": quiet', '"2002": muted');
  assert.throws(() => loadConfigFile(fixture(body)), /muted.*quiet/s);
});

test('configFile: a drop-default guild still requires an explicit channel map', () => {
  const body = GUILDS.replace(
    /      channels:\n        "2001": social\n        "2002": quiet\n/,
    '',
  );
  assert.throws(() => loadConfigFile(fixture(body)), /channels/);
});

test('configFile: a listen-all guild may omit channels entirely', () => {
  const body = GUILDS.replace(
    'slug: friends-a',
    'slug: friends-a\n      default_tier: social',
  ).replace(
    /      channels:\n        "2001": social\n        "2002": quiet\n/,
    '',
  );
  const friends = loadConfigFile(fixture(body)).discord.guilds[1];
  assert.equal(friends.defaultTier, 'social');
  assert.deepEqual(friends.channels, {});
  assert.deepEqual(friends.channelAllowSend, {});
});

test('configFile: slug rules — all-digits, bad chars, duplicates all throw', () => {
  assert.throws(
    () =>
      loadConfigFile(fixture(GUILDS.replace('slug: friends-a', 'slug: "123"'))),
    /slug/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture(GUILDS.replace('slug: friends-a', 'slug: "Friends A"')),
      ),
    /slug/,
  );
  assert.throws(
    () =>
      loadConfigFile(fixture(GUILDS.replace('slug: friends-a', 'slug: home'))),
    /slug/,
  );
});

test('configFile: quiet_hours validation — bad format and bad timezone throw', () => {
  assert.throws(
    () =>
      loadConfigFile(fixture(GUILDS.replace('"2300-0900"', '"25:00-0900"'))),
    /quiet_hours/,
  );
  assert.throws(
    () =>
      loadConfigFile(fixture(GUILDS.replace('America/New_York', 'Not/AZone'))),
    /timezone/,
  );
});

test('configFile: quiet_hours with a well-formed but out-of-range time throws (the h>23||m>59 branch)', () => {
  const body = GUILDS.replace('"2300-0900"', '"2599-0900"');
  assert.throws(() => loadConfigFile(fixture(body)), /invalid time "2599"/);
});

test('configFile: a guild entry missing `id` reports "missing", not "wrongly-typed"', () => {
  const body = GUILDS.replace('- id: "111"\n      slug: home', '- slug: home');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /guild entry missing a non-empty string `id`/.test(msg);
    },
  );
});

test('configFile: an unquoted numeric guild id names the precision-loss cause, not "missing"', () => {
  // Unquoted, this parses as a YAML number — precision already lost on an 18-digit
  // snowflake. The diagnosis must say "quoted string" + "loses precision", never "missing".
  const body = GUILDS.replace('id: "111"', 'id: 111111111111111118');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return (
        /must be a quoted string/.test(msg) &&
        /loses precision/.test(msg) &&
        !msg.includes('missing a non-empty string')
      );
    },
  );
});

test('configFile: a duplicate guild id across entries throws', () => {
  const body = GUILDS.replace('id: "222"', 'id: "111"');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /duplicate guild id "111"/,
  );
});

test('configFile: the same channel id appearing in more than one guild throws', () => {
  const body = GUILDS.replace('"2001": social', '"1001": social');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /channel id "1001" appears in more than one guild/,
  );
});

test('configFile: a non-digit channel key throws', () => {
  const body = GUILDS.replace('"1001": direct', 'general: direct');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /channel key "general" must be a raw Discord channel id/,
  );
});

test('configFile: an invalid tier other than the special-cased "muted" throws listing the valid set', () => {
  const body = GUILDS.replace('"1002": social', '"1002": loud');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /tier must be one of drop\|direct\|social\|quiet \(got "loud"\)/,
  );
});

test('configFile: discord.guilds present but empty throws', () => {
  const body = GUILDS.replace(
    /  guilds:[\s\S]*?paths:/,
    '  guilds: []\npaths:',
  );
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /discord\.guilds` must be a non-empty list/,
  );
});

test('configFile: discord.guilds present but not a list throws', () => {
  const body = GUILDS.replace(
    /  guilds:[\s\S]*?paths:/,
    '  guilds: "oops"\npaths:',
  );
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /discord\.guilds` must be a non-empty list/,
  );
});

test('configFile: a discord.guilds entry that is not a map throws', () => {
  const body = GUILDS.replace(
    /  guilds:[\s\S]*?paths:/,
    '  guilds:\n    - "oops"\npaths:',
  );
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /each `discord\.guilds` entry must be a map/,
  );
});

test('configFile: a non-boolean slash_commands throws naming the guild and the key', () => {
  const body = GUILDS.replace('slash_commands: true', 'slash_commands: "true"');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /guild 'home' `slash_commands` must be true or false/,
  );
});

test('configFile: pluralkit is per-guild, defaults false, and validates boolean values', () => {
  const c = loadConfigFile(fixture(GUILDS));
  assert.equal(c.discord.guilds[0]?.pluralKit, true);
  assert.equal(c.discord.guilds[1]?.pluralKit, false);
  const body = GUILDS.replace('pluralkit: true', 'pluralkit: "true"');
  assert.throws(
    () => loadConfigFile(fixture(body)),
    /guild 'home' `pluralkit` must be true or false/,
  );
});
