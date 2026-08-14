// Unit tests for the sandbox output guard: preview/cap/capLines/headTailParts
// + formatRead pagination. Pure (no sandbox instance). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preview, cap, capLines, headTailParts } from '../src/sandbox/preview.js';
import { formatRead } from '../src/sandbox/read.js';

// ---------- preview unit tests ----------

test('preview: number', () => {
  assert.equal(preview(42, 2048), '42');
});

test('preview: string short', () => {
  assert.equal(preview('hi', 2048), 'string(2 chars): "hi"');
});

test('preview: string long', () => {
  const big = 'x'.repeat(12048);
  const p = preview(big, 2048);
  assert.match(p, /string\(12048 chars\)/);
});

test('preview: array capped', () => {
  const arr = Array.from({ length: 100000 }, (_, i) => i);
  const p = preview(arr, 2048);
  assert.match(p, /Array\(100000\)/);
  assert.match(p, /showing \d+\/100000/);
});

test('preview: plain object', () => {
  const p = preview({ a: 1, b: 2 }, 2048);
  assert.match(p, /Object\{2 keys/);
  assert.match(p, /a: 1/);
});

test('preview: object with multiline string values renders them RAW in a block', () => {
 // The { file1: read(a), file2: read(b) } idiom: both file bodies must show as
 // real text, not JSON-escaped 300-char snippets.
  const file1 = 'line 1a\nline 2a\nline 3a';
  const file2 = 'line 1b\nline 2b\nline 3b';
  const out = preview({ file1, file2 }, 4096);
  assert.match(out, /Object\{2 keys: file1, file2\}/);
  assert.match(out, /file1: string\(\d+ chars\):/);
  assert.ok(out.includes('line 2a'), 'file1 body rendered raw');
  assert.ok(out.includes('line 2b'), 'file2 body rendered raw');
  assert.ok(!out.includes('\\n'), 'no escaped newlines');
});

test('preview: object with a single-line string value keeps the inline form', () => {
 // No multiline value → the normal inline Object{...} renderer, unchanged.
  const out = preview({ ok: true, name: 'bramble' }, 2048);
  assert.match(out, /Object\{2 keys: ok, name\} \{/);
  assert.match(out, /name: "bramble"/);
});

test('preview: array of multiline strings renders each raw', () => {
  const out = preview(['alpha\nbeta', 'gamma\ndelta'], 4096);
  assert.match(out, /Array\(2\):/);
  assert.ok(out.includes('beta') && out.includes('delta'), 'both elements raw');
  assert.ok(!out.includes('\\n'));
});

test('preview: nested strings keep 200 chars before truncation (richer defaults)', () => {
  const long = 'a'.repeat(500);
  const p = preview({ text: long }, 4096);
 // 197 kept + …(+N chars) marker
  assert.ok(p.includes('a'.repeat(197) + '…'), 'nested string should keep ~200 chars');
  assert.match(p, /\(\+303 chars\)/);
});

test('preview: opts.strCap and opts.maxDepth are honored', () => {
  const long = 'b'.repeat(100);
  const shallow = preview({ text: long }, 4096, { strCap: 20 });
  assert.ok(shallow.includes('b'.repeat(17) + '…'), 'strCap should bound nested strings');
  const deep = { a: { b: { c: { d: 1 } } } };
  const capped = preview(deep, 4096, { maxDepth: 2 });
  assert.ok(capped.includes('…'), 'maxDepth should elide deeper levels');
  assert.ok(!capped.includes('d: 1'), 'values beyond maxDepth must not render');
});

test('preview: function', () => {
  const p = preview(function foo(a: number, b: number) {}, 2048);
  assert.match(p, /\[Function: foo\(2 args\)\]/);
});

test('preview: Promise guarded', () => {
  const p = preview(Promise.resolve(1), 2048);
  assert.equal(p, '[Promise]');
});

test('preview: null/undefined/boolean', () => {
  assert.equal(preview(null, 2048), 'null');
  assert.equal(preview(undefined, 2048), 'undefined');
  assert.equal(preview(true, 2048), 'true');
});

test('preview: Buffer never dumps contents', () => {
  const p = preview(Buffer.alloc(1024), 2048);
  assert.match(p, /Buffer\(1024 bytes\)/);
  assert.doesNotMatch(p, /\x00/);
});

test('cap: byte-aware truncate', () => {
  const s = 'x'.repeat(100);
  const c = cap(s, 50);
  assert.ok(c.length <= 50);
  assert.match(c, /more bytes/);
});

// ---------- capLines: line-aware cap for run logs ----------

test('capLines: truncates at the last newline boundary, never mid-line', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `log line ${i + 1} with some padding text`);
  const s = lines.join('\n');
  const out = capLines(s, 400);
  const markerIdx = out.indexOf('\n[showing first');
  assert.ok(markerIdx > -1, 'marker must be present (input exceeds the budget)');
  const keptLines = out.slice(0, markerIdx).split('\n');
  for (const l of keptLines) {
    assert.ok(lines.includes(l), `every kept line must be a COMPLETE original line, got: ${JSON.stringify(l)}`);
  }
  assert.match(out, /\[showing first \d+ of 50 logged lines; \+\d+ more bytes — the values live in your variables, print a narrower slice\]/);
});

