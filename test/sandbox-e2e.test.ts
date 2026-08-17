// End-to-end sandbox tests: a real vm sandbox over a tmp-dir memory. Covers
// persistence, timeouts, tools (sh/sudo), the node host, injected globals
// (editor/fs/read/ponder/memory.person/git/focus), reserved-name protection,
// console isolation, heredoc round-trips, and elpis.sh.q. Split out of the former
// sandbox.test.ts monolith. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/sandbox/index.js';
import { createBgRegistry } from '../src/sandbox/bg.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
const memoryPath = path.join(tmp, 'memory.md');
fs.writeFileSync(memoryPath, '# Agent Memory\n');

const bgRegistry = createBgRegistry(tmp);

// Named (not inline) so the elpis.inbound-liveness tests below can mutate
// `deps.inbound` after the sandbox is built and observe the change live.
const deps = {
  config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: '/tmp/harness-root', dataDirectory: tmp } },
  memory: {
    read: () => fs.readFileSync(memoryPath, 'utf8'),
    append: (t: string) => fs.appendFileSync(memoryPath, `\n- [t] ${t}\n`),
    overwrite: (t: string) => fs.writeFileSync(memoryPath, t),
  },
  logbuf: [] as string[],
  bg: bgRegistry,
  inbound: null as unknown,
};

const sandbox = createSandbox(deps as Parameters<typeof createSandbox>[0]);

// ---------- parse errors, persistence, timeouts, tools, node host, globals ----------

test('sandbox: parse-error caret aligns under the 0-based acorn column', async () => {
  const r = await sandbox.run('const bad = 1 +* 2');
  assert.equal(r.ok, false);
  const err = r.error ?? '';
  const m = /\((\d+):(\d+)\)/.exec(err);
  assert.ok(m, `error should carry a line:col — got ${err}`);
  const ln = Number(m![1]);
  const col = Number(m![2]);
  const caretLine = err.split('\n').find((l) => l.trim() === '^');
  assert.ok(caretLine, 'a caret line is present in the code frame');
 // Prefix is `${lineNum}: ` = String(ln).length + 2 chars; acorn columns are
 // 0-based, so the caret sits at prefixWidth + col (no -1 off-by-one).
  assert.equal(caretLine!.indexOf('^'), String(ln).length + 2 + col,
    'caret sits at prefix width + 0-based acorn column');
});

test('sandbox: ponder slugifies thread names + close() is collision-safe', async () => {
 // A path-y / traversal-y thread name is slugified — the file stays inside
 // ponder/ and elpis.ponder('design/api') doesn't ENOENT on a missing subdir.
  await sandbox.run(`elpis.ponder('Design / API!', 'first note')`);
  const slug = 'design-api';
  assert.ok(fs.existsSync(path.join(tmp, 'ponder', `${slug}.md`)),
    'thread file is written under the slug, inside ponder/');
 // Traversal can't escape the ponder dir.
  await sandbox.run(`elpis.ponder('../SOUL', 'sneaky')`);
  assert.ok(!fs.existsSync(path.join(tmp, 'SOUL.md')),
    'traversal name cannot write outside ponder/');
 // close twice on the same slug must not clobber resolved/<slug>.md.
  await sandbox.run(`elpis.ponder('dup topic', 'a')`);
  await sandbox.run(`elpis.ponder.close('dup topic', 'done once')`);
  await sandbox.run(`elpis.ponder('dup topic', 'b')`);
  await sandbox.run(`elpis.ponder.close('dup topic', 'done twice')`);
  const resolvedDir = path.join(tmp, 'ponder', 'resolved');
  assert.ok(fs.existsSync(path.join(resolvedDir, 'dup-topic.md')), 'first archive kept');
  assert.ok(fs.existsSync(path.join(resolvedDir, 'dup-topic-2.md')),
    'second archive is suffixed, not clobbering the first');
});

test('e2e: 1 + 1 → 2', async () => {
  const r = await sandbox.run('1 + 1');
  assert.equal(r.ok, true);
  assert.equal(r.preview, '2');
  assert.equal(r.savedAs, '_');
});

test('e2e: const persists', async () => {
  await sandbox.run('const y = 10');
  const r = await sandbox.run('y + 1');
  assert.equal(r.ok, true);
  assert.equal(r.preview, '11');
});

test('e2e: let persists with mutation', async () => {
  await sandbox.run('let z = 1; z++');
  const r = await sandbox.run('z');
  assert.equal(r.preview, '2');
});

test('e2e: var persists', async () => {
  await sandbox.run('var w = 5');
  const r = await sandbox.run('w * 2');
  assert.equal(r.preview, '10');
});

test('e2e: destructuring persists', async () => {
  await sandbox.run('const { a } = { a: 7 }');
  const r = await sandbox.run('a');
  assert.equal(r.preview, '7');
});

test('e2e: function persists', async () => {
  await sandbox.run('function f(){ return 42 }');
  const r = await sandbox.run('f()');
  assert.equal(r.preview, '42');
});

test('e2e: class persists', async () => {
  await sandbox.run('class C {}');
  const r = await sandbox.run('new C()');
  assert.equal(r.ok, true);
 // instance preview — don't assert exact string, just no throw
});

test('e2e: no-init declarator then assign then read', async () => {
  await sandbox.run('let q');
  await sandbox.run('q = 9');
  const r = await sandbox.run('q');
  assert.equal(r.preview, '9');
});

test('e2e: _ reflects previous value', async () => {
  await sandbox.run('123');
  const r = await sandbox.run('_ + 1');
  assert.equal(r.preview, '124');
});

test('e2e: top-level await works', async () => {
  const r = await sandbox.run('await Promise.resolve(42)');
  assert.equal(r.ok, true);
  assert.equal(r.preview, '42');
});

// ---------- timeout tests ----------

test('e2e: sync infinite loop killed, process survives', async () => {
  const r = await sandbox.run('while(true){}');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /timeout|Time|execution/i);
 // process survives — next run still works
  const r2 = await sandbox.run('1 + 1');
  assert.equal(r2.ok, true);
  assert.equal(r2.preview, '2');
});

test('e2e: async hang detaches into a bg future (A5)', async () => {
  const r = await sandbox.run('await new Promise(()=>{})');
  assert.equal(r.ok, true);
  assert.equal(r.detached, true);
  assert.ok(r.bgId, 'should get a bg id');
});

