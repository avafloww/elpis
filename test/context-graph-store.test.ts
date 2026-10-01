import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createViewManifest } from '../src/context-graph.js';
import { SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1 } from '../src/context/scoped-system.js';
import { buildPromptProjection } from '../src/llm/prompt.js';
import {
  assembleDarkLocalBranch,
  assembleNextDarkPendingBranch,
} from '../src/context/root.js';
import { MAX_LOCAL_BRANCH_REQUEST_CANDIDATE_BYTES } from '../src/context/candidate.js';
import {
  materializeLocalBranchRequest,
  materializeProfileBoundLocalBranchRequest,
  materializeSystemProjection,
  materializeWorldConversation,
} from '../src/context/view.js';
import { openDatabase, runMigrations } from '../src/store/db.js';
import { readPromptFacingSoulSnapshot } from '../src/store/soul.js';
import {
  ContextGraphStore,
  LegacyImportConflictError,
  StaleContinuationHeadError,
  branchId,
  capsuleId,
  effectId,
  eventId,
  eventMessageProjectionId,
  hashContextBytes,
  legacyImportReceiptId,
  manifestId,
  shareGrantId,
  shadowProjectionPlanId,
  shadowRequestObservationId,
  systemLayerApprovalId,
  systemLayerProjectionId,
  worldId,
} from '../src/store/context-graph.js';

function fixture(): {
  directory: string;
  database: DatabaseSync;
  store: ContextGraphStore;
} {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-context-graph-'),
  );
  const database = openDatabase(directory);
  return { directory, database, store: new ContextGraphStore(database) };
}

function closeFixture(value: {
  directory: string;
  database: DatabaseSync;
}): void {
  value.database.close();
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function residentSoulSnapshot(directory: string, body = '# Synthetic soul\n') {
  const soulPath = path.join(directory, 'synthetic-SOUL.md');
  const sourceFile = `---\nname: Aster\n---\n\n${body}`;
  fs.writeFileSync(soulPath, sourceFile);
  return readPromptFacingSoulSnapshot(soulPath);
}

function residentRunProvenance(suffix: string, callIndex = 0, callCount = 1) {
  return {
    version: 1 as const,
    batchId: `resident-tool-batch:00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    batchSha256: hashContextBytes(`batch-${suffix}`),
    callIndex,
    callCount,
    toolName: 'run',
    argumentsSha256: hashContextBytes(`arguments-${suffix}-${callIndex}`),
  };
}

test('resident source inspection candidates preserve exact private sources and exact run provenance', () => {
  const value = fixture();
  try {
    const soul = residentSoulSnapshot(value.directory);
    assert.throws(
      () =>
        value.store.createResidentSourceInspectionCandidate({
          soul: { ...soul, parserGeneration: 2 },
          provenance: residentRunProvenance('9'),
          observedAt: 50,
        }),
      /parserGeneration is unsupported/,
    );
    const first = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('1'),
      observedAt: 100,
    });
    assert.equal(first.soul.sourceFile, soul.sourceFile);
    assert.equal(first.soul.body, soul.body);
    assert.match(
      first.soul.snapshotId,
      /^resident-soul-snapshot:[0-9a-f]{64}$/,
    );
    assert.match(
      first.candidate.candidateId,
      /^resident-source-candidate:[0-9a-f]{64}$/,
    );
    assert.equal(
      first.candidate.inspectBatchId,
      residentRunProvenance('1').batchId,
    );
    assert.equal(first.candidate.inspectToolName, 'run');
    assert.equal(first.candidate.observedAt, 100);

    const retry = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('1'),
      observedAt: 150,
    });
    assert.deepEqual(retry, first);

    const second = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('2'),
      observedAt: 200,
    });
    assert.equal(second.soul.snapshotId, first.soul.snapshotId);
    assert.notEqual(second.candidate.candidateId, first.candidate.candidateId);
    assert.deepEqual(
      value.store.getResidentSourceInspectionCandidate(
        first.candidate.candidateId,
      ),
      first,
    );

    const counts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_soul_source_snapshots) AS snapshots,
           (SELECT count(*) FROM context_resident_source_inspection_candidates) AS candidates,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals,
           (SELECT count(*) FROM context_system_profiles) AS profiles,
           (SELECT count(*) FROM context_branches) AS branches,
           (SELECT count(*) FROM context_effects) AS effects`,
      )
      .get() as Record<string, number>;
    assert.deepEqual(
      { ...counts },
      {
        snapshots: 1,
        candidates: 2,
        approvals: 0,
        profiles: 0,
        branches: 0,
        effects: 0,
      },
    );

    value.store.activate(0, 250);
    assert.throws(
      () =>
        value.store.createResidentSourceInspectionCandidate({
          soul,
          provenance: residentRunProvenance('3'),
          observedAt: 300,
        }),
      /requires dark graph mode/,
    );
    assert.ok(
      value.store.getResidentSourceInspectionCandidate(
        first.candidate.candidateId,
      ),
    );
  } finally {
    closeFixture(value);
  }
});

test('one resident run ordinal cannot capture changed SOUL sources', () => {
  const value = fixture();
  try {
    const provenance = residentRunProvenance('4');
    value.store.createResidentSourceInspectionCandidate({
      soul: residentSoulSnapshot(value.directory, '# First synthetic soul\n'),
      provenance,
      observedAt: 100,
    });
    assert.throws(
      () =>
        value.store.createResidentSourceInspectionCandidate({
          soul: residentSoulSnapshot(
            value.directory,
            '# Changed synthetic soul\n',
          ),
          provenance,
          observedAt: 200,
        }),
      /already captured different sources/,
    );
    const counts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_soul_source_snapshots) AS snapshots,
           (SELECT count(*) FROM context_resident_source_inspection_candidates) AS candidates`,
      )
      .get();
    assert.deepEqual({ ...counts }, { snapshots: 1, candidates: 1 });
  } finally {
    closeFixture(value);
  }
});

test('resident source candidate writes roll back late failures and stored records fail closed', () => {
  const value = fixture();
  try {
    value.database.exec(`
      CREATE TRIGGER test_resident_candidate_late_failure
        BEFORE INSERT ON context_resident_source_inspection_candidates
        BEGIN
          SELECT RAISE(ABORT, 'forced resident candidate failure');
        END;
    `);
    assert.throws(
      () =>
        value.store.createResidentSourceInspectionCandidate({
          soul: residentSoulSnapshot(value.directory),
          provenance: residentRunProvenance('5'),
          observedAt: 100,
        }),
      /forced resident candidate failure/,
    );
    const empty = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_soul_source_snapshots) AS snapshots,
           (SELECT count(*) FROM context_resident_source_inspection_candidates) AS candidates`,
      )
      .get();
    assert.deepEqual({ ...empty }, { snapshots: 0, candidates: 0 });

    value.database.exec('DROP TRIGGER test_resident_candidate_late_failure');
    assert.throws(
      () =>
        value.store.createResidentSourceInspectionCandidate(
          {
            soul: residentSoulSnapshot(value.directory),
            provenance: residentRunProvenance('7'),
            observedAt: 100,
          },
          () => {
            throw new Error('forced resident presentation failure');
          },
        ),
      /forced resident presentation failure/,
    );
    const afterPresentationFailure = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_soul_source_snapshots) AS snapshots,
           (SELECT count(*) FROM context_resident_source_inspection_candidates) AS candidates`,
      )
      .get();
    assert.deepEqual(
      { ...afterPresentationFailure },
      { snapshots: 0, candidates: 0 },
    );

    const created = value.store.createResidentSourceInspectionCandidate({
      soul: residentSoulSnapshot(value.directory),
      provenance: residentRunProvenance('5'),
      observedAt: 100,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_resident_source_inspection_candidates
             SET observed_at = observed_at + 1 WHERE candidate_id = ?`,
          )
          .run(created.candidate.candidateId),
      /resident source inspection candidates are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT OR REPLACE INTO context_resident_source_inspection_candidates
             SELECT * FROM context_resident_source_inspection_candidates
             WHERE candidate_id = ?`,
          )
          .run(created.candidate.candidateId),
      /resident source inspection candidate identity conflict/,
    );
    const substituted = residentRunProvenance('6');
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_resident_source_inspection_candidates(
               candidate_id, schema_version, scope_kind, execution_context,
               activation_epoch, contract_artifact_id,
               contract_migration_checksum, contract_content_hash,
               contract_content_bytes, soul_snapshot_id, inspect_batch_id,
               inspect_batch_sha256, inspect_call_index, inspect_call_count,
               inspect_tool_name, inspect_arguments_sha256, observed_at
             )
             SELECT ?, schema_version, scope_kind, execution_context,
               activation_epoch + 1, contract_artifact_id,
               contract_migration_checksum, contract_content_hash,
               contract_content_bytes, soul_snapshot_id, ?, ?, 0, 1,
               'run', ?, observed_at
             FROM context_resident_source_inspection_candidates
             WHERE candidate_id = ?`,
          )
          .run(
            `resident-source-candidate:${'f'.repeat(64)}`,
            substituted.batchId,
            substituted.batchSha256,
            substituted.argumentsSha256,
            created.candidate.candidateId,
          ),
      /resident source inspection candidate lineage is invalid/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `DELETE FROM context_resident_soul_source_snapshots
             WHERE snapshot_id = ?`,
          )
          .run(created.soul.snapshotId),
      /resident SOUL source snapshots are immutable/,
    );

    value.database.exec(
      'DROP TRIGGER context_resident_soul_source_snapshots_no_update',
    );
    value.database
      .prepare(
        `UPDATE context_resident_soul_source_snapshots
         SET source_file_blob = zeroblob(source_file_bytes)
         WHERE snapshot_id = ?`,
      )
      .run(created.soul.snapshotId);
    assert.throws(
      () =>
        value.store.getResidentSourceInspectionCandidate(
          created.candidate.candidateId,
        ),
      /source snapshot is inconsistent/,
    );
  } finally {
    closeFixture(value);
  }
});

test('resident source authorizations are exact, separate-batch, immutable receipts', () => {
  const value = fixture();
  try {
    const soul = residentSoulSnapshot(value.directory);
    const first = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('101'),
      observedAt: 100,
    });
    const second = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('102'),
      observedAt: 110,
    });
    assert.throws(
      () =>
        value.store.authorizeResidentSourceCandidate({
          candidateId: first.candidate.candidateId,
          freshSoul: soul,
          provenance: residentRunProvenance('101'),
          authorizedAt: 200,
        }),
      /different assistant batch/,
    );
    assert.throws(
      () =>
        value.store.authorizeResidentSourceCandidate(
          {
            candidateId: first.candidate.candidateId,
            freshSoul: soul,
            provenance: residentRunProvenance('103'),
            authorizedAt: 200,
          },
          () => {
            throw new Error('forced authorization presentation failure');
          },
        ),
      /forced authorization presentation failure/,
    );
    assert.equal(
      (
        value.database
          .prepare(
            'SELECT count(*) AS n FROM context_resident_source_candidate_authorizations',
          )
          .get() as { n: number }
      ).n,
      0,
    );

    const authorization = value.store.authorizeResidentSourceCandidate({
      candidateId: first.candidate.candidateId,
      freshSoul: soul,
      provenance: residentRunProvenance('103'),
      authorizedAt: 200,
    });
    assert.match(
      authorization.authorizationId,
      /^resident-source-authorization:[0-9a-f]{64}$/,
    );
    assert.equal(authorization.candidateId, first.candidate.candidateId);
    assert.equal(authorization.authorizeBatchId, residentRunProvenance('103').batchId);
    assert.deepEqual(
      value.store.authorizeResidentSourceCandidate({
        candidateId: first.candidate.candidateId,
        freshSoul: soul,
        provenance: residentRunProvenance('103'),
        authorizedAt: 250,
      }),
      authorization,
    );
    assert.throws(
      () =>
        value.store.authorizeResidentSourceCandidate({
          candidateId: first.candidate.candidateId,
          freshSoul: soul,
          provenance: residentRunProvenance('104'),
          authorizedAt: 250,
        }),
      /already authorized by a different call/,
    );
    assert.throws(
      () =>
        value.store.authorizeResidentSourceCandidate({
          candidateId: second.candidate.candidateId,
          freshSoul: soul,
          provenance: residentRunProvenance('103'),
          authorizedAt: 250,
        }),
      /already authorized different sources/,
    );
    const changed = residentSoulSnapshot(
      value.directory,
      '# Changed synthetic soul\n',
    );
    assert.throws(
      () =>
        value.store.authorizeResidentSourceCandidate({
          candidateId: second.candidate.candidateId,
          freshSoul: changed,
          provenance: residentRunProvenance('105'),
          authorizedAt: 250,
        }),
      /current exact inspected SOUL source/,
    );

    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_resident_source_candidate_authorizations
             SET authorized_at = authorized_at + 1 WHERE authorization_id = ?`,
          )
          .run(authorization.authorizationId),
      /resident source candidate authorizations are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT OR REPLACE INTO context_resident_source_candidate_authorizations
             SELECT * FROM context_resident_source_candidate_authorizations
             WHERE authorization_id = ?`,
          )
          .run(authorization.authorizationId),
      /resident source candidate authorization identity conflict/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `DELETE FROM context_resident_source_candidate_authorizations
             WHERE authorization_id = ?`,
          )
          .run(authorization.authorizationId),
      /resident source candidate authorizations are immutable/,
    );

    value.store.activate(0, 300);
    assert.deepEqual(
      value.store.getResidentSourceCandidateAuthorization(
        authorization.authorizationId,
      ),
      authorization,
    );
    assert.throws(
      () =>
        value.store.authorizeResidentSourceCandidate({
          candidateId: second.candidate.candidateId,
          freshSoul: soul,
          provenance: residentRunProvenance('106'),
          authorizedAt: 350,
        }),
      /requires dark graph mode/,
    );
  } finally {
    closeFixture(value);
  }
});

test('authorized resident identity layers derive atomically without creating runtime authority', () => {
  const value = fixture();
  try {
    const soul = residentSoulSnapshot(value.directory);
    const inspected = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('201'),
      observedAt: 100,
    });
    const authorization = value.store.authorizeResidentSourceCandidate({
      candidateId: inspected.candidate.candidateId,
      freshSoul: soul,
      provenance: residentRunProvenance('202'),
      authorizedAt: 200,
    });

    assert.throws(
      () =>
        value.store.deriveResidentIdentitySystemLayers({
          authorizationId: authorization.authorizationId,
          freshSoul: soul,
          provenance: residentRunProvenance('202'),
          derivedAt: 300,
        }),
      /later distinct assistant batch/,
    );
    assert.throws(
      () =>
        value.store.deriveResidentIdentitySystemLayers({
          authorizationId: authorization.authorizationId,
          freshSoul: residentSoulSnapshot(
            value.directory,
            '# Changed synthetic soul\n',
          ),
          provenance: residentRunProvenance('203'),
          derivedAt: 300,
        }),
      /current exact authorized SOUL source/,
    );
    assert.throws(
      () =>
        value.store.deriveResidentIdentitySystemLayers(
          {
            authorizationId: authorization.authorizationId,
            freshSoul: soul,
            provenance: residentRunProvenance('203'),
            derivedAt: 300,
          },
          () => {
            throw new Error('forced derivation presentation failure');
          },
        ),
      /forced derivation presentation failure/,
    );
    const afterRollback = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_identity_system_derivations) AS derivations,
           (SELECT count(*) FROM context_system_layer_projections) AS layers,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals`,
      )
      .get();
    assert.deepEqual(
      { ...afterRollback },
      { derivations: 0, layers: 0, approvals: 0 },
    );

    const receipt = value.store.deriveResidentIdentitySystemLayers({
      authorizationId: authorization.authorizationId,
      freshSoul: soul,
      provenance: residentRunProvenance('203'),
      derivedAt: 300,
    });
    assert.match(
      receipt.derivationId,
      /^resident-identity-derivation:[0-9a-f]{64}$/,
    );
    assert.equal(receipt.authorityRevision, 1);
    assert.equal(receipt.predecessorDerivationId, null);
    assert.equal(receipt.authorizationId, authorization.authorizationId);
    assert.deepEqual(
      value.store.getResidentIdentitySystemDerivation(receipt.derivationId),
      receipt,
    );
    assert.deepEqual(
      value.store.deriveResidentIdentitySystemLayers({
        authorizationId: authorization.authorizationId,
        freshSoul: soul,
        provenance: residentRunProvenance('203'),
        derivedAt: 350,
      }),
      receipt,
    );
    assert.throws(
      () =>
        value.store.deriveResidentIdentitySystemLayers({
          authorizationId: authorization.authorizationId,
          freshSoul: residentSoulSnapshot(
            value.directory,
            '# Replay source drift\n',
          ),
          provenance: residentRunProvenance('203'),
          derivedAt: 350,
        }),
      /current exact authorized SOUL source/,
    );
    assert.throws(
      () =>
        value.store.deriveResidentIdentitySystemLayers({
          authorizationId: authorization.authorizationId,
          freshSoul: soul,
          provenance: {
            ...residentRunProvenance('203'),
            batchSha256: hashContextBytes('changed replay batch'),
          },
          derivedAt: 350,
        }),
      /call already derived different sources/,
    );
    assert.throws(
      () =>
        value.store.deriveResidentIdentitySystemLayers({
          authorizationId: authorization.authorizationId,
          freshSoul: soul,
          provenance: residentRunProvenance('204'),
          derivedAt: 350,
        }),
      /already derived by a different call/,
    );

    const artifact = value.store.getScopedRuntimeContractArtifact();
    const contractLayer = value.store.getSystemLayerProjection(
      receipt.contractLayerId,
    );
    const identityLayer = value.store.getSystemLayerProjection(
      receipt.identityLayerId,
    );
    assert.equal(contractLayer?.content, artifact.content);
    assert.equal(contractLayer?.worldId, null);
    assert.equal(identityLayer?.content, soul.body);
    assert.equal(identityLayer?.worldId, null);
    const counts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_identity_system_derivations) AS derivations,
           (SELECT count(*) FROM context_system_layer_projections) AS layers,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals,
           (SELECT count(*) FROM context_system_profiles) AS profiles,
           (SELECT count(*) FROM context_world_events) AS worldEvents,
           (SELECT count(*) FROM context_branches) AS branches,
           (SELECT count(*) FROM context_effects) AS effects`,
      )
      .get();
    assert.deepEqual(
      { ...counts },
      {
        derivations: 1,
        layers: 2,
        approvals: 2,
        profiles: 0,
        worldEvents: 0,
        branches: 0,
        effects: 0,
      },
    );
    assert.deepEqual(value.store.getActivationState(), {
      mode: 'dark',
      epoch: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    const inspectedAgain = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('205'),
      observedAt: 400,
    });
    const authorizationAgain = value.store.authorizeResidentSourceCandidate({
      candidateId: inspectedAgain.candidate.candidateId,
      freshSoul: soul,
      provenance: residentRunProvenance('206'),
      authorizedAt: 410,
    });
    const receiptAgain = value.store.deriveResidentIdentitySystemLayers({
      authorizationId: authorizationAgain.authorizationId,
      freshSoul: soul,
      provenance: residentRunProvenance('207'),
      derivedAt: 420,
    });
    assert.equal(receiptAgain.authorityRevision, 2);
    assert.equal(receiptAgain.predecessorDerivationId, receipt.derivationId);
    assert.equal(receiptAgain.contractLayerId, receipt.contractLayerId);
    assert.equal(receiptAgain.contractApprovalId, receipt.contractApprovalId);
    assert.equal(receiptAgain.identityLayerId, receipt.identityLayerId);
    assert.equal(receiptAgain.identityApprovalId, receipt.identityApprovalId);
    const reusedCounts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_identity_system_derivations) AS derivations,
           (SELECT count(*) FROM context_system_layer_projections) AS layers,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals`,
      )
      .get();
    assert.deepEqual(
      { ...reusedCounts },
      { derivations: 2, layers: 2, approvals: 2 },
    );
    assert.deepEqual(
      value.store.getResidentIdentitySystemDerivation(
        receiptAgain.derivationId,
      ),
      receiptAgain,
    );

    const sourceOnlyPath = path.join(value.directory, 'source-only-SOUL.md');
    fs.writeFileSync(
      sourceOnlyPath,
      `---\nname: Briar\n---\n\n${soul.body}`,
    );
    const sourceOnlyChangedSoul = readPromptFacingSoulSnapshot(sourceOnlyPath);
    assert.equal(sourceOnlyChangedSoul.body, soul.body);
    assert.notEqual(sourceOnlyChangedSoul.sourceFileHash, soul.sourceFileHash);
    const inspectedSourceOnly =
      value.store.createResidentSourceInspectionCandidate({
        soul: sourceOnlyChangedSoul,
        provenance: residentRunProvenance('208'),
        observedAt: 430,
      });
    const authorizationSourceOnly =
      value.store.authorizeResidentSourceCandidate({
        candidateId: inspectedSourceOnly.candidate.candidateId,
        freshSoul: sourceOnlyChangedSoul,
        provenance: residentRunProvenance('209'),
        authorizedAt: 440,
      });
    const receiptSourceOnly = value.store.deriveResidentIdentitySystemLayers({
      authorizationId: authorizationSourceOnly.authorizationId,
      freshSoul: sourceOnlyChangedSoul,
      provenance: residentRunProvenance('210'),
      derivedAt: 450,
    });
    assert.equal(receiptSourceOnly.authorityRevision, 3);
    assert.equal(
      receiptSourceOnly.predecessorDerivationId,
      receiptAgain.derivationId,
    );
    assert.equal(receiptSourceOnly.contractLayerId, receipt.contractLayerId);
    assert.equal(receiptSourceOnly.contractApprovalId, receipt.contractApprovalId);
    assert.notEqual(receiptSourceOnly.identityLayerId, receipt.identityLayerId);
    assert.notEqual(
      receiptSourceOnly.identityApprovalId,
      receipt.identityApprovalId,
    );

    const changedSoul = residentSoulSnapshot(
      value.directory,
      '# Changed authorized synthetic soul\n',
    );
    const inspectedChanged = value.store.createResidentSourceInspectionCandidate({
      soul: changedSoul,
      provenance: residentRunProvenance('211'),
      observedAt: 460,
    });
    const authorizationChanged = value.store.authorizeResidentSourceCandidate({
      candidateId: inspectedChanged.candidate.candidateId,
      freshSoul: changedSoul,
      provenance: residentRunProvenance('212'),
      authorizedAt: 470,
    });
    const receiptChanged = value.store.deriveResidentIdentitySystemLayers({
      authorizationId: authorizationChanged.authorizationId,
      freshSoul: changedSoul,
      provenance: residentRunProvenance('213'),
      derivedAt: 480,
    });
    assert.equal(receiptChanged.authorityRevision, 4);
    assert.equal(
      receiptChanged.predecessorDerivationId,
      receiptSourceOnly.derivationId,
    );
    assert.equal(receiptChanged.contractLayerId, receipt.contractLayerId);
    assert.equal(receiptChanged.contractApprovalId, receipt.contractApprovalId);
    assert.notEqual(receiptChanged.identityLayerId, receipt.identityLayerId);
    assert.notEqual(receiptChanged.identityApprovalId, receipt.identityApprovalId);
    const changedCounts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_identity_system_derivations) AS derivations,
           (SELECT count(*) FROM context_system_layer_projections) AS layers,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals`,
      )
      .get();
    assert.deepEqual(
      { ...changedCounts },
      { derivations: 4, layers: 4, approvals: 4 },
    );
    assert.deepEqual(
      value.store.getResidentIdentitySystemDerivation(
        receiptChanged.derivationId,
      ),
      receiptChanged,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_resident_identity_system_derivations
             SET derived_at = derived_at + 1 WHERE derivation_id = ?`,
          )
          .run(receipt.derivationId),
      /resident identity system derivations are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_resident_identity_system_derivations
             SELECT * FROM context_resident_identity_system_derivations
             WHERE derivation_id = ?`,
          )
          .run(receipt.derivationId),
      /resident identity system derivation (identity conflict|lineage is invalid)/,
    );
  } finally {
    closeFixture(value);
  }
});

