import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import {
  ContextGraphStore,
  eventId,
  hashContextBytes,
  worldId,
} from '../src/store/context-graph.js';
import {
  createResidentSourceInspectionRecorder,
  formatResidentSourceInspectionPresentation,
} from '../src/context/resident-source-inspection.js';
import { createResidentSourceCandidateAuthorizer } from '../src/context/resident-source-authorization.js';
import { createResidentIdentitySystemDeriver } from '../src/context/resident-identity-system-derivation.js';
import { createResidentWorldProfileBinder } from '../src/context/resident-world-profile-binding.js';
import { createResidentDarkRequestAssembler } from '../src/context/resident-dark-request-assembly.js';
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
  const authorize = createResidentSourceCandidateAuthorizer({
    store,
    soulPath,
    previewMaxBytes,
    redactForOutput,
    now: () => 200,
  });
  const derive = createResidentIdentitySystemDeriver({
    store,
    soulPath,
    previewMaxBytes,
    redactForOutput,
    now: () => 300,
  });
  const bind = createResidentWorldProfileBinder({
    store,
    previewMaxBytes,
    redactForOutput,
    now: () => 500,
  });
  const assemble = createResidentDarkRequestAssembler({
    store,
    previewMaxBytes,
    redactForOutput,
    now: () => 700,
  });
  return {
    directory,
    database,
    store,
    soulPath,
    inspect,
    authorize,
    derive,
    bind,
    assemble,
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
    authorizations: Number(
      (
        value.database
          .prepare(
            'SELECT count(*) AS n FROM context_resident_source_candidate_authorizations',
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
    assert.deepEqual(rowCounts(value), { snapshots: 1, candidates: 1, authorizations: 0 });
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
    assert.deepEqual(rowCounts(value), { snapshots: 1, candidates: 1, authorizations: 0 });
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
    assert.deepEqual(rowCounts(value), { snapshots: 0, candidates: 0, authorizations: 0 });
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
    assert.deepEqual(rowCounts(value), { snapshots: 0, candidates: 0, authorizations: 0 });
  } finally {
    value.close();
  }
});

function inspectedCandidateId(result: string): string {
  const match = /^candidate_id: (resident-source-candidate:[0-9a-f]{64})$/m.exec(
    result,
  );
  assert.ok(match);
  return match[1];
}

function authorizedSourceId(result: string): string {
  const match =
    /^authorization_id: (resident-source-authorization:[0-9a-f]{64})$/m.exec(
      result,
    );
  assert.ok(match);
  return match[1];
}

function identityDerivationId(result: string): string {
  const match =
    /^derivation_id: (resident-identity-derivation:[0-9a-f]{64})$/m.exec(
      result,
    );
  assert.ok(match);
  return match[1];
}

test('resident source authorization records the exact inspected candidate from a later batch', () => {
  const value = fixture('# Synthetic soul\nsmall exact body\n');
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('10')));
    const result = value.authorize(candidateId, provenance('11'));
    assert.match(
      result,
      /^SOURCE CANDIDATE AUTHORIZED — NOT PROFILED OR ACTIVE/m,
    );
    assert.match(result, new RegExp(`candidate_id: ${candidateId}`));
    assert.match(result, /creates no system-layer approval, profile, branch/);
    assert.deepEqual(rowCounts(value), {
      snapshots: 1,
      candidates: 1,
      authorizations: 1,
    });
    assert.equal(value.authorize(candidateId, provenance('11')), result);
    const authorizationId =
      /^authorization_id: (resident-source-authorization:[0-9a-f]{64})$/m.exec(
        result,
      )?.[1];
    assert.ok(authorizationId);
    assert.equal(
      value.store.getResidentSourceCandidateAuthorization(authorizationId)
        ?.candidateId,
      candidateId,
    );
    const sideEffects = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals,
           (SELECT count(*) FROM context_system_profiles) AS profiles,
           (SELECT count(*) FROM context_branches) AS branches,
           (SELECT count(*) FROM context_effects) AS effects,
           (SELECT count(*) FROM context_continuation_advances) AS advances`,
      )
      .get();
    assert.deepEqual(
      { ...sideEffects },
      { approvals: 0, profiles: 0, branches: 0, effects: 0, advances: 0 },
    );
  } finally {
    value.close();
  }
});

test('resident source authorization rejects the inspection batch and stale current SOUL', () => {
  const value = fixture('# Synthetic soul\nsmall exact body\n');
  try {
    const inspected = value.inspect(provenance('12'));
    const candidateId = inspectedCandidateId(inspected);
    assert.throws(
      () => value.authorize(candidateId, provenance('12')),
      /different assistant batch/,
    );
    fs.writeFileSync(
      value.soulPath,
      '---\nname: Aster\n---\n\n# Changed synthetic soul\n',
    );
    assert.throws(
      () => value.authorize(candidateId, provenance('13')),
      /current exact inspected SOUL source/,
    );
    assert.deepEqual(rowCounts(value), {
      snapshots: 1,
      candidates: 1,
      authorizations: 0,
    });
  } finally {
    value.close();
  }
});

test('resident source authorization rolls back exact receipt presentation failures', () => {
  const value = fixture(
    '# Synthetic soul\n',
    16_384,
    (text) =>
      text.replace(
        'SOURCE CANDIDATE AUTHORIZED',
        '[SECRET REDACTED] AUTHORIZED',
      ),
  );
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('14')));
    assert.throws(
      () => value.authorize(candidateId, provenance('15')),
      /secret redaction would alter it/,
    );
    assert.deepEqual(rowCounts(value), {
      snapshots: 1,
      candidates: 1,
      authorizations: 0,
    });
  } finally {
    value.close();
  }
});

test('resident identity derivation presents an exact receipt and creates no runtime authority', () => {
  const value = fixture('# Synthetic soul\nsmall exact body\n');
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('20')));
    const authorizationId = authorizedSourceId(
      value.authorize(candidateId, provenance('21')),
    );
    const result = value.derive(authorizationId, provenance('22'));
    assert.match(
      result,
      /^AUTHORIZED IDENTITY SYSTEM LAYERS DERIVED — NOT PROFILED OR ACTIVE/m,
    );
    assert.match(result, new RegExp(`authorization_id: ${authorizationId}`));
    assert.match(result, /exactly two immutable worldless system layers/);
    assert.match(result, /creates no profile, world, branch, request view/);
    assert.equal(
      preview(result, 16_384),
      `string(${result.length} chars):\n${result}`,
    );
    const counts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_identity_system_derivations) AS derivations,
           (SELECT count(*) FROM context_system_layer_projections) AS layers,
           (SELECT count(*) FROM context_system_layer_approvals) AS approvals,
           (SELECT count(*) FROM context_system_profiles) AS profiles,
           (SELECT count(*) FROM context_world_events) AS world_events,
           (SELECT count(*) FROM context_branches) AS branches,
           (SELECT count(*) FROM context_effects) AS effects,
           (SELECT count(*) FROM context_continuation_advances) AS advances`,
      )
      .get();
    assert.deepEqual(
      { ...counts },
      {
        derivations: 1,
        layers: 2,
        approvals: 2,
        profiles: 0,
        world_events: 0,
        branches: 0,
        effects: 0,
        advances: 0,
      },
    );
    assert.equal(value.derive(authorizationId, provenance('22')), result);
  } finally {
    value.close();
  }
});