// ---------- tool tests ----------

test('e2e: sh returns object with stdout (async, A5)', async () => {
  const r = await sandbox.run('await elpis.sh("whoami")');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /whoami|stdout|sh\{/);
});

test('e2e: sh nonzero exit does not throw (async, A5)', async () => {
  const r = await sandbox.run('await elpis.sh("nonexistent-cmd-xyz")');
  assert.equal(r.ok, true);
 // the result object should show nonzero/null code
});

test('e2e: sudo runs as root (async, A5)', async () => {
  const r = await sandbox.run('(await elpis.sudo("whoami")).stdout.trim()');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /root/);
});

test('e2e: sh nonexistent cmd has nonzero code (async, A5)', async () => {
  const r = await sandbox.run('await elpis.sh("nonexistent-cmd-xyz")');
  assert.equal(r.ok, true);
  const out = await sandbox.run('(await elpis.sh("nonexistent-cmd-xyz")).code');
  assert.ok(out.preview === 'null' || Number(out.preview) !== 0);
});

test('e2e: sh proxy guard throws on un-awaited .stdout (A5)', async () => {
  const r = await sandbox.run('elpis.sh("whoami").stdout');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /async|await/i);
});

test('e2e: sh final-expression promise auto-resolves (A5)', async () => {
 // A bare elpis.sh as the last expression flattens (async-IIFE return), so the
 // common `elpis.sh("git status")`-as-last-line pattern keeps working unmodified.
  const r = await sandbox.run('elpis.sh("echo flat")');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /flat/);
});

test('e2e: console.log captured', async () => {
  const r = await sandbox.run('console.log("hello", "world"); 1');
  assert.equal(r.ok, true);
  assert.match(r.logs || '', /hello world/);
});
test('e2e: huge array preview capped, _ intact', async () => {
  const r = await sandbox.run('Array.from({length: 100000}, (_, i) => i)');
  assert.equal(r.ok, true);
  assert.ok(Buffer.byteLength(r.preview || '', 'utf8') <= 2048);
 // _ now holds the array; check length without clobbering, then re-create for slice
  const len = await sandbox.run('_?.length');
  assert.equal(len.preview, '100000');
 // re-run to repopulate _ (len clobbered it with the number 100000)
  await sandbox.run('Array.from({length: 100000}, (_, i) => i)');
  const slice = await sandbox.run('_.slice(0,3)');
  assert.match(slice.preview || '', /0.*1.*2/);
});

// ---------- node host tests ----------

test('e2e: require("node:fs") reads a file', async () => {
  const probe = path.join(tmp, 'probe.txt');
  fs.writeFileSync(probe, 'hello-from-fs\n');
  const r = await sandbox.run(`require("node:fs").readFileSync(${JSON.stringify(probe)}, "utf8").trim()`);
  assert.equal(r.ok, true);
  assert.match(r.preview || '', /hello-from-fs/);
});

test('e2e: require("node:fs") writes a file', async () => {
  const out = path.join(tmp, 'out.txt');
  const r = await sandbox.run(`require("node:fs").writeFileSync(${JSON.stringify(out)}, "written"); "ok"`);
  assert.equal(r.ok, true);
  assert.match(r.preview || '', /ok/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'written');
});

test('e2e: process is the real process', async () => {
  const r = await sandbox.run('process.platform');
  assert.equal(r.ok, true);
  assert.match(r.preview || '', new RegExp(process.platform));
});

test('e2e: Buffer global available', async () => {
  const r = await sandbox.run('Buffer.from("hi", "utf8").toString("hex")');
  assert.equal(r.ok, true);
  assert.match(r.preview || '', /6869/);
});

// ---------- new globals (editor, fs, async sh) ----------

test('e2e: fs global reads a file', async () => {
  const r = await sandbox.run(`fs.readFileSync("${memoryPath.replace(/\\/g, '\\\\')}", "utf8")`);
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /Agent Memory/);
});

test('e2e: elpis.editor is gone; elpis.edit and elpis.fill are functions', async () => {
  const r = await sandbox.run('typeof elpis.editor + "/" + typeof elpis.edit + "/" + typeof elpis.fill');
  assert.equal(r.ok, true, String(r.error));
  assert.equal(r.preview, 'string(27 chars): "undefined/function/function"');
});

test('e2e: elpis.edit() replaces a unique substring and returns a diff', async () => {
  const f = path.join(tmp, 'edit-target.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\nfour\n');
  const r = await sandbox.run(`elpis.edit(${JSON.stringify(f)}, "two\\nthree", "TWO\\nTHREE")`);
  assert.equal(r.ok, true, String(r.error));
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\nTWO\nTHREE\nfour\n');
  assert.match(r.preview || '', /@@ -2,2 \+2,2 @@/, 'result must carry the diff header');
  assert.match(r.preview || '', /\+.*TWO/, 'diff must show the inserted lines');
});

test('e2e: elpis.edit() on a non-unique needle throws with a line-numbered count', async () => {
  const f = path.join(tmp, 'edit-dup.txt');
  fs.writeFileSync(f, 'const x = 1;\nconst y = 1;\n');
  const dup = await sandbox.run(`elpis.edit(${JSON.stringify(f)}, "= 1;", "= 2;")`);
  assert.equal(dup.ok, false, 'an ambiguous needle must throw');
  assert.match(String(dup.error), /not unique — 2 occurrences \(lines 1, 2\)/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'const x = 1;\nconst y = 1;\n', 'file untouched on throw');
});

test('e2e: elpis.edit(..., { replaceAll: true }) replaces every occurrence', async () => {
  const f = path.join(tmp, 'edit-all.txt');
  fs.writeFileSync(f, 'a foo b foo\n');
  const r = await sandbox.run(`elpis.edit(${JSON.stringify(f)}, "foo", "bar", { replaceAll: true })`);
  assert.equal(r.ok, true, String(r.error));
  assert.equal(fs.readFileSync(f, 'utf8'), 'a bar b bar\n');
});

