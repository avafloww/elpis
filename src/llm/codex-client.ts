// codex-client.ts — ChatGPT Codex Responses transport for `codex-oauth`.
//
// The ChatGPT subscription surface is OpenAI-Responses-shaped but it is not the
// public API: requests go to `/backend-api/codex/responses`, require the
// ChatGPT workspace id beside the bearer token, always stream, and reject
// caller-supplied output caps. GPT-5.6 additionally uses Codex Responses Lite:
// tools are carried in an `additional_tools` developer input item and output
// items finish on `response.output_item.done`. This module deliberately reuses
// responses.ts's message/reasoning translation while owning those transport
// differences.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import OpenAI from 'openai';
import type { Config } from '../config.js';
import type { ConsoleHub } from '../console/hub.js';
import type { OAuthStore } from './oauth/store.js';
import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_CLIENT_VERSION,
} from './oauth/openai-codex.js';
import {
  failureToError,
  fromResponseOutput,
  mapResponsesUsage,
  responsesRunTool,
  streamResponsesComplete,
  toResponsesInput,
  type ResponsesRequestTransform,
} from './responses.js';
import {
  RUN_TOOL,
  SOCIAL_SUMMARIZE_PROMPT,
  classifyError,
  type ChatMessage,
  type CompleteOptions,
  type CompleteResult,
  type LLM,
  type ReasoningItemParam,
  type StandaloneCompleteOptions,
  type StandaloneCompleteResult,
} from './llm.js';
import { endpointAt, stampGeneration } from './provenance.js';
import { isPolicyDenial, nonSecretHeaders, recordPolicyDenial } from './policy-flight-recorder.js';

const ALLOWED_CODEX_PATHS = ['/backend-api/codex/', '/backend-api/models'];
const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000;
const GPT_5_6_CONTEXT_WINDOW = 372_000;
const CODEX_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';

type FetchFn = typeof fetch;

function urlOf(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(typeof input === 'string' ? input : input.toString());
}

function assertCodexTarget(input: RequestInfo | URL): void {
  const url = urlOf(input);
  const pathAllowed = ALLOWED_CODEX_PATHS.some((path) =>
    path.endsWith('/') ? url.pathname.startsWith(path) : url.pathname === path,
  );
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port || !pathAllowed) {
    throw new Error(`refusing to send OpenAI Codex OAuth credential to non-canonical URL: ${url.origin}${url.pathname}`);
  }
}

function mergeHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

/** Authenticated fetch boundary shared by inference and model discovery.
 * It owns the only bearer injection point, strips API-key auth, and retries
 * exactly once after a 401-triggered forced refresh. */
