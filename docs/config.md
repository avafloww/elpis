# Configuration

Elpis reads `config.yaml` from the repository root by default. `ELPIS_CONFIG` may point to another file, as the restricted image does with a read-only `/config.yaml` bind. Keep the file mode `0600` and never commit it.

```bash
cp config.example.yaml config.yaml
chmod 600 config.yaml
```

The example file is the exhaustive annotated reference. This document explains the major sections and validation rules.

## `llm`

| Key                         | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `provider_type`             | `openai-compatible`, `anthropic-oauth`, or `codex-oauth`                |
| `api_key`                   | required only for `openai-compatible`                                   |
| `base_url`                  | provider endpoint; defaults are provider-specific                       |
| `model`                     | provider model identifier                                               |
| `context_size`              | explicit context window; omit only when endpoint discovery is supported |
| `reasoning_effort`          | provider reasoning level                                                |
| `external_thinking`         | optional visible think-tool mode for supported Codex paths              |
| `api`                       | `auto`, `responses`, or `chat` for OpenAI-compatible providers          |
| `completion_reserve_tokens` | output budget reserved below the model context limit                    |

`anthropic-oauth` and `codex-oauth` use credentials stored in `elpis-data/elpis.db`; run `npm run oauth-login` after configuring the provider. See the provider-specific docs.

OpenAI-compatible generation requests are pinned to the configured credential-free HTTP(S) `base_url` and exactly its `/responses` and `/chat/completions` routes. Elpis refuses redirects and injects `api_key` only after the final request route has been validated.

The canonical provider/model registry uses `llm.providers` plus role references. `main` and `classifier` are required; `motor`, `secretary`, and `compaction` are optional. Configured optional roles resolve through the same provider-local model registry. A configured `secretary` remains unused until the Kubernetes-only secretary runtime is enabled. A configured `compaction` supplies the model used for background conversation summaries; its context window and per-model token density are resolved during early boot for summary-input admission. Omitting `compaction` performs no additional context lookup or client construction and preserves the main-model compaction behavior. Omitting either optional role leaves its registry reference and target as `null`.

A canonical model may set `tool_tier: weak`, `medium`, or `strong` to opt into the resident's bounded `elpis.llm` one-shot query surface. Each tier may be assigned to at most one model across the whole registry; duplicates fail configuration loading. Omitted or `null` means unavailable. The legacy flat LLM form exposes no query models.

```yaml
llm:
  providers:
    primary:
      provider_type: openai-compatible
      api_key: ${LLM_API_KEY}
      base_url: https://api.example.com/v1
      api: responses
      models:
        main:
          name: gpt-example
          context_size: 128000
          tool_tier: strong
        classifier:
          name: gpt-example-mini
          context_size: 32000
    local:
      provider_type: openai-compatible
      api_key: local-placeholder
      base_url: http://127.0.0.1:8080/v1
      api: chat
      models:
        advisor:
          name: local-example
          context_size: 64000
          tool_tier: weak
  roles:
    main: primary/main
    classifier: primary/classifier
    compaction: primary/classifier # optional
  completion_reserve_tokens: 8192
```

`tool_tier` changes only query exposure. Role selection remains independent, so a role model is not queryable unless explicitly opted in and a query-only model need not hold a runtime role.

## `operator`

`operator.name`, optional pronouns, and `discord_id` describe and authorize the human administrator. The name is display metadata; the Discord ID gates operator-only commands.

The inhabitant's name does **not** come from this section. It comes from `SOUL.md` frontmatter.

## `discord`

`discord.bot_token` is required. `discord.guilds` is exhaustive for guilds: an unlisted guild is never ingested. Each listed guild has a receive default and optional channel overrides.

`discord.ignored_user_ids` is an optional list of exact digit-only Discord user IDs. Messages and reactions from those authors are silently discarded at the gateway before PluralKit lookup, attachment download, content logging, transcript/context ingestion, ambient batching, or feedback capture. A reply to an ignored author's message omits the referenced message rather than importing its content. The default is `[]`; ordinary nonignored bots remain visible.

Each guild has:

- a stable lowercase `slug` used in qualified room names;
- optional slash-command registration;
- optional PluralKit resolution;
- optional quiet hours and timezone;
- `default_tier`: `drop` (the default), `direct`, `social`, or `quiet` for channels absent from `channels`;
- `channels`: channel IDs mapped to a scalar receive mode or an object with `tier` and `allow_send`;
- `allow_send`: a guild-wide master send gate, default `true`;
- `default_allow_send`: send policy for unlisted channels, default `false`.

`drop` rejects inbound messages. `direct` wakes eagerly. `social` uses the social wake classifier. `quiet` is ingested as ambient context unless explicitly addressed. An explicit `tier: drop` channel may still be output-only when its `allow_send` is true.

Outbound precedence is deny-only: guild `allow_send: false` denies every channel; otherwise an explicit channel's `allow_send` applies (scalar channel entries preserve compatibility and mean true), while an unlisted channel uses `default_allow_send`. A runtime mute or deafen may deny further but never re-enable a configuration denial. Agent sends and the final Discord transport both enforce the result. The Console shows configuration locks and omits redundant mute controls.