test('resident identity derivation rolls back exact presentation redaction', () => {
  const value = fixture(
    '# Synthetic soul\n',
    16_384,
    (text) =>
      text.replace(
        'AUTHORIZED IDENTITY SYSTEM LAYERS DERIVED',
        '[SECRET REDACTED] IDENTITY SYSTEM LAYERS',
      ),
  );
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('23')));
    const authorizationId = authorizedSourceId(
      value.authorize(candidateId, provenance('24')),
    );
    assert.throws(
      () => value.derive(authorizationId, provenance('25')),
      /secret redaction would alter it/,
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
      { derivations: 0, layers: 0, approvals: 0 },
    );
  } finally {
    value.close();
  }
});

test('resident world profile binding presents an exact dark receipt', () => {
  const value = fixture('# Synthetic soul\nsmall exact body\n');
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('30')));
    const authorizationId = authorizedSourceId(
      value.authorize(candidateId, provenance('31')),
    );
    const derivationId = identityDerivationId(
      value.derive(authorizationId, provenance('32')),
    );
    const targetWorldId = worldId('world:signal:synthetic-binding');
    const ingress = value.store.appendWorldEvent({
      eventId: eventId('event:synthetic-binding'),
      worldId: targetWorldId,
      kind: 'inbound:signal',
      payload: { synthetic: true },
      occurredAt: 400,
      recordedAt: 400,
    });
    const result = value.bind(
      derivationId,
      {
        worldId: targetWorldId,
        eventId: ingress.eventId,
        sequence: ingress.sequence,
      },
      provenance('33'),
    );
    assert.match(
      result,
      /^CURRENT WORLD SYSTEM PROFILE BOUND — DARK AND NON-RUNNABLE/m,
    );
    assert.match(result, new RegExp(`derivation_id: ${derivationId}`));
    assert.match(result, new RegExp(`world_id: ${targetWorldId}`));
    assert.match(result, new RegExp(`ingress_event_id: ${ingress.eventId}`));
    assert.match(result, /creates no branch, request view, provider request/);
    assert.equal(
      preview(result, 16_384),
      `string(${result.length} chars):\n${result}`,
    );
    assert.equal(
      value.bind(
        derivationId,
        {
          worldId: targetWorldId,
          eventId: ingress.eventId,
          sequence: ingress.sequence,
        },
        provenance('33'),
      ),
      result,
    );
    const counts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_world_profile_bindings) AS bindings,
           (SELECT count(*) FROM context_system_profiles) AS profiles,
           (SELECT count(*) FROM context_system_profile_advances) AS heads,
           (SELECT count(*) FROM context_branches) AS branches,
           (SELECT count(*) FROM context_effects) AS effects,
           (SELECT count(*) FROM context_continuation_advances) AS advances`,
      )
      .get();
    assert.deepEqual(
      { ...counts },
      { bindings: 1, profiles: 1, heads: 1, branches: 0, effects: 0, advances: 0 },
    );
  } finally {
    value.close();
  }
});

test('resident world profile binding rolls back exact presentation redaction', () => {
  const value = fixture(
    '# Synthetic soul\n',
    16_384,
    (text) =>
      text.replace(
        'CURRENT WORLD SYSTEM PROFILE BOUND',
        '[SECRET REDACTED] WORLD SYSTEM PROFILE',
      ),
  );
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('34')));
    const authorizationId = authorizedSourceId(
      value.authorize(candidateId, provenance('35')),
    );
    const derivationId = identityDerivationId(
      value.derive(authorizationId, provenance('36')),
    );
    const targetWorldId = worldId('world:discord:synthetic-binding');
    const ingress = value.store.appendWorldEvent({
      eventId: eventId('event:synthetic-binding-redaction'),
      worldId: targetWorldId,
      kind: 'inbound:discord',
      payload: { synthetic: true },
      occurredAt: 400,
      recordedAt: 400,
    });
    assert.throws(
      () =>
        value.bind(
          derivationId,
          {
            worldId: targetWorldId,
            eventId: ingress.eventId,
            sequence: ingress.sequence,
          },
          provenance('37'),
        ),
      /secret redaction would alter it/,
    );
    const counts = value.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM context_resident_world_profile_bindings) AS bindings,
           (SELECT count(*) FROM context_system_profiles) AS profiles,
           (SELECT count(*) FROM context_system_profile_advances) AS heads`,
      )
      .get();
    assert.deepEqual(
      { ...counts },
      { bindings: 0, profiles: 0, heads: 0 },
    );
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

