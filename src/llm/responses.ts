// responses.ts — the OpenAI Responses API path (reasoning-preserving).
//
// The Responses API is the modern surface: reasoning models return their
// chain-of-thought as first-class `reasoning` output items which — in stateless
// mode (`store: false` + `include: ['reasoning.encrypted_content']`) — carry an
// opaque `encrypted_content` blob. Passing those items BACK in the next
// request's `input` preserves the model's thinking across turns, which measured
// dramatically better on agentic tasks (OpenAI's ARC-AGI-3 writeup) than
// dropping it. That preservation is the whole point of this module:
//
// - Every reasoning item from a response is stored verbatim on the assistant
// `ChatMessage` (`reasoning_items`), persisted to the transcript, and
// re-sent on EVERY subsequent request — the request-assembly diet's
// reasoning-content strip (3a) deliberately does NOT apply to them. The
// endpoint's own `reasoning.context` knob (newer models) decides how much
// of that history actually renders into model context.
// - Human-readable reasoning (summary and/or raw reasoning text, when the
// endpoint emits either) is ALSO captured into the legacy
// `reasoning_content` field so the console, transcript forensics, and the
// compaction summarizer keep seeing the model's thinking. On this path
// `reasoning_content` is display-only: it is never sent back to the API
// (there is no field for it; the encrypted items are the continuity
// mechanism).
//
// Which path a session uses is decided in `createLLM` (llm.ts): `llm.api` =
// 'responses' | 'chat' | 'auto' (default), where auto tries Responses and
// permanently falls back to Chat Completions for the process lifetime when the
// endpoint 404s the route (`isResponsesUnsupported`). This module never
// decides; it just implements the Responses side of the fork.
//
// Wire-shape notes (SDK v5 `client.responses.*`):
// - tool calls arrive as `function_call` output items (`call_id` is the
// correlation key); our `ChatMessage.tool_calls[].id` stores the `call_id`,
// and a `tool` message maps back to a `function_call_output` item.
// - usage is `input_tokens`/`output_tokens` (+ `input_tokens_details.
// cached_tokens`), mapped onto the OpenAI-compat `LLMUsage` shape the rest
// of the harness speaks.
// - the run tool is the same schema as chat's RUN_TOOL, flattened to the
// Responses `FunctionTool` shape (derived lazily — llm.ts and this module
// import each other, so a module-load-time derivation would hit the TDZ).

import type OpenAI from 'openai';
import type { Config } from '../config.js';
import type { ConsoleHub } from '../console/hub.js';
import {
  addStandaloneOutputBytes,
  assertStandaloneOutputBytes,
} from './standalone-limits.js';
import {
  RUN_TOOL,
  THINK_TOOL,
  RetriableError,
  classifyError,
  computeCharsSent,
  prepareForApi,
  sanitizeAssistantMessage,
  type ChatMessage,
  type CompleteResult,
  type LLMUsage,
  type RunTool,
  type SkillTool,
} from './llm.js';

/** The subset of the Responses `reasoning` item shape we store and replay.
 * Structural (not the SDK type) so transcripts survive SDK upgrades; unknown
 * extra fields on a stored item are preserved by the index-signature and sent
 * back verbatim. */
export interface ReasoningItemParam {
  id: string;
  type: 'reasoning';
  summary: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  encrypted_content?: string | null;
  [key: string]: unknown;
}

/** RUN_TOOL in the Responses API's flattened FunctionTool shape. Derived
 * lazily from RUN_TOOL: llm.ts ⇄ responses.ts import each other, so reading
 * RUN_TOOL at module-evaluation time would hit the TDZ when this module
 * evaluates first. `strict: false` deliberately mirrors the chat path (the
 * run schema's optional `end` doesn't fit strict mode's all-required rule). */
let cachedRunTool: OpenAI.Responses.FunctionTool | null = null;
let cachedThinkTool: OpenAI.Responses.FunctionTool | null = null;

