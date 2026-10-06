import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, runMigrations } from '../src/store/db.js';
import { MindStore } from '../src/store/mind.js';
import {
  resolveSecretarySession,
  secretaryControlTokenDigest,
} from '../src/secretary/session.js';

function replaceWithV23Closure(db: ReturnType<typeof openDatabase>): void {
  const ledgerTriggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='elpis_migrations' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  for (const trigger of ledgerTriggers)
    db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);
  db.exec(`
    DROP TRIGGER context_active_home_branch_obligations_after_request_view_insert;
    DROP TRIGGER context_active_home_branch_obligations_no_update;
    DROP TRIGGER context_active_home_branch_obligations_no_delete;
    DROP TRIGGER context_active_home_provider_invocation_effect_guard;
    DROP TRIGGER context_active_home_provider_invocation_capsule_guard;
    DROP TRIGGER context_active_home_provider_invocation_transition_guard;
    DROP TRIGGER context_active_home_provider_invocation_advance_guard;
    DROP TRIGGER context_active_home_provider_invocation_recovery_guard;
    DROP TRIGGER context_active_home_provider_effect_transition_guard;
      DROP TRIGGER context_active_home_provider_outcomes_no_update;
    DROP TRIGGER context_active_home_provider_outcomes_no_delete;
    DROP TRIGGER context_active_home_provider_outcomes_lineage_guard;
    DROP TABLE context_active_home_provider_outcomes;
    DROP TRIGGER context_active_home_provider_response_evidence_no_update;
    DROP TRIGGER context_active_home_provider_response_evidence_no_delete;
    DROP TRIGGER context_active_home_provider_response_evidence_lineage_guard;
    DROP TABLE context_active_home_provider_response_evidence;
    DROP TRIGGER context_isolated_provider_execution_attempts_active_disjoint_guard;
    DROP TRIGGER context_active_home_provider_execution_attempts_no_update;
    DROP TRIGGER context_active_home_provider_execution_attempts_no_delete;
    DROP TRIGGER context_active_home_provider_execution_attempts_lineage_guard;
    DROP TABLE context_active_home_provider_execution_attempts;
    DROP TRIGGER context_active_home_provider_invocation_admissions_no_update;
    DROP TRIGGER context_active_home_provider_invocation_admissions_no_delete;
    DROP TRIGGER context_active_home_provider_invocation_admissions_lineage_guard;
    DROP TABLE context_active_home_branch_obligations;
    DROP TABLE context_active_home_provider_invocation_admissions;
    DROP TRIGGER context_active_home_ingress_admissions_no_update;
    DROP TRIGGER context_active_home_ingress_admissions_no_delete;
    DROP TRIGGER context_active_home_ingress_admissions_lineage_guard;
    DROP TABLE context_active_home_ingress_admissions;
    DROP TRIGGER context_home_text_speech_finalizations_lineage_guard;
    DROP TRIGGER context_home_text_speech_finalizations_no_update;
    DROP TRIGGER context_home_text_speech_finalizations_no_delete;
    DROP TRIGGER context_home_text_speech_effect_transition_guard;
    DROP TRIGGER context_home_text_continuation_advance_guard;
    DROP TRIGGER context_home_text_continuation_head_guard;
    DROP TRIGGER context_home_text_coordinator_release_guard;
    DROP TRIGGER context_home_text_speech_receipts_no_update;
    DROP TRIGGER context_home_text_speech_receipts_no_delete;
    DROP TRIGGER context_home_text_speech_receipts_lineage_guard;
    DROP TABLE context_home_text_speech_receipts;
    DROP TABLE context_home_text_speech_finalizations;
    DROP TRIGGER context_home_text_result_capsules_no_share;
    DROP TRIGGER context_home_text_speech_attempts_no_update;
    DROP TRIGGER context_home_text_speech_attempts_no_delete;
    DROP TRIGGER context_home_text_speech_attempts_lineage_guard;
    DROP TABLE context_home_text_speech_attempts;
    DROP TRIGGER context_isolated_provider_outcomes_no_update;

    DROP TRIGGER context_isolated_provider_outcomes_no_delete;
    DROP TRIGGER context_isolated_provider_outcomes_lineage_guard;
    DROP TABLE context_isolated_provider_outcomes;
    DROP TRIGGER context_isolated_provider_response_evidence_no_update;
    DROP TRIGGER context_isolated_provider_response_evidence_no_delete;
    DROP TRIGGER context_isolated_provider_response_evidence_lineage_guard;
    DROP TABLE context_isolated_provider_response_evidence;
    DROP TRIGGER context_dark_pending_branch_effect_guard;
    DROP TRIGGER context_dark_pending_branch_transition_guard;
    DROP TRIGGER context_isolated_provider_execution_attempts_no_update;
    DROP TRIGGER context_isolated_provider_execution_attempts_no_delete;
    DROP TRIGGER context_isolated_provider_execution_attempts_lineage_guard;
    DROP TRIGGER context_home_text_activation_scope_lineage_guard;
    DROP TRIGGER context_home_text_activation_scope_no_update;
    DROP TRIGGER context_home_text_activation_scope_no_delete;
    DROP TABLE context_home_text_activation_scope;
    DROP TRIGGER context_isolated_provider_execution_attempts_home_text_guard;
    DROP TABLE context_isolated_provider_execution_attempts;
    CREATE TRIGGER context_dark_pending_branch_effect_guard
      BEFORE INSERT ON context_effects
      WHEN EXISTS (
        SELECT 1 FROM context_dark_pending_branch_attempts
        WHERE branch_id = NEW.branch_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'context dark pending branch cannot issue effects');
      END;
    CREATE TRIGGER context_dark_pending_branch_transition_guard
      BEFORE UPDATE OF status, ended_at ON context_branches
      WHEN EXISTS (
        SELECT 1 FROM context_dark_pending_branch_attempts
        WHERE branch_id = OLD.branch_id
      )
        AND NOT (
          OLD.status = 'running'
          AND NEW.status = 'crashed'
          AND NEW.ended_at IS NOT NULL
          AND NEW.ended_at >= (
            SELECT abandoned_at
            FROM context_dark_pending_branch_abandonments
            WHERE branch_id = OLD.branch_id
          )
          AND EXISTS (
            SELECT 1 FROM context_dark_pending_branch_abandonments
            WHERE branch_id = OLD.branch_id
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid context dark pending branch transition');
      END;
    DROP TRIGGER context_dark_isolated_provider_invocation_admissions_no_update;
    DROP TRIGGER context_dark_isolated_provider_invocation_admissions_no_delete;
    DROP TRIGGER context_dark_isolated_provider_invocation_admissions_lineage_guard;
    DROP TABLE context_dark_isolated_provider_invocation_admissions;
    DROP TRIGGER context_dark_isolated_provider_binding_order_no_update;
    DROP TRIGGER context_dark_isolated_provider_binding_order_no_delete;
    DROP TRIGGER context_dark_isolated_provider_bindings_append_order;
    DROP TABLE context_dark_isolated_provider_binding_order;
    DROP TRIGGER context_dark_isolated_provider_bindings_conflict_guard;
    DROP TRIGGER context_dark_isolated_provider_bindings_lineage_guard;
    DROP TRIGGER context_dark_isolated_provider_bindings_no_update;
    DROP TRIGGER context_dark_isolated_provider_bindings_no_delete;
    DROP TABLE context_dark_isolated_provider_bindings;
    DROP TRIGGER context_resident_world_profile_bindings_identity_conflict;
    DROP TRIGGER context_resident_world_profile_bindings_lineage_guard;
    DROP TRIGGER context_resident_world_profile_bindings_no_update;
    DROP TRIGGER context_resident_world_profile_bindings_no_delete;
    DROP TABLE context_resident_world_profile_bindings;
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
    DROP TRIGGER context_dark_pending_branch_effect_guard;
    DROP TRIGGER context_dark_pending_branch_capsule_guard;
    DROP TRIGGER context_dark_pending_branch_transition_guard;
    DROP TRIGGER context_dark_pending_branch_request_messages_sealed;
    DROP TRIGGER context_dark_pending_branch_system_layers_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_events_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_shares_sealed;
    DROP TABLE context_dark_pending_branch_abandonments;
    DROP TABLE context_dark_pending_branch_attempts;
    DROP TABLE context_dark_ingress_admissions;
    DROP TABLE context_dark_ingress_generations;
    DROP TRIGGER context_bound_request_view_system_layers_sealed;
    DROP TRIGGER context_bound_request_view_messages_sealed;
    DROP TRIGGER context_bound_request_view_manifest_events_sealed;
    DROP TRIGGER context_bound_request_view_manifest_shares_sealed;
    DROP TABLE context_scoped_runtime_contract_artifacts;
    DROP TABLE context_system_profile_request_view_bindings;
    DROP TABLE context_local_branch_request_messages;
    DROP TABLE context_local_branch_request_system_layers;
    DROP TABLE context_local_branch_request_views;
    DROP TABLE context_system_profile_advances;
    DROP TABLE context_system_profiles;
    DROP TABLE context_system_layer_approvals;
    DROP TABLE context_system_layer_projections;

    DROP TABLE context_event_message_projections;
    DROP TABLE context_shadow_request_observations;
    DROP TABLE context_shadow_projection_plans;
    DROP TABLE context_branch_recoveries;
    DROP TABLE context_root_coordinator;
    DROP TABLE context_branch_starts;
    DROP INDEX context_branches_single_running_idx;
    DROP TABLE context_manifest_shares;
    DROP TABLE context_manifest_events;
    DROP TABLE context_capsule_edges;
    DROP TABLE context_legacy_import_receipts;
    DROP TABLE context_effects;
    DROP TABLE context_continuation_advances;
    DROP TABLE context_continuation_head;
    DROP TABLE context_graph_activation;
    DROP TABLE context_share_grants;
    DROP TABLE context_capsules;
    DROP TABLE context_manifests;
    DROP TABLE context_branches;
    DROP TABLE context_world_events;
    DROP INDEX worker_sessions_completion_pending_idx;
    DROP INDEX worker_sessions_cleanup_pending_idx;
    ALTER TABLE worker_sessions DROP COLUMN completion_notified_at;
    ALTER TABLE worker_sessions DROP COLUMN runtime_cleanup_completed_at;
    ALTER TABLE worker_sessions DROP COLUMN runtime_cleanup_error;
    DROP TRIGGER gateway_resident_state_identity_no_update;
    DROP TRIGGER gateway_resident_state_no_delete;
    DROP TRIGGER gateway_resident_state_binding_no_update;
    DROP TRIGGER gateway_resident_state_transition_guard;
    DROP TABLE discord_person_settings;
    DROP TABLE gateway_resident_state;
    DROP TABLE secretary_turns;
    DROP TABLE secretary_sessions;

    CREATE TABLE secretary_sessions (
      id TEXT PRIMARY KEY,
      root_mind_id TEXT NOT NULL REFERENCES mind_items(id) ON DELETE RESTRICT,
      status TEXT NOT NULL,
      model_ref TEXT NOT NULL,
      runtime TEXT NOT NULL,
      control_token_digest TEXT NOT NULL UNIQUE,
      pod_name TEXT,
      pod_uid TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_error TEXT
    );
    CREATE UNIQUE INDEX secretary_sessions_active_root_idx
      ON secretary_sessions(root_mind_id)
      WHERE status IN ('starting','ready');
    CREATE INDEX secretary_sessions_status_idx
      ON secretary_sessions(status, created_at);
    CREATE TRIGGER secretary_sessions_identity_no_update
      BEFORE UPDATE OF id, root_mind_id, model_ref, runtime, control_token_digest
      ON secretary_sessions BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_sessions_status_transition_guard
      BEFORE UPDATE OF status ON secretary_sessions BEGIN SELECT 1; END;

    CREATE TABLE secretary_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES secretary_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claimed_at INTEGER,
      completed_at INTEGER,
      last_error TEXT,
      UNIQUE(session_id, sequence)
    );
    CREATE UNIQUE INDEX secretary_turns_active_session_idx
      ON secretary_turns(session_id)
      WHERE status IN ('queued','claimed');
    CREATE INDEX secretary_turns_session_sequence_idx
      ON secretary_turns(session_id, sequence);
    CREATE INDEX secretary_turns_status_idx
      ON secretary_turns(status, updated_at);
    CREATE TRIGGER secretary_turns_identity_no_update
      BEFORE UPDATE OF id, session_id, sequence, request_json, created_at
      ON secretary_turns BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_turns_status_transition_guard
      BEFORE UPDATE OF status ON secretary_turns BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_turns_pristine_insert_guard
      BEFORE INSERT ON secretary_turns WHEN 0 BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_sessions_settle_turns_before_terminal
      BEFORE UPDATE OF status ON secretary_sessions BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_turns_lifecycle_update_guard
      BEFORE UPDATE ON secretary_turns WHEN 0 BEGIN SELECT 1; END;

    PRAGMA user_version=23;
  `);
  db.prepare(
    "DELETE FROM elpis_migrations WHERE component='core' AND name IN ('0024-global-secretary-authority','0025-gateway-resident-state','0026-gateway-rotation-proposal-checkpoint','0027-discord-person-settings','0028-worker-completion-delivery','0029-context-graph-dark-store','0030-context-root-coordinator','0031-context-shadow-projections','0032-context-event-message-projections','0033-context-system-layer-projections','0034-context-local-branch-request-views','0035-context-dark-ingress-admissions','0036-context-dark-pending-branch-attempts','0037-context-system-layer-approvals','0038-context-system-layer-approval-sources','0039-context-system-profiles','0040-context-system-profile-request-view-bindings','0041-context-dark-pending-profile-binding','0042-context-scoped-runtime-contract-artifact','0043-context-resident-source-inspection-candidates','0044-context-resident-source-candidate-authorizations', '0045-context-resident-identity-system-derivations', '0046-context-resident-world-profile-bindings','0047-context-dark-isolated-provider-bindings','0048-context-dark-isolated-provider-binding-order','0049-context-dark-isolated-provider-invocation-admissions','0050-context-isolated-provider-execution-ledger', '0051-context-home-text-activation-scope', '0052-context-home-text-request-scope', '0053-context-home-text-speech-attempts', '0054-context-home-text-speech-delivery', '0055-context-active-home-ingress-admissions', '0056-context-active-home-provider-invocation-admissions', '0057-context-active-home-provider-execution-ledger')",
  ).run();
  for (const trigger of ledgerTriggers) db.exec(trigger.sql);
}

