// Unit tests for Discord chunking + fetchContextWindow.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, attachmentLocalPath } from '../src/discord/discord.js';
import { fetchContextWindow } from '../src/llm/llm.js';
import {
  loadConfigFile,
  defaultConfigPath,
  type Config,
} from '../src/config.js';
import { openDatabase, type Database } from '../src/store/db.js';
import { resolveDataLayout } from '../src/store/data-layout.js';
import * as fs from 'node:fs';

const LIVE_LLM = process.env.TEST_LIVE_LLM === '1';
const NO_NETWORK = !!process.env.TEST_NO_NETWORK;
const NO_CONFIG = !fs.existsSync(defaultConfigPath());
const SKIP_LIVE = !LIVE_LLM || NO_NETWORK || NO_CONFIG;

async function withLiveConfig<T>(
  run: (config: Config, database: Database) => Promise<T>,
): Promise<T> {
  const config = loadConfigFile();
  const database = openDatabase(
    resolveDataLayout(config.paths.dataDirectory).root,
  );
  try {
    return await run(config, database);
  } finally {
    database.close();
  }
}

test('chunkText: short text unchanged', () => {
  assert.deepEqual(chunkText('hello'), ['hello']);
});

test('chunkText: under limit returns single chunk', () => {
  const s = 'a'.repeat(100);
  assert.deepEqual(chunkText(s), [s]);
});

test('chunkText: over 1900 splits into multiple chunks', () => {
  const s = 'a'.repeat(4000);
  const chunks = chunkText(s);
  assert.ok(chunks.length >= 2);
  for (const c of chunks)
    assert.ok(c.length <= 1900, `chunk ${c.length} > 1900`);
  // reassembled (sans trimStart gaps) should cover original
  assert.equal(chunks.join('').length, 4000);
});

test('chunkText: prefers newline breaks', () => {
  const line = 'a'.repeat(1000);
  const s = `${line}\n${line}\n${line}\n${line}`;
  const chunks = chunkText(s);
  // should split at newlines, keeping line content
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].length <= 1900);
});

test('chunkText: custom max param', () => {
  const s = 'a b c d e f g h i j';
  const chunks = chunkText(s, 5);
  for (const c of chunks) assert.ok(c.length <= 5);
});

// ---------- fetchContextWindow (explicit live endpoint probes) ----------

test(
  'fetchContextWindow: resolves configured model context_window',
  { skip: SKIP_LIVE },
  async () => {
    await withLiveConfig(async (config, database) => {
      const cw = await fetchContextWindow(
        {
          ...config,
          llm: { ...config.llm, contextSize: null },
        },
        database,
      );
      assert.ok(Number.isFinite(cw));
      assert.ok(cw > 0);
      assert.ok(cw >= 100000, `unexpectedly small context window: ${cw}`);
    });
  },
);

test(
  'fetchContextWindow: throws clearly for unknown model',
  { skip: SKIP_LIVE },
  async () => {
    await withLiveConfig(async (config, database) => {
      const bad = {
        ...config,
        llm: {
          ...config.llm,
          contextSize: null,
          model: 'nonexistent-model-xyz',
        },
      };
      await assert.rejects(() => fetchContextWindow(bad, database));
    });
  },
);

// ---------- attachment path collision regression ----------
// Discord may send multiple images with the same filename (e.g. image.png)
// in a single message. The local path must disambiguate by index.
test('attachmentLocalPath disambiguates reused filenames by index', () => {
  const p1 = attachmentLocalPath('/tmp/elpis-attach/msg-123', 'image.png', 0);
  const p2 = attachmentLocalPath('/tmp/elpis-attach/msg-123', 'image.png', 1);
  assert.notEqual(p1, p2);
  assert.match(p1, /image-0\.png$/);
  assert.match(p2, /image-1\.png$/);
});
