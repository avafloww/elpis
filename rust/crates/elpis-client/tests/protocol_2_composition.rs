use std::fs;
use std::os::unix::fs::PermissionsExt;

use elpis_client::{ClientConfig, ClientError, RemoteRunOwner, ResponseEvent, SettlementOutcome};
use elpis_journal::{
    Journal, JournalLimits, PrepareOutcome, PreparedRequest, RequestStatus, StoredRequest,
};
use elpis_protocol::{
    PROTOCOL_VERSION, Request, Response,
    v2::{CompletedEffectReceipt, EffectAmbiguity, EffectAmbiguityReason, EffectBinding},
};
use elpis_transport::{ClientFrame, ExecutorFence, FenceError, ServerFrame};
use serde_json::json;
use tempfile::TempDir;

const EXECUTOR_ID: &str = "executor-composition";
const BOOT_EPOCH: &str = "0123456789abcdef0123456789abcdef";
const CONNECTION_ID: &str = "connection-composition";

fn run(request_id: &str, context_id: &str, generation: u64, run_id: &str) -> Request {
    Request::Run {
        protocol: PROTOCOL_VERSION,
        request_id: request_id.into(),
        context_id: context_id.into(),
        generation,
        run_id: run_id.into(),
        source: "compose_protocol_2()".into(),
        preview_max_bytes: 1024,
    }
}

fn server_frame(seq: u64, request: Request) -> ServerFrame {
    ServerFrame::Request {
        protocol: PROTOCOL_VERSION,
        executor_id: EXECUTOR_ID.into(),
        boot_epoch: BOOT_EPOCH.into(),
        connection_id: CONNECTION_ID.into(),
        seq,
        request,
    }
}

fn binding(
    effect_id: &str,
    request_id: &str,
    context_id: &str,
    generation: u64,
    run_id: &str,
) -> EffectBinding {
    EffectBinding {
        effect_id: effect_id.into(),
        request_id: request_id.into(),
        context_id: context_id.into(),
        generation,
        run_id: run_id.into(),
        call_index: 0,
        capability: "message.send".into(),
        // SHA-256 of the canonical capability request bytes {"body":"ready"}.
        request_sha256: "66affcbba583536a05e3376116651d5dbd366f0a92c9fabb0576bf5b82c37170".into(),
    }
}

fn new_prepared(outcome: PrepareOutcome) -> PreparedRequest {
    match outcome {
        PrepareOutcome::New(prepared) => prepared,
        other => panic!("expected a newly prepared request, got {other:?}"),
    }
}

fn existing_completed(outcome: PrepareOutcome) -> StoredRequest {
    match outcome {
        PrepareOutcome::Existing(stored) if stored.status == RequestStatus::Completed => stored,
        other => panic!("expected a completed request replay, got {other:?}"),
    }
}

fn response_from(frame: &ClientFrame) -> Response {
    match frame {
        ClientFrame::Response { response, .. } => response.as_ref().clone(),
        ClientFrame::Heartbeat { .. } => panic!("stored response decoded as a heartbeat"),
    }
}

