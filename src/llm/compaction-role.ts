// Early boot resolution for the optional conversation-compaction model.
//
// Keeping this separate from compactor construction makes the model-specific
// context probe and density selection testable, and lets boot fail before any
// worker services or file watchers have started.

import { configForLlmRole, type Config } from '../config.js';
import type { Database } from '../store/db.js';
import { createDensityModel, type DensityModel } from './density.js';
import { fetchContextWindow } from './llm.js';
import {
  validateSummaryInputBudget,
  type SummaryInputBudget,
} from './compactor.js';

/**
 * Operational allowance for provider request envelopes and injected text. It
 * includes the currently known Anthropic billing header and Claude identity.
 * This is deliberately explicit headroom, not proof from an exact tokenizer.
 */
export const COMPACTION_FRAMING_TOKENS = 1_024;

const GENERIC_SUMMARY_OUTPUT_TOKENS = 12_000;
const ANTHROPIC_SUMMARY_OUTPUT_TOKENS = 32_000;

export interface CompactionRoleBudgetDeps {
  fetchContextWindow?: typeof fetchContextWindow;
  createDensityModel?: (
    db: Database,
    model: string,
    logger: Config['logger'],
  ) => DensityModel;
}

/**
 * Resolve admission accounting for an explicitly configured compaction role.
 * Omission is a true no-op: no config projection, context lookup, density
 * model, or budget is created.
 */
export async function resolveCompactionRoleBudget(
  config: Config,
  db: Database,
  deps: CompactionRoleBudgetDeps = {},
): Promise<SummaryInputBudget | undefined> {
  if (!config.llm.registry.targets.compaction) return undefined;

  const compactionConfig = configForLlmRole(config, 'compaction');
  // A failed lookup is a boot error. In particular, do not fall back to the
  // foreground model's window: the summary request goes to this role's model.
  const contextWindowTokens = await (
    deps.fetchContextWindow ?? fetchContextWindow
  )(compactionConfig, db);
  const density = (deps.createDensityModel ?? createDensityModel)(
    db,
    compactionConfig.llm.model,
    compactionConfig.logger,
  );

  // Chat and Responses summaries have a native 12k output cap. Anthropic's
  // native cap is 32k. Codex also reserves at least 12k of context headroom;
  // that reserve is admission accounting, not an enforced Codex output cap.
  const nativeSummaryHeadroom =
    compactionConfig.llm.providerType === 'anthropic-oauth'
      ? ANTHROPIC_SUMMARY_OUTPUT_TOKENS
      : GENERIC_SUMMARY_OUTPUT_TOKENS;
  const budget: SummaryInputBudget = {
    contextWindowTokens,
    outputReserveTokens: Math.max(
      compactionConfig.llm.completionReserveTokens,
      nativeSummaryHeadroom,
    ),
    framingTokens: COMPACTION_FRAMING_TOKENS,
    estimateTokens: (text) => density.estimate(text.length),
  };

  // Validate during early resolution rather than waiting until services have
  // started and createCompactor is eventually constructed.
  validateSummaryInputBudget(budget);
  return budget;
}
