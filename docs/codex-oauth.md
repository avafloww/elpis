# OpenAI Codex subscription OAuth

`provider_type: codex-oauth` runs the main agent through ChatGPT's Codex Responses backend using device-code OAuth.

> **Compatibility caveat:** `/backend-api/codex/*` is a product-specific contract, not the public OpenAI API. It can change or be restricted independently. Enable it deliberately.

## Login

Enable device-code authorization in ChatGPT settings, configure the provider, then run:

```bash
npm run oauth-login -- codex
```

The CLI completes device authorization with PKCE and stores credentials in `agent.db`.

## Configuration

```yaml
llm:
  provider_type: codex-oauth
  model: gpt-5-codex
  context_size: 272000
  reasoning_effort: high
```

`api_key` is unused. The base URL is pinned to the canonical ChatGPT backend.

## Wire behavior

The adapter:

- sends bearer and workspace identity only to allowed HTTPS ChatGPT paths;
- always uses streaming Responses;
- requests encrypted reasoning with `store: false`;
- persists and replays eligible reasoning items under exact provenance checks;
- supports tool-free summarization and standalone bounded completion lanes;
- refreshes once after an authentication failure;
- records policy denials only when both denial text and an error-shaped SSE envelope are present.

Responses Lite request shape is applied where required by the backend.

## Limitations

- Requires a ChatGPT subscription and device authorization.
- Product-specific limits and policy behavior can be nondeterministic.
- Exact-wire diagnostic bundles may contain private context and must remain local.
- Chat Completions fallback is not available on this provider path.