test('resident identity derivation refuses preexisting target rows without a derivation receipt', () => {
  const value = fixture();
  try {
    const soul = residentSoulSnapshot(value.directory);
    const inspected = value.store.createResidentSourceInspectionCandidate({
      soul,
      provenance: residentRunProvenance('220'),
      observedAt: 100,
    });
    const authorization = value.store.authorizeResidentSourceCandidate({
      candidateId: inspected.candidate.candidateId,
      freshSoul: soul,
      provenance: residentRunProvenance('221'),
      authorizedAt: 200,
    });
    const artifact = value.store.getScopedRuntimeContractArtifact();
    const contractLayer = value.store.createSystemLayerProjection({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      worldId: null,
      rendererGeneration: artifact.systemRendererGeneration,
      policyGeneration: artifact.policyGeneration,
      sourceKind: artifact.sourceKind,
      sourceHash: artifact.sourceHash,
      content: artifact.content,
      createdAt: 250,
    });
    value.store.approveSystemLayer({
      layerId: contractLayer.layerId,
      role: 'scoped_runtime_contract',
      basisRef: artifact.artifactId,
      approvalGeneration: 1,
      approvedAt: 250,
    });

    assert.throws(
      () =>
        value.store.deriveResidentIdentitySystemLayers({
          authorizationId: authorization.authorizationId,
          freshSoul: soul,
          provenance: residentRunProvenance('222'),
          derivedAt: 300,
        }),
      /refuses preexisting unreceipted target rows/,
    );
    const counts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_identity_system_derivations) AS derivations,
           (SELECT count(*) FROM context_system_layer_projections) AS layers,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals`,
      )
      .get();
    assert.deepEqual(
      { ...counts },
      { derivations: 0, layers: 1, approvals: 1 },
    );
  } finally {
    closeFixture(value);
  }
});

test('scoped runtime contract artifact is exact, independent from legacy prompt inputs, and immutable', () => {

  const value = fixture();
  try {
    const artifact = value.store.getScopedRuntimeContractArtifact();
    assert.deepEqual(artifact, SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1);
    const legacy = buildPromptProjection({
      soul: 'SOUL_PROMOTION_CANARY',
      memory: 'MEMORY_PROMOTION_CANARY',
      now: 'NOW_PROMOTION_CANARY',
      harnessRoot: '/example/harness',
      dataDirectory: '/example/data',
    });
    for (const canary of [
      'SOUL_PROMOTION_CANARY',
      'MEMORY_PROMOTION_CANARY',
      'NOW_PROMOTION_CANARY',
    ]) {
      assert.ok(legacy.content.includes(canary));
      assert.ok(!artifact.content.includes(canary));
    }
    const lifecycleBefore = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_world_events) AS events,
           (SELECT count(*) FROM context_branches) AS branches,
           (SELECT count(*) FROM context_system_layer_projections) AS layers,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals,
           (SELECT count(*) FROM context_system_profiles) AS profiles,
           (SELECT count(*) FROM context_dark_pending_branch_attempts) AS attempts`,
      )
      .get();
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_scoped_runtime_contract_artifacts
             SET content_text = 'changed' WHERE artifact_id = ?`,
          )
          .run(artifact.artifactId),
      /scoped runtime contract artifacts are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_scoped_runtime_contract_artifacts WHERE artifact_id = ?',
          )
          .run(artifact.artifactId),
      /scoped runtime contract artifacts are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT OR REPLACE INTO context_scoped_runtime_contract_artifacts(
               artifact_id, schema_version, system_renderer_generation,
               policy_generation, source_kind, source_hash, content_text,
               content_hash, content_bytes, introduced_by_migration
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifact.artifactId,
            artifact.schemaVersion,
            artifact.systemRendererGeneration,
            artifact.policyGeneration,
            artifact.sourceKind,
            artifact.sourceHash,
            artifact.content,
            artifact.contentHash,
            artifact.contentBytes,
            artifact.introducedByMigration,
          ),
      /scoped runtime contract artifact identity conflict/,
    );
    assert.deepEqual(value.store.getScopedRuntimeContractArtifact(), artifact);
    assert.deepEqual(
      value.database
        .prepare(
          `SELECT
             (SELECT count(*) FROM context_world_events) AS events,
             (SELECT count(*) FROM context_branches) AS branches,
             (SELECT count(*) FROM context_system_layer_projections) AS layers,
             (SELECT count(*) FROM context_system_layer_approvals) AS approvals,
             (SELECT count(*) FROM context_system_profiles) AS profiles,
             (SELECT count(*) FROM context_dark_pending_branch_attempts) AS attempts`,
        )
        .get(),
      lifecycleBefore,
    );
  } finally {
    closeFixture(value);
  }
});

test('scoped runtime contract reader rejects stored byte drift', () => {
  const value = fixture();
  try {
    value.database.exec(
      'DROP TRIGGER context_scoped_runtime_contract_artifacts_no_update',
    );
    value.database
      .prepare(
        `UPDATE context_scoped_runtime_contract_artifacts
         SET content_text = content_text || 'drift'`,
      )
      .run();
    assert.throws(
      () => value.store.getScopedRuntimeContractArtifact(),
      /scoped runtime contract artifact is missing or invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

test('world message projections materialize only exact ordered local text', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:a');
    const worldB = worldId('world:signal:b');
    const events = [
      { id: eventId('event:a-1'), world: worldA, text: 'A_ONE_CANARY' },
      { id: eventId('event:a-2'), world: worldA, text: 'A_TWO_CANARY' },
      { id: eventId('event:b-1'), world: worldB, text: 'B_ONLY_CANARY' },
    ];
    events.forEach((event, index) =>
      value.store.appendWorldEvent({
        eventId: event.id,
        worldId: event.world,
        kind: 'inbound:signal',
        payload: { text: event.text },
        occurredAt: index + 1,
        recordedAt: index + 1,
      }),
    );
    const projections = events.map((event, index) =>
      value.store.createEventMessageProjection({
        sourceEventId: event.id,
        sourceSequence: index + 1,
        worldId: event.world,
        rendererGeneration: 1,
        message: {
          role: 'user',
          content: `<incoming>${event.text}</incoming>`,
        },
        createdAt: index + 10,
      }),
    );
    assert.match(projections[0].projectionId, /^event-message:[0-9a-f]{64}$/);
    assert.equal(
      projections[0].messageHash,
      hashContextBytes(
        JSON.stringify({
          role: 'user',
          content: '<incoming>A_ONE_CANARY</incoming>',
        }),
      ),
    );
    assert.deepEqual(
      value.store.createEventMessageProjection({
        sourceEventId: events[0].id,
        sourceSequence: 1,
        worldId: worldA,
        rendererGeneration: 1,
        message: projections[0].message,
        createdAt: 99,
      }),
      projections[0],
    );
    assert.throws(
      () =>
        value.store.createEventMessageProjection({
          sourceEventId: events[0].id,
          sourceSequence: 1,
          worldId: worldA,
          rendererGeneration: 1,
          message: { role: 'user', content: 'changed rendering' },
          createdAt: 99,
        }),
      /projection identity conflict/,
    );
    assert.throws(
      () =>
        value.store.createEventMessageProjection({
          sourceEventId: events[0].id,
          sourceSequence: 2,
          worldId: worldA,
          rendererGeneration: 1,
          message: projections[0].message,
          createdAt: 99,
        }),
      /source lineage is invalid/,
    );
    const nonInbound = value.store.appendWorldEvent({
      eventId: eventId('event:derived'),
      worldId: worldA,
      kind: 'capsule',
      payload: { text: 'derived' },
      occurredAt: 4,
      recordedAt: 4,
    });
    assert.throws(
      () =>
        value.store.createEventMessageProjection({
          sourceEventId: nonInbound.eventId,
          sourceSequence: nonInbound.sequence,
          worldId: worldA,
          rendererGeneration: 1,
          message: { role: 'user', content: 'not authentic ingress' },
          createdAt: 99,
        }),
      /source lineage is invalid/,
    );

    const bMessages = materializeWorldConversation({
      store: value.store,
      worldId: worldB,
      rendererGeneration: 1,
      projectionIds: [projections[2].projectionId],
    });
    assert.deepEqual(bMessages, [
      {
        role: 'user',
        content: '<incoming>B_ONLY_CANARY</incoming>',
        worldId: worldB,
        eventId: events[2].id,
        sequence: 3,
      },
    ]);
    assert.equal(JSON.stringify(bMessages).includes('A_ONE_CANARY'), false);
    assert.throws(
      () =>
        materializeWorldConversation({
          store: value.store,
          worldId: worldB,
          rendererGeneration: 1,
          projectionIds: [projections[0].projectionId],
        }),
      /projection world mismatch/,
    );
    assert.throws(
      () =>
        materializeWorldConversation({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          projectionIds: [
            projections[1].projectionId,
            projections[0].projectionId,
          ],
        }),
      /projection order is invalid/,
    );
    const reorderedPlan = {
      schemaVersion: 2,
      worldId: worldA,
      wakeEventId: events[0].id,
      projectionGeneration: 2,
      policyGeneration: 1,
      rendererGeneration: 1,
      localEventIds: [events[1].id, events[0].id],
      localMessageProjectionIds: [
        projections[1].projectionId,
        projections[0].projectionId,
      ],
      sharedEventIds: [],
      foreignWorlds: [],
      unlineagedRoles: { system: 0, user: 0, assistant: 0, tool: 0 },
      systemLayers: [],
      blockers: [],
    };
    const reorderedHash = hashContextBytes(JSON.stringify(reorderedPlan));
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(`shadow-plan:${reorderedHash}`),
          worldId: worldA,
          wakeEventId: events[0].id,
          plan: reorderedPlan,
          createdAt: 99,
        }),
      /local event order is invalid/,
    );
    assert.throws(
      () =>
        materializeWorldConversation({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          projectionIds: [
            projections[0].projectionId,
            projections[0].projectionId,
          ],
        }),
      /duplicate projection/,
    );
    assert.throws(() =>
      value.database
        .prepare('UPDATE context_event_message_projections SET created_at = 0')
        .run(),
    );
    assert.throws(() =>
      value.database
        .prepare('DELETE FROM context_event_message_projections')
        .run(),
    );
  } finally {
    closeFixture(value);
  }
});

test('system layers materialize only explicit branch-visible scope', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:a');
    const worldB = worldId('world:signal:b');
    const create = (input: {
      kind:
        | 'runtime_contract'
        | 'identity'
        | 'world_policy'
        | 'private_frontier'
        | 'legacy_memory';
      visibility:
        | 'global_contract'
        | 'integrated_self'
        | 'integrated_self_candidate'
        | 'world'
        | 'private_root'
        | 'legacy_mixed';
      worldId: ReturnType<typeof worldId> | null;
      source: string;
      content: string;
      createdAt: number;
    }) =>
      value.store.createSystemLayerProjection({
        kind: input.kind,
        visibility: input.visibility,
        worldId: input.worldId,
        rendererGeneration: 1,
        policyGeneration: 1,
        sourceKind: 'synthetic_fixture',
        sourceHash: hashContextBytes(input.source),
        content: input.content,
        createdAt: input.createdAt,
      });
    const contract = create({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      worldId: null,
      source: 'contract-v1',
      content: 'CONTRACT_CANARY',
      createdAt: 1,
    });
    const identity = create({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      source: 'identity-v1',
      content: '\nIDENTITY_CANARY',
      createdAt: 2,
    });
    const worldPolicyA = create({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldA,
      source: 'policy-a',
      content: '\nWORLD_A_CANARY',
      createdAt: 3,
    });
    const worldPolicyB = create({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldB,
      source: 'policy-b',
      content: '\nWORLD_B_CANARY',
      createdAt: 4,
    });
    const candidate = create({
      kind: 'identity',
      visibility: 'integrated_self_candidate',
      worldId: null,
      source: 'candidate-v1',
      content: '\nCANDIDATE_CANARY',
      createdAt: 5,
    });
    const legacy = create({
      kind: 'legacy_memory',
      visibility: 'legacy_mixed',
      worldId: null,
      source: 'legacy-v1',
      content: '\nLEGACY_CANARY',
      createdAt: 6,
    });
    assert.match(contract.layerId, /^system-layer:[0-9a-f]{64}$/);
    assert.notEqual(worldPolicyA.layerId, worldPolicyB.layerId);
    assert.deepEqual(
      value.store.createSystemLayerProjection({
        kind: contract.kind,
        visibility: contract.visibility,
        worldId: contract.worldId,
        rendererGeneration: contract.rendererGeneration,
        policyGeneration: contract.policyGeneration,
        sourceKind: contract.sourceKind,
        sourceHash: contract.sourceHash,
        content: contract.content,
        createdAt: 99,
      }),
      contract,
    );
    const materialized = materializeSystemProjection({
      store: value.store,
      worldId: worldA,
      rendererGeneration: 1,
      policyGeneration: 1,
      layerIds: [contract.layerId, identity.layerId, worldPolicyA.layerId],
    });
    assert.deepEqual(materialized, {
      role: 'system',
      content: 'CONTRACT_CANARY\nIDENTITY_CANARY\nWORLD_A_CANARY',
    });
    assert.equal(materialized.content.includes('WORLD_B_CANARY'), false);
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldB,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [contract.layerId, identity.layerId, worldPolicyA.layerId],
        }),
      /world mismatch/,
    );
    for (const blocked of [candidate.layerId, legacy.layerId]) {
      assert.throws(
        () =>
          materializeSystemProjection({
            store: value.store,
            worldId: worldA,
            rendererGeneration: 1,
            policyGeneration: 1,
            layerIds: [contract.layerId, blocked],
          }),
        /not branch-visible/,
      );
    }
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [identity.layerId, contract.layerId],
        }),
      /order is invalid/,
    );
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [contract.layerId, identity.layerId, identity.layerId],
        }),
      /duplicate system layer/,
    );
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [
            contract.layerId,
            systemLayerProjectionId(`system-layer:${'0'.repeat(64)}`),
          ],
        }),
      /is missing/,
    );
    const privateLayer = create({
      kind: 'private_frontier',
      visibility: 'private_root',
      worldId: null,
      source: 'private-root-v1',
      content: '\nPRIVATE_ROOT_CANARY',
      createdAt: 7,
    });
    const wake = value.store.appendWorldEvent({
      eventId: eventId('event:system-plan-wake'),
      worldId: worldA,
      kind: 'inbound:signal',
      payload: { text: 'wake' },
      occurredAt: 8,
      recordedAt: 8,
    });
    const planFor = (layerId: typeof contract.layerId, blockers: string[]) => ({
      schemaVersion: 3,
      worldId: worldA,
      wakeEventId: wake.eventId,
      projectionGeneration: 3,
      policyGeneration: 1,
      rendererGeneration: 1,
      systemRendererGeneration: 1,
      localEventIds: [wake.eventId],
      localMessageProjectionIds: [],
      sharedEventIds: [],
      foreignWorlds: [],
      unlineagedRoles: { system: 0, user: 0, assistant: 0, tool: 0 },
      systemLayerProjectionIds: [layerId],
      blockers,
    });
    const malformedPlan = {
      ...planFor(privateLayer.layerId, [
        'unrendered_event',
        'system_layer_unavailable',
        'unbound_effect_tools',
      ]),
      systemLayerProjectionIds: 'not-an-array',
    };
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(malformedPlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: malformedPlan,
          createdAt: 9,
        }),
      /system layer references are invalid/,
    );
    const privatePlan = planFor(privateLayer.layerId, [
      'unrendered_event',
      'unbound_effect_tools',
    ]);
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(privatePlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: privatePlan,
          createdAt: 9,
        }),
      /system layer scope is unsupported/,
    );
    const missingBlockerPlan = planFor(candidate.layerId, [
      'unrendered_event',
      'unbound_effect_tools',
    ]);
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(missingBlockerPlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: missingBlockerPlan,
          createdAt: 10,
        }),
      /system blocker lineage is invalid/,
    );
    const staleBlockerPlan = planFor(candidate.layerId, [
      'legacy_mixed_system',
      'identity_candidate_unapproved',
      'unrendered_event',
      'unbound_effect_tools',
    ]);
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(staleBlockerPlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: staleBlockerPlan,
          createdAt: 11,
        }),
      /blockers are invalid/,
    );
    assert.throws(() =>
      value.database
        .prepare('UPDATE context_system_layer_projections SET created_at = 0')
        .run(),
    );
    assert.throws(() =>
      value.database
        .prepare('DELETE FROM context_system_layer_projections')
        .run(),
    );
    value.database.exec(
      'DROP TRIGGER context_system_layer_projections_no_update',
    );
    value.database
      .prepare(
        'UPDATE context_system_layer_projections SET content_text = ? WHERE layer_id = ?',
      )
      .run('CORRUPTED', contract.layerId);
    assert.throws(
      () => value.store.getSystemLayerProjection(contract.layerId),
      /stored system layer projection is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

function createBranch(
  store: ContextGraphStore,
  id: string,
  world: string,
  startedAt = 10,
): void {
  store.createBranch({
    branchId: branchId(id),
    worldId: worldId(world),
    authorityEpoch: 1,
    startedAt,
  });
}

function createLegacyCapsule(
  store: ContextGraphStore,
  id: string,
  branch: string,
  world: string,
): void {
  store.createCapsule({
    capsuleId: capsuleId(id),
    branchId: branchId(branch),
    worldId: worldId(world),
    kind: 'legacy_opaque',
    viewManifestHash: null,
    sourceRootHash: hashContextBytes('legacy-root'),
    policyGeneration: 0,
    content: { testimony: 'sealed legacy continuation' },
    createdAt: 12,
  });
}

test('shadow request observations are hash-only, immutable, and result-bound', () => {
  const value = fixture();
  try {
    const world = worldId('world:discord:guild:example');
    const wake = eventId('event:shadow-wake');
    value.store.appendWorldEvent({
      eventId: wake,
      worldId: world,
      kind: 'inbound',
      payload: { text: 'source testimony' },
      occurredAt: 10,
      recordedAt: 11,
    });
    const plan = {
      schemaVersion: 1,
      worldId: world,
      wakeEventId: wake,
      projectionGeneration: 1,
      policyGeneration: 1,
      localEventIds: [wake],
      sharedEventIds: [],
      foreignWorlds: [],
      unlineagedRoles: { system: 0, user: 0, assistant: 0, tool: 0 },
      systemLayers: [
        {
          ordinal: 0,
          sha256: hashContextBytes('system layer'),
          byteLength: 12,
          scope: 'legacy-mixed',
        },
      ],
      blockers: ['legacy_mixed_system'],
    };
    const missingLineagePlan = {
      ...plan,
      localEventIds: [wake, eventId('event:missing')],
    };
    const missingLineageHash = hashContextBytes(
      JSON.stringify(missingLineagePlan),
    );
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(`shadow-plan:${missingLineageHash}`),
          worldId: world,
          wakeEventId: wake,
          plan: missingLineagePlan,
          createdAt: 12,
        }),
      /local event is not in its world/,
    );
    const unsafePlan = { ...plan, content: 'forbidden raw request content' };
    const unsafeHash = hashContextBytes(JSON.stringify(unsafePlan));
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(`shadow-plan:${unsafeHash}`),
          worldId: world,
          wakeEventId: wake,
          plan: unsafePlan,
          createdAt: 12,
        }),
      /unsupported field/,
    );
    const planHash = hashContextBytes(JSON.stringify(plan));
    const planId = shadowProjectionPlanId(`shadow-plan:${planHash}`);
    const created = value.store.createShadowProjectionPlan({
      planId,
      worldId: world,
      wakeEventId: wake,
      plan,
      createdAt: 12,
    });
    assert.deepEqual(
      value.store.createShadowProjectionPlan({
        planId,
        worldId: world,
        wakeEventId: wake,
        plan,
        createdAt: 99,
      }),
      created,
      'content-addressed plans are create-if-identical',
    );

    const actualHash = hashContextBytes('actual projection bytes');
    const observed = value.store.recordShadowRequestObservation({
      observationId: shadowRequestObservationId('shadow-observation:one'),
      planId,
      worldId: world,
      surface: 'openai-chat',
      actualHash,
      actualBytes: 23,
      result: 'ineligible',
      reason: 'legacy_mixed_system',
      expectedHash: null,
      expectedBytes: null,
      observedAt: 13,
    });
    assert.equal(observed.reason, 'legacy_mixed_system');
    assert.deepEqual(value.store.listShadowRequestObservations(planId), [
      observed,
    ]);
    assert.throws(
      () =>
        value.store.recordShadowRequestObservation({
          observationId: shadowRequestObservationId(
            'shadow-observation:false-equal',
          ),
          planId,
          worldId: world,
          surface: 'openai-chat',
          actualHash,
          actualBytes: 23,
          result: 'equal',
          reason: null,
          expectedHash: hashContextBytes('different projection'),
          expectedBytes: 23,
          observedAt: 14,
        }),
      /result does not match/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            "UPDATE context_shadow_request_observations SET reason='changed' WHERE observation_id=?",
          )
          .run(observed.observationId),
      /immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_shadow_projection_plans WHERE plan_id=?',
          )
          .run(planId),
      /immutable/,
    );
    const columns = (
      value.database
        .prepare(
          "SELECT name FROM pragma_table_info('context_shadow_request_observations') ORDER BY cid",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    assert.equal(columns.includes('bytes'), false);
    assert.equal(columns.includes('content'), false);
  } finally {
    closeFixture(value);
  }
});

test('context graph immutable records reject update and deletion', () => {
  const value = fixture();
  try {
    const event = value.store.appendWorldEvent({
      eventId: eventId('event:1'),
      worldId: worldId('world:discord:guild:example'),
      kind: 'inbound',
      payload: { text: 'neutral fixture' },
      occurredAt: 10,
      recordedAt: 11,
    });
    assert.equal(event.payloadHash, hashContextBytes(event.payloadJson));

    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_world_events SET payload_json = ? WHERE event_id = ?',
          )
          .run('{}', 'event:1'),
      /context world events are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare('DELETE FROM context_world_events WHERE event_id = ?')
          .run('event:1'),
      /context world events are immutable/,
    );
    assert.equal(
      value.store.getWorldEvent(eventId('event:1'))?.payloadJson,
      '{"text":"neutral fixture"}',
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_world_events(
              event_id, world_id, event_kind, payload_json, payload_hash,
              occurred_at, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'event:bad-json',
            'world:internal',
            'test',
            '{',
            'a'.repeat(64),
            12,
            12,
          ),
      /CHECK constraint failed/,
    );
  } finally {
    closeFixture(value);
  }
});

test('context graph enforces same-world lineage and view edges', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:contact-a');
    const worldB = worldId('world:signal:contact-b');
    createBranch(value.store, 'branch:a', worldA);
    value.store.appendWorldEvent({
      eventId: eventId('event:b'),
      worldId: worldB,
      kind: 'inbound',
      payload: { text: 'world B only' },
      occurredAt: 12,
      recordedAt: 13,
    });
    assert.throws(
      () =>
        value.store.createManifest({
          manifestId: manifestId('manifest:a'),
          branchId: branchId('branch:a'),
          worldId: worldA,
          manifest: createViewManifest({
            branchId: branchId('branch:a'),
            worldId: worldA,
            parentBranchId: null,
            authorityEpoch: 1,
            eventIds: [eventId('event:b')],
            sharedEventIds: [],
            policyGeneration: 1,
          }),
          projectionGeneration: 0,
          createdAt: 14,
        }),
      /FOREIGN KEY constraint failed/,
    );

    const count = value.database
      .prepare(
        "SELECT count(*) AS count FROM context_manifests WHERE manifest_id = 'manifest:a'",
      )
      .get() as { count: number };
    assert.equal(
      count.count,
      0,
      'failed edge rolls back its manifest atomically',
    );
    value.store.finishBranch(branchId('branch:a'), 'yielded', 15);
    assert.throws(
      () =>
        value.store.createBranch({
          branchId: branchId('branch:b-child'),
          worldId: worldB,
          parentBranchId: branchId('branch:a'),
          authorityEpoch: 1,
          startedAt: 16,
        }),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    closeFixture(value);
  }
});

test('capsule edges enforce causal DAG order at the database seam', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:capsules', 'world:legacy-unscoped');
    createLegacyCapsule(
      value.store,
      'capsule:parent',
      'branch:capsules',
      'world:legacy-unscoped',
    );
    value.store.createCapsule({
      capsuleId: capsuleId('capsule:child'),
      branchId: branchId('branch:capsules'),
      worldId: worldId('world:legacy-unscoped'),
      kind: 'legacy_opaque',
      viewManifestHash: null,
      sourceRootHash: hashContextBytes('legacy-root-child'),
      policyGeneration: 0,
      content: { testimony: 'child' },
      parentCapsuleIds: [capsuleId('capsule:parent')],
      createdAt: 13,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_capsule_edges(
              child_capsule_id, parent_capsule_id, world_id, ordinal
            ) VALUES (?, ?, ?, ?)`,
          )
          .run('capsule:parent', 'capsule:child', 'world:legacy-unscoped', 0),
      /parent must predate child/,
    );
  } finally {
    closeFixture(value);
  }
});

