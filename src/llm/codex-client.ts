// codex-client.ts — ChatGPT Codex Responses transport for `codex-oauth`.
//
// The ChatGPT subscription surface is OpenAI-Responses-shaped but it is not the
// public API: requests go to `/backend-api/codex/responses`, require the
// ChatGPT workspace id beside the bearer token, always stream, and reject
// caller-supplied output caps. GPT-5.6 and Astra use Codex Responses Lite:
// tools are carried in an `additional_tools` developer input item and output
// items finish on `response.output_item.done`. This module deliberately reuses
// responses.ts's message/reasoning translation while owning those transport
// differences.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import OpenAI from 'openai';
import {
  createCodexOAuthFetch,
  type CodexOAuthObserver,
} from '@elpis/provider-transport';
import type { Config } from '../config.js';
import type { ConsoleHub } from '../console/hub.js';
import {
  addStandaloneOutputBytes,
  assertStandaloneOutputBytes,
} from './standalone-limits.js';
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
import {
  isPolicyDenial,
  nonSecretHeaders,
  recordPolicyDenial,
} from './policy-flight-recorder.js';

type FetchFn = typeof fetch;

const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000;
const GPT_5_6_CONTEXT_WINDOW = 372_000;

/** Resident adapter around the neutral authenticated transport. Policy-denial
 * observation stays here because it owns private Config and storage effects. */
