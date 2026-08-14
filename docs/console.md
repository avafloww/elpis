# Elpis Console

Elpis Console is a local web interface for observing and interacting with the running agent. It is served by `src/console/server.ts` and synchronized over one WebSocket through `ConsoleHub`.

## Views

- **Thread** — committed messages, streaming assistant work, tool calls, sends, compaction markers, and archived backfill.
- **Context** — the exact next-call request projection, including system segments, messages, and tools.
- **Mind** — searchable work graph with filters, sorting, rendered Markdown, comments, dependencies, reminders, and edit controls.
- **Log dock** — recent structured harness logs and level filters.

The room rail filters the displayed thread without creating separate histories.

## Streaming

Provider deltas reach the browser incrementally. A pending stream is visually distinct from committed history; committed messages replace the pending overlay. Context refreshes only after committed history changes because it represents the next complete request, not partial output.

## Chat ingress

The composer sends a console-provenance person message into the same inbound FIFO as Discord. Enter sends and Shift+Enter inserts a newline. The hub deduplicates client nonces and returns an explicit result.

Console speech does not impersonate Discord and does not bypass the agent loop.

## Context privacy

The Context view can expose system prompts, durable memory, conversation history, and tool schemas. The Thread and Mind views can expose private messages and work. Treat the entire console as a private administrative surface.

The server binds to loopback by default and provides no built-in authentication. For remote access, place an authenticated TLS reverse proxy in front of it.

## Attachments

The server exposes mode-restricted attachment files through a path-contained `/attachments/` route. Known media types may render inline; unknown types download as bytes. Path traversal is rejected.

## Failure isolation

Console bind or client errors are logged but do not stop the agent. The console reads state through the hub and delegates mutations through explicit handlers; it does not directly own the agent's stores.