test('manifests bind canonical hashes and exact active share events', () => {
  const value = fixture();
  try {
    const sourceWorld = worldId('world:discord:guild:source');
    const destinationWorld = worldId('world:signal:destination');
    createBranch(value.store, 'branch:source', sourceWorld);
    value.store.appendWorldEvent({
      eventId: eventId('event:source'),
      worldId: sourceWorld,
      kind: 'inbound',
      payload: { text: 'source-only text' },
      occurredAt: 10,
      recordedAt: 10,
    });
    const sourceView = createViewManifest({
      branchId: branchId('branch:source'),
      worldId: sourceWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [eventId('event:source')],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    for (const [id, changed] of [
      [
        'manifest:wrong-authority',
        createViewManifest({ ...sourceView, authorityEpoch: 2 }),
      ],
      [
        'manifest:wrong-parent',
        createViewManifest({
          ...sourceView,
          parentBranchId: branchId('branch:unrelated'),
        }),
      ],
    ] as const) {
      assert.throws(
        () =>
          value.store.createManifest({
            manifestId: manifestId(id),
            branchId: branchId('branch:source'),
            worldId: sourceWorld,
            manifest: changed,
            projectionGeneration: 1,
            createdAt: 11,
          }),
        /lineage does not match/,
      );
    }
    const sourceManifest = value.store.createManifest({
      manifestId: manifestId('manifest:source'),
      branchId: branchId('branch:source'),
      worldId: sourceWorld,
      manifest: sourceView,
      projectionGeneration: 1,
      createdAt: 11,
    });
    assert.equal(JSON.parse(sourceManifest.json).hash, sourceView.hash);
    assert.match(sourceManifest.cacheNamespace, /^context:[0-9a-f]{64}$/);
    assert.throws(
      () =>
        value.store.createCapsule({
          capsuleId: capsuleId('capsule:wrong-policy'),
          branchId: branchId('branch:source'),
          worldId: sourceWorld,
          kind: 'private',
          viewManifestHash: sourceView.hash,
          sourceRootHash: hashContextBytes('source-root'),
          policyGeneration: 2,
          content: { text: 'must not persist' },
          createdAt: 12,
        }),
      /policy does not match/,
    );
    value.store.createCapsule({
      capsuleId: capsuleId('capsule:source'),
      branchId: branchId('branch:source'),
      worldId: sourceWorld,
      kind: 'private',
      viewManifestHash: sourceView.hash,
      sourceRootHash: hashContextBytes('source-root'),
      policyGeneration: 1,
      content: { text: 'explicitly shareable sentence' },
      createdAt: 12,
    });
    value.store.createShareGrant({
      grantId: shareGrantId('share:one'),
      sharedEventId: eventId('event:share:one'),
      sourceCapsuleId: capsuleId('capsule:source'),
      sourceWorldId: sourceWorld,
      destinationWorldId: destinationWorld,
      canonicalText: 'explicitly shared sentence',
      authorityEpoch: 1,
      createdAt: 13,
    });

    value.store.finishBranch(branchId('branch:source'), 'yielded', 14);
    createBranch(value.store, 'branch:destination', destinationWorld, 15);
    const destinationView = createViewManifest({
      branchId: branchId('branch:destination'),
      worldId: destinationWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [eventId('event:share:one')],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:destination'),
      branchId: branchId('branch:destination'),
      worldId: destinationWorld,
      manifest: destinationView,
      projectionGeneration: 1,
      shareGrantIds: [shareGrantId('share:one')],
      createdAt: 15,
    });
    const shareEdge = value.database
      .prepare(
        `SELECT grant_id, shared_event_id, destination_world_id
         FROM context_manifest_shares WHERE manifest_id = ?`,
      )
      .get('manifest:destination') as {
      grant_id: string;
      shared_event_id: string;
      destination_world_id: string;
    };
    assert.deepEqual(
      { ...shareEdge },
      {
        grant_id: 'share:one',
        shared_event_id: 'event:share:one',
        destination_world_id: destinationWorld,
      },
    );
    const sourceProjection = value.store.getManifestProjection(
      manifestId('manifest:source'),
      { requireActiveShares: true },
    );
    assert.equal(sourceProjection?.localEvents[0]?.eventId, 'event:source');
    assert.deepEqual(
      JSON.parse(sourceProjection?.localEvents[0]?.payloadJson ?? '{}'),
      { text: 'source-only text' },
    );
    const destinationProjection = value.store.getManifestProjection(
      manifestId('manifest:destination'),
      { requireActiveShares: true },
    );
    assert.deepEqual(destinationProjection?.localEvents, []);
    assert.deepEqual(destinationProjection?.shares[0], {
      grantId: shareGrantId('share:one'),
      eventId: eventId('event:share:one'),
      sourceCapsuleId: capsuleId('capsule:source'),
      sourceWorldId: sourceWorld,
      destinationWorldId: destinationWorld,
      canonicalText: 'explicitly shared sentence',
      contentHash: hashContextBytes('explicitly shared sentence'),
      status: 'active',
      authorityEpoch: 1,
    });

    value.store.finishBranch(branchId('branch:destination'), 'yielded', 16);
    createBranch(value.store, 'branch:tampered', destinationWorld, 17);
    assert.throws(
      () =>
        value.store.createManifest({
          manifestId: manifestId('manifest:tampered'),
          branchId: branchId('branch:tampered'),
          worldId: destinationWorld,
          manifest: {
            ...destinationView,
            branchId: branchId('branch:tampered'),
            hash: '0'.repeat(64),
          },
          projectionGeneration: 1,
          shareGrantIds: [shareGrantId('share:one')],
          createdAt: 17,
        }),
      /hash does not match/,
    );

    value.store.finishBranch(branchId('branch:tampered'), 'crashed', 18);
    value.store.revokeShareGrant(shareGrantId('share:one'), 19);
    assert.equal(
      value.store.getManifestProjection(manifestId('manifest:destination'))
        ?.shares[0]?.status,
      'revoked',
    );
    assert.throws(
      () =>
        value.store.getManifestProjection(manifestId('manifest:destination'), {
          requireActiveShares: true,
        }),
      /revoked share/,
    );
    createBranch(value.store, 'branch:revoked', destinationWorld, 20);
    const revokedView = createViewManifest({
      ...destinationView,
      branchId: branchId('branch:revoked'),
    });
    assert.throws(
      () =>
        value.store.createManifest({
          manifestId: manifestId('manifest:revoked'),
          branchId: branchId('branch:revoked'),
          worldId: destinationWorld,
          manifest: revokedView,
          projectionGeneration: 1,
          shareGrantIds: [shareGrantId('share:one')],
          createdAt: 20,
        }),
      /revoked context share/,
    );
  } finally {
    closeFixture(value);
  }
});

test('continuation head compare-and-swap rejects a stale revision', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:1', 'world:console');
    value.store.finishBranch(branchId('branch:1'), 'yielded', 12);
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_continuation_head
             SET branch_id = 'branch:1', world_id = 'world:console',
               revision = 1, updated_at = 12 WHERE singleton = 1`,
          )
          .run(),
      /lacks an advance receipt/,
    );

    const first = value.store.advanceContinuationHead({
      expectedRevision: 0,
      branchId: branchId('branch:1'),
      updatedAt: 12,
    });
    assert.deepEqual(first, {
      branchId: branchId('branch:1'),
      worldId: worldId('world:console'),
      revision: 1,
      updatedAt: 12,
    });

    createBranch(value.store, 'branch:2', 'world:console', 13);
    assert.throws(
      () =>
        value.store.advanceContinuationHead({
          expectedRevision: 0,
          branchId: branchId('branch:2'),
          updatedAt: 13,
        }),
      StaleContinuationHeadError,
    );
    assert.equal(value.store.getContinuationHead().branchId, 'branch:1');
    assert.equal(value.store.getContinuationHead().revision, 1);
  } finally {
    closeFixture(value);
  }
});

test('continuation advances are immutable and preserve cross-world order', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:a', 'world:discord:guild:a');
    value.store.finishBranch(branchId('branch:a'), 'yielded', 20);
    value.store.advanceContinuationHead({
      expectedRevision: 0,
      branchId: branchId('branch:a'),
      updatedAt: 21,
    });

    createBranch(value.store, 'branch:b', 'world:signal:contact-b', 22);
    assert.throws(
      () =>
        value.store.advanceContinuationHead({
          expectedRevision: 1,
          branchId: branchId('branch:b'),
          updatedAt: 23,
        }),
      /has not yielded/,
    );
    value.store.finishBranch(branchId('branch:b'), 'yielded', 24);
    value.store.advanceContinuationHead({
      expectedRevision: 1,
      branchId: branchId('branch:b'),
      updatedAt: 25,
    });

    const rows = value.database
      .prepare(
        `SELECT revision, predecessor_branch_id, predecessor_world_id,
          branch_id, world_id FROM context_continuation_advances ORDER BY revision`,
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      {
        revision: 1,
        predecessor_branch_id: null,
        predecessor_world_id: null,
        branch_id: 'branch:a',
        world_id: 'world:discord:guild:a',
      },
      {
        revision: 2,
        predecessor_branch_id: 'branch:a',
        predecessor_world_id: 'world:discord:guild:a',
        branch_id: 'branch:b',
        world_id: 'world:signal:contact-b',
      },
    ]);
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_continuation_advances WHERE revision = 1',
          )
          .run(),
      /immutable/,
    );
  } finally {
    closeFixture(value);
  }
});

test('restart recovery converts prepared effects to uncertain without retry', () => {
  const value = fixture();
  try {
    const world = worldId('world:discord:guild:example');
    createBranch(value.store, 'branch:effect', world);
    value.store.prepareEffect({
      effectId: effectId('effect:1'),
      branchId: branchId('branch:effect'),
      worldId: world,
      destinationWorldId: world,
      kind: 'send',
      authorityEpoch: 1,
      payload: { destination: 'channel-example', text: 'hello' },
      idempotencyKey: 'send-attempt-1',
      preparedAt: 20,
    });

    assert.throws(
      () => value.store.finishBranch(branchId('branch:effect'), 'crashed', 29),
      /prepared effect/,
    );
    const recovered = value.store.recoverPreparedEffects(30);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, 'uncertain');
    assert.equal(recovered[0]?.resolvedAt, 30);
    assert.deepEqual(value.store.recoverPreparedEffects(31), []);
    assert.throws(
      () =>
        value.store.resolveEffect(effectId('effect:1'), 'observed', 32, {
          remoteId: 'not-issued-by-test',
        }),
      /effect is not prepared/,
    );
    value.store.finishBranch(branchId('branch:effect'), 'crashed', 33);
    assert.throws(
      () =>
        value.store.prepareEffect({
          effectId: effectId('effect:2'),
          branchId: branchId('branch:effect'),
          worldId: world,
          destinationWorldId: world,
          kind: 'send',
          authorityEpoch: 1,
          payload: { text: 'must not issue from a closed branch' },
          preparedAt: 34,
        }),
      /branch is not running/,
    );
  } finally {
    closeFixture(value);
  }
});

test('root coordinator serializes branches against one continuation head', () => {
  const value = fixture();
  try {
    const first = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:coordinated-a1'),
      worldId: worldId('world:signal:a'),
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 10,
    });
    assert.deepEqual(first.start, {
      branchId: branchId('branch:coordinated-a1'),
      worldId: worldId('world:signal:a'),
      baseRevision: 0,
      predecessorBranchId: null,
      predecessorWorldId: null,
      startedAt: 10,
    });
    assert.equal(first.state.activeBranchId, 'branch:coordinated-a1');
    assert.throws(
      () => value.store.finishBranch(first.branch.branchId, 'yielded', 11),
      /return capsules are incomplete/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_root_coordinator
             SET base_revision = 99, updated_at = 11 WHERE singleton = 1`,
          )
          .run(),
      /invalid context root coordinator transition/,
    );
    assert.throws(
      () =>
        value.store.beginCoordinatedBranch({
          branchId: branchId('branch:overlap'),
          worldId: worldId('world:signal:b'),
          expectedRevision: 0,
          authorityEpoch: 1,
          startedAt: 11,
        }),
      /already active/,
    );

    const firstView = createViewManifest({
      branchId: first.branch.branchId,
      worldId: first.branch.worldId,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:coordinated-a1'),
      branchId: first.branch.branchId,
      worldId: first.branch.worldId,
      manifest: firstView,
      projectionGeneration: 1,
      createdAt: 11,
    });
    value.store.completeCoordinatedBranch({
      branchId: first.branch.branchId,
      viewManifestHash: firstView.hash,
      privateCapsuleId: capsuleId('capsule:coordinated-a1-private'),
      rootReceiptCapsuleId: capsuleId('capsule:coordinated-a1-root'),
      sourceRootHash: hashContextBytes('coordinated-a1-root'),
      privateContent: { summary: 'first local branch' },
      outcome: 'completed',
      commitments: [],
      blockers: [],
      artifactRefs: [],
      endedAt: 12,
    });
    assert.deepEqual(value.store.getRootCoordinatorState(), {
      activeBranchId: null,
      activeWorldId: null,
      baseRevision: 1,
      predecessorBranchId: branchId('branch:coordinated-a1'),
      predecessorWorldId: worldId('world:signal:a'),
      updatedAt: 12,
    });
    assert.throws(
      () =>
        value.store.beginCoordinatedBranch({
          branchId: branchId('branch:stale'),
          worldId: worldId('world:signal:b'),
          expectedRevision: 0,
          authorityEpoch: 1,
          startedAt: 13,
        }),
      StaleContinuationHeadError,
    );
    assert.equal(value.store.getBranch(branchId('branch:stale')), null);

    const otherWorld = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:coordinated-b'),
      worldId: worldId('world:signal:b'),
      expectedRevision: 1,
      authorityEpoch: 1,
      startedAt: 14,
    });
    assert.equal(otherWorld.branch.parentBranchId, null);
    value.store.recoverCoordinatedBranch(15);

    const sameWorld = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:coordinated-a2'),
      worldId: worldId('world:signal:a'),
      expectedRevision: 1,
      authorityEpoch: 1,
      startedAt: 16,
    });
    assert.equal(sameWorld.branch.parentBranchId, 'branch:coordinated-a1');
  } finally {
    closeFixture(value);
  }
});

