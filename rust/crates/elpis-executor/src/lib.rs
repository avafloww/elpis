//! Executor-local capability policy and codecs.
//!
//! This crate deliberately exposes no transport or process execution API. In
//! particular, capability policy is constructed from local executor
//! configuration, not from a Run or a peer-controlled message.

pub mod host_exec;
