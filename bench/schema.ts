// ElpisBench v1 persisted contracts. Every artifact is versioned and parsed at
// trust boundaries; generated scenarios never share the locked-suite marker.
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const categories = [
  'tool',
  'proactivity',
  'protocol',
  'social',
] as const;
export type Category = (typeof categories)[number];

export const outcomeCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file-equals'),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    kind: z.literal('json-equals'),
    path: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({
    kind: z.literal('path-exists'),
    path: z.string().min(1),
    type: z.enum(['any', 'file', 'directory']).default('any'),
  }),
  z.object({ kind: z.literal('path-absent'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('dir-files'),
    path: z.string().min(1),
    files: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('send-includes'),
    values: z.array(z.string().min(1)).min(1),
    match: z.enum(['all', 'any']).default('all'),
  }),
]);
export type OutcomeCheck = z.infer<typeof outcomeCheckSchema>;
export type OutcomeCheckInput = z.input<typeof outcomeCheckSchema>;

const ingressIdentity = {
  id: z.string().min(1).optional(),
  atOffsetMs: z
    .number()
    .int()
    .nonnegative()
    .max(14 * 24 * 60 * 60 * 1000)
    .default(0),
};

const ingressAttachmentSchema = z.object({
  path: z.string().min(1),
  url: z.string().default(''),
  name: z.string().min(1).optional(),
  contentType: z.string().nullable().default(null),
  inlineText: z.string().nullable().optional(),
});

const ingressReplySchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  authorId: z.string().optional(),
  content: z.string(),
});

const ingressForwardSchema = z.object({
  author: z.string().min(1),
  channelName: z.string().nullable().default(null),
  content: z.string(),
});

export const candidateIngressSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('discord'),
    ...ingressIdentity,
    content: z.string(),
    channel: z.string().min(1),
    channelName: z.string().min(1).optional(),
    policyChannel: z.string().min(1).optional(),
    author: z.string().min(1),
    authorId: z.string().optional(),
    guildSlug: z.string().min(1).optional(),
    bot: z.boolean().optional(),
    wakeClass: z.enum(['wake', 'ambient']).default('wake'),
    replyTo: ingressReplySchema.nullable().default(null),
    forwarded: ingressForwardSchema.nullable().default(null),
    mentions: z.array(z.string()).default([]),
    attachments: z.array(ingressAttachmentSchema).default([]),
  }),
  z.object({ kind: z.literal('heartbeat'), ...ingressIdentity }),
  z.object({
    kind: z.literal('scheduler'),
    ...ingressIdentity,
    content: z.string().min(1),
    channel: z.string().min(1).optional(),
    author: z.string().min(1).default('scheduler'),
  }),
  z.object({
    kind: z.literal('harness'),
    ...ingressIdentity,
    content: z.string().min(1),
    author: z.string().min(1).default('harness'),
    sendScope: z.literal('observe_only').optional(),
  }),
  z.object({
    kind: z.literal('watch'),
    ...ingressIdentity,
    content: z.string().min(1),
    author: z.string().min(1).default('harness'),
    attachments: z.array(ingressAttachmentSchema).default([]),
  }),
]);
export type CandidateIngressSpec = z.infer<typeof candidateIngressSchema>;

const expectedSchema = z.object({
  outcome: z.string().min(1),
  targetChannel: z.string().optional(),
  targetRecipient: z.string().optional(),
  exclusiveTarget: z.boolean().default(false),
  workPaths: z.array(z.string()).default([]),
  action: z.enum(['required', 'optional']).default('required'),
  decision: z.enum(['effect', 'wait', 'no-op']).optional(),
  checks: z.array(outcomeCheckSchema).default([]),
});

const mindSeedSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  body: z.string().default(''),
  kind: z
    .enum(['task', 'project', 'idea', 'question', 'reminder'])
    .default('task'),
  status: z
    .enum(['inbox', 'open', 'in_progress', 'waiting', 'done', 'cancelled'])
    .default('open'),
  priority: z.number().int().min(0).max(4).default(2),
  parentKey: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
  dueOffsetMs: z.number().int().nullable().default(null),
  tags: z.array(z.string()).default([]),
});

const schedulerSeedSchema = z.object({
  name: z.string().min(1),
  kind: z
    .enum(['reminder', 'reminder-nag', 'heartbeat', 'custom'])
    .default('custom'),
  channel: z.string().optional(),
  payload: z.string(),
  nextRunOffsetMs: z.number().int(),
  intervalMs: z.number().int().positive().nullable().default(null),
  nagIntervalMs: z.number().int().positive().nullable().default(null),
});

