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

/** Render a bounded Markdown subset into Signal's UTF-16 BodyRange units. */
export function formatSignalMarkdown(input: string): FormattedSignalText {
  try {
    const output: FormattedSignalText = { text: '', styles: [] };
    renderTokens(Lexer.lexInline(input, markdown.defaults), output, 0);
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
