//! Executor-local capability policy and codecs.
//!
//! This crate exposes no transport or process-spawning implementation. Its
//! ledger-gated host service accepts only an injected synchronous runner, and
//! capability policy is constructed from local executor configuration rather
//! than from a Run or a peer-controlled message.

pub mod host_call_service;
pub mod host_exec;
