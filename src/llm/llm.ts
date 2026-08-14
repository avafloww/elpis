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
import type { Config } from '../config.js';
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
import { createAnthropicOAuthLLM, anthropicContextWindow } from './anthropic-client.js';
import { OAuthStore } from './oauth/store.js';
import { refreshAnthropicToken } from './oauth/anthropic.js';
import {
  OPENAI_CODEX_CREDENTIAL_KEY,
  refreshOpenAICodexToken,
} from './oauth/openai-codex.js';
import { createCodexOAuthLLM, fetchCodexContextWindow } from './codex-client.js';
import { endpointAt, stampGeneration, type ApiSurface, type GenerationProvenance, type ProviderType } from './provenance.js';
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
  /** For a `tool` message: the channel().send() calls made during that run,
 * recorded harness-side (literal channel + text). Rendered verbatim when the
 * result is aged down at request-assembly time so the agent's outbound speech
 * survives even after the tool payload is stubbed. Persisted;
 * never sent to the API. */
  sends?: { channel: string; text: string }[];
  /** Out-of-band generation attribution. Persisted for forensic/data use, but
 * deliberately ignored by every provider request translator. */
  provenance?: GenerationProvenance;
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
  /** Abort the provider request and response stream. */
  signal?: AbortSignal;
}

export interface StandaloneCompleteResult {
  content: string;
  reasoningContent?: string;
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
  const details = (usage as { prompt_tokens_details?: unknown }).prompt_tokens_details;
  if (typeof details !== 'object' || details === null) return undefined;
  const cached = (details as { cached_tokens?: unknown }).cached_tokens;
  return typeof cached === 'number' && Number.isFinite(cached) ? cached : undefined;
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
    const status = 'status' in e && typeof e.status === 'number' ? e.status : undefined;
    const code = 'code' in e && typeof e.code === 'string' ? e.code : undefined;
    const name = 'name' in e && typeof e.name === 'string' ? e.name : '';
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
      return new NonRetriableError(e);
    }
    if (status === 429 || (status && status >= 500) || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || name.includes('APIConnection') || name.includes('Timeout')) {
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
export function toApiMessage(m: ChatMessage): OpenAI.ChatCompletionMessageParam {
  const base: OpenAI.ChatCompletionMessageParam = {
    role: m.role,
    content: m.contentParts ?? m.content,
  } as OpenAI.ChatCompletionMessageParam;
  if (m.role === 'assistant' && m.tool_calls) {
    (base as OpenAI.ChatCompletionAssistantMessageParam).tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: tc.type,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  if (m.role === 'tool' && m.tool_call_id) {
    (base as OpenAI.ChatCompletionToolMessageParam).tool_call_id = m.tool_call_id;
  }
  if (m.role === 'assistant' && m.reasoning_content) {
    (base as { reasoning_content?: string }).reasoning_content = m.reasoning_content;
  }
  return base;
}

/** Spread `reasoning_effort` onto a request body when the endpoint is
 * configured for it (`config.llm.reasoningEffort`); otherwise return `base`
 * unchanged. Shared by the three request-body builders (streaming complete,
 * non-streaming complete, summarize) so the opt-in stays in one place. */
function withEffort<T extends object>(config: Config, base: T): T & { reasoning_effort?: string } {
  return config.llm.reasoningEffort ? { ...base, reasoning_effort: config.llm.reasoningEffort } : base;
}


// ─── Request-assembly diet ────────────────────────────────────
// Two NON-DESTRUCTIVE transforms applied to `messages` right before they are
// mapped to API params: they change only what is SENT, never what is stored.
// Transcript, in-memory history, and serializeHistory (the summarizer's view)
// always see full content.
//
// 3a — strip prior-turn reasoning: drop reasoning_content on assistant messages
// from COMPLETED turns; keep it on the current open tool chain. Responses-API
// `reasoning_items` are deliberately NOT stripped — replaying them is how the
// Responses path preserves the model's thinking across turns (the endpoint's
// `reasoning.context` governs rendering). Boundary = the
// last assistant message that ENDED a turn (see endsTurn below — a bare
// no-tool-calls message, OR a LAST tool call carrying end: true whose run
// actually succeeded, mirroring src/agent.ts's own endedByFlag rule), NOT
// "last user message" (a user msg can land mid-chain under mono).
// 3b — tool aging: outside a recent full-fidelity window, tool RESULTS are
// stubbed to their status line + recorded sends, and tool-call CODE is
// head-capped. `arguments` is a JSON string the server re-parses, so aging
// must JSON.parse → cap args.code → JSON.stringify (head-capping the raw
// string emits invalid JSON → permanent 400).

/** Pre-division char count of a single message AS SENT — content + role length +
 * 4 + tool-call `arguments` lengths. `reasoning_content` is deliberately
 * excluded (matches what `prepareForApi` sends: the diet strips it on
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
export function sentChars(m: ChatMessage, includeReasoningItems = true): number {
  let chars = (m.content?.length ?? 0) + m.role.length + 4;
  for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length;
  if (includeReasoningItems) {
    for (const r of m.reasoning_items ?? []) chars += reasoningItemChars(r);
  }
 // Anthropic thinking blocks are replayed on every request (like
 // reasoning_items), so count them regardless of the reasoning-item flag —
 // they are absent (0) on the OpenAI paths.
  for (const b of m.thinking_blocks ?? []) {
    chars += b.type === 'thinking' ? b.thinking.length + b.signature.length : b.data.length;
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

const AGE_CODE_MAX_CHARS = 400;
const AGE_CODE_MAX_LINES = 10;

/** Head-cap the `code` inside a tool_call's JSON `arguments` string, round-
 * tripping through JSON.parse/stringify so the emitted arguments stay valid
 * JSON. Leaves `arguments` untouched if it doesn't parse. */
function ageToolCallArguments(argumentsStr: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsStr); } catch { return argumentsStr; }
  if (typeof parsed !== 'object' || parsed === null) return argumentsStr;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.code !== 'string') return argumentsStr;
  const code = obj.code;
  const lines = code.split('\n');
  if (code.length <= AGE_CODE_MAX_CHARS && lines.length <= AGE_CODE_MAX_LINES) return argumentsStr;
  const head = lines.slice(0, AGE_CODE_MAX_LINES).join('\n').slice(0, AGE_CODE_MAX_CHARS);
  obj.code = `${head}\n[…code elided by harness; full text in the on-disk transcript]`;
  return JSON.stringify(obj);
}

