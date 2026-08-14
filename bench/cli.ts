#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authLogin } from './auth.js';
import { EXAMPLE_CONFIG, loadBenchConfig } from './config.js';
import { assertDoctor, doctor } from './doctor.js';
import { compareSummaries, buildSuiteSummary } from './scoring.js';
import { LOCKED_SCENARIOS } from './scenarios.js';
import { runScenario, providerLLM } from './runner.js';
import { parseEpisode, parseRunRecord, scenarioSpecSchema, suiteSummarySchema, type Episode, type JudgeScore, type ScenarioSpec } from './schema.js';
import { ensurePrivateDir, privateDataRoot, readJson, writePrivateJson } from './store.js';
import { epochsFromJournal, type JournalLine } from './data/epochs.js';
import { buildTranscriptIndex, type TranscriptIndex } from './data/index.js';
import { extractEpisodes, preferenceMutations, readJsonl, splitEpisodes, writeJsonl } from './data/pipeline.js';
import { assertRemoteSanitizationAllowed, sanitizeEpisode, sourceOverlap } from './data/sanitize.js';
import { privacyScan } from './data/sanitize.js';
import { publicizeEpisode, toHuggingFaceRow } from './data/export.js';
import { generateScenarioThroughSandbox } from './data/generate.js';
import { blindPacket, judgeRun } from './judge.js';

