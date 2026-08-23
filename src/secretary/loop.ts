import type { ChatMessage, CompleteResult } from '../llm/llm.js';
import type { SecretaryConversationPullReply } from './conversation.js';

const MAX_MODEL_ROUNDS = 8;
const MAX_MIND_CALLS = 16;
const MAX_TOOL_RESULT_CHARS = 1024 * 1024;

export const SECRETARY_SYSTEM_MESSAGE: ChatMessage = {
  role: 'system',
  content:
    'You are a bounded secretary with global read access to authorized Mind items. An optional session hint is prompt context, never an authority boundary; omit a read id only to inspect that hint. Use the mind tool when evidence is missing. Your only Mind write is creating a proposal through operation propose: you cannot update, accept, schedule, claim, or otherwise mutate items. Cite canonical elm-* item ids for factual summaries. Return a final answer to the user when done.',
};

export interface SecretaryTurnClient {
  complete(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompleteResult>;
  mind(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

function toolInput(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('secretary mind tool arguments must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('secretary mind tool arguments must be an object');
  return parsed as Record<string, unknown>;
}

function toolResult(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || encoded.length > MAX_TOOL_RESULT_CHARS)
    throw new Error('secretary Mind result is not bounded JSON');
  return encoded;
}

export async function runSecretaryTurn(
  client: SecretaryTurnClient,
  turn: NonNullable<SecretaryConversationPullReply['turn']>,
  signal?: AbortSignal,
): Promise<string> {
  const messages: ChatMessage[] = [SECRETARY_SYSTEM_MESSAGE, ...turn.messages];
  let mindCalls = 0;
  for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
    if (signal?.aborted)
      throw signal.reason ?? new Error('secretary turn aborted');
    const result = await client.complete(messages, signal);
    const assistant = result.message;
    if (assistant.role !== 'assistant')
      throw new Error(
        'secretary completion did not return an assistant message',
      );
    messages.push(assistant);
    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      if (assistant.content.length > 32_768)
        throw new Error(
          'secretary final answer exceeds the conversation bound',
        );
      return assistant.content;
    }
    for (const call of calls) {
      mindCalls++;
      if (mindCalls > MAX_MIND_CALLS)
        throw new Error('secretary Mind call budget exceeded');
      if (call.type !== 'function' || call.function.name !== 'mind')
        throw new Error('secretary completion requested an unsupported tool');
      const result = await client.mind(
        toolInput(call.function.arguments),
        signal,
      );
      messages.push({
        role: 'tool',
        content: toolResult(result),
        tool_call_id: call.id,
      });
    }
  }
  throw new Error('secretary model round budget exceeded');
}
