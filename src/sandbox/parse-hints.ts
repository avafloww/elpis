// parse-hints.ts — targeted diagnostics for pre-parse (acorn) failures.
//
// A pre-parse failure costs the WHOLE turn: nothing in the program runs, so a
// batch of memory writes plus a send all evaporate together. Acorn's raw
// "Unexpected token (2:78)" points at the symptom; these hints name the cause.
//
// Grounded in a real audit of one 24h transcript: 10 tool failures, 7 of them
// pre-parse syntax errors, and every one fell into three buckets — an unclosed
// delimiter at EOF, a plain-quoted string spanning lines, and a backtick nested
// inside a template literal.

import { blankLiterals } from '../lib/jslex.js';

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

interface Frame {
  ch: string;
  line: number;
}

/** Scan literal-blanked source for bracket imbalance. Returns a human sentence
 * or null. Uses blankLiterals so braces inside strings/templates/comments and
 * inside lifted heredoc bodies do not count. */
export function delimiterProblem(code: string): string | null {
  const blanked = blankLiterals(code);
  const stack: Frame[] = [];
  let line = 1;
  for (let i = 0; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '\n') {
      line++;
      continue;
    }
    if (OPENERS[ch]) {
      stack.push({ ch, line });
      continue;
    }
    if (CLOSERS[ch]) {
      const top = stack.pop();
      if (!top) return `a stray \`${ch}\` on line ${line} closes nothing.`;
      if (top.ch !== CLOSERS[ch]) {
        return `\`${ch}\` on line ${line} does not match the \`${top.ch}\` opened on line ${top.line}.`;
      }
    }
  }
  if (stack.length > 0) {
    const f = stack[stack.length - 1];
    const plural =
      stack.length > 1 ? ` (${stack.length} unclosed in total)` : '';
    return `reached the end of the program with an unclosed \`${f.ch}\` opened on line ${f.line}${plural} — the closing \`${OPENERS[f.ch]}\` is missing.`;
  }
  return null;
}

/** Detect the "nested backtick" slip using acorn's OWN error position rather
 * than guessing from counts: a template literal containing a raw backtick is
 * closed early, so the parser trips at or just after that backtick. Counting
 * backticks per line cannot distinguish this from two adjacent templates —
 * the position can. */
function nestedBacktickAt(code: string, error: string): number | null {
  const m = /\((\d+):(\d+)\)/.exec(error);
  if (!m) return null;
  const lineNo = Number(m[1]);
  const col = Number(m[2]);
  const line = code.split('\n')[lineNo - 1];
  if (line === undefined) return null;
  const near = line.slice(Math.max(0, col - 2), col + 2);
  if (!near.includes('`')) return null;
  // Two or more backticks on the line means a template was already open.
  const count = (line.match(/`/g) ?? []).length;
  return count >= 2 ? lineNo : null;
}

/**
 * Build hint lines for a pre-parse failure. `code` is the heredoc-expanded
 * source acorn actually parsed (so positions and literal-blanking line up);
 * `rawCode` is what the agent typed, used only for heredoc/TS shape checks.
 */
export function parseFailureHints(
  code: string,
  rawCode: string,
  error: string,
): string[] {
  const hints: string[] = [];
  const hasHeredoc = /<<</.test(rawCode);

  const delim = delimiterProblem(code);
  if (delim) hints.push(`Likely cause: ${delim}`);

  if (/Unterminated string constant/i.test(error)) {
    hints.push(
      'A plain \'…\' or "…" string cannot span multiple lines. For multi-line text use a `<<<TAG` heredoc — the body is verbatim, no escaping.',
    );
  }

  const btLine = nestedBacktickAt(code, error);
  if (btLine !== null && !/Unterminated string constant/i.test(error)) {
    hints.push(
      `Line ${btLine} looks like a template literal containing a raw backtick, which closes it early. Use a \`<<<TAG\` heredoc for text that mentions backticks.`,
    );
  }

  if (
    !hasHeredoc &&
    /\b(as\s+(any|const|unknown|object|string|number|boolean)|:\s*\w+(\[\])?\s*[=,)]|interface\s+\w+|satisfies\s|<\s*\w+\s*>)/.test(
      rawCode,
    )
  ) {
    hints.push(
      'This looks like TypeScript syntax (`as` casts, type annotations, `interface`). The sandbox runs PLAIN JavaScript — remove all type syntax.',
    );
  } else if (hasHeredoc && hints.length === 0) {
    hints.push(
      'A `<<<TAG` heredoc is present. The opener must be `<<<TAG` (bare identifier, no quotes/dashes) followed by a newline; the terminator begins with the exact `TAG`, and everything after it on that physical line is preserved as JavaScript (`TAG,{ other });`, `TAG.trimEnd()`, or `TAG,<<<NEXT`). Body is verbatim — real newlines, no escapes.',
    );
  }

  return hints;
}