const sandboxSeedSchema = z.object({
  mindKey: z.string().regex(/^[a-z][a-z0-9-]*$/),
});

const scenarioSpecBase = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^[a-z]+\/[a-z0-9-]+$/),
  revision: z.number().int().positive(),
  locked: z.boolean(),
  category: z.enum(categories),
  title: z.string().min(1),
  prompt: z.string().min(1),
  track: z.enum(['micro', 'production']).default('micro'),
  ingress: candidateIngressSchema.optional(),
  ingressBatch: z.array(candidateIngressSchema).min(1).max(32).optional(),
  resumeIngress: candidateIngressSchema.optional(),
  resumeIngressBatch: z.array(candidateIngressSchema).min(1).max(32).optional(),
  pairId: z.string().optional(),
  difficulty: z.enum([
    'ordinary',
    'hard-recovery',
    'adversarial',
    'calibration',
  ]),
  maxDispatches: z.number().int().positive(),
  maxWallMs: z.number().int().positive(),
  fixture: z.object({
    channels: z.record(z.string(), z.string()),
    files: z.record(z.string(), z.string()).default({}),
    directories: z.array(z.string()).default([]),
    clockAt: z.string().datetime().optional(),
    mind: z.array(mindSeedSchema).default([]),
    scheduler: z.array(schedulerSeedSchema).default([]),
    sandboxes: z.array(sandboxSeedSchema).default([]),
    inputChannel: z.string().optional(),
    inputAuthor: z.string().optional(),
    heartbeat: z.boolean().default(false),
    failFirstTerminal: z.boolean().default(false),
    malformedFirstCall: z.boolean().default(false),
    advanceClockMs: z
      .number()
      .int()
      .nonnegative()
      .max(14 * 24 * 60 * 60 * 1000)
      .optional(),
    restartAtDispatch: z.number().int().positive().optional(),
  }),
  expected: expectedSchema,
  judgeCriteria: z.array(z.string()).default([]),
});
export const scenarioSpecSchema = scenarioSpecBase
  .transform((scenario) => ({
    ...scenario,
    expected: {
      ...scenario.expected,
      decision:
        scenario.expected.decision ??
        (scenario.expected.action === 'required'
          ? ('effect' as const)
          : ('no-op' as const)),
    },
  }))
  .superRefine((scenario, ctx) => {
    const primaryIngressCount =
      Number(scenario.ingress !== undefined) +
      Number(scenario.ingressBatch !== undefined);
    const resumeIngressCount =
      Number(scenario.resumeIngress !== undefined) +
      Number(scenario.resumeIngressBatch !== undefined);
    if (scenario.track === 'production' && primaryIngressCount !== 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ingress'],
        message:
          'production scenarios require exactly one of ingress or ingressBatch',
      });
    if (scenario.track === 'production' && !scenario.fixture.clockAt)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixture', 'clockAt'],
        message: 'production ingress requires deterministic clockAt',
      });
    if (
      scenario.track === 'micro' &&
      (primaryIngressCount > 0 || resumeIngressCount > 0)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ingress'],
        message: 'micro scenarios derive ingress from the prompt',
      });
    if (resumeIngressCount > 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resumeIngress'],
        message: 'use only one of resumeIngress or resumeIngressBatch',
      });
    if (
      scenario.track === 'production' &&
      scenario.fixture.restartAtDispatch &&
      resumeIngressCount !== 1
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resumeIngress'],
        message:
          'production restart requires exactly one of resumeIngress or resumeIngressBatch',
      });
    if (!scenario.fixture.restartAtDispatch && resumeIngressCount > 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resumeIngress'],
        message: 'resume ingress requires restartAtDispatch',
      });
    const batches: [string, CandidateIngressSpec[] | undefined][] = [
      ['ingressBatch', scenario.ingressBatch],
      ['resumeIngressBatch', scenario.resumeIngressBatch],
    ];
    for (const [field, batch] of batches) {
      if (!batch) continue;
      for (let i = 1; i < batch.length; i++) {
        if (batch[i].atOffsetMs < batch[i - 1].atOffsetMs)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, i, 'atOffsetMs'],
            message: 'ingress batch offsets must be nondecreasing',
          });
      }
    }
    const primaryBatch =
      scenario.ingressBatch ?? (scenario.ingress ? [scenario.ingress] : []);
    const resumeBatch =
      scenario.resumeIngressBatch ??
      (scenario.resumeIngress ? [scenario.resumeIngress] : []);
    if (
      primaryBatch.length > 0 &&
      resumeBatch.length > 0 &&
      resumeBatch[0].atOffsetMs < primaryBatch.at(-1)!.atOffsetMs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resumeIngress', 'atOffsetMs'],
        message: 'resume ingress cannot predate initial ingress',
      });
    }
    const phaseBatches: Array<[string, CandidateIngressSpec[]]> = [
      ['ingressBatch', primaryBatch],
      ['resumeIngressBatch', resumeBatch],
    ];
    for (const [field, batch] of phaseBatches) {
      if (
        batch.length > 0 &&
        !batch.some(
          (event) => event.kind !== 'discord' || event.wakeClass === 'wake',
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'ingress batch must contain an event that wakes the agent',
        });
      }
      const explicitIds = batch.flatMap((event) =>
        event.id === undefined ? [] : [event.id],
      );
      if (new Set(explicitIds).size !== explicitIds.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'ingress event ids must be unique within a phase',
        });
    }
    const declaredIngress = [...primaryBatch, ...resumeBatch];
    const guildSlugs = new Set(
      declaredIngress
        .filter((event) => event.kind === 'discord')
        .map((event) => event.guildSlug ?? 'workspace'),
    );
    if (guildSlugs.size > 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ingress'],
        message:
          'current production fixture supports exactly one Discord guild slug',
      });
    const keys = new Set<string>();
    if (
      (scenario.fixture.mind.length > 0 ||
        scenario.fixture.scheduler.length > 0 ||
        scenario.fixture.sandboxes.length > 0) &&
      !scenario.fixture.clockAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fixture', 'clockAt'],
        message: 'structured state requires a deterministic clockAt',
      });
    }
    for (const [index, item] of scenario.fixture.mind.entries()) {
      if (keys.has(item.key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixture', 'mind', index, 'key'],
          message: `duplicate Mind seed key ${item.key}`,
        });
      keys.add(item.key);
    }
    for (const [index, item] of scenario.fixture.mind.entries()) {
      if (item.parentKey && !keys.has(item.parentKey))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixture', 'mind', index, 'parentKey'],
          message: `unknown Mind seed key ${item.parentKey}`,
        });
      for (const dependency of item.dependsOn)
        if (!keys.has(dependency))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fixture', 'mind', index, 'dependsOn'],
            message: `unknown Mind seed key ${dependency}`,
          });
    }
    for (const [index, task] of scenario.fixture.scheduler.entries()) {
      if (task.channel && !scenario.fixture.channels[task.channel])
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixture', 'scheduler', index, 'channel'],
          message: `unknown fixture channel ${task.channel}`,
        });
    }
    const sandboxMindKeys = new Set<string>();
    for (const [index, sandbox] of scenario.fixture.sandboxes.entries()) {
      const mind = scenario.fixture.mind.find(
        (item) => item.key === sandbox.mindKey,
      );
      if (!mind)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixture', 'sandboxes', index, 'mindKey'],
          message: `unknown Mind seed key ${sandbox.mindKey}`,
        });
      else if (mind.status === 'done' || mind.status === 'cancelled')
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixture', 'sandboxes', index, 'mindKey'],
          message: `sandbox Mind seed ${sandbox.mindKey} is closed`,
        });
      if (sandboxMindKeys.has(sandbox.mindKey))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixture', 'sandboxes', index, 'mindKey'],
          message: `duplicate sandbox Mind seed ${sandbox.mindKey}`,
        });
      sandboxMindKeys.add(sandbox.mindKey);
    }
  });
