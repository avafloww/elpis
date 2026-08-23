// transform.ts — persistence + top-level await surgery.
//
// Two jobs:
// 1. Persist top-level bindings across `run` calls. Naked `vm.runInContext`
// does NOT persist `let`/`const`/`class` (lexically scoped to one script).
// We rewrite top-level declarations into assignments on `globalThis`.
// 2. Support top-level `await`. We wrap the body in an async IIFE.
//
// The Node REPL trick (processTopLevelAwait): wrap in async IIFE, rewrite
// top-level declarations to globalThis assignments so they survive, return the
// final expression's value as the completion value.

import {
  parse as acornParse,
  type Node as AcornNode,
  type Program,
  type Statement,
  type Pattern,
  type VariableDeclaration,
  type Expression,
  type ExpressionStatement,
} from 'acorn';
import MagicString from 'magic-string';
import { RESERVED_GLOBALS } from './globals.js';
import { blankLiterals } from '../lib/jslex.js';

export interface TransformResult {
  /** On success: the rewritten source. On parse failure: the heredoc-expanded
   * source acorn was given (identical to the input when no heredocs), so
   * error line:col positions map onto it for the code frame. */
  code: string;
  /** true when the input parsed cleanly. */
  parsed: boolean;
  error?: string;
}

/** Extract all bound names from a destructuring Pattern. */
function boundNames(pattern: Pattern, out: string[] = []): string[] {
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'Property') {
          boundNames(prop.value as Pattern, out);
        } else if (prop.type === 'RestElement') {
          boundNames(prop.argument as Pattern, out);
        }
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (el) boundNames(el as Pattern, out);
      }
      break;
    case 'RestElement':
      boundNames(pattern.argument as Pattern, out);
      break;
    case 'AssignmentPattern':
      boundNames(pattern.left as Pattern, out);
      break;
    case 'MemberExpression':
      // destructuring target like a[0] — not a binding name
      break;
  }
  return out;
}

/** Source span of a node, sliced from the original string. */
function nodeSource(s: MagicString, node: AcornNode): string {
  return s.original.slice(node.start, node.end);
}

/**
 * Rewrite a single top-level node into globalThis assignments (in place on `s`).
 * The last top-level ExpressionStatement is handled separately (completion value).
 */
function rewriteTopLevel(node: Statement, s: MagicString): void {
  switch (node.type) {
    case 'VariableDeclaration': {
      const decl = node as VariableDeclaration;
      const parts: string[] = [];
      decl.declarations.forEach((d, i) => {
        const initText = d.init ? nodeSource(s, d.init) : undefined;
        if (d.id.type === 'Identifier') {
          const name = d.id.name;
          if (initText !== undefined) {
            parts.push(`globalThis.${name} = (${initText})`);
          } else {
            // no initializer: idempotent keep-defined. Use the prior value if any.
            parts.push(`globalThis.${name} = globalThis.${name}`);
          }
        } else {
          // destructuring
          const names = boundNames(d.id as Pattern);
          const targetText = nodeSource(s, d.id);
          if (initText !== undefined) {
            const tmp = `__d${i}`;
            parts.push(`${tmp} = (${initText})`);
            // ({ a, b } = tmp) — parens mandatory or it parses as a block
            parts.push(`(${targetText} = ${tmp})`);
            for (const n of names) parts.push(`globalThis.${n} = ${n}`);
          } else {
            // no init destructuring: nothing meaningful to persist
            parts.push(`(${targetText} = void 0)`);
            for (const n of names)
              parts.push(`globalThis.${n} = globalThis.${n}`);
          }
        }
      });
      // Replace the entire declaration node with a sequence of assignments.
      // End with ';' so the next statement is cleanly separated regardless of
      // whether acorn's node.end includes the trailing semicolon (double ;; is
      // a harmless empty statement).
      s.overwrite(node.start, node.end, parts.join('; ') + ';');
      break;
    }

    case 'FunctionDeclaration': {
      // Rewrite `function f{}` → `globalThis.f = function f{}` (inline,
      // same as classes). Keeps the named-function-expression semantics so the
      // body can recurse on its own name, and persists onto globalThis.
      // (Hoisting is lost vs. a declaration, but the agent defines in one run
      // and calls in the next; defining-before-use within a run is normal.)
      const name = node.id?.name;
      if (name) {
        const fnStart = node.start;
        const fnKeywordEnd = fnStart + 'function'.length;
        s.overwrite(fnStart, fnKeywordEnd, `globalThis.${name} = function`);
      }
      break;
    }

    case 'ClassDeclaration': {
      // Class declarations don't persist and don't hoist usefully here.
      // Rewrite `class C {}` → `globalThis.C = class C {}`
      const name = node.id?.name;
      if (name) {
        const classStart = node.start;
        const classKeywordEnd = classStart + 'class'.length;
        s.overwrite(classStart, classKeywordEnd, `globalThis.${name} = class`);
      }
      break;
    }

    default:
      // Import/export/other — leave untouched.
      break;
  }
}

/** Walk all bound names from a top-level declaration node (VariableDeclaration,
 * FunctionDeclaration, ClassDeclaration). Returns names that collide with a
 * reserved harness global — caught at pre-parse so the agent gets a one-line
 * teachable error instead of silently clobbering the helper. */
function reservedBindingNames(node: Statement): string[] {
  const out: string[] = [];
  const pushIfReserved = (name: string | undefined) => {
    if (name && (RESERVED_GLOBALS as Record<string, true>)[name])
      out.push(name);
  };
  switch (node.type) {
    case 'VariableDeclaration':
      for (const d of (node as VariableDeclaration).declarations) {
        if (d.id.type === 'Identifier') pushIfReserved(d.id.name);
        else
          out.push(
            ...boundNames(d.id as Pattern).filter(
              (n) => (RESERVED_GLOBALS as Record<string, true>)[n],
            ),
          );
      }
      break;
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      pushIfReserved((node as { id?: { name?: string } }).id?.name);
      break;
  }
  return out;
}

