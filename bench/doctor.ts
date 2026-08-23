import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BenchConfig, ProviderConfig } from './config.js';
import { ensurePrivateDir, privateDataRoot } from './store.js';
import { endpointAt } from '../src/llm/provenance.js';
import { openDatabase } from '../src/store/db.js';
import { OAuthStore } from '../src/llm/oauth/store.js';
import { refreshAnthropicToken } from '../src/llm/oauth/anthropic.js';
import {
  OPENAI_CODEX_CREDENTIAL_KEY,
  refreshOpenAICodexToken,
} from '../src/llm/oauth/openai-codex.js';
import { fetchCodexContextWindow } from '../src/llm/codex-client.js';
import { makeConfig } from '../test/helpers.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
function command(name: string, args: string[]): DoctorCheck {
  try {
    const detail = execFileSync(name, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')[0];
    return { name, ok: true, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
function authCheck(config: BenchConfig, providerName: string): DoctorCheck {
  const provider = config.providers[providerName];
  if (provider.provider_type === 'openai-compatible')
    return {
      name: `auth:${providerName}`,
      ok: Boolean(provider.api_key),
      detail: provider.api_key
        ? 'API key configured'
        : 'missing providers.*.api_key',
    };
  const file = path.join(
    config.data_directory ?? privateDataRoot(),
    'auth',
    'elpis.db',
  );
  if (!fs.existsSync(file))
    return {
      name: `auth:${providerName}`,
      ok: false,
      detail: `missing OAuth database ${file}; run auth login ${provider.provider_type}`,
    };
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const key =
      provider.provider_type === 'anthropic-oauth'
        ? 'anthropic'
        : 'openai-codex';
    const row = db
      .prepare('SELECT provider FROM oauth_credentials WHERE provider = ?')
      .get(key);
    db.close();
    return {
      name: `auth:${providerName}`,
      ok: Boolean(row),
      detail: row ? 'credential present' : `no ${key} credential`,
    };
  } catch (error) {
    return {
      name: `auth:${providerName}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
async function modelCheck(
  config: BenchConfig,
  name: string,
): Promise<DoctorCheck> {
  const provider: ProviderConfig = config.providers[name];
  try {
    if (provider.provider_type === 'openai-compatible') {
      const response = await fetch(endpointAt(provider.base_url!, 'models'), {
        headers: { Authorization: `Bearer ${provider.api_key}` },
      });
      if (!response.ok)
        throw new Error(`models endpoint returned HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: { id?: string }[] };
      if (
        Array.isArray(payload.data) &&
        payload.data.length &&
        !payload.data.some((m) => m.id === provider.model)
      )
        throw new Error(`model ${provider.model} was not listed`);
    } else {
      const dir = ensurePrivateDir(
        path.join(config.data_directory ?? privateDataRoot(), 'auth'),
      );
      const db = openDatabase(dir);
      if (provider.provider_type === 'anthropic-oauth') {
        const store = new OAuthStore(db, 'anthropic', refreshAnthropicToken);
        const token = await store.getAccessToken();
        const response = await fetch(
          endpointAt(
            provider.base_url ?? 'https://api.anthropic.com',
            'v1/models',
          ),
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'oauth-2025-04-20',
            },
          },
        );
        if (!response.ok)
          throw new Error(
            `Anthropic models endpoint returned HTTP ${response.status}`,
          );
        const payload = (await response.json()) as { data?: { id?: string }[] };
        if (
          Array.isArray(payload.data) &&
          payload.data.length &&
          !payload.data.some((m) => m.id === provider.model)
        )
          throw new Error(`model ${provider.model} was not listed`);
      } else {
        const store = new OAuthStore(
          db,
          OPENAI_CODEX_CREDENTIAL_KEY,
          refreshOpenAICodexToken,
        );
        const base = makeConfig({
          llm: {
            ...makeConfig().llm,
            providerType: 'codex-oauth',
            apiKey: '',
            baseUrl: 'https://chatgpt.com/backend-api',
            model: provider.model,
            contextSize: null,
          },
        });
        await fetchCodexContextWindow(base, store);
      }
    }
    return {
      name: `model:${name}`,
      ok: true,
      detail: `${provider.model} accessible`,
    };
  } catch (error) {
    return {
      name: `model:${name}`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function doctor(
  config: BenchConfig,
  opts: { skipProviders?: boolean } = {},
): Promise<DoctorCheck[]> {
  const checks = [
    command('docker', ['version', '--format', '{{.Server.Version}}']),
    command('docker', ['image', 'inspect', config.image]),
    command('git', ['--version']),
  ];
  checks.push(
    command('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--read-only',
      '--entrypoint',
      '/bin/sh',
      config.image,
      '-c',
      'test -r /usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1 || test -r /usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1',
    ]),
  );
  const providers = new Set(
    [
      config.default_provider,
      config.generator_provider,
      ...config.judges.map((j) => j.provider),
    ].filter(Boolean) as string[],
  );
  if (!opts.skipProviders) {
    for (const provider of providers) checks.push(authCheck(config, provider));
    for (const provider of providers)
      checks.push(await modelCheck(config, provider));
  }
  const families = new Set(config.judges.map((j) => j.family));
  checks.push({
    name: 'judge-panel',
    ok:
      config.judges.length === 3 &&
      families.size >= 2 &&
      config.judges.some((j) => !j.teacher_pool),
    detail:
      'requires three profiles, at least two families, and one outside the teacher pool',
  });
  return checks;
}
export function assertDoctor(checks: readonly DoctorCheck[]): void {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length)
    throw new Error(
      `doctor failed:\n${failed.map((c) => `- ${c.name}: ${c.detail}`).join('\n')}`,
    );
}
