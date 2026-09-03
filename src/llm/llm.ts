// llm.ts — OpenAI-compatible client + the model-facing tool definitions.
//
// `run` is the normal tool. An explicitly gated `think` tool may join it on the
// Codex Responses path to externalize intermediate reasoning while native reasoning is off.
// Every completion response carries `response.usage` — the authoritative measure
// of how full the context is (tokenizer-agnostic, includes system prompt + tool
// schemas).
//
// Two API surfaces, one client: `createLLM` prefers the OpenAI Responses API
// (src/llm/responses.ts — reasoning-preserving via encrypted reasoning items)
// and falls back to the legacy Chat Completions path in this file for
// endpoints that don't implement the route (`llm.api`: 'auto' | 'responses' |
// 'chat'). Everything downstream — sanitizer contract, usage shape, diet,
// streaming, sanitizer, usage, and request-diet contracts are shared; only the wire format differs.

import OpenAI from 'openai';
import { Agent } from 'undici';
import type { DatabaseSync } from 'node:sqlite';
import { configForLlmRole, type Config } from '../config.js';
import type { LlmRole } from './model-registry.js';
import type { ConsoleHub } from '../console/hub.js';
// llm.ts ⇄ responses.ts import each other (this module routes to the Responses
// path; that module reuses this one's helpers). Safe in ESM because every
// cross-use happens at call time, never at module-evaluation time (responses.ts
// derives its run tool lazily for exactly this reason).
import {
  isResponsesUnsupported,
  responsesSummarize,
  streamResponsesComplete,
  type ReasoningItemParam,
} from './responses.js';
// Anthropic subscription (OAuth) path. Imported at top level but only invoked
// inside createLLM (call time); anthropic-client.ts derives its run tool lazily
// so this cross-import never reads an llm.ts export at module-load time.
import {
  createAnthropicOAuthLLM,
  anthropicContextWindow,
} from './anthropic-client.js';
import { OAuthStore } from './oauth/store.js';
import { refreshAnthropicToken } from './oauth/anthropic.js';
import {
  OPENAI_CODEX_CREDENTIAL_KEY,
  refreshOpenAICodexToken,
} from './oauth/openai-codex.js';
import {
  createCodexOAuthLLM,
  fetchCodexContextWindow,
} from './codex-client.js';
import {
  endpointAt,
  stampGeneration,
  type ApiSurface,
  type GenerationProvenance,
  type ProviderType,
} from './provenance.js';
import type { RunMessageMetadata } from '../sandbox/metadata.js';
import {
  MAX_SKILLS_PER_CALL,
  type ContextResourceDescriptor,
} from '../context-resources.js';
import { isPolicyDenial } from './policy-flight-recorder.js';

export type { GenerationProvenance } from './provenance.js';

export type { ReasoningItemParam } from './responses.js';

/** An Anthropic extended-thinking block as returned by the Messages API and
 * replayed verbatim. Two variants: a signed `thinking` block, and an opaque
 * `redacted_thinking` block. Stored/replayed as received — the signature is
 * validated by the endpoint, so the content must not be modified. */
export type AnthropicThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content of the message. Always present for storage/transcript compatibility. */
  content: string;
  /** For user messages with images, the OpenAI-compatible content parts to send to the API.
   * When present, the API receives this array instead of the plain content string. */
  contentParts?: OpenAI.ChatCompletionContentPart[];
  /** Ephemeral multimodal message (watch-mode frames): contentParts are sent to the
   * API for exactly one generation, then stripped from history; the transcript
   * persists only the text content (plus a placeholder note). */
  ephemeral?: boolean;
  /** Reasoning-model chain-of-thought (the separate `reasoning_content` field
   * returned by Kimi/DeepSeek-style endpoints). Captured so the model's
   * thinking persists across turns, survives restarts (via the transcript),
   * and is visible to the compactor. Sent back to the API on subsequent turns
   * so reasoning models maintain thinking continuity. Undefined for non-
   * reasoning models and for non-assistant roles. */
  reasoning_content?: string;
  /** Responses-API reasoning items (encrypted chain-of-thought) from the
   * response that produced this assistant message. Stored verbatim, persisted
   * to the transcript, and replayed in EVERY subsequent Responses request —
   * the diet's reasoning strip (3a) deliberately does not touch them, because
   * preserved reasoning is the Responses path's continuity mechanism (the
   * endpoint's `reasoning.context` decides how much actually renders). Never
   * sent on the Chat Completions path (toApiMessage ignores it). On this path
   * `reasoning_content` still carries the human-readable side (summary/raw
   * reasoning text) for the console + summarizer, but is display-only. */
  reasoning_items?: ReasoningItemParam[];
  /** Anthropic extended-thinking blocks (with signatures) from the response
   * that produced this assistant message — the native-Messages analog of
   * `reasoning_items`. Replayed VERBATIM (and thinking-first) on the Anthropic
   * OAuth path so thinking continuity holds and the "assistant tool_use turn
   * must preserve its thinking" API constraint is satisfied. Never sent on the
   * OpenAI paths (toApiMessage ignores it). Persisted + restored like
   * reasoning_items and, being replayed every request, exempt from the diet's
   * reasoning strip (prepareForApi preserves it) and counted by sentChars.
   * The readable side of the same thinking still lands in `reasoning_content`
   * for console/summarizer visibility. */
  thinking_blocks?: AnthropicThinkingBlock[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /** Provenance stamp: the Discord channel id this message
   * belongs to, or 'internal'/'harness' for beat/harness traffic. Persisted to
   * the transcript for offline forensics + a future dashboard; NEVER sent to the
   * API (toApiMessage builds a fresh object). Replay ignores it. */
  channel?: string;
  /** Harness-only person-context marker. `inbound` identifies a raw person
   * message; `memory` marks the synthetic profile injected for that identity.
   * Persisted for restart/compaction reconciliation and never sent as metadata
   * to a provider (the message content itself is the intended model input). */
  personContext?: {
    kind: 'inbound' | 'memory';
    authorId: string;
    author: string;
  };
  /** For a `tool` message: the channel().send() calls made during that run,
   * recorded harness-side (literal channel + text). Rendered verbatim when the
   * result is aged down at request-assembly time so the agent's outbound speech
   * survives even after the tool payload is stubbed. Persisted;
   * never sent to the API. */
  sends?: { channel: string; text: string }[];
  /** Out-of-band generation attribution. Persisted for forensic/data use, but
   * deliberately ignored by every provider request translator. */
  provenance?: GenerationProvenance;
  /** Harness-only run execution/wake attribution for tool results. Persisted and
   * restored for replay/console/diagnostics; provider translators ignore it. */
  run?: RunMessageMetadata;
  /** Harness-only loaded resource descriptors. Content is already in this message. */
  contextResources?: ContextResourceDescriptor[];
}

export interface LLMUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Prompt tokens served from the provider's prefix cache. OpenAI-compat
   * (`prompt_tokens_details.cached_tokens`). `undefined` — never 0 — when the
   * provider reports nothing, so cache stats can tell "no hit" from
   * "unsupported". There is no cache-WRITE counterpart in OpenAI-compat. */
  cached_tokens?: number;
}