/** Upper bound on heredoc expansions per run — a runaway-loop backstop, far
 * above any real script. */
const HEREDOC_MAX = 100;

/**
 * Heredoc expansion (pre-parse): lift `<<<TAG … TAG` blocks into ordinary
 * string literals BEFORE acorn sees the source, so the agent can author
 * multi-line text (test fixtures, markdown, nested code) with ZERO escaping —
 * backticks, quotes, `${`, `\u`, backslashes are all literal.
 *
 * const block = <<<EOF
 * any text at all — `backticks`, "quotes", ${not-interpolated}, \u no escapes
 * EOF
 *
 * Rules:
 * - Opener: `<<<TAG` (TAG = [A-Za-z_][A-Za-z0-9_]*) followed by end-of-line.
 * `<<<` is not valid JS syntax anywhere, so no working code changes meaning.
 * - Content: every line between the opener line and the terminator line,
 * verbatim, INCLUDING the final newline (files usually want one; use
 * `.trimEnd` if not).
 * - Terminator: a line beginning with the exact TAG (leading blanks ok; a
 * longer identifier such as `TAGGED` does not match). Everything after TAG
 * on that physical line is preserved verbatim as JavaScript, so callers may
 * close a call, pass another argument, chain a method, add a comment, or open
 * the next heredoc without moving to another line. If content itself needs a
 * line beginning with the exact tag boundary, pick a different tag.
 * - Openers inside string literals / templates / comments are ignored (found
 * via blankLiterals), so code that *writes about* heredocs isn't mangled. A
 * marker inside a template `${}` interpolation is NOT expanded.
 *
 * Iterative: after each expansion the block IS a string literal, so the next
 * blankLiterals pass skips its content — a heredoc whose content mentions
 * `<<<OTHER` can't trigger a phantom expansion.
 */
export function expandHeredocs(code: string): { code: string; error?: string } {
  for (let n = 0; n < HEREDOC_MAX; n++) {
    const blanked = blankLiterals(code);
    const m = /<<<([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(blanked);
    if (!m) return { code };
    const tag = m[1];
    const openLine = blanked.slice(0, m.index).split('\n').length;
    const contentStart = m.index + m[0].length;
    const rest = code.slice(contentStart);
    const term = new RegExp(
      `^[ \\t]*${tag}(?![A-Za-z0-9_])([^\\r\\n]*)\\r?$`,
      'm',
    );
    const tm = term.exec(rest);
    if (!tm) {
      // Common cause: the body was written on ONE physical line using literal
      // `\n` escapes (so no real line ever contains just the tag). Heredoc
      // bodies are verbatim — they take REAL newlines, not escapes.
      const escapedBody = /\\[nrt]/.test(rest.slice(0, 400));
      const hint = escapedBody
        ? ` — the body looks like it uses literal \\n/\\t escapes on one line; a heredoc body takes REAL newlines (the whole block is verbatim, no escaping), so put ${tag} on its own real line`
        : ` — add a line containing only ${tag}`;
      return {
        code,
        error: `heredoc <<<${tag} opened at line ${openLine} has no terminator${hint}`,
      };
    }
    const trailer = tm[1] ?? ''; // verbatim same-line JavaScript continuation
    const content = rest.slice(0, tm.index); // verbatim, incl. final newline
    const end = contentStart + tm.index + tm[0].length;
    code =
      code.slice(0, m.index) +
      JSON.stringify(content) +
      trailer +
      code.slice(end);
  }
  return { code, error: `too many heredocs in one run (max ${HEREDOC_MAX})` };
}

export function transform(code: string): TransformResult {
  // Heredoc blocks are expanded before parsing — they are not JS syntax.
  const expanded = expandHeredocs(code);
  if (expanded.error) {
    return { code, parsed: false, error: expanded.error };
  }
  code = expanded.code;

  let ast: Program;
  try {
    ast = acornParse(code, {
      ecmaVersion: 'latest',
      allowAwaitOutsideFunction: true,
      sourceType: 'script',
    });
  } catch (e) {
    return {
      code: code,
      parsed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Reserved-name guard: a top-level declaration binding a harness global would
  // silently, permanently replace it (the transform rewrites the decl to a
  // `globalThis.<name> =` assignment). Catch it here, before any rewriting.
  for (const node of ast.body as Statement[]) {
    const clashes = reservedBindingNames(node);
    if (clashes.length > 0) {
      const names = clashes.map((n) => `'${n}'`).join(', ');
      return {
        code,
        parsed: false,
        error: `${names} is a harness global — pick another name. (Reserved: elpis, fs, console, _, and JS/Node builtins like Object, fetch, process)`,
      };
    }
  }

  const s = new MagicString(code);
  // Wrap: prepend async IIFE opener, append return + closer.
  // Use a LOCAL `_completion` so the completion value flows to `return`
  // without polluting globalThis (and without being shadowed by it).
  s.prepend('(async () => {\nlet _completion = undefined;\n');
  s.append('\nreturn _completion;\n})()');

  const body = ast.body;
  const last = body[body.length - 1];

  for (const node of body as Statement[]) {
    if (node === last && node.type === 'ExpressionStatement') {
      // rewrite EXPR → _completion = (EXPR); (assigns the local, returned at end)
      const expr = (node as ExpressionStatement).expression as Expression;
      s.appendLeft(expr.start, '_completion = (');
      s.appendLeft(expr.end, ')');
      continue;
    }
    rewriteTopLevel(node, s);
  }

  return { code: s.toString(), parsed: true };
}
