// jslex.ts — a minimal, tolerant JS "lexer-lite" for heredoc expansion.
//
// blankLiterals finds `<<<TAG` markers in real code rather than inside a
// string, template, or comment before acorn parses the transformed program. It
// replaces literal/comment contents with spaces while preserving newlines and
// total length, so offsets map 1:1 onto the original.
//
// Deliberate tolerances (this is not a real lexer):
// - Template interpolation code is blanked with the template, so a heredoc
// marker inside `${...}` is not expanded.
// - Regex literals are not recognized. A regex containing a quote can start a
// phantom string; the failure mode is a missed marker, not source corruption.
// - Unterminated strings/comments at EOF blank to the end.
// short and the failure mode is a missed match, not corruption.
// - Unterminated strings/comments at EOF blank to the end (streaming-friendly).

export function blankLiterals(code: string): string {
  const out: string[] = [];
  type State =
    | 'code'
    | 'single'
    | 'double'
    | 'template'
    | 'line-comment'
    | 'block-comment';
  let state: State = 'code';
  // Depth of `${` nesting inside a template. Interpolations are blanked too,
  // but we must still track their braces to know when the template resumes,
  // and templates can nest inside interpolations — so count brace depth and
  // template depth together.
  let templateDepth = 0; // how many nested template literals we are inside
  let braceDepth = 0; // unmatched `{` inside the current interpolation stack

  const keep = (ch: string) => {
    out.push(ch);
  };
  const blank = (ch: string) => {
    out.push(ch === '\n' ? '\n' : ' ');
  };

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          keep(' ');
          blank(next);
          i++;
          state = 'line-comment';
          break;
        }
        if (ch === '/' && next === '*') {
          keep(' ');
          blank(next);
          i++;
          state = 'block-comment';
          break;
        }
        if (ch === "'") {
          keep(ch);
          state = 'single';
          break;
        }
        if (ch === '"') {
          keep(ch);
          state = 'double';
          break;
        }
        if (ch === '`') {
          keep(ch);
          state = 'template';
          templateDepth = 1;
          braceDepth = 0;
          break;
        }
        keep(ch);
        break;
      case 'single':
      case 'double': {
        const quote = state === 'single' ? "'" : '"';
        if (ch === '\\') {
          blank(ch);
          if (next !== undefined) {
            blank(next);
            i++;
          }
          break;
        }
        if (ch === quote) {
          keep(ch);
          state = 'code';
          break;
        }
        // An unescaped newline terminates a broken string literal — bail back
        // to code so one bad quote doesn't swallow the rest of the source.
        if (ch === '\n') {
          keep(ch);
          state = 'code';
          break;
        }
        blank(ch);
        break;
      }
      case 'template':
        if (ch === '\\') {
          blank(ch);
          if (next !== undefined) {
            blank(next);
            i++;
          }
          break;
        }
        if (ch === '`') {
          // Closing the innermost template. If it was opened inside an
          // interpolation, we stay in template state for the outer one.
          templateDepth--;
          if (templateDepth === 0) {
            keep(ch);
            state = 'code';
          } else {
            blank(ch);
          }
          break;
        }
        if (ch === '$' && next === '{') {
          blank(ch);
          blank(next);
          i++;
          braceDepth++;
          break;
        }
        if (braceDepth > 0) {
          // Inside an interpolation: blank it, but track nested braces and
          // nested template opens so we resume the right context.
          if (ch === '{') {
            blank(ch);
            braceDepth++;
            break;
          }
          if (ch === '}') {
            blank(ch);
            braceDepth--;
            break;
          }
          if (ch === '`') {
            blank(ch);
            templateDepth++;
            break;
          }
        }
        blank(ch);
        break;
      case 'line-comment':
        if (ch === '\n') {
          keep(ch);
          state = 'code';
          break;
        }
        blank(ch);
        break;
      case 'block-comment':
        if (ch === '*' && next === '/') {
          blank(ch);
          blank(next);
          i++;
          state = 'code';
          break;
        }
        blank(ch);
        break;
    }
  }
  return out.join('');
}