test('coordinated return commits both capsules and head advance atomically', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:return');
    value.store.appendWorldEvent({
      eventId: eventId('event:return'),
      worldId: world,
      kind: 'inbound',
      payload: { text: 'return me' },
      occurredAt: 9,
      recordedAt: 9,
    });
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:return'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 2,
      startedAt: 10,
    });
    const view = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: world,
      parentBranchId: null,
      authorityEpoch: 2,
      eventIds: [eventId('event:return')],
      sharedEventIds: [],
      policyGeneration: 3,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:return'),
      branchId: opened.branch.branchId,
      worldId: world,
      manifest: view,
      projectionGeneration: 4,
      createdAt: 11,
    });
    value.store.prepareEffect({
      effectId: effectId('effect:return'),
      branchId: opened.branch.branchId,
      worldId: world,
      destinationWorldId: world,
      kind: 'send',
      authorityEpoch: 2,
      payload: { text: 'attempted' },
      preparedAt: 12,
    });
    const complete = (
      parentCapsuleIds?: readonly ReturnType<typeof capsuleId>[],
    ) =>
      value.store.completeCoordinatedBranch({
        branchId: opened.branch.branchId,
        viewManifestHash: view.hash,
        privateCapsuleId: capsuleId('capsule:return-private'),
        rootReceiptCapsuleId: capsuleId('capsule:return-root'),
        sourceRootHash: hashContextBytes('branch trace root'),
        privateContent: { summary: 'world-local outcome' },
        privateParentCapsuleIds: parentCapsuleIds,
        outcome: 'completed',
        commitments: ['follow up locally'],
        blockers: [],
        artifactRefs: ['artifact:one'],
        endedAt: 16,
      });

    assert.throws(() => complete(), /prepared effect/);
    assert.equal(value.store.getContinuationHead().revision, 0);
    value.store.resolveEffect(effectId('effect:return'), 'failed', 13, {
      accepted: false,
    });
    assert.throws(
      () => complete([capsuleId('capsule:missing-parent')]),
      /FOREIGN KEY constraint failed/,
    );
    const capsuleCount = value.database
      .prepare('SELECT count(*) AS n FROM context_capsules')
      .get() as { n: number };
    assert.equal(capsuleCount.n, 0);
    assert.equal(
      value.store.getBranch(opened.branch.branchId)?.status,
      'running',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);

    const returned = complete();
    assert.equal(returned.branch.status, 'yielded');
    assert.equal(returned.head.revision, 1);
    assert.equal(returned.head.branchId, opened.branch.branchId);
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    const rootReceipt = JSON.parse(returned.rootReceipt.contentJson);
    assert.equal(rootReceipt.privateCapsuleId, 'capsule:return-private');
    assert.deepEqual(rootReceipt.effects, [
      {
        effectId: 'effect:return',
        destinationWorldId: world,
        kind: 'send',
        authorityEpoch: 2,
        payloadHash: hashContextBytes(JSON.stringify({ text: 'attempted' })),
        status: 'failed',
        preparedAt: 12,
        resolvedAt: 13,
      },
    ]);
    const committedCapsules = value.database
      .prepare(
        `SELECT capsule_kind FROM context_capsules
         WHERE branch_id = ? ORDER BY sequence`,
      )
      .all(opened.branch.branchId) as { capsule_kind: string }[];
    assert.deepEqual(
      committedCapsules.map((row) => row.capsule_kind),
      ['private', 'root_receipt'],
    );
  } finally {
    closeFixture(value);
  }
});

test('root coordinator crash recovery makes prepared effects uncertain without advancing', () => {
  const value = fixture();
  try {
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:recover-active'),
      worldId: worldId('world:signal:recovery'),
      expectedRevision: 0,
      authorityEpoch: 4,
      startedAt: 10,
    });
    value.store.prepareEffect({
      effectId: effectId('effect:recover-active'),
      branchId: opened.branch.branchId,
      worldId: opened.branch.worldId,
      destinationWorldId: opened.branch.worldId,
      kind: 'send',
      authorityEpoch: 4,
      payload: { text: 'issued state is unknown after restart' },
      preparedAt: 11,
    });

    const recovered = value.store.recoverCoordinatedBranch(20);
    assert.deepEqual(recovered, {
      ...opened.start,
      uncertainEffects: 1,
      recoveredAt: 20,
    });
    assert.equal(
      value.store.getBranch(opened.branch.branchId)?.status,
      'crashed',
    );
    assert.equal(
      value.store.getEffect(effectId('effect:recover-active'))?.status,
      'uncertain',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.recoverCoordinatedBranch(21), null);

    const retry = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:recover-retry'),
      worldId: opened.branch.worldId,
      expectedRevision: 0,
      authorityEpoch: 5,
      startedAt: 22,
    });
    assert.equal(retry.start.baseRevision, 0);
  } finally {
    closeFixture(value);
  }
});

test('legacy import receipts are idempotent and reject changed testimony', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:migration', 'world:legacy-unscoped');
    createLegacyCapsule(
      value.store,
      'capsule:legacy',
      'branch:migration',
      'world:legacy-unscoped',
    );

    const sourceHash = hashContextBytes('exact old mixed summary bytes');
    const first = value.store.recordLegacyImport({
      receiptId: legacyImportReceiptId('legacy-import:1'),
      sourceRef: 'transcript:main:summary-7',
      sourceHash,
      sourceSize: 29,
      artifactRef: `legacy:${sourceHash}`,
      importGeneration: 1,
      capsuleId: capsuleId('capsule:legacy'),
      importedAt: 20,
    });
    const repeated = value.store.recordLegacyImport({
      receiptId: legacyImportReceiptId('legacy-import:retry'),
      sourceRef: 'transcript:main:summary-7',
      sourceHash,
      sourceSize: 29,
      artifactRef: `legacy:${sourceHash}`,
      importGeneration: 1,
      capsuleId: capsuleId('capsule:legacy'),
      importedAt: 99,
    });
    assert.deepEqual(repeated, first);

    const row = value.database
      .prepare('SELECT count(*) AS count FROM context_legacy_import_receipts')
      .get() as { count: number };
    assert.equal(row.count, 1);
    assert.throws(
      () =>
        value.store.recordLegacyImport({
          receiptId: legacyImportReceiptId('legacy-import:2'),
          sourceRef: 'transcript:main:summary-7',
          sourceHash: hashContextBytes(
            'different bytes must not gain old provenance',
          ),
          sourceSize: 45,
          artifactRef: 'legacy:different',
          importGeneration: 1,
          capsuleId: capsuleId('capsule:legacy'),
          importedAt: 100,
        }),
      LegacyImportConflictError,
    );
  } finally {
    closeFixture(value);
  }
});

test('local branch request views bind one coordinated world without lifecycle effects', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:a');
    const worldB = worldId('world:signal:b');
    const eventA = value.store.appendWorldEvent({
      eventId: eventId('event:request-a'),
      worldId: worldA,
      kind: 'inbound:signal',
      payload: { text: 'A_PRIVATE_CANARY' },
      occurredAt: 1,
      recordedAt: 1,
    });
    const eventB1 = value.store.appendWorldEvent({
      eventId: eventId('event:request-b1'),
      worldId: worldB,
      kind: 'inbound:signal',
      payload: { text: 'B_ONE_CANARY' },
      occurredAt: 2,
      recordedAt: 2,
    });
    const eventB2 = value.store.appendWorldEvent({
      eventId: eventId('event:request-b2'),
      worldId: worldB,
      kind: 'inbound:signal',
      payload: { text: 'B_TWO_CANARY' },
      occurredAt: 3,
      recordedAt: 3,
    });
    const projectionA = value.store.createEventMessageProjection({
      sourceEventId: eventA.eventId,
      sourceSequence: eventA.sequence,
      worldId: worldA,
      rendererGeneration: 1,
      message: {
        role: 'user',
        content: '<incoming>A_PRIVATE_CANARY</incoming>',
      },
      createdAt: 4,
    });
    const projectionB1 = value.store.createEventMessageProjection({
      sourceEventId: eventB1.eventId,
      sourceSequence: eventB1.sequence,
      worldId: worldB,
      rendererGeneration: 1,
      message: { role: 'user', content: '<incoming>B_ONE_CANARY</incoming>' },
      createdAt: 5,
    });
    const projectionB2 = value.store.createEventMessageProjection({
      sourceEventId: eventB2.eventId,
      sourceSequence: eventB2.sequence,
      worldId: worldB,
      rendererGeneration: 1,
      message: { role: 'user', content: '<incoming>B_TWO_CANARY</incoming>' },
      createdAt: 6,
    });
    const layer = (input: {
      kind: 'runtime_contract' | 'identity' | 'world_policy';
      visibility: 'global_contract' | 'integrated_self' | 'world';
      worldId: ReturnType<typeof worldId> | null;
      source: string;
      content: string;
      createdAt: number;
    }) =>
      value.store.createSystemLayerProjection({
        kind: input.kind,
        visibility: input.visibility,
        worldId: input.worldId,
        rendererGeneration: 1,
        policyGeneration: 1,
        sourceKind: 'synthetic_fixture',
        sourceHash: hashContextBytes(input.source),
        content: input.content,
        createdAt: input.createdAt,
      });
    const contract = layer({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      worldId: null,
      source: 'request-contract',
      content: 'CONTRACT_CANARY',
      createdAt: 7,
    });
    const identity = layer({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      source: 'request-identity',
      content: '\nIDENTITY_CANARY',
      createdAt: 8,
    });
    const policyA = layer({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldA,
      source: 'request-policy-a',
      content: '\nA_POLICY_CANARY',
      createdAt: 9,
    });
    const policyB = layer({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldB,
      source: 'request-policy-b',
      content: '\nB_POLICY_CANARY',
      createdAt: 10,
    });
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:request-b'),
      worldId: worldB,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 11,
    });
    const manifest = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: worldB,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [eventB1.eventId, eventB2.eventId],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:request-b'),
      branchId: opened.branch.branchId,
      worldId: worldB,
      manifest,
      projectionGeneration: 1,
      createdAt: 12,
    });
    const base = {
      branchId: opened.branch.branchId,
      worldId: worldB,
      manifestId: manifestId('manifest:request-b'),
      systemRendererGeneration: 1,
      systemLayerProjectionIds: [
        contract.layerId,
        identity.layerId,
        policyB.layerId,
      ],
      messageProjectionIds: [
        projectionB1.projectionId,
        projectionB2.projectionId,
      ],
      createdAt: 13,
    };
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          systemLayerProjectionIds: [
            contract.layerId,
            identity.layerId,
            policyA.layerId,
          ],
        }),
      /system layer is invalid/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          messageProjectionIds: [
            projectionB2.projectionId,
            projectionB1.projectionId,
          ],
        }),
      /message lineage is invalid/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          messageProjectionIds: [projectionB1.projectionId],
        }),
      /coverage is incomplete/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          messageProjectionIds: [
            projectionB1.projectionId,
            projectionA.projectionId,
          ],
        }),
      /message lineage is invalid/,
    );
    const lifecycleBefore = {
      branch: value.store.getBranch(opened.branch.branchId),
      coordinator: value.store.getRootCoordinatorState(),
      head: value.store.getContinuationHead(),
      activation: value.store.getActivationState(),
    };
    const created = value.store.createLocalBranchRequestView(base);
    assert.match(created.requestViewId, /^branch-request-view:[0-9a-f]{64}$/);
    assert.equal(created.view.executionMode, 'dark');
    assert.equal(created.view.scope, 'local-only');
    assert.equal(created.view.runnable, false);
    assert.equal(created.view.toolMode, 'none');
    assert.deepEqual(value.store.createLocalBranchRequestView(base), created);
    const materialized = materializeLocalBranchRequest({
      store: value.store,
      requestViewId: created.requestViewId,
    });
    assert.deepEqual(materialized.messages, [
      {
        role: 'system',
        content: 'CONTRACT_CANARY\nIDENTITY_CANARY\nB_POLICY_CANARY',
      },
      { role: 'user', content: '<incoming>B_ONE_CANARY</incoming>' },
      { role: 'user', content: '<incoming>B_TWO_CANARY</incoming>' },
    ]);
    assert.equal(
      materialized.candidateHash,
      hashContextBytes(materialized.candidateJson),
    );
    assert.equal(
      materialized.candidateBytes,
      Buffer.byteLength(materialized.candidateJson),
    );
    assert.equal(
      materialized.candidateJson.includes('A_PRIVATE_CANARY'),
      false,
    );
    assert.equal(materialized.candidateJson.includes('A_POLICY_CANARY'), false);
    assert.deepEqual(
      {
        branch: value.store.getBranch(opened.branch.branchId),
        coordinator: value.store.getRootCoordinatorState(),
        head: value.store.getContinuationHead(),
        activation: value.store.getActivationState(),
      },
      lifecycleBefore,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_local_branch_request_views SET created_at = 0 WHERE request_view_id = ?',
          )
          .run(created.requestViewId),
      /immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_local_branch_request_messages WHERE request_view_id = ?',
          )
          .run(created.requestViewId),
      /immutable/,
    );
    value.store.recoverCoordinatedBranch(14);
    assert.throws(
      () => value.store.createLocalBranchRequestView(base),
      /active coordinated branch/,
    );
    value.database.exec(
      'DROP TRIGGER context_local_branch_request_views_no_update',
    );
    value.database
      .prepare(
        'UPDATE context_local_branch_request_views SET view_hash = ? WHERE request_view_id = ?',
      )
      .run('0'.repeat(64), created.requestViewId);
    assert.throws(
      () => value.store.getLocalBranchRequestView(created.requestViewId),
      /stored local branch request view is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

test('local branch request views reject manifests with explicit shares', () => {
  const value = fixture();
  try {
    const sourceWorld = worldId('world:signal:source');
    const destinationWorld = worldId('world:signal:destination');
    createBranch(value.store, 'branch:share-source', sourceWorld, 1);
    const sourceManifest = createViewManifest({
      branchId: branchId('branch:share-source'),
      worldId: sourceWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:share-source'),
      branchId: branchId('branch:share-source'),
      worldId: sourceWorld,
      manifest: sourceManifest,
      projectionGeneration: 1,
      createdAt: 2,
    });
    value.store.createCapsule({
      capsuleId: capsuleId('capsule:share-source'),
      branchId: branchId('branch:share-source'),
      worldId: sourceWorld,
      kind: 'private',
      viewManifestHash: sourceManifest.hash,
      sourceRootHash: hashContextBytes('share-source-root'),
      policyGeneration: 1,
      content: { text: 'shareable fixture' },
      createdAt: 3,
    });
    value.store.createShareGrant({
      grantId: shareGrantId('share:request-view'),
      sharedEventId: eventId('event:request-view-share'),
      sourceCapsuleId: capsuleId('capsule:share-source'),
      sourceWorldId: sourceWorld,
      destinationWorldId: destinationWorld,
      canonicalText: 'explicit share fixture',
      authorityEpoch: 1,
      createdAt: 4,
    });
    value.store.finishBranch(branchId('branch:share-source'), 'yielded', 5);
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:share-destination'),
      worldId: destinationWorld,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 6,
    });
    const destinationManifest = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: destinationWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [eventId('event:request-view-share')],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:share-destination'),
      branchId: opened.branch.branchId,
      worldId: destinationWorld,
      manifest: destinationManifest,
      projectionGeneration: 1,
      shareGrantIds: [shareGrantId('share:request-view')],
      createdAt: 7,
    });
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          branchId: opened.branch.branchId,
          worldId: destinationWorld,
          manifestId: manifestId('manifest:share-destination'),
          systemRendererGeneration: 1,
          systemLayerProjectionIds: [],
          messageProjectionIds: [],
          createdAt: 8,
        }),
      /manifest is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

test('local branch request views reject non-monotonic manifest event order', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:request-order');
    const first = value.store.appendWorldEvent({
      eventId: eventId('event:request-order-first'),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'first' },
      occurredAt: 1,
      recordedAt: 1,
    });
    const later = value.store.appendWorldEvent({
      eventId: eventId('event:request-order-later'),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'later' },
      occurredAt: 2,
      recordedAt: 2,
    });
    const firstProjection = value.store.createEventMessageProjection({
      sourceEventId: first.eventId,
      sourceSequence: first.sequence,
      worldId: world,
      rendererGeneration: 1,
      message: { role: 'user', content: 'first' },
      createdAt: 3,
    });
    const laterProjection = value.store.createEventMessageProjection({
      sourceEventId: later.eventId,
      sourceSequence: later.sequence,
      worldId: world,
      rendererGeneration: 1,
      message: { role: 'user', content: 'later' },
      createdAt: 4,
    });
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:request-order'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 5,
    });
    const manifest = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: world,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [later.eventId, first.eventId],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:request-order'),
      branchId: opened.branch.branchId,
      worldId: world,
      manifest,
      projectionGeneration: 1,
      createdAt: 6,
    });
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          branchId: opened.branch.branchId,
          worldId: world,
          manifestId: manifestId('manifest:request-order'),
          systemRendererGeneration: 1,
          systemLayerProjectionIds: [],
          messageProjectionIds: [
            laterProjection.projectionId,
            firstProjection.projectionId,
          ],
          createdAt: 7,
        }),
      /manifest event order is invalid/,
    );
    const row = value.database
      .prepare(
        'SELECT count(*) AS count FROM context_local_branch_request_views',
      )
      .get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    closeFixture(value);
  }
});

