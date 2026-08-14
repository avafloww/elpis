// names.ts — session identity for the fleet: the permanent `f-xxxxxx` id and
// the human-facing adjective-noun name.
//
// A session gets both: `newSessionId` mints a permanent, never-reused
// reference (assigned once at creation and immutable thereafter); it is
// always addressable by id even if its name is later contested. `id` and
// `name` share one reference namespace (both resolve a session), so
// `validateName` rejects anything starting with `f-` — that prefix is
// reserved for ids and a colliding name would make `f-...` ambiguous.
//
// Randomness is `node:crypto`'s `randomInt` throughout (never `Math.random`)
// since ids and name collisions matter for uniqueness guarantees, not just
// cosmetics.

import { randomInt } from 'node:crypto';

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Permanent, never-reused session id: 'f-' + 6 base36 chars. */
export function newSessionId(): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += BASE36[randomInt(BASE36.length)];
  }
  return `f-${suffix}`;
}

const ADJECTIVES = [
  'brisk', 'amber', 'quiet', 'bold', 'calm', 'crisp', 'dusty', 'eager',
  'faded', 'gentle', 'honest', 'icy', 'jolly', 'keen', 'lively', 'mellow',
  'noble', 'olive', 'plain', 'quick', 'rustic', 'solid', 'tidy', 'vivid',
];

const NOUNS = [
  'otter', 'anvil', 'kestrel', 'birch', 'cedar', 'delta', 'ember', 'falcon',
  'granite', 'harbor', 'ibis', 'juniper', 'kelp', 'lantern', 'marsh', 'nectar',
  'oak', 'pebble', 'quartz', 'raven', 'sable', 'thistle', 'urchin', 'willow',
];

const COMBO_COUNT = ADJECTIVES.length * NOUNS.length;

function randomCombo(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  return `${adjective}-${noun}`;
}

/**
 * Adjective-noun kebab name, retried against `taken` on collision. If every
 * combo in the word lists is somehow taken, falls back to a deterministic
 * numeric-suffix escape (`<first-combo>-2`, `-3`, ...) off the first
 * adjective-noun pair so this always terminates rather than looping forever.
 */
export function generateName(taken: Set<string>): string {
  for (let i = 0; i < COMBO_COUNT; i++) {
    const candidate = randomCombo();
    if (!taken.has(candidate)) return candidate;
  }
  const base = `${ADJECTIVES[0]}-${NOUNS[0]}`;
  let n = 2;
  let candidate = `${base}-${n}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Throws unless `name` is a valid session name; never returns falsy. */
export function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid session name ${JSON.stringify(name)}: must match ${NAME_RE} ` +
        '(1-40 chars, lowercase letters/digits/hyphens, starting with a letter or digit)'
    );
  }
  if (name.startsWith('f-')) {
    throw new Error(
      `invalid session name ${JSON.stringify(name)}: must not start with "f-" (reserved for session ids)`
    );
  }
}
