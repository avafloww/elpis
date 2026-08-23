import { randomBytes } from 'node:crypto';

export type MindId = `elm-${string}`;

const FULL_RE = /^elm-[0-9a-z]{8}$/;
const PREFIX_RE = /^elm-[0-9a-z]{3,8}$/;

export function newMindId(
  bytes: (size: number) => Buffer = randomBytes,
): MindId {
  const limit = 36 ** 8;
  const ceiling = Math.floor(2 ** 48 / limit) * limit;
  let value: number;
  do value = bytes(6).readUIntBE(0, 6);
  while (value >= ceiling);
  return `elm-${(value % limit).toString(36).padStart(8, '0')}`;
}

export function isMindId(value: unknown): value is MindId {
  return typeof value === 'string' && FULL_RE.test(value);
}

export function isMindIdPrefix(value: unknown): value is string {
  return typeof value === 'string' && PREFIX_RE.test(value);
}

export function resolveMindRef<T extends { id: MindId; title: string }>(
  items: readonly T[],
  ref: unknown,
): T {
  if (typeof ref !== 'string' || !ref.trim())
    throw new Error(
      'mind: expected an elm-* id, unique prefix, or exact title',
    );
  const value = ref.trim();
  const exact = items.find((item) => item.id === value);
  if (exact) return exact;
  if (isMindIdPrefix(value)) {
    const matches = items.filter((item) => item.id.startsWith(value));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw new Error(
        `mind: ambiguous id prefix ${JSON.stringify(value)} (${matches.length} matches)`,
      );
  }
  const titles = items.filter((item) => item.title === value);
  if (titles.length === 1) return titles[0];
  if (titles.length > 1)
    throw new Error(
      `mind: ambiguous exact title ${JSON.stringify(value)} (${titles.length} matches)`,
    );
  throw new Error(`mind: no item matching ${JSON.stringify(value)}`);
}
