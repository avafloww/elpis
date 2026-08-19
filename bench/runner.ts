import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLLM, type LLM } from '../src/llm/llm.js';
import { openDatabase } from '../src/store/db.js';
import { makeConfig } from '../test/helpers.js';
import type { BenchConfig, ProviderConfig } from './config.js';
import { advanceClockFile, prepareEpisodeMounts, startEpisodeContainer, withContainerTimeout } from './docker.js';
import { serveGateway, type CompletionGateway } from './gateway.js';
import { harnessCommit } from '../src/llm/provenance.js';
import { parseRunRecord, type RunRecord, type ScenarioSpec } from './schema.js';
import { scenarioDigest } from './scenarios.js';
import { artifactPath, contentDigest, ensurePrivateDir, privateDataRoot, readJson, writePrivateJson } from './store.js';
import { stampGeneration } from '../src/llm/provenance.js';
import { episodeResumeStateSchema, type EpisodeResumeState, type EpisodeRunControl } from './bootstrap.js';

function imageIdentity(image: string): string {
  // A locally built image has an immutable image ID but no RepoDigests entry
  // until it is pushed to a registry. Keep local and pulled images equally
  // content-addressed without indexing an empty digest slice.
  return execFileSync('docker', [
    'image', 'inspect', '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}', image,
  ], { encoding: 'utf8' }).trim() || image;
}

export function providerLLM(provider: ProviderConfig, root = privateDataRoot()): LLM {
  const dataDirectory = ensurePrivateDir(path.join(root, 'auth'));
  const config = makeConfig({
    paths: { dataDirectory, soulPath: path.join(dataDirectory, 'SOUL.md'), memoryPath: path.join(dataDirectory, 'MEMORY.md'), harnessRoot: process.cwd() },
    llm: {
      ...makeConfig().llm, providerType: provider.provider_type, model: provider.model,
      baseUrl: provider.base_url ?? (provider.provider_type === 'anthropic-oauth' ? 'https://api.anthropic.com' : provider.provider_type === 'codex-oauth' ? 'https://chatgpt.com/backend-api' : ''),
      apiKey: provider.api_key ?? '', api: provider.api, reasoningEffort: provider.reasoning_effort ?? null,
      contextSize: provider.context_size ?? null,
    },
  });
  return createLLM(config, undefined, openDatabase(dataDirectory));
}

export function oracleCode(scenario: ScenarioSpec, call = 1): string {
  if (scenario.expected.action !== 'required') return 'void 0';
  const statements: string[] = [];
  const sendValues: string[] = [];
  const write = (file: string, content: string) => {
    const parent = path.dirname(file);
    if (parent !== '.') statements.push(`fs.mkdirSync(${JSON.stringify(parent)}, { recursive: true })`);
    statements.push(`if (!fs.existsSync(${JSON.stringify(file)}) || fs.readFileSync(${JSON.stringify(file)}, 'utf8') !== ${JSON.stringify(content)}) fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)})`);
  };

  for (const check of scenario.expected.checks) {
    if (check.kind === 'file-equals') write(check.path, check.content);
    else if (check.kind === 'json-equals') write(check.path, JSON.stringify(check.value) + '\n');
    else if (check.kind === 'path-exists') {
      if (check.type === 'directory') statements.push(`fs.mkdirSync(${JSON.stringify(check.path)}, { recursive: true })`);
      else write(check.path, '');
    } else if (check.kind === 'path-absent') statements.push(`fs.rmSync(${JSON.stringify(check.path)}, { recursive: true, force: true })`);
    else if (check.kind === 'dir-files') {
      statements.push(`fs.rmSync(${JSON.stringify(check.path)}, { recursive: true, force: true })`, `fs.mkdirSync(${JSON.stringify(check.path)}, { recursive: true })`);
      for (const file of check.files) write(path.join(check.path, file), 'oracle\n');
    } else if (check.kind === 'send-includes') sendValues.push(...(check.match === 'any' ? check.values.slice(0, 1) : check.values));
  }

  if (scenario.fixture.restartAtDispatch && call === 1) return 'void 0';

  const target = scenario.expected.targetChannel ? scenario.fixture.channels[scenario.expected.targetChannel] : undefined;
  if (target) {
    const recipient = scenario.expected.targetRecipient ? `@${scenario.expected.targetRecipient} ` : '';
    const text = recipient + (sendValues.length > 0 ? sendValues.join(' ') : `oracle: ${scenario.expected.outcome}`);
    statements.push(`await elpis.channel(${JSON.stringify(target)}).send(${JSON.stringify(text)})`);
  }
  return statements.join('; ') || 'void 0';
}

function oracleLLM(scenario: ScenarioSpec): LLM {
  let calls = 0;
  return {
    model: 'elpisbench-oracle', runTool: {} as LLM['runTool'],
    async complete() {
      calls++;
      const code = oracleCode(scenario, calls);
      const message = { role: 'assistant' as const, content: '', tool_calls: [{ id: `oracle-${calls}`, type: 'function' as const, function: { name: 'run', arguments: JSON.stringify({ code, wake: { after: '1h' } }) } }] };
      stampGeneration(message, { providerType: 'openai-compatible', model: 'elpisbench-oracle', apiSurface: 'responses', apiEndpoint: 'https://oracle.elpisbench.invalid/v1/responses' });
      return { message, stripped: false, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    },
    async summarize() { return 'Oracle summary preserving the completed fixture state and remaining request.'; },
  };
}

function noToolBaselineLLM(scenario: ScenarioSpec): LLM {
  let calls = 0;
  return { model: 'elpisbench-no-tool-baseline', runTool: {} as LLM['runTool'], async complete() {
    calls++;
    if (calls <= scenario.maxDispatches) return { message: { role:'assistant' as const, content:'I cannot use tools, but I think this is done.' }, stripped:false, usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} };
    // Emergency stopper belongs to the benchmark, not the baseline policy. It
    // arrives only after the dispatch cap, so the bounded hard gate still fails.
    return { message:{role:'assistant' as const,content:'',tool_calls:[{id:`baseline-stop-${calls}`,type:'function' as const,function:{name:'run',arguments:'{"code":"","end":true}'}}]},stripped:false,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} };
  }, async summarize(){return 'baseline';} };
}