export function createCodexFetch(
  store: OAuthStore,
  sessionId: () => string,
  fetchFn: FetchFn = fetch,
  responsesLite = false,
  config?: Config,
  preserveTransportHeaders = false,
): FetchFn {
  let policyMonitorSequence = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assertCodexTarget(input);
    const send = async (): Promise<Response> => {
      const token = await store.getAccessToken();
      const identity = store.read();
      if (!identity?.accountId) {
        throw new Error(`OpenAI Codex OAuth credential in ${store.location} has no ChatGPT account id — re-run npm run oauth-login -- codex`);
      }
      const headers = mergeHeaders(input, init);
      headers.delete('x-api-key');
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('chatgpt-account-id', identity.accountId);
      const setTransport = (name: string, value: string): void => {
        if (!preserveTransportHeaders || !headers.has(name)) headers.set(name, value);
      };
      setTransport('OpenAI-Beta', 'responses=experimental');
      setTransport('originator', 'pi');
      setTransport('version', OPENAI_CODEX_CLIENT_VERSION);
      setTransport('User-Agent', 'elpis/0.1.0');
      setTransport('session_id', sessionId());
      setTransport('conversation_id', sessionId());
      setTransport('x-client-request-id', sessionId());
      if (responsesLite) setTransport(CODEX_RESPONSES_LITE_HEADER, 'true');
      else if (!preserveTransportHeaders) headers.delete(CODEX_RESPONSES_LITE_HEADER);
      setTransport('Accept', 'application/json');
      const replayableInput = input instanceof Request ? input.clone() : input;
      const requestBody = init?.body instanceof Uint8Array || Buffer.isBuffer(init?.body)
        ? new Uint8Array(init.body as Uint8Array)
        : typeof init?.body === 'string'
          ? new TextEncoder().encode(init.body)
          : input instanceof Request
            ? new Uint8Array(await input.clone().arrayBuffer())
            : new Uint8Array();
      const requestExpectsStream = (() => {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(requestBody)) as { stream?: unknown };
          return parsed.stream === true;
        } catch {
          return false;
        }
      })();
      const requestCapture = {
        url: urlOf(input).href,
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        headers: nonSecretHeaders(headers),
        body: requestBody,
      };
      const sealBody = (response: Response, responseBody: Uint8Array, bodyComplete: boolean, captureTrigger: 'http-status' | 'stream-policy-event' | 'stream-policy-bytes'): void => {
        try {
          const record = recordPolicyDenial(config!, 'codex-responses', requestCapture, {
            status: response.status,
            statusText: response.statusText,
            headers: nonSecretHeaders(response.headers),
            body: responseBody,
            bodyComplete,
            captureTrigger,
          }, { status: response.status, message: new TextDecoder().decode(responseBody) });
          if (record) config!.logger.error(`[policy-flight-recorder] sealed denial | directory=${record.directory} | manifest_sha256=${record.manifestSha256}`);
        } catch (captureError) {
          config!.logger.error('[policy-flight-recorder] failed to seal denial:', captureError);
        }
      };
      const sealHttpResponse = async (response: Response): Promise<void> => {
        const responseBody = new Uint8Array(await response.arrayBuffer());
        sealBody(response, responseBody, true, 'http-status');
      };
      const policyErrorEvent = (eventText: string): boolean => {
        const eventName = eventText.match(/^event:\s*([^\r\n]+)/m)?.[1]?.trim().toLowerCase() ?? '';
        const dataText = eventText
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        let payloadType = '';
        let hasErrorObject = false;
        try {
          const payload = JSON.parse(dataText) as { type?: unknown; error?: unknown; response?: { error?: unknown } };
          payloadType = typeof payload.type === 'string' ? payload.type.toLowerCase() : '';
          hasErrorObject = payload.error !== undefined || payload.response?.error !== undefined;
        } catch {
 // A live trailing event can be incomplete JSON. Its explicit event
 // name still identifies the envelope while denial text prevents an
 // early match on a bare header.
        }
        const errorEnvelope = eventName === 'error'
          || eventName === 'response.failed'
          || payloadType === 'error'
          || payloadType === 'response.failed'
          || hasErrorObject;
        return errorEnvelope && isPolicyDenial(dataText || eventText);
      };
      const monitorSseResponse = async (response: Response, monitorId: number): Promise<void> => {
        const reader = response.body?.getReader();
        if (!reader) {
          config!.logger.warn(`[policy-flight-recorder] monitor=${monitorId} no response body`);
          return;
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        let chunksRead = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              config!.logger.info(`[policy-flight-recorder] monitor=${monitorId} eof | chunks=${chunksRead} | bytes=${bytes}`);
              return;
            }
            if (!value) continue;
            chunks.push(value);
            chunksRead++;
            bytes += value.byteLength;
            if (bytes > 8 * 1024 * 1024) {
              config!.logger.warn(`[policy-flight-recorder] monitor=${monitorId} limit | chunks=${chunksRead} | bytes=${bytes}`);
              await reader.cancel('policy flight recorder monitor limit');
              return;
            }
            const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
            const text = raw.toString('utf8');
            const segments = text.split(/\r?\n\r?\n/);
            const trailing = segments.pop() ?? '';
            const completeEvents = segments.length;
            const matchedCompleteEvent = segments.some(policyErrorEvent);
            const matchedTrailingError = policyErrorEvent(trailing);
            const policyTextSeen = isPolicyDenial(text);
            if (chunksRead === 1 || policyTextSeen) {
              config!.logger.info(`[policy-flight-recorder] monitor=${monitorId} progress | chunks=${chunksRead} | bytes=${bytes} | complete_events=${completeEvents} | policy_text=${policyTextSeen} | error_event=${matchedCompleteEvent || matchedTrailingError}`);
            }
            if (matchedCompleteEvent || matchedTrailingError) {
              sealBody(response, new Uint8Array(raw), false, matchedCompleteEvent ? 'stream-policy-event' : 'stream-policy-bytes');
              config!.logger.info(`[policy-flight-recorder] monitor=${monitorId} matched | chunks=${chunksRead} | bytes=${bytes} | complete_events=${completeEvents} | event_complete=${matchedCompleteEvent}`);
              await reader.cancel('policy denial captured');
              return;
            }
          }
        } catch (captureError) {
          config!.logger.error(`[policy-flight-recorder] monitor=${monitorId} failed:`, captureError);
        }
      };
 // Never follow redirects while carrying the bearer. Even though Fetch
 // normally strips Authorization on a cross-origin redirect, making that
 // behavior explicit here keeps the security boundary local and auditable.
      const response = await fetchFn(replayableInput, { ...init, headers, redirect: 'error' });
      const responseIsSse = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
      if (config) {
        config.logger.info(`[policy-flight-recorder] transport | status=${response.status} | request_stream=${requestExpectsStream} | content_type_sse=${responseIsSse} | content_type_present=${response.headers.has('content-type')}`);
      }
      if (config && response.status >= 400 && response.status < 500) {
        await sealHttpResponse(response.clone());
      } else if (config && response.ok && (requestExpectsStream || responseIsSse)) {
        const monitorId = ++policyMonitorSequence;
        config.logger.info(`[policy-flight-recorder] monitor=${monitorId} attached | status=${response.status} | request_stream=${requestExpectsStream} | content_type_sse=${responseIsSse}`);
        void monitorSseResponse(response.clone(), monitorId);
      }
      return response;
    };

    let response = await send();
    if (response.status === 401) {
 // The body is irrelevant and leaving it unread can pin the underlying
 // connection while the refresh exchange runs.
      await response.body?.cancel().catch(() => undefined);
      await store.forceRefresh();
      response = await send();
    }
    return response;
  }) as FetchFn;
}