test('v24 preserves v23 session and turn history while converting root to optional hint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-v24-'));
  const db = openDatabase(dir);
  const mind = new MindStore(db);
  const root = mind.create({ title: 'legacy exact root' });
  replaceWithV23Closure(db);

  const sessionId = 'sec-' + 'm'.repeat(22);
  const turnId = 'stn-' + 'n'.repeat(22);
  const token = 'z'.repeat(43);
  const request = JSON.stringify({ role: 'user', content: 'legacy question' });
  const response = JSON.stringify({
    role: 'assistant',
    content: 'legacy durable answer',
  });
  db.prepare(
    `INSERT INTO secretary_sessions
       (id,root_mind_id,status,model_ref,runtime,control_token_digest,
        pod_name,pod_uid,created_at,updated_at,last_error)
     VALUES (?,?,'closed','p/secretary','kubernetes',?,'pod-old','uid-old',10,20,NULL)`,
  ).run(sessionId, root.id, secretaryControlTokenDigest(token));
  db.prepare(
    `INSERT INTO secretary_turns
       (id,session_id,sequence,status,request_json,response_json,
        created_at,updated_at,claimed_at,completed_at,last_error)
     VALUES (?,?,1,'completed',?,?,11,19,12,19,NULL)`,
  ).run(turnId, sessionId, request, response);

  runMigrations(db);

  const session = db
    .prepare('SELECT * FROM secretary_sessions WHERE id=?')
    .get(sessionId) as Record<string, unknown>;
  assert.equal(session.hint_mind_id, root.id);
  assert.equal(Object.hasOwn(session, 'root_mind_id'), false);
  assert.equal(session.status, 'closed');
  assert.equal(session.pod_name, 'pod-old');
  assert.equal(session.pod_uid, 'uid-old');
  const turn = db
    .prepare('SELECT * FROM secretary_turns WHERE id=?')
    .get(turnId) as Record<string, unknown>;
  assert.equal(turn.session_id, sessionId);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.request_json, request);
  assert.equal(turn.response_json, response);
  assert.equal(turn.claimed_at, 12);
  assert.equal(turn.completed_at, 19);
  assert.equal(
    resolveSecretarySession(db, token),
    null,
    'closed token stays revoked',
  );
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    57,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM elpis_migrations WHERE component='core' AND name='0024-global-secretary-authority'",
        )
        .get() as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('secretary_turns_v23','secretary_sessions_v22')",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