test('manifest rereads reject canonical authority drift from the branch', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:manifest-lineage');
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:manifest-lineage'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 1,
    });
    const malformed = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: world,
      parentBranchId: null,
      authorityEpoch: 2,
      eventIds: [],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    const projectionGeneration = 1;
    const cacheNamespace = `context:${hashContextBytes(
      `${world}\u0000${projectionGeneration}\u0000${malformed.hash}`,
    )}`;
    value.database
      .prepare(
        `INSERT INTO context_manifests(
           manifest_id, branch_id, world_id, manifest_hash, manifest_json,
           projection_generation, policy_generation, cache_namespace, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'manifest:authority-drift',
        opened.branch.branchId,
        world,
        malformed.hash,
        JSON.stringify(malformed),
        projectionGeneration,
        malformed.policyGeneration,
        cacheNamespace,
        2,
      );
    assert.throws(
      () =>
        value.store.getManifestProjection(
          manifestId('manifest:authority-drift'),
        ),
      /stored context manifest identity is invalid/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          branchId: opened.branch.branchId,
          worldId: world,
          manifestId: manifestId('manifest:authority-drift'),
          systemRendererGeneration: 1,
          systemLayerProjectionIds: [],
          messageProjectionIds: [],
          createdAt: 3,
        }),
      /stored context manifest identity is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

function createDarkAssemblyInputs(
  value: ReturnType<typeof fixture>,
  world: ReturnType<typeof worldId>,
  prefix: string,
): {
  messageProjectionIds: ReturnType<typeof eventMessageProjectionId>[];
} {
  const events = ['one', 'two'].map((suffix, index) =>
    value.store.appendWorldEvent({
      eventId: eventId('event:' + prefix + '-' + suffix),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: prefix + '-' + suffix },
      occurredAt: index + 1,
      recordedAt: index + 1,
    }),
  );
  const projections = events.map((event, index) =>
    value.store.createEventMessageProjection({
      sourceEventId: event.eventId,
      sourceSequence: event.sequence,
      worldId: world,
      rendererGeneration: 7,
      message: {
        role: 'user',
        content:
          '<incoming>' +
          prefix.toUpperCase() +
          '_' +
          (index + 1) +
          '_CANARY</incoming>',
      },
      createdAt: index + 10,
    }),
  );
  const layer = (input: {
    kind: 'runtime_contract' | 'identity' | 'world_policy';
    visibility: 'global_contract' | 'integrated_self' | 'world';
    layerWorld: ReturnType<typeof worldId> | null;
    sourceKind: 'authored_scoped_contract' | 'soul_snapshot' | 'routing_policy';
    role: 'scoped_runtime_contract' | 'identity' | 'world_policy';
    content: string;
    createdAt: number;
  }) => {
    const projection = value.store.createSystemLayerProjection({
      kind: input.kind,
      visibility: input.visibility,
      worldId: input.layerWorld,
      rendererGeneration: 4,
      policyGeneration: 3,
      sourceKind: input.sourceKind,
      sourceHash: hashContextBytes(prefix + ':' + input.kind),
      content: input.content,
      createdAt: input.createdAt,
    });
    const approval = value.store.approveSystemLayer({
      layerId: projection.layerId,
      role: input.role,
      basisRef: 'fixture:' + prefix + ':' + input.kind,
      approvalGeneration: 1,
      approvedAt: 23,
    });
    return { approval };
  };
  const layers = [
    layer({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      layerWorld: null,
      sourceKind: 'authored_scoped_contract',
      role: 'scoped_runtime_contract',
      content: 'DARK_CONTRACT',
      createdAt: 20,
    }),
    layer({
      kind: 'identity',
      visibility: 'integrated_self',
      layerWorld: null,
      sourceKind: 'soul_snapshot',
      role: 'identity',
      content: '\nASTER_IDENTITY',
      createdAt: 21,
    }),
    layer({
      kind: 'world_policy',
      visibility: 'world',
      layerWorld: world,
      sourceKind: 'routing_policy',
      role: 'world_policy',
      content: '\n' + prefix.toUpperCase() + '_POLICY_CANARY',
      createdAt: 22,
    }),
  ];
  const profile = value.store.createSystemProfile({
    worldId: world,
    scopedRuntimeContractApprovalId: layers[0]!.approval.approvalId,
    identityApprovalId: layers[1]!.approval.approvalId,
    worldPolicyApprovalId: layers[2]!.approval.approvalId,
    createdAt: 24,
  });
  value.store.advanceSystemProfileHead({
    worldId: world,
    expectedRevision: 0,
    expectedProfileId: null,
    profileId: profile.profileId,
    advancedAt: 25,
  });
  return {
    messageProjectionIds: projections.map(
      (projection) => projection.projectionId,
    ),
  };
}

function tableCount(database: DatabaseSync, table: string): number {
  const row = database
    .prepare('SELECT count(*) AS count FROM ' + table)
    .get() as { count: number };
  return row.count;
}

test('dark local branch assembly atomically reserves only one world and remains non-runnable', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:assembly-a');
    const worldB = worldId('world:signal:assembly-b');
    const a = createDarkAssemblyInputs(value, worldA, 'assembly-a');
    const b = createDarkAssemblyInputs(value, worldB, 'assembly-b');
    const activationBefore = value.store.getActivationState();
    const headBefore = value.store.getContinuationHead();

    const assembled = assembleDarkLocalBranch({
      store: value.store,
      expectedActivationEpoch: activationBefore.epoch,
      expectedHeadRevision: headBefore.revision,
      worldId: worldB,
      branchId: branchId('branch:dark-assembly-b'),
      messageProjectionIds: b.messageProjectionIds,
      assembledAt: 30,
    });

    assert.equal(assembled.branch.worldId, worldB);
    assert.equal(assembled.branch.status, 'running');
    assert.equal(assembled.branch.authorityEpoch, 1);
    assert.equal(assembled.start.baseRevision, 0);
    assert.match(assembled.manifest.manifestId, /^manifest:[0-9a-f]{64}$/);
    assert.equal(assembled.manifest.projectionGeneration, 7);
    assert.equal(assembled.manifest.policyGeneration, 3);
    assert.deepEqual(JSON.parse(assembled.manifest.json).sharedEventIds, []);
    assert.equal(assembled.requestView.view.runnable, false);
    assert.equal(assembled.requestView.view.toolMode, 'none');
    assert.deepEqual(assembled.request.messages, [
      {
        role: 'system',
        content: 'DARK_CONTRACT\nASTER_IDENTITY\nASSEMBLY-B_POLICY_CANARY',
      },
      { role: 'user', content: '<incoming>ASSEMBLY-B_1_CANARY</incoming>' },
      { role: 'user', content: '<incoming>ASSEMBLY-B_2_CANARY</incoming>' },
    ]);
    assert.equal(
      assembled.request.candidateJson.includes('ASSEMBLY-A_1_CANARY'),
      false,
    );
    assert.equal(
      assembled.request.candidateJson.includes('ASSEMBLY-A_POLICY_CANARY'),
      false,
    );
    assert.equal(
      assembled.request.candidateHash,
      hashContextBytes(assembled.request.candidateJson),
    );
    assert.equal(a.messageProjectionIds.length, 2);

    assert.equal(tableCount(value.database, 'context_branches'), 1);
    assert.equal(tableCount(value.database, 'context_branch_starts'), 1);
    assert.equal(tableCount(value.database, 'context_manifests'), 1);
    assert.equal(
      tableCount(value.database, 'context_local_branch_request_views'),
      1,
    );
    assert.equal(
      tableCount(value.database, 'context_system_profile_request_view_bindings'),
      1,
    );
    assert.equal(
      assembled.profileBinding.binding.requestViewId,
      assembled.requestView.requestViewId,
    );
    assert.deepEqual(value.store.getRootCoordinatorState(), {
      activeBranchId: assembled.branch.branchId,
      activeWorldId: worldB,
      baseRevision: 0,
      predecessorBranchId: null,
      predecessorWorldId: null,
      updatedAt: 30,
    });
    assert.deepEqual(value.store.getContinuationHead(), headBefore);
    assert.deepEqual(value.store.getActivationState(), activationBefore);
    for (const table of [
      'context_capsules',
      'context_effects',
      'context_continuation_advances',
      'context_shadow_projection_plans',
      'context_shadow_request_observations',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }

    const recovered = value.store.recoverCoordinatedBranch(31);
    assert.equal(recovered?.uncertainEffects, 0);
    assert.equal(value.store.getContinuationHead().revision, 0);
    assert.equal(
      value.store.getBranch(assembled.branch.branchId)?.status,
      'crashed',
    );
    assert.deepEqual(
      materializeLocalBranchRequest({
        store: value.store,
        requestViewId: assembled.requestView.requestViewId,
      }),
      assembled.request,
    );
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rolls back a late request-view failure', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-rollback');
    const input = createDarkAssemblyInputs(value, world, 'assembly-rollback');
    value.database.exec(
      [
        'CREATE TEMP TRIGGER force_dark_assembly_late_failure',
        'BEFORE INSERT ON context_local_branch_request_views',
        'BEGIN',
        "SELECT RAISE(ABORT, 'forced late assembly failure');",
        'END;',
      ].join('\n'),
    );
    assert.throws(
      () =>
        assembleDarkLocalBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          worldId: world,
          branchId: branchId('branch:assembly-rollback'),
          ...input,
          assembledAt: 30,
        }),
      /forced late assembly failure/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_manifest_events',
      'context_local_branch_request_views',
      'context_local_branch_request_system_layers',
      'context_local_branch_request_messages',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rolls back candidate materialization failure', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-candidate-rollback');
    const input = createDarkAssemblyInputs(
      value,
      world,
      'assembly-candidate-rollback',
    );
    const content = 'x'.repeat(
      Math.floor(MAX_LOCAL_BRANCH_REQUEST_CANDIDATE_BYTES / 2) + 1,
    );
    const projections = ['one', 'two'].map((suffix, index) => {
      const event = value.store.appendWorldEvent({
        eventId: eventId('event:assembly-candidate-' + suffix),
        worldId: world,
        kind: 'inbound:signal',
        payload: { text: suffix },
        occurredAt: index + 40,
        recordedAt: index + 40,
      });
      return value.store.createEventMessageProjection({
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        worldId: world,
        rendererGeneration: 7,
        message: { role: 'user', content },
        createdAt: index + 50,
      });
    });
    assert.throws(
      () =>
        assembleDarkLocalBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          worldId: world,
          branchId: branchId('branch:assembly-candidate-rollback'),
          messageProjectionIds: projections.map(
            (projection) => projection.projectionId,
          ),
          assembledAt: 60,
        }),
      /candidate exceeds byte limit/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_manifest_events',
      'context_local_branch_request_views',
      'context_local_branch_request_system_layers',
      'context_local_branch_request_messages',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly requires a selected profile before any write', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-profile-missing');
    const source = value.store.appendWorldEvent({
      eventId: eventId('event:assembly-profile-missing'),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'PROFILE_REQUIRED_CANARY' },
      occurredAt: 1,
      recordedAt: 1,
    });
    const projection = value.store.createEventMessageProjection({
      sourceEventId: source.eventId,
      sourceSequence: source.sequence,
      worldId: world,
      rendererGeneration: 7,
      message: { role: 'user', content: 'PROFILE_REQUIRED_CANARY' },
      createdAt: 2,
    });
    assert.throws(
      () =>
        assembleDarkLocalBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          worldId: world,
          branchId: branchId('branch:assembly-profile-missing'),
          messageProjectionIds: [projection.projectionId],
          assembledAt: 30,
        }),
      /current system profile head not found/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_system_profile_request_view_bindings',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rolls back a late profile-binding failure', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-binding-rollback');
    const input = createDarkAssemblyInputs(
      value,
      world,
      'assembly-binding-rollback',
    );
    value.database.exec(
      [
        'CREATE TEMP TRIGGER force_dark_binding_failure',
        'BEFORE INSERT ON context_system_profile_request_view_bindings',
        'BEGIN',
        "SELECT RAISE(ABORT, 'forced binding failure');",
        'END;',
      ].join('\n'),
    );
    assert.throws(
      () =>
        assembleDarkLocalBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          worldId: world,
          branchId: branchId('branch:assembly-binding-rollback'),
          messageProjectionIds: input.messageProjectionIds,
          assembledAt: 30,
        }),
      /forced binding failure/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_system_profile_request_view_bindings',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rejects stale root state and an active branch', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-stale');
    const input = createDarkAssemblyInputs(value, world, 'assembly-stale');
    const assemble = (
      overrides: Partial<Parameters<typeof assembleDarkLocalBranch>[0]>,
    ) =>
      assembleDarkLocalBranch({
        store: value.store,
        expectedActivationEpoch: 0,
        expectedHeadRevision: 0,
        worldId: world,
        branchId: branchId('branch:assembly-stale'),
        ...input,
        assembledAt: 30,
        ...overrides,
      });
    assert.throws(
      () => assemble({ expectedActivationEpoch: 1 }),
      /activation is not dark at epoch 1/,
    );
    assert.throws(
      () => assemble({ expectedHeadRevision: 1 }),
      StaleContinuationHeadError,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 0);

    value.store.beginCoordinatedBranch({
      branchId: branchId('branch:already-active'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 8,
      startedAt: 31,
    });
    assert.throws(
      () => assemble({ branchId: branchId('branch:blocked-by-active') }),
      /context branch already active/,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 1);
    assert.equal(
      value.store.getRootCoordinatorState().activeBranchId,
      branchId('branch:already-active'),
    );
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly derives same-world parent and fresh authority', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-parent');
    const input = createDarkAssemblyInputs(value, world, 'assembly-parent');
    const previousBranchId = branchId('branch:assembly-parent-history');
    value.store.createBranch({
      branchId: previousBranchId,
      worldId: world,
      authorityEpoch: 8,
      startedAt: 1,
    });
    value.store.finishBranch(previousBranchId, 'yielded', 2);
    value.store.advanceContinuationHead({
      expectedRevision: 0,
      branchId: previousBranchId,
      updatedAt: 3,
    });

    const assembled = assembleDarkLocalBranch({
      store: value.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 1,
      worldId: world,
      branchId: branchId('branch:assembly-parent-current'),
      ...input,
      assembledAt: 30,
    });
    assert.equal(assembled.branch.parentBranchId, previousBranchId);
    assert.equal(assembled.branch.authorityEpoch, 9);
    assert.equal(assembled.start.predecessorBranchId, previousBranchId);
    assert.equal(assembled.start.predecessorWorldId, world);
    assert.equal(assembled.start.baseRevision, 1);
    assert.equal(value.store.getContinuationHead().revision, 1);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rejects incomplete or substituted projection lineage', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-lineage');
    const foreignWorld = worldId('world:signal:assembly-foreign');
    const input = createDarkAssemblyInputs(value, world, 'assembly-lineage');
    const foreign = createDarkAssemblyInputs(
      value,
      foreignWorld,
      'assembly-foreign',
    );
    const extraEvent = value.store.appendWorldEvent({
      eventId: eventId('event:assembly-other-generation'),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'other generation' },
      occurredAt: 40,
      recordedAt: 40,
    });
    const wrongGeneration = value.store.createEventMessageProjection({
      sourceEventId: extraEvent.eventId,
      sourceSequence: extraEvent.sequence,
      worldId: world,
      rendererGeneration: 8,
      message: { role: 'user', content: 'OTHER_GENERATION_CANARY' },
      createdAt: 41,
    });
    const assemble = (
      messageProjectionIds: typeof input.messageProjectionIds,
    ) =>
      assembleDarkLocalBranch({
        store: value.store,
        expectedActivationEpoch: 0,
        expectedHeadRevision: 0,
        worldId: world,
        branchId: branchId('branch:assembly-invalid-lineage'),
        messageProjectionIds,
        assembledAt: 50,
      });

    assert.throws(
      () => assemble([]),
      /requires unique local message projections/,
    );
    assert.throws(
      () =>
        assemble([
          input.messageProjectionIds[0]!,
          input.messageProjectionIds[0]!,
        ]),
      /requires unique local message projections/,
    );
    assert.throws(
      () => assemble([eventMessageProjectionId('event-message:missing')]),
      /projection is missing/,
    );
    assert.throws(
      () => assemble([foreign.messageProjectionIds[0]!]),
      /message lineage is invalid/,
    );
    assert.throws(
      () => assemble([...input.messageProjectionIds].reverse()),
      /manifest event order is invalid/,
    );
    assert.throws(
      () =>
        assemble([
          input.messageProjectionIds[0]!,
          wrongGeneration.projectionId,
        ]),
      /renderer generation is inconsistent/,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 0);

    const firstProjection = value.store.getEventMessageProjection(
      input.messageProjectionIds[0]!,
    )!;
    value.database.exec('DROP TRIGGER context_world_events_no_update');
    value.database
      .prepare(
        'UPDATE context_world_events SET event_kind = ? WHERE event_id = ?',
      )
      .run('derived:capsule', firstProjection.sourceEventId);
    assert.throws(
      () => assemble(input.messageProjectionIds),
      /stored event message projection has invalid source/,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 0);
  } finally {
    closeFixture(value);
  }
});

test('dark ingress admission atomically records only a new exact inbound event', () => {
  const value = fixture();
  try {
    const input = {
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      wakeClass: 'text_user_turn' as const,
      messageRendererGeneration: 7,
      event: {
        eventId: eventId('event:dark-ingress-exact'),
        worldId: worldId('world:signal:dark-ingress'),
        kind: 'inbound:signal',
        payload: { text: 'DARK_INGRESS_PRIVATE_CANARY' },
        occurredAt: 10,
        recordedAt: 11,
      },
      admittedAt: 12,
    };
    const receipt = value.store.admitDarkInboundEvent(input);
    assert.deepEqual(receipt.generation, {
      queueGeneration: 1,
      firstAdmissibleSequence: 1,
      activationEpoch: 0,
    });
    assert.equal(receipt.event.sequence, 1);
    assert.deepEqual(receipt.admission, {
      eventId: input.event.eventId,
      worldId: input.event.worldId,
      sourceSequence: 1,
      activationEpoch: 0,
      queueGeneration: 1,
      wakeClass: 'text_user_turn',
      messageRendererGeneration: 7,
      admittedAt: 12,
    });
    assert.deepEqual(value.store.admitDarkInboundEvent(input), receipt);

    const admissionRow = value.database
      .prepare('SELECT * FROM context_dark_ingress_admissions')
      .get() as Record<string, unknown>;
    assert.equal(
      JSON.stringify(admissionRow).includes('DARK_INGRESS_PRIVATE_CANARY'),
      false,
    );
    assert.equal(
      receipt.event.payloadJson.includes('DARK_INGRESS_PRIVATE_CANARY'),
      true,
    );
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          ...input,
          admittedAt: 13,
        }),
      /dark ingress admission conflict/,
    );
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          ...input,
          event: { ...input.event, payload: { text: 'changed' } },
        }),
      /dark ingress admission conflict/,
    );

    const unadmitted = value.store.appendWorldEvent({
      eventId: eventId('event:dark-ingress-unadmitted'),
      worldId: input.event.worldId,
      kind: 'inbound:signal',
      payload: { text: 'UNADMITTED_CANARY' },
      occurredAt: 20,
      recordedAt: 20,
    });
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          ...input,
          event: {
            eventId: unadmitted.eventId,
            worldId: unadmitted.worldId,
            kind: unadmitted.kind,
            payload: { text: 'UNADMITTED_CANARY' },
            occurredAt: unadmitted.occurredAt,
            recordedAt: unadmitted.recordedAt,
          },
          admittedAt: 20,
        }),
      /dark ingress admission conflict/,
    );
    assert.equal(tableCount(value.database, 'context_dark_ingress_admissions'), 1);
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_effects',
      'context_continuation_advances',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
  } finally {
    closeFixture(value);
  }
});

test('dark ingress admission rolls its event back after a late database rejection', () => {
  const value = fixture();
  try {
    value.database.exec(`
      CREATE TRIGGER test_dark_ingress_late_rejection
      BEFORE INSERT ON context_dark_ingress_admissions
      WHEN NEW.event_id = 'event:dark-ingress-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic late admission rejection');
      END;
    `);
    const rejectedId = eventId('event:dark-ingress-rollback');
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          expectedActivationEpoch: 0,
          queueGeneration: 1,
          wakeClass: 'text_user_turn',
          messageRendererGeneration: 1,
          event: {
            eventId: rejectedId,
            worldId: worldId('world:discord:rollback'),
            kind: 'inbound:discord',
            payload: { text: 'ROLLBACK_CANARY' },
            occurredAt: 30,
            recordedAt: 30,
          },
          admittedAt: 30,
        }),
      /synthetic late admission rejection/,
    );
    assert.equal(value.store.getWorldEvent(rejectedId), null);
    assert.equal(value.store.getDarkIngressAdmission(rejectedId), null);
    assert.equal(tableCount(value.database, 'context_world_events'), 0);
    assert.equal(tableCount(value.database, 'context_dark_ingress_admissions'), 0);
  } finally {
    closeFixture(value);
  }
});

test('dark ingress admission fails closed on stale state and immutable lineage', () => {
  const value = fixture();
  try {
    const staleId = eventId('event:dark-ingress-stale');
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          expectedActivationEpoch: 1,
          queueGeneration: 1,
          wakeClass: 'text_user_turn',
          messageRendererGeneration: 1,
          event: {
            eventId: staleId,
            worldId: worldId('world:signal:stale'),
            kind: 'inbound:signal',
            payload: { text: 'STALE_CANARY' },
            occurredAt: 40,
            recordedAt: 40,
          },
          admittedAt: 40,
        }),
      /context graph activation is not dark at epoch 1/,
    );
    assert.equal(value.store.getWorldEvent(staleId), null);

    const rejectedDerivedId = eventId('event:dark-ingress-api-derived');
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          expectedActivationEpoch: 0,
          queueGeneration: 1,
          wakeClass: 'text_user_turn',
          messageRendererGeneration: 1,
          event: {
            eventId: rejectedDerivedId,
            worldId: worldId('world:signal:api-derived'),
            kind: 'derived:capsule',
            payload: { text: 'API_DERIVED_CANARY' },
            occurredAt: 45,
            recordedAt: 45,
          },
          admittedAt: 45,
        }),
      /context dark ingress admission lineage is invalid/,
    );
    assert.equal(value.store.getWorldEvent(rejectedDerivedId), null);
    assert.equal(value.store.getDarkIngressAdmission(rejectedDerivedId), null);

    const derived = value.store.appendWorldEvent({
      eventId: eventId('event:dark-ingress-derived'),
      worldId: worldId('world:signal:derived'),
      kind: 'derived:capsule',
      payload: { text: 'DERIVED_CANARY' },
      occurredAt: 50,
      recordedAt: 50,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_dark_ingress_admissions(
               event_id, world_id, source_sequence, activation_epoch,
               queue_generation, wake_class, message_renderer_generation,
               admitted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            derived.eventId,
            derived.worldId,
            derived.sequence,
            0,
            1,
            'text_user_turn',
            1,
            50,
          ),
      /context dark ingress admission lineage is invalid/,
    );

    const admitted = value.store.admitDarkInboundEvent({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      wakeClass: 'text_user_turn',
      messageRendererGeneration: 1,
      event: {
        eventId: eventId('event:dark-ingress-immutable'),
        worldId: worldId('world:signal:immutable'),
        kind: 'inbound:signal',
        payload: { text: 'IMMUTABLE_CANARY' },
        occurredAt: 60,
        recordedAt: 60,
      },
      admittedAt: 60,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_dark_ingress_admissions SET admitted_at = ? WHERE event_id = ?',
          )
          .run(61, admitted.event.eventId),
      /context dark ingress admissions are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_dark_ingress_admissions WHERE event_id = ?',
          )
          .run(admitted.event.eventId),
      /context dark ingress admissions are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_dark_ingress_generations SET activation_epoch = 2 WHERE queue_generation = 1',
          )
          .run(),
      /context dark ingress generations are immutable/,
    );
  } finally {
    closeFixture(value);
  }
});

function admitPendingFixture(
  value: ReturnType<typeof fixture>,
  input: {
    id: string;
    world: string;
    rendererGeneration: number;
    queueGeneration?: number;
    content: string;
    time: number;
    project?: boolean;
    projectionRendererGeneration?: number;
  },
) {
  const receipt = value.store.admitDarkInboundEvent({
    expectedActivationEpoch: 0,
    queueGeneration: input.queueGeneration ?? 1,
    wakeClass: 'text_user_turn',
    messageRendererGeneration: input.rendererGeneration,
    event: {
      eventId: eventId(input.id),
      worldId: worldId(input.world),
      kind: 'inbound:signal',
      payload: { text: input.content },
      occurredAt: input.time,
      recordedAt: input.time,
    },
    admittedAt: input.time,
  });
  const projection =
    input.project === false
      ? null
      : value.store.createEventMessageProjection({
          sourceEventId: receipt.event.eventId,
          sourceSequence: receipt.event.sequence,
          worldId: receipt.event.worldId,
          rendererGeneration:
            input.projectionRendererGeneration ?? input.rendererGeneration,
          message: {
            role: 'user',
            content: `<incoming>${input.content}</incoming>`,
          },
          createdAt: input.time,
        });
  return { receipt, projection };
}

test('dark pending inspection is bounded, read-only, and activation-gated', () => {
  const value = fixture();
  try {
    const tables = [
      'context_world_events',
      'context_dark_ingress_admissions',
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_effects',
      'context_continuation_advances',
    ];
    const before = Object.fromEntries(
      tables.map((table) => [table, tableCount(value.database, table)]),
    );
    const activation = value.store.getActivationState();
    const coordinator = value.store.getRootCoordinatorState();
    const head = value.store.getContinuationHead();

    assert.deepEqual(
      value.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 1,
        maxEvents: 4,
      }),
      { status: 'empty' },
    );
    assert.deepEqual(
      value.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 1,
        queueGeneration: 1,
        maxEvents: 4,
      }),
      {
        status: 'blocked',
        reason: 'activation_mismatch',
        expectedActivationEpoch: 1,
        actualMode: 'dark',
        actualActivationEpoch: 0,
      },
    );
    assert.throws(
      () =>
        value.store.inspectNextDarkPendingBatch({
          expectedActivationEpoch: 0,
          queueGeneration: 0,
          maxEvents: 1,
        }),
      /queueGeneration must be positive/,
    );
    for (const maxEvents of [0, 1_025]) {
      assert.throws(
        () =>
          value.store.inspectNextDarkPendingBatch({
            expectedActivationEpoch: 0,
            queueGeneration: 1,
            maxEvents,
          }),
        /maxEvents must be between 1 and 1024/,
      );
    }
    assert.deepEqual(
      Object.fromEntries(
        tables.map((table) => [table, tableCount(value.database, table)]),
      ),
      before,
    );
    assert.deepEqual(value.store.getActivationState(), activation);
    assert.deepEqual(value.store.getRootCoordinatorState(), coordinator);
    assert.deepEqual(value.store.getContinuationHead(), head);
  } finally {
    closeFixture(value);
  }
});

test('dark pending inspection never skips an unrenderable frontier', () => {
  const value = fixture();
  try {
    const first = admitPendingFixture(value, {
      id: 'event:pending-frontier-a',
      world: 'world:signal:pending-a',
      rendererGeneration: 7,
      content: 'FRONTIER_A_PRIVATE_CANARY',
      time: 10,
      project: false,
    });
    admitPendingFixture(value, {
      id: 'event:pending-later-b',
      world: 'world:signal:pending-b',
      rendererGeneration: 7,
      content: 'LATER_B_PRIVATE_CANARY',
      time: 11,
    });
    const tables = [
      'context_world_events',
      'context_dark_ingress_admissions',
      'context_event_message_projections',
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_effects',
      'context_continuation_advances',
    ];
    const countsBefore = Object.fromEntries(
      tables.map((table) => [table, tableCount(value.database, table)]),
    );
    const activationBefore = value.store.getActivationState();
    const coordinatorBefore = value.store.getRootCoordinatorState();
    const headBefore = value.store.getContinuationHead();
    const blocked = value.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.deepEqual(blocked, {
      status: 'blocked',
      reason: 'projection_unavailable',
      eventId: first.receipt.event.eventId,
      worldId: first.receipt.event.worldId,
      sourceSequence: first.receipt.event.sequence,
      messageRendererGeneration: 7,
    });
    assert.equal(JSON.stringify(blocked).includes('FRONTIER_A_PRIVATE_CANARY'), false);
    assert.equal(JSON.stringify(blocked).includes('LATER_B_PRIVATE_CANARY'), false);
    assert.deepEqual(
      value.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 2,
        maxEvents: 8,
      }),
      {
        status: 'blocked',
        reason: 'generation_mismatch',
        eventId: first.receipt.event.eventId,
        worldId: first.receipt.event.worldId,
        sourceSequence: first.receipt.event.sequence,
        expectedActivationEpoch: 0,
        actualActivationEpoch: 0,
        expectedQueueGeneration: 2,
        actualQueueGeneration: 1,
      },
    );
    assert.deepEqual(
      Object.fromEntries(
        tables.map((table) => [table, tableCount(value.database, table)]),
      ),
      countsBefore,
    );
    assert.deepEqual(value.store.getActivationState(), activationBefore);
    assert.deepEqual(value.store.getRootCoordinatorState(), coordinatorBefore);
    assert.deepEqual(value.store.getContinuationHead(), headBefore);
  } finally {
    closeFixture(value);
  }

  const wrongRenderer = fixture();
  try {
    const first = admitPendingFixture(wrongRenderer, {
      id: 'event:pending-wrong-renderer',
      world: 'world:signal:pending-wrong-renderer',
      rendererGeneration: 4,
      projectionRendererGeneration: 5,
      content: 'WRONG_RENDERER_PRIVATE_CANARY',
      time: 20,
    });
    assert.deepEqual(
      wrongRenderer.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 1,
        maxEvents: 8,
      }),
      {
        status: 'blocked',
        reason: 'projection_unavailable',
        eventId: first.receipt.event.eventId,
        worldId: first.receipt.event.worldId,
        sourceSequence: first.receipt.event.sequence,
        messageRendererGeneration: 4,
      },
    );
  } finally {
    closeFixture(wrongRenderer);
  }
});

test('dark pending inspection returns only the contiguous same-world renderable prefix', () => {
  const crossWorld = fixture();
  try {
    const a1 = admitPendingFixture(crossWorld, {
      id: 'event:pending-a1',
      world: 'world:signal:pending-prefix-a',
      rendererGeneration: 3,
      content: 'PREFIX_A1_PRIVATE_CANARY',
      time: 30,
    });
    const a2 = admitPendingFixture(crossWorld, {
      id: 'event:pending-a2',
      world: 'world:signal:pending-prefix-a',
      rendererGeneration: 3,
      content: 'PREFIX_A2_PRIVATE_CANARY',
      time: 31,
    });
    const b1 = admitPendingFixture(crossWorld, {
      id: 'event:pending-b1',
      world: 'world:signal:pending-prefix-b',
      rendererGeneration: 3,
      content: 'PREFIX_B1_PRIVATE_CANARY',
      time: 32,
    });
    const a3 = admitPendingFixture(crossWorld, {
      id: 'event:pending-a3',
      world: 'world:signal:pending-prefix-a',
      rendererGeneration: 3,
      content: 'PREFIX_A3_PRIVATE_CANARY',
      time: 33,
    });
    const ready = crossWorld.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.deepEqual(ready, {
      status: 'ready',
      worldId: a1.receipt.event.worldId,
      messageRendererGeneration: 3,
      items: [
        {
          eventId: a1.receipt.event.eventId,
          sourceSequence: a1.receipt.event.sequence,
          projectionId: a1.projection!.projectionId,
        },
        {
          eventId: a2.receipt.event.eventId,
          sourceSequence: a2.receipt.event.sequence,
          projectionId: a2.projection!.projectionId,
        },
      ],
      stopReason: 'world_boundary',
    });
    assert.deepEqual(
      crossWorld.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 1,
        maxEvents: 1,
      }),
      {
        status: 'ready',
        worldId: a1.receipt.event.worldId,
        messageRendererGeneration: 3,
        items: [
          {
            eventId: a1.receipt.event.eventId,
            sourceSequence: a1.receipt.event.sequence,
            projectionId: a1.projection!.projectionId,
          },
        ],
        stopReason: 'limit',
      },
    );
    const serialized = JSON.stringify(ready);
    for (const canary of [
      'PREFIX_A1_PRIVATE_CANARY',
      'PREFIX_A2_PRIVATE_CANARY',
      'PREFIX_B1_PRIVATE_CANARY',
      'PREFIX_A3_PRIVATE_CANARY',
    ]) {
      assert.equal(serialized.includes(canary), false);
    }
    assert.equal(serialized.includes(a1.receipt.event.eventId), true);
    assert.equal(serialized.includes(a2.projection!.projectionId), true);
    assert.equal(serialized.includes(b1.receipt.event.eventId), false);
    assert.equal(serialized.includes(b1.projection!.projectionId), false);
    assert.equal(serialized.includes(a3.receipt.event.eventId), false);
    assert.equal(serialized.includes(a3.projection!.projectionId), false);
  } finally {
    closeFixture(crossWorld);
  }

  const rendererBoundary = fixture();
  try {
    admitPendingFixture(rendererBoundary, {
      id: 'event:pending-renderer-1',
      world: 'world:signal:pending-renderer',
      rendererGeneration: 1,
      content: 'RENDERER_ONE_PRIVATE_CANARY',
      time: 40,
    });
    admitPendingFixture(rendererBoundary, {
      id: 'event:pending-renderer-2',
      world: 'world:signal:pending-renderer',
      rendererGeneration: 2,
      content: 'RENDERER_TWO_PRIVATE_CANARY',
      time: 41,
    });
    const ready = rendererBoundary.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.equal(ready.items.length, 1);
      assert.equal(ready.stopReason, 'renderer_boundary');
    }
  } finally {
    closeFixture(rendererBoundary);
  }

  const generationBoundary = fixture();
  try {
    const first = admitPendingFixture(generationBoundary, {
      id: 'event:pending-generation-1',
      world: 'world:signal:pending-generation',
      rendererGeneration: 2,
      content: 'GENERATION_ONE_PRIVATE_CANARY',
      time: 45,
    });
    generationBoundary.database
      .prepare(
        `INSERT INTO context_dark_ingress_generations(
           queue_generation, first_admissible_sequence, activation_epoch
         ) VALUES (?, ?, ?)`,
      )
      .run(2, 2, 0);
    const second = admitPendingFixture(generationBoundary, {
      id: 'event:pending-generation-2',
      world: 'world:signal:pending-generation',
      rendererGeneration: 2,
      queueGeneration: 2,
      content: 'GENERATION_TWO_PRIVATE_CANARY',
      time: 46,
    });
    const secondId = second.receipt.event.eventId;
    const ready = generationBoundary.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.deepEqual(ready, {
      status: 'ready',
      worldId: first.receipt.event.worldId,
      messageRendererGeneration: 2,
      items: [
        {
          eventId: first.receipt.event.eventId,
          sourceSequence: first.receipt.event.sequence,
          projectionId: first.projection!.projectionId,
        },
      ],
      stopReason: 'generation_boundary',
    });
    assert.equal(JSON.stringify(ready).includes(secondId), false);
  } finally {
    closeFixture(generationBoundary);
  }

  const unavailable = fixture();
  try {
    admitPendingFixture(unavailable, {
      id: 'event:pending-projected',
      world: 'world:signal:pending-unavailable',
      rendererGeneration: 6,
      content: 'PROJECTED_PRIVATE_CANARY',
      time: 50,
    });
    admitPendingFixture(unavailable, {
      id: 'event:pending-unprojected',
      world: 'world:signal:pending-unavailable',
      rendererGeneration: 6,
      content: 'UNPROJECTED_PRIVATE_CANARY',
      time: 51,
      project: false,
    });
    const ready = unavailable.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.equal(ready.items.length, 1);
      assert.equal(ready.stopReason, 'projection_unavailable');
    }
  } finally {
    closeFixture(unavailable);
  }
});

function createPendingAssemblyInputs(
  value: ReturnType<typeof fixture>,
  prefix: string,
) {
  const world = worldId('world:signal:' + prefix);
  createDarkAssemblyInputs(value, world, prefix + '-system');
  const pending = [1, 2, 3].map((number) =>
    admitPendingFixture(value, {
      id: 'event:' + prefix + '-' + number,
      world,
      rendererGeneration: 7,
      content: prefix.toUpperCase() + '_' + number + '_PRIVATE_CANARY',
      time: 30 + number,
    }),
  );
  return { world, pending };
}

function createPendingAttemptFixture(
  value: ReturnType<typeof fixture>,
  prefix: string,
  selected: readonly number[],
) {
  const input = createPendingAssemblyInputs(value, prefix);
  const assembled = assembleDarkLocalBranch({
    store: value.store,
    expectedActivationEpoch: 0,
    expectedHeadRevision: 0,
    worldId: input.world,
    branchId: branchId('branch:' + prefix),
    messageProjectionIds: selected.map(
      (index) => input.pending[index]!.projection!.projectionId,
    ),
    assembledAt: 40,
  });
  return { ...input, assembled };
}

function insertDarkPendingAttempt(
  database: DatabaseSync,
  input: ReturnType<typeof createPendingAttemptFixture> & {
    maxEvents: number;
  },
): void {
  const selected = input.assembled.requestView.view.messageProjectionIds;
  const selectedAdmissions = selected.map((projectionId) => {
    const projection = input.pending.find(
      (item) => item.projection?.projectionId === projectionId,
    );
    assert.ok(projection);
    return projection.receipt.admission;
  });
  database
    .prepare(
      `INSERT INTO context_dark_pending_branch_attempts(
         branch_id, world_id, request_view_id, activation_epoch,
         queue_generation, max_events, selected_count,
         first_source_sequence, last_source_sequence, assembled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.assembled.branch.branchId,
      input.world,
      input.assembled.requestView.requestViewId,
      0,
      1,
      input.maxEvents,
      selectedAdmissions.length,
      selectedAdmissions[0]!.sourceSequence,
      selectedAdmissions[selectedAdmissions.length - 1]!.sourceSequence,
      40,
    );
}