function codexClient(
  config: Config,
  store: OAuthStore,
  sessionId: () => string,
  fetchFn: FetchFn = fetch,
  responsesLite = false,
): OpenAI {
  const dispatcher = new Agent({ bodyTimeout: 1_200_000, headersTimeout: 1_200_000 });
  return new OpenAI({
 // The custom fetch overwrites this placeholder on every request. Supplying
 // a non-empty key keeps the SDK constructor happy without ever sending it.
    apiKey: 'codex-oauth',
    baseURL: `${OPENAI_CODEX_BASE_URL}/codex`,
    maxRetries: 0,
    timeout: 1_200_000,
    fetchOptions: { dispatcher } as unknown as Record<string, unknown>,
    fetch: createCodexFetch(store, sessionId, fetchFn, responsesLite, config),
  });
}

/** OMP/codex-rs enable Responses Lite by default for the GPT-5.6 family. The
 * live model registry also reports `use_responses_lite`, but Elpis's model
 * discovery boundary intentionally returns only a context window; the family
 * predicate is the stable fallback used by OMP's generated model policy. */
export function usesCodexResponsesLite(model: string): boolean {
  return /^gpt-5\.6(?:-|$)/.test(model);
}

function normalizeCodexLiteInput(input: unknown[]): unknown[] {
  return input.map((raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const item = raw as Record<string, unknown>;
    const role = item.role === 'system' ? 'developer' : item.role;
    if (!Array.isArray(item.content)) return role === item.role ? item : { ...item, role };
    const content = item.content.map((rawPart) => {
      if (typeof rawPart !== 'object' || rawPart === null) return rawPart;
      const part = rawPart as Record<string, unknown>;
      if (part.type !== 'input_image' || !('detail' in part)) return part;
      const { detail: _detail, ...withoutDetail } = part;
      return withoutDetail;
    });
    return { ...item, role, content };
  });
}