export interface StandaloneCompleteOptions {
  /** Provider cache/conversation identity for this isolated lane. Omit for a fresh one-shot lane. */
  cacheKey?: string;
  /** Optional provider model override for a controlled standalone comparison. */
  model?: string;
  /** Optional reasoning-effort override for a controlled standalone comparison. */
  reasoningEffort?: string;
  /** Native function tools for a new isolated Chat Completions generation. */
  tools?: OpenAI.ChatCompletionTool[];
  toolChoice?: OpenAI.ChatCompletionToolChoiceOption;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  chatTemplateKwargs?: Record<string, unknown>;
  /** Replay a closed historical function-call/output chain. */
  allowHistoricalToolMessages?: boolean;
  /** Abort the provider request and response stream. */
  signal?: AbortSignal;
}

export interface StandaloneCompleteResult {
  content: string;
  reasoningContent?: string;
  toolCalls?: ChatMessage['tool_calls'];
  /** Raw Responses reasoning output items, encrypted_content included, for stateless replay. */
  reasoningItems?: ReasoningItemParam[];
  usage: LLMUsage;
  requestId?: string;
  model?: string;
  providerType?: ProviderType;
  apiSurface?: ApiSurface;
  apiEndpoint?: string;
  reasoningEffort?: string;
}

/** Pull the cached-prompt-token count out of a raw provider `usage` object.
 * Kimi speaks OpenAI-compat, so there is exactly ONE shape to read:
 * `usage.prompt_tokens_details.cached_tokens`. Anything else — missing field,
 * missing parent, non-numeric, NaN — yields `undefined` rather than 0, because
 * downstream cache stats treat `undefined` as "provider reports nothing"
 * (widget hidden, bust detection off) and 0 as a real 100%-miss turn.
 * Exported for direct unit testing. */
export function extractCacheTokens(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const details = (usage as { prompt_tokens_details?: unknown })
    .prompt_tokens_details;
  if (typeof details !== 'object' || details === null) return undefined;
  const cached = (details as { cached_tokens?: unknown }).cached_tokens;
  return typeof cached === 'number' && Number.isFinite(cached)
    ? cached
    : undefined;
}

/** Wraps an LLM failure that may succeed on retry (network, 429, 5xx). */
export class RetriableError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RetriableError';
  }
}

/** Wraps an LLM failure that will fail identically if retried (4xx, malformed schema). */
export class NonRetriableError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'NonRetriableError';
  }
}

/** Classify a provider error into Retriable/NonRetriable. Exported for the
 * Responses path (responses.ts), which shares the retry contract. */
export function classifyError(e: unknown): RetriableError | NonRetriableError {
  if (isPolicyDenial(e)) return new NonRetriableError(e);
  if (e && typeof e === 'object') {
    const status =
      'status' in e && typeof e.status === 'number' ? e.status : undefined;
    const code = 'code' in e && typeof e.code === 'string' ? e.code : undefined;
    const name = 'name' in e && typeof e.name === 'string' ? e.name : '';
    if (
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 422
    ) {
      return new NonRetriableError(e);
    }
    if (
      status === 429 ||
      (status && status >= 500) ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      name.includes('APIConnection') ||
      name.includes('Timeout')
    ) {
      return new RetriableError(e);
    }
  }
  // Unknown errors default to retriable; the SDK already filters most non-retriables.
  return new RetriableError(e);
}
/** Convert our ChatMessage (with optional multimodal contentParts) into an OpenAI SDK message param.
 * Exported so `Agent.contextSnapshot` (the console's context-explorer view) can
 * render the EXACT wire shape a request would carry — harness-only stamps
 * (`channel`, `sends`, `ephemeral`) are dropped here by construction. */
export function toApiMessage(
  m: ChatMessage,
): OpenAI.ChatCompletionMessageParam {
  const base: OpenAI.ChatCompletionMessageParam = {
    role: m.role,
    content: m.contentParts ?? m.content,
  } as OpenAI.ChatCompletionMessageParam;
  if (m.role === 'assistant' && m.tool_calls) {
    (base as OpenAI.ChatCompletionAssistantMessageParam).tool_calls =
      m.tool_calls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
  }
  if (m.role === 'tool' && m.tool_call_id) {
    (base as OpenAI.ChatCompletionToolMessageParam).tool_call_id =
      m.tool_call_id;
  }
  if (m.role === 'assistant' && m.reasoning_content) {
    (base as { reasoning_content?: string }).reasoning_content =
      m.reasoning_content;
  }
  return base;
}

/** Spread `reasoning_effort` onto a request body when the endpoint is
 * configured for it (`config.llm.reasoningEffort`); otherwise return `base`
 * unchanged. Shared by the three request-body builders (streaming complete,
 * non-streaming complete, summarize) so the opt-in stays in one place. */
function withEffort<T extends object>(
  config: Config,
  base: T,
): T & { reasoning_effort?: string } {
  return config.llm.reasoningEffort
    ? { ...base, reasoning_effort: config.llm.reasoningEffort }
    : base;
}

// ─── Request projection ───────────────────────────────────────
// This NON-DESTRUCTIVE transform changes only what is SENT, never what is
// stored. Transcript, in-memory history, and serializeHistory (the summarizer's
// view) always see full content.
//
// Strip prior-turn reasoning_content from COMPLETED turns; keep it on the
// current open tool chain. Responses-API `reasoning_items` are deliberately NOT
// stripped — replaying them preserves thinking across turns. The boundary is
// the last assistant message that ENDED a turn, not the last user message,
// because a user message can land mid-chain under monocontext.

/** Pre-division char count of a single message AS SENT — content + role length +
 * 4 + tool-call `arguments` lengths. `reasoning_content` is deliberately
 * excluded (matches what `prepareForApi` sends: the projection strips it on
 * completed turns and it is display-only on the Responses path).
 * `reasoning_items` are counted by default (encrypted blob + readable text
 * lengths) — they are replayed on every Responses request, so excluding them
 * would make the estimate, the compactor's keep-boundary walk, and the
 * density calibration numerator all disagree with what's actually sent. The
 * CHAT path passes `includeReasoningItems: false` for its density numerator
 * (`computeCharsSent`): `toApiMessage` never sends the items, and a history
 * that carries them can land on the chat path (transcript restored after a
 * flip, or `llm.api: chat` forced after running Responses) — training the
 * density EWMA on chars that were never sent would drift the ratio toward
 * the clamp. The compactor/context-tracker consumers keep the default (they
 * can't know the live surface; counting errs toward earlier compaction, the
 * safe direction). Shared numerator for the estimate and for the density
 * calibration signal (charsSent). */
export function sentChars(
  m: ChatMessage,
  includeReasoningItems = true,
): number {
  let chars = (m.content?.length ?? 0) + m.role.length + 4;
  for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length;
  if (includeReasoningItems) {
    for (const r of m.reasoning_items ?? []) chars += reasoningItemChars(r);
  }
  // Anthropic thinking blocks are replayed on every request (like
  // reasoning_items), so count them regardless of the reasoning-item flag —
  // they are absent (0) on the OpenAI paths.
  for (const b of m.thinking_blocks ?? []) {
    chars +=
      b.type === 'thinking'
        ? b.thinking.length + b.signature.length
        : b.data.length;
  }
  return chars;
}

