# Elpis

Elpis is a self-hosted, single-agent runtime built around one programmable tool: JavaScript executed in a persistent sandbox.

It gives an agent a durable home rather than a stateless chat session: one continuous conversation across Discord rooms and a local web console, a filesystem-backed identity and memory, restart-safe transcripts, scheduled and autonomous wakes, a dependency-aware work graph, and the ability to inspect and maintain its own runtime.

> **Security model:** Elpis is designed for a dedicated machine or VM operated for one trusted agent. The sandbox is a coordination boundary, not a hostile-code boundary. The agent can deliberately shell out, use passwordless sudo when provisioned by the installer, edit the harness, and restart services.

## Core model

- **One agent, one thread.** Inputs from configured Discord rooms and the console enter one causally ordered history. Every message retains room provenance.
- **One tool, many capabilities.** The model receives `run(code)`. JavaScript can call namespaced capabilities such as `elpis.channel`, `elpis.schedule`, `elpis.mind`, `elpis.browser`, and `elpis.computer`.
- **Persistent working state.** Top-level JavaScript bindings survive tool calls within the process. Long-lived state belongs in the data directory.
- **Durable identity and memory.** `SOUL.md`, `MEMORY.md`, `people/`, `ponder/`, transcripts, and `agent.db` survive restarts and model changes.
- **Context without silent deletion.** Provider requests are projections of the durable record: completed-turn display reasoning and untrusted opaque state may be omitted, while transcripts remain complete. Compaction writes a marked summary and preserves the original record on disk.
- **Self-maintenance.** The agent can inspect source, edit files, run tests, commit changes, and deploy a verified build.
- **Local extensions.** Trusted TypeScript modules in the private data directory can add frozen `elpis.ext.*` APIs and deterministic boot-time prompt blocks without hardcoding inhabitant-specific tools into core.
- **Autonomous operation.** Heartbeats, scheduled tasks, background-job completion, and reminders can wake the same continuing agent.
- **Bounded coding collaboration.** An opt-in authenticated MCP adapter lets external coding agents work through the canonical Mind graph and task-bound correspondence without becoming parallel copies of the resident agent.

## Surfaces

| Surface | Purpose |
| --- | --- |
| Discord | Conversation, ambient rooms, attachments, slash commands, moderation, and outbound messages |
| Elpis Console | Thread, live streaming, context inspection, logs, usage, chat ingress, and Mind UI |
| JavaScript sandbox | Persistent programmable tool environment |
| Data-directory extensions | Trusted local APIs and deterministic prompt additions under `elpis.ext.*` |
| Mind | Dependency-aware projects, tasks, ideas, questions, comments, tags, and reminders |
| Coding-agent MCP | Opt-in authenticated adapter over Mind plus task-bound correspondence with the resident agent |
| Browser / computer | Stateful Playwright sessions and a persistent Linux desktop |
| Fleet | Optional bounded coding-worker sessions |

## Requirements

- A fresh dedicated Debian 13 VM or machine is the supported deployment target.
- Node.js 22 or newer; the installer provisions Node.js 24.
- A Discord application and bot token.
- One configured LLM provider.
- For the full desktop surface, a VM with a virtual display supported by Xorg.

## Install

The installer provisions system packages, a dedicated service user, Node.js, the checkout, dependencies, the build, systemd units, and a private `config.yaml`.

```bash
git clone https://github.com/avafloww/elpis.git
cd elpis
sudo ./deploy/install.sh
```

The installer is intended for a new dedicated host. Read [`docs/install.md`](docs/install.md) before using it on an existing system.

For a manual development checkout:

```bash
npm ci
cp config.example.yaml config.yaml
chmod 600 config.yaml
# edit config.yaml
npm run build
npm start
```

Configuration reference: [`docs/config.md`](docs/config.md). Extensions: [`docs/extensions.md`](docs/extensions.md). Coding-agent MCP: [`docs/mcp.md`](docs/mcp.md).

## Minimal configuration

```yaml
llm:
  provider_type: openai-compatible
  api_key: ${OPENAI_API_KEY}
  base_url: https://api.openai.com/v1
  model: gpt-4o
  context_size: 128000

discord:
  bot_token: ${DISCORD_BOT_TOKEN}
  guilds:
    - id: "111111111111111111"
      slug: home
      tier: home
      channels:
        - id: "222222222222222222"
          name: general
          tier: direct

paths:
  data_directory: ../data
```

`config.yaml` is ignored by Git and should remain mode `0600`. OAuth credentials and structured state are stored in `DATA_DIRECTORY/agent.db`; transcripts and private diagnostic bundles also live under the data directory.

## Provider support

- **OpenAI-compatible APIs** through Chat Completions or Responses.
- **Anthropic Messages** through the optional subscription OAuth adapter.
- **OpenAI Codex Responses** through the optional ChatGPT device-code adapter.

The subscription adapters use provider-internal or product-specific contracts rather than ordinary public API keys. Read their trust and compatibility notes before enabling them:

- [`docs/anthropic-oauth.md`](docs/anthropic-oauth.md)
- [`docs/codex-oauth.md`](docs/codex-oauth.md)

## Development

```bash
npm run build
npm run test:unit       # deterministic, no-network suite
npm test                # includes environment-sensitive integration tests
npm run bench:check
```

The repository is intentionally source-first: TypeScript tests import `src/` through `tsx`; production runs the built `dist/` tree.

Read [`AGENTS.md`](AGENTS.md) before changing load-bearing loop, persistence, compaction, prompt, or sandbox code.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — runtime and data flow
- [`docs/context.md`](docs/context.md) — monocontext and request assembly
- [`docs/compaction.md`](docs/compaction.md) — background folding and quality gates
- [`docs/persistence.md`](docs/persistence.md) — files, SQLite, transcripts, and custody
- [`docs/sandbox.md`](docs/sandbox.md) — JavaScript execution and capability surface
- [`docs/extensions.md`](docs/extensions.md) — trusted data-directory APIs and prompt blocks
- [`docs/console.md`](docs/console.md) — web console
- [`docs/mind.md`](docs/mind.md) — work graph
- [`docs/fleet.md`](docs/fleet.md) — optional coding workers
- [`docs/testing.md`](docs/testing.md) — test strategy
- [`SECURITY.md`](SECURITY.md) — threat model and vulnerability reporting

## Project status

Elpis is a living personal-agent runtime, not a multi-tenant platform or hardened remote-code-execution service. Interfaces may evolve with the needs of the inhabitant. Releases should preserve data compatibility or document migrations explicitly.

## License

MIT licensed. See [`LICENSE`](LICENSE).