/** Move the public Responses tool declaration into the Responses Lite input
 * grammar used by GPT-5.6 Codex. The private backend otherwise accepts the
 * request but treats the model as if it had no callable tool. */
export const shapeCodexResponsesLiteRequest: ResponsesRequestTransform = (body) => {
  const tools = Array.isArray(body.tools) ? body.tools : [responsesRunTool()];
  const input = Array.isArray(body.input) ? body.input : [];
  const normalizedInput = normalizeCodexLiteInput(input);
  const shaped: Record<string, unknown> = {
    ...body,
    input: [
      { type: 'additional_tools', role: 'developer', tools },
      ...normalizedInput,
    ],
    parallel_tool_calls: false,
    reasoning: {
      ...((typeof body.reasoning === 'object' && body.reasoning !== null)
        ? body.reasoning as Record<string, unknown>
        : {}),
      context: 'all_turns',
    },
  };
  delete shaped.tools;
  delete shaped.instructions;
  return shaped;
};

/** Project response-side reasoning objects onto the narrower Codex INPUT
 * grammar. The public Responses API returns lifecycle fields such as `id` and
 * `status`; the ChatGPT Codex backend rejects at least `status` when that raw
 * object is replayed (`Unknown parameter: input[n].status`). OMP performs the
 * same allowlist projection. History remains byte-for-byte untouched so the
 * public Responses path and transcript forensics retain the native output. */
export function sanitizeCodexMessagesForReplay(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const sanitized = messages.map((message) => {
    if (!message.reasoning_items || message.reasoning_items.length === 0) return message;
    changed = true;
    const reasoningItems = message.reasoning_items.map((item) => {
      const replay: Record<string, unknown> = {
        type: 'reasoning',
        summary: Array.isArray(item.summary) ? item.summary : [],
      };
      if (Array.isArray(item.content)) replay.content = item.content;
      if (typeof item.encrypted_content === 'string' || item.encrypted_content === null) {
        replay.encrypted_content = item.encrypted_content;
      }
      return replay as ReasoningItemParam;
    });
    return { ...message, reasoning_items: reasoningItems };
  });
  return changed ? sanitized : messages;
}

function assertBalancedHistoricalToolMessages(messages: ChatMessage[]): void {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (pending.size > 0 && message.role !== 'tool') {
      throw new Error(`unresolved historical tool call: ${[...pending][0]}`);
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        const id = call.id?.trim();
        if (!id || call.type !== 'function' || !call.function.name?.trim()) {
          throw new Error('invalid historical tool call');
        }
        if (seen.has(id)) throw new Error(`duplicate historical tool call: ${id}`);
        seen.add(id);
        pending.add(id);
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const id = message.tool_call_id?.trim();
    if (!id || !pending.has(id)) throw new Error(`orphan historical tool output: ${id || 'missing id'}`);
    pending.delete(id);
  }
  if (pending.size > 0) throw new Error(`unresolved historical tool call: ${[...pending][0]}`);
}

/** Build a tool-declaration-free, monocontext-free request for the selected Codex wire
 * grammar. Closed historical calls may be replayed explicitly, but the new completion gets no tools. */
export function buildCodexStandaloneRequest(
  config: Config,
  messages: ChatMessage[],
  cacheKey: string,
  responsesLite: boolean,
  opts: StandaloneCompleteOptions = {},
): OpenAI.Responses.ResponseCreateParamsStreaming {
  if (!cacheKey.trim()) throw new Error('Codex standalone cacheKey must be non-empty');
  const hasToolHistory = messages.some((message) => message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0);
  if (hasToolHistory && !opts.allowHistoricalToolMessages) {
    throw new Error('Codex standalone completion does not accept tool messages or tool calls');
  }
  if (hasToolHistory) assertBalancedHistoricalToolMessages(messages);
  const input = toResponsesInput(sanitizeCodexMessagesForReplay(messages));
  const model = opts.model ?? config.llm.model;
  const reasoningEffort = opts.reasoningEffort ?? config.llm.reasoningEffort;
  const body: Record<string, unknown> = {
    model,
    input: responsesLite ? normalizeCodexLiteInput(input) : input,
    store: false,
    include: ['reasoning.encrypted_content'],
    stream: true,
    prompt_cache_key: cacheKey,
    ...(responsesLite ? { parallel_tool_calls: false } : {}),
    ...((reasoningEffort || responsesLite)
      ? {
          reasoning: {
            ...(reasoningEffort
              ? { effort: reasoningEffort as OpenAI.ReasoningEffort }
              : {}),
            ...(responsesLite ? { context: 'all_turns' as const } : {}),
          },
        }
      : {}),
  };
  return body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;
}

