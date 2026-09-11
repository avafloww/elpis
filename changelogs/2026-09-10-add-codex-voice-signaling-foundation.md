# Add bounded Codex voice signaling foundation

Elpis now includes a bounded JSON-RPC-over-JSONL client and an injected Codex app-server voice broker for future subscription-backed Discord voice signaling. The broker creates one ephemeral thread, sends the exact context-free V3 WebRTC start request, correlates signaling notifications to one call, and requires observed child exit through graceful shutdown and bounded signal escalation.

This is an inert foundation. It is not connected to `/join`, does not provide a WebRTC media peer, and does not spawn a process, open a network connection, access a device, or use subscription authentication by itself. The existing public Realtime bridge remains the only configured voice path and stays disabled by default.

Deterministic tests cover JSONL bounds and cleanup, strict notification sequencing, stale-child fencing, mandatory terminal stop delivery, media IPC bounds, and truthful shutdown failure when a child does not report exit after `SIGKILL`. Subscription media wiring, provider verification, and a human Discord call remain future acceptance work.