export function responsesSkillTool(
  skillTool: SkillTool,
): OpenAI.Responses.FunctionTool {
  return {
    type: 'function',
    name: skillTool.function.name,
    description: skillTool.function.description,
    parameters: skillTool.function.parameters as unknown as Record<
      string,
      unknown
    >,
    strict: true,
  };
}
export function responsesRunTool(
  runTool: RunTool = RUN_TOOL,
): OpenAI.Responses.FunctionTool {
  if (runTool !== RUN_TOOL) {
    return {
      type: 'function',
      name: runTool.function.name,
      description: runTool.function.description,
      parameters: runTool.function.parameters as unknown as Record<
        string,
        unknown
      >,
      strict: false,
    };
  }
  if (!cachedRunTool) {
    cachedRunTool = {
      type: 'function',
      name: RUN_TOOL.function.name,
      description: RUN_TOOL.function.description,
      parameters: RUN_TOOL.function.parameters as unknown as Record<
        string,
        unknown
      >,
      strict: false,
    };
  }
  return cachedRunTool;
}

export function responsesThinkTool(): OpenAI.Responses.FunctionTool {
  if (!cachedThinkTool) {
    cachedThinkTool = {
      type: 'function',
      name: THINK_TOOL.function.name,
      description: THINK_TOOL.function.description,
      parameters: THINK_TOOL.function.parameters as unknown as Record<
        string,
        unknown
      >,
      strict: true,
    };
  }
  return cachedThinkTool;
}

export function responsesModelTools(
  config: Config,
  runTool: RunTool = RUN_TOOL,
  skillTool?: SkillTool,
): OpenAI.Responses.FunctionTool[] {
  return [
    responsesRunTool(runTool),
    ...(skillTool ? [responsesSkillTool(skillTool)] : []),
    ...(config.llm.externalThinking ? [responsesThinkTool()] : []),
  ];
}

/** Convert chat-completions multimodal content parts (the shape Discord ingest
 * builds) to Responses input content parts. */
function toResponsesContentParts(
  parts: OpenAI.ChatCompletionContentPart[],
): OpenAI.Responses.ResponseInputMessageContentList {
  const out: OpenAI.Responses.ResponseInputContent[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      out.push({ type: 'input_text', text: p.text });
    } else if (p.type === 'image_url') {
      out.push({
        type: 'input_image',
        image_url: p.image_url.url,
        detail: 'auto',
      });
    }
    // other part kinds (audio) are not produced by this harness; skip if seen.
  }
  return out;
}

/** Map dieted ChatMessages to a Responses `input` item list.
 *
 * Per assistant message the emit order is [reasoning items, message?,
 * function_calls] — reasoning first (the API requires a reasoning item to be
 * followed by the rest of its generation's items), then the visible message,
 * then the calls. A `tool` message becomes a `function_call_output` keyed by
 * the stored `tool_call_id` (which on this path IS the Responses `call_id`).
 * Exported for unit tests. */
