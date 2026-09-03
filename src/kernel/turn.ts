import type { ChatMessage } from '../llm/llm.js';
import type { ContextResourceDescriptor } from '../context-resources.js';

export interface KernelToolContext {
  callIndex: number;
  callCount: number;
}

export interface KernelToolOutput {
  content: string;
  sends?: ChatMessage['sends'];
  run?: ChatMessage['run'];
  contextResources?: ContextResourceDescriptor[];
}

export type KernelToolHandler = (
  call: NonNullable<ChatMessage['tool_calls']>[number],
  context: KernelToolContext,
) => Promise<KernelToolOutput>;

export interface KernelTurnHooks {
  appendAssistant(message: ChatMessage): void | Promise<void>;
  appendTool(
    message: ChatMessage,
    context: KernelToolContext,
  ): void | Promise<void>;
}

export interface KernelTurnApplication {
  assistant: ChatMessage;
  toolMessages: ChatMessage[];
  shouldContinue: boolean;
}

export async function applyKernelTurn(
  assistant: ChatMessage,
  handle: KernelToolHandler,
  hooks: KernelTurnHooks,
): Promise<KernelTurnApplication> {
  if (assistant.role !== 'assistant') {
    throw new Error('kernel turn requires an assistant message');
  }
  await hooks.appendAssistant(assistant);
  const toolMessages = await dispatchKernelTools(
    assistant,
    handle,
    hooks.appendTool,
  );
  return {
    assistant,
    toolMessages,
    shouldContinue: toolMessages.length > 0,
  };
}

export async function dispatchKernelTools(
  assistant: Pick<ChatMessage, 'tool_calls'>,
  handle: KernelToolHandler,
  append: (
    message: ChatMessage,
    context: KernelToolContext,
  ) => void | Promise<void>,
): Promise<ChatMessage[]> {
  const calls = assistant.tool_calls ?? [];
  const messages: ChatMessage[] = [];
  for (let callIndex = 0; callIndex < calls.length; callIndex++) {
    const call = calls[callIndex];
    const context = { callIndex, callCount: calls.length };
    const output = await handle(call, context);
    const message: ChatMessage = {
      role: 'tool',
      tool_call_id: call.id,
      content: output.content,
      ...(output.sends ? { sends: output.sends } : {}),
      ...(output.run ? { run: output.run } : {}),
      ...(output.contextResources
        ? { contextResources: output.contextResources }
        : {}),
    };
    await append(message, context);
    messages.push(message);
  }
  return messages;
}