const argv = process.argv.slice(2);
const take = (name: string): string | undefined => { const i = argv.indexOf(name); if (i < 0) return undefined; const value = argv[i + 1]; argv.splice(i, 2); return value; };
const flag = (name: string): boolean => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const configArg = take('--config');
const output = (value: unknown): void => { process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`); };
const need = (value: string | undefined, message: string): string => { if (!value) throw new Error(message); return value; };

async function main(): Promise<void> {
  const command = argv.shift();
  if (!command || command === 'help' || command === '--help') return output(help());
  if (command === 'init') {
    const file = path.resolve(argv.shift() ?? path.join(privateDataRoot(), 'config.yaml')); ensurePrivateDir(path.dirname(file));
    if (fs.existsSync(file)) throw new Error(`${file} already exists`); fs.writeFileSync(file, EXAMPLE_CONFIG, { mode: 0o600 }); return output(file);
  }
  if (command === 'image' && argv.shift() === 'build') {
    const tag = take('--tag') ?? 'elpisbench:latest'; execFileSync('docker', ['build', '--pull', '--tag', tag, '--file', 'bench/docker/Dockerfile', '.'], { stdio: 'inherit' }); return;
  }
  const config = loadBenchConfig(configArg);
  if (command === 'doctor') { const checks = await doctor(config); output(checks); assertDoctor(checks); return; }
  if (command === 'auth' && argv.shift() === 'login') { await authLogin(argv.shift() ?? config.providers[config.default_provider].provider_type, config.data_directory ?? privateDataRoot()); return; }
  if (command === 'list') { const category = take('--category'); return output(LOCKED_SCENARIOS.filter((s) => !category || s.category === category).map((s) => ({ id: s.id, category: s.category, title: s.title, difficulty: s.difficulty }))); }
  if (command === 'run') {
    const oracle = flag('--oracle'); const baseline = take('--baseline'); if (oracle && baseline) throw new Error('--oracle and --baseline are mutually exclusive'); if (baseline && baseline !== 'no-tool') throw new Error('--baseline currently supports only no-tool');
    assertDoctor(await doctor(config, { skipProviders: oracle || baseline === 'no-tool' })); const provider = take('--provider') ?? config.default_provider; const out = take('--out'); const ids = argv.length ? new Set(argv) : null;
    const scenarios = LOCKED_SCENARIOS.filter((s) => !ids || ids.has(s.id)); if (!scenarios.length) throw new Error('no locked scenarios selected');
    const completed = await mapConcurrent(scenarios, config.concurrency, async (scenario) => { process.stderr.write(`run ${scenario.id}\n`); return runScenario(config, scenario, provider, { oracle, noToolBaseline: baseline === 'no-tool' }); });
    const summary = buildSuiteSummary(`suite-${Date.now()}`, completed.map((record) => ({ record, category: LOCKED_SCENARIOS.find((s) => s.id === record.scenarioId)!.category })));
    if (out) writePrivateJson(path.resolve(out), summary); return output(summary);
  }
  if (command === 'judge') {
    const scoresFile = take('--scores'); const packetsOnly = flag('--packets-only'); const recordFiles = argv.filter((v) => !v.startsWith('--'));
    const runs = recordFiles.map((file) => parseRunRecord(readJson(file))); const scores = scoresFile ? readJsonl<JudgeScore>(scoresFile) : [];
    if (packetsOnly) return output({ profiles: config.judges, blindPackets: runs.map((record) => blindPacket(record, LOCKED_SCENARIOS.find((s) => s.id === record.scenarioId)!)) });
    if (!scoresFile) {
      for (const record of runs) for (const profile of config.judges) {
        const scenario = LOCKED_SCENARIOS.find((s) => s.id === record.scenarioId); if (!scenario) throw new Error(`unknown locked scenario ${record.scenarioId}`);
        scores.push(...await judgeRun(providerLLM(config.providers[profile.provider], config.data_directory ?? privateDataRoot()), profile, record, scenario, config.data_directory ?? privateDataRoot()));
      }
    }
    const summary = buildSuiteSummary(`judged-${Date.now()}`, runs.map((record) => ({ record, category: LOCKED_SCENARIOS.find((s) => s.id === record.scenarioId)!.category, judges: scores.filter((s) => s.runId === record.runId) })));
    return output(summary);
  }
  if (command === 'compare') { const a = suiteSummarySchema.parse(readJson(need(argv.shift(), 'compare requires summary A'))); const b = suiteSummarySchema.parse(readJson(need(argv.shift(), 'compare requires summary B'))); return output(compareSummaries(a, b)); }
  if (command === 'calibrate') {
    const summaries = argv.map((file) => suiteSummarySchema.parse(readJson(file))); if (summaries.length < 2) throw new Error('calibrate requires at least two summaries');
    const values = summaries.map((s) => s.weightedScore); return output({ repeatability: Math.max(...values) - Math.min(...values), pass: Math.max(...values) - Math.min(...values) <= 0.03 && summaries.every((s) => !s.inconclusive) });
  }
  if (command === 'data') return dataCommand(config);
  throw new Error(`unknown command ${command}`);
}

async function dataCommand(config: ReturnType<typeof loadBenchConfig>): Promise<void> {
  const sub = argv.shift(); const out = take('--out');
  if (sub === 'epochs') { const lines = readJsonl<JournalLine>(need(argv.shift(), 'data epochs requires journal.jsonl')); const value = epochsFromJournal(lines); if (out) writePrivateJson(path.resolve(out), value); return output(value); }
  if (sub === 'index') { const roots = argv.length ? argv : [path.join(config.data_directory ?? privateDataRoot(), 'transcripts')]; const value = buildTranscriptIndex(roots); if (out) writePrivateJson(path.resolve(out), value); return output(value); }
  if (sub === 'extract') { const value = extractEpisodes(readJson(need(argv.shift(), 'data extract requires index.json')) as TranscriptIndex); if (out) writeJsonl(path.resolve(out), value.accepted); return output({ accepted: value.accepted.length, rejected: value.rejected }); }
  if (sub === 'sanitize') {
    const remote = flag('--remote'); assertRemoteSanitizationAllowed(remote, config.allow_private_input); const episodes = readJsonl<Episode>(need(argv.shift(), 'data sanitize requires episodes.jsonl'));
    const cleaned = episodes.map((e) => sanitizeEpisode(parseEpisode(e))); const failed = cleaned.filter((r) => r.findings.length); if (failed.length) throw new Error(`independent privacy scan found prohibited content in ${failed.length} episodes`);
    if (out) writeJsonl(path.resolve(out), cleaned.map((r) => r.episode)); return output({ sanitized: cleaned.length, aliases: cleaned.reduce((n, r) => n + Object.keys(r.aliases).length, 0) });
  }
  if (sub === 'generate') { const explicitBrief = take('--brief'); const brief = explicitBrief ?? argv.join(' '); need(brief, 'data generate requires a brief'); const provider = config.generator_provider ?? config.default_provider; const scenario = await generateScenarioThroughSandbox(providerLLM(config.providers[provider], config.data_directory ?? privateDataRoot()), brief, config.data_directory ?? privateDataRoot()); if (out) writePrivateJson(path.resolve(out), scenario); return output(scenario); }
  if (sub === 'validate') { const file = need(argv.shift(), 'data validate requires a JSON/JSONL file'); const values = file.endsWith('.jsonl') ? readJsonl<unknown>(file) : [readJson(file)]; const parsed = values.map((v) => { try { return scenarioSpecSchema.parse(v); } catch { return parseEpisode(v); } }); return output({ valid: parsed.length }); }
  if (sub === 'split') { const rows = splitEpisodes(readJsonl<Episode>(need(argv.shift(), 'data split requires episodes.jsonl')).map(parseEpisode)); if (out) writeJsonl(path.resolve(out), rows); return output({ rows: rows.length, splits: Object.fromEntries(['train','validation','test'].map((s) => [s, rows.filter((r) => r.split === s).length])) }); }
  if (sub === 'approve') { const by = need(take('--by'), 'data approve requires --by REVIEWER'); const rows = readJsonl<Episode>(need(argv.shift(), 'data approve requires sanitized episodes.jsonl')).map(parseEpisode); for (const row of rows) if (privacyScan(row).length) throw new Error(`privacy scan failed for ${row.id}`); const approved = rows.map((row) => ({ ...row, accepted: true, review: { status: 'approved' as const, approvedAt: new Date().toISOString(), approvedBy: by } })); if (out) writeJsonl(path.resolve(out), approved); return output({ approved: approved.length, reviewer: by }); }
  if (sub === 'export') { const publicMode = flag('--public'); const salt = take('--salt') ?? 'elpisbench-public-v1'; let rows = readJsonl<Episode>(need(argv.shift(), 'data export requires episodes.jsonl')).map(parseEpisode); if (publicMode) rows = rows.map((e) => publicizeEpisode(e, salt)); const exported = rows.map(toHuggingFaceRow); if (out) writeJsonl(path.resolve(out), exported); return output({ rows: exported.length, public: publicMode }); }
  if (sub === 'rollout') {
    if (!flag('--stdin')) throw new Error('data rollout currently accepts grouped candidates via --stdin'); const payload = JSON.parse(fs.readFileSync(0, 'utf8')) as { scenario: string; candidates: string[]; fake?: boolean };
    const scenario = LOCKED_SCENARIOS.find((s) => s.id === payload.scenario); if (!scenario) throw new Error(`unknown scenario ${payload.scenario}`);
    if (payload.fake) return output(payload.candidates.map((_, i) => ({ gates: { outcome:true,targeting:true,containment:true,terminalEnd:true,bounded:true,quiescent:true }, metrics: { surplusModelTurns:i,failedCalls:0 } })));
    const runs = []; for (const candidate of payload.candidates) runs.push(await runScenario(config, scenario, config.default_provider, { candidate })); return output(runs);
  }
  if (sub === 'preference') { const pairs = readJsonl<Episode>(need(argv.shift(), 'data preference requires episodes.jsonl')).flatMap((e) => preferenceMutations(parseEpisode(e))); if (out) writeJsonl(path.resolve(out), pairs); return output({ pairs: pairs.length }); }
  if (sub === 'overlap') { const a=fs.readFileSync(need(argv.shift(),'source required'),'utf8'), b=fs.readFileSync(need(argv.shift(),'candidate required'),'utf8'); return output({ overlap: sourceOverlap(a,b) }); }
  throw new Error(`unknown data command ${sub}`);
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> { const results = new Array<R>(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { for (;;) { const index = next++; if (index >= items.length) return; results[index] = await fn(items[index]); } })); return results; }
function help(): string { return `ElpisBench\n\nCommands:\n  init [file]\n  doctor\n  image build [--tag TAG]\n  auth login [anthropic-oauth|codex-oauth]\n  list [--category CATEGORY]\n  run [scenario ids...] [--provider NAME] [--oracle|--baseline no-tool] [--out FILE]\n  judge RECORD... [--scores JSONL]\n  compare A B\n  calibrate SUMMARY...\n  data epochs|index|extract|sanitize|generate|rollout|validate|split|approve|export|preference|overlap\n`; }
main().catch((error) => { process.stderr.write(`elpisbench: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