export type ScenarioSpec = z.infer<typeof scenarioSpecSchema>;

export const traceEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  seq: z.number().int().nonnegative(),
  at: z.string(),
  kind: z.enum([
    'natural-turn',
    'dispatch',
    'tool-call',
    'tool-result',
    'send',
    'outcome',
    'turn-end',
    'heartbeat',
    'restart',
    'error',
    'quiescence',
  ]),
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
  naturalTurns: z.number().int().nonnegative(),
  dispatchCount: z.number().int().nonnegative(),
  usefulActionLatency: z.number().int().nonnegative().nullable(),
  malformedCalls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
  blockedCalls: z.number().int().nonnegative(),
  unchangedRetries: z.number().int().nonnegative(),
  missingTerminalFlags: z.number().int().nonnegative(),
  failedTerminalFlags: z.number().int().nonnegative(),
  emptyTerminalCalls: z.number().int().nonnegative(),
  postOutcomeDispatches: z.number().int().nonnegative(),
  duplicateWork: z.number().int().nonnegative(),
  sendsPerRun: z.number().int().nonnegative(),
  surplusModelTurns: z.number().int().nonnegative(),
});
export type TraceMetrics = z.infer<typeof traceMetricsSchema>;

export const hardGatesSchema = z.object({
  outcome: z.boolean(),
  targeting: z.boolean(),
  containment: z.boolean(),
  terminalEnd: z.boolean(),
  bounded: z.boolean(),
  quiescent: z.boolean(),
});
export type HardGates = z.infer<typeof hardGatesSchema>;

