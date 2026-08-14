// editor.ts — dependency-free string-replace core for self-editing.
//
// The agent edits its own source files by exact substring replacement:
// `oldStr` must occur exactly once in the file unless the caller opts into
// `{ all: true }`. This is Claude-Code-Edit semantics — no anchors, no
// content-hash refs, no block/region addressing. A not-found or ambiguous needle
// THROWS (with orientation: a near-miss window on not-found, line numbers on
// ambiguity) — never a silent no-op and never a corrupting guess.
//
// All bounds are CHARACTER OFFSETS into the original source. Pure and
// synchronous; no filesystem IO. The sandbox `elpis.edit` global wraps
// `replace` with file IO + a diff of what changed.

/** One changed span for a string-replace diff. `from` is the 1-based line
 * number of the span in the ORIGINAL source. */
export interface EditHunk {
  from: number;
  removed: string[];
  inserted: string[];
}

/** Result of {@link replace}: the new source, how many sites changed, and a
 * per-site diff hunk (in original-file order) so the caller can render it. */
export interface EditResult {
  source: string;
  count: number;
  hunks: EditHunk[];
}

/**
 * Replace `oldStr` with `newStr` by EXACT substring match — the single
 * string-replace primitive behind `elpis.edit`. `oldStr` must occur exactly
 * once unless `opts.all` is set. Throws (never silently no-ops) on an empty
 * `oldStr`, `oldStr === newStr`, a not-found needle (the message carries a
 * `nearMiss` window), or a non-unique needle without `opts.all`.
 */
export function replace(
  source: string,
  oldStr: string,
  newStr: string,
  opts: { all?: boolean } = {},
): EditResult {
  if (typeof oldStr !== 'string' || oldStr === '') {
    throw new Error('edit: oldString must be a non-empty string');
  }
  if (typeof newStr !== 'string') {
    throw new Error('edit: newString must be a string');
  }
  if (oldStr === newStr) {
    throw new Error('edit: newString must differ from oldString');
  }
 // Every match offset in the ORIGINAL source (non-overlapping).
  const offsets: number[] = [];
  for (let i = source.indexOf(oldStr); i >= 0; i = source.indexOf(oldStr, i + oldStr.length)) {
    offsets.push(i);
  }
  if (offsets.length === 0) {
    throw new Error(`edit: oldString not found.\n${nearMiss(source, oldStr)}`);
  }
  if (offsets.length > 1 && !opts.all) {
    const lines = offsets.map((o) => lineNumberAt(source, o));
    throw new Error(
      `edit: oldString is not unique — ${offsets.length} occurrences (lines ${formatLineList(lines)}). ` +
      `Include more surrounding text to make it unique, or pass { replaceAll: true }.`,
    );
  }
  const targets = opts.all ? offsets : [offsets[0]];
 // Build the diff hunks against the ORIGINAL source (line numbers stay valid).
  const hunks: EditHunk[] = targets.map((off) => {
    const lineStart = startOfLine(source, off);
    const spanEnd = off + oldStr.length;
    let lineEnd = spanEnd;
    while (lineEnd < source.length && source[lineEnd] !== '\n') lineEnd++;
    const removed = source.slice(lineStart, lineEnd).split('\n');
    const inserted = (source.slice(lineStart, off) + newStr + source.slice(spanEnd, lineEnd)).split('\n');
    return { from: lineNumberAt(source, lineStart), removed, inserted };
  });
 // Apply right-to-left so an earlier splice never shifts a later offset.
  let out = source;
  for (const off of [...targets].sort((a, b) => b - a)) {
    out = out.slice(0, off) + newStr + out.slice(off + oldStr.length);
  }
  return { source: out, count: targets.length, hunks };
}

/**
 * Best-effort orientation for a not-found `replace`: locate the file line most
 * similar to the FIRST line of `oldStr` and render a small `NN:`-numbered
 * window (~2 lines of context each side, capped) around it. The point is
 * orientation ("you probably meant this line"), not precision.
 */
export function nearMiss(source: string, oldStr: string): string {
  const lines = source.split('\n');
  const needleLines = oldStr.split('\n');
  const probe = (needleLines[0] ?? '').trim();
  if (probe === '' || (lines.length === 1 && lines[0] === '')) {
    return '(no near-miss suggestion — the file is empty)';
  }
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const d = levenshtein(lines[i].trim(), probe, bestScore);
    if (d < bestScore) { bestScore = d; best = i; }
  }
  const span = Math.max(1, needleLines.length);
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length - 1, Math.min(best + span - 1 + 2, from + 11));
  const rows = [`closest match near line ${best + 1}:`];
  for (let i = from; i <= to; i++) {
    rows.push(`${String(i + 1).padStart(4)}: ${lines[i]}`);
  }
  return rows.join('\n');
}

/** Levenshtein edit distance with an early-out ceiling: once every cell in a
 * row exceeds `max` the incumbent can't be beaten, so stop. Used only to rank
 * candidate lines for {@link nearMiss}. */
function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return rowMin;
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

/** 1-based line numbers of every occurrence offset, capped for display. */
function formatLineList(lines: number[]): string {
  return lines.slice(0, 8).join(', ') + (lines.length > 8 ? ', …' : '');
}

/** 1-based line number of the line that contains character offset `at`. */
function lineNumberAt(source: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Offset of the first char of the line containing offset `at`. */
function startOfLine(source: string, at: number): number {
  let i = at;
  while (i > 0 && source[i - 1] !== '\n') i--;
  return i;
}
