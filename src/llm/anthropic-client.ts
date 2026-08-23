// anthropic-client.ts — the Anthropic Messages wire path for a Claude Pro/Max
// subscription (provider_type: 'anthropic-oauth').
//
// This is the third wire surface alongside the OpenAI Chat Completions path
// (llm.ts) and the OpenAI Responses path (responses.ts). It speaks the native
// Anthropic Messages API, which a subscription OAuth token can only drive while
// impersonating Claude Code:
// - Authorization: Bearer <oauth token> (NOT x-api-key)
// - the `oauth-2025-04-20` + `claude-code-…` beta headers, CC User-Agent,
// and `?beta=true`
// - a Claude-Code identity system block as the FIRST system block, plus the
// billing/`cch` fingerprint block CC attaches (see BILLING + patchCch)
//
// It also owns the cache-tier discipline the Anthropic endpoint needs (no
// implicit longest-prefix caching): the system prompt is split via
// segmentSystemPrompt into stable / boundary / perturn tiers with explicit
// cache_control breakpoints, and the last conversation message carries one too.
//
// EXTENDED THINKING is enabled (adaptive) and the signed `thinking` blocks are
// captured, persisted (ChatMessage.thinking_blocks), and REPLAYED VERBATIM on
// every subsequent request — thinking-first within each assistant turn, which
// preserves continuity and satisfies Anthropic's "an assistant tool_use turn
// must carry its thinking" constraint. The readable side also lands in
// `reasoning_content` for console/summarizer visibility (display: summarized).

import { createHash } from 'node:crypto';
import { Agent } from 'undici';
import type { Config } from '../config.js';
import type { ConsoleHub } from '../console/hub.js';
import { segmentSystemPrompt, type SystemTier } from './prompt.js';
import { xxh64 } from './oauth/xxhash.js';
import type { OAuthStore } from './oauth/store.js';
import {
  RUN_TOOL,
  SOCIAL_SUMMARIZE_PROMPT,
  RetriableError,
  NonRetriableError,
  classifyError,
  prepareForApi,
  computeCharsSent,
  sanitizeAssistantMessage,
  type ChatMessage,
  type CompleteOptions,
  type CompleteResult,
  type LLMUsage,
  type RunTool,
  type LLM,
  type AnthropicThinkingBlock,
  type StandaloneCompleteOptions,
  type StandaloneCompleteResult,
} from './llm.js';
import { endpointAt, stampGeneration } from './provenance.js';

