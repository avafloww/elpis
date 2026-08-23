// src/time.ts — small local-time display helpers for context envelopes.
// Uses the host's system timezone by default; tests may pass an IANA zone explicitly.
// An optional IANA zone argument is exposed for deterministic tests.

const HM_OPTIONS = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
} as const;
const STAMP_OPTIONS = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
} as const;

export function localHm(ms: number, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    ...HM_OPTIONS,
    timeZone,
  } as any);
  return `[${fmt.format(ms)}]`;
}

export function localStamp(ms: number, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    ...STAMP_OPTIONS,
    timeZone,
  } as any);
  const parts = fmt.formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  // e.g. [Sat Jul 13 · 22:04]
  return `[${weekday} ${month} ${day} · ${hour}:${minute}]`;
}
