import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import {
  ContextGraphStore,
  hashContextBytes,
} from '../src/store/context-graph.js';
import {
  createResidentSourceInspectionRecorder,
  formatResidentSourceInspectionPresentation,
} from '../src/context/resident-source-inspection.js';
import { preview } from '../src/sandbox/preview.js';

function provenance(suffix: string) {
  return {
    version: 1 as const,
    batchId: `resident-tool-batch:00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    batchSha256: hashContextBytes(`batch-${suffix}`),
    callIndex: 0,
    callCount: 1,
    toolName: 'run',
    argumentsSha256: hashContextBytes(`arguments-${suffix}`),
  };
}

function fixture(
  body: string,
  previewMaxBytes = 16_384,
  redactForOutput: (text: string) => string = (text) => text,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-inspect-'));
  const soulPath = path.join(directory, 'SOUL.md');
  fs.writeFileSync(soulPath, `---\nname: Aster\n---\n\n${body}`);
  const database = openDatabase(directory);
  const store = new ContextGraphStore(database);
  const inspect = createResidentSourceInspectionRecorder({
    store,
    soulPath,
    previewMaxBytes,
    redactForOutput,
    now: () => 100,
  });
  return {
    directory,
    database,
    store,
    inspect,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function rowCounts(value: ReturnType<typeof fixture>) {
  return {
    snapshots: Number(
      (
        value.database
          .prepare(
            'SELECT count(*) AS n FROM context_resident_soul_source_snapshots',
          )
          .get() as { n: number }
      ).n,
    ),
    candidates: Number(
      (
        value.database
          .prepare(
            'SELECT count(*) AS n FROM context_resident_source_inspection_candidates',
          )
          .get() as { n: number }
      ).n,
    ),
  };
}

test('resident source inspection presents complete exact review text before commit', () => {
  const value = fixture('# Synthetic soul\nsmall exact body\n');
  try {
    const result = value.inspect(provenance('1'));
    assert.match(result, /^CANDIDATE ONLY — NOT AUTHORIZED/m);
    assert.match(result, /inspection_status: complete/);
    assert.match(result, /# Scoped context branch/);
    assert.match(result, /# Synthetic soul\nsmall exact body/);
    assert.doesNotMatch(result, /SOUL_BODY_OMITTED_BYTES/);
    assert.equal(
      preview(result, 16_384),
      `string(${result.length} chars):\n${result}`,
    );
    assert.deepEqual(rowCounts(value), { snapshots: 1, candidates: 1 });
  } finally {
    value.close();
  }
});

test('resident source inspection presents UTF-8-safe exact ranges when the body is large', () => {
  const body =
    '# Large synthetic soul\n' + '🌿é漢'.repeat(8_000) + '\nlast exact line\n';
  const value = fixture(body, 4_096);
  try {
    const result = value.inspect(provenance('2'));
    assert.match(result, /inspection_status: incomplete/);
    const range = /SOUL_BODY_OMITTED_BYTES \[(\d+),(\d+)\)/.exec(result);
    assert.ok(range);
    const start = Number(range[1]);
    const end = Number(range[2]);
    assert.ok(start >= 0 && end > start);
    assert.ok(end <= Buffer.byteLength(body, 'utf8'));
    const visible =
      /PROMPT_FACING_SOUL_BODY_BEGIN\n([\s\S]*?)\nSOUL_BODY_OMITTED_BYTES \[\d+,\d+\)\n([\s\S]*?)\nPROMPT_FACING_SOUL_BODY_END/.exec(
        result,
      );
    assert.ok(visible);
    const bodyBytes = Buffer.from(body, 'utf8');
    assert.equal(visible[1], bodyBytes.subarray(0, start).toString('utf8'));
    assert.equal(visible[2], bodyBytes.subarray(end).toString('utf8'));
    assert.doesNotMatch(result, /�/);
    assert.equal(
      preview(result, 4_096),
      `string(${result.length} chars):\n${result}`,
    );
    assert.deepEqual(rowCounts(value), { snapshots: 1, candidates: 1 });
  } finally {
    value.close();
  }
});

test('resident source inspection presentation failure rolls back every candidate row', () => {
  const value = fixture('# Synthetic soul\n', 32);
  try {
    assert.throws(
      () => value.inspect(provenance('3')),
      /cannot present exact candidate metadata/,
    );
    assert.deepEqual(rowCounts(value), { snapshots: 0, candidates: 0 });
  } finally {
    value.close();
  }
});

test('secret-redacted presentation rolls back the exact source candidate', () => {
  const secret = 'synthetic-credential-value';
  const value = fixture(
    `# Synthetic soul\ncontains ${secret}\n`,
    16_384,
    (text) => text.replaceAll(secret, '[SECRET REDACTED]'),
  );
  try {
    assert.throws(
      () => value.inspect(provenance('5')),
      /secret redaction would alter it/,
    );
    assert.deepEqual(rowCounts(value), { snapshots: 0, candidates: 0 });
  } finally {
    value.close();
  }
});

test('resident source inspection formatter rejects invalid budgets without a partial view', () => {
  const value = fixture('# Synthetic soul\n');
  try {
    const capture = value.store.createResidentSourceInspectionCandidate({
      soul: {
        parserGeneration: 1,
        sourceFile: '# Synthetic soul\n',
        sourceFileHash: hashContextBytes('# Synthetic soul\n'),
        sourceFileBytes: Buffer.byteLength('# Synthetic soul\n'),
        body: '# Synthetic soul\n',
        bodyHash: hashContextBytes('# Synthetic soul\n'),
        bodyBytes: Buffer.byteLength('# Synthetic soul\n'),
      },
      provenance: provenance('4'),
      observedAt: 100,
    });
    assert.throws(
      () => formatResidentSourceInspectionPresentation(capture, 0),
      /budget is invalid/,
    );
  } finally {
    value.close();
  }
});