test('dark pending attempts require profile bindings at insert and typed reread', () => {
  const insertValue = fixture();
  try {
    const pending = createPendingAttemptFixture(
      insertValue,
      'pending-binding-insert',
      [0, 1, 2],
    );
    insertValue.database.exec(
      'DROP TRIGGER context_system_profile_request_view_bindings_no_delete',
    );
    insertValue.database
      .prepare(
        'DELETE FROM context_system_profile_request_view_bindings WHERE request_view_id = ?',
      )
      .run(pending.assembled.requestView.requestViewId);
    assert.throws(
      () =>
        insertDarkPendingAttempt(insertValue.database, {
          ...pending,
          maxEvents: 3,
        }),
      /context dark pending branch attempt lacks profile binding/,
    );
    assert.equal(
      tableCount(insertValue.database, 'context_dark_pending_branch_attempts'),
      0,
    );
  } finally {
    closeFixture(insertValue);
  }

  const readValue = fixture();
  try {
    const pending = createPendingAttemptFixture(
      readValue,
      'pending-binding-reread',
      [0, 1, 2],
    );
    insertDarkPendingAttempt(readValue.database, { ...pending, maxEvents: 3 });
    readValue.database.exec(
      'DROP TRIGGER context_system_profile_request_view_bindings_no_delete',
    );
    readValue.database
      .prepare(
        'DELETE FROM context_system_profile_request_view_bindings WHERE request_view_id = ?',
      )
      .run(pending.assembled.requestView.requestViewId);
    assert.throws(
      () =>
        readValue.store.getDarkPendingBranchAttempt(
          pending.assembled.branch.branchId,
        ),
      /stored context dark pending branch attempt lacks profile binding/,
    );
  } finally {
    closeFixture(readValue);
  }
});

test('schema41 refuses an existing unbound dark pending attempt', () => {
  const value = fixture();
  try {
    const pending = createPendingAttemptFixture(
      value,
      'pending-binding-migration',
      [0, 1, 2],
    );
    insertDarkPendingAttempt(value.database, { ...pending, maxEvents: 3 });
    value.database.exec(`
      DROP TRIGGER context_system_profile_request_view_bindings_no_delete;
      DELETE FROM context_system_profile_request_view_bindings
        WHERE request_view_id = '${pending.assembled.requestView.requestViewId}';
      DROP TRIGGER context_dark_pending_branch_attempts_profile_binding_guard;
      DROP TRIGGER context_resident_identity_system_derivations_identity_conflict;
      DROP TRIGGER context_resident_identity_system_derivations_lineage_guard;
      DROP TRIGGER context_resident_identity_system_derivations_no_update;
      DROP TRIGGER context_resident_identity_system_derivations_no_delete;
      DROP TABLE context_resident_identity_system_derivations;
      DROP TRIGGER context_resident_source_candidate_authorizations_identity_conflict;
      DROP TRIGGER context_resident_source_candidate_authorizations_lineage_guard;
      DROP TRIGGER context_resident_source_candidate_authorizations_no_update;
      DROP TRIGGER context_resident_source_candidate_authorizations_no_delete;
      DROP TABLE context_resident_source_candidate_authorizations;
      DROP TRIGGER context_resident_source_inspection_candidates_identity_conflict;
      DROP TRIGGER context_resident_source_inspection_candidates_lineage_guard;
      DROP TRIGGER context_resident_source_inspection_candidates_no_update;
      DROP TRIGGER context_resident_source_inspection_candidates_no_delete;
      DROP TABLE context_resident_source_inspection_candidates;
      DROP TRIGGER context_resident_soul_source_snapshots_identity_conflict;
      DROP TRIGGER context_resident_soul_source_snapshots_no_update;
      DROP TRIGGER context_resident_soul_source_snapshots_no_delete;
      DROP TABLE context_resident_soul_source_snapshots;
      DROP TRIGGER context_scoped_runtime_contract_artifacts_identity_conflict;
      DROP TRIGGER context_scoped_runtime_contract_artifacts_no_delete;
      DROP TRIGGER context_scoped_runtime_contract_artifacts_no_update;
      DROP TABLE context_scoped_runtime_contract_artifacts;
      DROP TRIGGER elpis_migrations_no_delete;
      DELETE FROM elpis_migrations
        WHERE component = 'core'
          AND name IN (
            '0041-context-dark-pending-profile-binding',
            '0042-context-scoped-runtime-contract-artifact',
            '0043-context-resident-source-inspection-candidates',
            '0044-context-resident-source-candidate-authorizations',
            '0045-context-resident-identity-system-derivations'
          );
      PRAGMA user_version = 40;
    `);
    assert.throws(
      () => runMigrations(value.database),
      /existing context dark pending branch attempt lacks profile binding/,
    );
    assert.equal(
      (
        value.database.prepare('PRAGMA user_version').get() as {
          user_version: number;
        }
      ).user_version,
      40,
    );
    assert.equal(
      (
        value.database
          .prepare(
            `SELECT count(*) AS count FROM elpis_migrations
             WHERE component = 'core'
               AND name = '0041-context-dark-pending-profile-binding'`,
          )
          .get() as { count: number }
      ).count,
      0,
    );
  } finally {
    closeFixture(value);
  }
});

test('dark pending attempt receipts bind one non-runnable branch and require abandonment before crash', () => {
  const value = fixture();
  try {
    const pending = createPendingAttemptFixture(
      value,
      'pending-attempt-lifecycle',
      [0, 1, 2],
    );
    insertDarkPendingAttempt(value.database, { ...pending, maxEvents: 3 });
    assert.equal(
      tableCount(value.database, 'context_dark_pending_branch_attempts'),
      1,
    );
    assert.equal(
      tableCount(value.database, 'context_dark_pending_branch_abandonments'),
      0,
    );

    const fourth = admitPendingFixture(value, {
      id: 'event:pending-attempt-lifecycle-4',
      world: pending.world,
      rendererGeneration: 7,
      content: 'PENDING_ATTEMPT_LIFECYCLE_4_PRIVATE_CANARY',
      time: 41,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_manifest_events(
               manifest_id, event_id, world_id, ordinal
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            pending.assembled.manifest.manifestId,
            fourth.receipt.event.eventId,
            pending.world,
            3,
          ),
      /bound request view manifest events are sealed/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_local_branch_request_messages(
               request_view_id, projection_id, world_id, ordinal
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            pending.assembled.requestView.requestViewId,
            fourth.projection!.projectionId,
            pending.world,
            3,
          ),
      /bound request view messages are sealed/,
    );
    const extraLayer = value.store.createSystemLayerProjection({
      kind: 'world_policy',
      visibility: 'world',
      worldId: pending.world,
      rendererGeneration: 4,
      policyGeneration: 3,
      sourceKind: 'synthetic_fixture',
      sourceHash: hashContextBytes('pending-attempt-extra-layer'),
      content: 'PENDING_ATTEMPT_EXTRA_POLICY',
      createdAt: 41,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_local_branch_request_system_layers(
               request_view_id, layer_id, world_id, ordinal
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            pending.assembled.requestView.requestViewId,
            extraLayer.layerId,
            pending.world,
            3,
          ),
      /bound request view system layers are sealed/,
    );

    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_effects(
               effect_id, branch_id, world_id, destination_world_id,
               effect_kind, authority_epoch, payload_json, payload_hash,
               idempotency_key, status, prepared_at, resolved_at,
               observation_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, NULL)`,
          )
          .run(
            'effect:pending-attempt',
            pending.assembled.branch.branchId,
            pending.world,
            pending.world,
            'send',
            pending.assembled.branch.authorityEpoch,
            '{}',
            hashContextBytes('{}'),
            'pending-attempt-effect',
            41,
          ),
      /context dark pending branch cannot issue effects/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_branches
             SET status = 'yielded', ended_at = 41
             WHERE branch_id = ?`,
          )
          .run(pending.assembled.branch.branchId),
      /invalid context dark pending branch transition/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_branches
             SET status = 'crashed', ended_at = 41
             WHERE branch_id = ?`,
          )
          .run(pending.assembled.branch.branchId),
      /invalid context dark pending branch transition/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_dark_pending_branch_abandonments(
               branch_id, abandoned_at, reason
             ) VALUES (?, ?, 'coordinator_recovery')`,
          )
          .run(pending.assembled.branch.branchId, 39),
      /context dark pending branch abandonment lineage is invalid/,
    );

    value.database
      .prepare(
        `INSERT INTO context_dark_pending_branch_abandonments(
           branch_id, abandoned_at, reason
         ) VALUES (?, ?, 'coordinator_recovery')`,
      )
      .run(pending.assembled.branch.branchId, 41);
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_branches
             SET status = 'crashed', ended_at = 40
             WHERE branch_id = ?`,
          )
          .run(pending.assembled.branch.branchId),
      /invalid context dark pending branch transition/,
    );
    value.database
      .prepare(
        `UPDATE context_branches
         SET status = 'crashed', ended_at = 41
         WHERE branch_id = ?`,
      )
      .run(pending.assembled.branch.branchId);
    assert.equal(
      value.store.getBranch(pending.assembled.branch.branchId)?.status,
      'crashed',
    );
    assert.equal(tableCount(value.database, 'context_effects'), 0);
    assert.equal(value.store.getContinuationHead().revision, 0);

    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_dark_pending_branch_attempts
             SET max_events = 4 WHERE branch_id = ?`,
          )
          .run(pending.assembled.branch.branchId),
      /context dark pending branch attempts are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `DELETE FROM context_dark_pending_branch_abandonments
             WHERE branch_id = ?`,
          )
          .run(pending.assembled.branch.branchId),
      /context dark pending branch abandonments are immutable/,
    );
  } finally {
    closeFixture(value);
  }
});

