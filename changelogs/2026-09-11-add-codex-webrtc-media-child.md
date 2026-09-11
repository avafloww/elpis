# Add the bounded Codex WebRTC media child

The inert Codex subscription signaling foundation now has a one-call Werift media subprocess. It frames 24 kHz mono PCM through native Opus, forwards opaque data-channel events, bounds every IPC and media buffer, fences late callbacks, and requires explicit process exit after shutdown.

The app-server broker can now exchange bounded PCM and event data with that child. Graceful shutdown keeps IPC open until the child reports `closed` and then actually exits. Deadline-driven SIGTERM/SIGKILL escalation still requires observed process exit and is reported as abnormal rather than successful graceful closure.

`werift` is a new production dependency. The subscription path remains unwired and disabled: `/join` still uses only the configured public Realtime bridge, and this change starts no app-server, peer, network, device, credential, or call by itself. Response/item correlation for the separate WebRTC audio and control channels remains required before activation.

Focused app-server, media-runtime, real-constructor, subprocess-entrypoint, and existing voice client tests pass, as does the TypeScript build. Live provider and Discord call acceptance were not performed.