// ─── Claude Code fingerprint constants (matched to oh-my-pi's reversed values) ─
const CLAUDE_CODE_VERSION = '2.1.220';
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, claude-desktop)`;
const CLAUDE_CODE_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/** Betas that identify the request as Claude Code + grant OAuth inference.
 * `interleaved-thinking-2025-05-14` lets the model think between tool calls
 * (extended thinking is enabled — see anthropicThinkingParam). */
const ANTHROPIC_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
];

/** Adaptive extended thinking, on by default (required on newer Claude models —
 * omitting it on Opus 5 runs adaptive anyway, and it's the modern replacement
 * for the removed `budget_tokens`). `display: 'summarized'` returns a readable
 * summary in the thinking blocks (captured into `reasoning_content` for the
 * console/summarizer); the block's SIGNATURE is emitted regardless of display
 * and is what the replay path preserves. */
function anthropicThinkingParam(): Record<string, unknown> {
  return { type: 'adaptive', display: 'summarized' };
}
/** CC's per-request output-token ceiling. Anthropic requires `max_tokens`. */
const MAX_OUTPUT_TOKENS = 64000;
// Roomier than the chat path's 12k: on newer models thinking is on by default
// even when we don't send the param, and it shares this budget — a tight cap
// could let thinking truncate the visible summary.
const SUMMARIZE_MAX_TOKENS = 32000;
const ANTHROPIC_VERSION = '2023-06-01';

// Billing header (see createBillingHeader / patchCch). `cch=00000` is a
// placeholder replaced with the real XXH64 attestation before the body is sent.
const BILLING_PREFIX = 'x-anthropic-billing-header:';
const CCH_PLACEHOLDER = 'cch=00000';
const CCH_SEED = 0x4d659218e32a3268n;
const FINGERPRINT_SALT = '59cf53e54c78';

/** CC's per-conversation billing header, injected as the FIRST system block.
 * The `cc_version` carries a 3-hex fingerprint over chars [4,7,20] of the
 * first user message; the `cch` is patched post-serialization (patchCch). */
export function createBillingHeader(firstUserText: string): string {
  const k = [4, 7, 20].map((i) => firstUserText[i] ?? '0').join('');
  const suffix = createHash('sha256')
    .update(`${FINGERPRINT_SALT}${k}${CLAUDE_CODE_VERSION}`)
    .digest('hex')
    .slice(0, 3);
  return `${BILLING_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER};`;
}

/** Replace the `cch=00000` placeholder with XXH64(body-with-placeholder) low
 * 20 bits (5 hex). Hashing the placeholder body then overwriting the 5 chars
 * in place is self-consistent (same length), matching CC / oh-my-pi. Returns
 * the body unchanged when no billing header is present. */
export function patchCch(body: string): string {
  const at = body.indexOf(CCH_PLACEHOLDER);
  if (at < 0) return body;
  const bytes = new TextEncoder().encode(body);
  const cch = (xxh64(bytes, CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0');
  return body.slice(0, at + 4) + cch + body.slice(at + 4 + 5);
}

// ─── Anthropic wire types (only the shapes we build/read) ────────────────────
interface CacheControl {
  type: 'ephemeral';
}
interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}
interface ImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
interface WireMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/** Map one OpenAI-style multimodal content part to an Anthropic content block. */
function imagePartToBlock(url: string): ImageBlock | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (m)
    return {
      type: 'image',
      source: { type: 'base64', media_type: m[1], data: m[2] },
    };
  if (/^https?:\/\//.test(url))
    return { type: 'image', source: { type: 'url', url } };
  return null;
}

/** Convert one ChatMessage into an effective Anthropic role + content blocks.
 * `tool` messages become user `tool_result` blocks; assistant `tool_calls`
 * become `tool_use` blocks. Returns null for a message that contributes no
 * wire content (e.g. an empty ghost assistant message with no tool calls). */
function messageToBlocks(
  m: ChatMessage,
): { role: 'user' | 'assistant'; blocks: ContentBlock[] } | null {
  if (m.role === 'tool') {
    if (!m.tool_call_id) return null;
    const isError = (m.content ?? '')
      .split('\n')
      .some((l) => l.startsWith('[run FAILED'));
    return {
      role: 'user',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content ?? '',
          is_error: isError,
        },
      ],
    };
  }
  if (m.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    // Thinking blocks are replayed VERBATIM and must come FIRST in the turn
    // (before text/tool_use) — the Anthropic constraint for extended thinking +
    // tool use. Their signatures are validated by the endpoint, so they pass
    // through untouched.
    for (const tb of m.thinking_blocks ?? [])
      blocks.push(tb as unknown as ContentBlock);
    if (m.content && m.content.length > 0)
      blocks.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        input = {};
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
    return blocks.length > 0 ? { role: 'assistant', blocks } : null;
  }
  // user (or a stray system message folded into user text, defensively)
  const blocks: ContentBlock[] = [];
  if (m.contentParts) {
    for (const part of m.contentParts) {
      if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
      else if (part.type === 'image_url') {
        const img = imagePartToBlock(part.image_url.url);
        if (img) blocks.push(img);
      }
    }
  } else if (m.content && m.content.length > 0) {
    blocks.push({ type: 'text', text: m.content });
  }
  return blocks.length > 0 ? { role: 'user', blocks } : null;
}

/** Translate the harness message array into Anthropic `system` blocks + a
 * `messages` array. Consecutive same-role messages are coalesced (Anthropic
 * requires strict user/assistant alternation, unlike OpenAI). The leading
 * system message becomes the tiered `system` blocks (with the CC billing +
 * identity blocks prepended). */
export function translate(messages: ChatMessage[]): {
  system: TextBlock[];
  wire: WireMessage[];
} {
  const [first, ...rest] = messages;
  const systemText = first?.role === 'system' ? first.content : '';
  const convo = first?.role === 'system' ? rest : messages;

  // First user text feeds the billing-header fingerprint.
  const firstUser = convo.find((m) => m.role === 'user');
  const firstUserText = firstUser?.content ?? '';

  const system: TextBlock[] = [
    { type: 'text', text: createBillingHeader(firstUserText) },
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
  ];
  // Tiered body with cache breakpoints after the last stable + last boundary block.
  const segments = segmentSystemPrompt(systemText);
  const lastOfTier = (tier: SystemTier): number => {
    let idx = -1;
    segments.forEach((s, i) => {
      if (s.tier === tier) idx = i;
    });
    return idx;
  };
  const stableBreak = lastOfTier('stable');
  const boundaryBreak = lastOfTier('boundary');
  segments.forEach((seg, i) => {
    const block: TextBlock = { type: 'text', text: seg.text };
    if (i === stableBreak || i === boundaryBreak)
      block.cache_control = { type: 'ephemeral' };
    system.push(block);
  });

  // Coalesce consecutive same-role messages.
  const wire: WireMessage[] = [];
  for (const m of convo) {
    const conv = messageToBlocks(m);
    if (!conv) continue;
    const tail = wire[wire.length - 1];
    if (tail && tail.role === conv.role) tail.content.push(...conv.blocks);
    else wire.push({ role: conv.role, content: [...conv.blocks] });
  }
  // Cache breakpoint on the last content block of the last message (incremental
  // history caching). Only text/tool_result blocks accept cache_control.
  const lastMsg = wire[wire.length - 1];
  if (lastMsg) {
    for (let i = lastMsg.content.length - 1; i >= 0; i--) {
      const b = lastMsg.content[i];
      if (b.type === 'text' || b.type === 'tool_result') {
        (
          b as TextBlock | (ToolResultBlock & { cache_control?: CacheControl })
        ).cache_control = { type: 'ephemeral' };
        break;
      }
    }
  }
  return { system, wire };
}

/** The `run` tool in Anthropic's `{name, description, input_schema}` shape.
 * Derived lazily: llm.ts ⇄ anthropic-client.ts import each other, so reading
 * RUN_TOOL at this module's load time could hit the TDZ (matches responses.ts). */
function anthropicRunTool(runTool: RunTool = RUN_TOOL): {
  name: string;
  description: string;
  input_schema: unknown;
} {
  return {
    name: runTool.function.name,
    description: runTool.function.description,
    input_schema: runTool.function.parameters,
  };
}

// Raise undici's 300s default body/headers timeout — a long Claude generation
// can pause between chunks while it reasons (mirrors llm.ts's OpenAI client).
const dispatcher = new Agent({
  bodyTimeout: 1_200_000,
  headersTimeout: 1_200_000,
});

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function toLLMUsage(u: AnthropicUsage): LLMUsage {
  const input = u.input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const prompt = input + cacheRead + cacheCreate;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    // Anthropic reports cache reads directly; matches the harness's
    // `cached_tokens` = "served from prefix cache" contract.
    cached_tokens:
      u.cache_read_input_tokens === undefined ? undefined : cacheRead,
  };
}

async function postAnthropic(
  config: Config,
  store: OAuthStore,
  body: Record<string, unknown>,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const token = await store.getAccessToken();
  const url = `${config.llm.baseUrl.replace(/\/+$/, '')}/v1/messages?beta=true`;
  const serialized = patchCch(JSON.stringify(body));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETAS.join(','),
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      'User-Agent': CLAUDE_CODE_USER_AGENT,
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: serialized,
    signal,
    dispatcher,
  } as RequestInit & { dispatcher: Agent });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // A 401 usually means the access token expired between the store's skew
    // check and the request — force a refresh so the retry uses a fresh token.
    if (res.status === 401) {
      await store.forceRefresh().catch(() => {});
      throw new RetriableError(new Error(`anthropic 401: ${text}`));
    }
    const err = Object.assign(new Error(`anthropic ${res.status}: ${text}`), {
      status: res.status,
    });
    throw classifyError(err);
  }
  return res;
}

/** Streaming completion over Anthropic SSE. */
async function anthropicComplete(
  config: Config,
  store: OAuthStore,
  messages: ChatMessage[],
  hub: ConsoleHub | undefined,
  options: {
    toolFree?: boolean;
    signal?: AbortSignal;
    runTool?: RunTool;
    toolChoice?: 'required' | 'auto';
  } = {},
): Promise<CompleteResult> {
  try {
    try {
      hub?.streamStart();
    } catch {
      /* observer only */
    }

    const prepared = prepareForApi(messages);
    const charsSent = computeCharsSent(prepared, false);
    const { system, wire } = translate(prepared);
    const body: Record<string, unknown> = {
      model: config.llm.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: wire,
      ...(options.toolFree
        ? {}
        : {
            tools: [anthropicRunTool(options.runTool)],
            tool_choice: {
              type: options.toolChoice === 'required' ? 'any' : 'auto',
              disable_parallel_tool_use: true,
            },
          }),
      thinking: anthropicThinkingParam(),
      stream: true,
    };
    // Effort (`output_config.effort`) is the primary intelligence/cost knob on
    // Claude — driven by `llm.reasoning_effort` (low|medium|high|xhigh|max;
    // default 'high'). Claude Code sends this same field, so the OAuth/CC
    // surface accepts it — but it's the one request field unverifiable without
    // a live call, so `reasoning_effort: none` is an escape hatch that omits
    // `output_config` entirely should the endpoint ever reject it.
    if (config.llm.reasoningEffort && config.llm.reasoningEffort !== 'none') {
      body.output_config = { effort: config.llm.reasoningEffort };
    }

    let content = '';
    let reasoning = '';
    const toolBlocks: Record<
      number,
      { id?: string; name?: string; json: string }
    > = {};
    // Thinking blocks (with signatures), accumulated per stream index and
    // replayed verbatim next turn. Keyed by index to preserve order.
    const thinkingAcc: Record<number, AnthropicThinkingBlock> = {};
    let usage: AnthropicUsage = {};
    let requestId: string | undefined;
    const controller = new AbortController();
    if (options.signal?.aborted) controller.abort();
    else
      options.signal?.addEventListener('abort', () => controller.abort(), {
        once: true,
      });

    try {
      const res = await postAnthropic(
        config,
        store,
        body,
        true,
        controller.signal,
      );
      requestId =
        res.headers.get('request-id') ??
        res.headers.get('x-request-id') ??
        undefined;
      for await (const evt of parseSSE(res, controller.signal)) {
        if (evt.type === 'message_start') {
          const u = (evt.message as { usage?: AnthropicUsage } | undefined)
            ?.usage;
          if (u) usage = { ...usage, ...u };
        } else if (evt.type === 'content_block_start') {
          const cb = evt.content_block as
            | {
                type?: string;
                id?: string;
                name?: string;
                data?: string;
                thinking?: string;
                signature?: string;
              }
            | undefined;
          const idx = evt.index as number;
          if (cb?.type === 'tool_use')
            toolBlocks[idx] = { id: cb.id, name: cb.name, json: '' };
          else if (cb?.type === 'thinking')
            thinkingAcc[idx] = {
              type: 'thinking',
              thinking: cb.thinking ?? '',
              signature: cb.signature ?? '',
            };
          else if (cb?.type === 'redacted_thinking')
            thinkingAcc[idx] = {
              type: 'redacted_thinking',
              data: cb.data ?? '',
            };
        } else if (evt.type === 'content_block_delta') {
          const idx = evt.index as number;
          const d = evt.delta as
            | {
                type?: string;
                text?: string;
                thinking?: string;
                signature?: string;
                partial_json?: string;
              }
            | undefined;
          if (d?.type === 'text_delta' && d.text) {
            content += d.text;
            try {
              hub?.streamDelta('content', d.text);
            } catch {
              /* observer only */
            }
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            reasoning += d.thinking;
            const tb = thinkingAcc[idx];
            if (tb && tb.type === 'thinking') tb.thinking += d.thinking;
            try {
              hub?.streamDelta('reasoning', d.thinking);
            } catch {
              /* observer only */
            }
          } else if (d?.type === 'signature_delta' && d.signature) {
            const tb = thinkingAcc[idx];
            if (tb && tb.type === 'thinking') tb.signature += d.signature;
          } else if (
            d?.type === 'input_json_delta' &&
            d.partial_json !== undefined
          ) {
            const slot = toolBlocks[idx];
            if (slot) {
              slot.json += d.partial_json;
            }
          }
        } else if (evt.type === 'message_delta') {
          const u = (evt as { usage?: AnthropicUsage }).usage;
          if (u) usage = { ...usage, ...u };
        }
      }
    } catch (e) {
      throw e instanceof RetriableError || e instanceof NonRetriableError
        ? e
        : classifyError(e);
    }

    // Assemble tool calls; arguments must be the JSON string the run tool expects.
    const tool_calls = Object.keys(toolBlocks)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => toolBlocks[i])
      .filter((t) => t.id)
      .map((t) => ({
        id: t.id as string,
        type: 'function' as const,
        function: { name: t.name ?? 'run', arguments: t.json || '{}' },
      }));

    const sanitized = sanitizeAssistantMessage({
      content,
      reasoning_content: reasoning || undefined,
      tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
    });
    // Attach the captured thinking blocks (in stream order) for verbatim replay.
    const thinkingBlocks = Object.keys(thinkingAcc)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => thinkingAcc[i]);
    if (thinkingBlocks.length > 0)
      sanitized.message.thinking_blocks = thinkingBlocks;
    return {
      message: sanitized.message,
      stripped: sanitized.stripped,
      usage: toLLMUsage(usage),
      promptChars: charsSent,
      ...(requestId ? { requestId } : {}),
    };
  } finally {
    try {
      hub?.streamEnd();
    } catch {
      /* observer only */
    }
  }
}

async function anthropicSummarize(
  config: Config,
  store: OAuthStore,
  text: string,
  systemPrompt = SOCIAL_SUMMARIZE_PROMPT,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.llm.model,
    max_tokens: SUMMARIZE_MAX_TOKENS,
    system: [
      { type: 'text', text: createBillingHeader(text) },
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: systemPrompt },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    stream: false,
  };
  const res = await postAnthropic(config, store, body, false);
  const data = (await res.json()) as {
    stop_reason?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      'summarize truncated by max_tokens (anthropic stop_reason=max_tokens)',
    );
  }
  return (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Parse an Anthropic SSE Response body into `data:` JSON events. */
async function* parseSSE(
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const body = res.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  // Node's fetch body is a web ReadableStream (async-iterable in Node ≥18).
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    if (signal.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || payload === '') continue;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          /* skip malformed */
        }
      }
    }
  }
}

/** Known context windows (tokens) for current Claude models, keyed by an id
 * substring. Subscription tokens can't drive `/models/info`, so the harness
 * maps them here; `llm.context_size` overrides everything. */
export function anthropicContextWindow(model: string): number | undefined {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 200_000;
  // Opus/Sonnet/Fable 4.6+ and 5-family all serve a 1M window.
  if (
    m.includes('opus') ||
    m.includes('sonnet') ||
    m.includes('fable') ||
    m.includes('mythos')
  )
    return 1_000_000;
  return undefined;
}

/** Build an {@link LLM} backed by a Claude subscription over OAuth. Satisfies
 * the same interface as the OpenAI-backed client (minus the OpenAI `client`
 * handle, which nothing outside llm.ts consumes). */
export function createAnthropicOAuthLLM(
  config: Config,
  store: OAuthStore,
  hub: ConsoleHub | undefined,
): LLM {
  config.logger.info(
    `llm: using the Anthropic Messages surface (Claude subscription OAuth) | model=${config.llm.model}`,
  );
  const identity = store.read();
  if (identity?.email)
    config.logger.info(
      `llm: anthropic account ${identity.email}${identity.orgName ? ` (${identity.orgName})` : ''}`,
    );
  return {
    model: config.llm.model,
    runTool: RUN_TOOL,
    async completeStandalone(
      messages: ChatMessage[],
      opts: StandaloneCompleteOptions = {},
    ): Promise<StandaloneCompleteResult> {
      if (opts.tools !== undefined)
        throw new Error(
          'Anthropic standalone completion does not support caller-defined native tools',
        );
      if (
        messages.some(
          (message) =>
            message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0,
        )
      ) {
        throw new Error(
          'standalone completion does not accept tool messages or tool calls',
        );
      }
      if (opts.model && opts.model !== config.llm.model) {
        throw new Error(
          `standalone model must use the configured role target ${config.llm.model}`,
        );
      }
      const isolated =
        opts.reasoningEffort === undefined
          ? config
          : {
              ...config,
              llm: { ...config.llm, reasoningEffort: opts.reasoningEffort },
            };
      const result = await anthropicComplete(
        isolated,
        store,
        messages,
        undefined,
        { toolFree: true, signal: opts.signal },
      );
      return {
        content: result.message.content ?? '',
        ...(result.message.reasoning_content
          ? { reasoningContent: result.message.reasoning_content }
          : {}),
        usage: result.usage,
        ...(result.requestId ? { requestId: result.requestId } : {}),
        model: isolated.llm.model,
        providerType: 'anthropic-oauth',
        apiSurface: 'anthropic-messages',
        apiEndpoint: endpointAt(isolated.llm.baseUrl, 'v1/messages'),
        ...(isolated.llm.reasoningEffort
          ? { reasoningEffort: isolated.llm.reasoningEffort }
          : {}),
      };
    },
    async complete(
      messages: ChatMessage[],
      options: CompleteOptions = {},
    ): Promise<CompleteResult> {
      const result = await anthropicComplete(config, store, messages, hub, {
        signal: options.signal,
        runTool: options.runTool,
        toolChoice: options.toolChoice,
      });
      stampGeneration(result.message, {
        providerType: 'anthropic-oauth',
        model: config.llm.model,
        apiSurface: 'anthropic-messages',
        apiEndpoint: endpointAt(config.llm.baseUrl, 'v1/messages'),
        reasoningEffort: config.llm.reasoningEffort ?? undefined,
        requestId: result.requestId,
      });
      return result;
    },
    async summarize(text: string, systemPrompt?: string): Promise<string> {
      return anthropicSummarize(config, store, text, systemPrompt);
    },
  };
}