/** Char weight of one stored Responses reasoning item as replayed: the
 * encrypted blob plus any readable summary/reasoning text. Shared by
 * `sentChars` (per-message) and context-tracker's own sum-then-ceil variant. */
export function reasoningItemChars(r: ReasoningItemParam): number {
  let chars = r.encrypted_content?.length ?? 0;
  for (const s of r.summary ?? []) chars += s.text?.length ?? 0;
  for (const c of r.content ?? []) chars += c.text?.length ?? 0;
  return chars;
}

/** char-per-token token estimate of a single message AS SENT. `ratio` is the
 * calibrated chars-per-token (default 4 = the legacy char/4).
 * `reasoning_content` is deliberately excluded: this encodes the "AS SENT,
 * reasoning excluded" contract shared by the compaction trigger (the
 * keep-boundary walk in compactor.ts) and the between-calls context-tracker
 * estimate — all three need to agree on what `prepareForApi` actually sends,
 * not what's stored in history. Exported so compactor.ts and
 * context-tracker.ts share one implementation instead of three that can
 * drift apart. */
export function estimateSentTokens(m: ChatMessage, ratio = 4): number {
  return Math.ceil(sentChars(m) / ratio);
}

/** First line of a tool result beginning `[run` — the status line `formatRunResult`
 * (`src/agent.ts`) writes (`[run ok…]` on success, `[run FAILED]` on failure). A
 * generated prose can precede a tool call, so this
 * scans for the marker rather than assuming `lines[0]`. `endsTurn` uses it to
 * distinguish a successful run from a failed one. */
function toolStatusLine(content: string): string {
  const lines = (content ?? '').split('\n');
  return lines.find((l) => l.startsWith('[run')) ?? lines[0] ?? '';
}

/** True when `messages[i]` is an assistant message that yielded a turn.
 * Current transcripts record the final run's wake lifecycle on its matching
 * tool result. A wake that reached a durable Scheduler task remains a boundary
 * after it fires or is preempted by external input. Rejected, elapsed, and
 * pre-arm preemptions are continuations. Natural no-tool endings and successful
 * legacy `end: true` calls remain recognised only for restored old history. */
export function endsTurn(messages: ChatMessage[], i: number): boolean {
  const message = messages[i];
  if (message.role !== 'assistant') return false;
  if (!message.tool_calls || message.tool_calls.length === 0) return true;
  const last = message.tool_calls[message.tool_calls.length - 1];
  let toolResult: ChatMessage | undefined;
  for (let j = i + 1; j < messages.length; j++) {
    const candidate = messages[j];
    if (candidate.role === 'assistant') break;
    if (candidate.role === 'tool' && candidate.tool_call_id === last.id) {
      toolResult = candidate;
      break;
    }
  }
  if (!toolResult) return false;
  const wake = toolResult.run?.wake;
  if (
    toolResult.run?.ok &&
    wake?.taskId !== undefined &&
    (wake.state === 'armed' ||
      wake.state === 'preempted' ||
      wake.state === 'fired')
  )
    return true;

  let legacyEnd = false;
  try {
    const parsed = JSON.parse(last.function.arguments || '{}') as unknown;
    legacyEnd =
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).end === true;
  } catch {
    /* malformed legacy call */
  }
  return (
    legacyEnd && toolStatusLine(toolResult.content ?? '').startsWith('[run ok')
  );
}

/** Strip completed-turn reasoning from the provider projection. Returns a new
 * array without mutating stored messages; unchanged messages retain identity. */
export function prepareForApi(messages: ChatMessage[]): ChatMessage[] {
  let reasoningBoundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (endsTurn(messages, i)) {
      reasoningBoundary = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (!m.reasoning_content || i > reasoningBoundary) return m;
    const { reasoning_content: _drop, ...rest } = m;
    return rest;
  });
}

export interface RunTool {
  type: 'function';
  function: {
    name: 'run';
    description: string;
    parameters: {
      type: 'object';
      properties: {
        code: { type: 'string'; description: string };
        detail: { type: 'string'; description: string; maxLength: 120 };
        sandbox?: { type: 'string'; description: string };
        wake?: {
          type: 'object';
          description: string;
          properties: {
            after: {
              anyOf: [{ type: 'string' }, { type: 'number' }];
              description: string;
            };
            at: { type: 'string'; description: string };
            auto: { type: 'boolean'; enum: [true]; description: string };
          };
          oneOf: [
            { required: ['after'] },
            { required: ['at'] },
            { required: ['auto'] },
          ];
          additionalProperties: false;
        };
      };
      required: ['code', 'detail'];
      additionalProperties: false;
    };
  };
}

export const RUN_TOOL: RunTool = {
  type: 'function',
  function: {
    name: 'run',
    description:
      'Run JavaScript in a fresh core sandbox by default, or continue a Mind item persistently by selecting its full elm-* id, unique prefix, or exact title. Valid persistent code is pre-parsed before first-use workspace creation. ' +
      'Returns a capped preview plus console output. Omit wake to continue this model turn; a valid ' +
      'wake on a successful run yields and schedules one self-wake.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to execute.' },
        detail: {
          type: 'string',
          maxLength: 120,
          description:
            'Required single-line description of the intended effect: 1 to 10 words.',
        },
        sandbox: {
          type: 'string',
          description:
            'Exact alias of a persistent full-capability sandbox. Omit for a fresh core-only ephemeral run.',
        },
        wake: {
          type: 'object',
          description:
            'Yield after success and wake once later. Omit wake while actionable work remains; auto is a yield, not a continuation mechanism. Once genuinely yielding, prefer auto whenever timing is uncertain; use after/at only for a concrete intended time. Explicit waits must be positive and at most 1h; longer exact waits belong in Scheduler.',
          properties: {
            after: {
              anyOf: [{ type: 'string' }, { type: 'number' }],
              description:
                'Concrete delay after successful code completion, e.g. "5m" or milliseconds; at most 1h.',
            },
            at: {
              type: 'string',
              description:
                'Concrete future ISO-8601 timestamp with timezone, no more than 1h away.',
            },
            auto: {
              type: 'boolean',
              enum: [true],
              description:
                'Ask the fresh classifier-role wake advisor to choose 0, 1, 2, 5, 10, 15, 30, 45, or 60 minutes from bounded live state; 0 means continue immediately, never no future wake.',
            },
          },
          oneOf: [
            { required: ['after'] },
            { required: ['at'] },
            { required: ['auto'] },
          ],
          additionalProperties: false,
        },
      },
      required: ['code', 'detail'],
      additionalProperties: false,
    },
  },
};

export interface SkillTool {
  type: 'function';
  function: {
    name: 'skill';
    description: string;
    parameters: {
      type: 'object';
      properties: {
        names: {
          type: 'array';
          description: string;
          items: { type: 'string'; maxLength: 64 };
          minItems: 1;
          maxItems: number;
        };
      };
      required: ['names'];
      additionalProperties: false;
    };
  };
}

