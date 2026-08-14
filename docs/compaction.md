# Compaction

Compaction keeps one long-running conversation inside the model's context window without deleting the durable record.

## Trigger

The context tracker compares estimated request tokens with an effective threshold derived from:

- `compaction.trigger_tokens`;
- the provider/model context window;
- `llm.completion_reserve_tokens`.

When history crosses the threshold, the agent starts a background fold. Foreground work can continue while summarization runs.

## Boundary model

A compaction job records the exact message boundary it intends to replace. When the summary returns, the fold applies only if that prefix still matches the live history. Messages added after the boundary remain untouched.

This makes compaction safe under continued conversation: it cannot apply a summary to a different prefix merely because array positions changed.

## Summary contract

The summarizer receives the selected history as a document to condense, not a conversation to continue. The summary must:

- be written in first person as a note from the agent to their future self;
- preserve active commitments, decisions, relationships, corrections, and unresolved work;
- retain routing/privacy boundaries;
- distinguish fact from inference;
- be long enough to carry the selected interval rather than merely acknowledging it.

The instruction appears both before and after the fold body so a long serialized history cannot bury it.

## Quality gates and retries

A candidate is rejected when it is empty, implausibly short, malformed, truncated, or looks like a continuation rather than a summary. Rejections are logged with a reason and retried with bounded backoff.

If no candidate is accepted, the original history remains live and an operator-visible notice reports the failure. A later successful fold clears stale failure state.

## Application

An accepted summary replaces only the selected in-memory prefix. The transcript remains append-only and still contains every original message plus the compaction record. Recent messages and the current open tool chain remain verbatim.

`compaction.keep_tokens` controls how much recent history stays outside the fold.

## Provider paths

Summarization uses the configured provider's supported tool-free completion path. Codex Responses Lite and generic Responses have their own wire transformations; Anthropic and Chat paths follow their native contracts. Summary requests do not expose the ordinary sandbox tool.

## Operational checks

When changing compaction:

- test stale-boundary rejection;
- test concurrent message arrival;
- test summary quality rejection and retry;
- test provider-specific request shape;
- verify transcript preservation;
- verify successful application is visible to the context tracker and console.
