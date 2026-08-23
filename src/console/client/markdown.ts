function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

declare global {
  interface Window {
    marked?: {
      parse(source: string, options?: Record<string, unknown>): string;
    };
  }
}

export function markdown(value: unknown): string {
  const source = typeof value === 'string' ? value : '';
  const escaped = escapeHtml(source);
  try {
    return (
      window.marked?.parse(escaped, { gfm: true, breaks: false }) ??
      escaped.replaceAll('\n', '<br>')
    );
  } catch {
    return escaped.replaceAll('\n', '<br>');
  }
}

export function plain(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value == null
      ? ''
      : JSON.stringify(value, null, 2);
}
