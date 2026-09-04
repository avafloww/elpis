import type {
  LlmProxyProviderType,
  LlmProxyRoute,
} from '@elpis/gateway-protocol';

export const GATEWAY_LLM_WIRE_GRAMMARS = Object.freeze({
  responses: 'openai-compatible-responses-v1',
  'chat/completions': 'openai-compatible-chat-completions-v1',
  messages: 'anthropic-oauth-messages-v1',
  codexResponses: 'codex-oauth-responses-v1',
  codexModels: 'codex-oauth-backend-models-v1',
  models: 'codex-oauth-models-v1',
} as const);

export function assertGatewayProviderTarget(input: {
  readonly providerType: LlmProxyProviderType;
  readonly baseUrl: string;
  readonly routes: readonly LlmProxyRoute[];
  readonly wireGrammar: Readonly<Record<string, string>>;
}): void {
  if (new URL(input.baseUrl).protocol !== 'https:')
    throw new Error('provider target requires HTTPS');
  const routes = [...input.routes].sort((left, right) =>
    left.localeCompare(right),
  );
  const grammarKeys = Object.keys(input.wireGrammar).sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    routes.length === 0 ||
    routes.length !== grammarKeys.length ||
    routes.some((route, index) => route !== grammarKeys[index])
  )
    throw new Error('provider target route grammar mismatch');

  if (input.providerType === 'openai-compatible') {
    for (const route of routes) {
      if (
        (route !== 'responses' && route !== 'chat/completions') ||
        input.wireGrammar[route] !== GATEWAY_LLM_WIRE_GRAMMARS[route]
      )
        throw new Error('OpenAI-compatible target is not executable');
    }
    return;
  }
  if (input.providerType === 'anthropic-oauth') {
    if (
      routes.length !== 1 ||
      routes[0] !== 'messages' ||
      input.wireGrammar.messages !== GATEWAY_LLM_WIRE_GRAMMARS.messages
    )
      throw new Error('Anthropic target is not executable');
    return;
  }
  if (input.baseUrl !== 'https://chatgpt.com/backend-api')
    throw new Error('Codex target base URL is not pinned');
  for (const route of routes) {
    const expected =
      route === 'codex/responses'
        ? GATEWAY_LLM_WIRE_GRAMMARS.codexResponses
        : route === 'codex/models'
          ? GATEWAY_LLM_WIRE_GRAMMARS.codexModels
          : route === 'models'
            ? GATEWAY_LLM_WIRE_GRAMMARS.models
            : null;
    if (expected === null || input.wireGrammar[route] !== expected)
      throw new Error('Codex target is not executable');
  }
}