test('resident dark request assembly presents the complete exact candidate', () => {
  const value = fixture('# Synthetic soul\n' + 'x'.repeat(11_000), 16_384);
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('40')));
    const authorizationId = authorizedSourceId(
      value.authorize(candidateId, provenance('41')),
    );
    const derivationId = identityDerivationId(
      value.derive(authorizationId, provenance('42')),
    );
    const targetWorldId = worldId('world:signal:synthetic-dark-request');
    const bindingIngress = value.store.appendWorldEvent({
      eventId: eventId('event:synthetic-dark-request-binding'),
      worldId: targetWorldId,
      kind: 'inbound:signal',
      payload: { text: 'BINDING_ONLY_CANARY' },
      occurredAt: 400,
      recordedAt: 400,
    });
    value.bind(
      derivationId,
      {
        worldId: targetWorldId,
        eventId: bindingIngress.eventId,
        sequence: bindingIngress.sequence,
      },
      provenance('43'),
    );
    const current = value.store.appendWorldEvent({
      eventId: eventId('event:synthetic-dark-request-current'),
      worldId: targetWorldId,
      kind: 'inbound:signal',
      payload: { text: 'EXACT_DARK_REQUEST_CANARY' },
      occurredAt: 600,
      recordedAt: 600,
    });
    value.store.createEventMessageProjection({
      sourceEventId: current.eventId,
      sourceSequence: current.sequence,
      worldId: targetWorldId,
      rendererGeneration: 1,
      message: {
        role: 'user',
        content: '<incoming>EXACT_DARK_REQUEST_CANARY</incoming>',
      },
      createdAt: 600,
    });
    const result = value.assemble(
      {
        worldId: targetWorldId,
        eventId: current.eventId,
        sequence: current.sequence,
      },
      provenance('44'),
    );
    assert.match(
      result,
      /^CURRENT WORLD DARK REQUEST ASSEMBLED — NON-RUNNABLE/m,
    );
    assert.match(result, /PROVIDER-NEUTRAL CANDIDATE JSON/);
    assert.match(result, /EXACT_DARK_REQUEST_CANARY/);
    assert.doesNotMatch(result, /BINDING_ONLY_CANARY/);
    assert.match(result, /NON-RUNNABLE/);
    assert.match(result, /dark, tool-free request candidate only/);
    assert.match(result, /was not sent to a provider/);
    assert.equal(
      preview(result, 16_384),
      `string(${result.length} chars):\n${result}`,
    );
    assert.equal(
      value.assemble(
        {
          worldId: targetWorldId,
          eventId: current.eventId,
          sequence: current.sequence,
        },
        provenance('44'),
      ),
      result,
    );
    assert.equal(
      (
        value.database
          .prepare(
            'SELECT count(*) AS n FROM context_dark_pending_branch_attempts',
          )
          .get() as { n: number }
      ).n,
      1,
    );
    assert.equal(
      (
        value.database
          .prepare('SELECT count(*) AS n FROM context_effects')
          .get() as { n: number }
      ).n,
      0,
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    value.close();
  }
});