/** First line of a tool result beginning `[run` — the status line `formatRunResult`
 * (`src/agent.ts`) writes (`[run ok…]` on success, `[run FAILED]` on failure). A
 * generated prose can precede a tool call, so this
 * scans for the marker rather than assuming `lines[0]`. Shared by `ageToolResult`
 * (3b) and `endsTurn` (which reads it to tell a successful run from a failed one). */
function toolStatusLine(content: string): string {
  const lines = (content ?? '').split('\n');
  return lines.find((l) => l.startsWith('[run')) ?? lines[0] ?? '';
}

/** Age a tool RESULT down to its status line + any recorded sends, verbatim. */
function ageToolResult(m: ChatMessage): ChatMessage {
  const statusLine = toolStatusLine(m.content ?? '');
  const parts = [statusLine];
  for (const s of m.sends ?? []) parts.push(`→ #${s.channel}: ${JSON.stringify(s.text)}`);
  parts.push('[…result elided by harness; full text in the on-disk transcript]');
  return { ...m, content: parts.join('\n') };
}

/** True when `messages[i]` is an assistant message that ENDED a turn. Two shapes
 * are recognised, mirroring `src/agent.ts`'s own `endedByFlag` rule exactly (not
 * a looser approximation of it):
 * - a message with no tool calls at all (the natural turn-end,
 * still present in older history and in restored transcripts), or
 * - a message whose LAST tool call (the loop's `endedByFlag = wantsEnd &&
 * result.ok` is a plain assignment per call, so only the final call in a
 * multi-tool-call response decides) carries `end: true` in its arguments
 * AND that call's matching `tool` result (found by `tool_call_id` among the
 * messages that follow, up to the next assistant message) shows the run
 * actually SUCCEEDED (`formatRunResult`'s `[run ok…]` status line, via
 * `toolStatusLine`). A failed run's `end: true` does NOT end the turn — the
 * failure has to come back to the model, so its reasoning must survive the
 * strip — and a result that isn't in the array yet (an interrupted chain)
 * can't have succeeded, so it doesn't end the turn either.
 * The diet's reasoning-strip boundary keys off this rather than off "has no
 * tool_calls", which silently degenerates to -1 once every turn ends with a
 * run call. */
