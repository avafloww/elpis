# Discord voice

`/join` joins the operator's current regular voice channel in the configured `home` guild. `/leave` ends the call. Both commands use the existing operator authorization gate. Stage channels are unsupported.

The public OpenAI Realtime bridge is optional and disabled by default. It requires a dedicated `discord.voice.api_key`; it does not borrow LLM, Gateway, or OAuth credentials. Its WebSocket authority is fixed to `wss://api.openai.com/v1/realtime`. Model and stock voice are configurable. The default is `gpt-realtime-2.1` with `marin`. This public API implementation has not been established as identical to the desktop app's `gpt-live` mode.

```yaml
discord:
  voice:
    enabled: true
    api_key: ${VOICE_API_KEY}
    model: gpt-realtime-2.1
    voice: marin
    transcription_model: gpt-4o-mini-transcribe
    max_session_minutes: 60
  guilds:
    - id: '300000000000000001'
      slug: home
      slash_commands: true
      channels:
        '300000000000000002': { tier: direct, allow_send: true }
```

Merge these settings into the existing configuration; the channel ID must identify the actual voice channel. A guild default does not authorize voice capture: the voice channel must be explicitly configured with receive and send enabled. The bot needs View Channel, Connect, Speak, and Send Messages permissions there. The operator must be present. Only the operator's microphone is ingested; other channel members can hear playback. Tell participants before starting voice. The operator leaving, the bot being moved/disconnected, a context clear, shutdown, provider failure, deafen, or the session deadline ends the call. Mute stops playback while keeping permitted listening active.

## Continuity and delivery

The resident's usual model, identity, memory, tools, and ordered conversation remain authoritative. Realtime provides the media layer. It receives audio for transcription and the resident's explicitly authored text for speech rendering; no copy of private working history or opaque reasoning is transferred into a second agent.

Response latency includes the resident's normal model turn. Playback streams once an explicit reply is ready; the bridge does not generate independent conversational fillers while the resident is working.

Discord Opus is decoded into PCM16 mono at 24 kHz. Semantic VAD identifies utterance boundaries. The bridge waits for the provider to acknowledge that automatic responses and automatic interruption are disabled before accepting media. Finalized transcriptions enter ordinary ingress in audio commit order with `source="voice"` provenance. Partial transcripts never enter durable history or invoke tools. ASR may make mistakes; it is not an exact record of sound.

An explicit header or `elpis.channel(...).send(text)` to the joined voice channel first delivers readable text in that channel's chat, then streams speech. The same configuration, moderation, and resident send checks apply. Voice playback alone cannot start another resident turn or yield the current turn. The voice model is instructed to read the supplied text verbatim; the output transcript is retained so differences can be inspected.

A voice receipt distinguishes `played`, `interrupted`, and `failed`, and retains the provider's generated transcript and the player's elapsed playback milliseconds. The transcript may include words that were generated but not heard before interruption. `played` describes the local Discord player draining, not proof that every remote listener heard the audio. Barge-in clears queued audio without retracting the readable message or committed history. Do not automatically repeat an interrupted reply.

Each authored speech request carries a unique token echoed in response metadata; only that exact request may bind a response for playback. Response ID ownership remains fixed for the call, including after completion; delayed, conflicting, or unsolicited responses cannot claim another reply. Calls close after 1,024 distinct response IDs to bound retained ownership records.

One call and one playback response may be active at a time. Speech requests are capped at 4,000 characters and 120 seconds; ASR allows at most 32 pending utterances with a 30-second deadline per utterance. A missing VAD boundary ends the call after 10 seconds of local silence, and a microphone utterance exceeding 60 seconds ends with a notice rather than silently dropping its tail. Audio buffers are bounded and held only in memory. Raw audio is not saved. Sessions last at most 60 minutes and never reconnect automatically into a new conversation.

## Verification

Focused deterministic coverage exercises the gateway command handler, home/operator/channel gates, PCM conversion, receive filtering, transcript order, stream interruption, lifecycle cancellation, and receipt restoration. Discord transport uses `@discordjs/voice` with DAVE encryption enabled and the native Opus package.

Run `npx tsx scripts/voice-smoke.ts` after configuring voice to check the live provider with stock synthetic speech. It requires FFmpeg's `flite` filter, sends a neutral test utterance, verifies finalized recognition, checks that no audio arrives before explicit speech authorization, and verifies synthesized output. It does not read resident history, save recordings, or connect to Discord. This provider check does not replace a real Discord call test.

For live acceptance, join the configured voice channel, use `/join`, speak a short question, verify the resident's text and spoken answer, interrupt a longer answer, then use `/leave`. Verify the finalized inbound utterance and the actual playback receipt in the Console thread after the call. Also check mute/deafen and that no later audio plays after leaving or clearing context.

Protocol references: [OpenAI WebSocket guide](https://developers.openai.com/api/docs/guides/realtime-websocket), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), and [VAD controls](https://developers.openai.com/api/docs/guides/realtime-vad).

## Codex subscription investigation

An isolated Codex CLI 0.154.0 check found `thread/realtime/start`, `appendAudio`, and `appendSpeech`, plus the native model identifier `gpt-live-1-codex`. Its default WebSocket startup failed with `realtime conversation requires API key auth`. That result applies only to the WebSocket transport; it does not establish a credential requirement for every Codex realtime path.

Public Codex 0.155.0-alpha.2 source exposes WebRTC and existing-call start transports that bypass the `realtime_api_key` gate. The app-server keeps ChatGPT subscription authentication and refresh inside its existing `ModelClient` boundary. The official TUI generates a local WebRTC offer, sends `thread/realtime/start` with V3, client-managed handoffs, and startup context disabled, then waits for `thread/realtime/started` and `thread/realtime/sdp` before applying the answer.

The bundled `codex-voice-host` helper cannot directly bridge Discord audio: native media stays inside that child process and opens physical microphone and speaker devices; only SDP, mute/suppression controls, and peak telemetry cross its control pipe. The harness now includes an inert, bounded JSONL client and injected app-server signaling broker, but that broker is not wired to `/join` and starts no process, network, device, or media path by itself. A subscription-backed Discord path still needs a harness-owned WebRTC peer that carries Discord media while app-server owns signaling and authentication. It must not extract or replay subscription credentials. Before enabling that path, verify that client-managed handoffs prevent autonomous Codex turns, preserve ordered resident ingress and explicit speech receipts, and survive a real Discord call. The public API bridge remains useful groundwork, not evidence that this native path or human-call acceptance is complete.
