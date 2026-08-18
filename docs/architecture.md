# Architecture

Elpis is one long-lived Node.js process hosting one agent, one ordered conversation history, and one persistent JavaScript sandbox.

## Boot

`src/index.ts` is the composition root. At startup it:

1. loads and validates `config.yaml`;
2. creates the data directory, migrates known legacy state into `elpis-data/`, and opens `elpis-data/elpis.db`;
3. ensures `SOUL.md` and `MEMORY.md` exist;
4. restores the newest transcript with opaque-replay provenance checks;
5. constructs the provider, context tracker, compactor, sandbox, scheduler, Mind, channel directory, optional fleet, console, and Discord adapter;
6. starts the agent loop;
7. delivers restart or optional harness-update notices through the same inbound queue.

A failure in a required persistence or configuration component is a boot failure. Optional surfaces such as the console and fleet degrade independently where their contracts permit it.

## Runtime flow

```text
Discord / console / scheduler / heartbeat / background completion
                            │
                            ▼
                    one inbound FIFO
                            │
                            ▼
                Agent.loop() in src/agent.ts
                    │               │
                    │               └── durable transcript append
                    ▼
           prompt + request assembly
                    │
                    ▼
       provider stream (Responses, Chat, or Messages)
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
  internal assistant work   run(code) tool call
                               │
                               ▼
                     persistent JS sandbox
                               │
                     elpis.* capabilities
                               │
                               ▼
                    tool result + next loop

Only elpis.channel(...).send(...) produces outward speech.
```

The loop is sequential. New messages can queue while work is active, but a second model turn never runs concurrently with the first.

## Main modules

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | dependency construction, boot restoration, services, process guards |
| `src/agent.ts` | inbound FIFO, model/tool loop, turn state, heartbeats, routing, compaction coordination |
| `src/config.ts` | YAML parsing, defaults, validation, path derivation |
| `src/llm/llm.ts` | provider-neutral LLM interface, Chat/Responses selection, request dieting |
| `src/llm/responses.ts` | OpenAI Responses translation and streaming |
| `src/llm/anthropic-client.ts` | Anthropic Messages streaming and thinking-block handling |
| `src/llm/codex-client.ts` | Codex subscription transport and standalone completion lane |
| `src/llm/prompt.ts` | system prompt, identity/memory/people injection, tool documentation |
| `src/llm/compactor.ts` | asynchronous fold scheduling and boundary validation |
| `src/sandbox/index.ts` | VM lifecycle, source transform, timeout/detach behavior |
| `src/sandbox/globals.ts` | `elpis.*` capability namespace and core globals |
| `src/discord/discord.ts` | Discord gateway, ingestion, commands, attachments, reactions |
| `src/console/` | HTTP/WebSocket console and archived-history reader |
| `src/store/` | SQLite and file-backed durable state |
| `src/fleet/` | optional bounded coding-worker sessions |

## Identity and names

The harness does not hardcode an inhabitant.

- The agent name is read from `SOUL.md` YAML frontmatter.
- The operator name comes from `operator.name` in configuration.
- Discord display names and people records are runtime data.
- Missing identity falls back to neutral labels such as `Agent` and `operator`.

## Conversation provenance

Every committed message can carry its source channel. Inbound Discord content is wrapped in a structured envelope containing author, channel, time, reply, forwarding, mention, and attachment metadata. The console, scheduler, heartbeat, and internal notices use reserved provenance labels.

Room provenance controls rendering, moderation, reply targeting, and privacy. It does not create a second agent or a second conversation history.

## Persistence layers

Elpis uses distinct stores for distinct kinds of continuity:

- **Markdown and files:** identity, memory, people, open questions, self-authored notes.
- **JSONL transcripts:** complete ordered message history and provider working-state envelopes.
- **SQLite:** channels, feedback, scheduler, OAuth credentials, mutes, density estimates, fleet, and Mind.
- **process memory:** the active message list and persistent JavaScript bindings.

See [`persistence.md`](persistence.md).

## Provider boundary

`createLLM()` exposes a common completion and streaming contract. Provider adapters retain provider-specific state only where the wire protocol requires it:

- `reasoning_content` for compatible Chat APIs;
- Responses reasoning items with encrypted content;
- Anthropic thinking blocks and signatures.

Opaque state is replayed only across an exact trusted provenance match. It is working state, not durable identity; visible messages and tool history remain usable without it.

## Turn completion

A turn yields only when the final successful, non-detached `run` durably arms a valid one-shot wake. Sending a message does not yield. Tool errors, elapsed absolute targets, and pre-arm preemption continue the turn. An interleaved reply does not complete other active work.

This explicit boundary lets the agent send progress, continue dependent tool work, and choose when it is actually done.

## Autonomous wakes

The same agent loop receives:

- periodic heartbeats;
- due scheduler tasks and Mind reminders;
- background-job progress and completion;
- fleet completion;
- restart and compaction notices.

Synthetic wakes do not masquerade as person-authored input. The turn records whether fresh person input occurred so policies such as external thinking can distinguish them.

## Failure behavior

- Every message is persisted when committed.
- Provider and compaction retries are bounded and observable.
- A failed fold leaves the original history intact.
- Process-level errors are logged and can be delivered to a configured error channel.
- Background subprocesses have explicit lifecycle tracking.
- Console failure does not stop the agent.
- Invalid configuration fails loudly before the bot begins operating.