test('capLines: N/M/K counts in the marker are accurate', () => {
  const lines = Array.from({ length: 20 }, (_, i) => 'y'.repeat(10) + i);
  const s = lines.join('\n');
  const totalBytes = Buffer.byteLength(s, 'utf8');
  const out = capLines(s, 180);
  const m = /\[showing first (\d+) of (\d+) logged lines; \+(\d+) more bytes/.exec(out);
  assert.ok(m, `expected the capLines marker, got: ${out}`);
  const [, nStr, mStr, kStr] = m;
  assert.equal(Number(mStr), 20, 'M must be the total line count');
  const shown = out.slice(0, out.indexOf('\n[showing first'));
  assert.equal(shown.split('\n').length, Number(nStr), 'N must match the actually-kept line count');
  assert.equal(totalBytes - Buffer.byteLength(shown, 'utf8'), Number(kStr), 'K must be the exact byte remainder');
});

test('capLines: input under budget is returned unchanged', () => {
  const s = 'a\nb\nc';
  assert.equal(capLines(s, 4096), s);
});

test('capLines: a single logged line longer than the budget falls back to the byte cap', () => {
  const s = 'x'.repeat(500);
  const out = capLines(s, 100);
  assert.doesNotMatch(out, /logged lines/, 'no line-boundary marker possible with zero complete lines');
  assert.match(out, /more bytes\]/, 'falls back to cap()\'s own marker');
  assert.equal(out, cap(s, 100), 'must be exactly cap()\'s output, no double marker');
});


// ---------- headTailParts ----------

test('headTailParts: zero tail budget yields empty tail, not the whole string', () => {
  const s = 'abcdefghij';
 // budget * tailFrac floors to 0 → the old s.slice(-0) returned the WHOLE
 // string. The guard must return ''.
  const { tail } = headTailParts(s, 4, 0.75, 0.15);
  assert.equal(tail, '', 'zero tail budget must not leak the whole string');
 // A real (non-zero) tail budget still takes the last N chars.
  const { tail: tail2 } = headTailParts(s, 20, 0.5, 0.5);
  assert.equal(tail2, s.slice(-10));
});

// ---------- B2: budget-proportional string previews ----------

test('B2: long string preview scales with budget', () => {
  const big = 'x'.repeat(5000);
 // small budget
  const p1 = preview(big, 1024);
  assert.match(p1, /string\(5000 chars\)/);
  assert.match(p1, /full value in `_`/);
  assert.doesNotMatch(p1, /slice it for more/, 'the old generic elision suffix must be gone');
 // larger budget should yield more bytes
  const p2 = preview(big, 8192);
  assert.ok(Buffer.byteLength(p2, 'utf8') > Buffer.byteLength(p1, 'utf8'));
});

