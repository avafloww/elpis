# Fleet

Fleet is an optional subsystem for bounded coding-worker sessions. A worker is not another copy of the inhabitant: it is a detached task process with explicit scope, durable event history, and a report back into the main agent's one conversation.

## Enable

Set `fleet.enabled: true` and configure the Claude Agent SDK authentication or endpoint described in `config.example.yaml`. When disabled, `elpis.fleet` remains present but throws a clear not-available error.

## Session lifecycle

`elpis.fleet.run(prompt, opts)` creates a registry entry, optional Git worktree, session directory, and detached runner process. It returns immediately with the session identity.

The runner:

- drives one Claude Agent SDK session;
- appends ordered NDJSON events to its session directory;
- serves a local control socket;
- survives harness restarts;
- can be resumed or steered with its SDK session ID;
- emits completion notices into the main history.

The systemd harness unit uses `KillMode=process` so a harness restart does not kill detached runners.

## API

- `run(prompt, opts?)` — start a worker;
- `send(ref, text, opts?)` — steer or revive it;
- `interrupt(ref)` — stop the active worker turn;
- `list()` — list sessions;
- `status(ref)` — detailed state;
- `tail(ref, n?)` — recent durable events;
- `diff(ref, opts?)` — inspect worktree changes;
- `dismiss(ref, opts?)` — retire a session safely.

References accept IDs or unambiguous names. Ambiguity throws rather than selecting silently.

## Worktrees and safety

Repository tasks use isolated Git worktrees by default. Read-only sessions cannot write until explicitly revived with `readOnly: false`; that transition is persisted. Dismissal refuses to strand uncommitted or unmerged changes unless the caller explicitly keeps or discards the worktree.

Use `worktree: false` only when direct work in the provided directory is intentional.

## Models and endpoints

`fleet.models` can remap SDK aliases and optionally pin context windows. `fleet.efforts` defines accepted effort strings. A custom `fleet.base_url` is an Anthropic API root **without** `/v1`; the SDK appends its Messages path.

Fleet credentials and model selection are separate from the main `llm` provider.

## Durable protocol

Runner events are appended to `events.jsonl` and streamed over a local socket. Reconnecting clients subscribe from the last sequence number, allowing gap-free replay. A torn final NDJSON line is skipped rather than making the whole event history unreadable.

Registry and worktree metadata live in `elpis-data/elpis.db`; session files live under `elpis-data/fleet/`.

## Scoped actor server

Scoped actors are a separate native path from the legacy Claude Agent SDK runners. `fleet.actor_server.enabled` is false by default; its default bind is `127.0.0.1:8790`. A non-loopback bind requires an explicit host firewall or NetworkPolicy.

One random control token resolves a server-owned session, actor slug, canonical `model_ref`, and linked Mind root. The actor HTTP surface provides bounded completion, linked-root/descendant Mind operations, and a durable two-way mailbox. Callers cannot submit a route, model, session, actor, mailbox direction, or different Mind root. The database stores only the token digest.

The mailbox is retry-safe and receiver-acknowledged. An actor can pull dispatcher messages, acknowledge them, post progress, and post one terminal finish. Dispatcher-side send/read/ack operations are internal only.

## Delegation boundary

Fleet is appropriate for searches, mechanical edits, test runs, and bounded implementation. The main inhabitant remains responsible for task framing, consequential decisions, review, and what is ultimately committed or said.
