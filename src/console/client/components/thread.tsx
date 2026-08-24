import type { ComponentChildren } from 'preact';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import type { ConsoleState, MindItem, StreamEntry } from '../types.js';
import { object, text } from '../types.js';
import { attachmentsOf, attachmentUrl, utterance } from '../envelope.js';
import {
  formatRunSource,
  resultSummary,
  splitRunResult,
  statementCount,
  wakePresentation,
} from '../run.js';
import { isNearBottom, preservePrependScrollTop } from '../scroll.js';
import { clock, duration, Markdown } from './common.js';

function roomMatches(entry: StreamEntry, room: string): boolean {
  if (room === 'all' || entry.channel === room) return true;
  return (entry.sends ?? []).some((send) => send.channel === room);
}

function cleanTag(value: string): string {
  return value.replace(/#\d{4,}$/, '');
}

function displayName(entry: StreamEntry, fallback: string): string {
  const author = entry.displayName?.trim() || entry.author?.trim();
  if (!author) return cleanTag(fallback);
  if (/^\d{12,}$/.test(author))
    return entry.channel === 'console' ? 'console' : 'person';
  return cleanTag(author);
}

function Item({
  entry,
  room,
  children,
}: {
  entry: StreamEntry;
  room: string;
  children: ComponentChildren;
}) {
  return (
    <div
      class={`thread-item ${roomMatches(entry, room) ? '' : 'thread-item-dim'}`}
    >
      {children}
    </div>
  );
}

function MessageMeta({
  entry,
  name,
  reply = false,
}: {
  entry: StreamEntry;
  name: string;
  reply?: boolean;
}) {
  return (
    <div class={`message-meta ${reply ? 'message-meta-reply' : ''}`}>
      <strong>{name}</strong>
      {!reply ? <span>{entry.channel}</span> : null}
      <time>{clock(entry.ts)}</time>
    </div>
  );
}

function PersonMessage({ entry }: { entry: StreamEntry }) {
  const name = displayName(entry, 'person');
  const content = utterance(entry.content);
  const attachments = attachmentsOf(entry.content);
  return (
    <div class='message-row'>
      <div class='message-avatar person-avatar'>
        {name[0]?.toUpperCase() || 'P'}
      </div>
      <div class='message-copy'>
        <MessageMeta entry={entry} name={name} />
        {content ? (
          <Markdown value={content} className='message-prose' />
        ) : null}
        {attachments.length ? (
          <AttachmentCards attachments={attachments} />
        ) : null}
      </div>
    </div>
  );
}

function ReplyMessage({
  entry,
  agent,
  value,
}: {
  entry: StreamEntry;
  agent: string;
  value: string;
}) {
  return (
    <div class='message-row'>
      <div class='message-avatar agent-avatar'>◆</div>
      <div class='message-copy'>
        <MessageMeta entry={entry} name={agent} reply />
        <Markdown value={value} className='message-prose reply-prose' />
      </div>
    </div>
  );
}

function ThoughtCard({ value }: { value: string }) {
  return (
    <details class='thought-surface'>
      <summary>
        <span>❋</span>
        <strong>thinking</strong>
      </summary>
      <div>{value}</div>
    </details>
  );
}

function syntaxClass(token: string): string {
  if (/^(?:'[^']*'|"[^"]*"|`[^`]*`)$/.test(token)) return 'syntax-string';
  if (
    /^(?:const|let|var|return|await|async|if|else|for|while|new|throw|try|catch|true|false|null|undefined)$/.test(
      token,
    )
  )
    return 'syntax-keyword';
  if (/^\d+(?:\.\d+)?$/.test(token)) return 'syntax-number';
  if (
    /^(?:elpis|fs|console|process|require|JSON|Object|Array|Promise)$/.test(
      token,
    )
  )
    return 'syntax-object';
  if (/^\/\//.test(token)) return 'syntax-comment';
  return '';
}

function HighlightedCode({ value }: { value: string }) {
  const parts = value.split(
    /((?:'[^'\n]*'|"[^"\n]*"|`[^`]*`)|\b(?:const|let|var|return|await|async|if|else|for|while|new|throw|try|catch|true|false|null|undefined|elpis|fs|console|process|require|JSON|Object|Array|Promise)\b|\b\d+(?:\.\d+)?\b|\/\/[^\n]*)/g,
  );
  return (
    <code>
      {parts.map((part, index) => (
        <span class={syntaxClass(part)} key={index}>
          {part}
        </span>
      ))}
    </code>
  );
}

function FormattedCode({
  call,
}: {
  call: NonNullable<StreamEntry['toolCalls']>[number];
}) {
  const [value, setValue] = useState(call.code);
  useEffect(() => {
    let current = true;
    setValue(call.code);
    void formatRunSource(call).then((formatted) => {
      if (current) setValue(formatted);
    });
    return () => {
      current = false;
    };
  }, [call.code, call.display]);
  return <HighlightedCode value={value} />;
}

function CodeCard({
  call,
  result,
  startedAt,
}: {
  call: NonNullable<StreamEntry['toolCalls']>[number];
  result?: StreamEntry;
  startedAt?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const detail = call.detail || 'run code';
  const count = statementCount(call.code);
  const elapsed = duration(startedAt, result?.ts);
  const outcome = result ? splitRunResult(result.content) : null;
  return (
    <div
      class={`code-card ${outcome && !outcome.ok ? 'code-card-failed' : ''}`}
    >
      <button class='code-card-head' onClick={() => setOpen(!open)}>
        <span class='code-caret'>{open ? '▾' : '▸'}</span>
        <span class='surface-label'>ran code</span>
        <span class='code-summary'>
          {count} {count === 1 ? 'statement' : 'statements'} · {detail}
        </span>
        <span class='surface-spacer' />
        <span class='surface-time'>{elapsed}</span>
      </button>
      {open ? (
        <pre class='code-body'>
          <FormattedCode call={call} />
        </pre>
      ) : null}
      <div class='code-result'>
        <span>result</span>
        <strong>{result ? resultSummary(result.content) : 'running…'}</strong>
        <code title={call.id}>{call.id}</code>
      </div>
    </div>
  );
}

export interface DiffPreviewLine {
  kind: 'same' | 'add' | 'remove';
  number: number | null;
  text: string;
}

export function editDiffPreview(
  before: string,
  after: string,
  maxChanged = 80,
): DiffPreviewLine[] {
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const output: DiffPreviewLine[] = [];
  for (let i = Math.max(0, prefix - 2); i < prefix; i++)
    output.push({ kind: 'same', number: i + 1, text: left[i] ?? '' });
  const removed = left.slice(prefix, left.length - suffix).slice(0, maxChanged);
  const added = right.slice(prefix, right.length - suffix).slice(0, maxChanged);
  removed.forEach((text, index) =>
    output.push({ kind: 'remove', number: prefix + index + 1, text }),
  );
  added.forEach((text, index) =>
    output.push({ kind: 'add', number: prefix + index + 1, text }),
  );
  for (
    let i = right.length - suffix;
    i < Math.min(right.length, right.length - suffix + 2);
    i++
  )
    output.push({ kind: 'same', number: i + 1, text: right[i] ?? '' });
  return output;
}

export function operationDisplayTarget(target: string): string {
  const normalized = target.replaceAll('\\', '/');
  const repositoryMarker = '/elpis-harness/';
  const repositoryIndex = normalized.lastIndexOf(repositoryMarker);
  if (repositoryIndex >= 0)
    return normalized.slice(repositoryIndex + repositoryMarker.length);
  if (!normalized.startsWith('/')) return normalized;
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : normalized;
}

type OperationReceipt = NonNullable<
  NonNullable<StreamEntry['toolCalls']>[number]['operations']
>[number];

function mindOperationLabel(name: string): string {
  const action = name.split('.').at(-1) ?? 'operation';
  return (
    (
      {
        add: 'created Mind item',
        done: 'completed Mind item',
        cancel: 'cancelled Mind item',
        comment: 'commented on Mind',
        reply: 'replied in Mind',
        update: 'updated Mind item',
        status: 'changed Mind status',
        get: 'read Mind item',
        list: 'listed Mind items',
        ready: 'read ready Mind items',
        graph: 'read Mind graph',
        depends: 'linked Mind dependency',
        unlinks: 'removed Mind dependency',
        tag: 'tagged Mind item',
        untag: 'untagged Mind item',
        remind: 'set Mind reminder',
      } as Record<string, string>
    )[action] ?? `Mind · ${action}`
  );
}

function operationLabel(operation: OperationReceipt): string {
  if (operation.kind === 'edit') return 'edited file';
  if (operation.kind === 'shell') return 'ran command';
  if (operation.kind === 'mind') return mindOperationLabel(operation.name);
  if (operation.kind === 'file')
    return /write|append/i.test(operation.name) ? 'wrote file' : 'read file';
  if (operation.kind === 'git')
    return `git · ${operation.name.split('.').at(-1) ?? 'operation'}`;
  return 'desktop';
}

export function operationMindId(operation: {
  kind: string;
  target: string;
  targetLiteral?: boolean;
}): string | null {
  return operation.kind === 'mind' &&
    operation.targetLiteral === true &&
    /^elm-[a-z0-9]+$/i.test(operation.target)
    ? operation.target
    : null;
}

export function operationReceiptUseful(operation: {
  kind: string;
  target: string;
  targetLiteral?: boolean;
}): boolean {
  if (operation.kind === 'mind') return operationMindId(operation) !== null;
  if (operation.kind === 'file') return operation.targetLiteral === true;
  return true;
}

function OperationCard({
  operation,
  callId,
  detail,
  mindItems,
  onOpenMind,
}: {
  operation: OperationReceipt;
  result?: StreamEntry;
  callId: string;
  detail?: string;
  mindItems: MindItem[];
  onOpenMind(id: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const target = operationDisplayTarget(operation.target);
  const mindId = operationMindId(operation);
  if (operation.kind === 'mind') {
    if (!mindId) return null;
    const item = mindItems.find((candidate) => candidate.id === mindId);
    return (
      <button
        class='operation-compact operation-mind-link'
        onClick={() => onOpenMind(mindId)}
        title={`Open ${mindId} in Mind`}
      >
        <span class='surface-label'>{operationLabel(operation)}</span>
        <strong>{item?.title || mindId}</strong>
        {item?.status ? <span>{item.status.replaceAll('_', ' ')}</span> : null}
        <code>{mindId}</code>
        <i>→</i>
      </button>
    );
  }
  if (!operationReceiptUseful(operation)) return null;
  if (operation.kind !== 'edit') {
    const summary =
      operation.kind === 'computer'
        ? detail || target
        : operation.kind === 'git' && target === '—'
          ? operation.name.split('.').at(-1) || 'operation'
          : target;
    return (
      <div
        class={`operation-compact operation-${operation.kind}-compact`}
        title={`${operation.name} · ${callId}`}
      >
        <span class='surface-label'>{operationLabel(operation)}</span>
        <strong>{summary}</strong>
      </div>
    );
  }
  const diff =
    operation.before !== undefined && operation.after !== undefined
      ? editDiffPreview(operation.before, operation.after)
      : [];
  const added = diff.filter((line) => line.kind === 'add').length;
  const removed = diff.filter((line) => line.kind === 'remove').length;
  const canExpand = (operation.after?.split('\n').length ?? 0) > 8;
  return (
    <div class='operation-card operation-edit'>
      <header>
        <span class='surface-label'>edited file</span>
        <strong>{target}</strong>
        <span class='surface-spacer' />
        <span class='operation-counts'>
          <b>+{added}</b>
          <i>−{removed}</i>
        </span>
      </header>
      {expanded && operation.after ? (
        <pre class='operation-full-value'>{operation.after}</pre>
      ) : diff.length ? (
        <pre class='operation-diff'>
          {diff.map((line, index) => (
            <span class={`diff-${line.kind}`} key={index}>
              <b>{line.number ?? ''}</b>
              <i>
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
              </i>
              <code>{line.text}</code>
            </span>
          ))}
        </pre>
      ) : null}
      <footer>
        {canExpand ? (
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? '− collapse' : '+ show full value'}
          </button>
        ) : (
          <span>edit receipt</span>
        )}
        <span class='surface-spacer' />
        <code title={callId}>{callId}</code>
      </footer>
    </div>
  );
}

function WakeCard({ entry }: { entry: StreamEntry }) {
  const [raw, setRaw] = useState(false);
  const wake = wakePresentation(entry.run);
  if (!wake) return null;
  return (
    <div class='wake-card'>
      <span class='wake-glyph'>⏱</span>
      <div>
        <strong>{wake.when}</strong>
        <span>{wake.reason}</span>
      </div>
      <span class='surface-spacer' />
      <button onClick={() => setRaw(!raw)}>raw</button>
      {raw ? <code>{wake.raw}</code> : null}
    </div>
  );
}

function SendCard({ channel, value }: { channel: string; value: string }) {
  return (
    <div class='send-surface'>
      <header>
        <span class='surface-label'>sent message</span>
        <strong>{channel}</strong>
        <span class='surface-spacer' />
        <span>delivered ✓</span>
      </header>
      <Markdown value={value} className='send-body' />
    </div>
  );
}

function BackgroundCard({ entry }: { entry: StreamEntry }) {
  const run = object(entry.run);
  if (run.detached !== true) return null;
  const result = splitRunResult(entry.content);
  return (
    <div class='background-card'>
      <header>
        <span class='surface-label'>background job</span>
        <strong>{text(run.detail, 'detached run')}</strong>
        <span class='surface-spacer' />
        <span class='background-state'>
          <i /> running
        </span>
      </header>
      {result.console ? <pre>{result.console}</pre> : null}
      <footer>
        <span>{text(run.bgId)}</span>
      </footer>
    </div>
  );
}

function AttachmentCards({
  attachments,
}: {
  attachments: ReturnType<typeof attachmentsOf>;
}) {
  return (
    <div class='attachment-grid'>
      {attachments.map((attachment, index) => {
        const url = attachmentUrl(attachment.localPath);
        const image = attachment.contentType.startsWith('image/');
        return (
          <div class='attachment-surface' key={`${attachment.name}-${index}`}>
            <header>
              <span class='surface-label'>
                {image ? 'image' : 'attachment'}
              </span>
              <strong>{attachment.name}</strong>
              <span class='surface-spacer' />
              <span>{attachment.size.toLocaleString()} bytes</span>
            </header>
            {image && url ? (
              <img src={url} alt={attachment.name} loading='lazy' />
            ) : null}
            {url ? (
              <a href={url} target='_blank' rel='noreferrer'>
                open attachment
              </a>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function WatchSurface({ entry }: { entry: StreamEntry }) {
  const summary = utterance(entry.content).replace(/^\[watch\]\s*/i, '');
  return (
    <div class='desktop-surface'>
      <header>
        <span class='surface-label'>desktop</span>
        <strong>{summary || 'visual inspection frame'}</strong>
        <span class='surface-spacer' />
        <span>{clock(entry.ts)}</span>
      </header>
      <div>
        {entry.frameUrl ? (
          <a href={entry.frameUrl} target='_blank' rel='noreferrer'>
            <img
              class='desktop-frame'
              src={entry.frameUrl}
              alt={summary || 'post-action desktop frame'}
              loading='lazy'
            />
          </a>
        ) : (
          <div class='desktop-frame'>frame unavailable</div>
        )}
        <div>
          <code>computer / motor</code>
          <span>captured</span>
          <strong>post-action desktop frame</strong>
          <p>
            The harness delivered this bounded frame with the event receipt.
          </p>
        </div>
      </div>
    </div>
  );
}

function InternalEventCard({ entry }: { entry: StreamEntry }) {
  const labels = {
    harness: 'harness event',
    background: 'background completion',
    restart: 'restart receipt',
    memory: 'memory context',
  } as const;
  const kind =
    entry.eventKind === 'person' || entry.eventKind === 'watch'
      ? 'harness'
      : (entry.eventKind ?? 'harness');
  const body = utterance(entry.content);
  const preview = body.split('\n', 1)[0] || labels[kind];
  return (
    <details class={`internal-event internal-event-${kind}`}>
      <summary>
        <span>◆</span>
        <strong>{labels[kind]}</strong>
        <code>{entry.displayName || 'harness'}</code>
        <span class='surface-spacer' />
        <time>{clock(entry.ts)}</time>
      </summary>
      <div>
        <span>{preview}</span>
        <pre>{body}</pre>
      </div>
    </details>
  );
}

function Divider({ entry }: { entry: StreamEntry }) {
  const labels: Record<string, string> = {
    compaction: `⟂ compacted ${entry.replaced ?? 0} messages`,
    cachebust: `↯ cache prefix rewritten · ${entry.rewritten ?? 0} tok`,
    yieldnudge: `⏱ continuation nudge · ${entry.count ?? 1}`,
    cleared: 'thread cleared',
  };
  return (
    <div class='thread-divider'>
      {labels[entry.kind] || entry.content || entry.kind}
    </div>
  );
}

function Entry({
  entry,
  resultByCall,
  room,
  agent,
  mindItems,
  onOpenMind,
}: {
  entry: StreamEntry;
  resultByCall: Map<string, StreamEntry>;
  room: string;
  agent: string;
  mindItems: MindItem[];
  onOpenMind(id: string): void;
}) {
  if (entry.kind === 'think-result' || entry.kind === 'tool') return null;
  if (['compaction', 'cachebust', 'cleared', 'yieldnudge'].includes(entry.kind))
    return (
      <Item entry={entry} room={room}>
        <Divider entry={entry} />
      </Item>
    );
  if (entry.kind === 'notice' || entry.kind === 'system')
    return (
      <Item entry={entry} room={room}>
        <div class='thread-notice'>
          <Markdown value={utterance(entry.content)} />
        </div>
      </Item>
    );
  if (entry.kind === 'summary') {
    const newline = entry.content.indexOf('\n');
    return (
      <Item entry={entry} room={room}>
        <details class='memory-surface'>
          <summary>❋ earlier memory · summary</summary>
          <Markdown
            value={(newline >= 0
              ? entry.content.slice(newline + 1)
              : entry.content
            ).trim()}
          />
        </details>
      </Item>
    );
  }
  const person = entry.role === 'user' || entry.kind === 'user';
  if (person)
    return (
      <Item entry={entry} room={room}>
        {entry.eventKind === 'watch' ? (
          <WatchSurface entry={entry} />
        ) : entry.eventKind && entry.eventKind !== 'person' ? (
          <InternalEventCard entry={entry} />
        ) : (
          <PersonMessage entry={entry} />
        )}
      </Item>
    );
  const content = entry.content?.trim();
  return (
    <Item entry={entry} room={room}>
      {entry.reasoning_content ? (
        <ThoughtCard value={entry.reasoning_content} />
      ) : null}
      {content ? (
        <ReplyMessage entry={entry} agent={agent} value={content} />
      ) : null}
      {(entry.toolCalls ?? []).map((call) => {
        const result = resultByCall.get(call.id);
        return (
          <div class='tool-sequence' key={call.id}>
            <CodeCard call={call} result={result} startedAt={entry.ts} />
            {(call.operations ?? []).map((operation, index) => (
              <OperationCard
                key={`${operation.name}-${index}`}
                operation={operation}
                result={result}
                callId={call.id}
                detail={call.detail}
                mindItems={mindItems}
                onOpenMind={onOpenMind}
              />
            ))}
            {result ? <BackgroundCard entry={result} /> : null}
            {(result?.sends ?? []).map((send, index) => (
              <SendCard
                key={`${send.channel}-${index}`}
                channel={send.channel}
                value={send.text}
              />
            ))}
            {result ? <WakeCard entry={result} /> : null}
          </div>
        );
      })}
      {(entry.sends ?? []).map((send, index) => (
        <SendCard
          key={`${send.channel}-${index}`}
          channel={send.channel}
          value={send.text}
        />
      ))}
    </Item>
  );
}

export function ThreadStream({
  entries,
  room,
  agent,
  live,
  mindItems,
  onOpenMind,
}: {
  entries: StreamEntry[];
  room: string;
  agent: string;
  live?: ConsoleState['live'];
  mindItems: MindItem[];
  onOpenMind(id: string): void;
}) {
  const resultByCall = useMemo(
    () =>
      new Map(
        entries
          .filter((entry) => entry.kind === 'tool' && entry.tool_call_id)
          .map((entry) => [entry.tool_call_id as string, entry]),
      ),
    [entries],
  );
  return (
    <div class='thread-stream'>
      {entries.map((entry) => (
        <Entry
          key={entry.id}
          entry={entry}
          resultByCall={resultByCall}
          room={room}
          agent={agent}
          mindItems={mindItems}
          onOpenMind={onOpenMind}
        />
      ))}
      {live ? (
        <div class='thread-item'>
          {live.reasoning ? <ThoughtCard value={live.reasoning} /> : null}
          <div class='message-row'>
            <div class='message-avatar agent-avatar live-avatar'>◆</div>
            <div class='message-copy'>
              <div class='message-meta message-meta-reply'>
                <strong>{agent}</strong>
                <span class='writing-pill'>writing</span>
              </div>
              <div class='message-prose reply-prose streaming-copy'>
                {live.content || 'thinking'}
                <i />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
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

  return (
    <div
      class='thread-scroll'
      ref={ref}
      onScroll={() => {
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
      }}
    >
      <ThreadStream
        entries={state.messages}
        room={state.room}
        agent={cleanTag(state.meta?.botTag || 'agent')}
        live={state.live}
        mindItems={state.mindItems}
        onOpenMind={(id) => {
          actions.selectMind(id);
          actions.setView('mind');
        }}
      />
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