export function endsTurn(messages: ChatMessage[], i: number): boolean {
  const m = messages[i];
  if (m.role !== 'assistant') return false;
  if (!m.tool_calls || m.tool_calls.length === 0) return true;
  const last = m.tool_calls[m.tool_calls.length - 1];
  let wantsEnd: boolean;
  try {
 // `.end` access on a non-object parse (e.g. arguments === 'null') throws a
 // TypeError here too — caught the same as a JSON syntax error, since neither
 // shape can carry a meaningful `end: true` request.
    wantsEnd = JSON.parse(last.function.arguments || '{}').end === true;
  } catch {
    wantsEnd = false;
  }
  if (!wantsEnd) return false;
  let toolResult: ChatMessage | undefined;
  for (let j = i + 1; j < messages.length; j++) {
    const mm = messages[j];
    if (mm.role === 'assistant') break; // next turn started; this chain is exhausted
    if (mm.role === 'tool' && mm.tool_call_id === last.id) { toolResult = mm; break; }
  }
  if (!toolResult) return false;
  return toolStatusLine(toolResult.content ?? '').startsWith('[run ok');
}

/** Apply the reasoning-strip + tool-aging diet. Returns a NEW array (inputs
 * untouched). Exported for tests. */
export function prepareForApi(messages: ChatMessage[], toolAgeKeepTokens: number, ratio = 4): ChatMessage[] {
 // 3a boundary: index of the last assistant message that ENDED a turn. Keep
 // reasoning_content on every message AFTER it (the whole current open chain).
  let reasoningBoundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (endsTurn(messages, i)) {
      reasoningBoundary = i;
      break;
    }
  }
 // 3b window: walk backwards accumulating estimates until toolAgeKeepTokens.
 // Messages at index >= agingStart are inside the window (sent untouched).
 // 0 disables aging entirely.
  let agingStart = 0;
  if (toolAgeKeepTokens > 0) {
    let acc = 0;
    agingStart = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      acc += estimateSentTokens(messages[i], ratio);
      agingStart = i;
      if (acc >= toolAgeKeepTokens) break;
    }
  }
  return messages.map((m, i) => {
    let out = m;
 // 3a: strip prior-turn reasoning (at/before the last message that ended a turn).
    if (out.reasoning_content && i <= reasoningBoundary) {
      const { reasoning_content: _drop, ...rest } = out;
      out = rest;
    }
 // 3b: age tool traffic outside the window.
    if (toolAgeKeepTokens > 0 && i < agingStart) {
      if (out.role === 'tool') {
        out = ageToolResult(out);
      } else if (out.role === 'assistant' && out.tool_calls && out.tool_calls.length > 0) {
        const tool_calls = out.tool_calls.map((tc) => ({
          ...tc,
          function: { ...tc.function, arguments: ageToolCallArguments(tc.function.arguments) },
        }));
        out = { ...out, tool_calls };
      }
    }
    return out;
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
        end: { type: 'boolean'; description: string };
      };
      required: ['code'];
    };
  };
}

export const RUN_TOOL: RunTool = {
  type: 'function',
  function: {
    name: 'run',
    description:
      'Run JavaScript in your persistent sandbox. Returns a capped preview of the ' +
      'completion value (full value saved as `_`), plus console output. Use this for ' +
      'everything: computation, shelling out via elpis.sh()/elpis.sudo(), and updating memory via elpis.remember().',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript to execute.' },
        end: {
          type: 'boolean',
          description:
            'Set true on your final run call to end the turn. This is the ONLY way to end a ' +
            'turn — if the run succeeds the harness stops here instead of asking you for ' +
            'another message. Ignored when the run fails, so an error always comes back to ' +
            'you. To end without doing anything, use empty code: run(\'\', end: true).',
        },
      },
      required: ['code'],
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
        thoughts: { type: 'string', description: 'Unpolished scratchpad reasoning to carry into the next response.' },
      },
      required: ['thoughts'],
      additionalProperties: false,
    },
  },
};

