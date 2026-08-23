import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryConsolidator,
  MEMORY_CONSOLIDATION_PROMPT,
  effectiveMemoryLimits,
} from '../src/store/memory-consolidator.js';
import { noopLogger } from '../src/lib/log.js';
import type { LLM } from '../src/llm/llm.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

function fixture() {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-consolidator-'),
  );
  const memoryPath = path.join(dataDirectory, 'MEMORY.md');
  const soulPath = path.join(dataDirectory, 'SOUL.md');
  fs.writeFileSync(soulPath, '---\nname: Test\n---\nsmall creature\n');
  fs.mkdirSync(path.join(dataDirectory, 'people'));
  return { dataDirectory, memoryPath, soulPath };
}

function fakeLLM(
  rewrite: (text: string, system: string) => string | Promise<string>,
): LLM {
  return {
    model: 'fake',
    runTool: {} as LLM['runTool'],
    async complete() {
      throw new Error('not used');
    },
    async summarize(text, system = '') {
      return rewrite(text, system);
    },
  };
}

function manager(
  paths: ReturnType<typeof fixture>,
  llm: LLM,
  threshold = 60,
  target = 30,
) {
  return new MemoryConsolidator({
    ...paths,
    thresholdTokens: threshold,
    targetTokens: target,
    maxContextTokens: 1000,
    estimateTokens: (chars) => Math.ceil(chars / 4),
    llm,
    logger: noopLogger,
    debounceMs: 5,
  });
}

test('memory limits clamp to half the usable model window', () => {
  assert.deepEqual(effectiveMemoryLimits(32_000, 24_000, 32_000, 8_000), {
    threshold: 12_000,
    target: 9_000,
  });
  assert.deepEqual(effectiveMemoryLimits(32_000, 24_000, 1_000_000, 8_000), {
    threshold: 32_000,
    target: 24_000,
  });
  assert.deepEqual(effectiveMemoryLimits(0, 24_000, 16_000, 8_000), {
    threshold: 0,
    target: 24_000,
  });
});

test('private consolidation prompt owns the memory, permits grug, and forbids new dates/polish', () => {
  assert.match(
    MEMORY_CONSOLIDATION_PROMPT,
    /your memory, not anyone else's profile/i,
  );
  assert.match(MEMORY_CONSOLIDATION_PROMPT, /private by default/i);
  assert.match(
    MEMORY_CONSOLIDATION_PROMPT,
    /Grug\/fragment language is welcome/,
  );
  assert.match(MEMORY_CONSOLIDATION_PROMPT, /Do not add the current date/);
});

test('oversized memory is atomically consolidated and backed up', async () => {
  const p = fixture();
  const original = '# Memory\n' + 'old repeated fact\n'.repeat(80);
  fs.writeFileSync(p.memoryPath, original);
  let seenSystem = '';
  const m = manager(
    p,
    fakeLLM((_text, system) => {
      seenSystem = system;
      return '# memory\nthing keep. fix known.\n';
    }),
  );
  const result = await m.checkNow(p.memoryPath, true);
  assert.equal(result.status, 'consolidated');
  assert.equal(
    fs.readFileSync(p.memoryPath, 'utf8'),
    '# memory\nthing keep. fix known.\n',
  );
  assert.match(seenSystem, /first-person internal monologue/);
  assert.match(seenSystem, /Small identity anchor/);
  const backupDir = resolveDataLayout(p.dataDirectory).memoryBackups;
  const backups = fs.readdirSync(backupDir);
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(backups.length, 1);
  assert.equal(
    fs.statSync(path.join(backupDir, backups[0])).mode & 0o777,
    0o600,
  );
  assert.equal(
    fs.readFileSync(
      path.join(resolveDataLayout(p.dataDirectory).memoryBackups, backups[0]),
      'utf8',
    ),
    original,
  );
});

test('failure preserves original and safeMemoryView bounds boot injection', async () => {
  const p = fixture();
  const original = '# Memory\n' + 'do not lose me\n'.repeat(200);
  fs.writeFileSync(p.memoryPath, original);
  const m = manager(
    p,
    fakeLLM(() => {
      throw new Error('provider down');
    }),
  );
  const result = await m.checkNow(p.memoryPath, true);
  assert.equal(result.status, 'failed');
  assert.equal(fs.readFileSync(p.memoryPath, 'utf8'), original);
  const view = m.safeMemoryView();
  assert.match(view, /Full durable memory remains at/);
  assert.match(view, /middle omitted/);
  assert.ok(view.length < original.length);
  assert.equal(
    fs.existsSync(resolveDataLayout(p.dataDirectory).memoryBackups),
    false,
  );
});

test('person frontmatter is preserved byte-for-byte while only its body is rewritten', async () => {
  const p = fixture();
  fs.writeFileSync(p.memoryPath, '# small\n');
  const person = path.join(p.dataDirectory, 'people', 'friend.md');
  const frontmatter = '---\nname: friend\nids: [discord:123]\n---\n';
  fs.writeFileSync(person, frontmatter + 'third person duplicate\n'.repeat(80));
  const m = manager(
    p,
    fakeLLM(() => 'I know friend. kind. boundary stays.'),
  );
  const result = await m.checkNow(person, true);
  assert.equal(result.status, 'consolidated');
  assert.equal(
    fs.readFileSync(person, 'utf8'),
    frontmatter + 'I know friend. kind. boundary stays.\n',
  );
});

test('watch requests are debounced and self-write does not loop', async () => {
  const p = fixture();
  fs.writeFileSync(p.memoryPath, '# small\n');
  let calls = 0;
  const m = manager(
    p,
    fakeLLM(() => {
      calls++;
      return '# small now\n';
    }),
  );
  m.startWatching();
  fs.writeFileSync(p.memoryPath, 'large\n'.repeat(100));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await m.flush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await m.flush();
  m.stop();
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(p.memoryPath, 'utf8'), '# small now\n');
});

test('boot scan includes MEMORY.md and people files', async () => {
  const p = fixture();
  fs.writeFileSync(p.memoryPath, 'memory\n'.repeat(100));
  fs.writeFileSync(
    path.join(p.dataDirectory, 'people', 'friend.md'),
    'friend\n'.repeat(100),
  );
  const m = manager(
    p,
    fakeLLM(() => 'I keep this.'),
  );
  const results = await m.ensureBootSafe();
  assert.deepEqual(
    results.map((r) => r.status),
    ['consolidated', 'consolidated'],
  );
});