test('dark pending attempt receipts reject branches with inherited effects or capsules', () => {
  const withEffect = fixture();
  try {
    const pending = createPendingAttemptFixture(
      withEffect,
      'pending-attempt-inherited-effect',
      [0, 1, 2],
    );
    withEffect.database
      .prepare(
        `INSERT INTO context_effects(
           effect_id, branch_id, world_id, destination_world_id,
           effect_kind, authority_epoch, payload_json, payload_hash,
           idempotency_key, status, prepared_at, resolved_at,
           observation_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, NULL)`,
      )
      .run(
        'effect:pending-attempt-inherited',
        pending.assembled.branch.branchId,
        pending.world,
        pending.world,
        'send',
        pending.assembled.branch.authorityEpoch,
        '{}',
        hashContextBytes('{}'),
        'pending-attempt-inherited-effect',
        41,
      );
    assert.throws(
      () =>
        insertDarkPendingAttempt(withEffect.database, {
          ...pending,
          maxEvents: 3,
        }),
      /context dark pending branch attempt lineage is invalid/,
    );
    assert.equal(
      tableCount(withEffect.database, 'context_dark_pending_branch_attempts'),
      0,
    );
  } finally {
    closeFixture(withEffect);
  }

  const withCapsule = fixture();
  try {
    const pending = createPendingAttemptFixture(
      withCapsule,
      'pending-attempt-inherited-capsule',
      [0, 1, 2],
    );
    withCapsule.store.createCapsule({
      capsuleId: capsuleId('capsule:pending-attempt-inherited'),
      branchId: pending.assembled.branch.branchId,
      worldId: pending.world,
      kind: 'private',
      viewManifestHash: pending.assembled.manifest.hash,
      sourceRootHash: hashContextBytes('pending-attempt-root'),
      policyGeneration: pending.assembled.manifest.policyGeneration,
      content: { forbidden: 'pre-existing capsule' },
      createdAt: 41,
    });
    assert.throws(
      () =>
        insertDarkPendingAttempt(withCapsule.database, {
          ...pending,
          maxEvents: 3,
        }),
      /context dark pending branch attempt lineage is invalid/,
    );
    assert.equal(
      tableCount(withCapsule.database, 'context_dark_pending_branch_attempts'),
      0,
    );
  } finally {
    closeFixture(withCapsule);
  }
});

test('dark pending attempt receipts reject skipped and non-maximal admitted prefixes', () => {
  const nonMaximal = fixture();
  try {
    const pending = createPendingAttemptFixture(
      nonMaximal,
      'pending-attempt-nonmaximal',
      [0, 1],
    );
    assert.throws(
      () =>
        insertDarkPendingAttempt(nonMaximal.database, {
          ...pending,
          maxEvents: 3,
        }),
      /context dark pending branch attempt lineage is invalid/,
    );
    insertDarkPendingAttempt(nonMaximal.database, {
      ...pending,
      maxEvents: 2,
    });
    assert.equal(
      tableCount(nonMaximal.database, 'context_dark_pending_branch_attempts'),
      1,
    );
  } finally {
    closeFixture(nonMaximal);
  }

  const skipped = fixture();
  try {
    const pending = createPendingAttemptFixture(
      skipped,
      'pending-attempt-skipped',
      [0, 2],
    );
    assert.throws(
      () =>
        insertDarkPendingAttempt(skipped.database, {
          ...pending,
          maxEvents: 2,
        }),
      /context dark pending branch attempt lineage is invalid/,
    );
    assert.equal(
      tableCount(skipped.database, 'context_dark_pending_branch_attempts'),
      0,
    );
  } finally {
    closeFixture(skipped);
  }
});

test('atomic dark pending assembly commits one bounded attempt and recovery makes it retryable', () => {
  const value = fixture();
  try {
    const input = createPendingAssemblyInputs(
      value,
      'pending-atomic-retry',
    );
    const first = assembleNextDarkPendingBranch({
      store: value.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 0,
      queueGeneration: 1,
      maxEvents: 2,
      branchId: branchId('branch:pending-atomic-first'),
      assembledAt: 40,
    });
    assert.equal(first.status, 'assembled');
    if (first.status !== 'assembled') return;
    assert.deepEqual(first.attempt, {
      branchId: first.assembly.branch.branchId,
      worldId: input.world,
      requestViewId: first.assembly.requestView.requestViewId,
      activationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 2,
      selectedCount: 2,
      firstSourceSequence: input.pending[0]!.receipt.admission.sourceSequence,
      lastSourceSequence: input.pending[1]!.receipt.admission.sourceSequence,
      assembledAt: 40,
    });
    assert.deepEqual(first.assembly.request.messages.slice(1), [
      {
        role: 'user',
        content: '<incoming>PENDING-ATOMIC-RETRY_1_PRIVATE_CANARY</incoming>',
      },
      {
        role: 'user',
        content: '<incoming>PENDING-ATOMIC-RETRY_2_PRIVATE_CANARY</incoming>',
      },
    ]);
    assert.equal(
      first.assembly.request.candidateJson.includes(
        'PENDING-ATOMIC-RETRY_3_PRIVATE_CANARY',
      ),
      false,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 1);
    assert.equal(
      tableCount(value.database, 'context_dark_pending_branch_attempts'),
      1,
    );
    assert.equal(value.store.getContinuationHead().revision, 0);

    const recovered = value.store.recoverCoordinatedBranch(41);
    assert.equal(recovered?.uncertainEffects, 0);
    assert.deepEqual(
      value.store.getDarkPendingBranchAbandonment(
        first.assembly.branch.branchId,
      ),
      {
        branchId: first.assembly.branch.branchId,
        abandonedAt: 41,
        reason: 'coordinator_recovery',
      },
    );
    assert.equal(
      value.store.getBranch(first.assembly.branch.branchId)?.status,
      'crashed',
    );
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.getContinuationHead().revision, 0);
    assert.equal(
      tableCount(value.database, 'context_dark_ingress_admissions'),
      3,
    );
    assert.equal(tableCount(value.database, 'context_branch_recoveries'), 1);
    assert.deepEqual(
      materializeLocalBranchRequest({
        store: value.store,
        requestViewId: first.assembly.requestView.requestViewId,
      }),
      first.assembly.request,
    );

    const retry = assembleNextDarkPendingBranch({
      store: value.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 0,
      queueGeneration: 1,
      maxEvents: 2,
      branchId: branchId('branch:pending-atomic-retry'),
      assembledAt: 42,
    });
    assert.equal(retry.status, 'assembled');
    if (retry.status === 'assembled') {
      assert.equal(
        retry.attempt.firstSourceSequence,
        first.attempt.firstSourceSequence,
      );
      assert.equal(
        retry.attempt.lastSourceSequence,
        first.attempt.lastSourceSequence,
      );
      assert.deepEqual(
        retry.assembly.request.messages,
        first.assembly.request.messages,
      );
      value.store.recoverCoordinatedBranch(43);
    }
    assert.equal(
      tableCount(value.database, 'context_dark_pending_branch_attempts'),
      2,
    );
    assert.equal(
      tableCount(value.database, 'context_dark_pending_branch_abandonments'),
      2,
    );
    assert.equal(
      tableCount(value.database, 'context_dark_ingress_admissions'),
      3,
    );
  } finally {
    closeFixture(value);
  }
});

test('atomic dark pending assembly stops at the first world boundary', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:pending-boundary-a');
    const systemLayerProjectionIds = createDarkAssemblyInputs(
      value,
      worldA,
      'pending-boundary-system',
    ).systemLayerProjectionIds;
    admitPendingFixture(value, {
      id: 'event:pending-boundary-a1',
      world: worldA,
      rendererGeneration: 7,
      content: 'PENDING_BOUNDARY_A1_PRIVATE_CANARY',
      time: 31,
    });
    admitPendingFixture(value, {
      id: 'event:pending-boundary-a2',
      world: worldA,
      rendererGeneration: 7,
      content: 'PENDING_BOUNDARY_A2_PRIVATE_CANARY',
      time: 32,
    });
    admitPendingFixture(value, {
      id: 'event:pending-boundary-b1',
      world: 'world:signal:pending-boundary-b',
      rendererGeneration: 7,
      content: 'PENDING_BOUNDARY_B1_PRIVATE_CANARY',
      time: 33,
    });
    const assembled = assembleNextDarkPendingBranch({
      store: value.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 0,
      queueGeneration: 1,
      maxEvents: 8,
      branchId: branchId('branch:pending-world-boundary'),
      systemLayerProjectionIds,
      assembledAt: 40,
    });
    assert.equal(assembled.status, 'assembled');
    if (assembled.status === 'assembled') {
      assert.equal(assembled.attempt.selectedCount, 2);
      assert.equal(
        assembled.assembly.request.candidateJson.includes(
          'PENDING_BOUNDARY_B1_PRIVATE_CANARY',
        ),
        false,
      );
      assert.deepEqual(
        assembled.assembly.request.messages.slice(1).map((item) => item.content),
        [
          '<incoming>PENDING_BOUNDARY_A1_PRIVATE_CANARY</incoming>',
          '<incoming>PENDING_BOUNDARY_A2_PRIVATE_CANARY</incoming>',
        ],
      );
      value.store.recoverCoordinatedBranch(41);
    }
  } finally {
    closeFixture(value);
  }
});

test('atomic dark pending assembly requires a selected profile before reserving', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:pending-profile-missing');
    admitPendingFixture(value, {
      id: 'event:pending-profile-missing',
      world,
      rendererGeneration: 7,
      content: 'PENDING_PROFILE_REQUIRED_CANARY',
      time: 10,
    });
    assert.throws(
      () =>
        assembleNextDarkPendingBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          queueGeneration: 1,
          maxEvents: 4,
          branchId: branchId('branch:pending-profile-missing'),
          assembledAt: 20,
        }),
      /current system profile head not found/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_system_profile_request_view_bindings',
      'context_dark_pending_branch_attempts',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(
      tableCount(value.database, 'context_dark_ingress_admissions'),
      1,
    );
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
  } finally {
    closeFixture(value);
  }
});

test('atomic dark pending assembly returns blockers without reserving a branch', () => {
  const empty = fixture();
  try {
    assert.deepEqual(
      assembleNextDarkPendingBranch({
        store: empty.store,
        expectedActivationEpoch: 0,
        expectedHeadRevision: 0,
        queueGeneration: 1,
        maxEvents: 4,
        branchId: branchId('branch:pending-empty'),
        assembledAt: 1,
      }),
      { status: 'empty' },
    );
    assert.equal(tableCount(empty.database, 'context_branches'), 0);
    assert.equal(
      tableCount(empty.database, 'context_dark_pending_branch_attempts'),
      0,
    );
  } finally {
    closeFixture(empty);
  }

  const unavailable = fixture();
  try {
    admitPendingFixture(unavailable, {
      id: 'event:pending-atomic-unavailable',
      world: 'world:signal:pending-atomic-unavailable',
      rendererGeneration: 7,
      content: 'PENDING_ATOMIC_UNAVAILABLE_PRIVATE_CANARY',
      time: 10,
      project: false,
    });
    const blocked = assembleNextDarkPendingBranch({
      store: unavailable.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 0,
      queueGeneration: 1,
      maxEvents: 4,
      branchId: branchId('branch:pending-unavailable'),
      assembledAt: 11,
    });
    assert.equal(blocked.status, 'blocked');
    if (blocked.status === 'blocked') {
      assert.equal(blocked.reason, 'projection_unavailable');
    }
    assert.equal(tableCount(unavailable.database, 'context_branches'), 0);
    assert.equal(
      tableCount(unavailable.database, 'context_dark_pending_branch_attempts'),
      0,
    );
  } finally {
    closeFixture(unavailable);
  }

  const stale = fixture();
  try {
    const input = createPendingAssemblyInputs(stale, 'pending-atomic-stale');
    assert.throws(
      () =>
        assembleNextDarkPendingBranch({
          store: stale.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 1,
          queueGeneration: 1,
          maxEvents: 2,
          branchId: branchId('branch:pending-stale'),
          assembledAt: 40,
        }),
      StaleContinuationHeadError,
    );
    assert.equal(tableCount(stale.database, 'context_branches'), 0);
    assert.equal(tableCount(stale.database, 'context_manifests'), 0);
    assert.equal(
      tableCount(stale.database, 'context_local_branch_request_views'),
      0,
    );
    assert.equal(
      tableCount(stale.database, 'context_dark_pending_branch_attempts'),
      0,
    );
  } finally {
    closeFixture(stale);
  }
});

test('atomic dark pending assembly rolls back when the attempt receipt fails', () => {
  const value = fixture();
  try {
    const input = createPendingAssemblyInputs(
      value,
      'pending-atomic-attempt-failure',
    );
    assert.throws(
      () =>
        assembleNextDarkPendingBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          queueGeneration: 1,
          maxEvents: 2,
          branchId: branchId('branch:pending-attempt-chronology'),
          assembledAt: 30,
        }),
      /context dark pending branch attempt lineage is invalid/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_dark_pending_branch_attempts',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }

    value.database.exec(
      [
        'CREATE TEMP TRIGGER force_pending_attempt_failure',
        'BEFORE INSERT ON context_dark_pending_branch_attempts',
        'BEGIN',
        "SELECT RAISE(ABORT, 'forced pending attempt failure');",
        'END;',
      ].join('\n'),
    );
    assert.throws(
      () =>
        assembleNextDarkPendingBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          queueGeneration: 1,
          maxEvents: 2,
          branchId: branchId('branch:pending-attempt-failure'),
          assembledAt: 40,
        }),
      /forced pending attempt failure/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_dark_pending_branch_attempts',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(
      tableCount(value.database, 'context_dark_ingress_admissions'),
      3,
    );
  } finally {
    closeFixture(value);
  }
});

