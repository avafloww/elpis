//! Executor-local capability policy and codecs.
//!
//! This crate exposes no transport implementation. Its process handle remains
//! inert until an admitted local service gives it a validated request and exact
//! execution token; capability policy cannot be widened by a Run or peer.

pub mod host_call_service;
pub mod host_exec;
pub mod host_exec_process;