test('e2e: elpis.edit() not-found throws with a near-miss window', async () => {
  const f = path.join(tmp, 'edit-miss.txt');
  fs.writeFileSync(f, 'alpha\nconst timeout = 5000;\ngamma\n');
  const r = await sandbox.run(`elpis.edit(${JSON.stringify(f)}, "const timeuot = 5000;", "x")`);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not found/);
  assert.match(String(r.error), /closest match near line 2/);
});

test('e2e: elpis.fill() substitutes {{keys}}; several elpis.edit() calls run in one program', async () => {
  const f = path.join(tmp, 'edit-multi.txt');
  fs.writeFileSync(f, 'const a = 0;\nconst b = 0;\n');
  const code = [
    'const patch = elpis.fill("const a = {{a}};", { a: 1 });',
    `elpis.edit(${JSON.stringify(f)}, "const a = 0;", patch);`,
    `elpis.edit(${JSON.stringify(f)}, "const b = 0;", "const b = 2;");`,
    '"done"',
  ].join('\n');
  const r = await sandbox.run(code);
  assert.equal(r.ok, true, String(r.error));
  assert.equal(fs.readFileSync(f, 'utf8'), 'const a = 1;\nconst b = 2;\n');
});

test('e2e: await elpis.sh() returns same shape (async-first, A5)', async () => {
  const r = await sandbox.run('await elpis.sh("echo hello")');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /hello/);
  const prev = await sandbox.run('_');
  assert.equal(prev.ok, true);
  assert.match(prev.preview || '', /stdout/);
});

test('e2e: marginalia returns a transient causal fragment without writing a side file', async () => {
  const notesDir = path.join(tmp, 'notes');
  const before = fs.existsSync(notesDir) ? new Set(fs.readdirSync(notesDir, { recursive: true })) : new Set();
  const r = await sandbox.run('elpis.marginalia("wait — the first framing ate the hand")');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /MARGINALIA/);
  assert.match(r.preview || '', /first framing ate the hand/);
  const after = fs.existsSync(notesDir) ? new Set(fs.readdirSync(notesDir, { recursive: true })) : new Set();
  assert.deepEqual(after, before);
  const empty = await sandbox.run('elpis.marginalia("   ")');
  assert.equal(empty.ok, false);
  assert.match(String(empty.error), /1\.\.2000 characters/);
});

// ---------- memory tests ----------


test('e2e: remember appends to memory file', async () => {
  fs.writeFileSync(memoryPath, '# Agent Memory\n');
  const r = await sandbox.run('elpis.remember("test note from unit test")');
  assert.equal(r.ok, true);
  const content = fs.readFileSync(memoryPath, 'utf8');
  assert.match(content, /test note from unit test/);
});

test('e2e: memory note survives process restart + appears in system prompt', async () => {
  fs.writeFileSync(memoryPath, '# Agent Memory\n');
  await sandbox.run('elpis.remember("durable fact: prefers dark mode")');
 // simulate a restart: a fresh memory handle reads the same file
  const { createMemory } = await import('../src/store/memory.js');
  const freshMemory = createMemory(memoryPath);
  const contents = freshMemory.read();
  assert.match(contents, /durable fact: prefers dark mode/);
 // and the system prompt built from fresh memory includes it
  const { build } = await import('../src/llm/prompt.js');
  const prompt = build({ soul: '# Soul\n', memory: contents, now: '', harnessRoot: '/tmp', dataDirectory: '/tmp' });
  assert.match(prompt, /durable fact: prefers dark mode/);
});

test('e2e: elpis.memory.search finds matches across MEMORY.md, people/ and ponder/', async () => {
 // Use throwaway names + clean up: the sandbox's tmp data dir is shared with
 // the elpis.memory.person tests, which expect to CREATE people/ files themselves.
  const memFile = path.join(tmp, 'MEMORY.md');
  const personFile = path.join(tmp, 'people', 'falconer.md');
  const ponderFile = path.join(tmp, 'ponder', 'falconry.md');
  fs.writeFileSync(memFile, '# Agent Memory\n- [2026-07-02] the sky code is FALCON\n');
  fs.mkdirSync(path.join(tmp, 'people'), { recursive: true });
  fs.writeFileSync(personFile, '---\nname: Falconer\nids: []\n---\n- likes falcon metaphors\n');
  fs.mkdirSync(path.join(tmp, 'ponder'), { recursive: true });
  fs.writeFileSync(ponderFile, 'why birds?\n- no falcons here, just moths\n');
  try {
    const r = await sandbox.run('elpis.memory.search("falcon")');
    assert.equal(r.ok, true);
    assert.match(r.preview || '', /count: 4/); // MEMORY 1 + person 2 + ponder 1 (case-insensitive)
    assert.match(r.preview || '', /MEMORY\.md/);
    assert.match(r.preview || '', /falconer\.md/);
 // string patterns are case-insensitive and regex-escaped (parens literal)
    const r2 = await sandbox.run('elpis.memory.search("FALCON metaphors (missing)")');
    assert.match(r2.preview || '', /count: 0/);
  } finally {
    fs.rmSync(memFile, { force: true });
    fs.rmSync(personFile, { force: true });
    fs.rmSync(ponderFile, { force: true });
  }
});

test('no-op run: empty/comment-only code returns an explicit empty-program note', async () => {
  for (const code of ['', '   ', '// just a comment', '/* block */\n// line']) {
    const r = await sandbox.run(code);
    assert.equal(r.ok, true);
    assert.match(r.preview || '', /empty program — nothing executed/,
      'an empty program should say so rather than read as progress');
    assert.doesNotMatch(r.preview || '', /no tool call/,
      'the old turn-end guidance is wrong — ending needs end: true');
    assert.equal(r.savedAs, undefined);
  }
});