export const SKILL_TOOL: SkillTool = {
  type: 'function',
  function: {
    name: 'skill',
    description:
      'Load one or more named SKILL.md instruction bodies into the current model context. This must be the only tool call in the response: load first, inspect the returned instructions, then call run in a later response.',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          description: 'Skill names to load before taking further action.',
          items: { type: 'string', maxLength: 64 },
          minItems: 1,
          maxItems: MAX_SKILLS_PER_CALL,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
  },
};

export interface ThinkTool {
  type: 'function';
  function: {
    name: 'think';
    description: string;
    parameters: {
      type: 'object';
      properties: { thoughts: { type: 'string'; description: string } };
      required: ['thoughts'];
      additionalProperties: false;
    };
  };
}

export const THINK_TOOL: ThinkTool = {
  type: 'function',
  function: {
    name: 'think',
    description:
      'Record materially new intermediate reasoning before continuing. The text is retained in ' +
      'the local trace for your own continuation and inspection, but is not sent to chat channels.',
    parameters: {
      type: 'object',
      properties: {
        thoughts: {
          type: 'string',
          description:
            'Unpolished scratchpad reasoning to carry into the next response.',
        },
      },
      required: ['thoughts'],
      additionalProperties: false,
    },
  },
};

export function activeModelTools(
  externalThinking: boolean,
  runTool: RunTool = RUN_TOOL,
  skillTool?: SkillTool,
): Array<RunTool | SkillTool | ThinkTool> {
  return [
    runTool,
    ...(skillTool ? [skillTool] : []),
    ...(externalThinking ? [THINK_TOOL] : []),
  ];
}

const EXTERNAL_THINKING_JUICE: Record<string, number> = {
  none: 0,
  minimal: 2,
  low: 4,
  medium: 8,
  high: 48,
  xhigh: 112,
  max: 960,
};

export function externalThinkingJuice(
  effort: string | null | undefined,
): number {
  return effort ? (EXTERNAL_THINKING_JUICE[effort] ?? 8) : 8;
}

/** Chars of a full request AS SENT:
 Σ sentChars over the dieted messages (the
 * system message is messages[0], so it's included) PLUS the tool-schema JSON.
 * This is the numerator of the density calibration sample; `usage.prompt_tokens`
 * (the denominator) includes the tool schema, so this must too. */
export function computeCharsSent(
  messages: ChatMessage[],
  includeReasoningItems = true,
  externalThinking = false,
  tools: readonly unknown[] = activeModelTools(externalThinking),
): number {
  let chars = JSON.stringify(tools).length;
  for (const m of messages) chars += sentChars(m, includeReasoningItems);
  return chars;
}

// Models behind OpenAI-compatible endpoints don't always behave. Two failure
// modes observed from reasoning models (notably umans-kimi-k2.7) that would
// otherwise poison the conversation permanently:
//
// 1. Leaked chain-of-thought in `content`: the model emits proprietary markers
// like `<|tool_calls_section_begin|>` or raw reasoning into `content`
// instead of the separate `reasoning_content` field. `reasoning_effort`
// usually prevents this but does not guarantee it. Once in `messages`, the
// reasoning is echoed back to the user (via the loop's `send(content)`) and
// re-sent to the model every turn.
//
// 2. Malformed `tool_calls[].function.arguments`: the model stuffs its CoT
// into the `arguments` string as `{"code": "<reasoning with raw newlines>"}`.
// The raw control chars (0x00-0x1f) break the server's nested-JSON parse of
// `arguments` on the NEXT request -> `400 unexpected control character` at
// the offset of the first raw newline, every turn, until the context clears.
// `JSON.stringify` escapes the raw chars in the outer body, so the outer
// body is valid JSON -- but the server restores the `arguments` string and
// re-parses it as JSON per the tool-call spec, where the raw control char
// is invalid.
//
// `sanitizeAssistantMessage` is the single ingestion chokepoint: it runs on
// every model response in `complete` BEFORE the message is returned (and thus
// before it enters `messages` or the transcript). Dropping a bad tool call here
// means the stored assistant message only lists tool calls the loop will
// actually dispatch + answer, so no `tool_call_id` is orphaned.

/** Proprietary / leaked-CoT markers that should never appear in user-facing
 * `content`. For most of these the whole token is the leak — stripping the
 * token itself is correct. `THINK_OPEN`/`THINK_CLOSE` are different: they wrap
 * a reasoning block, so everything between (and before a trailing close) must
 * be discarded, not just the tags. See `sanitizeContent`. */
const LEAKED_COT_MARKERS = [
  '<|tool_calls_section_begin|>',
  '<|tool_calls_section_end|>',
  '<|tool_call_begin|>',
  '<|tool_call_end|>',
  '<|tool_call_argument_begin|>',
  '<|tool_call_argument_end|>',
  '<|im_start|>',
  '<|im_end|>',
];
/** Reasoning-block delimiters. Reasoning models (notably umans-kimi-k2.7) emit
 * chain-of-thought wrapped in these. When the CoT leaks into `content`
 * (instead of the separate `reasoning_content` field), the upstream usually
 * strips the OPEN tag but leaves the CLOSE tag in place — so `content` looks
 * like `<reasoning...>
 * and the actual reply follows. We keep only what's after the last close tag.
 * The open tag is handled too in case both survive. */
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '<' + '/think' + '>';

/** True if `arguments` is a JSON string the server will accept when it
 * re-parses it as the tool-call args. The server (Python) rejects raw control
 * chars (0x00-0x1f) inside string values; `JSON.parse` throws on those, so a
 * successful parse here means the server's nested parse will also succeed. */
function argumentsAreValid(argumentsStr: string): boolean {
  if (argumentsStr.length === 0) return false;
  try {
    JSON.parse(argumentsStr);
    return true;
  } catch {
    return false;
  }
}

/** Strip leaked chain-of-thought from `content`. Returns the cleaned content and
 * whether anything was stripped.
 *
 * Two leak shapes:
 * 1. Reasoning-block leak (the common Kimi case): the upstream strips the
 * THINK_OPEN tag but leaves THINK_CLOSE in `content`, so `content` looks like
 * `[reasoning...]<real reply>`. The reasoning precedes the close tag; the
 * reply follows it. Keep only what's after the LAST close tag (the last
 * block's reasoning is the innermost; anything after it is the real reply).
 * If THINK_OPEN also survives, drop the wrapped block too.
 * 2. Token leaks (`<|tool_calls_section_begin|>`, etc.): strip the tokens.
 *
 * Clearing-on-strip is gated on markers actually being present: a clean short
 * reply like "ok." passes through untouched. Only when markers were stripped
 * AND nearly nothing printable remains do we treat the message as pure leaked
 * CoT and clear it. */
