import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfigFile, requireMaterializedConfig } from '../src/config.js';
import { createSecretRegistry, redactSecrets } from '../src/lib/secrets.js';

const APPLICATION_ID = '123456789012345678';
const BOT_TOKEN = `${Buffer.from(APPLICATION_ID).toString('base64url')}.fixture.token`;

function fixture(
  options: {
    operatorId?: string;
    guildSlug?: string;
    voice?: string;
  } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-voice-config-'));
  const file = path.join(dir, 'config.yaml');
  const operator = options.operatorId
    ? `operator:\n  discord_id: "${options.operatorId}"\n`
    : '';
  const voice = options.voice
    ? options.voice
        .trim()
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n') + '\n'
    : '';
  fs.writeFileSync(
    file,
    `llm:
  api_key: sk-test
  base_url: https://example.test/v1
  model: test-model
${operator}discord:
  bot_token: ${BOT_TOKEN}
${voice}  guilds:
    - id: "111111111111111111"
      slug: ${options.guildSlug ?? 'home'}
      channels:
        "222222222222222222": direct
paths:
  data_directory: ${dir}/data
`,
  );
  return file;
}

test('Discord voice defaults disabled without requiring credentials or operator authorization', () => {
  const config = loadConfigFile(fixture());
  assert.deepEqual(config.discord.voice, {
    enabled: false,
    apiKey: null,
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    maxSessionMinutes: 60,
  });
});

test('enabled Discord voice parses configurable public Realtime settings', () => {
  const config = requireMaterializedConfig(
    loadConfigFile(
      fixture({
        operatorId: '333333333333333333',
        voice: `voice:
  enabled: true
  api_key: sk-voice-secret-abcdefgh
  model: realtime-model
  voice: cedar
  transcription_model: transcript-model
  max_session_minutes: 25`,
      }),
    ),
  );
  assert.deepEqual(config.discord.voice, {
    enabled: true,
    apiKey: 'sk-voice-secret-abcdefgh',
    model: 'realtime-model',
    voice: 'cedar',
    transcriptionModel: 'transcript-model',
    maxSessionMinutes: 25,
  });
  assert.equal(
    redactSecrets(
      'credential=sk-voice-secret-abcdefgh',
      createSecretRegistry(config),
    ),
    'credential=[SECRET REDACTED]',
  );
});

test('enabled Discord voice requires its API key, operator id, and home guild', () => {
  assert.throws(
    () =>
      loadConfigFile(
        fixture({ operatorId: '333', voice: 'voice:\n  enabled: true' }),
      ),
    /discord\.voice\.api_key.*enabled/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture({
          voice: 'voice:\n  enabled: true\n  api_key: sk-voice-secret-abcdefgh',
        }),
      ),
    /operator\.discord_id.*required/,
  );
  assert.throws(
    () =>
      loadConfigFile(
        fixture({
          operatorId: '333',
          guildSlug: 'friends',
          voice: 'voice:\n  enabled: true\n  api_key: sk-voice-secret-abcdefgh',
        }),
      ),
    /guild with slug `home`/,
  );
});

test('Discord voice session limit is a positive integer capped at 60 minutes', () => {
  for (const value of ['0', '61', '1.5']) {
    assert.throws(
      () =>
        loadConfigFile(
          fixture({ voice: `voice:\n  max_session_minutes: ${value}` }),
        ),
      /max_session_minutes must be an integer from 1 to 60/,
    );
  }
});

test('Discord voice rejects endpoint overrides and unknown settings', () => {
  assert.throws(
    () =>
      loadConfigFile(
        fixture({
          voice: 'voice:\n  endpoint: wss://untrusted.example/realtime',
        }),
      ),
    /discord\.voice.*unknown key `endpoint`/,
  );
});
