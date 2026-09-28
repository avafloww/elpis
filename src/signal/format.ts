import { Lexer, Marked, type Token } from 'marked';

export type SignalTextStyleName =
  | 'BOLD'
  | 'ITALIC'
  | 'SPOILER'
  | 'STRIKETHROUGH'
  | 'MONOSPACE';

export interface SignalTextStyle {
  style: SignalTextStyleName;
  start: number;
  length: number;
}

export interface FormattedSignalText {
  text: string;
  styles: SignalTextStyle[];
}

const MAX_STYLE_RANGES = 128;
const STYLE_ORDER: SignalTextStyleName[] = [
  'BOLD',
  'ITALIC',
  'STRIKETHROUGH',
  'MONOSPACE',
  'SPOILER',
];
const TOKEN_STYLES: Record<string, SignalTextStyleName | undefined> = {
  strong: 'BOLD',
  em: 'ITALIC',
  del: 'STRIKETHROUGH',
  codespan: 'MONOSPACE',
  signalSpoiler: 'SPOILER',
};

const markdown = new Marked({
  extensions: [
    {
      name: 'signalSpoiler',
      level: 'inline',
      start(src) {
        const index = src.indexOf('||');
        return index < 0 ? undefined : index;
      },
      tokenizer(src) {
        const match = /^\|\|(?=\S)([\s\S]*?\S)\|\|/.exec(src);
        if (!match) return;
        return {
          type: 'signalSpoiler',
          raw: match[0],
          text: match[1],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      },
      renderer() {
        return false;
      },
      childTokens: ['tokens'],
    },
  ],
});

function renderTokens(
  tokens: Token[],
  output: { text: string; styles: SignalTextStyle[] },
  depth: number,
): void {
  for (const token of tokens) {
    if (depth > 32) {
      output.text += token.raw;
      continue;
    }
    const style = TOKEN_STYLES[token.type];
    if (style) {
      const start = output.text.length;
      if (
        token.type !== 'codespan' &&
        'tokens' in token &&
        Array.isArray(token.tokens)
      ) {
        renderTokens(token.tokens, output, depth + 1);
      } else {
        output.text +=
          'text' in token && typeof token.text === 'string'
            ? token.text
            : token.raw;
      }
      const length = output.text.length - start;
      if (length > 0) output.styles.push({ style, start, length });
      continue;
    }
    if (token.type === 'text' || token.type === 'escape') {
      output.text += token.text;
      continue;
    }
    if (token.type === 'br') {
      output.text += '\n';
      continue;
    }
    output.text += token.raw;
  }
}

interface SourceLine {
  start: number;
  end: number;
  content: string;
}

function sourceLine(input: string, start: number): SourceLine {
  let newline = start;
  while (
    newline < input.length &&
    input[newline] !== '\n' &&
    input[newline] !== '\r'
  ) {
    newline++;
  }
  if (newline === input.length) {
    return { start, end: input.length, content: input.slice(start) };
  }
  const end =
    input[newline] === '\r' && input[newline + 1] === '\n'
      ? newline + 2
      : newline + 1;
  return { start, end, content: input.slice(start, newline) };
}

function openingFence(
  content: string,
): { marker: '`' | '~'; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(content);
  if (!match) return null;
  const delimiter = match[1];
  if (delimiter[0] === '`' && match[2].includes('`')) return null;
  return { marker: delimiter[0] as '`' | '~', length: delimiter.length };
}

function closesFence(
  content: string,
  fence: { marker: '`' | '~'; length: number },
): boolean {
  const indent = /^ {0,3}/.exec(content)?.[0].length ?? 0;
  const candidate = content.slice(indent);
  let length = 0;
  while (candidate[length] === fence.marker) length++;
  return length >= fence.length && /^[ \t]*$/.test(candidate.slice(length));
}

function renderInline(
  input: string,
  output: { text: string; styles: SignalTextStyle[] },
): void {
  if (input.length === 0) return;
  renderTokens(Lexer.lexInline(input, markdown.defaults), output, 0);
}

function renderMarkdown(
  input: string,
  output: { text: string; styles: SignalTextStyle[] },
): void {
  let cursor = 0;
  let scan = 0;
  while (scan < input.length) {
    const line = sourceLine(input, scan);
    const fence = openingFence(line.content);
    if (!fence) {
      scan = line.end;
      continue;
    }

    let closing: SourceLine | null = null;
    let closingScan = line.end;
    while (closingScan < input.length) {
      const candidate = sourceLine(input, closingScan);
      if (closesFence(candidate.content, fence)) {
        closing = candidate;
        break;
      }
      closingScan = candidate.end;
    }
    renderInline(input.slice(cursor, line.start), output);
    if (!closing) {
      output.text += input.slice(line.start);
      return;
    }

    const start = output.text.length;
    // Keep the body byte-for-byte, including its final line break before the
    // stripped closing fence, so following text retains the original boundary.
    output.text += input.slice(line.end, closing.start);
    const length = output.text.length - start;
    if (length > 0) {
      output.styles.push({ style: 'MONOSPACE', start, length });
    }
    cursor = closing.end;
    scan = cursor;
  }
  renderInline(input.slice(cursor), output);
}

/** Render a bounded Markdown subset into Signal's UTF-16 BodyRange units. */
export function formatSignalMarkdown(input: string): FormattedSignalText {
  try {
    const output: FormattedSignalText = { text: '', styles: [] };
    renderMarkdown(input, output);
    if (output.styles.length > MAX_STYLE_RANGES) {
      return { text: input, styles: [] };
    }
    output.styles.sort(
      (a, b) =>
        a.start - b.start ||
        b.length - a.length ||
        STYLE_ORDER.indexOf(a.style) - STYLE_ORDER.indexOf(b.style),
    );
    return output;
  } catch {
    return { text: input, styles: [] };
  }
}
