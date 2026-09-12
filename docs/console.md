# Elpis Console

Elpis Console is the private Preact interface for observing and steering one running resident. `src/console/server.ts` serves a static bundle built from `src/console/client`; `ConsoleHub` synchronizes every view over one same-origin WebSocket. The UI is exported as `ConsoleDashboard` from `src/console/client/dashboard.ts`, backed by the transport-neutral `useConsole(transport)` reducer/action hook. Its bounded transport can only publish connection/frame events and send Console frames.

## Views

- **Thread** — committed messages, streaming assistant work, reasoning and tool cards, sends, compaction markers, room lens, and archived backfill.
- **Context** — the exact next-call request projection with verbatim copy actions.
- **Mind** — grouped proposals and committed work, details, comments, edits, and secretary launch context.
- **Workers** — fixed-template episode status, steering mailbox, and path-free artifact receipts.
- **Secretary** — ephemeral runtime conversations with durable turn history and optional Mind prompt hints.
- **Logs** — a persistent desktop rail and dedicated mobile view over the bounded log tail.

The v2 visual and functional divergences are recorded in `docs/console-v2-adjustments.md`. The optional [Elpis Gateway](gateway.md) reuses this same dashboard and reducer over a bounded selected-resident transport; it does not maintain a copied Console implementation.

## Build

`npm run build` typechecks the Node harness, copies static authored assets, then strictly typechecks the browser client with `tsconfig.console.json` and bundles the standalone entry and its same-origin `/ws` transport through esbuild into stable `dist/console/public/app.js` and `app.css` assets. The design-tool `.dc.html` runtime is not part of production.

## Behavioral invariants

The room rail filters one shared history rather than creating separate conversations. Thread follows growth only while the reader remains near the bottom; scrolling upward reveals `↓ latest`. Archived prepend preserves the visible position. Provider deltas arrive incrementally and committed history replaces the pending stream. Context responses are request-correlated so stale projections cannot repaint the view.

The Thread composer enqueues console-provenance person speech into the same inbound FIFO as Discord. Worker and secretary operations use fixed request-correlated Hub controls. The UI renders unavailable, stale, ambiguous, failed, and empty states honestly instead of inventing fixture data.

Connected viewers receive incremental `sync` frames for worker and Secretary sessions, Mind items, metadata, room state, and usage. Collection patches carry changed records by stable ID plus their authoritative order, including removals. Unchanged records and mounted controls retain their identity. Thread messages, streaming deltas, and logs keep their existing event paths.

One Hub observer pass runs 750 ms after the previous pass finishes while viewers are attached. It reads the bounded public worker and Secretary projections so changes from every runtime writer reach both local and Gateway dashboards, including completion and failure outside a console command. Unchanged state sends no frame. The observer stops when the last viewer disconnects and never starts agent turns. Existing session, turn, mailbox, artifact-preview, and credential/path filtering limits apply equally to incremental updates.

The client's `watch` frame selects at most one worker detail, one Mind detail, and the Context projection. The UI watches its open view; worker mailbox/artifact receipts and Mind comments/dependencies then update without reopening the detail. Context keeps its shared one-second build throttle and sends a projection only when it changes. Reconnection reestablishes these watches and releases interrupted backfill requests. Late replies from superseded requests, selections, or socket attachments cannot repaint a different selection. Within the same process, an overlapping reconnect snapshot preserves already loaded Thread history; a new process establishes a fresh history baseline.

Sent-message cards include voice playback status, elapsed playback time, and an expandable generated speech transcript when available. An interrupted transcript may include words that had not yet played; readable text delivery remains separate from acoustic playback.

Tool cards expand source/arguments and results independently. Returned values, console output, and the original tool result have separate copy and line-wrap controls; output stays literal text. Non-`run` tools retain their names and arguments. A result whose call is outside loaded history remains inspectable until backfill pairs it with its call.

Action summaries cover filesystem operations, Mind, browser/desktop, web search/extraction, scheduling, workers, memory, and other `elpis.*` calls. These bounded source previews are marked **in source**: a call appearing in code does not establish that it executed. Only literal Mind IDs become navigation links. Runtime command/read receipts show their own status, duration, output preview, and expandable streams; a run's aggregate result is never attributed to an individual command. Runtime truncation is explicit, and expanding cannot recover bytes the runtime did not retain. Edit cards offer before/after inspection even for short edits.

For browser acceptance, build, run `node test/fixtures/console-ui-server.mjs`, and open `http://127.0.0.1:8799` with `playwright-cli`. Then run `playwright-cli run-code --filename test/console-tool-cards.browser.js` in that browser session. The fixture uses the built Console server and Hub with synthetic history; it does not connect to an inhabitant. Checks cover full output, copying, wrapping, literal rendering, receipt attribution, keyboard controls, and narrow screens. Screenshots stay in ignored `.playwright-cli/` storage.

## Privacy and isolation

Context may expose system prompts, durable memory, conversation history, and tool schemas. Thread, Mind, worker receipts, secretary history, and logs may expose private work. Treat the entire console as a private administrative surface.

Run `npm run build && node test/console-sync.acceptance.mjs` for a real Chromium acceptance pass against the built console with synthetic runtime data. This checks background updates across the views, draft preservation, and websocket reconnects without reloading the page; it requires the Playwright Chromium browser installed for the repository's browser tooling.

The server binds to loopback by default. Remote access requires an authenticated TLS reverse proxy. Same-origin WebSocket checks, bounded attachment routes, and explicit Hub mutation handlers remain server-owned. Console bind or client failures do not stop the agent.