test('system layer approvals derive provenance and reject unsafe layers', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:approval-fixture');
    const createLayer = (input: {
      kind: 'runtime_contract' | 'identity' | 'integrated_self' | 'world_policy' | 'legacy_memory';
      visibility: 'global_contract' | 'integrated_self' | 'integrated_self_candidate' | 'world' | 'legacy_mixed';
      worldId: ReturnType<typeof worldId> | null;
      source: string;
      sourceKind: string;
    }) =>
      value.store.createSystemLayerProjection({
        kind: input.kind,
        visibility: input.visibility,
        worldId: input.worldId,
        rendererGeneration: 1,
        policyGeneration: 1,
        sourceKind: input.sourceKind,
        sourceHash: hashContextBytes(input.source),
        content: `content:${input.source}`,
        createdAt: 10,
      });
    const specs = [
      {
        layer: createLayer({ kind: 'runtime_contract', visibility: 'global_contract', worldId: null, source: 'approval-contract', sourceKind: 'authored_scoped_contract' }),
        role: 'scoped_runtime_contract' as const,
        basisRef: 'fixture:contract:v1',
        basisKind: 'authored_scoped_contract',
      },
      {
        layer: createLayer({ kind: 'identity', visibility: 'integrated_self', worldId: null, source: 'approval-identity', sourceKind: 'soul_snapshot' }),
        role: 'identity' as const,
        basisRef: 'fixture:identity:v1',
        basisKind: 'soul_snapshot',
      },
      {
        layer: createLayer({ kind: 'integrated_self', visibility: 'integrated_self', worldId: null, source: 'approval-self-delta', sourceKind: 'accepted_self_delta' }),
        role: 'integrated_self' as const,
        basisRef: 'fixture:self-delta:v1',
        basisKind: 'accepted_self_delta',
      },
      {
        layer: createLayer({ kind: 'world_policy', visibility: 'world', worldId: world, source: 'approval-policy', sourceKind: 'routing_policy' }),
        role: 'world_policy' as const,
        basisRef: 'fixture:routing-policy:v1',
        basisKind: 'routing_policy',
      },
    ];
    const approvals = specs.map((spec, index) =>
      value.store.approveSystemLayer({
        layerId: spec.layer.layerId,
        role: spec.role,
        basisRef: spec.basisRef,
        approvalGeneration: 1,
        approvedAt: 20 + index,
      }),
    );
    approvals.forEach((approval, index) => {
      assert.match(approval.approvalId, /^system-layer-approval:[0-9a-f]{64}$/);
      assert.equal(approval.basisKind, specs[index].basisKind);
      assert.equal(approval.basisHash, specs[index].layer.sourceHash);
      assert.deepEqual(value.store.getSystemLayerApproval(approval.approvalId), approval);
    });
    assert.throws(
      () => value.store.approveSystemLayer({
        layerId: specs[1].layer.layerId,
        role: 'identity',
        basisRef: 'fixture:identity:backdated',
        approvalGeneration: 2,
        approvedAt: 9,
      }),
      /system layer approval predates its layer/,
    );
    assert.deepEqual(
      value.store.approveSystemLayer({
        layerId: specs[1].layer.layerId,
        role: 'identity',
        basisRef: specs[1].basisRef,
        approvalGeneration: 1,
        approvedAt: 21,
      }),
      approvals[1],
    );
    assert.throws(
      () => value.store.approveSystemLayer({
        layerId: specs[1].layer.layerId,
        role: 'identity',
        basisRef: 'fixture:identity:changed',
        approvalGeneration: 1,
        approvedAt: 21,
      }),
      /system layer approval identity conflict/,
    );
    assert.throws(
      () => value.store.approveSystemLayer({
        layerId: specs[1].layer.layerId,
        role: 'identity',
        basisRef: specs[1].basisRef,
        approvalGeneration: 1,
        approvedAt: 99,
      }),
      /system layer approval identity conflict/,
    );
    const unsafe = [
      createLayer({ kind: 'identity', visibility: 'integrated_self_candidate', worldId: null, source: 'approval-candidate', sourceKind: 'soul_snapshot' }),
      createLayer({ kind: 'legacy_memory', visibility: 'legacy_mixed', worldId: null, source: 'approval-legacy', sourceKind: 'authored_scoped_contract' }),
    ];
    for (const layer of unsafe) {
      assert.throws(
        () => value.store.approveSystemLayer({
          layerId: layer.layerId,
          role: 'identity',
          basisRef: 'fixture:unsafe',
          approvalGeneration: 1,
          approvedAt: 30,
        }),
        /system layer approval role does not match layer scope/,
      );
    }
    const wrongSource = createLayer({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      source: 'approval-wrong-source',
      sourceKind: 'synthetic_fixture',
    });
    assert.throws(
      () => value.store.approveSystemLayer({
        layerId: wrongSource.layerId,
        role: 'identity',
        basisRef: 'fixture:wrong-source',
        approvalGeneration: 1,
        approvedAt: 30,
      }),
      /system layer approval role does not match layer scope/,
    );
    const corruptLayer = createLayer({ kind: 'runtime_contract', visibility: 'global_contract', worldId: null, source: 'approval-corrupt', sourceKind: 'authored_scoped_contract' });
    const corruptId = systemLayerApprovalId(`system-layer-approval:${'f'.repeat(64)}`);
    value.database.prepare(
      `INSERT INTO context_system_layer_approvals(
         approval_id, layer_id, approval_role, basis_kind, basis_ref,
         basis_hash, approval_generation, approved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      corruptId,
      corruptLayer.layerId,
      'scoped_runtime_contract',
      'authored_scoped_contract',
      'fixture:corrupt',
      corruptLayer.sourceHash,
      1,
      31,
    );
    assert.throws(
      () => value.store.getSystemLayerApproval(corruptId),
      /stored system layer approval is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

test('system profiles bind exact approvals and advance one append-only world head', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:profile-a');
    const worldB = worldId('world:signal:profile-b');
    const approve = (input: {
      kind: 'runtime_contract' | 'identity' | 'integrated_self' | 'world_policy';
      visibility: 'global_contract' | 'integrated_self' | 'world';
      worldId: ReturnType<typeof worldId> | null;
      sourceKind: 'authored_scoped_contract' | 'soul_snapshot' | 'accepted_self_delta' | 'routing_policy';
      role: 'scoped_runtime_contract' | 'identity' | 'integrated_self' | 'world_policy';
      source: string;
      rendererGeneration?: number;
      policyGeneration?: number;
    }) => {
      const layer = value.store.createSystemLayerProjection({
        kind: input.kind,
        visibility: input.visibility,
        worldId: input.worldId,
        rendererGeneration: input.rendererGeneration ?? 2,
        policyGeneration: input.policyGeneration ?? 3,
        sourceKind: input.sourceKind,
        sourceHash: hashContextBytes(input.source),
        content: `profile:${input.source}`,
        createdAt: 10,
      });
      return value.store.approveSystemLayer({
        layerId: layer.layerId,
        role: input.role,
        basisRef: `fixture:${input.source}`,
        approvalGeneration: 1,
        approvedAt: 20,
      });
    };
    const contract = approve({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      worldId: null,
      sourceKind: 'authored_scoped_contract',
      role: 'scoped_runtime_contract',
      source: 'profile-contract',
    });
    const identity = approve({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      sourceKind: 'soul_snapshot',
      role: 'identity',
      source: 'profile-identity-a',
    });
    const integratedSelf = approve({
      kind: 'integrated_self',
      visibility: 'integrated_self',
      worldId: null,
      sourceKind: 'accepted_self_delta',
      role: 'integrated_self',
      source: 'profile-self',
    });
    const policyA = approve({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldA,
      sourceKind: 'routing_policy',
      role: 'world_policy',
      source: 'profile-policy-a',
    });
    assert.throws(
      () => value.store.createSystemProfile({
        worldId: worldA,
        scopedRuntimeContractApprovalId: contract.approvalId,
        identityApprovalId: identity.approvalId,
        worldPolicyApprovalId: policyA.approvalId,
        createdAt: 19,
      }),
      /system profile scoped_runtime_contract lineage is invalid/,
    );
    const profileA = value.store.createSystemProfile({
      worldId: worldA,
      scopedRuntimeContractApprovalId: contract.approvalId,
      identityApprovalId: identity.approvalId,
      integratedSelfApprovalId: integratedSelf.approvalId,
      worldPolicyApprovalId: policyA.approvalId,
      createdAt: 30,
    });
    assert.match(profileA.profileId, /^system-profile:[0-9a-f]{64}$/);
    assert.equal(profileA.profile.activationEpoch, 0);
    assert.equal(profileA.profile.systemRendererGeneration, 2);
    assert.equal(profileA.profile.policyGeneration, 3);
    assert.deepEqual(value.store.getSystemProfile(profileA.profileId), profileA);
    assert.deepEqual(
      value.store.createSystemProfile({
        worldId: worldA,
        scopedRuntimeContractApprovalId: contract.approvalId,
        identityApprovalId: identity.approvalId,
        integratedSelfApprovalId: integratedSelf.approvalId,
        worldPolicyApprovalId: policyA.approvalId,
        createdAt: 30,
      }),
      profileA,
    );
    assert.throws(
      () => value.store.createSystemProfile({
        worldId: worldA,
        scopedRuntimeContractApprovalId: contract.approvalId,
        identityApprovalId: identity.approvalId,
        integratedSelfApprovalId: integratedSelf.approvalId,
        worldPolicyApprovalId: policyA.approvalId,
        createdAt: 31,
      }),
      /system profile identity conflict/,
    );
    assert.throws(
      () => value.store.advanceSystemProfileHead({
        worldId: worldA,
        expectedRevision: 0,
        expectedProfileId: null,
        profileId: profileA.profileId,
        advancedAt: 29,
      }),
      /invalid context system profile advance/,
    );
    const head1 = value.store.advanceSystemProfileHead({
      worldId: worldA,
      expectedRevision: 0,
      expectedProfileId: null,
      profileId: profileA.profileId,
      advancedAt: 40,
    });
    assert.equal(head1.revision, 1);
    assert.equal(head1.predecessorProfileId, null);

    const identityB = approve({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      sourceKind: 'soul_snapshot',
      role: 'identity',
      source: 'profile-identity-b',
    });
    const profileB = value.store.createSystemProfile({
      worldId: worldA,
      scopedRuntimeContractApprovalId: contract.approvalId,
      identityApprovalId: identityB.approvalId,
      integratedSelfApprovalId: integratedSelf.approvalId,
      worldPolicyApprovalId: policyA.approvalId,
      createdAt: 32,
    });
    assert.throws(
      () => value.store.advanceSystemProfileHead({
        worldId: worldA,
        expectedRevision: 0,
        expectedProfileId: null,
        profileId: profileB.profileId,
        advancedAt: 41,
      }),
      /system profile head is not at revision 0/,
    );
    assert.throws(
      () => value.store.advanceSystemProfileHead({
        worldId: worldA,
        expectedRevision: 1,
        expectedProfileId: profileA.profileId,
        profileId: profileB.profileId,
        advancedAt: 39,
      }),
      /invalid context system profile advance/,
    );
    const head2 = value.store.advanceSystemProfileHead({
      worldId: worldA,
      expectedRevision: 1,
      expectedProfileId: profileA.profileId,
      profileId: profileB.profileId,
      advancedAt: 42,
    });
    assert.deepEqual(
      {
        revision: head2.revision,
        predecessor: head2.predecessorProfileId,
        profile: head2.profileId,
      },
      { revision: 2, predecessor: profileA.profileId, profile: profileB.profileId },
    );
    assert.deepEqual(value.store.getSystemProfile(profileA.profileId), profileA);

    value.database.exec(`
      SAVEPOINT corrupt_old_profile_head;
      DROP TRIGGER context_system_profile_advances_no_update;
      UPDATE context_system_profile_advances
        SET advanced_at = 29
        WHERE world_id = '${worldA}' AND activation_epoch = 0 AND revision = 1;
    `);
    assert.throws(
      () => value.store.getSystemProfileHead(worldA, 0),
      /stored system profile head target is invalid/,
    );
    value.database.exec(`
      ROLLBACK TO corrupt_old_profile_head;
      RELEASE corrupt_old_profile_head;
    `);

    value.database.exec(`
      SAVEPOINT corrupt_latest_profile_head;
      DROP TRIGGER context_system_profile_advances_no_update;
      UPDATE context_system_profile_advances
        SET advanced_at = 39
        WHERE world_id = '${worldA}' AND activation_epoch = 0 AND revision = 2;
    `);
    assert.throws(
      () => value.store.getSystemProfileHead(worldA, 0),
      /stored system profile head chronology is invalid/,
    );
    value.database.exec(`
      ROLLBACK TO corrupt_latest_profile_head;
      RELEASE corrupt_latest_profile_head;
    `);

    value.database.exec(`
      SAVEPOINT corrupt_profile_creation_time;
      DROP TRIGGER context_system_profiles_no_update;
      UPDATE context_system_profiles
        SET created_at = 43
        WHERE profile_id = '${profileB.profileId}';
    `);
    assert.throws(
      () => value.store.getSystemProfileHead(worldA, 0),
      /stored system profile head target is invalid/,
    );
    value.database.exec(`
      ROLLBACK TO corrupt_profile_creation_time;
      RELEASE corrupt_profile_creation_time;
    `);

    const policyB = approve({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldB,
      sourceKind: 'routing_policy',
      role: 'world_policy',
      source: 'profile-policy-b',
    });
    assert.throws(
      () => value.store.createSystemProfile({
        worldId: worldA,
        scopedRuntimeContractApprovalId: contract.approvalId,
        identityApprovalId: identity.approvalId,
        worldPolicyApprovalId: policyB.approvalId,
        createdAt: 50,
      }),
      /system profile world_policy lineage is invalid/,
    );
    const wrongGeneration = approve({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      sourceKind: 'soul_snapshot',
      role: 'identity',
      source: 'profile-identity-wrong-generation',
      rendererGeneration: 4,
    });
    assert.throws(
      () => value.store.createSystemProfile({
        worldId: worldA,
        scopedRuntimeContractApprovalId: contract.approvalId,
        identityApprovalId: wrongGeneration.approvalId,
        createdAt: 51,
      }),
      /system profile identity lineage is invalid/,
    );
    assert.throws(
      () => value.database.prepare(
        `INSERT INTO context_system_profile_advances(
           world_id, activation_epoch, revision, predecessor_profile_id,
           profile_id, advanced_at
         ) VALUES (?, 0, 4, ?, ?, 60)`,
      ).run(worldA, profileA.profileId, profileA.profileId),
      /invalid context system profile advance/,
    );
  } finally {
    closeFixture(value);
  }
});

test('profile bindings seal one exact historical request view', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:bound-profile');
    const sourceEventId = eventId('event:bound-profile');
    value.store.appendWorldEvent({
      eventId: sourceEventId,
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'BOUND_PROFILE_MESSAGE' },
      occurredAt: 1,
      recordedAt: 1,
    });
    const message = value.store.createEventMessageProjection({
      sourceEventId,
      sourceSequence: 1,
      worldId: world,
      rendererGeneration: 2,
      message: { role: 'user', content: '<incoming>BOUND_PROFILE_MESSAGE</incoming>' },
      createdAt: 10,
    });
    const approve = (input: {
      kind: 'runtime_contract' | 'identity' | 'world_policy';
      visibility: 'global_contract' | 'integrated_self' | 'world';
      worldId: ReturnType<typeof worldId> | null;
      sourceKind: 'authored_scoped_contract' | 'soul_snapshot' | 'routing_policy';
      role: 'scoped_runtime_contract' | 'identity' | 'world_policy';
      source: string;
      content: string;
    }) => {
      const layer = value.store.createSystemLayerProjection({
        kind: input.kind,
        visibility: input.visibility,
        worldId: input.worldId,
        rendererGeneration: 2,
        policyGeneration: 3,
        sourceKind: input.sourceKind,
        sourceHash: hashContextBytes(input.source),
        content: input.content,
        createdAt: 10,
      });
      const approval = value.store.approveSystemLayer({
        layerId: layer.layerId,
        role: input.role,
        basisRef: `fixture:${input.source}`,
        approvalGeneration: 1,
        approvedAt: 20,
      });
      return { layer, approval };
    };
    const contract = approve({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      worldId: null,
      sourceKind: 'authored_scoped_contract',
      role: 'scoped_runtime_contract',
      source: 'bound-contract',
      content: 'BOUND_CONTRACT\n',
    });
    const identityA = approve({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      sourceKind: 'soul_snapshot',
      role: 'identity',
      source: 'bound-identity-a',
      content: 'BOUND_IDENTITY_A\n',
    });
    const policy = approve({
      kind: 'world_policy',
      visibility: 'world',
      worldId: world,
      sourceKind: 'routing_policy',
      role: 'world_policy',
      source: 'bound-policy',
      content: 'BOUND_POLICY\n',
    });
    const profileA = value.store.createSystemProfile({
      worldId: world,
      scopedRuntimeContractApprovalId: contract.approval.approvalId,
      identityApprovalId: identityA.approval.approvalId,
      worldPolicyApprovalId: policy.approval.approvalId,
      createdAt: 22,
    });
    value.store.advanceSystemProfileHead({
      worldId: world,
      expectedRevision: 0,
      expectedProfileId: null,
      profileId: profileA.profileId,
      advancedAt: 25,
    });
    const assembly = assembleDarkLocalBranch({
      store: value.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 0,
      worldId: world,
      branchId: branchId('branch:bound-profile'),
      messageProjectionIds: [message.projectionId],
      assembledAt: 40,
    });
    const binding = assembly.profileBinding;
    assert.match(binding.bindingId, /^profile-view-binding:[0-9a-f]{64}$/);
    assert.equal(binding.binding.requestViewHash, assembly.requestView.viewHash);
    assert.equal(binding.binding.profileHash, profileA.profileHash);
    assert.deepEqual(
      value.store.getSystemProfileRequestViewBinding(binding.bindingId),
      binding,
    );
    assert.deepEqual(
      value.store.getSystemProfileRequestViewBindingForView(
        assembly.requestView.requestViewId,
      ),
      binding,
    );
    const materialized = materializeProfileBoundLocalBranchRequest({
      store: value.store,
      bindingId: binding.bindingId,
    });
    assert.equal(materialized.binding.bindingId, binding.bindingId);
    assert.equal(materialized.request.candidateHash, assembly.request.candidateHash);
    assert.deepEqual(
      value.store.createSystemProfileRequestViewBinding({
        requestViewId: assembly.requestView.requestViewId,
        expectedProfileId: profileA.profileId,
        expectedProfileHeadRevision: 1,
        boundAt: 40,
      }),
      binding,
    );
    assert.throws(
      () => value.store.createSystemProfileRequestViewBinding({
        requestViewId: assembly.requestView.requestViewId,
        expectedProfileId: profileA.profileId,
        expectedProfileHeadRevision: 1,
        boundAt: 41,
      }),
      /binding identity conflict/,
    );
    const storedBinding = value.database.prepare(
      `SELECT * FROM context_system_profile_request_view_bindings
       WHERE binding_id = ?`,
    ).get(binding.bindingId) as Record<string, string | number>;
    value.database.exec(`
      SAVEPOINT reject_retroactive_effect_binding;
      DROP TRIGGER context_system_profile_request_view_bindings_no_delete;
      DELETE FROM context_system_profile_request_view_bindings
        WHERE binding_id = '${binding.bindingId}';
    `);
    value.store.prepareEffect({
      effectId: effectId('effect:bound-profile-before-binding'),
      branchId: assembly.branch.branchId,
      worldId: world,
      destinationWorldId: world,
      kind: 'send',
      authorityEpoch: assembly.branch.authorityEpoch,
      payload: { text: 'must not gain a binding retroactively' },
      preparedAt: 40,
    });
    assert.throws(
      () => value.database.prepare(
        `INSERT INTO context_system_profile_request_view_bindings(
           binding_id, request_view_id, world_id, activation_epoch,
           profile_id, profile_head_revision, request_view_hash, profile_hash,
           binding_json, binding_hash, bound_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        storedBinding.binding_id,
        storedBinding.request_view_id,
        storedBinding.world_id,
        storedBinding.activation_epoch,
        storedBinding.profile_id,
        storedBinding.profile_head_revision,
        storedBinding.request_view_hash,
        storedBinding.profile_hash,
        storedBinding.binding_json,
        storedBinding.binding_hash,
        storedBinding.bound_at,
      ),
      /binding lineage is invalid/,
    );
    value.database.exec(`
      ROLLBACK TO reject_retroactive_effect_binding;
      RELEASE reject_retroactive_effect_binding;
    `);
    assert.throws(
      () => value.database.prepare(
        `INSERT OR REPLACE INTO context_system_profile_request_view_bindings(
           binding_id, request_view_id, world_id, activation_epoch,
           profile_id, profile_head_revision, request_view_hash, profile_hash,
           binding_json, binding_hash, bound_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        storedBinding.binding_id,
        storedBinding.request_view_id,
        storedBinding.world_id,
        storedBinding.activation_epoch,
        storedBinding.profile_id,
        storedBinding.profile_head_revision,
        storedBinding.request_view_hash,
        storedBinding.profile_hash,
        storedBinding.binding_json,
        storedBinding.binding_hash,
        storedBinding.bound_at,
      ),
      /binding identity already exists/,
    );
    assert.throws(
      () => value.database.prepare(
        `UPDATE context_system_profile_request_view_bindings
         SET bound_at = bound_at + 1 WHERE binding_id = ?`,
      ).run(binding.bindingId),
      /bindings are immutable/,
    );
    assert.throws(
      () => value.database.prepare(
        `DELETE FROM context_system_profile_request_view_bindings
         WHERE binding_id = ?`,
      ).run(binding.bindingId),
      /bindings are immutable/,
    );
    assert.throws(
      () => value.database.prepare(
        `INSERT INTO context_local_branch_request_system_layers(
           request_view_id, layer_id, world_id, ordinal
         ) VALUES (?, ?, ?, 99)`,
      ).run(
        assembly.requestView.requestViewId,
        contract.layer.layerId,
        world,
      ),
      /bound request view system layers are sealed/,
    );
    assert.throws(
      () => value.database.prepare(
        `INSERT INTO context_local_branch_request_messages(
           request_view_id, projection_id, world_id, ordinal
         ) VALUES (?, ?, ?, 99)`,
      ).run(
        assembly.requestView.requestViewId,
        message.projectionId,
        world,
      ),
      /bound request view messages are sealed/,
    );
    assert.throws(
      () => value.database.prepare(
        `INSERT INTO context_manifest_events(
           manifest_id, event_id, world_id, ordinal
         ) VALUES (?, ?, ?, 99)`,
      ).run(assembly.manifest.manifestId, sourceEventId, world),
      /bound request view manifest events are sealed/,
    );
    assert.throws(
      () => value.database.prepare(
        `INSERT INTO context_manifest_shares(
           manifest_id, grant_id, shared_event_id, destination_world_id, ordinal
         ) VALUES (?, 'share:sealed-fixture', ?, ?, 99)`,
      ).run(assembly.manifest.manifestId, sourceEventId, world),
      /bound request view manifest shares are sealed/,
    );
    const identityB = approve({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      sourceKind: 'soul_snapshot',
      role: 'identity',
      source: 'bound-identity-b',
      content: 'BOUND_IDENTITY_B\n',
    });
    const profileB = value.store.createSystemProfile({
      worldId: world,
      scopedRuntimeContractApprovalId: contract.approval.approvalId,
      identityApprovalId: identityB.approval.approvalId,
      worldPolicyApprovalId: policy.approval.approvalId,
      createdAt: 42,
    });
    value.store.advanceSystemProfileHead({
      worldId: world,
      expectedRevision: 1,
      expectedProfileId: profileA.profileId,
      profileId: profileB.profileId,
      advancedAt: 43,
    });
    assert.deepEqual(
      value.store.getSystemProfileRequestViewBinding(binding.bindingId),
      binding,
    );
    assert.deepEqual(
      value.store.createSystemProfileRequestViewBinding({
        requestViewId: assembly.requestView.requestViewId,
        expectedProfileId: profileA.profileId,
        expectedProfileHeadRevision: 1,
        boundAt: 40,
      }),
      binding,
    );
    assert.equal(
      materializeProfileBoundLocalBranchRequest({
        store: value.store,
        bindingId: binding.bindingId,
      }).request.candidateHash,
      assembly.request.candidateHash,
    );
  } finally {
    closeFixture(value);
  }
});

test('pending recovery rolls abandonment back when crash cannot proceed', () => {
  const value = fixture();
  try {
    const input = createPendingAssemblyInputs(
      value,
      'pending-atomic-recovery-failure',
    );
    const assembled = assembleNextDarkPendingBranch({
      store: value.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 0,
      queueGeneration: 1,
      maxEvents: 2,
      branchId: branchId('branch:pending-recovery-failure'),
      assembledAt: 40,
    });
    assert.equal(assembled.status, 'assembled');
    if (assembled.status !== 'assembled') return;
    assert.throws(
      () => value.store.recoverCoordinatedBranch(39),
      /context dark pending branch abandonment lineage is invalid/,
    );
    assert.equal(
      value.store.getBranch(assembled.assembly.branch.branchId)?.status,
      'running',
    );
    assert.equal(
      value.store.getDarkPendingBranchAbandonment(
        assembled.assembly.branch.branchId,
      ),
      null,
    );
    assert.equal(tableCount(value.database, 'context_branch_recoveries'), 0);

    value.database.exec(
      [
        'CREATE TEMP TRIGGER force_pending_abandonment_failure',
        'BEFORE INSERT ON context_dark_pending_branch_abandonments',
        'BEGIN',
        "SELECT RAISE(ABORT, 'forced pending abandonment failure');",
        'END;',
      ].join('\n'),
    );
    assert.throws(
      () => value.store.recoverCoordinatedBranch(41),
      /forced pending abandonment failure/,
    );
    assert.equal(
      value.store.getBranch(assembled.assembly.branch.branchId)?.status,
      'running',
    );
    assert.equal(
      value.store.getRootCoordinatorState().activeBranchId,
      assembled.assembly.branch.branchId,
    );
    assert.equal(
      value.store.getDarkPendingBranchAbandonment(
        assembled.assembly.branch.branchId,
      ),
      null,
    );
    assert.equal(tableCount(value.database, 'context_branch_recoveries'), 0);
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    closeFixture(value);
  }
});
