import { useMemo, useState } from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import type { ConsoleState, JsonObject } from '../types.js';
import { array, object, text } from '../types.js';
import { copy, Empty } from './common.js';

function ContextCard({
  message,
  index,
}: {
  message: JsonObject;
  index: number;
}) {
  const [copied, setCopied] = useState(false);
  const role = text(message.role, 'unknown');
  const raw = JSON.stringify(message, null, 2);
  const content =
    typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content ?? '', null, 2);
  return (
    <article class='context-card'>
      <header>
        <span class={`role role-${role}`}>{role}</span>
        <span>segment {index + 1}</span>
        <span class='spacer' />
        <span>{Math.ceil(raw.length / 4).toLocaleString()} tok</span>
        <button
          onClick={async () => {
            setCopied(await copy(raw));
            window.setTimeout(() => setCopied(false), 1000);
          }}
        >
          {copied ? '✓ copied' : '⧉ JSON'}
        </button>
      </header>
      {message.reasoning_content ? (
        <>
          <div class='context-label'>reasoning_content</div>
          <pre>{String(message.reasoning_content)}</pre>
        </>
      ) : null}
      {content ? (
        <>
          <div class='context-label'>content</div>
          <pre>{content}</pre>
        </>
      ) : null}
      {array<JsonObject>(message.tool_calls).map((call, i) => (
        <div key={i}>
          <div class='context-label'>
            tool_call · {text(object(call.function).name, '?')}
          </div>
          <pre>
            {text(
              object(call.function).arguments,
              JSON.stringify(call, null, 2),
            )}
          </pre>
        </div>
      ))}
    </article>
  );
}

export function ContextView({
  state,
  actions,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
}) {
  const context = state.context;
  const messages = useMemo(
    () => array<JsonObject>(context?.messages),
    [context],
  );
  const raw = context ? JSON.stringify(context, null, 2) : '';
  return (
    <div class='view-scroll'>
      <div class='view-column context-column'>
        <div class='view-heading'>
          <div>
            <div class='eyebrow'>NEXT REQUEST PROJECTION</div>
            <h1>Context</h1>
          </div>
          <div class='heading-actions'>
            <span>
              {messages.length} segments · ~
              {Math.ceil(raw.length / 4).toLocaleString()} tok
            </span>
            <button onClick={() => actions.requestContext()}>↻ refresh</button>
            <button disabled={!context} onClick={() => void copy(raw)}>
              ⧉ JSON
            </button>
          </div>
        </div>
        {!context ? (
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