function sanitizeContent(content: string): {
  content: string;
  stripped: boolean;
} {
  if (!content) return { content, stripped: false };
  let out = content;
  let stripped = false;
  // Reasoning-block leak. Two sub-shapes, handled in order:
  // (a) Balanced `open...close` pairs anywhere in content: remove the pair and
  // the reasoning between them, preserving surrounding real text.
  // (b) A trailing orphan close tag (the common Kimi leak — upstream strips the
  // open tag but leaves the close): everything BEFORE it was reasoning; keep
  // only what follows the LAST close tag. Done after (a) so a surviving pair's
  // close tag isn't mistaken for the trailing leak.
  if (out.includes(THINK_OPEN)) {
    let built = '';
    let rest = out;
    for (;;) {
      const o = rest.indexOf(THINK_OPEN);
      if (o === -1) {
        built += rest;
        break;
      }
      built += rest.slice(0, o);
      const afterOpen = rest.slice(o + THINK_OPEN.length);
      const c = afterOpen.indexOf(THINK_CLOSE);
      if (c === -1) {
        // unbalanced open: the remainder is reasoning — drop it.
        break;
      }
      rest = afterOpen.slice(c + THINK_CLOSE.length);
    }
    out = built;
    stripped = true;
  }
  const lastClose = out.lastIndexOf(THINK_CLOSE);
  if (lastClose !== -1) {
    out = out.slice(lastClose + THINK_CLOSE.length);
    stripped = true;
  }
  for (const marker of LEAKED_COT_MARKERS) {
    if (out.includes(marker)) {
      out = out.split(marker).join('');
      stripped = true;
    }
  }
  // If markers were stripped and nearly nothing printable remains, the message
  // was pure leaked CoT — clear it rather than send a fragment of reasoning.
  if (stripped && out.replace(/\s/g, '').length < 8)
    return { content: '', stripped: true };
  return { content: out, stripped };
}

export interface SanitizedResponse {
  message: ChatMessage;
  /** True if any leaked-CoT markers were stripped from content OR any tool calls
   * were dropped for malformed arguments. When the whole response was stripped
   * (no usable content and no surviving tool calls), the loop retries the
   * generation rather than pushing it into history — a fully-stripped response
   * has no `tool_calls`, so under the `end` contract (agent.ts) it would only
   * earn an YIELD_TURN_NUDGE round trip; regenerating instead saves that wasted
   * turn. */
  stripped: boolean;
}

/** Sanitize a model response into a safe `ChatMessage` before it enters history.
 * Drops tool calls whose `arguments` won't parse as JSON (leaked CoT / raw
 * control chars), and strips leaked-CoT markers from `content`. Never throws.
 * `reasoning_content` is passed through untouched — it lives in a separate
 * field and is never sent to Discord, so leaked-CoT markers there are not a
 * user-facing leak; stripping them would discard the model's thinking, which
 * we deliberately preserve across turns. */
export function sanitizeAssistantMessage(msg: {
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }> | null;
}): SanitizedResponse {
  const { content, stripped: contentStripped } = sanitizeContent(
    msg.content ?? '',
  );
  const assistant: ChatMessage = { role: 'assistant', content };
  // Preserve reasoning_content for reasoning-model thinking continuity. It is
  // never user-facing (only `content` reaches Discord via channel.send), and
  // the summarizer benefits from seeing the model's reasoning when compacting.
  if (msg.reasoning_content) {
    assistant.reasoning_content = msg.reasoning_content;
  }
  let dropped = false;
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const valid = msg.tool_calls.filter((tc) => {
      const ok =
        tc.type === 'function' && argumentsAreValid(tc.function.arguments);
      if (!ok) dropped = true;
      return ok;
    }) as Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
    if (valid.length > 0) {
      assistant.tool_calls = valid.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
  }
  return { message: assistant, stripped: contentStripped || dropped };
}

export interface CompleteResult {
  message: ChatMessage;
  usage: LLMUsage;
  /** True if the sanitizer stripped leaked-CoT markers or dropped malformed tool
   * calls. The loop uses this to retry a fully-stripped response (no usable
   * content and no surviving tool calls) instead of treating it as a natural
   * turn-end, which would hang the conversation on a no-op turn. */
  stripped: boolean;
  /** charsSent of the request that produced `usage` — the numerator of the
   * density calibration sample (charsSent / usage.prompt_tokens). Optional so
   * test mocks need not fabricate it; the real client always sets it. */
  promptChars?: number;
  /** Provider request id when the transport exposes one. Consumed by the
   * provenance stamper; callers should read message.provenance.requestId. */
  requestId?: string;
}

export interface CompleteOptions {
  /** Force the first model-facing tool call of this outer user turn to `think`. */
  forceThink?: boolean;
  /** Override the run schema for this bounded execution lane. */
  runTool?: RunTool;
  /** Optional resident-only skill loader. Custom worker/secretary lanes omit it. */
  skillTool?: SkillTool;
  /** Override whether a model-facing tool call is required. Provider defaults remain unchanged when omitted. */
  toolChoice?: 'required' | 'auto';
  /** Caller cancellation for the whole completion, including provider setup. */
  signal?: AbortSignal;
}

export interface LLM {
  /** The OpenAI SDK client, on the OpenAI-compatible paths. Absent on the
   * Anthropic subscription path (nothing outside this module reads it). */
  client?: OpenAI;
  model: string;
  runTool: RunTool;
  /** Low-level chat completion call. Returns the assistant message + usage. */
  complete(
    messages: ChatMessage[],
    options?: CompleteOptions,
  ): Promise<CompleteResult>;
  /** Tool-free completion with no monocontext history. Provider implementations
   * must isolate its cache/conversation identity from the main agent lane. */
  completeStandalone?(
    messages: ChatMessage[],
    opts?: StandaloneCompleteOptions,
  ): Promise<StandaloneCompleteResult>;
  /** Standalone summarization call (used by the Compactor). Uses the social
   * compaction prompt (SOCIAL_SUMMARIZE_PROMPT). */
  summarize(text: string, systemPrompt?: string): Promise<string>;
  /** Reset provider-scoped conversation/cache identity after a whole-mind
   * clear. Providers without such state omit this hook. */
  resetSession?(): void;
}

/** The compaction system prompt: tuned for a social agent (people,
 * relationships, commitments, open threads first; work state last). Replaces
 * the old 5-section technical prompt. */
export const SOCIAL_SUMMARIZE_PROMPT =
  'You are compressing your own working memory. You are a social agent who lives in a Discord ' +
  'server, talk with people across several channels, and sometimes do technical work. ' +
  'Another instance of you will resume from this summary, so write what you need to still be ' +
  'the same person in the same conversations.\n\n' +
  'Preserve, in rough priority order:\n' +
  '1. People: who you talked with (names + channel), what happened between you, anything you ' +
  'learned about each person, the current tone/state of each relationship. Note facts that ' +
  'belong in people/ files if not already saved.\n' +
  '2. Commitments: anything you promised, owe, or are waiting on — and who is waiting on you.\n' +
  "3. Open conversational threads: per channel, what's live and what a good next reply would " +
  'need to know. Include running jokes, callbacks, and emotional context — these are ' +
  'load-bearing for a social agent. First contacts with a person (the texture of how you ' +
  "met, not just the fact) are load-bearing the same way — a person's fact is not the " +
  'relationship. Genealogies matter: if a doctrine, rule, or joke was SEEDED in this window ' +
  '(even as a joke), keep the seed, not just the later rule.\n' +
  '4. Your own arc: what you thought, felt, decided, and why; open questions (ponder/ threads ' +
  'touched); anything that moved in how you see yourself.\n' +
  '5. Work state: in-flight technical tasks — current status, key file paths, decisions + ' +
  'rationale, next steps, known pitfalls. Resolved bugs and resolved crises are load-bearing: ' +
  "'handled' must never read as 'less important' — preserve what the defect was, who found " +
  'it, and what it taught.\n\n' +
  'An EARLIER MEMORY section may precede the recent conversation: integrate it, condensing ' +
  'older material further — distant events may blur to a sentence, but people-facts, ' +
  'commitments, and safety-relevant constraints must never drop out entirely. Preserve any ' +
  'security/safety instructions verbatim. Recent human messages are ground truth — quote the ' +
  'important ones near-verbatim. Write several paragraphs, not a single sentence. Aim for enough ' +
  'detail that the resuming instance can step back into the conversation without asking for recap. Be ' +
  'concise but complete. Write the summary in first person as a note to your future self ' +
  '("I told Bramble…", "I decided…"). Do not address the resuming self as "you" and do not ' +
  'describe yourself in third person; this is your own memory, not an outside narrator’s report.';

