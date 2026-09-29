import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  importLegacyTranscriptIntoGraph,
  preserveLegacyTranscript,
} from '../src/context/legacy-import.js';
import { ContextGraphStore } from '../src/store/context-graph.js';
import { openDatabase } from '../src/store/db.js';

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-context-legacy-'));
}

test('legacy import preserves exact bytes privately and is idempotent', () => {
  const directory = root();
  const source = path.join(directory, 'main.jsonl');
  const bytes = Buffer.from('{"role":"user","content":"Aster"}\n\u0000tail');
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  const contextRoot = path.join(directory, 'context-graph');
  const first = preserveLegacyTranscript(source, contextRoot);
  const second = preserveLegacyTranscript(source, contextRoot);
  assert.deepEqual(second, first);
  assert.deepEqual(fs.readFileSync(first.artifactPath), bytes);
  assert.equal(fs.statSync(contextRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(first.artifactPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(first.artifactPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(source), bytes);
});

test('legacy graph import seals mixed testimony behind one tool-free yielded branch', () => {
  const directory = root();
  const source = path.join(directory, 'main.jsonl');
  const bytes = Buffer.from(
    '{"role":"user","content":"forbidden-world-canary"}\n\u0000tail',
  );
  fs.writeFileSync(source, bytes, { mode: 0o600 });
  const database = openDatabase(directory);
  try {
    const store = new ContextGraphStore(database);
    const contextRoot = path.join(directory, 'context-graph');
    const first = importLegacyTranscriptIntoGraph({
      sourcePath: source,
      contextRoot,
      store,
      importedAt: 100,
    });
    const repeated = importLegacyTranscriptIntoGraph({
      sourcePath: source,
      contextRoot,
      store,
      importedAt: 200,
    });
    assert.deepEqual(repeated, first);
    assert.deepEqual(fs.readFileSync(first.artifact.artifactPath), bytes);
    const branch = database
      .prepare(
        `SELECT world_id, authority_epoch, status
         FROM context_branches WHERE branch_id = ?`,
      )
      .get(`branch:legacy:${first.artifact.sha256}`) as Record<string, unknown>;
    assert.deepEqual({ ...branch }, {
      world_id: 'world:legacy-unscoped',
      authority_epoch: 0,
      status: 'yielded',
    });
    const capsule = database
      .prepare(
        'SELECT content_json FROM context_capsules WHERE capsule_id = ?',
      )
      .get(first.graph.capsuleId) as { content_json: string };
    assert.equal(capsule.content_json.includes('forbidden-world-canary'), false);
    assert.deepEqual(JSON.parse(capsule.content_json), {
      schemaVersion: 1,
      provenance: 'legacy-mixed-unscoped',
      artifactRef: first.artifact.artifactId,
      sourceHash: first.artifact.sha256,
      sourceSize: bytes.length,
    });
    assert.equal(
      (database.prepare('SELECT count(*) AS count FROM context_effects').get() as {
        count: number;
      }).count,
      0,
    );
    assert.equal(
      (
        database
          .prepare('SELECT count(*) AS count FROM context_legacy_import_receipts')
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    database.close();
  }
});

test('legacy import refuses symlink sources and conflicting artifacts', () => {
  const directory = root();
  const source = path.join(directory, 'main.jsonl');
  fs.writeFileSync(source, 'original');
  const link = path.join(directory, 'linked.jsonl');
  fs.symlinkSync(source, link);
  assert.throws(
    () => preserveLegacyTranscript(link, path.join(directory, 'graph-a')),
    /non-symlink/,
  );
  const receipt = preserveLegacyTranscript(
    source,
    path.join(directory, 'graph-b'),
  );
  fs.writeFileSync(receipt.artifactPath, 'tampered');
  assert.throws(
    () => preserveLegacyTranscript(source, path.join(directory, 'graph-b')),
    /conflicts with its content address/,
  );
});