test('elpis.channel(name): resolves a room name to its id; unknown name throws with known rooms', async () => {
  const sent: { channelId: string; content: string }[] = [];
  const named = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: '/tmp/harness-root', dataDirectory: tmp } },
    memory: {
      read: () => '', append: () => undefined, overwrite: () => undefined,
    },
    logbuf: [],
    send: async (channelId, content) => { sent.push({ channelId, content }); },
    listChannels: () => ['111222333'],
    listChannelsWithNames: () => [{ id: '111222333', name: 'unnamed-agent' }],
    resolveChannel: (ref) => {
      const clean = ref.replace(/^#/, '');
      return clean === 'unnamed-agent' || clean === '111222333' ? '111222333' : null;
    },
  });
  const ok = await named.run('await elpis.channel("unnamed-agent").send("hi via name")');
  assert.equal(ok.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '111222333', 'name resolved to the real id');
  const hash = await named.run('await elpis.channel("#unnamed-agent").send("with hash")');
  assert.equal(hash.ok, true);
  assert.equal(sent[1].channelId, '111222333', 'leading # is accepted');
  const bad = await named.run('elpis.channel("no-such-room")');
  assert.equal(bad.ok, false);
  assert.match(bad.error || '', /unknown channel "no-such-room"/);
  assert.match(bad.error || '', /unnamed-agent/, 'the throw lists known rooms by their qualified name');
 // an all-digits id skips resolution entirely
  const byId = await named.run('await elpis.channel("111222333").send("by id")');
  assert.equal(byId.ok, true);
  assert.equal(sent[2].channelId, '111222333');
 // V1: no-arg elpis.channel throws with the known-channel list.
  const noArg = await named.run('elpis.channel()');
  assert.equal(noArg.ok, false);
  assert.match(noArg.error || '', /a channel ref is required/);
  assert.match(noArg.error || '', /unnamed-agent/, 'the throw lists known rooms by their qualified name');
 // elpis.channel('internal') is refused (provenance label, not a room).
  const internal = await named.run('elpis.channel("internal")');
  assert.equal(internal.ok, false);
  assert.match(internal.error || '', /provenance label/);
});

test('elpis.channel().send: literal escape sequences throw unless allowEscapes', async () => {
  const sent: { channelId: string; content: string }[] = [];
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: '/tmp/hr', dataDirectory: tmp } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
    send: async (channelId, content) => { sent.push({ channelId, content }); },
    listChannels: () => ['111'],
  });
 // A message with a literal backslash-n (what the agent leaked to a human).
  const bad = await sb.run('await elpis.channel("111").send("line one\\\\nline two")');
  assert.equal(bad.ok, false, 'literal \\n should be refused');
  assert.match(bad.error ?? '', /literal escape sequences/);
  assert.equal(sent.length, 0, 'nothing was sent');
 // Real newlines are fine.
  const good = await sb.run('await elpis.channel("111").send("line one\\nline two")');
  assert.equal(good.ok, true, String(good.error));
  assert.equal(sent.length, 1);
 // Override sends the backslashes verbatim.
  const forced = await sb.run('await elpis.channel("111").send("regex: \\\\d+\\\\n", { allowEscapes: true })');
  assert.equal(forced.ok, true, String(forced.error));
  assert.equal(sent.length, 2);
});

test('elpis.sleep(ms) delays async without blocking the event loop', async () => {
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: '/tmp/hr', dataDirectory: tmp } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
    bg: bgRegistry,
  });
  const start = Date.now();
  const r = await sb.run('await elpis.sleep(30); "done"');
  const elapsed = Date.now() - start;
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /"done"/);
  assert.ok(elapsed >= 25, `expected at least 25ms delay, got ${elapsed}ms`);
  assert.ok(elapsed < 300, `expected sub-300ms total, got ${elapsed}ms`);
 // Invalid arguments default to 0 delay rather than throwing.
  const noArg = await sb.run('await elpis.sleep(); "ok"');
  assert.equal(noArg.ok, true, String(noArg.error));
  const neg = await sb.run('await elpis.sleep(-10); "ok"');
  assert.equal(neg.ok, true, String(neg.error));
});

// ---------- A1: parse errors surface with position + TS hint ----------

test('A1: parse error returns pre-parse marker with acorn position', async () => {
  const r = await sandbox.run('const x = ;');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /SyntaxError \(pre-parse\)/);
 // acorn gives a (line:col) position
  assert.match(r.error || '', /\(1:\d+\)/);
});

test('A1: TS cast code returns a TS hint', async () => {
  const r = await sandbox.run('const x = v as any');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /TypeScript syntax/);
  assert.match(r.error || '', /plain JavaScript/i);
});

test('A1: valid code unaffected by the parse-error path', async () => {
  const r = await sandbox.run('1 + 2');
  assert.equal(r.ok, true);
  assert.equal(r.preview, '3');
});

// ---------- A2: _ preserved on undefined completion ----------

test('A2: console.log-final run does not clobber _', async () => {
 // bank a real value into _
  await sandbox.run('[1, 2, 3]');
 // a run ending in console.log returns undefined
  const r = await sandbox.run('console.log("hi")');
  assert.equal(r.ok, true);
  assert.match(r.preview || '', /undefined \(previous _ preserved\)/);
  assert.equal(r.savedAs, undefined);
 // _ still holds the array
  const still = await sandbox.run('_.length');
  assert.equal(still.preview, '3');
});

test('A2: assignment-only run preserves _', async () => {
  await sandbox.run('"banked"');
 // declarations as the last statement → completion is undefined
  const r = await sandbox.run('let q = 5; let p = 10;');
  assert.equal(r.ok, true);
  assert.match(r.preview || '', /undefined \(previous _ preserved\)/);
  const still = await sandbox.run('_');
  assert.match(still.preview || '', /banked/);
});

test('A2: real value still sets _', async () => {
  const r = await sandbox.run('42');
  assert.equal(r.savedAs, '_');
  const v = await sandbox.run('_');
  assert.equal(v.preview, '42');
});

// ---------- A6 (elpis era): the namespace is the protected surface; verb names are free ----------

test('A6: redeclaring elpis errors at parse time', async () => {
  const r = await sandbox.run('const elpis = 5');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /reserved/i);
});

test('A6: redeclaring fs errors (bare survivor)', async () => {
  const r = await sandbox.run('const fs = 5');
  assert.equal(r.ok, false);
});

test('A6: freed verb names persist as plain variables', async () => {
  const r1 = await sandbox.run('const search = 41; search + 1');
  assert.equal(r1.ok, true);
  assert.match(r1.preview ?? '', /42/);
  const r2 = await sandbox.run('search'); // persisted across runs
  assert.match(r2.preview ?? '', /41/);
});

test('A6: plain reassignment does not clobber elpis', async () => {
  await sandbox.run('elpis = 5');
  const r = await sandbox.run('typeof elpis.sh');
  assert.match(r.preview ?? '', /function/);
});

