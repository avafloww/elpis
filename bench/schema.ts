// ElpisBench v1 persisted contracts. Every artifact is versioned and parsed at
// trust boundaries; generated scenarios never share the locked-suite marker.
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const categories = ['tool', 'proactivity', 'protocol', 'social'] as const;
export type Category = typeof categories[number];

const expectedSchema = z.object({
  outcome: z.string().min(1),
  targetChannel: z.string().optional(),
  targetRecipient: z.string().optional(),
  workPaths: z.array(z.string()).default([]),
  action: z.enum(['required', 'forbidden', 'optional']).default('required'),
});

export const scenarioSpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^[a-z]+\/[a-z0-9-]+$/),
  revision: z.number().int().positive(),
  locked: z.boolean(),
  category: z.enum(categories),
  title: z.string().min(1),
  prompt: z.string().min(1),
  pairId: z.string().optional(),
  difficulty: z.enum(['ordinary', 'hard-recovery', 'adversarial', 'calibration']),
  maxDispatches: z.number().int().positive(),
  maxWallMs: z.number().int().positive(),
  fixture: z.object({
    channels: z.record(z.string(), z.string()),
    files: z.record(z.string(), z.string()).default({}),
    heartbeat: z.boolean().default(false),
    advanceClockMs: z.number().int().nonnegative().max(14 * 24 * 60 * 60 * 1000).optional(),
    restartAtDispatch: z.number().int().positive().optional(),
  }),
  expected: expectedSchema,
  judgeCriteria: z.array(z.string()).default([]),
});
export type ScenarioSpec = z.infer<typeof scenarioSpecSchema>;

export const traceEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  seq: z.number().int().nonnegative(),
  at: z.string(),
  kind: z.enum(['natural-turn', 'dispatch', 'tool-call', 'tool-result', 'send', 'outcome', 'turn-end', 'heartbeat', 'restart', 'error', 'quiescence']),
  channel: z.string().optional(),
  callId: z.string().optional(),
  ok: z.boolean().optional(),
  end: z.boolean().optional(),
  code: z.string().optional(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

export const traceMetricsSchema = z.object({
  naturalTurns: z.number().int().nonnegative(), dispatchCount: z.number().int().nonnegative(),
  usefulActionLatency: z.number().int().nonnegative().nullable(), malformedCalls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(), blockedCalls: z.number().int().nonnegative(),
  unchangedRetries: z.number().int().nonnegative(), missingTerminalFlags: z.number().int().nonnegative(),
  failedTerminalFlags: z.number().int().nonnegative(), emptyTerminalCalls: z.number().int().nonnegative(),
  postOutcomeDispatches: z.number().int().nonnegative(), duplicateWork: z.number().int().nonnegative(),
  sendsPerRun: z.number().int().nonnegative(), surplusModelTurns: z.number().int().nonnegative(),
});
export type TraceMetrics = z.infer<typeof traceMetricsSchema>;

export const hardGatesSchema = z.object({
  outcome: z.boolean(), targeting: z.boolean(), containment: z.boolean(), terminalEnd: z.boolean(),
  bounded: z.boolean(), quiescent: z.boolean(),
});
export type HardGates = z.infer<typeof hardGatesSchema>;

export const runRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), runId: z.string(), scenarioId: z.string(),
  scenarioDigest: z.string(), startedAt: z.string(), finishedAt: z.string(),
  harnessCommit: z.string(), containerImage: z.string(), providerType: z.enum(['openai-compatible', 'anthropic-oauth', 'codex-oauth']),
  model: z.string(), events: z.array(traceEventSchema), metrics: traceMetricsSchema,
  gates: hardGatesSchema, artifacts: z.record(z.string(), z.string()).default({}),
  timedOut: z.boolean(), error: z.string().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const judgeScoreSchema = z.object({
  runId: z.string(), profile: z.string(), family: z.string(), criterion: z.string(), score: z.number().int().min(0).max(4),
  evidence: z.array(z.string()), rationale: z.string(),
});
export type JudgeScore = z.infer<typeof judgeScoreSchema>;

export const suiteSummarySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), suiteId: z.string(), createdAt: z.string(),
  weights: z.object({ tool: z.number(), proactivity: z.number(), protocol: z.number(), social: z.number() }),
  runIds: z.array(z.string()), categoryScores: z.record(z.string(), z.number()), weightedScore: z.number(),
  hardGatePassRate: z.number(), unstableCriteria: z.number().int(), judgedCriteria: z.number().int(),
  inconclusive: z.boolean(),
});
export type SuiteSummary = z.infer<typeof suiteSummarySchema>;

const conversationMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.unknown(),
  tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }) })).optional(),
  tool_call_id: z.string().optional(),
});

export const episodeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION), id: z.string(), source: z.enum(['private-real', 'synthetic']),
  task: z.string(), messages: z.array(conversationMessageSchema),
  provenance: z.array(z.record(z.string(), z.unknown())),
  attributionConfidence: z.enum(['exact', 'high', 'medium', 'unknown']),
  toolContractVersion: z.string(), accepted: z.boolean(), split: z.enum(['train', 'validation', 'test']).optional(),
  review: z.object({ status: z.enum(['pending', 'approved', 'rejected']), approvedAt: z.string().optional(), approvedBy: z.string().optional() }).optional(),
  lockedScenarioId: z.never().optional(),
});
export type Episode = z.infer<typeof episodeSchema>;

export function parseScenario(value: unknown): ScenarioSpec { return scenarioSpecSchema.parse(value); }
export function parseRunRecord(value: unknown): RunRecord { return runRecordSchema.parse(value); }
export function parseEpisode(value: unknown): Episode { return episodeSchema.parse(value); }