A listen-all digest agent can use `default_tier: social`, keep `default_allow_send: false`, and give only its digest channel `allow_send: true`. Other Discord settings control attachment inlining, animated emote keyframes, ambient draining, and the error-notice channel.

## `compaction`

- `trigger_tokens`: requested fold threshold;
- `keep_tokens`: recent history left outside the fold;

The effective trigger is clamped below the provider context window by `llm.completion_reserve_tokens`.

## `dashboard`

`dashboard.local` configures the independently sufficient resident Console:

- `enabled`: serves the local operator Console;
- `host` / `port`: bind address;
- `mcp_enabled`: opt-in Streamable HTTP MCP endpoint at `/mcp` for the canonical Mind graph.

`dashboard.remote` is optional. Its canonical `url` is the Gateway's external HTTPS origin. `enrollment_token` is the exact one-use `ege1` token emitted by Gateway's **Add Instance** flow; omit it after enrollment when no replay is needed. A configured but unavailable Gateway does not block resident boot or the local Console. See [Elpis Gateway](gateway.md).

MCP has no built-in public-network authentication and rejects browser-Origin requests. Keep it loopback-bound or place it behind TLS and authentication. See [Coding-agent MCP](mcp.md).

## `heartbeat`

- `interval_ms`: base autonomous wake interval; `0` disables;
- `max_interval_ms`: idle-backoff ceiling;
- `reflection_min_messages`: minimum person messages before another reflection is useful;
- `social_nudge_ms`: outbound-silence threshold for a possible social nudge; `0` disables.

A heartbeat is a synthetic input to the same continuing agent, not a separate worker.

## `sandbox`

- `sync_timeout_ms`: V8 watchdog for synchronous code;
- `async_deadline_ms`: point at which pending work detaches into a background future;
- `preview_max_bytes`: returned-value preview cap;
- `log_max_bytes`: per-run captured-log cap.

These limits control accidents and resource use; they do not make the sandbox hostile-code safe.

## `console`

The console defaults to `127.0.0.1:8787`. Keep it loopback-only and put an authenticated TLS reverse proxy in front if remote access is needed.

## `modules`

Built-in optional modules are `kagi`, `bsky`, `browser`, `computer`, and `motor`. Configure exactly one policy:

- `enabled: [...]` is an allowlist; `enabled: []` requests none;
- `disabled: [...]` is a denylist; `disabled: []` requests all;
- omitting `modules` preserves the normal request-all default.

Supplying both keys, naming an unknown module, or repeating an ID is a boot error. Module state is resolved once at boot:

- **disabled**: excluded by policy, absent from `Object.keys(elpis)`, and direct access is `undefined`;
- **unavailable**: selected but missing credentials, dependencies, or runtime support; enumerable with precise rejecting stubs, but omitted from the prompt;
- **active**: real API plus prompt documentation.

`motor` requires an active `computer`. The official restricted image makes the desktop/browser/motor stack unavailable.

## Optional integration settings

- `kagi.api_key` supplies search and page-extraction credentials.
- `bluesky` supplies AT Protocol credentials and service configuration.
- `workers` enables native Mind-rooted workers, sets the global concurrency cap, and configures the token-bound broker. Model choice uses canonical `llm.providers` references.

## `paths`

`paths.data_directory` is resolved to an absolute path at boot. Relative paths resolve from the process working directory, normally the checkout root. The example uses `../data`, producing a sibling data directory without assuming a Unix username.

The source checkout path is discovered from the running build and is not configured here.

## Environment interpolation

YAML values support `${NAME}` substitution from process environment variables. Use this when a secret manager injects values at service start. A missing referenced environment variable is a configuration error.

Do not write `$HOME` expecting shell expansion; use an absolute path, a relative path such as `../data`, or `${HOME}` if the service environment explicitly provides it.

## Logging

`log_level` accepts the levels documented in `config.example.yaml`. Logs go to stdout/stderr and therefore to journald under the systemd service.

## Validation

Invalid provider combinations, malformed IDs, duplicate guild slugs, duplicate channel membership, unsupported tiers, invalid timezones, and unsafe OAuth endpoint overrides fail at boot with a path-specific error. Elpis does not silently guess around malformed security-relevant configuration.

## Workers

`workers` is disabled by default. `workers.server` exposes token-bound completion, Mind, and mailbox routes. Production spawning additionally requires `workers.kubernetes.enabled`, a credential-free `broker_url` origin reachable from worker Pods, and one operator-owned `PodTemplate` selected by fixed namespace/name/container configuration. Enabling Kubernetes workers without `workers.enabled`, the worker server, or a broker URL is a boot-time configuration error. Callers can choose only a canonical Mind ID and optional configured `provider/model` reference; no Pod field is part of the agent API. See [workers.md](workers.md) and `config.example.yaml`.