test('A6: elpis members are frozen — assignment does not clobber', async () => {
 // The sandbox script body is NOT strict-mode (no `'use strict'` pragma in
 // the transform's async-IIFE wrapper — see transform.ts), so assigning to a
 // frozen property is a silent no-op rather than a thrown TypeError (the same
 // sloppy-mode behavior the pre-existing "plain reassignment does not clobber
 // a reserved global" invariant already accounts for). The invariant under
 // test is no silent clobber, not an exception.
  await sandbox.run('elpis.sh = 5');
  const r = await sandbox.run('typeof elpis.sh');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview ?? '', /function/);
});

test('A6: elpis.inbound getter stays live', async () => {
  deps.inbound = null;
  const r1 = await sandbox.run('elpis.inbound');
  assert.match(r1.preview ?? '', /null/);
  deps.inbound = { author: 'bramble' } as never;
  const r2 = await sandbox.run('elpis.inbound.author');
  assert.match(r2.preview ?? '', /bramble/);
});

// every expected verb is actually on elpis
test('elpis carries the full verb surface', async () => {
  const expected = ['sh', 'sudo', 'grep', 'read', 'edit', 'fill', 'channel', 'remember', 'ponder',
    'restart', 'deploy', 'focus', 'preview', 'git', 'memory', 'bg', 'inbound', 'search', 'extract',
    'sleep', 'wait', 'timeout', 'schedule', 'unschedule', 'tasks', 'state', 'ext', 'motor'];
  const r = await sandbox.run('Object.keys(elpis).sort().join(",")');
  for (const k of expected) assert.match(r.preview ?? '', new RegExp(`\\b${k}\\b`));
});


// ---------- HARNESS_ROOT / DATA_DIR globals ----------

test('HARNESS_ROOT and DATA_DIR globals available', async () => {
  const r = await sandbox.run('HARNESS_ROOT + " | " + DATA_DIR');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /\/tmp\/harness-root \| /);
});

// ---------- F3c: elpis.focus / NOW.md ----------

test('F3c: elpis.focus() writes NOW.md', async () => {
  const r = await sandbox.run('elpis.focus("currently: testing\\nnext: commit")');
  assert.equal(r.ok, true, String(r.error));
  const nowPath = path.join(tmp, 'NOW.md');
  assert.equal(fs.readFileSync(nowPath, 'utf8'), 'currently: testing\nnext: commit');
});

test('F3c: elpis.focus() overwrites (not appends)', async () => {
  await sandbox.run('elpis.focus("first")');
  await sandbox.run('elpis.focus("second")');
  const nowPath = path.join(tmp, 'NOW.md');
  assert.equal(fs.readFileSync(nowPath, 'utf8'), 'second');
});

// ---------- B4: elpis.read global ----------

test('B4: elpis.read() returns line-numbered file contents', async () => {
  const f = path.join(tmp, 'lines.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree');
  const r = await sandbox.run(`elpis.read(${JSON.stringify(f)})`);
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /lines\.txt \(3 lines/);
  assert.match(r.preview || '', /1: one/);
  assert.match(r.preview || '', /3: three/);
});

test('B4: elpis.read() honors from/to slice', async () => {
  const f = path.join(tmp, 'slice.txt');
  fs.writeFileSync(f, 'a\nb\nc\nd\ne\n');
  const r = await sandbox.run(`elpis.read(${JSON.stringify(f)}, { from: 2, to: 4 })`);
  assert.equal(r.ok, true);
  assert.match(r.preview || '', /showing 2-4/);
  assert.match(r.preview || '', /2: b/);
  assert.match(r.preview || '', /4: d/);
});

test('B4: elpis.read() numbers:false drops line numbers', async () => {
  const f = path.join(tmp, 'nonum.txt');
  fs.writeFileSync(f, 'x\ny\n');
  const r = await sandbox.run(`elpis.read(${JSON.stringify(f)}, { numbers: false })`);
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.preview || '', /^\s*1: x/m);
  assert.match(r.preview || '', /nonum\.txt/);
  assert.match(r.preview || '', /x/);
});

test('B4/2a: elpis.read() self-paginates a large file — the continuation marker survives elpis.preview()\'s downstream head/tail split', async () => {
  const f = path.join(tmp, 'big-elpis.read.txt');
  const lines = Array.from({ length: 500 }, (_, i) => `record ${i + 1}: ${'x'.repeat(40)}`);
  fs.writeFileSync(f, lines.join('\n'));
  const r = await sandbox.run(`elpis.read(${JSON.stringify(f)})`);
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview || '', /continue: read\(/, 'the continuation marker must survive elpis.preview()\'s own truncation');
  assert.match(r.preview || '', /showing lines 1–\d+ of 500/);
});


// ---------- E2: elpis.ponder global ----------

test('E2: elpis.ponder() creates and appends a thread file', async () => {
  const r1 = await sandbox.run('elpis.ponder("e2-thread", "what is the question?")');
  assert.equal(r1.ok, true, String(r1.error));
  const file = path.join(tmp, 'ponder', 'e2-thread.md');
  assert.ok(fs.existsSync(file));
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /what is the question\?/);
 // second call appends a dated bullet
  await sandbox.run('elpis.ponder("e2-thread", "a further thought")');
  const body2 = fs.readFileSync(file, 'utf8');
  assert.match(body2, /a further thought/);
});

test('E2: elpis.ponder.close() archives to resolved/', async () => {
  await sandbox.run('elpis.ponder("e2-close", "open question")');
  const r = await sandbox.run('elpis.ponder.close("e2-close", "it resolved")');
  assert.equal(r.ok, true, String(r.error));
  const orig = path.join(tmp, 'ponder', 'e2-close.md');
  const arch = path.join(tmp, 'ponder', 'resolved', 'e2-close.md');
  assert.ok(!fs.existsSync(orig), 'original moved');
  assert.ok(fs.existsSync(arch), 'archive created');
  assert.match(fs.readFileSync(arch, 'utf8'), /it resolved/);
});

test('E2: elpis.ponder.close() without conclusion still archives', async () => {
  await sandbox.run('elpis.ponder("e2-noconc", "just a thread")');
  await sandbox.run('elpis.ponder.close("e2-noconc")');
  const arch = path.join(tmp, 'ponder', 'resolved', 'e2-noconc.md');
  assert.ok(fs.existsSync(arch));
});