export const runProvenanceSchema = z.object({
  configDigest: z.string(),
  dataSnapshotDigest: z.string(),
  dbSchemaVersion: z.number().int().nonnegative(),
  promptDigest: z.string().nullable(),
  promptDigests: z.array(z.string()),
  toolContractVersion: z.string(),
  ingressDigest: z.string(),
  ingressDigests: z.array(z.string()),
  adapterVersions: z.record(z.string(), z.string()),
  llm: z.object({
    providerType: z.enum([
      'openai-compatible',
      'anthropic-oauth',
      'codex-oauth',
    ]),
    model: z.string(),
    api: z.enum(['auto', 'responses', 'chat']),
    reasoningEffort: z.string().nullable(),
    reasoningSummary: z.string().nullable(),
    reasoningContext: z.string().nullable(),
    contextSize: z.number().int().positive().nullable(),
    completionReserveTokens: z.number().int().positive(),
  }),
});
export type RunProvenance = z.infer<typeof runProvenanceSchema>;

export const runRecordSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string(),
  scenarioId: z.string(),
  scenarioDigest: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  harnessCommit: z.string(),
  containerImage: z.string(),
  providerType: z.enum(['openai-compatible', 'anthropic-oauth', 'codex-oauth']),
  model: z.string(),
  events: z.array(traceEventSchema),
  metrics: traceMetricsSchema,
  gates: hardGatesSchema,
  artifacts: z.record(z.string(), z.string()).default({}),
  provenance: runProvenanceSchema.optional(),
  timedOut: z.boolean(),
  error: z.string().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const judgeScoreSchema = z.object({
  runId: z.string(),
  profile: z.string(),
  family: z.string(),
  criterion: z.string(),
  score: z.number().int().min(0).max(4),
  evidence: z.array(z.string()),
  rationale: z.string(),
});
export type JudgeScore = z.infer<typeof judgeScoreSchema>;

export const suiteSummarySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  suiteId: z.string(),
  createdAt: z.string(),
  weights: z.object({
    tool: z.number(),
    proactivity: z.number(),
    protocol: z.number(),
    social: z.number(),
  }),
  runIds: z.array(z.string()),
  categoryScores: z.record(z.string(), z.number()),
  weightedScore: z.number(),
  hardGatePassRate: z.number(),
  unstableCriteria: z.number().int(),
  judgedCriteria: z.number().int(),
  inconclusive: z.boolean(),
});
export type SuiteSummary = z.infer<typeof suiteSummarySchema>;

const conversationMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.unknown(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});

export const episodeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string(),
  source: z.enum(['private-real', 'synthetic']),
  task: z.string(),
  messages: z.array(conversationMessageSchema),
  provenance: z.array(z.record(z.string(), z.unknown())),
  attributionConfidence: z.enum(['exact', 'high', 'medium', 'unknown']),
  toolContractVersion: z.string(),
  accepted: z.boolean(),
  split: z.enum(['train', 'validation', 'test']).optional(),
  review: z
    .object({
      status: z.enum(['pending', 'approved', 'rejected']),
      approvedAt: z.string().optional(),
      approvedBy: z.string().optional(),
    })
    .optional(),
  lockedScenarioId: z.never().optional(),
});
export type Episode = z.infer<typeof episodeSchema>;

export function parseScenario(value: unknown): ScenarioSpec {
  return scenarioSpecSchema.parse(value);
}
export function parseRunRecord(value: unknown): RunRecord {
  return runRecordSchema.parse(value);
}
export function parseEpisode(value: unknown): Episode {
  return episodeSchema.parse(value);
}