export function activeModelTools(externalThinking: boolean): Array<RunTool | ThinkTool> {
  return externalThinking ? [RUN_TOOL, THINK_TOOL] : [RUN_TOOL];
}

const EXTERNAL_THINKING_JUICE: Record<string, number> = {
  none: 0, minimal: 2, low: 4, medium: 8, high: 48, xhigh: 112, max: 960,
};

export function externalThinkingJuice(effort: string | null | undefined): number {
  return effort ? EXTERNAL_THINKING_JUICE[effort] ?? 8 : 8;
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
): number {
  let chars = JSON.stringify(activeModelTools(externalThinking)).length;
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
function sanitizeContent(content: string): { content: string; stripped: boolean } {
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
      if (o === -1) { built += rest; break; }
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
  if (stripped && out.replace(/\s/g, '').length < 8) return { content: '', stripped: true };
  return { content: out, stripped };
}

export interface SanitizedResponse {
  message: ChatMessage;
  /** True if any leaked-CoT markers were stripped from content OR any tool calls
 * were dropped for malformed arguments. When the whole response was stripped
 * (no usable content and no surviving tool calls), the loop retries the
 * generation rather than pushing it into history — a fully-stripped response
 * has no `tool_calls`, so under the `end` contract (agent.ts) it would only
 * earn an END_TURN_NUDGE round trip; regenerating instead saves that wasted
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
  const { content, stripped: contentStripped } = sanitizeContent(msg.content ?? '');
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
      const ok = tc.type === 'function' && argumentsAreValid(tc.function.arguments);
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
  complete(messages: ChatMessage[], ratio?: number, options?: CompleteOptions): Promise<CompleteResult>;
  /** Tool-free completion with no monocontext history. Provider implementations
 * must isolate its cache/conversation identity from the main agent lane. */
  completeStandalone?(messages: ChatMessage[], opts?: StandaloneCompleteOptions): Promise<StandaloneCompleteResult>;
  /** Standalone summarization call (used by the Compactor). Uses the social
 * compaction prompt (SOCIAL_SUMMARIZE_PROMPT). */
  summarize(text: string): Promise<string>;
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
  '3. Open conversational threads: per channel, what\'s live and what a good next reply would ' +
  'need to know. Include running jokes, callbacks, and emotional context — these are ' +
  'load-bearing for a social agent. First contacts with a person (the texture of how you ' +
  'met, not just the fact) are load-bearing the same way — a person\'s fact is not the ' +
  'relationship. Genealogies matter: if a doctrine, rule, or joke was SEEDED in this window ' +
  '(even as a joke), keep the seed, not just the later rule.\n' +
  '4. Your own arc: what you thought, felt, decided, and why; open questions (ponder/ threads ' +
  'touched); anything that moved in how you see yourself.\n' +
  '5. Work state: in-flight technical tasks — current status, key file paths, decisions + ' +
  'rationale, next steps, known pitfalls. Resolved bugs and resolved crises are load-bearing: ' +
  '\'handled\' must never read as \'less important\' — preserve what the defect was, who found ' +
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
  partials: Record<number, { id?: string; type?: string; function: { name?: string; arguments: string } }>,
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
  ratio = 4,
): Promise<CompleteResult> {
  try {
    try { hub?.streamStart(); } catch { /* observer must never break generation */ }
    const controller = new AbortController();
    const prepared = prepareForApi(messages, config.compaction.toolAgeKeepTokens, ratio);
    const charsSent = computeCharsSent(prepared, false);
    const base = {
      model: config.llm.model,
      messages: prepared.map(toApiMessage),
      tools: [RUN_TOOL],
      stream: true as const,
      stream_options: { include_usage: true as const },
    };
    const params = withEffort(config, base);
    let content = '';
    let reasoningContent = '';
    const partialToolCalls: Record<number, { id?: string; type?: string; function: { name?: string; arguments: string } }> = {};
    let usage: LLMUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let requestId: string | undefined;

    try {
      const pending = client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: controller.signal },
      );
      const withResponse = (pending as unknown as { withResponse?: () => Promise<{ data: AsyncIterable<OpenAI.ChatCompletionChunk>; request_id: string | null }> }).withResponse;
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
        const delta = chunk.choices[0]?.delta as (typeof chunk.choices[0] extends { delta?: infer D } ? D : never) | undefined;
        const rc = (delta as { reasoning_content?: string } | undefined)?.reasoning_content;
        if (rc) {
          reasoningContent += rc;
          try { hub?.streamDelta('reasoning', rc); } catch { /* observer only */ }
        }
        if (delta?.content) {
          content += delta.content;
          try { hub?.streamDelta('content', delta.content); } catch { /* observer only */ }
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!partialToolCalls[idx]) partialToolCalls[idx] = { function: { arguments: '' } };
          const slot = partialToolCalls[idx];
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
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
    return { message: sanitized.message, stripped: sanitized.stripped, usage, promptChars: charsSent, ...(requestId ? { requestId } : {}) };
  } finally {
    try { hub?.streamEnd(); } catch { /* observer must never break generation */ }
  }
}

