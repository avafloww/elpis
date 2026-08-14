# ElpisBench

ElpisBench measures fluency in Elpis's one-tool `run(code, end?)` environment:
tool competence, proactive judgment, protocol discipline, and concise social
calibration. It also supplies a private-first SFT, DPO, and GRPO data pipeline.
This replaces the former local/Proxmox benchmark; Docker is the only substrate.

## Security model

Each episode gets a fresh unprivileged container with a read-only root,
`--network none`, all capabilities dropped, `no-new-privileges`, resource
limits, and a `noexec,nosuid,nodev` tmpfs. Its only mounts are the scenario work
directory, result directory, and read-only faketime clock. Simulated restarts
replace the container and preserve only those episode mounts.

Credentials and provider clients stay on the host. A JSONL stdio gateway serves
completions, summaries, session resets, and clock advancement. The container
never sees the transcript corpus or Docker socket.

Private data defaults to `~/.local/share/elpisbench` with `0700` directories and
`0600` files. Real-derived episodes remain permanently private; public export
rejects them. Remote sanitization fails closed unless `allow_private_input: true`.

## Setup and benchmark commands

```bash
npm run bench -- init
# edit ~/.local/share/elpisbench/config.yaml
npm run bench -- auth login codex-oauth
npm run bench -- auth login anthropic-oauth
npm run bench -- image build
npm run bench -- doctor

npm run bench -- list
npm run bench -- run tool/read-edit-verify
npm run bench -- run                         # all 48 locked scenarios
npm run bench -- run --oracle                # infrastructure hard-gate acceptance
npm run bench -- run --baseline no-tool      # tool/protocol sensitivity baseline
npm run bench -- judge <record...> --packets-only
npm run bench -- judge <record...>           # run the three blind profiles
npm run bench -- judge <record...> --scores scores.jsonl
npm run bench -- compare old.json new.json
npm run bench -- calibrate repeat-a.json repeat-b.json

# opt-in live isolation/timeout checks (requires the built image)
ELPISBENCH_DOCKER_LIVE=1 node --test --import tsx/esm test/bench-docker-live.test.ts
```

`doctor` is a hard preflight. Runs are content-addressed over scenario revision,
image digest, provider settings, and harness commit, so reissuing an interrupted
command reuses complete records.

The locked suite has 16 tool-use, 12 proactive actionable/no-action, 12 social,
and 8 protocol/adversarial scenarios. Generated scenarios are always
`locked:false` and cannot enter it automatically.

Each locked scenario has a concrete fixture contract: initial files and
folders, the actual inbound room, optional deterministic fault injection, and
typed outcome checks. Required work passes only when its file, JSON, directory,
or target-send predicates are true after a successful tool result or send.
Merely dispatching a tool is not an outcome. Cross-room and heartbeat targets
must be named in the prompt; ordinary replies may use the inbound room. The
scripted oracle produces ordinary tool calls that satisfy these same checks—no
private success marker or candidate-only answer path. The no-tool baseline is
the corresponding sensitivity check.

Hard gates apply before the 35/25/20/20 weighted score. Extra sends and
surplus model turns incur a small universal trajectory penalty; proactivity and
protocol scenarios additionally charge post-outcome work, and other
category-specific faults add to it. Three blind 0–4 judges
are reduced by median while retaining evidence and may lower, but never erase,
the deterministic mechanical score. A range over one is unstable, and
instability over 10% makes comparisons inconclusive.

## Private data commands

```bash
npm run bench -- data epochs journal.jsonl --out epochs.json
npm run bench -- data index /read-only/sessions --out index.json
npm run bench -- data extract index.json --out extracted.jsonl
npm run bench -- data sanitize extracted.jsonl --out sanitized.jsonl
npm run bench -- data generate "recover from one failed command" --out scenario.json
npm run bench -- data validate scenario.json
npm run bench -- data split sanitized.jsonl --out split.jsonl
npm run bench -- data approve split.jsonl --by reviewer-name --out approved.jsonl
npm run bench -- data preference approved.jsonl --out dpo.jsonl
npm run bench -- data export approved.jsonl --out hf-private.jsonl
```

Indexing reconstructs turns, pairs calls/results, recovers sends, deduplicates
restart/compaction overlap, rejects ambiguous/interrupted traces, and removes
provider reasoning. Only exact/high model attribution enters model-specific
mining. Sol and Opus 5 have equal eligibility and weighting; content hashing
routes ordinary cases approximately 50/50 and hard cases to both.

Sanitization consistently aliases secrets, identifiers, contacts, and paths,
removes attachments, and runs an independent privacy and source-overlap scan.
Manual approval remains required.

## Optional training package

```bash
cd bench/training
uv sync
uv run elpisbench-preflight <model-or-tokenizer>
uv run elpisbench-sft fixtures/sft.jsonl --dry-run
uv run elpisbench-dpo fixtures/dpo.jsonl --dry-run
uv run elpisbench-grpo protocol/terminal-end --groups 2 --dry-run --fake-service
```

Preflight checks tool rendering, object argument round-tripping, stable prefixes,
assistant masking (or the need for a completion collator), and a golden
render/tokenize/decode/replay. Failing models require an explicit local Jinja
template. Initial tooling deliberately refuses real training.
