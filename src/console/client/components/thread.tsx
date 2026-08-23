import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import type { ConsoleState, StreamEntry } from '../types.js';
import { clock, Markdown } from './common.js';
import { isNearBottom, preservePrependScrollTop } from '../scroll.js';
import { attachmentsOf, attachmentUrl, utterance } from '../envelope.js';
import { runAttribution, splitRunResult } from '../run.js';

function roomMatches(entry: StreamEntry, room: string): boolean {
  if (room === 'all' || entry.channel === room) return true;
  return (entry.sends ?? []).some((send) => send.channel === room);
}

function Meta({ entry, agent }: { entry: StreamEntry; agent: string }) {
  const name = entry.author || (entry.role === 'user' ? 'person' : agent);
  return (
    <div class='event-meta'>
      <strong>{name}</strong>
      <span>{entry.channel}</span>
      <time>{clock(entry.ts)}</time>
    </div>
  );
}

function ToolCard({
  call,
}: {
  call: NonNullable<StreamEntry['toolCalls']>[number];
}) {
  return (
    <details class='tool-card'>
      <summary>
        <span class='caret'>▸</span>
        <span>{call.detail || 'run'}</span>
        <code>{call.id}</code>
      </summary>
      <pre>{call.code}</pre>
    </details>
  );
}

function Divider({ entry }: { entry: StreamEntry }) {
  if (entry.kind === 'compaction')
    return (
      <div class='thread-divider'>
        ⟂ compacted {entry.replaced ?? 0} messages
      </div>
    );
  if (entry.kind === 'cachebust')
    return (
      <div class='thread-divider'>
        ↯ cache prefix rewritten · {entry.rewritten ?? 0} tok
      </div>
    );
  if (entry.kind === 'yieldnudge')
    return (
      <div class='thread-divider'>
        ⏱ continuation nudge · {entry.count ?? 1}
      </div>
    );
  return <div class='thread-divider'>{entry.content || entry.kind}</div>;
}

function AttachmentCards({ entry }: { entry: StreamEntry }) {
  const attachments = attachmentsOf(entry.content);
  if (!attachments.length) return null;
  return (
    <div class='attachments'>
      {attachments.map((attachment, index) => {
        const url = attachmentUrl(attachment.localPath);
        const image = attachment.contentType.startsWith('image/');
        return (
          <div class='attachment-card' key={`${attachment.name}-${index}`}>
            {image && url ? (
              <img src={url} alt={attachment.name} loading='lazy' />
            ) : null}
            {url ? (
              <a href={url} target='_blank' rel='noreferrer'>
                {attachment.name}
              </a>
            ) : (
              <span>{attachment.name}</span>
            )}
            <small>
              {attachment.contentType} · {attachment.size.toLocaleString()}{' '}
              bytes
            </small>
          </div>
        );
      })}
    </div>
  );
}

function RunResult({ entry }: { entry: StreamEntry }) {
  const result = splitRunResult(entry.content ?? '');
  const attribution = runAttribution(entry.run);
  return (
    <details class={`run-result ${result.ok ? 'run-ok' : 'run-failed'}`} open>
      <summary>
        <span>{result.ok ? '● run completed' : '● run failed'}</span>
        {entry.run?.detail ? <strong>{String(entry.run.detail)}</strong> : null}
      </summary>
      {attribution ? <div class='run-attribution'>{attribution}</div> : null}
      {result.console ? (
        <>
          <div class='result-label'>console</div>
          <pre class='tool-output'>{result.console}</pre>
        </>
      ) : null}
      <div class='result-label'>
        {result.ok ? 'value → saved as _' : 'error'}
      </div>
      <pre class='tool-output'>{result.value || '(no value)'}</pre>
    </details>
  );
}