export async function codexStandaloneComplete(
  client: OpenAI,
  config: Config,
  messages: ChatMessage[],
  cacheKey: string,
  responsesLite: boolean,
  opts: StandaloneCompleteOptions = {},
): Promise<StandaloneCompleteResult> {
  const body = buildCodexStandaloneRequest(config, messages, cacheKey, responsesLite, opts);
  let streamed = '';
  let final: { id?: unknown; output?: unknown[]; usage?: unknown; error?: unknown } | null = null;
  const completedItems = new Map<number, unknown>();
  try {
    const events = await client.responses.create(body, opts.signal ? { signal: opts.signal } : undefined);
    for await (const event of events) {
      if (event.type === 'response.output_text.delta') streamed += event.delta;
      else if (event.type === 'response.output_item.done') completedItems.set(event.output_index, event.item);
      else if (event.type === 'response.completed') final = event.response;
      else if (event.type === 'response.incomplete') {
        throw new Error(`Codex standalone completion incomplete after ${streamed.length} characters`);
      } else if (event.type === 'response.failed') {
        throw failureToError(event.response?.error);
      }
    }
  } catch (error) {
    throw classifyError(error);
  }
  if (!final) throw classifyError(new Error('Codex standalone stream ended without a terminal event'));
  const output = (final.output?.length ?? 0) > 0
    ? final.output ?? []
    : [...completedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  const parts = fromResponseOutput(output);
  const requestId = typeof final.id === 'string' ? final.id : undefined;
  return {
    content: parts.content || streamed,
    ...(parts.reasoningContent ? { reasoningContent: parts.reasoningContent } : {}),
    ...(parts.reasoningItems ? { reasoningItems: parts.reasoningItems } : {}),
    usage: mapResponsesUsage(final.usage),
    ...(requestId ? { requestId } : {}),
    model: opts.model ?? config.llm.model,
    providerType: 'codex-oauth',
    apiSurface: 'codex-responses',
    apiEndpoint: endpointAt(OPENAI_CODEX_BASE_URL, 'codex/responses'),
    ...((opts.reasoningEffort ?? config.llm.reasoningEffort) ? { reasoningEffort: opts.reasoningEffort ?? config.llm.reasoningEffort ?? undefined } : {}),
  };
}

async function codexSummarize(
  client: OpenAI,
  config: Config,
  text: string,
  sessionId: string,
  responsesLite: boolean,
  systemPrompt = SOCIAL_SUMMARIZE_PROMPT,
): Promise<string> {
  const result = await codexStandaloneComplete(client, config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text },
  ], sessionId, responsesLite);
  return result.content;
}