test('preview: string elision names the exact slice offsets that reproduce the elided middle', () => {
 // A deterministic, non-repeating-in-a-way-that-hides-bugs pattern so a
 // wrong offset would visibly break the round-trip.
  const s = Array.from({ length: 5000 }, (_, i) => String(i % 10)).join('');
  const p = preview(s, 1024);
  const m = /_\.slice\((\d+), (\d+)\) for the rest/.exec(p);
  assert.ok(m, `expected slice offsets in preview output, got: ${p}`);
  const headEnd = Number(m[1]);
  const tailStart = Number(m[2]);
 // The printed offsets must be the ACTUAL boundary the head/tail split used:
 // slicing the original string at exactly these offsets must reproduce the
 // head and tail strings shown in the preview, verbatim.
  assert.ok(p.includes(JSON.stringify(s.slice(0, headEnd))), 'headEnd must match the head string actually shown');
  assert.ok(p.includes(JSON.stringify(s.slice(tailStart))), 'tailStart must match the tail string actually shown');
  assert.ok(headEnd < tailStart, 'a genuinely truncated preview must have a non-empty elided middle');
});

test('B2: short string preview unchanged', () => {
  assert.equal(preview('hi', 2048), 'string(2 chars): "hi"');
});

test('preview: a string that fits the budget is shown once, in full — no elision path', () => {
 // 80 < length ≤ head+tail budget used to take the elision path anyway,
 // printing the string's end twice and an inverted `_.slice(200, 0)` cursor.
  const s = 'a'.repeat(200);
  const p = preview(s, 2048);
  assert.equal(p, `string(200 chars): ${JSON.stringify(s)}`);
  assert.doesNotMatch(p, /middle elided/);
});

test('preview: overlapping head/tail (length under head+tail budget) never emits inverted slice offsets', () => {
 // 1600 chars at a 2048 budget: head(1536) + tail(307) overlap — nothing is
 // actually elided, so the full string must be shown instead of a bogus
 // `_.slice(1536, 1293)`.
  const s = 'b'.repeat(1600);
  const p = preview(s, 2048);
  assert.equal(p, `string(1600 chars): ${JSON.stringify(s)}`);
  const m = /_\.slice\((\d+), (\d+)\)/.exec(p);
  assert.equal(m, null, 'no slice cursor when nothing was elided');
});

// ---------- B3: sh-shaped previews ----------