export function createLLM(config: Config, hub?: ConsoleHub, db?: DatabaseSync): LLM {

 // Anthropic subscription path: no OpenAI client, native Messages API over the
 // stored OAuth credential (in agent.db, refresh handled by the store).
  if (config.llm.providerType === 'anthropic-oauth') {
    if (!db) throw new Error('createLLM: provider_type=anthropic-oauth requires the agent.db handle (pass it as the 4th argument)');
    const store = new OAuthStore(db, 'anthropic', refreshAnthropicToken);
    if (!store.isLoggedIn()) {
      config.logger.warn(`llm: no Anthropic OAuth credential in ${store.location} — run \`npm run oauth-login\` before the first turn (calls will fail until then)`);
    }
    return createAnthropicOAuthLLM(config, store, hub);
  }

 // ChatGPT Codex subscription path: the OpenAI SDK is retained only as the
 // Responses stream parser; codex-client.ts owns OAuth/header injection and
 // pins requests to the canonical ChatGPT backend.
  if (config.llm.providerType === 'codex-oauth') {
    if (!db) throw new Error('createLLM: provider_type=codex-oauth requires the agent.db handle (pass it as the 4th argument)');
    const store = new OAuthStore(db, OPENAI_CODEX_CREDENTIAL_KEY, refreshOpenAICodexToken);
    if (!store.isLoggedIn()) {
      config.logger.warn(`llm: no OpenAI Codex OAuth credential in ${store.location} — run \`npm run oauth-login -- codex\` before the first turn (calls will fail until then)`);
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
 // the Responses API first — the modern surface, whose encrypted reasoning
 // items preserve the model's thinking across turns — and permanently falls
 // back to Chat Completions for the process lifetime when the endpoint
 // doesn't serve the route. Fallback is decided INSIDE the failing call (the
 // caller's message is not popped, no retry budget is spent): the error is
 // eaten, the same request re-issues on the chat path, and every later call
 // skips straight to chat. Two fallback triggers:
 // - a 404/405 (`isResponsesUnsupported`) flips unconditionally — the route
 // is plainly absent;
 // - any OTHER failure BEFORE the first Responses success (gateways answer
 // an unimplemented /responses with 400/500/501/…, not just 404) probes
 // the chat path with the same request and commits the flip only if chat
 // SUCCEEDS. A transient outage fails both, propagates the original
 // Responses error (keeping its Retriable/NonRetriable class for the
 // loop's backoff), and leaves the mode undecided for the next attempt.
 // Once Responses has succeeded, later errors propagate unchanged — endpoint
 // trouble at that point would hit either surface, and flipping would
 // silently discard reasoning preservation on a healthy route.
  let apiMode: 'responses' | 'chat' = config.llm.api === 'chat' ? 'chat' : 'responses';
  const canFallBack = config.llm.api === 'auto';
  let responsesEverSucceeded = false;
  let surfaceAnnounced = false;
  function flipToChat(reason: string): void {
    apiMode = 'chat';
    config.logger.warn(`llm: falling back to Chat Completions for this process — ${reason}`);
  }
  async function routeCall<T>(viaResponses: () => Promise<T>, viaChat: () => Promise<T>): Promise<T> {
    if (apiMode === 'responses') {
      try {
        const result = await viaResponses();
        responsesEverSucceeded = true;
        if (!surfaceAnnounced) {
          surfaceAnnounced = true;
          config.logger.info('llm: using the OpenAI Responses API surface (encrypted reasoning preserved across turns)');
        }
        return result;
      } catch (e) {
        if (!canFallBack) throw e;
        if (isResponsesUnsupported(e)) {
          flipToChat('endpoint has no /responses route (404/405)');
        } else if (!responsesEverSucceeded) {
          let result: T;
          try {
            result = await viaChat();
          } catch {
            throw e; // both surfaces failed — surface the original Responses error
          }
          flipToChat(`first /responses attempt failed (${e instanceof Error ? e.message : String(e)}) and Chat Completions succeeded`);
          return result;
        } else {
          throw e;
        }
      }
    }
    return viaChat();
  }

  async function chatComplete(messages: ChatMessage[], ratio: number): Promise<CompleteResult> {
    return streamComplete(client, config, messages, hub, ratio);
  }

  async function chatSummarize(systemPrompt: string, text: string): Promise<string> {
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
    async complete(messages: ChatMessage[], ratio = 4, _options: CompleteOptions = {}): Promise<CompleteResult> {
      return routeCall(
        async () => {
          const result = await streamResponsesComplete(client, config, messages, hub, ratio);
          stampGeneration(result.message, {
            providerType: 'openai-compatible', model: config.llm.model,
            apiSurface: 'responses', apiEndpoint: endpointAt(config.llm.baseUrl, 'responses'),
            reasoningEffort: config.llm.reasoningEffort ?? undefined,
            requestId: result.requestId,
          });
          return result;
        },
        async () => {
          const result = await chatComplete(messages, ratio);
          stampGeneration(result.message, {
            providerType: 'openai-compatible', model: config.llm.model,
            apiSurface: 'chat-completions', apiEndpoint: endpointAt(config.llm.baseUrl, 'chat/completions'),
            reasoningEffort: config.llm.reasoningEffort ?? undefined,
            requestId: result.requestId,
          });
          return result;
        },
      );
    },
    async summarize(text: string): Promise<string> {
      return routeCall(
        () => responsesSummarize(client, config, SOCIAL_SUMMARIZE_PROMPT, text),
        () => chatSummarize(SOCIAL_SUMMARIZE_PROMPT, text),
      );
    },
  };
}

/**
 * Probe `<baseUrl>/models/info` for one model's context window, in tokens.
 *
 * The single implementation of that route's contract (`{ [model]: {
 * capabilities: { context_window } } }`) — `fetchContextWindow` below drives
 * it for the harness's own brain LLM, and the fleet registry drives it for a
 * fleet session's model. THROWS on a non-OK response or a missing/non-finite
 * `context_window`; each caller decides whether that is fatal (boot) or merely
 * a degrade-to-default (fleet).
 */
export async function fetchModelContextWindow(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<number> {
  const url = `${baseUrl}/models/info`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
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
export async function fetchContextWindow(config: Config, db?: DatabaseSync): Promise<number> {
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
    if (!db) throw new Error('fetchContextWindow: provider_type=codex-oauth requires the agent.db handle');
    const store = new OAuthStore(db, OPENAI_CODEX_CREDENTIAL_KEY, refreshOpenAICodexToken);
    return fetchCodexContextWindow(config, store);
  }
  return fetchModelContextWindow(config.llm.baseUrl, config.llm.apiKey, config.llm.model);
}