// ---------- E3: elpis.memory.person global ----------

test('E3: elpis.memory.person() creates people/ file with frontmatter stub', async () => {
 // Need an inbound author to pre-fill ids; create a fresh sandbox with elpis.inbound.
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: tmp, dataDirectory: tmp } },
    memory: { read: () => fs.readFileSync(memoryPath, 'utf8'), append: (t) => fs.appendFileSync(memoryPath, t), overwrite: (t) => fs.writeFileSync(memoryPath, t) },
    logbuf: [],
    inbound: { id: 'x', channelId: 'c', channelName: 'c', author: 'Bramble', authorId: '111111111111111101', content: 'hi', createdAt: 't', replyTo: null, forwarded: null, mentions: [], attachments: [] },
  });
  const r = await sb.run('elpis.memory.person("Bramble", "wants my identity based in myself")');
  assert.equal(r.ok, true, String(r.error));
  const file = path.join(tmp, 'people', 'bramble.md');
  assert.ok(fs.existsSync(file));
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /name: Bramble/);
  assert.match(body, /discord:111111111111111101/);
  assert.match(body, /wants my identity based in myself/);
});

test('E3: elpis.memory.person() appends to existing file without duplicating frontmatter', async () => {
  const file = path.join(tmp, 'people', 'bramble.md');
  fs.rmSync(path.join(tmp, 'people'), { recursive: true, force: true });
  await sandbox.run('elpis.memory.person("Bramble", "first note")');
  await sandbox.run('elpis.memory.person("Bramble", "second note")');
  const body = fs.readFileSync(file, 'utf8');
 // frontmatter appears once
  assert.equal((body.match(/^---$/gm) || []).length, 2);
  assert.match(body, /first note/);
  assert.match(body, /second note/);
});

test('elpis.memory.person() for a NON-author slug creates the file WITHOUT the author id', async () => {
 // Bramble is speaking, but the agent records a fact about Rowan. Rowan's new file
 // must NOT inherit Bramble's Discord id (durable identity corruption).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-f29-'));
  const memPath = path.join(dir, 'memory.md');
  fs.writeFileSync(memPath, '# mem\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => fs.readFileSync(memPath, 'utf8'), append: (t) => fs.appendFileSync(memPath, t), overwrite: (t) => fs.writeFileSync(memPath, t) },
    logbuf: [],
    inbound: { id: 'x', channelId: 'c', channelName: 'c', author: 'Bramble', authorId: '111', content: 'hi', createdAt: 't', replyTo: null, forwarded: null, mentions: [], attachments: [] },
  });
  const r = await sb.run('elpis.memory.person("Rowan", "likes long walks")');
  assert.equal(r.ok, true, String(r.error));
  const body = fs.readFileSync(path.join(dir, 'people', 'rowan.md'), 'utf8');
  assert.match(body, /ids: \[\]/, 'non-author file must have empty ids');
  assert.doesNotMatch(body, /discord:111/, 'must not stamp the inbound author id onto a non-author file');
});

test('elpis.memory.person() for the inbound author DOES pre-fill their id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-f29b-'));
  const memPath = path.join(dir, 'memory.md');
  fs.writeFileSync(memPath, '# mem\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => fs.readFileSync(memPath, 'utf8'), append: (t) => fs.appendFileSync(memPath, t), overwrite: (t) => fs.writeFileSync(memPath, t) },
    logbuf: [],
    inbound: { id: 'x', channelId: 'c', channelName: 'c', author: 'Bramble', authorId: '111', content: 'hi', createdAt: 't', replyTo: null, forwarded: null, mentions: [], attachments: [] },
  });
  const r = await sb.run('elpis.memory.person("Bramble", "wants identity in herself")');
  assert.equal(r.ok, true, String(r.error));
  const body = fs.readFileSync(path.join(dir, 'people', 'bramble.md'), 'utf8');
  assert.match(body, /ids: \[discord:111\]/, 'the inbound author own file must pre-fill their id');
});

// ---------- git helpers ----------

test('git: status/diff/add/commit in a temp repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-'));
  const memPath = path.join(dir, 'memory.md');
  fs.writeFileSync(memPath, '# mem\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => fs.readFileSync(memPath, 'utf8'), append: (t) => fs.appendFileSync(memPath, t), overwrite: (t) => fs.writeFileSync(memPath, t) },
    logbuf: [],
  });
  execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', { cwd: dir });

  const st0 = await sb.run('await elpis.git.status()');
  assert.equal(st0.ok, true, String(st0.error));
  assert.match(st0.preview ?? '', /ok: true/);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const add = await sb.run('await elpis.git.add("a.txt")');
  assert.equal(add.ok, true, String(add.error));
  assert.match(add.preview ?? '', /ok: true/);

  const commit = await sb.run('await elpis.git.commit("first")');
  assert.equal(commit.ok, true, String(commit.error));
  assert.match(commit.preview ?? '', /sha:/);

  const diff = await sb.run('await elpis.git.diff()');
  assert.equal(diff.ok, true, String(diff.error));
});

test('git: commit requires a non-empty message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-'));
  const memPath = path.join(dir, 'memory.md');
  fs.writeFileSync(memPath, '# mem\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => fs.readFileSync(memPath, 'utf8'), append: (t) => fs.appendFileSync(memPath, t), overwrite: (t) => fs.writeFileSync(memPath, t) },
    logbuf: [],
  });
  execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', { cwd: dir });
  const r = await sb.run('await elpis.git.commit("")');
  assert.equal(r.ok, false, 'empty commit message should fail');
  assert.match(r.error ?? '', /non-empty string/);
});

test('git: commit with nothing staged THROWS instead of silently no-oping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-'));
  fs.writeFileSync(path.join(dir, 'memory.md'), '# mem\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
  });
  execSync('git init && git config user.name "Test" && git config user.email "test@example.com"', { cwd: dir });
 // Clean tree → commit fails; the run surfaces the throw as ok:false + error.
  const r = await sb.run('await elpis.git.commit("nothing staged")');
  assert.equal(r.ok, false, 'a no-op commit must not look like success');
  assert.match(r.error ?? '', /git\.commit failed/);
});

