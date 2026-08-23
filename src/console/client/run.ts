import type { JsonObject } from './types.js';
import { object, text } from './types.js';

export interface RunResultParts {
  ok: boolean;
  value: string;
  console: string;
}

export interface WakePresentation {
  when: string;
  reason: string;
  raw: string;
}

export function splitRunResult(content: string): RunResultParts {
  const separator = '\n--- console ---\n';
  const index = content.indexOf(separator);
  const head = index < 0 ? content : content.slice(0, index);
  return {
    ok: !/\[run FAILED\]/.test(content),
    value: head
      .trim()
      .replace(/^\[run [^\]]*\]\n?/, '')
      .trim(),
    console: index < 0 ? '' : content.slice(index + separator.length),
  };
}

export function resultSummary(content: string, max = 220): string {
  const result = splitRunResult(content);
  const source =
    result.value || result.console || (result.ok ? 'completed' : 'failed');
  const oneLine = source.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function statementCount(code: string): number {
  const source = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  return Math.max(
    1,
    source
      .split(/;|\n/)
      .map((part) => part.trim())
      .filter(Boolean).length,
  );
}

export function wakePresentation(
  value: unknown,
  now = Date.now(),
): WakePresentation | null {
  const run = object(value);
  const wake = object(run.wake);
  if (!Object.keys(wake).length || text(wake.state) !== 'armed') return null;
  const targetAt = Number(wake.targetAt);
  const target = Number.isFinite(targetAt) ? new Date(targetAt) : null;
  const delta = target ? Math.max(0, target.getTime() - now) : 0;
  const minutes = Math.round(delta / 60_000);
  const relative =
    minutes < 60
      ? `in ${minutes}m`
      : `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const advice = object(wake.advice);
  const reason = text(advice.reason, text(wake.kind, 'scheduled')).replaceAll(
    '-',
    ' ',
  );
  const task = wake.taskId == null ? '' : `task #${String(wake.taskId)}`;
  return {
    when: target
      ? `Wake scheduled · ${target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, ${relative}`
      : 'Wake scheduled',
    reason,
    raw: [task, text(wake.kind), text(wake.state)].filter(Boolean).join(' · '),
  };
}

export function executionLabel(value: JsonObject | undefined): string {
  const execution = object(value?.execution);
  return text(execution.alias, text(execution.kind));
}