function EventCard({
  entry,
  agent,
  room,
}: {
  entry: StreamEntry;
  agent: string;
  room: string;
}) {
  if (entry.kind === 'think-result') return null;
  if (
    ['compaction', 'cachebust', 'cleared', 'yieldnudge'].includes(entry.kind)
  ) {
    return (
      <div class={roomMatches(entry, room) ? '' : 'room-dim'}>
        <Divider entry={entry} />
      </div>
    );
  }
  if (entry.kind === 'notice' || entry.kind === 'system')
    return (
      <div class={`notice ${roomMatches(entry, room) ? '' : 'room-dim'}`}>
        <Markdown value={utterance(entry.content)} />
      </div>
    );
  if (entry.kind === 'summary') {
    const newline = entry.content.indexOf('\n');
    return (
      <div class={`summary-card ${roomMatches(entry, room) ? '' : 'room-dim'}`}>
        <div>❋ earlier memory · summary</div>
        <Markdown
          value={(newline >= 0
            ? entry.content.slice(newline + 1)
            : entry.content
          ).trim()}
        />
      </div>
    );
  }
  const person = entry.role === 'user' || entry.kind === 'user';
  const toolResult = entry.kind === 'tool';
  const content = person ? utterance(entry.content) : entry.content;
  return (
    <article
      class={`event-card ${person ? 'event-person' : 'event-agent'} ${toolResult ? 'event-tool-result' : ''} ${roomMatches(entry, room) ? '' : 'room-dim'}`}
      data-entry-id={entry.id}
    >
      <div class={`avatar ${person ? 'avatar-person' : 'avatar-agent'}`}>
        {person ? (entry.author?.[0] || 'P').toUpperCase() : '◆'}
      </div>
      <div class='event-content'>
        <Meta entry={entry} agent={agent} />
        {entry.reasoning_content ? (
          <details class='thought-card'>
            <summary>❋ thinking</summary>
            <div>{entry.reasoning_content}</div>
          </details>
        ) : null}
        {content?.trim() ? (
          toolResult ? (
            <RunResult entry={entry} />
          ) : (
            <Markdown value={content} className='prose' />
          )
        ) : null}
        {person ? <AttachmentCards entry={entry} /> : null}
        {(entry.toolCalls ?? []).map((call) => (
          <ToolCard key={call.id} call={call} />
        ))}
        {(entry.sends ?? []).map((send, index) => (
          <div class='send-card' key={`${send.channel}-${index}`}>
            <div>delivered ✓ · {send.channel}</div>
            <Markdown value={send.text} />
          </div>
        ))}
      </div>
    </article>
  );
}

function LiveCard({ state }: { state: ConsoleState }) {
  const live = state.live;
  if (!live) return null;
  return (
    <article class='event-card event-agent event-live'>
      <div class='avatar avatar-agent'>◆</div>
      <div class='event-content'>
        <div class='event-meta'>
          <strong>{state.meta?.botTag || 'agent'}</strong>
          <span class='live-label'>live</span>
        </div>
        {live.reasoning ? (
          <details class='thought-card' open>
            <summary>❋ thinking</summary>
            <div>{live.reasoning}</div>
          </details>
        ) : null}
        {live.content ? (
          <div class='stream-text'>
            {live.content}
            <span class='stream-caret' />
          </div>
        ) : (
          <div class='thinking-line'>
            <span /> thinking
          </div>
        )}
      </div>
    </article>
  );
}

export function ThreadView({
  state,
  actions,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const previous = useRef({
    first: state.messages[0]?.id,
    height: 0,
    top: 0,
    length: state.messages.length,
  });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const first = state.messages[0]?.id;
    if (
      previous.current.first !== undefined &&
      first !== previous.current.first &&
      state.messages.length > previous.current.length
    ) {
      node.scrollTop = preservePrependScrollTop(
        previous.current.top,
        previous.current.height,
        node.scrollHeight,
      );
    } else if (atBottom) {
      node.scrollTop = node.scrollHeight;
    }
    previous.current = {
      first,
      height: node.scrollHeight,
      top: node.scrollTop,
      length: state.messages.length,
    };
  }, [state.messages, state.live, atBottom]);

  useEffect(() => {
    if (state.view === 'thread' && atBottom && ref.current)
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [state.view, atBottom]);

  const onScroll = (): void => {
    const node = ref.current;
    if (!node) return;
    const bottom = isNearBottom(node);
    setAtBottom(bottom);
    previous.current = {
      ...previous.current,
      height: node.scrollHeight,
      top: node.scrollTop,
    };
    if (node.scrollTop < 120) actions.requestBackfill();
  };

  return (
    <div class='view-scroll thread-scroll' ref={ref} onScroll={onScroll}>
      <div class='view-column thread-column'>
        {state.loadingHistory ? (
          <div class='loading-row'>loading earlier context…</div>
        ) : null}
        {state.messages.map((entry) => (
          <EventCard
            key={entry.id}
            entry={entry}
            agent={state.meta?.botTag || 'agent'}
            room={state.room}
          />
        ))}
        <LiveCard state={state} />
      </div>
      {!atBottom ? (
        <button
          class='latest-button'
          onClick={() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          }}
        >
          ↓ latest
        </button>
      ) : null}
    </div>
  );
}