test('resident dark request assembly rolls back when redaction changes the exact candidate', () => {
  const value = fixture(
    '# Synthetic soul\n',
    32_768,
    (text) => text.replace('REDACTION_DARK_REQUEST_CANARY', '[SECRET REDACTED]'),
  );
  try {
    const candidateId = inspectedCandidateId(value.inspect(provenance('50')));
    const authorizationId = authorizedSourceId(
      value.authorize(candidateId, provenance('51')),
    );
    const derivationId = identityDerivationId(
      value.derive(authorizationId, provenance('52')),
    );
    const targetWorldId = worldId('world:discord:synthetic-dark-redaction');
    const bindingIngress = value.store.appendWorldEvent({
      eventId: eventId('event:synthetic-dark-redaction-binding'),
      worldId: targetWorldId,
      kind: 'inbound:discord',
      payload: { synthetic: true },
      occurredAt: 400,
      recordedAt: 400,
    });
    value.bind(
      derivationId,
      {
        worldId: targetWorldId,
        eventId: bindingIngress.eventId,
        sequence: bindingIngress.sequence,
      },
      provenance('53'),
    );
    const current = value.store.appendWorldEvent({
      eventId: eventId('event:synthetic-dark-redaction-current'),
      worldId: targetWorldId,
      kind: 'inbound:discord',
      payload: { synthetic: true },
      occurredAt: 600,
      recordedAt: 600,
    });
    value.store.createEventMessageProjection({
      sourceEventId: current.eventId,
      sourceSequence: current.sequence,
      worldId: targetWorldId,
      rendererGeneration: 1,
      message: {
        role: 'user',
        content: '<incoming>REDACTION_DARK_REQUEST_CANARY</incoming>',
      },
      createdAt: 600,
    });
    assert.throws(
      () =>
        value.assemble(
          {
            worldId: targetWorldId,
            eventId: current.eventId,
            sequence: current.sequence,
          },
          provenance('54'),
        ),
      /secret redaction would alter it/,
    );
    for (const table of [
      'context_dark_ingress_admissions',
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_system_profile_request_view_bindings',
      'context_dark_pending_branch_attempts',
    ]) {
      const count = value.database
        .prepare(`SELECT count(*) AS n FROM ${table}`)
        .get() as { n: number };
      assert.equal(count.n, 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    value.close();
  }
});
