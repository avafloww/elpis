import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeResidentToolBatchSha256,
  createResidentRunAuthority,
  parseRecordedResidentToolBatch,
  type ResidentRunScopeHandle,
  type ResidentRunToken,
} from '../src/kernel/resident-run-provenance.js';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];

function authority() {
  let index = 0;
  return createResidentRunAuthority({ randomId: () => ids[index++] });
}

test('batch identity is fresh and raw argument bytes affect the commitment', () => {
  const value = authority();
  const first = value.issuer.prepare([
    { toolName: 'run', arguments: '{"code":"1"}' },
  ]);
  const second = value.issuer.prepare([
    { toolName: 'run', arguments: '{"code":"1"}' },
  ]);
  assert.notEqual(first.record.batchId, second.record.batchId);
  assert.notEqual(first.record.batchSha256, second.record.batchSha256);

  const compact = createResidentRunAuthority({ randomId: () => ids[0] });
  const spaced = createResidentRunAuthority({ randomId: () => ids[0] });
  const compactRecord = compact.issuer.prepare([
    { toolName: 'run', arguments: '{"code":"1"}' },
  ]).record;
  const spacedRecord = spaced.issuer.prepare([
    { toolName: 'run', arguments: '{ "code": "1" }' },
  ]).record;
  assert.notEqual(compactRecord.batchSha256, spacedRecord.batchSha256);

  const duplicate = createResidentRunAuthority({ randomId: () => ids[0] });
  duplicate.issuer.prepare([{ toolName: 'run', arguments: '{}' }]);
  assert.throws(
    () => duplicate.issuer.prepare([{ toolName: 'run', arguments: '{}' }]),
    /batch id was already used/,
  );

  const sparse = new Array(2) as Array<{
    toolName: string;
    arguments: string;
  }>;
  sparse[0] = { toolName: 'run', arguments: '{}' };
  const sparseAuthority = createResidentRunAuthority({
    randomId: () => ids[0],
  });
  assert.throws(
    () => sparseAuthority.issuer.prepare(sparse),
    /batch is sparse/,
  );
});

test('committed call tokens are single-use and bind ordered call snapshots', () => {
  const value = authority();
  const batch = value.issuer.prepare([
    { toolName: 'think', arguments: '{"thoughts":"x"}' },
    { toolName: 'run', arguments: '{"code":"2"}' },
  ]);
  assert.throws(() => value.issuer.issue(batch.prepared, 1), /not committed/);
  value.issuer.commit(batch.prepared);
  assert.throws(() => value.issuer.commit(batch.prepared), /already committed/);

  const token = value.issuer.issue(batch.prepared, 1);
  assert.throws(() => value.issuer.issue(batch.prepared, 1), /already issued/);
  const handle = value.verifier.accept(token);
  assert.throws(() => value.verifier.accept(token), /already accepted/);
  assert.deepEqual(value.verifier.resolveActive(handle), {
    version: 1,
    batchId: batch.record.batchId,
    batchSha256: batch.record.batchSha256,
    callIndex: 1,
    callCount: 2,
    toolName: 'run',
    argumentsSha256:
      '55f03901c63e59d00d8f66b5cfdf7e00d8d1f19a1e7dc2b65d8c2498e41712e6',
  });
});

test('tokens and handles are authority-local and structural lookalikes fail', () => {
  const first = authority();
  const second = authority();
  const batch = first.issuer.prepare([
    { toolName: 'run', arguments: '{"code":"3"}' },
  ]);
  first.issuer.commit(batch.prepared);
  const token = first.issuer.issue(batch.prepared, 0);
  assert.throws(() => second.verifier.accept(token), /run token is invalid/);
  assert.throws(
    () => first.verifier.accept(Object.freeze({}) as ResidentRunToken),
    /run token is invalid/,
  );
  assert.throws(
    () => first.verifier.lifecycle(Object.freeze({}) as ResidentRunScopeHandle),
    /scope handle is invalid/,
  );
});

test('scope lifecycle rejects detached and closed provenance', () => {
  const value = authority();
  const batch = value.issuer.prepare([
    { toolName: 'run', arguments: '{"code":"4"}' },
  ]);
  value.issuer.commit(batch.prepared);
  const handle = value.verifier.accept(value.issuer.issue(batch.prepared, 0));
  assert.equal(value.verifier.lifecycle(handle), 'active');
  value.verifier.detach(handle);
  assert.equal(value.verifier.lifecycle(handle), 'detached');
  assert.throws(
    () => value.verifier.resolveActive(handle),
    /scope is detached/,
  );
  assert.throws(() => value.verifier.detach(handle), /cannot detach detached/);
  value.verifier.close(handle);
  assert.equal(value.verifier.lifecycle(handle), 'closed');
  assert.throws(() => value.verifier.resolveActive(handle), /scope is closed/);
  value.verifier.close(handle);
});

test('forensic batch parser accepts only exact recomputable metadata', () => {
  const calls = [
    { toolName: 'run', arguments: '{"code":"5"}' },
    { toolName: 'think', arguments: '{"thoughts":"y"}' },
  ];
  const value = authority();
  const batch = value.issuer.prepare(calls);
  assert.deepEqual(
    parseRecordedResidentToolBatch(batch.record, calls),
    batch.record,
  );
  assert.equal(
    parseRecordedResidentToolBatch(
      { ...batch.record, batchSha256: '0'.repeat(64) },
      calls,
    ),
    null,
  );
  assert.equal(
    parseRecordedResidentToolBatch({ ...batch.record, extra: true }, calls),
    null,
  );
  assert.equal(
    parseRecordedResidentToolBatch(batch.record, [...calls].reverse()),
    null,
  );
});

test('canonical batch vector is stable and domain-separated', () => {
  const hash = computeResidentToolBatchSha256(
    'resident-tool-batch:00000000-0000-4000-8000-000000000001',
    [
      {
        callIndex: 0,
        toolName: 'run',
        argumentsSha256:
          '55f03901c63e59d00d8f66b5cfdf7e00d8d1f19a1e7dc2b65d8c2498e41712e6',
      },
    ],
  );
  assert.equal(
    hash,
    '1f35195d1b86f5f96050c33cb48428d97b731f3ff33dffae921048eba26d173a',
  );
});
