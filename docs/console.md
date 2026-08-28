# Elpis Console

Elpis Console is the private Preact interface for observing and steering one running resident. `src/console/server.ts` serves a static bundle built from `src/console/client`; `ConsoleHub` synchronizes every view over one same-origin WebSocket. The UI is exported as `ConsoleDashboard` from `src/console/client/dashboard.ts`, backed by the transport-neutral `useConsole(transport)` reducer/action hook. Its bounded transport can only publish connection/frame events and send Console frames.

## Views

- **Thread** — committed messages, streaming assistant work, reasoning and tool cards, sends, compaction markers, room lens, and archived backfill.
- **Context** — the exact next-call request projection with verbatim copy actions.
- **Mind** — grouped proposals and committed work, details, comments, edits, and secretary launch context.
- **Workers** — fixed-template episode status, steering mailbox, and path-free artifact receipts.
- **Secretary** — ephemeral runtime conversations with durable turn history and optional Mind prompt hints.
- **Logs** — a persistent desktop rail and dedicated mobile view over the bounded log tail.

The v2 visual and functional divergences are recorded in `docs/console-v2-adjustments.md`.

## Build

`npm run build` typechecks the Node harness, copies static authored assets, then strictly typechecks the browser client with `tsconfig.console.json` and bundles the standalone entry and its same-origin `/ws` transport through esbuild into stable `dist/console/public/app.js` and `app.css` assets. The design-tool `.dc.html` runtime is not part of production.

## Behavioral invariants

The room rail filters one shared history rather than creating separate conversations. Thread follows growth only while the reader remains near the bottom; scrolling upward reveals `↓ latest`. Archived prepend preserves the visible position. Provider deltas arrive incrementally and committed history replaces the pending stream. Context responses are request-correlated so stale projections cannot repaint the view.

The Thread composer enqueues console-provenance person speech into the same inbound FIFO as Discord. Worker and secretary operations use fixed request-correlated Hub controls. The UI renders unavailable, stale, ambiguous, failed, and empty states honestly instead of inventing fixture data.

## Privacy and isolation

Context may expose system prompts, durable memory, conversation history, and tool schemas. Thread, Mind, worker receipts, secretary history, and logs may expose private work. Treat the entire console as a private administrative surface.

The server binds to loopback by default. Remote access requires an authenticated TLS reverse proxy. Same-origin WebSocket checks, bounded attachment routes, and explicit Hub mutation handlers remain server-owned. Console bind or client failures do not stop the agent.
