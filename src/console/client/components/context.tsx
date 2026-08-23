import { useMemo } from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import type { ConsoleState, JsonObject } from '../types.js';
import { array, object, text } from '../types.js';
import { Empty } from './common.js';

function contentOf(message: JsonObject): string {
  if (typeof message.content === 'string') return message.content;
  return JSON.stringify(message.content ?? '', null, 2);
}

function segmentLabel(message: JsonObject, index: number): string {
  const role = text(message.role, 'segment');
  const content = contentOf(message);
  if (/SOUL|identity|who you are/i.test(content)) return 'identity · SOUL';
  if (/MEMORY|durable memory/i.test(content)) return 'durable memory';
  if (/tool|function/i.test(content) && role === 'system')
    return 'tool contract';
  if (/incoming-message/.test(content)) return 'incoming message';
  if (role === 'assistant') return 'assistant response';
  if (role === 'tool') return 'tool result';
  return `${role} segment ${index + 1}`;
}

function ContextCard({
  message,
  index,
}: {
  message: JsonObject;
  index: number;
}) {
  const role = text(message.role, 'unknown');
  const raw = JSON.stringify(message);
  const content = contentOf(message);
  const reasoning = text(message.reasoning_content);
  const calls = array<JsonObject>(message.tool_calls);
  const source = [
    reasoning,
    content,
    ...calls.map((call) =>
      text(object(call.function).arguments, JSON.stringify(call)),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
  const preview = source.length > 900 ? `${source.slice(0, 899)}…` : source;
  return (
    <article class='context-segment'>
      <header>
        <span class={`context-role role-${role}`}>{role}</span>
        <strong>{segmentLabel(message, index)}</strong>
        <span class='surface-spacer' />
        <span>{Math.ceil(raw.length / 4).toLocaleString()} tok</span>
      </header>
      <pre>{preview}</pre>
    </article>
  );
}

export function ContextView({
  state,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
}) {
  const messages = useMemo(
    () => array<JsonObject>(state.context?.messages),
    [state.context],
  );
  const raw = state.context ? JSON.stringify(state.context) : '';
  return (
    <div class='reference-scroll'>
      <div class='context-view reference-column'>
        <div class='context-summary'>
          Next request projection · {messages.length} segments · ~
          {Math.ceil(raw.length / 4).toLocaleString()} tokens
        </div>
        {!state.context ? (
          <Empty>Context is unavailable or still loading.</Empty>
        ) : (
          messages.map((message, index) => (
            <ContextCard key={index} message={message} index={index} />
          ))
        )}
      </div>
    </div>
  );
}
