use elpis_executor::host_exec::{
    CapabilityProfile, HOST_EXEC_CAPABILITY, HostExecError, HostExecRequest, HostExecResult,
    HostExecTermination, MAX_HOST_EXEC_ARG_BYTES, MAX_HOST_EXEC_ARGV_BYTES,
    MAX_HOST_EXEC_ARGV_ITEMS, MAX_HOST_EXEC_RECEIPT_BYTES, MAX_HOST_EXEC_REQUEST_BYTES,
    MAX_HOST_EXEC_STDIN_BYTES, MAX_HOST_EXEC_STREAM_BYTES,
};
use elpis_python::HostCall;

const ENABLED: CapabilityProfile = CapabilityProfile::OwnedPermissive;

#[test]
fn profile_defaults_disabled_and_accepts_only_exact_local_values() {
    assert_eq!(CapabilityProfile::default(), CapabilityProfile::Disabled);
    assert_eq!(
        CapabilityProfile::from_local_config(None),
        Ok(CapabilityProfile::Disabled)
    );
    assert_eq!(
        CapabilityProfile::from_local_config(Some("disabled")),
        Ok(CapabilityProfile::Disabled)
    );
    assert_eq!(
        CapabilityProfile::from_local_config(Some("owned_permissive")),
        Ok(ENABLED)
    );
    for invalid in [
        "",
        "enabled",
        "permissive",
        "owned-permissive",
        "OWNED_PERMISSIVE",
        " owned_permissive",
        "owned_permissive ",
    ] {
        assert_eq!(
            CapabilityProfile::from_local_config(Some(invalid)),
            Err(HostExecError::InvalidProfile),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn profile_allows_one_exact_capability_only_when_enabled() {
    assert_eq!(
        CapabilityProfile::Disabled.authorize(HOST_EXEC_CAPABILITY),
        Err(HostExecError::CapabilityDisabled)
    );
    assert_eq!(ENABLED.authorize(HOST_EXEC_CAPABILITY), Ok(()));
    for capability in [
        "",
        "host.exec",
        "elpis.host",
        "elpis.host.exec.more",
        "ELPIS.HOST.EXEC",
        "elpis.host.exec ",
        "elpis_host_exec",
    ] {
        assert_eq!(
            ENABLED.authorize(capability),
            Err(HostExecError::UnknownCapability)
        );
    }
}

#[test]
fn host_call_conversion_does_not_consult_guest_data_for_profile() {
    let call = HostCall {
        call_index: 42,
        capability: HOST_EXEC_CAPABILITY.into(),
        argv: vec!["printf".into(), "%s".into(), "hello".into()],
        stdin: "input".into(),
    };
    assert_eq!(
        HostExecRequest::from_host_call(CapabilityProfile::Disabled, &call),
        Err(HostExecError::CapabilityDisabled)
    );
    let request = HostExecRequest::from_host_call(ENABLED, &call).unwrap();
    assert_eq!(request.argv(), ["printf", "%s", "hello"]);
    assert_eq!(request.stdin(), "input");
}

#[test]
fn request_denies_unknown_fields_missing_or_malformed_arguments() {
    for body in [
        br#"{}"#.as_slice(),
        br#"{"argv":null}"#,
        br#"{"argv":"echo"}"#,
        br#"{"argv":[1]}"#,
        br#"{"argv":["echo"],"stdin":null}"#,
        br#"{"argv":["echo"],"extra":true}"#,
        br#"{"argv":["echo"],"argv":["again"]}"#,
        br#"{"argv":["echo"]"#,
        &[0xff, 0xfe],
    ] {
        assert_eq!(
            HostExecRequest::decode(ENABLED, HOST_EXEC_CAPABILITY, body),
            Err(HostExecError::MalformedRequest)
        );
    }
    assert_eq!(
        HostExecRequest::decode(ENABLED, HOST_EXEC_CAPABILITY, br#"{"argv":[]}"#),
        Err(HostExecError::EmptyArgv)
    );
}

#[test]
fn request_enforces_every_argument_and_stdin_bound() {
    assert_eq!(
        HostExecRequest::new(vec![String::new()], String::new()),
        Err(HostExecError::EmptyProgram)
    );
    assert!(HostExecRequest::new(vec!["echo".into(), String::new()], String::new()).is_ok());
    // stdin is data, not an OS argument; its UTF-8 bytes may include NUL.
    assert!(HostExecRequest::new(vec!["cat".into()], "a\0b".into()).is_ok());
    assert!(
        HostExecRequest::new(
            vec!["x".repeat(MAX_HOST_EXEC_ARG_BYTES)],
            "x".repeat(MAX_HOST_EXEC_STDIN_BYTES)
        )
        .is_ok()
    );
    assert_eq!(
        HostExecRequest::new(vec![], String::new()),
        Err(HostExecError::EmptyArgv)
    );
    assert_eq!(
        HostExecRequest::new(
            vec!["x".into(); MAX_HOST_EXEC_ARGV_ITEMS + 1],
            String::new()
        ),
        Err(HostExecError::TooManyArguments)
    );
    assert_eq!(
        HostExecRequest::new(vec!["x".repeat(MAX_HOST_EXEC_ARG_BYTES + 1)], String::new()),
        Err(HostExecError::ArgumentTooLarge)
    );
    assert_eq!(
        HostExecRequest::new(vec!["a\0b".into()], String::new()),
        Err(HostExecError::ArgumentContainsNul)
    );
    let aggregate = vec![
        "x".repeat(MAX_HOST_EXEC_ARG_BYTES);
        MAX_HOST_EXEC_ARGV_BYTES / MAX_HOST_EXEC_ARG_BYTES + 1
    ];
    assert_eq!(
        HostExecRequest::new(aggregate, String::new()),
        Err(HostExecError::ArgumentsTooLarge)
    );
    assert_eq!(
        HostExecRequest::new(
            vec!["echo".into()],
            "x".repeat(MAX_HOST_EXEC_STDIN_BYTES + 1)
        ),
        Err(HostExecError::StdinTooLarge)
    );
    assert_eq!(
        HostExecRequest::decode(
            ENABLED,
            HOST_EXEC_CAPABILITY,
            &vec![b' '; MAX_HOST_EXEC_REQUEST_BYTES + 1]
        ),
        Err(HostExecError::RequestTooLarge)
    );

    // Escaping is also included in the canonical effect-request bound.
    let escaping = "\u{1}".repeat(MAX_HOST_EXEC_ARG_BYTES);
    assert_eq!(
        HostExecRequest::new(vec![escaping; 16], String::new()),
        Err(HostExecError::RequestTooLarge)
    );
}

#[test]
fn request_canonicalization_is_deterministic_and_normalizes_optional_stdin() {
    let omitted = HostExecRequest::decode(
        ENABLED,
        HOST_EXEC_CAPABILITY,
        r#" { "argv" : ["echo","🐇"] } "#.as_bytes(),
    )
    .unwrap();
    let reordered = HostExecRequest::decode(
        ENABLED,
        HOST_EXEC_CAPABILITY,
        r#"{"stdin":"","argv":["echo","🐇"]}"#.as_bytes(),
    )
    .unwrap();
    assert_eq!(omitted, reordered);
    assert_eq!(
        omitted.canonical_bytes(),
        "{\"argv\":[\"echo\",\"🐇\"],\"stdin\":\"\"}".as_bytes()
    );
    assert_eq!(omitted.canonical_bytes(), omitted.canonical_bytes());
}

#[test]
fn receipt_has_fixed_bytes_and_roundtrips_binary_streams() {
    let result = HostExecResult::new(
        HostExecTermination::Exited(7),
        vec![0, 0xff, b'a'],
        vec![b'e', b'r', b'r'],
    )
    .unwrap();
    let bytes = result.canonical_receipt_bytes();
    assert_eq!(
        bytes,
        br#"{"termination":{"kind":"exited","value":7},"stdout":"AP9h","stderr":"ZXJy"}"#
    );
    assert_eq!(
        HostExecResult::decode_canonical_receipt(&bytes).unwrap(),
        result
    );
    assert_eq!(result.termination(), HostExecTermination::Exited(7));
    assert_eq!(result.stdout(), [0, 0xff, b'a']);
    assert_eq!(result.stderr(), b"err");

    let signaled = HostExecResult::new(HostExecTermination::Signaled(9), vec![], vec![]).unwrap();
    assert_eq!(
        HostExecResult::decode_canonical_receipt(&signaled.canonical_receipt_bytes()).unwrap(),
        signaled
    );
}

#[test]
fn receipt_rejects_invalid_shapes_encodings_and_noncanonical_json() {
    assert_eq!(
        HostExecResult::decode_canonical_receipt(&vec![b' '; MAX_HOST_EXEC_RECEIPT_BYTES + 1]),
        Err(HostExecError::ReceiptTooLarge)
    );
    for malformed in [
        br#"{}"#.as_slice(),
        br#"{"termination":{"kind":"exited","value":0},"stdout":"","stderr":"","extra":1}"#,
        br#"{"termination":{"kind":"unknown","value":0},"stdout":"","stderr":""}"#,
        br#"{"termination":{"kind":"exited","value":"0"},"stdout":"","stderr":""}"#,
        br#"{"termination":{"kind":"exited","value":0,"extra":1},"stdout":"","stderr":""}"#,
        br#"{"termination":{"kind":"exited","value":0},"stdout":"@@","stderr":""}"#,
        br#"{"termination":{"kind":"exited","value":0},"stdout":"YQ==","stderr":""}"#,
        br#"{"termination":{"kind":"exited","value":0},"stdout":"","stderr":null}"#,
    ] {
        assert!(HostExecResult::decode_canonical_receipt(malformed).is_err());
    }
    let reordered = br#"{"stdout":"","stderr":"","termination":{"kind":"exited","value":0}}"#;
    assert_eq!(
        HostExecResult::decode_canonical_receipt(reordered),
        Err(HostExecError::NonCanonicalReceipt)
    );
    let whitespace = br#"{ "termination":{"kind":"exited","value":0},"stdout":"","stderr":""}"#;
    assert_eq!(
        HostExecResult::decode_canonical_receipt(whitespace),
        Err(HostExecError::NonCanonicalReceipt)
    );
}

#[test]
fn receipt_enforces_termination_and_both_stream_bounds() {
    for termination in [
        HostExecTermination::Exited(-1),
        HostExecTermination::Exited(256),
        HostExecTermination::Signaled(0),
        HostExecTermination::Signaled(128),
    ] {
        assert_eq!(
            HostExecResult::new(termination, vec![], vec![]),
            Err(HostExecError::InvalidTermination)
        );
    }
    let maximum = HostExecResult::new(
        HostExecTermination::Exited(255),
        vec![1; MAX_HOST_EXEC_STREAM_BYTES],
        vec![2; MAX_HOST_EXEC_STREAM_BYTES],
    )
    .unwrap();
    assert_eq!(
        HostExecResult::decode_canonical_receipt(&maximum.canonical_receipt_bytes()).unwrap(),
        maximum
    );
    assert_eq!(
        HostExecResult::new(
            HostExecTermination::Exited(0),
            vec![0; MAX_HOST_EXEC_STREAM_BYTES + 1],
            vec![]
        ),
        Err(HostExecError::StdoutTooLarge)
    );
    assert_eq!(
        HostExecResult::new(
            HostExecTermination::Exited(0),
            vec![],
            vec![0; MAX_HOST_EXEC_STREAM_BYTES + 1]
        ),
        Err(HostExecError::StderrTooLarge)
    );
}
