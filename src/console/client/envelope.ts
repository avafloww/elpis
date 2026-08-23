const ENVELOPE_CHILD_TAGS = [
  'reply-to',
  'forwarded-from',
  'mentions',
  'animation-frames',
  'attachment-content',
];

function envelopeRegion(content: string): string | null {
  const open = content.indexOf('<incoming-message');
  if (open < 0) return null;
  const openEnd = content.indexOf('>', open);
  if (openEnd < 0) return null;
  const close = content.lastIndexOf('</incoming-message>');
  return close > openEnd
    ? content.slice(openEnd + 1, close)
    : content.slice(openEnd + 1);
}

function stripLeadingChildren(region: string): string {
  let pos = 0;
  for (;;) {
    while (pos < region.length && /\s/.test(region[pos] ?? '')) pos++;
    const rest = region.slice(pos);
    const tag = ENVELOPE_CHILD_TAGS.find((name) => rest.startsWith(`<${name}`));
    if (tag) {
      const close = region.indexOf(`</${tag}>`, pos);
      if (close < 0) break;
      pos = close + tag.length + 3;
      continue;
    }
    const attachment = rest.match(/^attachment#\d+:[^\n]*/);
    if (attachment) {
      pos += attachment[0].length;
      continue;
    }
    break;
  }
  return region.slice(pos);
}

export interface EnvelopeAttachment {
  name: string;
  contentType: string;
  size: number;
  localPath: string | null;
}

export function utterance(content: unknown): string {
  const source = typeof content === 'string' ? content : '';
  const region = envelopeRegion(source);
  return (region === null ? source : stripLeadingChildren(region)).trim();
}

export function attachmentsOf(content: unknown): EnvelopeAttachment[] {
  const source = typeof content === 'string' ? content : '';
  const region = envelopeRegion(source);
  if (region === null) return [];
  const output: EnvelopeAttachment[] = [];
  let pos = 0;
  for (;;) {
    while (pos < region.length && /\s/.test(region[pos] ?? '')) pos++;
    const rest = region.slice(pos);
    const tag = ENVELOPE_CHILD_TAGS.find((name) => rest.startsWith(`<${name}`));
    if (tag) {
      const close = region.indexOf(`</${tag}>`, pos);
      if (close < 0) break;
      pos = close + tag.length + 3;
      continue;
    }
    const line = rest.match(/^attachment#\d+:[^\n]*/);
    if (!line) break;
    const match = line[0].match(
      /^attachment#\d+: (.*) \(([^()]*), (\d+) bytes\)( -> (.*?))?( \(inlined below\))?$/,
    );
    if (match)
      output.push({
        name: match[1] ?? '',
        contentType: match[2] ?? '',
        size: Number(match[3]),
        localPath: match[5] || null,
      });
    pos += line[0].length;
  }
  return output;
}

export function attachmentUrl(localPath: string | null): string | null {
  if (!localPath) return null;
  const normalized = localPath.replaceAll('\\', '/');
  const marker = '/elpis-attach/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  const parts = normalized
    .slice(index + marker.length)
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  return `/attachments/${parts.map(encodeURIComponent).join('/')}`;
}