test('B3: sh result shape renders code/stderr/stdout purposefully', () => {
  const p = preview({ stdout: 'build ok\n145 tests', stderr: 'warning: deprecation', code: 0, signal: null }, 2048);
  assert.match(p, /sh\{ code: 0/);
  assert.match(p, /--- stderr ---/);
  assert.match(p, /--- stdout/);
  assert.match(p, /build ok/);
});

test('B3: sh result stdout tail-biased when over budget', () => {
  const longStdout = 'line\n'.repeat(5000);
  const p = preview({ stdout: longStdout, stderr: '', code: 1, signal: null }, 1024);
  assert.match(p, /code: 1/);
 // tail-biased: the last lines should be present, not the first
  assert.match(p, /line\n/);
});

// ---------- FleetDiff-shaped previews ----------

test('FleetDiff: single worktree renders the stat header + raw committed text (not JSON-escaped)', () => {
  const diff = {
    ok: true,
    session: 'brisk-otter',
    worktrees: [
      {
        name: 'brisk-otter',
        path: '/data/fleet/brisk-otter',
        branch: 'fleet/brisk-otter',
        base: 'abcdef1234567890',
        stat: { files: 2, insertions: 5, deletions: 1 },
        files: [
          { path: 'src/a.ts', status: 'M', insertions: 4, deletions: 1 },
          { path: 'src/b.ts', status: 'A', insertions: 1, deletions: 0 },
        ],
        committed: 'diff --git a/src/a.ts b/src/a.ts\n+line one\n+line two',
        uncommitted: null,
      },
    ],
  };
  const p = preview(diff, 8192);
  assert.match(p, /^fleet diff — brisk-otter/);
  assert.match(p, /== brisk-otter \(\/data\/fleet\/brisk-otter\) vs abcdef123 {2}\[branch fleet\/brisk-otter\]/);
  assert.match(p, /2 files, \+5 −1/);
  assert.match(p, /M src\/a\.ts \(\+4 −1\)/);
  assert.match(p, /A src\/b\.ts \(\+1 −0\)/);
  assert.match(p, /-- committed --/);
 // raw text, not JSON-escaped (no \\n sequences from JSON.stringify)
  assert.ok(p.includes('+line one\n+line two'), 'committed text renders with real newlines');
  assert.ok(!p.includes('\\n'), 'no JSON-escaped newlines');
  assert.match(p, /-- uncommitted --\s*\n\(clean\)/);
});

test('FleetDiff: null committed and uncommitted render as "(none)" / "(clean)"', () => {
  const diff = {
    ok: true,
    session: 'sess',
    worktrees: [{
      name: 'sess', path: '/data/fleet/sess', branch: null, base: 'HEAD',
      stat: { files: 0, insertions: 0, deletions: 0 }, files: [],
      committed: null, uncommitted: null,
    }],
  };
  const p = preview(diff, 4096);
  assert.match(p, /-- committed --\s*\n\(none\)/);
  assert.match(p, /-- uncommitted --\s*\n\(clean\)/);
});

test('FleetDiff: two worktrees render stat blocks only + a drill-in hint', () => {
  const mkWt = (name: string) => ({
    name, path: `/data/fleet/${name}`, branch: `fleet/${name}`, base: 'HEAD',
    stat: { files: 1, insertions: 2, deletions: 0 },
    files: [{ path: 'x.ts', status: 'M' as const, insertions: 2, deletions: 0 }],
    committed: 'some committed diff text',
    uncommitted: 'some uncommitted diff text',
  });
  const diff = { ok: true, session: 'multi', worktrees: [mkWt('one'), mkWt('two')] };
  const p = preview(diff, 8192);
  assert.match(p, /== one \(\/data\/fleet\/one\)/);
  assert.match(p, /== two \(\/data\/fleet\/two\)/);
  assert.match(p, /1 files, \+2 −0/);
 // stat-blocks only: no committed/uncommitted bodies
  assert.ok(!p.includes('some committed diff text'));
  assert.ok(!p.includes('some uncommitted diff text'));
  assert.ok(!p.includes('-- committed --'));
  assert.match(p, /drill in: elpis\.fleet\.diff\(ref, \{ worktree: '<name>' \}\)/);
});

test('FleetDiff: file list caps at 20 with "… N more"', () => {
  const files = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.ts`, status: 'M' as const, insertions: 1, deletions: 0 }));
  const diff = {
    ok: true,
    session: 'sess',
    worktrees: [{
      name: 'sess', path: '/data/fleet/sess', branch: null, base: 'HEAD',
      stat: { files: 25, insertions: 25, deletions: 0 }, files,
      committed: null, uncommitted: null,
    }],
  };
  const p = preview(diff, 8192);
  assert.match(p, /f0\.ts/);
  assert.match(p, /f19\.ts/);
  assert.ok(!p.includes('f20.ts'), 'files past the cap of 20 are not listed individually');
  assert.match(p, /… 5 more/);
});

test('FleetDiff: session note is included in the header when present', () => {
  const diff = { ok: true, session: 'sess', note: 'stranded work', worktrees: [] };
  const p = preview(diff, 4096);
  assert.match(p, /^fleet diff — sess — stranded work/);
});


// ---------- 2a: formatRead unit tests (direct, no sandbox) ----------

test('formatRead: a render that fits under budget is byte-identical to the un-paginated form', () => {
  const out = formatRead('lines.txt', 'one\ntwo\nthree', {}, 4096);
  assert.equal(out,
    `lines.txt (3 lines, showing 1-3)\n   1: one\n   2: two\n   3: three`);
  assert.ok(!out.includes('continue: read('), 'no continuation marker when the full render already fits');
});

test('formatRead: line prefixes are plain NN: line numbers (no content hash)', () => {
  const out = formatRead('f.txt', 'alpha\nbeta', {}, 4096);
  assert.match(out, /^\s*1: alpha$/m, `line 1 must be a plain "NN: " prefix, got: ${out}`);
  assert.doesNotMatch(out, /^\s*1:[0-9a-f]{2}:/m, 'no 2-hex hash after the line number');
});

test('formatRead: clamps at the last complete line and appends a continuation marker', () => {
  const nLines = 100;
  const content = Array.from({ length: nLines }, (_, i) => `line ${i + 1} of ${nLines} with some padding text here`).join('\n');
  const out = formatRead('big.txt', content, {}, 500);
  const m = /showing lines 1–(\d+) of 100 — continue: read\('big\.txt', \{from: (\d+)\}\)/.exec(out);
  assert.ok(m, `expected a clamped continuation marker, got tail: ${out.slice(-200)}`);
  const shownTo = Number(m[1]);
  const contFrom = Number(m[2]);
  assert.ok(shownTo < nLines, 'must have actually clamped (not shown the whole file)');
  assert.equal(contFrom, shownTo + 1, 'continuation from must be exactly shownTo + 1');
 // The last shown line must be COMPLETE, not cut mid-line.
  const lastLineRe = new RegExp(`^\\s*${shownTo}: line ${shownTo} of ${nLines} with some padding text here$`, 'm');
  assert.match(out, lastLineRe, 'the last shown line must render in full');
 // No content from the next (unshown) line should leak in before the marker.
  assert.ok(!out.includes(`line ${shownTo + 1} of`), 'must not include any part of the first unshown line');
});

test('formatRead: a {from,to} range that overflows clamps within the range — marker points at the first unshown line of the REQUESTED range', () => {
  const nLines = 300;
  const content = Array.from({ length: nLines }, (_, i) => `row-${i + 1}-payload-text-here`).join('\n');
  const out = formatRead('rows.txt', content, { from: 101, to: 250 }, 400);
  const m = /showing lines 101–(\d+) of 300 — continue: read\('rows\.txt', \{from: (\d+)\}\)/.exec(out);
  assert.ok(m, `expected a clamped marker within the requested range, got tail: ${out.slice(-200)}`);
  const shownTo = Number(m[1]);
  assert.ok(shownTo >= 101 && shownTo < 250, 'clamp must land inside the requested range, before its end');
  assert.equal(Number(m[2]), shownTo + 1);
});

test('formatRead: raw-byte accounting — backslash-heavy content no longer pays a JSON-escape tax (raw render), so LF and escape-heavy lines clamp alike', () => {
 // Since preview renders multiline strings RAW, formatRead budgets in raw
 // UTF-8 bytes. A line full of backslashes/quotes (which would double once
 // JSON-escaped) now costs the same as a plain line of equal length.
  const nLines = 200;
  const makeContent = (line: string) =>
    Array.from({ length: nLines }, () => line).join('\n');
  const budget = 800;
 // Both lines are exactly 20 raw chars; the second would be 25+ once
 // JSON-escaped (backslashes and quotes double).
  const plain = formatRead('f.txt', makeContent('line payload text aa'), {}, budget);
  const escapey = formatRead('f.txt', makeContent('line \\"payload\\" \\\\a'), {}, budget);
  const shownCount = (s: string): number => {
    const m = /showing lines \d+–(\d+) of/.exec(s);
    if (!m) throw new Error(`no clamp marker found in: ${s}`);
    return Number(m[1]);
  };
 // Same raw line length → same clamp point, regardless of escape density.
  assert.equal(shownCount(escapey), shownCount(plain),
    'escape-heavy content must clamp at the same line as plain content of equal raw length');
});


// ---------- preview: raw multiline strings + Buffer hex ----------

test('preview: multiline string renders RAW — real newlines, no JSON escaping', () => {
  const s = 'line "one"\nline \\two\nline three';
  const out = preview(s, 4096);
  assert.equal(out, `string(${s.length} chars):\n${s}`);
});

test('preview: single-line string keeps JSON.stringify (boundary-exact)', () => {
  const out = preview('hi there ', 4096);
  assert.equal(out, 'string(9 chars): "hi there "');
});

test('preview: long multiline string elides the middle with a raw cursor, head/tail unescaped', () => {
  const line = 'payload line with some text\n';
  const s = line.repeat(200);
  const out = preview(s, 512);
  assert.match(out, /\[middle elided — _\.slice\(\d+, \d+\) for the rest; full value in `_`\]/);
  assert.ok(out.includes('payload line with some text\n'), 'head must contain raw unescaped lines');
  assert.ok(!out.includes('\\n'), 'no escaped newlines anywhere');
});

test('preview: Buffer contents render as a bounded hex head (no more "contents not dumped")', () => {
  const out = preview(Buffer.from('user \\"Test\\"', 'utf8'), 4096);
  assert.match(out, /^Buffer\(13 bytes\) hex: 75 73 65 72 20 5c 22/);
  const big = preview(Buffer.alloc(300, 0xab), 4096);
  assert.match(big, /Buffer\(300 bytes\) hex: (ab ){63}ab … \(\+236 more/);
});