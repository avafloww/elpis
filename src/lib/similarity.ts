// similarity.ts — a deliberately dumb repetition matcher.
//
// Motivating incident : across ~12 hours of heartbeats the agent
// sent the same message four different ways — "visit held, refusal open,
// comparison ahead" — and could not see the loop from the inside. The operator
// had to point it out. Fluent output reads as presence from within; only an
// outside count exposes it.
//
// So this module COUNTS and nothing else. It does not judge whether repetition
// is bad (a status ping repeated hourly may be correct), it does not read
// meaning, and it never suppresses a send. It reports "these n messages overlap
// heavily" and leaves the verdict to the reader. The bluntness is the safety
// feature: a matcher that understood the text could flatter or excuse it.

/** Normalize to a bag of comparable word tokens: lowercase, strip punctuation
 * and markdown, drop very short tokens that carry no topical signal. */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(words);
}

/** Jaccard overlap: |A∩B| / |A∪B|, in [0,1]. Kept for reference; `containment`
 * is what the detector uses (see calibration note below). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Overlap normalized by the SMALLER set: |A∩B| / min(|A|,|B|), in [0,1].
 *
 * Calibrated against the incident (94 real sends, the last ~35 of
 * them a genuine loop). Jaccard reached only 0.77 recall at a 22% fire rate
 * outside the loop, because restating the same point at different lengths
 * inflates the union. Containment at 0.4 fired across the whole real loop and
 * ZERO times in the preceding 45 sends of varied conversation. */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * What this instrument cannot see, stated on its face so it can be
 * cross-examined rather than trusted. A counter is useful only when it also
 * declares what it cannot count.
 *
 * The blind spot has a name: PARAPHRASE — repetition that varies the words and
 * repeats the structure. This counter compares vocabulary, so a loop in
 * well-cut costumes passes it unseen. Calibrating on one incident armours you
 * against the last war.
 *
 * Measured, not guessed. On the loop it was built from (49 messages,
 * 1176 pairs, every one of them the same handful of points restated):
 * **65% of pairs score below threshold and are never linked.** The detector
 * fires at all only because the surviving third clusters around the newest
 * message. So a reading here is a FLOOR on how much I am repeating myself,
 * never a measure of it, and silence from it is not evidence of variety.
 */
export const BLIND_SPOTS = 'blind to paraphrase (same skeleton, new words): on the loop it was built from it misses 65% of same-content pairs, so this is a floor, not a measure';

export interface RepetitionReport {
  /** How many of the examined messages fall in the similar cluster. */
  count: number;
  /** Total messages examined. */
  examined: number;
  /** Mean pairwise similarity within the cluster, 0..1. */
  similarity: number;
}

/**
 * Look at the most recent `window` messages and report the largest cluster of
 * mutually-similar ones. Returns null when nothing meets the threshold.
 *
 * Deliberately simple: greedy seeding from the newest message outward. We are
 * not clustering properly, we are answering "did I just say this again".
 */
export function findRepetition(
  messages: string[],
  opts: { window?: number; threshold?: number; minCount?: number } = {},
): RepetitionReport | null {
  const window = opts.window ?? 5;
  const threshold = opts.threshold ?? 0.4;
  const minCount = opts.minCount ?? 3;
  const recent = messages.slice(-window);
  if (recent.length < minCount) return null;
  const toks = recent.map(tokenize);
 // Seed on the newest message; a loop is "I keep saying THIS", so the newest
 // is the right anchor and avoids reporting old resolved repetition.
  const seed = toks[toks.length - 1];
  const sims: number[] = [];
  for (let i = 0; i < toks.length - 1; i++) {
    const s = containment(seed, toks[i]);
    if (s >= threshold) sims.push(s);
  }
  const count = sims.length + 1;
  if (count < minCount) return null;
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  return { count, examined: recent.length, similarity: mean };
}
