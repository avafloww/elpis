import type { GatewayManagedTransport } from './gateway-managed-config.js';

export const GATEWAY_OPENAI_SDK_API_KEY = 'elpis-transport-owned';
export const GATEWAY_CODEX_SDK_API_KEY = 'codex-transport-owned';
export const GATEWAY_OPENAI_SDK_BASE_URL =
  'https://gateway-provider.invalid/v1';

export interface GatewayOpenAIClientTransport {
  readonly baseURL: string;
  readonly fetch: typeof fetch;
}

const IntrinsicRequest = Request;
const intrinsicURL = URL;
const requestUrl = Object.getOwnPropertyDescriptor(
  Request.prototype,
  'url',
)!.get!;
const requestMethod = Object.getOwnPropertyDescriptor(
  Request.prototype,
  'method',
)!.get!;
const requestHeaders = Object.getOwnPropertyDescriptor(
  Request.prototype,
  'headers',
)!.get!;
const requestSignal = Object.getOwnPropertyDescriptor(
  Request.prototype,
  'signal',
)!.get!;
const intrinsicArrayBuffer = Request.prototype.arrayBuffer;
const intrinsicHeadersGet = Headers.prototype.get;
const IntrinsicTextDecoder = TextDecoder;
const intrinsicTextDecode = TextDecoder.prototype.decode;
const intrinsicJsonParse = JSON.parse;
const intrinsicReflectApply = Reflect.apply;
const intrinsicObjectFreeze = Object.freeze;

function requestValue<T>(request: Request, getter: (this: Request) => T): T {
  return intrinsicReflectApply(getter, request, []) as T;
}

function header(headers: Headers, name: string): string | null {
  return intrinsicReflectApply(intrinsicHeadersGet, headers, [name]) as
    string | null;
}

type GatewayTransportMetadata = Parameters<
  GatewayManagedTransport['dispatch']
>[1];

function createGatewaySdkBridge(
  transport: GatewayManagedTransport,
  suffix: string,
  apiKey: string,
  metadata: () => GatewayTransportMetadata,
): GatewayOpenAIClientTransport {
  const expectedUrl = new intrinsicURL(
    suffix,
    GATEWAY_OPENAI_SDK_BASE_URL + '/',
  ).href;
  const bridge = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new IntrinsicRequest(input, init);
    if (requestValue(request, requestUrl) !== expectedUrl)
      throw new Error('Gateway SDK request path is not authorized');
    if (requestValue(request, requestMethod) !== 'POST')
      throw new Error('Gateway SDK request method is not authorized');
    const headers = requestValue(request, requestHeaders);
    if (header(headers, 'authorization') !== `Bearer ${apiKey}`)
      throw new Error('Gateway SDK authorization sentinel is invalid');
    if (
      header(headers, 'api-key') !== null ||
      header(headers, 'cookie') !== null ||
      header(headers, 'proxy-authorization') !== null
    )
      throw new Error('Gateway SDK request carries forbidden credentials');
    const contentType = header(headers, 'content-type');
    if (contentType === null || !contentType.startsWith('application/json'))
      throw new Error('Gateway SDK request body must be JSON');
    const payload = new Uint8Array(
      await intrinsicReflectApply(intrinsicArrayBuffer, request, []),
    );
    if (payload.byteLength === 0)
      throw new Error('Gateway SDK request body is empty');
    let body: unknown;
    try {
      const decoder = new IntrinsicTextDecoder('utf-8', { fatal: true });
      const text = intrinsicReflectApply(intrinsicTextDecode, decoder, [
        payload,
      ]);
      body = intrinsicReflectApply(intrinsicJsonParse, JSON, [text]);
    } catch {
      throw new Error('Gateway SDK request body must be valid UTF-8 JSON');
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      (body as Record<string, unknown>).model !== transport.model
    )
      throw new Error('Gateway SDK request model is not authorized');
    return transport.dispatch(
      payload,
      metadata(),
      requestValue(request, requestSignal),
    );
  };
  return intrinsicObjectFreeze({
    baseURL: GATEWAY_OPENAI_SDK_BASE_URL,
    fetch: bridge as typeof fetch,
  });
}

export function createGatewayOpenAIClientTransport(
  transport: GatewayManagedTransport,
): GatewayOpenAIClientTransport {
  if (transport.providerType !== 'openai-compatible')
    throw new Error(
      'Gateway OpenAI bridge requires an OpenAI-compatible target',
    );
  const suffix =
    transport.apiSurface === 'responses'
      ? 'responses'
      : transport.apiSurface === 'chat-completions'
        ? 'chat/completions'
        : null;
  if (suffix === null)
    throw new Error(
      'Gateway OpenAI bridge received an incompatible API surface',
    );
  return createGatewaySdkBridge(
    transport,
    suffix,
    GATEWAY_OPENAI_SDK_API_KEY,
    () => ({ kind: 'none' }),
  );
}

export function createGatewayCodexClientTransport(
  transport: GatewayManagedTransport,
  sessionId: () => string,
): GatewayOpenAIClientTransport {
  if (
    transport.providerType !== 'codex-oauth' ||
    transport.apiSurface !== 'codex-responses'
  )
    throw new Error('Gateway Codex bridge requires a Codex Responses target');
  return createGatewaySdkBridge(
    transport,
    'responses',
    GATEWAY_CODEX_SDK_API_KEY,
    () => ({ kind: 'codex', sessionId: sessionId() }),
  );
}
