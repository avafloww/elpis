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

The guarded summarizer supports an optional synchronous input-admission validator. When `createCompactor` receives a `summaryInputBudget`, it estimates the complete selected-summary-model request before admission: the carried prior summary, recent-history serialization and section wrappers, the tail reminder, `SOCIAL_SUMMARIZE_PROMPT`, plus caller-supplied provider framing or injected-prompt overhead. The caller also supplies that model's context window, output-token reserve, and token estimator. These values deliberately do not reuse the foreground history-density ratio, because the selected summary model can tokenize differently. Invalid numeric budgets fail at construction.

Admission requires the estimated input plus output reserve to fit the selected model's context window. An over-budget input records and logs an observable estimated-budget failure before any model request or quality retry. It does not move the fold boundary, tighten the serialization cap, discard additional history, or produce a replacement summary, so the original history remains live. Without `summaryInputBudget`, behavior is unchanged.

This is an operational estimate, not an exact tokenizer guarantee. Callers should use model-specific estimation and include enough explicit framing overhead for the provider request envelope and any provider-added instructions.

After admission, a candidate is rejected when it is empty, implausibly short, malformed, truncated, or looks like a continuation rather than a summary. Candidate rejections are logged with a reason and retried with bounded backoff.

If no candidate is accepted, the original history remains live and an operator-visible notice reports the failure. A later successful fold clears stale failure state.

## Application

An accepted summary replaces only the selected in-memory prefix. The transcript remains append-only and still contains every original message plus the compaction record. Recent messages and the current open tool chain remain verbatim except for resource-bearing tool results that existed when a fold began: those transient results are excluded from the summary and retained tail, then named in the single compaction notice for deliberate reload. Resource results appended after the fold began remain verbatim.

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