export function toResponsesInput(
  messages: ChatMessage[],
): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: m.content ?? '',
      });
      continue;
    }
    if (m.role === 'assistant') {
      // A reasoning item may only be replayed when at least one item from its
      // own generation follows it (the API 400s a dangling one: "provided
      // without its required following item"). An assistant message with no
      // content and no tool calls (e.g. a max-output `incomplete` that spent
      // its whole budget thinking) therefore contributes NO items — replaying
      // its reasoning alone would poison every subsequent request, and the
      // guard also heals any such message already sitting in a restored
      // transcript. Items are shallow-copied so the SDK can never mutate
      // in-memory history through the request body.
      const hasFollower = Boolean(m.content) || (m.tool_calls?.length ?? 0) > 0;
      if (hasFollower) {
        for (const r of m.reasoning_items ?? []) {
          items.push({ ...r } as unknown as OpenAI.Responses.ResponseInputItem);
        }
      }
      if (m.content) {
        items.push({ role: 'assistant', content: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }
    // system / user
    if (m.contentParts && m.contentParts.length > 0) {
      items.push({
        role: m.role,
        content: toResponsesContentParts(m.contentParts),
      });
    } else {
      items.push({ role: m.role, content: m.content ?? '' });
    }
  }
  return items;
}

/** The pieces of one model response, pulled out of its `output` item list.
 * `content` is every message item's output_text concatenated; `toolCalls` maps
 * function_call items to the chat tool_calls shape (`id` ← `call_id`);
 * `reasoningItems` are the raw reasoning items (encrypted blobs included) for
 * replay; `reasoningContent` is the human-readable side (raw reasoning text if
 * present, else summary text) for display/summarizer visibility. */
export function fromResponseOutput(output: unknown[]): {
  content: string;
  reasoningContent?: string;
  reasoningItems?: ReasoningItemParam[];
  toolCalls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
} {
  let content = '';
  const reasoningTexts: string[] = [];
  const reasoningItems: ReasoningItemParam[] = [];
  const toolCalls: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }> = [];
  for (const raw of output ?? []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part?.type === 'output_text' && typeof part.text === 'string')
          content += part.text;
        // A refusal is the message — surface it as content so the loop and the
        // transcript see it (and so the turn isn't an empty-content orphan).
        else if (part?.type === 'refusal' && typeof part.refusal === 'string')
          content += part.refusal;
      }
    } else if (item.type === 'reasoning') {
      reasoningItems.push(item as unknown as ReasoningItemParam);
      const texts = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];
      const summaries = Array.isArray(item.summary)
        ? (item.summary as Array<Record<string, unknown>>)
        : [];
      const readable = (texts.length > 0 ? texts : summaries)
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n\n');
      if (readable) reasoningTexts.push(readable);
    } else if (item.type === 'function_call') {
      // Mirror the chat path's assembleToolCalls: an id-less call is dropped
      // (never dispatched, never replayed) — an empty-string call_id would
      // collide across calls and be rejected by the API on replay.
      if (typeof item.call_id !== 'string' || item.call_id.length === 0)
        continue;
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : '',
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        },
      });
    }
  }
  return {
    content,
    reasoningContent:
      reasoningTexts.length > 0 ? reasoningTexts.join('\n\n') : undefined,
    reasoningItems: reasoningItems.length > 0 ? reasoningItems : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/** Map a Responses `usage` object onto the OpenAI-compat LLMUsage shape the
 * rest of the harness (context tracker, cache stats, density) consumes.
 * `cached_tokens` follows extractCacheTokens' contract: `undefined` — never
 * 0 — when the provider reports nothing. */
export function mapResponsesUsage(usage: unknown): LLMUsage {
  const u = (
    typeof usage === 'object' && usage !== null ? usage : {}
  ) as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const details = u.input_tokens_details;
  let cached: number | undefined;
  if (typeof details === 'object' && details !== null) {
    const c = (details as Record<string, unknown>).cached_tokens;
    if (typeof c === 'number' && Number.isFinite(c)) cached = c;
  }
  return {
    prompt_tokens: num(u.input_tokens),
    completion_tokens: num(u.output_tokens),
    total_tokens: num(u.total_tokens),
    ...(cached !== undefined ? { cached_tokens: cached } : {}),
  };
}

/** Optional last-mile request shaping for Responses-compatible transports
 * whose wire grammar differs from the public endpoint (currently Codex
 * Responses Lite). It runs after prepareForApi/buildResponsesParams so the
 * transport never bypasses the shared request diet. */
export type ResponsesRequestTransform = (
  body: Record<string, unknown>,
) => Record<string, unknown>;

/** True when an error (raw or classify-wrapped) explicitly means this endpoint
 * has no /responses route. Only 404/405/501 are capability evidence for
 * `llm.api: auto`; capacity, auth, model, and other upstream failures must
 * surface on Responses without probing or latching Chat Completions. */
export function isResponsesUnsupported(e: unknown): boolean {
  const inner =
    e instanceof RetriableError ||
    (e &&
      typeof e === 'object' &&
      'cause' in e &&
      (e as { name?: string }).name === 'NonRetriableError')
      ? (e as { cause: unknown }).cause
      : e;
  if (!inner || typeof inner !== 'object') return false;
  const status =
    'status' in inner &&
    typeof (inner as { status: unknown }).status === 'number'
      ? (inner as { status: number }).status
      : undefined;
  return status === 404 || status === 405 || status === 501;
}

/** Convert a `response.failed` event's bare `{ code, message }` error object
 * into a real Error that `classifyError` handles correctly. The bare object
 * has no `status`, so unhandled it would (a) render operator-facing as
 * `[object Object]` and (b) default to retriable — turning a terminal verdict
 * like `context_length_exceeded` into an endless retry-with-backoff loop that
 * never reaches the documented non-retriable surfacing. Only genuinely
 * transient codes stay retriable (a synthetic 5xx/429 status); everything
 * else gets a synthetic 400 → NonRetriableError, matching the chat path where
 * the SDK error carries a real status. Exported for unit tests. */
export function failureToError(error: unknown): Error {
  const e = (
    typeof error === 'object' && error !== null ? error : {}
  ) as Record<string, unknown>;
  const code = typeof e.code === 'string' ? e.code : 'unknown';
  const message =
    typeof e.message === 'string'
      ? e.message
      : 'responses stream reported failure';
  const status =
    code === 'rate_limit_exceeded' ? 429 : code === 'server_error' ? 503 : 400;
  return Object.assign(
    new Error(`responses stream failed (${code}): ${message}`),
    {
      code,
      status,
    },
  );
}

/** Build the shared (stream/non-stream) request body. Stateless reasoning
 * preservation is unconditional: `store: false` + encrypted reasoning in
 * `include`, with prior turns' reasoning items already replayed in `input` by
 * toResponsesInput. `reasoning.summary`/`reasoning.context` are opt-in config
 * knobs (newer-endpoint features; omitted = endpoint default) — `context` is
 * newer than the pinned SDK's Reasoning type, hence the widened cast. */
function buildResponsesParams(
  config: Config,
  prepared: ChatMessage[],
  tools: OpenAI.Responses.FunctionTool[],
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: config.llm.model,
    input: toResponsesInput(prepared),
    tools,
    parallel_tool_calls: false,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  const reasoning: Record<string, unknown> = {};
  if (config.llm.externalThinking) reasoning.effort = 'none';
  else if (config.llm.reasoningEffort)
    reasoning.effort = config.llm.reasoningEffort;
  if (config.llm.reasoningSummary)
    reasoning.summary = config.llm.reasoningSummary;
  if (config.llm.reasoningContext)
    reasoning.context = config.llm.reasoningContext;
  if (Object.keys(reasoning).length > 0) {
    params.reasoning = reasoning as OpenAI.Reasoning;
  }
  return params;
}

/** Assemble a CompleteResult from a finished Response object (either the
 * non-streaming return or a stream's `response.completed` payload). */
function assembleResult(
  resp: { output?: unknown[]; usage?: unknown },
  charsSent: number,
  extraContent = '',
  requestId?: string,
): CompleteResult {
  const parts = fromResponseOutput(resp.output ?? []);
  const sanitized = sanitizeAssistantMessage({
    content: parts.content + extraContent,
    reasoning_content: parts.reasoningContent,
    tool_calls: parts.toolCalls,
  });
  if (parts.reasoningItems) {
    sanitized.message.reasoning_items = parts.reasoningItems;
  }
  return {
    message: sanitized.message,
    stripped: sanitized.stripped,
    usage: mapResponsesUsage(resp.usage),
    promptChars: charsSent,
    ...(requestId ? { requestId } : {}),
  };
}

/** Streaming Responses completion. Final message assembly comes from the
 * `response.completed` payload's output items (authoritative, including
 * encrypted reasoning); deltas drive the console mirror and idle watchdog. */
export async function streamResponsesComplete(
  client: OpenAI,
  config: Config,
  messages: ChatMessage[],
  hub?: ConsoleHub,
  extraBody: Record<string, unknown> = {},
  transformRequest?: ResponsesRequestTransform,
  outerSignal?: AbortSignal,
  runTool: RunTool = RUN_TOOL,
  skillTool?: SkillTool,
  maxOutputBytes?: number,
): Promise<CompleteResult> {
  try {
    try {
      hub?.streamStart();
    } catch {
      /* observer must never break generation */
    }
    const controller = new AbortController();
    if (outerSignal?.aborted) controller.abort();
    else
      outerSignal?.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    config.logger.info(`[llm/responses] stage=enter`);
    const prepareStart = Date.now();
    const prepared = prepareForApi(messages);
    const modelTools = responsesModelTools(config, runTool, skillTool);
    const charsSent = computeCharsSent(
      prepared,
      true,
      config.llm.externalThinking,
      modelTools,
    );
    config.logger.info(
      `[llm/responses] stage=prepared | duration=${Date.now() - prepareStart}ms | messages=${prepared.length}`,
    );

    let content = '';
    let visibleOutputBytes = 0;
    let reasoningPreview = '';
    // Function-call args accumulate per output index until the terminal item.
    const callSlots: Record<
      number,
      { callId?: string; name?: string; args: string }
    > = {};
    // The public endpoint repeats completed output items in
    // response.completed.response.output. ChatGPT's Codex SSE transport does
    // not reliably do that: its authoritative items arrive on
    // response.output_item.done and the terminal envelope may carry usage
    // only. Keep the done items by output index and reconstruct the response
    // from them below.
    const completedItems = new Map<number, unknown>();
    let finalResponse: { output?: unknown[]; usage?: unknown } | null = null;
    let failure: unknown = null;
    let requestId: string | undefined;
    let idleTimedOut = false;
    let progressDeadline = Date.now() + config.llm.streamIdleTimeoutMs;
    const markMeaningfulProgress = (): void => {
      progressDeadline = Date.now() + config.llm.streamIdleTimeoutMs;
    };
    const awaitBeforeProgressDeadline = async <T>(
      promise: PromiseLike<T>,
    ): Promise<T> => {
      if (config.llm.streamIdleTimeoutMs <= 0) return promise;
      const remaining = progressDeadline - Date.now();
      if (remaining <= 0) {
        idleTimedOut = true;
        controller.abort();
        throw new Error('responses stream made no meaningful progress');
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            idleTimedOut = true;
            controller.abort();
            reject(new Error('responses stream made no meaningful progress'));
          }, remaining);
          timer.unref();
        });
        return await Promise.race([Promise.resolve(promise), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let closeIterator: (() => void) | null = null;
    try {
      const baseRequest = {
        ...buildResponsesParams(config, prepared, modelTools),
        ...extraBody,
        stream: true,
      } as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(baseRequest)) {
        if (value === undefined) delete baseRequest[key];
      }
      const request = transformRequest
        ? transformRequest(baseRequest)
        : baseRequest;
      config.logger.info('[llm/responses] stage=request-start');
      const stream = await awaitBeforeProgressDeadline(
        client.responses.create(
          request as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
          { signal: controller.signal },
        ),
      );
      config.logger.info('[llm/responses] stage=stream-acquired');
      requestId = (stream as unknown as { _request_id?: string })._request_id;
      const iterator = stream[Symbol.asyncIterator]();
      let iteratorClosed = false;
      closeIterator = () => {
        if (iteratorClosed) return;
        iteratorClosed = true;
        try {
          const closing = iterator.return?.();
          void Promise.resolve(closing).catch(() => {});
        } catch {
          /* cleanup must not replace the provider result */
        }
      };
      streamLoop: for (;;) {
        const step = await awaitBeforeProgressDeadline(iterator.next());
        if (step.done) {
          iteratorClosed = true;
          break;
        }
        const event = step.value;
        switch (event.type) {
          case 'response.output_text.delta': {
            if (event.delta) markMeaningfulProgress();
            visibleOutputBytes = addStandaloneOutputBytes(
              visibleOutputBytes,
              event.delta,
              maxOutputBytes,
              () => controller.abort(),
            );
            content += event.delta;
            try {
              hub?.streamDelta('content', event.delta);
            } catch {
              /* observer only */
            }
            break;
          }
          case 'response.reasoning_text.delta':
          case 'response.reasoning_summary_text.delta': {
            if (event.delta) markMeaningfulProgress();
            reasoningPreview += event.delta;
            try {
              hub?.streamDelta('reasoning', event.delta);
            } catch {
              /* observer only */
            }
            break;
          }
          case 'response.output_item.added': {
            const item = event.item as {
              type?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
            };
            if (item?.type === 'function_call') {
              markMeaningfulProgress();
              callSlots[event.output_index] = {
                callId: item.call_id,
                name: item.name,
                args: item.arguments ?? '',
              };
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            if (event.delta) markMeaningfulProgress();
            const slot = (callSlots[event.output_index] ??= { args: '' });
            slot.args += event.delta;
            break;
          }
          case 'response.function_call_arguments.done': {
            markMeaningfulProgress();
            const slot = (callSlots[event.output_index] ??= { args: '' });
            slot.args = event.arguments;
            break;
          }
          case 'response.output_item.done': {
            markMeaningfulProgress();
            completedItems.set(event.output_index, event.item);
            break;
          }
          case 'response.completed':
          case 'response.incomplete': {
            markMeaningfulProgress();
            // incomplete (max_output_tokens hit) still carries whatever was
            // generated; surface it like chat's truncated finish rather than
            // erroring the turn.
            finalResponse = event.response;
            break streamLoop;
          }
          case 'response.failed': {
            markMeaningfulProgress();
            failure = failureToError(event.response?.error);
            controller.abort();
            break streamLoop;
          }
          default:
            break;
        }
      }
    } catch (e) {
      if (idleTimedOut) {
        throw classifyError(
          Object.assign(
            new Error(
              `responses stream idle for ${config.llm.streamIdleTimeoutMs}ms`,
            ),
            { status: 504, code: 'stream_idle_timeout' },
          ),
        );
      }
      throw classifyError(e);
    } finally {
      closeIterator?.();
    }

    if (failure) throw classifyError(failure);
    if (!finalResponse) {
      // The stream ended without a terminal event — a dropped connection
      // shape; retriable like any transport failure.
      throw new RetriableError(
        new Error('responses stream ended without a terminal event'),
      );
    }

    const terminalOutput = Array.isArray(finalResponse.output)
      ? finalResponse.output
      : [];
    const streamedOutput = [...completedItems.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item);
    const output =
      streamedOutput.length > 0 ? streamedOutput : [...terminalOutput];

    // Some compatible streams expose function-call deltas/additions but omit
    // both output_item.done and terminal output. Preserve those calls too;
    // the call_id is mandatory because it is the result/replay correlation
    // key. Never duplicate a call already present in authoritative output.
    const parsedOutput = fromResponseOutput(output);
    if (!parsedOutput.toolCalls) {
      for (const [, slot] of Object.entries(callSlots)) {
        if (!slot.callId) continue;
        output.push({
          type: 'function_call',
          call_id: slot.callId,
          name: slot.name ?? '',
          arguments: slot.args,
        });
      }
    }
    const responseForAssembly = { ...finalResponse, output };
    const streamedTextFallback =
      parsedOutput.content || content.length === 0 ? '' : content;
    const result = assembleResult(
      responseForAssembly,
      charsSent,
      streamedTextFallback,
      requestId,
    );
    assertStandaloneOutputBytes(result.message.content ?? '', maxOutputBytes);
    return result;
  } finally {
    try {
      hub?.streamEnd();
    } catch {
      /* observer must never break generation */
    }
  }
}

/** One-shot summarization over the Responses API (the compactor's call).
 * `max_output_tokens` includes reasoning tokens on this surface (unlike chat's
 * max_tokens, which only capped the visible completion), so the cap leaves
 * headroom for the model to think before writing the ~3k-token summary. */
export async function responsesSummarize(
  client: OpenAI,
  config: Config,
  systemPrompt: string,
  text: string,
): Promise<string> {
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: config.llm.model,
    instructions: systemPrompt,
    input: text,
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: 12_000,
  };
  if (config.llm.reasoningEffort) {
    params.reasoning = {
      effort: config.llm.reasoningEffort as OpenAI.ReasoningEffort,
    };
  }
  const resp = await client.responses.create(params);
  // An incomplete response means the summary was cut (max_output_tokens also
  // covers reasoning here) — throw so the guarded summarizer's retry/lastError
  // machinery records the real cause instead of the quality gate blaming the
  // model's prose.
  if (resp.status === 'incomplete') {
    const reason = resp.incomplete_details?.reason ?? 'unknown';
    throw new Error(
      `summarize incomplete (${reason}, content ${fromResponseOutput(resp.output ?? []).content.length} chars)`,
    );
  }
  return fromResponseOutput(resp.output ?? []).content;
}
