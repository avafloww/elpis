import { createHash } from 'node:crypto';
import type { Episode } from '../schema.js';

const secretPatterns = [
  /\b(?:sk|xox[baprs]|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
];
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?:\+?\d[\d .()-]{7,}\d)/g;
const absolutePathPattern = /(?:\/home|\/Users|[A-Za-z]:\\Users)[/\\][^\s"']+/g;
const discordIdPattern = /\b\d{15,22}\b/g;

export interface SanitizationResult {
  episode: Episode;
  findings: string[];
  aliases: Record<string, string>;
}
function stableAlias(
  kind: string,
  value: string,
  aliases: Record<string, string>,
): string {
  if (!aliases[value])
    aliases[value] =
      `<${kind}_${Object.keys(aliases).filter((v) => aliases[v].startsWith(`<${kind}_`)).length + 1}>`;
  return aliases[value];
}
function cleanText(input: string, aliases: Record<string, string>): string {
  let text = input;
  for (const pattern of secretPatterns)
    text = text.replace(pattern, (v) => stableAlias('secret', v, aliases));
  text = text.replace(emailPattern, (v) => stableAlias('email', v, aliases));
  text = text.replace(phonePattern, (v) => stableAlias('phone', v, aliases));
  text = text.replace(absolutePathPattern, (v) =>
    stableAlias('path', v, aliases),
  );
  text = text.replace(discordIdPattern, (v) => stableAlias('id', v, aliases));
  return text;
}
function deepClean(value: unknown, aliases: Record<string, string>): unknown {
  if (typeof value === 'string') return cleanText(value, aliases);
  if (Array.isArray(value)) return value.map((v) => deepClean(v, aliases));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !['attachment', 'image_url', 'audio_url'].includes(k))
        .map(([k, v]) => [k, deepClean(v, aliases)]),
    );
  return value;
}
export function privacyScan(value: unknown): string[] {
  const text = JSON.stringify(value);
  const findings: string[] = [];
  for (const [name, pattern] of [
    ['secret', secretPatterns[0]],
    ['oauth', secretPatterns[1]],
    ['hex-secret', secretPatterns[2]],
    ['email', emailPattern],
    ['phone', phonePattern],
    ['absolute-path', absolutePathPattern],
    ['discord-id', discordIdPattern],
  ] as const) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(name);
  }
  return findings;
}
export function sanitizeEpisode(episode: Episode): SanitizationResult {
  const aliases: Record<string, string> = {};
  const cleaned = deepClean(episode, aliases) as Episode;
  const findings = privacyScan(cleaned);
  return { episode: cleaned, findings, aliases };
}
export function assertRemoteSanitizationAllowed(
  remote: boolean,
  allowPrivateInput: boolean,
): void {
  if (remote && !allowPrivateInput)
    throw new Error(
      'remote sanitization of private-derived input is disabled; set allow_private_input: true explicitly',
    );
}
export function sourceOverlap(
  source: string,
  candidate: string,
  window = 64,
): number {
  const shingles = new Set<string>();
  for (let i = 0; i + window <= source.length; i += Math.max(1, window / 4))
    shingles.add(
      createHash('sha256')
        .update(source.slice(i, i + window))
        .digest('hex'),
    );
  let matches = 0,
    total = 0;
  for (
    let i = 0;
    i + window <= candidate.length;
    i += Math.max(1, window / 4)
  ) {
    total++;
    if (
      shingles.has(
        createHash('sha256')
          .update(candidate.slice(i, i + window))
          .digest('hex'),
      )
    )
      matches++;
  }
  return total ? matches / total : 0;
}