#[test]
fn protocol_2_effect_settlement_composes_across_transport_journal_and_client() {
    let temp = TempDir::new().unwrap();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let database = temp.path().join("protocol-2.sqlite3");
    let mut journal = Journal::open(&database, JournalLimits::default()).unwrap();
    let mut fence = ExecutorFence::restore(
        journal
            .fence_checkpoint(EXECUTOR_ID, BOOT_EPOCH, CONNECTION_ID)
            .unwrap(),
    )
    .unwrap();
    let mut owner = RemoteRunOwner::new(EXECUTOR_ID, ClientConfig::new(4, 8, 8).unwrap()).unwrap();

    // The request is durable before ExecutorFence exposes it for dispatch.
    let completed_request = run("request-completed", "context-completed", 1, "run-completed");
    let completed_server_frame = server_frame(1, completed_request.clone());
    let completed_prepared = new_prepared(journal.prepare(&completed_server_frame).unwrap());
    let completed_dispatch = fence
        .accept_server_frame(completed_server_frame.clone())
        .unwrap()
        .expect("a Run frame must dispatch");
    assert_eq!(completed_dispatch.request, completed_request);
    owner.register_run(&completed_dispatch.request).unwrap();

    // "sent" has the canonical unpadded base64url spelling c2VudA and the
    // fixed SHA-256 below. This is a real validated protocol-2 receipt DTO,
    // not an untyped JSON stand-in.
    let completed_receipt = CompletedEffectReceipt {
        binding: binding(
            "2cafb9e58a0b1c7d41eb045af37165a87ea8d713fda19ee2298fa17b2c220eb5",
            "request-completed",
            "context-completed",
            1,
            "run-completed",
        ),
        receipt: "c2VudA".into(),
        receipt_sha256: "7afbb3347fb7252e533d58d99d72d9106fc6fdb3f30df23fa70b764c15ac42c5".into(),
    };
    assert_eq!(completed_receipt.receipt_bytes().unwrap(), b"sent".to_vec());
    let mut completed_response = Response::success(
        "request-completed".into(),
        "completed",
        json!({"value": "accepted"}),
    );
    completed_response.completed_effects = vec![completed_receipt.clone()];
    completed_response.validate().unwrap();

    let completed_client_frame = fence
        .build_response(completed_dispatch.seq, completed_response.clone())
        .unwrap();
    let completed_frame_bytes = completed_client_frame.to_json().unwrap();
    let completed_stored = journal
        .complete(&completed_prepared, &completed_client_frame)
        .unwrap();
    assert_eq!(completed_stored.bytes, completed_frame_bytes);

    // Reopening reconstructs the fence from durable state. The repeated
    // ServerFrame yields only the exact stored ClientFrame bytes: it cannot be
    // exposed as another dispatch and the fence cannot build a second response.
    drop(journal);
    let mut journal = Journal::open(&database, JournalLimits::default()).unwrap();
    let completed_replay = existing_completed(journal.prepare(&completed_server_frame).unwrap());
    let completed_replay = completed_replay.response.unwrap();
    assert_eq!(completed_replay.bytes, completed_frame_bytes);
    let replayed_completed_frame = ClientFrame::from_json(&completed_replay.bytes).unwrap();
    assert_eq!(
        replayed_completed_frame.to_json().unwrap(),
        completed_frame_bytes
    );

    let mut fence = ExecutorFence::restore(
        journal
            .fence_checkpoint(EXECUTOR_ID, BOOT_EPOCH, CONNECTION_ID)
            .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        fence.accept_server_frame(completed_server_frame.clone()),
        Err(FenceError::StaleSequence {
            expected: 2,
            actual: 1,
        })
    ));
    assert!(matches!(
        fence.build_response(1, completed_response.clone()),
        Err(FenceError::AlreadyResponded(1))
    ));

    let replayed_completed_response = response_from(&replayed_completed_frame);
    assert_eq!(replayed_completed_response, completed_response);
    let completed_settlement = match owner
        .accept_response(replayed_completed_response.clone())
        .unwrap()
    {
        ResponseEvent::Settled(settlement) => settlement,
        other => panic!("expected exact settlement, got {other:?}"),
    };
    assert!(!completed_settlement.context_fenced);
    match &completed_settlement.outcome {
        SettlementOutcome::Exact {
            response,
            cancel_response: None,
        } => {
            assert_eq!(response, &completed_response);
            assert_eq!(response.completed_effects, vec![completed_receipt]);
        }
        other => panic!("expected exact effect settlement, got {other:?}"),
    }
    assert_eq!(
        owner.accept_response(replayed_completed_response).unwrap(),
        ResponseEvent::Duplicate
    );

    // A second Run follows the same transport and durable journal path, this
    // time carrying the typed protocol-2 effect ambiguity provenance.
    let ambiguous_request = run("request-ambiguous", "context-ambiguous", 7, "run-ambiguous");
    let ambiguous_server_frame = server_frame(2, ambiguous_request.clone());
    let ambiguous_prepared = new_prepared(journal.prepare(&ambiguous_server_frame).unwrap());
    let ambiguous_dispatch = fence
        .accept_server_frame(ambiguous_server_frame.clone())
        .unwrap()
        .expect("the second Run frame must dispatch");
    assert_eq!(ambiguous_dispatch.request, ambiguous_request);
    owner.register_run(&ambiguous_dispatch.request).unwrap();

    let ambiguous_binding = binding(
        "48c862ca704841ee0c61bcf01a3e4cb732658f66286cb66dda66150fa8563ba1",
        "request-ambiguous",
        "context-ambiguous",
        7,
        "run-ambiguous",
    );
    let mut ambiguous_response = Response::failure(
        Some("request-ambiguous".into()),
        "failed",
        "effect_ambiguous",
        "effect outcome cannot be proven",
    );
    ambiguous_response.ambiguity = Some(EffectAmbiguity {
        binding: ambiguous_binding.clone(),
        reason: EffectAmbiguityReason::CompletionPersistenceFailed,
        may_have_occurred: true,
        context_invalidated: true,
    });
    ambiguous_response.validate().unwrap();

    let ambiguous_client_frame = fence
        .build_response(ambiguous_dispatch.seq, ambiguous_response.clone())
        .unwrap();
    let ambiguous_frame_bytes = ambiguous_client_frame.to_json().unwrap();
    let ambiguous_stored = journal
        .complete(&ambiguous_prepared, &ambiguous_client_frame)
        .unwrap();
    assert_eq!(ambiguous_stored.bytes, ambiguous_frame_bytes);

    drop(journal);
    let mut journal = Journal::open(&database, JournalLimits::default()).unwrap();
    let ambiguous_replay = existing_completed(journal.prepare(&ambiguous_server_frame).unwrap());
    let ambiguous_replay = ambiguous_replay.response.unwrap();
    assert_eq!(ambiguous_replay.bytes, ambiguous_frame_bytes);
    let replayed_ambiguous_frame = ClientFrame::from_json(&ambiguous_replay.bytes).unwrap();
    assert_eq!(
        replayed_ambiguous_frame.to_json().unwrap(),
        ambiguous_frame_bytes
    );
    let replayed_ambiguous_response = response_from(&replayed_ambiguous_frame);

    let ambiguous_settlement = match owner
        .accept_response(replayed_ambiguous_response.clone())
        .unwrap()
    {
        ResponseEvent::Settled(settlement) => settlement,
        other => panic!("expected effect-ambiguous settlement, got {other:?}"),
    };
    assert!(ambiguous_settlement.context_fenced);
    match &ambiguous_settlement.outcome {
        SettlementOutcome::EffectAmbiguous {
            response,
            correlated_response: None,
        } => {
            assert_eq!(response, &ambiguous_response);
            assert_eq!(
                response.ambiguity.as_ref().unwrap().binding,
                ambiguous_binding
            );
            assert_eq!(
                response.ambiguity.as_ref().unwrap().reason,
                EffectAmbiguityReason::CompletionPersistenceFailed
            );
        }
        other => panic!("expected typed effect ambiguity, got {other:?}"),
    }

    assert_eq!(
        owner
            .accept_response(replayed_ambiguous_response.clone())
            .unwrap(),
        ResponseEvent::Duplicate
    );
    let mut contradictory_late_response = replayed_ambiguous_response;
    contradictory_late_response
        .ambiguity
        .as_mut()
        .unwrap()
        .reason = EffectAmbiguityReason::ExecutorLost;
    contradictory_late_response.validate().unwrap();
    assert_eq!(
        owner.accept_response(contradictory_late_response),
        Err(ClientError::ConflictingTerminalResponse)
    );

    // Settlement atomically leaves the context released only after generation
    // 7 is fenced: that generation cannot re-enter, while generation 8 can.
    assert_eq!(owner.fenced_through("context-ambiguous"), Some(7));
    assert!(!owner.is_busy("context-ambiguous"));
    assert_eq!(
        owner.register_run(&run("request-fenced", "context-ambiguous", 7, "run-fenced",)),
        Err(ClientError::Fenced)
    );
    let next_generation = owner
        .register_run(&run(
            "request-next-generation",
            "context-ambiguous",
            8,
            "run-next-generation",
        ))
        .unwrap();
    assert_eq!(next_generation.generation, 8);
    assert!(owner.is_busy("context-ambiguous"));
}
