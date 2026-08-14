# Anthropic subscription OAuth

`provider_type: anthropic-oauth` runs the main agent through Anthropic Messages using a Claude subscription OAuth credential stored in `agent.db`.

> **Trust and compatibility:** this adapter presents Claude Code's OAuth client identity, beta headers, user agent, and `x-app` value. It is not an official general-purpose subscription API and may conflict with provider terms or change without notice. Enable it deliberately.

## Login

Configure the provider and model, then run:

```bash
npm run oauth-login -- anthropic
```

The CLI performs an authorization-code flow with PKCE and stores the resulting credential in the local SQLite credential store. Tokens are never written to `config.yaml`.

## Wire behavior

The adapter:

- sends `Authorization: Bearer` to the canonical Anthropic endpoint only;
- includes the required OAuth and Claude Code beta headers;
- streams native Messages events;
- preserves signed thinking blocks for eligible same-provider replay;
- refreshes credentials through the canonical token endpoint;
- clears incompatible thinking state when the provider/model changes.

The identity/SOUL segment remains at the tail of the system prompt for cache stability and behavioral priority.

## Configuration

```yaml
llm:
  provider_type: anthropic-oauth
  model: claude-opus-4-1
  context_size: 200000
  reasoning_effort: high
```

`api_key` is unused. `base_url` defaults to `https://api.anthropic.com` and unsafe token destinations are rejected.

## Limitations

- Requires an interactive browser approval during login.
- Provider-internal headers and behavior can change.
- Subscription rate limits and usage windows differ from API billing.
- Opaque thinking blocks are working state, not portable durable memory.