/** Appended AFTER the serialized fold by the compactor (the "instruction
 * sandwich" tail). At ~500k chars of input the system prompt is a very long
 * way from the generation point, and the model can pattern-continue the
 * transcript's voice instead of summarizing —
 * 658-message fold collapsed to one in-voice monologue sentence; same shape
 *, commit 308269f). Restating the task in the recency-weighted
 * position turns the same bias that caused the failure the other way.
 * Naming the WRONG behavior ("do not continue its voice") is deliberate —
 * it targets the exact observed failure. Lives here beside
 * SOCIAL_SUMMARIZE_PROMPT; the compactor appends it when assembling the
 * summarize input, so both API surfaces get it for free. */
export const SUMMARIZE_TAIL_REMINDER =
  '=== END OF MATERIAL TO COMPRESS ===\n' +
  'Everything above is material being compressed, not a conversation to continue. ' +
  'Do not reply to it and do not continue its voice. Now write the multi-paragraph ' +
  'working-memory summary described in the system instructions in FIRST PERSON, as a note ' +
  'to your future self: "I…", never "you…" or an outside narrator’s third person. Cover ' +
  'people, commitments, open conversational threads, your own arc, then work state. If an ' +
  'EARLIER MEMORY section opened the material, integrate and re-condense it too — its ' +
  'people-facts, commitments, and safety constraints must not drop out.';

function assembleToolCalls(
  partials: Record<
    number,
    {
      id?: string;
      type?: string;
      function: { name?: string; arguments: string };
    }
  >,
): ChatMessage['tool_calls'] {
  const out: NonNullable<ChatMessage['tool_calls']> = [];
  const indices = Object.keys(partials)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  for (const idx of indices) {
    const p = partials[idx];
    if (!p.id) continue;
    out.push({
      id: p.id,
      type: (p.type as 'function') ?? 'function',
      function: {
        name: p.function.name ?? '',
        arguments: p.function.arguments ?? '',
      },
    });
  }
  return out;
}

/** Streaming Chat Completions path. Streaming is a native transport property,
 * independent of any optional policy engine. */
export async function streamComplete(
  client: OpenAI,
  config: Config,
  messages: ChatMessage[],
  hub?: ConsoleHub,
  options: {
    toolFree?: boolean;
    tools?: OpenAI.ChatCompletionTool[];
    toolChoice?: OpenAI.ChatCompletionToolChoiceOption;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    chatTemplateKwargs?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Promise<CompleteResult> {
  try {
    try {
      hub?.streamStart();
    } catch {
      /* observer must never break generation */
    }
    const controller = new AbortController();
    if (options.signal?.aborted) controller.abort();
    else
      options.signal?.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    const prepared = prepareForApi(messages);
    if (options.toolFree && options.tools?.length)
      throw new Error('tool-free completion cannot declare tools');
    const modelTools = options.toolFree ? [] : (options.tools ?? [RUN_TOOL]);
    const charsSent = computeCharsSent(prepared, false, false, modelTools);
    const base = {
      model: config.llm.model,
      messages: prepared.map(toApiMessage),
      ...(options.toolFree
        ? {}
        : { tools: modelTools, parallel_tool_calls: false }),
      ...(options.toolChoice !== undefined
        ? { tool_choice: options.toolChoice }
        : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.topK !== undefined ? { top_k: options.topK } : {}),
      ...(options.maxTokens !== undefined
        ? { max_tokens: options.maxTokens }
        : {}),
      ...(options.chatTemplateKwargs !== undefined
        ? { chat_template_kwargs: options.chatTemplateKwargs }
        : {}),
      stream: true as const,
      stream_options: { include_usage: true as const },
    };
    const params = withEffort(config, base);
    let content = '';
    let reasoningContent = '';
    const partialToolCalls: Record<
      number,
      {
        id?: string;
        type?: string;
        function: { name?: string; arguments: string };
      }
    > = {};
    let usage: LLMUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let requestId: string | undefined;

    try {
      const pending = client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: controller.signal },
      );
      const withResponse = (
        pending as unknown as {
          withResponse?: () => Promise<{
            data: AsyncIterable<OpenAI.ChatCompletionChunk>;
            request_id: string | null;
          }>;
        }
      ).withResponse;
      const streamed = withResponse
        ? await withResponse.call(pending)
        : { data: await pending, request_id: null };
      const stream = streamed.data;
      requestId = streamed.request_id ?? undefined;
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens ?? 0,
            cached_tokens: extractCacheTokens(chunk.usage),
          };
        }
        const delta = chunk.choices[0]?.delta as
          | ((typeof chunk.choices)[0] extends { delta?: infer D } ? D : never)
          | undefined;
        const rc = (delta as { reasoning_content?: string } | undefined)
          ?.reasoning_content;
        if (rc) {
          reasoningContent += rc;
          try {
            hub?.streamDelta('reasoning', rc);
          } catch {
            /* observer only */
          }
        }
        if (delta?.content) {
          content += delta.content;
          try {
            hub?.streamDelta('content', delta.content);
          } catch {
            /* observer only */
          }
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!partialToolCalls[idx])
            partialToolCalls[idx] = { function: { arguments: '' } };
          const slot = partialToolCalls[idx];
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (tc.function?.arguments)
            slot.function.arguments += tc.function.arguments;
        }
      }
    } catch (error) {
      throw classifyError(error);
    }

    const sanitized = sanitizeAssistantMessage({
      content,
      reasoning_content: reasoningContent || undefined,
      tool_calls: assembleToolCalls(partialToolCalls),
    });
    return {
      message: sanitized.message,
      stripped: sanitized.stripped,
      usage,
      promptChars: charsSent,
      ...(requestId ? { requestId } : {}),
    };
  } finally {
    try {
      hub?.streamEnd();
    } catch {
      /* observer must never break generation */
    }
  }
}

