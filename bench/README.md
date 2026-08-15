# ElpisBench

ElpisBench is the isolated execution, trace, and evaluation engine for measuring
an Elpis inhabitant in a seeded world. The public repository intentionally ships
**zero validated benchmark worlds**. No current command or score is a production
capability baseline.

The former 48-scenario corpus was removed because its prompts narrated hidden
state and desired actions. Passing those scenarios mostly measured whether a
model could follow answer-shaped instructions. An empty honest corpus is better
than a convincing but invalid score.

## Required shape of a validated world

A candidate must not be told that it is under evaluation. It receives the same
kind of ingress and information it would receive in production:

- the real production harness process from a pinned commit and image;
- a private seeded data directory, config, and SQLite snapshot;
- the exact bounded conversation prefix, SOUL, MEMORY, Mind, scheduler, files,
  clock, channel map, attachments, and enabled tool surface for that branch;
- an ordinary raw Discord event, literal `[heartbeat]`, scheduler notice,
  harness wake, watch event, or restart continuation.

Only deterministic adapters replace the outside world: provider transport,
Discord/event transport, wall clock, and process supervision. Each world is both
a model benchmark and a production integration test covering boot/migrations,
prompt and tool construction, routing, persistence, outbound sends, restart
continuity, quiescence, and provenance.

Scenario descriptions and expected outcomes remain host-only. Evaluation checks
concrete state, delivery, and trace consequences after the turn. It does not
classify model actions as forbidden; the container is the authority boundary and
any action available inside it is in scope.

Exact transcript-derived worlds are permanently private. Public artifacts may be
reconstructed generic mechanisms only, never lightly redacted transcript data.
Names, IDs, hosts, dates, personal memories, distinctive quotes, paths,
attachments, credentials, and source provenance must not enter this repository.

## Isolation engine

Each episode gets an unprivileged container with a read-only root, no network,
all capabilities dropped, `no-new-privileges`, resource limits, and a
`noexec,nosuid,nodev` tmpfs. The seeded brain is mounted at
`/home/agent/data`; host control state is outside that brain. Provider clients
and credentials remain on the host behind a JSONL stdio gateway.

Engine fixtures can seed a deterministic world through `fixture.clockAt`, keyed
Mind items with parent/dependency edges, and scheduler tasks whose times are
offsets from that clock. Seeding runs through the production SQLite migrations,
`MindService`, and `Scheduler` before the production runtime boots. Structured
state without a declared clock is rejected, so container startup latency cannot
silently change the world. These generic fixtures test the engine; they are not
validated benchmark episodes.

The engine retains typed outcome checks, append-only traces, restart replacement,
blind judge packets, comparison/calibration machinery, and the private data
pipeline. These mechanisms are testable, but they are not a benchmark corpus.

## Commands

```bash
npm run bench -- init
npm run bench -- image build
npm run bench -- doctor
npm run bench -- list        # [] until reviewed production worlds exist
npm run bench -- run         # fails closed: no validated production scenarios

npm run bench -- data epochs journal.jsonl --out epochs.json
npm run bench -- data index /read-only/sessions --out index.json
npm run bench -- data extract index.json --out extracted.jsonl
npm run bench -- data sanitize extracted.jsonl --out sanitized.jsonl
npm run bench -- data validate artifact.json
```

The next acceptance milestone is not a model score. It is one transcript-mined,
evaluation-blind world whose seeded state, production ingress, real harness boot,
privacy boundary, hidden consequence checks, and full provenance survive replay.
