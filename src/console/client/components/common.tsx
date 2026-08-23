import { marked } from 'marked';
import type { ComponentChildren } from 'preact';

marked.setOptions({ breaks: true, gfm: true });

export function clock(value: unknown): string {
  const time = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relative(value: unknown): string {
  const time = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function duration(from: unknown, to: unknown): string {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return '';
  const ms = end - start;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function Markdown({
  value,
  className = '',
}: {
  value: unknown;
  className?: string;
}) {
  const html = marked.parse(String(value ?? ''), { async: false });
  return (
    <div class={className} dangerouslySetInnerHTML={{ __html: String(html) }} />
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class='empty-state'>{children}</div>;
}

export function statusTone(status: unknown): string {
  const value = String(status ?? '').toLowerCase();
  if (['running', 'in_progress', 'claimed', 'ambiguous'].includes(value))
    return 'amber';
  if (['ready', 'idle', 'completed', 'finished'].includes(value))
    return 'green';
  if (['starting', 'spawning', 'waiting'].includes(value)) return 'teal';
  if (['failed', 'cancelled', 'blocked'].includes(value)) return 'red';
  if (value === 'open') return 'violet';
  if (value === 'proposal') return 'gold-dim';
  return 'muted';
}

export function statusLabel(status: unknown): string {
  return String(status ?? '').replaceAll('_', ' ');
}
