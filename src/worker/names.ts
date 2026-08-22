import { randomInt } from "node:crypto";

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const ADJECTIVES = [
  "brisk",
  "amber",
  "quiet",
  "bold",
  "calm",
  "crisp",
  "dusty",
  "eager",
  "faded",
  "gentle",
  "honest",
  "icy",
  "jolly",
  "keen",
  "lively",
  "mellow",
  "noble",
  "olive",
  "plain",
  "quick",
  "rustic",
  "solid",
  "tidy",
  "vivid",
];
const NOUNS = [
  "otter",
  "anvil",
  "kestrel",
  "birch",
  "cedar",
  "delta",
  "ember",
  "falcon",
  "granite",
  "harbor",
  "ibis",
  "juniper",
  "kelp",
  "lantern",
  "marsh",
  "nectar",
  "oak",
  "pebble",
  "quartz",
  "raven",
  "sable",
  "thistle",
  "urchin",
  "willow",
];
const COMBO_COUNT = ADJECTIVES.length * NOUNS.length;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function newWorkerId(): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += BASE36[randomInt(BASE36.length)];
  return `wrk-${suffix}`;
}

export function generateWorkerSlug(taken: Set<string>): string {
  for (let i = 0; i < COMBO_COUNT; i++) {
    const slug = `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
    if (!taken.has(slug)) return slug;
  }
  const base = `${ADJECTIVES[0]}-${NOUNS[0]}`;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export function validateWorkerSlug(slug: string): void {
  if (!SLUG_RE.test(slug) || slug.startsWith("wrk-")) {
    throw new Error(
      `invalid worker slug ${JSON.stringify(slug)}: expected 1-80 lowercase letters, digits, or hyphens and not the wrk- id prefix`,
    );
  }
}
