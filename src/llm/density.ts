// density.ts — calibrated chars-per-token for the configured model.
//
// The harness estimates token counts between real completions with a
// chars/ratio formula. A fixed ratio drifts across models and content. Instead
// of shipping a large tokenizer for every provider, this learns from the usage
// data the server already returns: charsSent / prompt_tokens is a direct sample
// of the configured model's density.
//
// - Seed 4.0 until the first accepted sample lands.
// - First accepted sample sets the ratio outright; later ones blend by EWMA.
// - Clamp to [2, 6] so one pathological response can't poison the estimators.
// - Reject small prompts (< MIN_PROMPT_TOKENS): they are mostly fixed template
// overhead and misrepresent the steady-state density.
// - Persisted per model in agent.db's token_density table; a missing/corrupt row
// degrades to the seed. Nothing here may throw into the agent loop.

import type { Database } from '../store/db.js';
import type { Logger } from '../lib/log.js';

const SEED_RATIO = 4;
const ALPHA = 0.1;             // EWMA weight on each new sample
const MIN_RATIO = 2;
const MAX_RATIO = 6;
const MIN_PROMPT_TOKENS = 1000; // below this, the prompt is mostly template overhead
const LOG_DELTA = 0.05;        // log when the ratio moves at least this much

export interface DensityModel {
  ratio(): number;
  estimate(chars: number): number;
  observe(charsSent: number, promptTokens: number): void;
}

function clamp(x: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, x));
}

export function createDensityModel(db: Database, model: string, logger: Logger): DensityModel {
  let ratio = SEED_RATIO;
  let samples = 0;

 // Load any persisted ratio for this model. Never fatal.
  try {
    const row = db.prepare('SELECT ratio, samples FROM token_density WHERE model = ?').get(model) as
      | { ratio: number; samples: number }
      | undefined;
    if (row && Number.isFinite(row.ratio)) {
      ratio = clamp(row.ratio);
      samples = Number.isFinite(row.samples) && row.samples > 0 ? row.samples : 0;
    }
  } catch (e) {
    logger.warn(`[density] could not load persisted ratio for ${model}; using seed ${SEED_RATIO}: ${String(e)}`);
  }

  const upsert = db.prepare(
    `INSERT INTO token_density (model, ratio, samples, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET ratio = excluded.ratio, samples = excluded.samples, updated_at = excluded.updated_at`,
  );
  let persistWarned = false;

  return {
    ratio() {
      return ratio;
    },
    estimate(chars: number): number {
      if (!Number.isFinite(chars) || chars <= 0) return 0;
      return Math.ceil(chars / ratio);
    },
    observe(charsSent: number, promptTokens: number): void {
      if (!Number.isFinite(charsSent) || !Number.isFinite(promptTokens)) return;
      if (charsSent <= 0 || promptTokens < MIN_PROMPT_TOKENS) return;
      const sample = clamp(charsSent / promptTokens);
      const prev = ratio;
      ratio = samples === 0 ? sample : clamp((1 - ALPHA) * ratio + ALPHA * sample);
      samples++;
      try {
        upsert.run(model, ratio, samples, new Date().toISOString());
      } catch (e) {
        if (!persistWarned) {
          persistWarned = true;
          logger.warn(`[density] could not persist ratio for ${model} (continuing in memory): ${String(e)}`);
        }
      }
      if (Math.abs(ratio - prev) >= LOG_DELTA) {
        logger.info(`[density] ${model} chars/token ${prev.toFixed(3)} → ${ratio.toFixed(3)} (sample ${sample.toFixed(3)}, n=${samples})`);
      }
    },
  };
}