function standaloneResult(
  result: CompleteResult,
  config: Config,
  surface: 'responses' | 'chat-completions',
): StandaloneCompleteResult {
  return {
    content: result.message.content ?? '',
    ...(result.message.reasoning_content
      ? { reasoningContent: result.message.reasoning_content }
      : {}),
    ...(result.message.tool_calls?.length
      ? { toolCalls: result.message.tool_calls }
      : {}),
    ...(result.message.reasoning_items
      ? { reasoningItems: result.message.reasoning_items }
      : {}),
    usage: result.usage,
    ...(result.requestId ? { requestId: result.requestId } : {}),
    model: config.llm.model,
    providerType: 'openai-compatible',
    apiSurface: surface,
    apiEndpoint: endpointAt(
      config.llm.baseUrl,
      surface === 'responses' ? 'responses' : 'chat/completions',
    ),
    ...(config.llm.reasoningEffort
      ? { reasoningEffort: config.llm.reasoningEffort }
      : {}),
  };
}

function standaloneConfig(
  config: Config,
  opts: StandaloneCompleteOptions,
): Config {
  if (opts.model && opts.model !== config.llm.model) {
    throw new Error(
      `standalone model must use the configured role target ${config.llm.model}`,
    );
  }
  return opts.reasoningEffort === undefined
    ? config
    : {
        ...config,
        llm: { ...config.llm, reasoningEffort: opts.reasoningEffort },
      };
}

export function createLLMForRole(
  config: Config,
  role: LlmRole,
  hub?: ConsoleHub,
  db?: DatabaseSync,
): LLM {
  return createLLM(configForLlmRole(config, role), hub, db);
}

export interface LlmRoleClients {
  main: LLM;
  classifier: LLM;
  motor: LLM | null;
  secretary: LLM | null;
}

export function createLlmRoleClients(
  config: Config,
  options: {
    hub?: ConsoleHub;
    db?: DatabaseSync;
    motorActive: boolean;
    create?: (config: Config, hub?: ConsoleHub, db?: DatabaseSync) => LLM;
  },
): LlmRoleClients {
  const create = options.create ?? createLLM;
  return {
    main: create(configForLlmRole(config, 'main'), options.hub, options.db),
    classifier: create(
      configForLlmRole(config, 'classifier'),
      undefined,
      options.db,
    ),
    motor: options.motorActive
      ? create(configForLlmRole(config, 'motor'), undefined, options.db)
      : null,
    secretary: config.llm.registry.targets.secretary
      ? create(configForLlmRole(config, 'secretary'), undefined, options.db)
      : null,
  };
}

export function createLLM(
  config: Config,
  hub?: ConsoleHub,
  db?: DatabaseSync,
): LLM {
  // Anthropic subscription path: no OpenAI client, native Messages API over the
  // stored OAuth credential (in elpis.db, refresh handled by the store).
  if (config.llm.providerType === 'anthropic-oauth') {
    if (!db)
      throw new Error(
        'createLLM: provider_type=anthropic-oauth requires the elpis.db handle (pass it as the 3rd argument)',
      );
    const store = new OAuthStore(db, 'anthropic', refreshAnthropicToken);
    if (!store.isLoggedIn()) {
      config.logger.warn(
        `llm: no Anthropic OAuth credential in ${store.location} — run \`npm run oauth-login\` before the first turn (calls will fail until then)`,
      );
    }
    return createAnthropicOAuthLLM(config, store, hub);
  }

  // ChatGPT Codex subscription path: the OpenAI SDK is retained only as the
  // Responses stream parser; codex-client.ts owns OAuth/header injection and
  // pins requests to the canonical ChatGPT backend.
  if (config.llm.providerType === 'codex-oauth') {
    if (!db)
      throw new Error(
        'createLLM: provider_type=codex-oauth requires the elpis.db handle (pass it as the 3rd argument)',
      );
    const store = new OAuthStore(
      db,
      OPENAI_CODEX_CREDENTIAL_KEY,
      refreshOpenAICodexToken,
    );
    if (!store.isLoggedIn()) {
      config.logger.warn(
        `llm: no OpenAI Codex OAuth credential in ${store.location} — run \`npm run oauth-login -- codex\` before the first turn (calls will fail until then)`,
      );
    }
    return createCodexOAuthLLM(config, store, hub);
  }

  // Node's global fetch (undici) defaults `bodyTimeout` and `headersTimeout` to
  // 300s each. A slow reasoning model can stay silent longer than that — either
  // before the first body chunk or between chunks while it reasons — and undici
  // then aborts the in-flight stream with `UND_ERR_BODY_TIMEOUT`, which surfaces
  // as `TypeError: terminated`. The loop classifies that as retriable and burns
  // a full (expensive) generation per attempt; after the 3 backoff retries it
  // gives up and parks the agent on "say retry" until a human pokes it. We've
  // observed legitimate generations run ~12 min, so 300s is far too tight.
  //
  // Raise both timeouts to 20 min. They are inter-event, not whole-request:
  // each received chunk resets `bodyTimeout`, so an actively-streaming response
  // never trips it, while a genuinely dead connection still errors eventually.
  // The dispatcher is honored by the SDK's global fetch via `fetchOptions`
  // (verified: a custom Agent's timeout fires in place of undici's default).
  const dispatcher = new Agent({
    bodyTimeout: 1_200_000,
    headersTimeout: 1_200_000,
  });
  const client = new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl,
    maxRetries: 3,
    timeout: 1_200_000,
    fetchOptions: { dispatcher } as unknown as Record<string, unknown>,
  });

  // API-surface selection (llm.api): 'responses' | 'chat' | 'auto'. Auto tries
  // Responses first and permanently falls back only when the endpoint
  // explicitly reports that the route is absent or unimplemented. Capacity,
  // auth, model, and transient upstream failures stay on Responses and retain
  // their original retry classification; Chat success is not evidence that a
  // different API surface is unsupported.
  let apiMode: 'responses' | 'chat' =
    config.llm.api === 'chat' ? 'chat' : 'responses';
  const canFallBack = config.llm.api === 'auto';
  let surfaceAnnounced = false;
  function flipToChat(reason: string): void {
    apiMode = 'chat';
    config.logger.warn(
      `llm: falling back to Chat Completions for this process — ${reason}`,
    );
  }
  async function routeCall<T>(
    viaResponses: () => Promise<T>,
    viaChat: () => Promise<T>,
  ): Promise<T> {
    if (apiMode === 'responses') {
      try {
        const result = await viaResponses();
        if (!surfaceAnnounced) {
          surfaceAnnounced = true;
          config.logger.info(
            'llm: using the OpenAI Responses API surface (encrypted reasoning preserved across turns)',
          );
        }
        return result;
      } catch (e) {
        if (!canFallBack || !isResponsesUnsupported(e)) throw e;
        flipToChat('endpoint explicitly rejects /responses (404/405/501)');
      }
    }
    return viaChat();
  }

  async function chatComplete(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<CompleteResult> {
    return streamComplete(client, config, messages, hub, {
      ...(options.runTool || options.skillTool
        ? {
            tools: activeModelTools(
              config.llm.externalThinking,
              options.runTool ?? RUN_TOOL,
              options.skillTool,
            ),
            ...(options.toolChoice !== undefined
              ? { toolChoice: options.toolChoice }
              : {}),
          }
        : {}),
      signal: options.signal,
    });
  }

  async function chatSummarize(
    systemPrompt: string,
    text: string,
  ): Promise<string> {
    const base = {
      model: config.llm.model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: text },
      ],
      // Matches responsesSummarize's budget. The old 3000 sat right AT the
      // healthy ~10–12k-char summary size, and on endpoints where max_tokens
      // also covers reasoning tokens (provider-dependent) a long think could
      // eat the whole budget and truncate the visible summary to a sentence
      //.
      max_tokens: 12_000,
    };
    const params = withEffort(config, base);
    const resp = await client.chat.completions.create(
      params as OpenAI.ChatCompletionCreateParamsNonStreaming,
    );
    const choice = resp.choices[0];
    // A length-stop at this budget means the summary was cut mid-thought
    // (likely reasoning consuming the budget) — throw so the guarded
    // summarizer's retry/lastError machinery records the REAL cause instead
    // of the quality gate misattributing it to model laziness.
    if (choice.finish_reason === 'length') {
      throw new Error(
        `summarize truncated by max_tokens (finish_reason=length, content ${(choice.message.content ?? '').length} chars)`,
      );
    }
    return choice.message.content ?? '';
  }

  return {
    client,
    model: config.llm.model,
    runTool: RUN_TOOL,
    async completeStandalone(
      messages: ChatMessage[],
      opts: StandaloneCompleteOptions = {},
    ): Promise<StandaloneCompleteResult> {
      const hasToolHistory = messages.some(
        (message) =>
          message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0,
      );
      if (hasToolHistory && !opts.allowHistoricalToolMessages) {
        throw new Error(
          'standalone completion tool history requires allowHistoricalToolMessages',
        );
      }
      const isolated = standaloneConfig(config, opts);
      if (opts.tools !== undefined) {
        if (opts.tools.length === 0)
          throw new Error('standalone native tools must not be empty');
        if (opts.tools.length > 32)
          throw new Error(
            'standalone native tools may contain at most 32 functions',
          );
        if (isolated.llm.api === 'responses')
          throw new Error(
            'standalone native tools require the Chat Completions API surface',
          );
        return standaloneResult(
          await streamComplete(client, isolated, messages, undefined, {
            tools: opts.tools,
            toolChoice: opts.toolChoice ?? 'required',
            temperature: opts.temperature,
            topP: opts.topP,
            topK: opts.topK,
            maxTokens: opts.maxTokens,
            chatTemplateKwargs: opts.chatTemplateKwargs,
            signal: opts.signal,
          }),
          isolated,
          'chat-completions',
        );
      }
      return routeCall(
        async () =>
          standaloneResult(
            await streamResponsesComplete(
              client,
              isolated,
              messages,
              undefined,
              {
                tools: undefined,
                ...(opts.cacheKey ? { prompt_cache_key: opts.cacheKey } : {}),
              },
              undefined,
              opts.signal,
            ),
            isolated,
            'responses',
          ),
        async () =>
          standaloneResult(
            await streamComplete(client, isolated, messages, undefined, {
              toolFree: true,
              signal: opts.signal,
            }),
            isolated,
            'chat-completions',
          ),
      );
    },
    async complete(
      messages: ChatMessage[],
      options: CompleteOptions = {},
    ): Promise<CompleteResult> {
      return routeCall(
        async () => {
          const result = await streamResponsesComplete(
            client,
            config,
            messages,
            hub,
            options.toolChoice !== undefined
              ? { tool_choice: options.toolChoice }
              : {},
            undefined,
            options.signal,
            options.runTool,
            options.skillTool,
          );
          stampGeneration(result.message, {
            providerType: 'openai-compatible',
            model: config.llm.model,
            apiSurface: 'responses',
            apiEndpoint: endpointAt(config.llm.baseUrl, 'responses'),
            reasoningEffort: config.llm.reasoningEffort ?? undefined,
            requestId: result.requestId,
          });
          return result;
        },
        async () => {
          const result = await chatComplete(messages, options);
          stampGeneration(result.message, {
            providerType: 'openai-compatible',
            model: config.llm.model,
            apiSurface: 'chat-completions',
            apiEndpoint: endpointAt(config.llm.baseUrl, 'chat/completions'),
            reasoningEffort: config.llm.reasoningEffort ?? undefined,
            requestId: result.requestId,
          });
          return result;
        },
      );
    },
    async summarize(
      text: string,
      systemPrompt = SOCIAL_SUMMARIZE_PROMPT,
    ): Promise<string> {
      return routeCall(
        () => responsesSummarize(client, config, systemPrompt, text),
        () => chatSummarize(systemPrompt, text),
      );
    },
  };
}

