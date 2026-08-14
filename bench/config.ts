import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { privateDataRoot } from './store.js';

const providerSchema = z.object({
  provider_type: z.enum(['openai-compatible', 'anthropic-oauth', 'codex-oauth']),
  model: z.string().min(1), base_url: z.string().url().optional(), api_key: z.string().optional(),
  api: z.enum(['auto', 'responses', 'chat']).default('auto'), reasoning_effort: z.string().optional(),
  context_size: z.number().int().positive().optional(),
});
const configSchema = z.object({
  version: z.literal(1), default_provider: z.string(), generator_provider: z.string().optional(),
  providers: z.record(z.string(), providerSchema),
  judges: z.array(z.object({ id: z.string(), provider: z.string(), family: z.string(), teacher_pool: z.boolean().default(false) })).length(3),
  image: z.string().default('elpisbench:latest'), concurrency: z.number().int().min(1).max(16).default(3),
  allow_private_input: z.boolean().default(false), data_directory: z.string().optional(),
});
export type BenchConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;

export function configPath(arg?: string): string { return path.resolve(arg ?? process.env.ELPISBENCH_CONFIG ?? path.join(privateDataRoot(), 'config.yaml')); }
export function loadBenchConfig(arg?: string): BenchConfig {
  const file = configPath(arg);
  let raw: unknown;
  try { raw = YAML.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`unable to read ElpisBench config ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const config = configSchema.parse(raw);
  for (const name of [config.default_provider, config.generator_provider, ...config.judges.map((j) => j.provider)].filter(Boolean) as string[]) {
    if (!config.providers[name]) throw new Error(`ElpisBench config references unknown provider ${JSON.stringify(name)}`);
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.provider_type === 'openai-compatible' && (!provider.base_url || !provider.api_key)) throw new Error(`provider ${name}: openai-compatible requires base_url and api_key`);
    if (provider.provider_type === 'codex-oauth' && provider.base_url && provider.base_url.replace(/\/+$/, '') !== 'https://chatgpt.com/backend-api') throw new Error(`provider ${name}: codex-oauth is pinned to https://chatgpt.com/backend-api`);
    if (provider.provider_type === 'codex-oauth' && provider.api === 'chat') throw new Error(`provider ${name}: codex-oauth does not support api: chat`);
  }
  return config;
}

export const EXAMPLE_CONFIG = `version: 1
default_provider: sol
generator_provider: sol
image: elpisbench:latest
concurrency: 3
allow_private_input: false
providers:
  sol:
    provider_type: codex-oauth
    model: gpt-5.6
  opus:
    provider_type: anthropic-oauth
    model: claude-opus-5
  external-judge:
    provider_type: openai-compatible
    model: gemini-2.5-pro
    base_url: https://generativelanguage.googleapis.com/v1beta/openai
    api_key: replace-me
judges:
  - { id: blind-a, provider: sol, family: openai, teacher_pool: true }
  - { id: blind-b, provider: opus, family: anthropic, teacher_pool: true }
  - { id: blind-c, provider: external-judge, family: google, teacher_pool: false }
`;
