import type { JsonObject } from './types.js';
import { object, text } from './types.js';

export function runAttribution(value: unknown): string {
  const run = object(value);
  const parts: string[] = [];
  const execution = object(run.execution);
  if (Object.keys(execution).length) {
    parts.push(text(execution.alias, text(execution.kind)));
    if (execution.lifecycle) parts.push(text(execution.lifecycle));
    if (execution.mindId != null)
      parts.push(`Mind #${String(execution.mindId)}`);
    if (execution.mindTitle) parts.push(text(execution.mindTitle));
    if (execution.mindStatus) parts.push(text(execution.mindStatus));
    if (execution.runId) parts.push(text(execution.runId));
    else if (execution.generation != null)
      parts.push(`g${String(execution.generation)}`);
    if (execution.resetGeneration != null)
      parts.push(`reset g${String(execution.resetGeneration)}`);
    if (execution.coldStart) parts.push('cold');
    if (execution.retiring) parts.push('retiring');
    if (execution.statusReminder) parts.push('status reminder');
    if (execution.classifierReminder) parts.push('classifier reminder');
  }
  if (run.detached)
    parts.push(`detached${run.bgId ? ` ${text(run.bgId)}` : ''}`);
  const wake = object(run.wake);
  if (Object.keys(wake).length) {
    let label = `wake ${text(wake.state)} · ${text(wake.kind)}`;
    if (wake.targetAt)
      label += ` → ${new Date(Number(wake.targetAt)).toISOString()}`;
    if (wake.taskId != null) label += ` · task #${String(wake.taskId)}`;
    const advice = object(wake.advice);
    if (Object.keys(advice).length)
      label += ` · ${text(advice.source)} ${Math.round(Number(advice.delayMs) / 60000)}m ${text(advice.reason)}`;
    parts.push(label);
  }
  return parts.filter(Boolean).join(' · ');
}

export function splitRunResult(content: string): {
  ok: boolean;
  value: string;
  console: string;
} {
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