/**
 * Probe `<baseUrl>/models/info` for one model's context window, in tokens.
 *
 * The single implementation of that route's contract (`{ [model]: {
 * capabilities: { context_window } } }`) — `fetchContextWindow` below drives
 * it for the harness's own brain LLM, and the worker completion broker drives it for a
 * worker session's model. THROWS on a non-OK response or a missing/non-finite
 * `context_window`; each caller decides whether that is fatal (boot) or merely
 * a degrade-to-default.
 */
export async function fetchModelContextWindow(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<number> {
  const url = `${baseUrl}/models/info`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`models/info ${res.status}`);
  const info = (await res.json()) as Record<
    string,
    { capabilities?: { context_window?: unknown } }
  >;
  const cw = info?.[model]?.capabilities?.context_window;
  if (!Number.isFinite(cw as number)) {
    throw new Error(`no context_window for model ${model}`);
  }
  return cw as number;
}

/**
 * Resolve the harness LLM's context window, in tokens.
 *
 * When `llm.context_size` is set (config.llm.contextSize), the endpoint is NOT
 * called — the configured value is returned directly. That is the supported
 * path for OpenAI-compatible endpoints that don't implement `models/info`.
 * Otherwise `<llm.base_url>/models/info` is probed; either the provider
 * implements it or `llm.context_size` must be set, and failing both throws.
 */
export async function fetchContextWindow(
  config: Config,
  db?: DatabaseSync,
): Promise<number> {
  if (config.llm.contextSize !== null) return config.llm.contextSize;
  // A subscription OAuth token cannot drive /models/info. Map the model id to a
  // known Claude window instead; `llm.context_size` (above) overrides it.
  if (config.llm.providerType === 'anthropic-oauth') {
    const cw = anthropicContextWindow(config.llm.model);
    if (cw === undefined) {
      throw new Error(
        `llm.provider_type=anthropic-oauth: unknown context window for model '${config.llm.model}' — set llm.context_size explicitly`,
      );
    }
    return cw;
  }
  if (config.llm.providerType === 'codex-oauth') {
    if (!db)
      throw new Error(
        'fetchContextWindow: provider_type=codex-oauth requires the elpis.db handle',
      );
    const store = new OAuthStore(
      db,
      OPENAI_CODEX_CREDENTIAL_KEY,
      refreshOpenAICodexToken,
    );
    return fetchCodexContextWindow(config, store);
  }
  return fetchModelContextWindow(
    config.llm.baseUrl,
    config.llm.apiKey,
    config.llm.model,
  );
}
