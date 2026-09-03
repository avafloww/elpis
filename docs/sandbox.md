# JavaScript sandbox

The resident model receives `run(code)` for action and an on-demand `skill(names)` context loader. Elpis evaluates run code in one persistent `node:vm` context and injects a capability namespace; worker and secretary lanes keep their custom run-only tool sets.

## Persistence

Top-level `let`, `const`, `var`, function, and class declarations are transformed into persistent global bindings. They survive later `run` calls in the same process. The most recent non-`undefined` result is available as `_`.

This is working memory, not durable storage. Write durable state under `DATA_DIR`.

## Execution and limits

- synchronous execution is bounded by `sandbox.sync_timeout_ms`;
- asynchronous work is bounded by `sandbox.async_deadline_ms`;
- work still pending at the async deadline becomes a tracked background future;
- stdout, stderr, logs, and previews are byte-capped;
- subprocesses are tracked per run and terminated or transferred deliberately when work detaches.

`node:vm` is not a security boundary. `elpis.sh`, `elpis.sudo`, filesystem access, and self-editing are intentionally powerful.

## Source transform

The transform provides:

- persistent top-level bindings;
- top-level `await`;
- raw `<<<TAG` heredocs for multiline text;
- parse diagnostics for common delimiter, string, backtick, and TypeScript-in-JavaScript mistakes;
- protection against replacing reserved globals such as `elpis`, `fs`, and `_`.

Heredoc bodies are verbatim. Use `elpis.fill()` when explicit `{{name}}` substitution is needed.

## Core globals

- `elpis.*` — namespaced capabilities;
- `fs` — Node filesystem API;
- `require()` — CommonJS/builtin package loading rooted in the process;
- `process`, `Buffer`, `fetch`, `URL`, Web Crypto, encoders;
- `HARNESS_ROOT`, `DATA_DIR`;
- `console` — captured per-run logging.

Dynamic `import()` is not available inside the VM. Use `require()` for runtime-loaded local CommonJS modules.

## Capability groups

### Files and code

- `elpis.read`, `elpis.grep`, `elpis.edit`, `elpis.fill`; supported read/grep/edit/git entry points interrupt with each nearest unseen `AGENTS.md` scope before access, including lexical and physical parents for file symlinks;
- `elpis.sh`, `elpis.sudo`, `elpis.ssh`;
- `elpis.git`, `elpis.deploy`, `elpis.restart`;
- `elpis.preview`.

### Durable thought and work

- `elpis.remember`, `elpis.memory`;
- `elpis.focus`, `elpis.state`, `elpis.ponder`;
- `elpis.mind`;
- `elpis.schedule`, including `.list()` and `.remove(ref)`.

### Conversation and waiting

- `elpis.channel(ref)` for explicit sends, typing, and self-mute;
- `elpis.inbound` for the current input envelope;
- `elpis.sleep`, `elpis.timeout`;
- `elpis.bg` for detached jobs and futures.

### Network and interaction

- `elpis.search`, `elpis.extract`;
- `elpis.browser` for stateful Playwright sessions;
- `elpis.computer` for the persistent Linux desktop;
- `elpis.watch` for ephemeral image batches;
- `elpis.bsky` for AT Protocol;
- `elpis.motor` for bounded screenshot-to-action control with resident-selected [motor skills](motor-skills.md);
- optional `elpis.llm` for models explicitly opted in with a canonical `tool_tier`; `list()` returns only tier, canonical ref, endpoint model name, provider type, and context size, while `query({ prompt, model, schema? })` performs a fresh isolated call with no resident context or tools;
- optional `elpis.worker` supervision for Mind-rooted workers; a worker sandbox itself receives only its parent-bound `run(code, detail)` tool and workspace allowlist.

### Bare LLM queries

`elpis.llm` exists only in the full resident sandbox and only when at least one canonical model has `tool_tier: weak|medium|strong`. It is absent from core, worker, and secretary surfaces. The model selector accepts an exposed tier or its exact canonical `provider/model` ref.

Every query sends exactly one user message through a boot-created standalone client. It receives no SOUL, MEMORY, history, Mind, social context, provider reasoning replay, cache key, or function tools. The result contains text, sanitized model/provenance/usage fields, and optional validated JSON; it never returns provider endpoints, credentials, request IDs, tool calls, or reasoning fields/items.

A run may make at most four queries and submit at most 128 KiB of normalized query input. Options must be plain own enumerable data properties; proxies, accessors, non-enumerable members, symbols, and unknown keys are rejected before any provider call. Each prompt is limited to 64 KiB, each optional schema to 16 KiB, combined provider input to 80 KiB, and returned text to 64 KiB. OpenAI-compatible and Anthropic calls request at most 4096 output tokens. The Codex subscription transport rejects caller-supplied output-token caps, so that path is bounded instead by a 64 KiB visible-output abort and the same 120-second wall deadline. All paths enforce the visible-output and deadline bounds even if provider cancellation is not cooperative.

Schema mode appends a JSON-only instruction, parses exact JSON, and validates locally with Ajv without coercion, defaults, or property removal. It first clones and deep-freezes plain data-only schema objects without executing proxies, accessors, `toJSON`, functions, or inherited behavior. It accepts a bounded JSON Schema draft-07 subset: all reference keywords and regex-bearing `pattern`/`patternProperties` are rejected, and `format` is treated as an annotation rather than enforced. Invalid model output throws; it is never repaired silently.

### Local extensions

Inhabitant-specific practices belong in trusted `DATA_DIRECTORY/elpis-data/config/extensions/` modules rather than the core sandbox. Loaded APIs appear under `elpis.ext`; see [extensions.md](extensions.md).

The runtime prompt is the canonical exhaustive API reference presented to the inhabitant. New capabilities must update implementation, tests, and that prompt together.

## Outward speech

A `run` result is internal. The inhabitant speaks to people only by calling `elpis.channel(target).send(...)`. This preserves routing and send receipts.

## Turn yielding

`run` accepts an optional exact sandbox alias and one wake: `{ auto: true }`, `{ after: "5m" }`, or `{ at: "<future ISO-8601 with timezone>" }`. Prefer `auto` whenever cadence is uncertain; a fresh classifier-role advisor chooses 1/2/5/10/15/30/45/60 minutes from bounded work state. Explicit `after`/`at` is for concrete timing and may be no more than one hour; longer exact waits use Scheduler. Only a final successful, non-detached run with a valid wake yields. `after` starts after code completes; `at` keeps wall time and continues if it elapses during execution. Omit `wake` while another branch remains active.

## Background work

`elpis.bg.start(cmd)` launches a detached, restart-durable job. Jobs remember their origin room, emit periodic still-running wakes, and emit one terminal wake with status and log tail. Long JavaScript promises that cross the async deadline become process-local futures and cannot survive a harness restart.

## Browser and desktop state

Browser profiles, screenshots, Xauthority, motor traces, and desktop runtime state live under the private data directory. They must never be committed with source.