test('git: commitAndPush stages untracked files by default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-'));
  fs.writeFileSync(path.join(dir, 'memory.md'), '# mem\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
  });
  execSync('git init --bare', { cwd: remote });
  execSync(`git init && git config user.name "Test" && git config user.email "test@example.com" && git remote add origin ${remote} && git commit --allow-empty -m init && git push -u origin HEAD`, { cwd: dir });
 // A brand-new, unstaged file. commitAndPush should add it, commit, and push.
  fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh');
  const r = await sb.run('await elpis.git.commitAndPush("add new.txt")');
  assert.equal(r.ok, true, String(r.error));
  const log = execSync('git log --oneline', { cwd: dir }).toString();
  assert.match(log, /add new\.txt/);
  const tracked = execSync('git ls-files', { cwd: dir }).toString();
  assert.match(tracked, /new\.txt/, 'the untracked file was staged + committed');
});

test('deploy: refuses to build/restart a dirty tree unless allowDirty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-deploy-'));
  fs.writeFileSync(path.join(dir, 'memory.md'), '# mem\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
  });
  execSync('git init && git config user.name "Test" && git config user.email "test@example.com" && git commit --allow-empty -m init', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted'); // makes the tree dirty
  const r = await sb.run('await elpis.deploy("should abort")');
  assert.equal(r.ok, true, String(r.error)); // the run itself succeeds
 // elpis.deploy returned { ok:false } WITHOUT running npm build (no package.json here).
  assert.match(r.preview ?? '', /deploy aborted: uncommitted changes/);
});

test('grep: finds matches in a path, returns raw file:line hits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-grep-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nNEEDLE here\nomega\n');
  const sb = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 4096, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: dir, dataDirectory: dir } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
  });
  const hit = await sb.run(`await elpis.grep("NEEDLE", { path: ${JSON.stringify(dir)} })`);
  assert.equal(hit.ok, true, String(hit.error));
  assert.match(hit.preview ?? '', /a\.txt:2:NEEDLE here/);
  const miss = await sb.run(`await elpis.grep("nothinghere", { path: ${JSON.stringify(dir)} })`);
  assert.match(miss.preview ?? '', /no matches/);
});

// ---------- reserved list ⇔ injected globals ⇔ documented globals ----------

// Every global the prompt (prompt.ts) documents must actually exist in the
// sandbox, or the agent gets a ReferenceError. `inbound` regressed exactly this
// way in the A6 rework. Post-elpis-restructure, the harness-verb tier resolves
// through the `elpis.` namespace; only the bare survivors resolve directly off
// globalThis.
const PROMPT_DOCUMENTED_GLOBALS = [
  'elpis.sh', 'elpis.sudo', 'fs', 'elpis.edit', 'elpis.fill', 'elpis.memory', 'elpis.remember',
  'elpis.read', 'elpis.bg', 'elpis.channel', 'elpis.focus', 'elpis.ponder', 'elpis.restart',
  'elpis.deploy', 'elpis.preview', 'elpis.inbound', 'console', '_',
  'elpis.search', 'elpis.extract', 'elpis.git', 'elpis.grep', 'elpis.motor',
];

test('every prompt-documented global exists in the sandbox', async () => {
  const r = await sandbox.run(`
    (${JSON.stringify(PROMPT_DOCUMENTED_GLOBALS)}).filter(n => {
      let v = globalThis;
      for (const part of n.split('.')) {
        if (v == null || !(part in v)) return true;
        v = v[part];
      }
      return false;
    })
  `);
  assert.equal(r.ok, true, String(r.error));
 // The completion is [] (no missing names); preview renders an empty array.
  assert.match(r.preview ?? '', /Array\(0\)|\[\s*\]/, `missing globals: ${r.preview}`);
});

// ---------- per-run console isolation ----------

test('concurrent runs keep their logs separate (reentrant, no shared buffer)', async () => {
  const [r1, r2] = await Promise.all([
    sandbox.run('console.log("A1"); await new Promise(res => setTimeout(res, 40)); console.log("A2"); 1'),
    sandbox.run('console.log("B1"); await new Promise(res => setTimeout(res, 15)); console.log("B2"); 2'),
  ]);
  assert.equal(r1.logs, 'A1\nA2');
  assert.equal(r2.logs, 'B1\nB2');
});

test('post-detach logs do NOT bleed into the next run; DO arrive with the settle notice', async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-detach-'));
  const settled: Array<{ id: string; value: unknown; rejected: boolean; logs?: string }> = [];
  const detachSandbox = createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 100, previewMaxBytes: 2048, logMaxBytes: 4096 }, kagi: { apiKey: null }, paths: { harnessRoot: tmp2, dataDirectory: tmp2 } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
    bg: createBgRegistry(tmp2),
    onFutureSettled: (id, value, rejected, logs) => { settled.push({ id, value, rejected, logs }); },
  });

  const r = await detachSandbox.run(
    'console.log("pre-detach"); await new Promise(res => setTimeout(res, 250)); console.log("post-detach"); "done"',
  );
  assert.equal(r.detached, true, 'run should detach past the 100ms deadline');
  assert.equal(r.logs, 'pre-detach', 'the detached RunResult carries only the pre-detach logs');
  assert.match(r.preview ?? '', /\[bg <[^>]+>\]/, 'detached preview uses [bg <id>] format');

  while (settled.length === 0) {
    const rq = await detachSandbox.run('console.log("quick"); 1');
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(settled.length, 1, 'one settle notice delivered');
  assert.equal(settled[0].value, 'done');
  assert.equal(settled[0].logs, 'post-detach', 'post-detach logs arrive with the settle notice');
});

test('sh caps accumulated stdout (no unbounded growth)', async () => {
 // Generate ~5KB but cap the buffer at 500 bytes via the test hook.
  const r = await sandbox.run(
    'const out = await elpis.sh("for i in $(seq 1 500); do echo 0123456789; done", { maxBuffer: 500 }); ({ len: out.stdout.length, tail: out.stdout.slice(-40) })',
  );
  assert.equal(r.ok, true, String(r.error));
 // stdout stops growing near the cap (+ the truncation marker), nowhere near 5KB.
  assert.match(r.preview ?? '', /output truncated/);
  const m = /len:\s*(\d+)/.exec(r.preview ?? '');
  assert.ok(m, `expected a len field, got ${r.preview}`);
  assert.ok(Number(m![1]) < 700, `stdout should be capped near 500, got ${m![1]}`);
});