export function createCodexFetch(
  store: OAuthStore,
  sessionId: () => string,
  fetchFn: FetchFn = fetch,
  responsesLite = false,
  config?: Config,
  preserveTransportHeaders = false,
  dispatcher?: unknown,
): FetchFn {
  let policyMonitorSequence = 0;
  const policyConfig = config;
  const observe: CodexOAuthObserver | undefined = policyConfig
    ? async ({ request, response }) => {
        const requestCapture = {
          url: request.url,
          method: request.method,
          headers: nonSecretHeaders(request.headers),
          body: request.body,
        };
        const sealBody = (
          observedResponse: Response,
          responseBody: Uint8Array,
          bodyComplete: boolean,
          captureTrigger:
            'http-status' | 'stream-policy-event' | 'stream-policy-bytes',
        ): void => {
          try {
            const record = recordPolicyDenial(
              policyConfig,
              'codex-responses',
              requestCapture,
              {
                status: observedResponse.status,
                statusText: observedResponse.statusText,
                headers: nonSecretHeaders(observedResponse.headers),
                body: responseBody,
                bodyComplete,
                captureTrigger,
              },
              {
                status: observedResponse.status,
                message: new TextDecoder().decode(responseBody),
              },
            );
            if (record)
              policyConfig.logger.error(
                `[policy-flight-recorder] sealed denial | directory=${record.directory} | manifest_sha256=${record.manifestSha256}`,
              );
          } catch (captureError) {
            policyConfig.logger.error(
              '[policy-flight-recorder] failed to seal denial:',
              captureError,
            );
          }
        };
        const sealHttpResponse = async (
          observedResponse: Response,
        ): Promise<void> => {
          const responseBody = new Uint8Array(
            await observedResponse.arrayBuffer(),
          );
          sealBody(observedResponse, responseBody, true, 'http-status');
        };
        const policyErrorEvent = (eventText: string): boolean => {
          const eventName =
            eventText
              .match(/^event:\s*([^\r\n]+)/m)?.[1]
              ?.trim()
              .toLowerCase() ?? '';
          const dataText = eventText
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          let payloadType = '';
          let hasErrorObject = false;
          try {
            const payload = JSON.parse(dataText) as {
              type?: unknown;
              error?: unknown;
              response?: { error?: unknown };
            };
            payloadType =
              typeof payload.type === 'string'
                ? payload.type.toLowerCase()
                : '';
            hasErrorObject =
              payload.error !== undefined ||
              payload.response?.error !== undefined;
          } catch {
            // A live trailing event can be incomplete JSON. Its explicit event
            // name still identifies the envelope while denial text prevents an
            // early match on a bare header.
          }
          const errorEnvelope =
            eventName === 'error' ||
            eventName === 'response.failed' ||
            payloadType === 'error' ||
            payloadType === 'response.failed' ||
            hasErrorObject;
          return errorEnvelope && isPolicyDenial(dataText || eventText);
        };
        const monitorSseResponse = async (
          observedResponse: Response,
          monitorId: number,
        ): Promise<void> => {
          const reader = observedResponse.body?.getReader();
          if (!reader) {
            policyConfig.logger.warn(
              `[policy-flight-recorder] monitor=${monitorId} no response body`,
            );
            return;
          }
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          let chunksRead = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                policyConfig.logger.info(
                  `[policy-flight-recorder] monitor=${monitorId} eof | chunks=${chunksRead} | bytes=${bytes}`,
                );
                return;
              }
              if (!value) continue;
              chunks.push(value);
              chunksRead++;
              bytes += value.byteLength;
              if (bytes > 8 * 1024 * 1024) {
                policyConfig.logger.warn(
                  `[policy-flight-recorder] monitor=${monitorId} limit | chunks=${chunksRead} | bytes=${bytes}`,
                );
                await reader.cancel('policy flight recorder monitor limit');
                return;
              }
              const raw = Buffer.concat(
                chunks.map((chunk) => Buffer.from(chunk)),
                bytes,
              );
              const text = raw.toString('utf8');
              const segments = text.split(/\r?\n\r?\n/);
              const trailing = segments.pop() ?? '';
              const completeEvents = segments.length;
              const matchedCompleteEvent = segments.some(policyErrorEvent);
              const matchedTrailingError = policyErrorEvent(trailing);
              const policyTextSeen = isPolicyDenial(text);
              if (chunksRead === 1 || policyTextSeen) {
                policyConfig.logger.info(
                  `[policy-flight-recorder] monitor=${monitorId} progress | chunks=${chunksRead} | bytes=${bytes} | complete_events=${completeEvents} | policy_text=${policyTextSeen} | error_event=${matchedCompleteEvent || matchedTrailingError}`,
                );
              }
              if (matchedCompleteEvent || matchedTrailingError) {
                sealBody(
                  observedResponse,
                  new Uint8Array(raw),
                  false,
                  matchedCompleteEvent
                    ? 'stream-policy-event'
                    : 'stream-policy-bytes',
                );
                policyConfig.logger.info(
                  `[policy-flight-recorder] monitor=${monitorId} matched | chunks=${chunksRead} | bytes=${bytes} | complete_events=${completeEvents} | event_complete=${matchedCompleteEvent}`,
                );
                await reader.cancel('policy denial captured');
                return;
              }
            }
          } catch (captureError) {
            policyConfig.logger.error(
              `[policy-flight-recorder] monitor=${monitorId} failed:`,
              captureError,
            );
          }
        };
        const responseIsSse =
          response.headers
            .get('content-type')
            ?.toLowerCase()
            .includes('text/event-stream') ?? false;
        policyConfig.logger.info(
          `[policy-flight-recorder] transport | status=${response.status} | request_stream=${request.expectsStream} | content_type_sse=${responseIsSse} | content_type_present=${response.headers.has('content-type')}`,
        );
        if (response.status >= 400 && response.status < 500) {
          await sealHttpResponse(response);
        } else if (response.ok && (request.expectsStream || responseIsSse)) {
          const monitorId = ++policyMonitorSequence;
          policyConfig.logger.info(
            `[policy-flight-recorder] monitor=${monitorId} attached | status=${response.status} | request_stream=${request.expectsStream} | content_type_sse=${responseIsSse}`,
          );
          void monitorSseResponse(response, monitorId);
        }
      }
    : undefined;

  return createCodexOAuthFetch({
    credentials: store,
    sessionId,
    fetch: fetchFn,
    responsesLite,
    preserveTransportHeaders,
    dispatcher,
    observe,
  });
}

function codexClient(
  config: Config,
  store: OAuthStore,
  sessionId: () => string,
  fetchFn: FetchFn = fetch,
  responsesLite = false,
): OpenAI {
  const dispatcher = new Agent({
    bodyTimeout: 1_200_000,
    headersTimeout: 1_200_000,
  });
  return new OpenAI({
    // The custom fetch overwrites this placeholder on every request. Supplying
    // a non-empty key keeps the SDK constructor happy without ever sending it.
    apiKey: 'codex-oauth',
    baseURL: `${OPENAI_CODEX_BASE_URL}/codex`,
    maxRetries: 0,
    timeout: 1_200_000,
    fetchOptions: { dispatcher } as unknown as Record<string, unknown>,
    fetch: createCodexFetch(
      store,
      sessionId,
      fetchFn,
      responsesLite,
      config,
      false,
      dispatcher,
    ),
  });
}

/** Codex's model registry enables Responses Lite for GPT-5.6 and Astra.
 * Discovery returns only a context window, so keep explicit model families
 * here for clients that bypass discovery with a configured context size. */
export function usesCodexResponsesLite(model: string): boolean {
  return /^(?:gpt-5\.6|gpt-6-astra)(?:-|$)/.test(model);
}