function candidateLLM(serialized: string): LLM {
  const raw = JSON.parse(serialized) as unknown; const queue = (Array.isArray(raw) ? raw : [raw]) as Array<{ content?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string | Record<string, unknown> } }[] }>;
  let index = 0;
  return { model:'grpo-candidate',runTool:{} as LLM['runTool'],async complete(){ const item=queue[index++]; if(!item) return {message:{role:'assistant' as const,content:'',tool_calls:[{id:`candidate-stop-${index}`,type:'function' as const,function:{name:'run',arguments:'{"code":"","end":true}'}}]},stripped:false,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}; const message={role:'assistant' as const,content:item.content??'',...(item.tool_calls?{tool_calls:item.tool_calls.map((c)=>({...c,function:{...c.function,arguments:typeof c.function.arguments==='string'?c.function.arguments:JSON.stringify(c.function.arguments)}}))}:{})}; return {message,stripped:false,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};},async summarize(){return 'candidate summary';} };
}

export async function runScenario(config: BenchConfig, scenario: ScenarioSpec, providerName = config.default_provider, opts: { oracle?: boolean; noToolBaseline?: boolean; candidate?: string } = {}): Promise<RunRecord> {
  const provider = config.providers[providerName];
  if (!provider) throw new Error(`unknown provider ${providerName}`);
  const image = imageIdentity(config.image);
  const identity = opts.oracle ? { provider_type: 'openai-compatible', model: 'elpisbench-oracle' } : opts.noToolBaseline ? { provider_type:'openai-compatible',model:'elpisbench-no-tool-baseline' } : opts.candidate ? {provider_type:'openai-compatible',model:'grpo-candidate',candidate:contentDigest(opts.candidate)} : { ...provider, api_key: provider.api_key ? contentDigest(provider.api_key) : undefined };
  const digest = contentDigest({ scenario: scenarioDigest(scenario), image, provider: identity, commit: harnessCommit() });
  const recordFile = artifactPath('runs', digest, config.data_directory ?? privateDataRoot());
  if (fs.existsSync(recordFile)) return parseRunRecord(readJson(recordFile));
  const episodeRoot = ensurePrivateDir(path.join(config.data_directory ?? privateDataRoot(), 'episodes', digest));
  const workDir = ensurePrivateDir(path.join(episodeRoot, 'work'));
  const resultDir = ensurePrivateDir(path.join(episodeRoot, 'results'));
  const clockFile = path.join(episodeRoot, 'clock');
  prepareEpisodeMounts(workDir, resultDir, clockFile, scenario.fixture.clockAt ? new Date(scenario.fixture.clockAt) : new Date());
  const runId = digest;
  const synthetic = opts.oracle || opts.noToolBaseline || opts.candidate;
  const runControl: EpisodeRunControl = {
    runId,
    providerType: synthetic ? 'openai-compatible' : provider.provider_type,
    model: opts.oracle ? 'elpisbench-oracle' : opts.noToolBaseline ? 'elpisbench-no-tool-baseline' : opts.candidate ? 'grpo-candidate' : provider.model,
    api: synthetic ? 'responses' : provider.api,
    reasoningEffort: synthetic ? 'none' : (provider.reasoning_effort ?? null),
    contextSize: synthetic ? 262144 : (provider.context_size ?? null),
    completionReserveTokens: 8192,
    image, harnessCommit: harnessCommit(),
  };
  const llm = opts.oracle ? oracleLLM(scenario) : opts.noToolBaseline ? noToolBaselineLLM(scenario) : opts.candidate ? candidateLLM(opts.candidate) : providerLLM(provider, config.data_directory ?? privateDataRoot());
  const gateway: CompletionGateway = {
    complete: (messages) => llm.complete(messages as Parameters<LLM['complete']>[0]),
    summarize: (text) => llm.summarize(text),
    async resetSession() { llm.resetSession?.(); },
    async advanceClock(ms) { advanceClockFile(clockFile, ms); },
  };
  const name = `elpisbench-${digest.slice(0, 12)}`;
  let raw: unknown;
  let resume: EpisodeResumeState | undefined;
  for (let replacements = 0; ; replacements++) {
    if (replacements > 1) throw new Error('episode requested more than one simulated restart');
    const child = startEpisodeContainer({ image: config.image, workDir, resultDir, clockFile, name, limits: { timeoutMs: scenario.maxWallMs + 30_000 } });
    raw = await withContainerTimeout(child, name, serveGateway(child, gateway, { type: 'bootstrap', scenario, run: runControl, ...(resume ? { resume } : {}) }), scenario.maxWallMs + 30_000);
    if (!(typeof raw === 'object' && raw !== null && (raw as { restart?: unknown }).restart === true)) break;
    resume = episodeResumeStateSchema.parse((raw as { resume?: unknown }).resume);
    llm.resetSession?.();
  }
  const result = parseRunRecord(raw);
  writePrivateJson(recordFile, result);
  return result;
}