// ---------- heredoc expansion ----------

test('heredoc: expands <<<TAG block into a string literal, content verbatim incl trailing newline', async () => {
  const { expandHeredocs } = await import('../src/sandbox/transform.js');
  const src = 'const x = <<<EOF\nline `one` ${not} "two" \\u \\n\nEOF\nx.length';
  const r = expandHeredocs(src);
  assert.equal(r.error, undefined);
  const expected = JSON.stringify('line `one` ${not} "two" \\u \\n\n');
  assert.ok(r.code.includes(`const x = ${expected}`), `got: ${r.code}`);
  assert.ok(r.code.endsWith('x.length'));
});

test('heredoc: runs end-to-end through the sandbox with zero escaping', async () => {
  const r = await sandbox.run('const hd = <<<BLOCK\nconst t = `tpl ${x}`; execSync("nope \\"q\\"")\nBLOCK\nhd');
  assert.equal(r.ok, true, String(r.error));
 // The content survives byte-for-byte: backticks, ${, backslash-quote.
  const r2 = await sandbox.run('[hd.includes("`tpl ${x}`"), hd.includes(String.fromCharCode(92) + String.fromCharCode(34) + "q"), hd.endsWith(String.fromCharCode(10))]');
  assert.equal(r2.ok, true, String(r2.error));
  assert.match(r2.preview ?? '', /true, true, true/);
});

test('heredoc: missing terminator is a teachable pre-parse error', async () => {
  const r = await sandbox.run('const x = <<<EOF\nno end in sight');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /heredoc <<<EOF opened at line 1 has no terminator/);
});

test('heredoc: a `\\n`-escaped one-line body hints the real-newlines fix', async () => {
  const { expandHeredocs } = await import('../src/sandbox/transform.js');
 // Opener has a real newline, but the whole body is one physical line of
 // literal `\n` escapes, so the terminator never lands on its own line — the
 // exact shape the agent hit. The error should call that out.
  const src = 'const x = <<<TEST\n\\ntest(\\"a\\", () => {})\\nmore\ndangling';
  const r = expandHeredocs(src);
  assert.match(r.error ?? '', /has no terminator/);
  assert.match(r.error ?? '', /literal \\n\/\\t escapes|REAL newlines/);
});

test('heredoc: a marker inside a string literal is NOT expanded', async () => {
  const { expandHeredocs } = await import('../src/sandbox/transform.js');
  const src = 'const doc = "use <<<EOF\\n...\\nEOF to author blocks"; doc';
  const r = expandHeredocs(src);
  assert.equal(r.error, undefined);
  assert.equal(r.code, src, 'source with marker only inside a string must be untouched');
});

test('heredoc: two blocks in one run; content mentioning another marker stays literal', async () => {
  const { expandHeredocs } = await import('../src/sandbox/transform.js');
  const src = 'const a = <<<ONE\nmentions <<<TWO here\nONE\nconst b = <<<TWO\nsecond\nTWO\n[a, b]';
  const r = expandHeredocs(src);
  assert.equal(r.error, undefined);
  assert.ok(r.code.includes(JSON.stringify('mentions <<<TWO here\n')), 'first block verbatim');
  assert.ok(r.code.includes(JSON.stringify('second\n')), 'second block expanded');
});


// ---------- elpis.sh.q: shell quoting ----------

test('elpis.sh.q: quoted value round-trips through a real shell byte-for-byte', async () => {
  const r = await sandbox.run('const tricky = `weird \'val\' "q" $HOME \\u005c backtick`; (await elpis.sh("printf %s " + elpis.sh.q(tricky))).stdout === tricky');
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview ?? '', /true/);
});
// ---------- sleep primitive ----------

test('sleep: delays at least the requested milliseconds and resolves', async () => {
  const r = await sandbox.run(
    'const start = Date.now(); await elpis.sleep(60); const elapsed = Date.now() - start; ({ ok: elapsed >= 40 && elapsed < 300, elapsed })',
  );
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview ?? '', /ok:\s*true/);
});

test('sleep: non-finite values are treated as 0', async () => {
  const r = await sandbox.run(
    'const start = Date.now(); await elpis.sleep(-50); await elpis.sleep(NaN); await elpis.sleep(undefined); const elapsed = Date.now() - start; ({ ok: elapsed < 100, elapsed })',
  );
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview ?? '', /ok:\s*true/);
});

test('sleep: does not block the event loop across concurrent runs', async () => {
  const [r1, r2] = await Promise.all([
    sandbox.run('const start = Date.now(); await elpis.sleep(80); Date.now() - start'),
    sandbox.run('const start = Date.now(); await elpis.sleep(20); Date.now() - start'),
  ]);
  assert.equal(r1.ok, true, String(r1.error));
  assert.equal(r2.ok, true, String(r2.error));
  const t1 = Number((r1.preview ?? '').match(/(\d+)/)?.[1] ?? '0');
  const t2 = Number((r2.preview ?? '').match(/(\d+)/)?.[1] ?? '0');
  assert.ok(t2 < t1, `shorter sleep should finish first (t1=${t1}, t2=${t2})`);
});

// ---------- timeout primitive ----------

test('timeout: resolves with promise value if it settles before timeout', async () => {
  const r = await sandbox.run(
    'await elpis.timeout(new Promise(res => setTimeout(() => res("ok"), 20)), 100)',
  );
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview ?? '', /ok/);
});

test('timeout: rejects when promise takes longer than timeout', async () => {
  const r = await sandbox.run(
    'await elpis.timeout(new Promise(res => setTimeout(res, 200)), 30)',
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /timeout after 30ms/);
});

test('timeout: zero or non-finite ms returns promise unchanged (no timeout)', async () => {
  const r = await sandbox.run(
    'await elpis.timeout(new Promise(res => setTimeout(() => res("done"), 10)), 0)',
  );
  assert.equal(r.ok, true, String(r.error));
  assert.match(r.preview ?? '', /done/);
});

test('timeout: rejects with underlying error if promise rejects before timeout', async () => {
  const r = await sandbox.run(
    'await elpis.timeout(new Promise((_, rej) => setTimeout(() => rej(new Error("boom")), 20)), 100)',
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /boom/);
});