function normalizeCodexLiteInput(input: unknown[]): unknown[] {
  return input.map((raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const item = raw as Record<string, unknown>;
    const role = item.role === 'system' ? 'developer' : item.role;
    if (!Array.isArray(item.content))
      return role === item.role ? item : { ...item, role };
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
 * grammar used by GPT-5.6 and Astra on Codex. The private backend otherwise accepts the
 * request but treats the model as if it had no callable tool. */
export const shapeCodexResponsesLiteRequest: ResponsesRequestTransform = (
  body,
) => {
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
      ...(typeof body.reasoning === 'object' && body.reasoning !== null
        ? (body.reasoning as Record<string, unknown>)
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
export function sanitizeCodexMessagesForReplay(
  messages: ChatMessage[],
): ChatMessage[] {
  let changed = false;
  const sanitized = messages.map((message) => {
    if (!message.reasoning_items || message.reasoning_items.length === 0)
      return message;
    changed = true;
    const reasoningItems = message.reasoning_items.map((item) => {
      const replay: Record<string, unknown> = {
        type: 'reasoning',
        summary: Array.isArray(item.summary) ? item.summary : [],
      };
      if (Array.isArray(item.content)) replay.content = item.content;
      if (
        typeof item.encrypted_content === 'string' ||
        item.encrypted_content === null
      ) {
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
        if (seen.has(id))
          throw new Error(`duplicate historical tool call: ${id}`);
        seen.add(id);
        pending.add(id);
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const id = message.tool_call_id?.trim();
    if (!id || !pending.has(id))
      throw new Error(`orphan historical tool output: ${id || 'missing id'}`);
    pending.delete(id);
  }
  if (pending.size > 0)
    throw new Error(`unresolved historical tool call: ${[...pending][0]}`);
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
  if (!cacheKey.trim())
    throw new Error('Codex standalone cacheKey must be non-empty');
  const hasToolHistory = messages.some(
    (message) =>
      message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0,
  );
  if (hasToolHistory && !opts.allowHistoricalToolMessages) {
    throw new Error(
      'Codex standalone completion does not accept tool messages or tool calls',
    );
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
    ...(reasoningEffort || responsesLite
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
  const body = buildCodexStandaloneRequest(
    config,
    messages,
    cacheKey,
    responsesLite,
    opts,
  );
  const controller = new AbortController();
  if (opts.signal?.aborted) controller.abort();
  else
    opts.signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
  let streamed = '';
  let visibleOutputBytes = 0;
  let final: {
    id?: unknown;
    output?: unknown[];
    usage?: unknown;
    error?: unknown;
  } | null = null;
  const completedItems = new Map<number, unknown>();
  try {
    const events = await client.responses.create(body, {
      signal: controller.signal,
    });
    for await (const event of events) {
      if (event.type === 'response.output_text.delta') {
        visibleOutputBytes = addStandaloneOutputBytes(
          visibleOutputBytes,
          event.delta,
          opts.maxOutputBytes,
          () => controller.abort(),
        );
        streamed += event.delta;
      } else if (event.type === 'response.output_item.done')
        completedItems.set(event.output_index, event.item);
      else if (event.type === 'response.completed') final = event.response;
      else if (event.type === 'response.incomplete') {
        throw new Error(
          `Codex standalone completion incomplete after ${streamed.length} characters`,
        );
      } else if (event.type === 'response.failed') {
        throw failureToError(event.response?.error);
      }
    }
  } catch (error) {
    throw classifyError(error);
  }
  if (!final)
    throw classifyError(
      new Error('Codex standalone stream ended without a terminal event'),
    );
  const output =
    (final.output?.length ?? 0) > 0
      ? (final.output ?? [])
      : [...completedItems.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, item]) => item);
  const parts = fromResponseOutput(output);
  const content = parts.content || streamed;
  assertStandaloneOutputBytes(content, opts.maxOutputBytes);
  const requestId = typeof final.id === 'string' ? final.id : undefined;
  return {
    content,
    ...(parts.reasoningContent
      ? { reasoningContent: parts.reasoningContent }
      : {}),
    ...(parts.reasoningItems ? { reasoningItems: parts.reasoningItems } : {}),
    usage: mapResponsesUsage(final.usage),
    ...(requestId ? { requestId } : {}),
    model: opts.model ?? config.llm.model,
    providerType: 'codex-oauth',
    apiSurface: 'codex-responses',
    apiEndpoint: endpointAt(OPENAI_CODEX_BASE_URL, 'codex/responses'),
    ...((opts.reasoningEffort ?? config.llm.reasoningEffort)
      ? {
          reasoningEffort:
            opts.reasoningEffort ?? config.llm.reasoningEffort ?? undefined,
        }
      : {}),
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
  const result = await codexStandaloneComplete(
    client,
    config,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    sessionId,
    responsesLite,
  );
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
  const client = codexClient(
    config,
    store,
    () => sessionId,
    fetchFn,
    responsesLite,
  );
  const standaloneLane = new AsyncLocalStorage<string>();
  const standaloneFallbackId = randomUUID();
  const standaloneClient = codexClient(
    config,
    store,
    () => standaloneLane.getStore() ?? standaloneFallbackId,
    fetchFn,
    responsesLite,
  );
  return {
    client,
    model: config.llm.model,
    runTool: RUN_TOOL,
    resetSession(): void {
      sessionId = randomUUID();
    },
    async completeStandalone(
      messages: ChatMessage[],
      opts: StandaloneCompleteOptions = {},
    ): Promise<StandaloneCompleteResult> {
      if (opts.tools !== undefined)
        throw new Error(
          'Codex standalone completion does not support caller-defined native tools',
        );
      const laneId = opts.cacheKey ?? randomUUID();
      if (typeof laneId !== 'string' || !laneId.trim())
        throw new Error(
          'completeStandalone cacheKey must be a non-empty string',
        );
      const model = opts.model ?? config.llm.model;
      if (usesCodexResponsesLite(model) !== responsesLite) {
        throw new Error(
          `completeStandalone model ${model} uses a different Codex wire grammar than ${config.llm.model}`,
        );
      }
      return standaloneLane.run(laneId, () =>
        codexStandaloneComplete(
          standaloneClient,
          config,
          messages,
          laneId,
          responsesLite,
          opts,
        ),
      );
    },
    async complete(
      messages: ChatMessage[],
      options: CompleteOptions = {},
    ): Promise<CompleteResult> {
      // The Codex backend requires streaming and rejects output caps. The
      // shared Responses path adds neither; this provider contributes its
      // stable cache key and the harness's tool-call invariants. An armed run wake
      // is the only sanctioned yield, so automatic tool selection can strand Codex
      // in the no-tool-call nudge loop.
      const sanitizeStart = Date.now();
      const sanitizedMessages = sanitizeCodexMessagesForReplay(messages);
      config.logger.info(
        `[llm/codex] stage=sanitized | duration=${Date.now() - sanitizeStart}ms | messages=${sanitizedMessages.length}`,
      );
      const result = await streamResponsesComplete(
        client,
        config,
        sanitizedMessages,
        hub,
        {
          prompt_cache_key: sessionId,
          parallel_tool_calls: false,
          tool_choice: options.forceThink
            ? { type: 'function', name: 'think' }
            : (options.toolChoice ?? 'required'),
        },
        responsesLite ? shapeCodexResponsesLiteRequest : undefined,
        options.signal,
        options.runTool,
        options.skillTool,
      );
      stampGeneration(result.message, {
        providerType: 'codex-oauth',
        model: config.llm.model,
        apiSurface: 'codex-responses',
        apiEndpoint: endpointAt(OPENAI_CODEX_BASE_URL, 'codex/responses'),
        reasoningEffort: config.llm.externalThinking
          ? 'none'
          : (config.llm.reasoningEffort ?? undefined),
        requestId: result.requestId,
      });
      return result;
    },
    summarize(text: string, systemPrompt?: string): Promise<string> {
      return codexSummarize(
        client,
        config,
        text,
        sessionId,
        responsesLite,
        systemPrompt,
      );
    },
  };
}

function entryId(entry: Record<string, unknown>): string | undefined {
  const value = entry.slug ?? entry.id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function entryContext(entry: Record<string, unknown>, model: string): number {
  const reported = entry.context_window;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0)
    return Math.floor(reported);
  return /^gpt-5\.6(?:-|$)/.test(model)
    ? GPT_5_6_CONTEXT_WINDOW
    : DEFAULT_CODEX_CONTEXT_WINDOW;
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
      failures.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const root =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const entries = Array.isArray(root.models)
      ? root.models
      : Array.isArray(root.data)
        ? root.data
        : null;
    if (!entries) {
      failures.push(`${path}: no models/data array`);
      continue;
    }
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (entryId(entry) === config.llm.model)
        return entryContext(entry, config.llm.model);
    }
    throw new Error(
      `Codex model discovery did not return '${config.llm.model}' — choose an available model or set llm.context_size explicitly`,
    );
  }
  throw new Error(
    `unable to discover Codex models (${failures.join('; ')}) — set llm.context_size explicitly to bypass discovery`,
  );
}
