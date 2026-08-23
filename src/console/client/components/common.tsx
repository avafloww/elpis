import type { ComponentChildren } from 'preact';
import { markdown, plain } from '../markdown';

export function relative(value: unknown): string {
  const time =
    typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(time)) return '—';
  const delta = Math.max(0, Date.now() - time);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function clock(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Markdown({
  value,
  className = '',
}: {
  value: unknown;
  className?: string;
}) {
  return (
    <div
      class={className}
      dangerouslySetInnerHTML={{ __html: markdown(value) }}
    />
  );
}

export function Status({ value }: { value: unknown }) {
  const status = plain(value) || 'unknown';
  return (
    <span class={`status status-${status.replaceAll('_', '-')}`}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class='empty-state'>{children}</div>;
}

export function Notice({
  tone = 'muted',
  children,
}: {
  tone?: string;
  children: ComponentChildren;
}) {
  return <div class={`notice notice-${tone}`}>{children}</div>;
}

export async function copy(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  }
}