/** Build the LLM facade for a ChatGPT Codex subscription. */
export function createCodexOAuthLLM(
  config: Config,
  store: OAuthStore,
  hub?: ConsoleHub,
  fetchFn: FetchFn = fetch,
): LLM {
  let sessionId = randomUUID();
  const responsesLite = usesCodexResponsesLite(config.llm.model);
  const client = codexClient(config, store, () => sessionId, fetchFn, responsesLite);
  const standaloneLane = new AsyncLocalStorage<string>();
  const standaloneFallbackId = randomUUID();
  const standaloneClient = codexClient(config, store, () => standaloneLane.getStore() ?? standaloneFallbackId, fetchFn, responsesLite);
  return {
    client,
    model: config.llm.model,
    runTool: RUN_TOOL,
    resetSession(): void {
      sessionId = randomUUID();
    },
    async completeStandalone(messages: ChatMessage[], opts: StandaloneCompleteOptions = {}): Promise<StandaloneCompleteResult> {
      if (opts.tools !== undefined) throw new Error('Codex standalone completion does not support caller-defined native tools');
      const laneId = opts.cacheKey ?? randomUUID();
      if (typeof laneId !== 'string' || !laneId.trim()) throw new Error('completeStandalone cacheKey must be a non-empty string');
      const model = opts.model ?? config.llm.model;
      if (usesCodexResponsesLite(model) !== responsesLite) {
        throw new Error(`completeStandalone model ${model} uses a different Codex wire grammar than ${config.llm.model}`);
      }
      return standaloneLane.run(laneId, () => codexStandaloneComplete(standaloneClient, config, messages, laneId, responsesLite, opts));
    },
    async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<CompleteResult> {
 // The Codex backend requires streaming and rejects output caps. The
 // shared Responses path adds neither; this provider contributes its
 // stable cache key and the harness's tool-call invariants. An armed run wake
 // is the only sanctioned yield, so automatic tool selection can strand Codex
 // in the no-tool-call nudge loop.
      const sanitizeStart = Date.now();
      const sanitizedMessages = sanitizeCodexMessagesForReplay(messages);
      config.logger.info(`[llm/codex] stage=sanitized | duration=${Date.now() - sanitizeStart}ms | messages=${sanitizedMessages.length}`);
      const result = await streamResponsesComplete(client, config, sanitizedMessages, hub, {
        prompt_cache_key: sessionId,
        parallel_tool_calls: false,
        tool_choice: options.forceThink
          ? { type: 'function', name: 'think' }
          : 'required',
      }, responsesLite ? shapeCodexResponsesLiteRequest : undefined, options.signal, options.runTool);
      stampGeneration(result.message, {
        providerType: 'codex-oauth', model: config.llm.model,
        apiSurface: 'codex-responses', apiEndpoint: endpointAt(OPENAI_CODEX_BASE_URL, 'codex/responses'),
        reasoningEffort: config.llm.externalThinking ? 'none' : config.llm.reasoningEffort ?? undefined,
        requestId: result.requestId,
      });
      return result;
    },
    summarize(text: string, systemPrompt?: string): Promise<string> {
      return codexSummarize(client, config, text, sessionId, responsesLite, systemPrompt);
    },
  };
}

function entryId(entry: Record<string, unknown>): string | undefined {
  const value = entry.slug ?? entry.id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function entryContext(entry: Record<string, unknown>, model: string): number {
  const reported = entry.context_window;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) return Math.floor(reported);
  return /^gpt-5\.6(?:-|$)/.test(model) ? GPT_5_6_CONTEXT_WINDOW : DEFAULT_CODEX_CONTEXT_WINDOW;
}

/** Resolve a model window from ChatGPT's authenticated discovery routes.
 * `/codex/models` is primary; `/models` is retained as the compatibility
 * fallback used by Codex/OMP. */
export async function fetchCodexContextWindow(
  config: Config,
  store: OAuthStore,
  fetchFn: FetchFn = fetch,
): Promise<number> {
  const sessionId = randomUUID();
  const authenticatedFetch = createCodexFetch(store, () => sessionId, fetchFn);
  const failures: string[] = [];
  for (const path of ['/codex/models', '/models']) {
    const url = new URL(`${OPENAI_CODEX_BASE_URL}${path}`);
    url.searchParams.set('client_version', OPENAI_CODEX_CLIENT_VERSION);
    let response: Response;
    try {
      response = await authenticatedFetch(url, { method: 'GET' });
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!response.ok) {
      failures.push(`${path}: HTTP ${response.status}`);
      continue;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      failures.push(`${path}: invalid JSON`);
      continue;
    }
    const root = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    const entries = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : null;
    if (!entries) {
      failures.push(`${path}: no models/data array`);
      continue;
    }
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (entryId(entry) === config.llm.model) return entryContext(entry, config.llm.model);
    }
    throw new Error(
      `Codex model discovery did not return '${config.llm.model}' — choose an available model or set llm.context_size explicitly`,
    );
  }
  throw new Error(`unable to discover Codex models (${failures.join('; ')}) — set llm.context_size explicitly to bypass discovery`);
}
