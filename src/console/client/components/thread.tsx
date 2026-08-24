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

export type CodeLanguage =
  | 'javascript'
  | 'json'
  | 'css'
  | 'markup'
  | 'shell'
  | 'config'
  | 'markdown'
  | 'plain';

export function codeLanguageForPath(target: string): CodeLanguage {
  const clean = target.toLowerCase().split(/[?#]/, 1)[0] ?? '';
  const extension = clean.includes('.') ? (clean.split('.').at(-1) ?? '') : '';
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension))
    return 'javascript';
  if (extension === 'json' || extension === 'jsonl') return 'json';
  if (['css', 'scss', 'less'].includes(extension)) return 'css';
  if (['html', 'htm', 'xml', 'svg'].includes(extension)) return 'markup';
  if (['sh', 'bash', 'zsh', 'fish'].includes(extension)) return 'shell';
  if (['yaml', 'yml', 'toml', 'ini'].includes(extension)) return 'config';
  if (['md', 'mdx', 'markdown'].includes(extension)) return 'markdown';
  return 'plain';
}

function syntaxPattern(language: CodeLanguage): RegExp | null {
  if (language === 'javascript')
    return /((?:'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)|\b(?:const|let|var|return|await|async|if|else|for|while|new|throw|try|catch|true|false|null|undefined|elpis|fs|console|process|require|JSON|Object|Array|Promise)\b|\b\d+(?:\.\d+)?\b|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;
  if (language === 'json')
    return /("(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/gi;
  if (language === 'css')
    return /((?:'[^'\n]*'|"[^"\n]*")|\/\*[\s\S]*?\*\/|#[0-9a-f]{3,8}\b|--[a-z0-9_-]+|-?\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg)?\b)/gi;
  if (language === 'markup')
    return /(<!--[\s\S]*?-->|<\/?[a-z][^>]*>|"[^"\n]*"|'[^'\n]*')/gi;
  if (language === 'shell')
    return /((?:'[^'\n]*'|"[^"\n]*")|#[^\n]*|\$\{?[a-z_][a-z0-9_]*\}?|\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|export|local|sudo)\b|\b\d+\b)/gi;
  if (language === 'config')
    return /((?:'[^'\n]*'|"[^"\n]*")|#[^\n]*|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b|^[ \t]*[a-z0-9_.-]+(?=\s*[:=]))/gim;
  if (language === 'markdown')
    return /(`[^`\n]+`|^#{1,6}\s+[^\n]*|\[[^\]]+\]\([^)]+\)|^>\s+[^\n]*)/gm;
  return null;
}

function syntaxClass(token: string, language: CodeLanguage): string {
  if (/^(?:'[^']*'|"[^"]*"|`[^`]*`)$/.test(token)) return 'syntax-string';
  if (/^(?:\/\/|\/\*|#(?![0-9a-f]{3,8}\b)|<!--)/i.test(token))
    return 'syntax-comment';
  if (
    /^(?:const|let|var|return|await|async|if|then|else|elif|fi|for|while|do|done|case|esac|new|throw|try|catch|true|false|null|undefined|export|local|sudo)$/i.test(
      token,
    )
  )
    return 'syntax-keyword';
  if (/^-?\d|^#[0-9a-f]{3,8}$/i.test(token)) return 'syntax-number';
  if (
    language === 'markup' ||
    /^(?:elpis|fs|console|process|require|JSON|Object|Array|Promise|\$|--)/.test(
      token,
    ) ||
    (language === 'config' && /[a-z0-9_.-]/i.test(token)) ||
    (language === 'markdown' && /^(?:#|>|\[)/.test(token))
  )
    return 'syntax-object';
  if (language === 'javascript' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token))
    return 'syntax-identifier';
  return '';
}

export function syntaxTokens(
  value: string,
  language: CodeLanguage,
): Array<{ value: string; className: string }> {
  const pattern = syntaxPattern(language);
  const parts = pattern ? value.split(pattern) : [value];
  return parts.map((part) => ({
    value: part,
    className: syntaxClass(part, language),
  }));
}

function HighlightedCode({
  value,
  language = 'javascript',
}: {
  value: string;
  language?: CodeLanguage;
}) {
  return (
    <code>
      {syntaxTokens(value, language).map((part, index) => (
        <span class={part.className} key={index}>
          {part.value}
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

export interface RuntimeOperationReceipt {
  sequence: number;
  kind: 'shell' | 'git' | 'file';
  name: string;
  command: string;
  commandBytes?: number;
  commandTruncated?: boolean;
  state: 'running' | 'completed' | 'failed';
  startedAt: number;
  durationMs?: number;
  ok?: boolean;
  code?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  error?: string;
}

export function runtimeOperationReceipts(
  entry: StreamEntry | undefined,
): RuntimeOperationReceipt[] {
  const raw = object(entry?.run).operationReceipts;
  if (!Array.isArray(raw)) return [];
  const receipts: RuntimeOperationReceipt[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) break;
    const source = value as Record<string, unknown>;
    if (
      source.sequence !== receipts.length ||
      (source.kind !== 'shell' &&
        source.kind !== 'git' &&
        source.kind !== 'file') ||
      typeof source.name !== 'string' ||
      typeof source.command !== 'string' ||
      (source.state !== 'running' &&
        source.state !== 'completed' &&
        source.state !== 'failed') ||
      typeof source.startedAt !== 'number'
    )
      break;
    receipts.push(source as unknown as RuntimeOperationReceipt);
  }
  return receipts;
}

export function hasRuntimeOperationLedger(
  entry: StreamEntry | undefined,
): boolean {
  return Array.isArray(object(entry?.run).operationReceipts);
}

export function runtimeOperationReceiptsDropped(
  entry: StreamEntry | undefined,
): number {
  const value = object(entry?.run).operationReceiptsDropped;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

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
  const language = codeLanguageForPath(operation.target);
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
        <pre class='operation-full-value'>
          <HighlightedCode value={operation.after} language={language} />
        </pre>
      ) : diff.length ? (
        <pre class='operation-diff'>
          {diff.map((line, index) => (
            <span class={`diff-${line.kind}`} key={index}>
              <b>{line.number ?? ''}</b>
              <i>
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
              </i>
              <HighlightedCode value={line.text} language={language} />
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

function runtimeReceiptState(receipt: RuntimeOperationReceipt): string {
  if (receipt.state === 'running') return 'running';
  if (receipt.kind === 'file' && receipt.state === 'completed') return 'read';
  if (receipt.state === 'failed') return 'failed';
  if (receipt.signal) return receipt.signal.toLowerCase();
  if (receipt.code !== undefined && receipt.code !== null)
    return `exit ${receipt.code}`;
  return receipt.ok ? 'completed' : 'failed';
}

function runtimeReceiptDuration(receipt: RuntimeOperationReceipt): string {
  if (receipt.durationMs === undefined) return '';
  if (receipt.durationMs < 1000) return `${receipt.durationMs}ms`;
  return `${(receipt.durationMs / 1000).toFixed(receipt.durationMs < 10_000 ? 1 : 0)}s`;
}

function streamLabel(
  shown: string | undefined,
  total: number | undefined,
  truncated: boolean | undefined,
): string {
  const shownBytes = new TextEncoder().encode(shown ?? '').length;
  return truncated && total !== undefined
    ? `${shownBytes.toLocaleString()} of ${total.toLocaleString()} bytes`
    : `${(total ?? shownBytes).toLocaleString()} bytes`;
}

function RuntimeOperationCard({
  receipt,
  callId,
}: {
  receipt: RuntimeOperationReceipt;
  callId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = receipt.state !== 'running';
  const label =
    receipt.kind === 'git'
      ? `git · ${receipt.name}`
      : receipt.kind === 'file'
        ? receipt.name === 'grep'
          ? 'searched files'
          : 'read file'
        : 'ran command';
  const state = runtimeReceiptState(receipt);
  const elapsed = runtimeReceiptDuration(receipt);
  return (
    <div
      class={`runtime-operation runtime-operation-${receipt.state} ${receipt.ok === false ? 'runtime-operation-bad' : ''}`}
    >
      <button
        class={`operation-compact operation-${receipt.kind}-compact`}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-expanded={canExpand ? expanded : undefined}
        title={`${receipt.name} · ${callId} · invocation ${receipt.sequence + 1}`}
      >
        <span class='surface-label'>{label}</span>
        <strong>
          {receipt.command}
          {receipt.commandTruncated ? '…' : ''}
        </strong>
        <span>{state}</span>
        {elapsed ? <code>{elapsed}</code> : null}
        {canExpand ? <i>{expanded ? '▾' : '▸'}</i> : null}
      </button>
      {expanded ? (
        <div class='runtime-operation-output'>
          {receipt.stdout ? (
            <section>
              <header>
                <span>stdout</span>
                <code>
                  {streamLabel(
                    receipt.stdout,
                    receipt.stdoutBytes,
                    receipt.stdoutTruncated,
                  )}
                </code>
              </header>
              <pre>{receipt.stdout}</pre>
            </section>
          ) : null}
          {receipt.stderr ? (
            <section class='runtime-stderr'>
              <header>
                <span>stderr</span>
                <code>
                  {streamLabel(
                    receipt.stderr,
                    receipt.stderrBytes,
                    receipt.stderrTruncated,
                  )}
                </code>
              </header>
              <pre>{receipt.stderr}</pre>
            </section>
          ) : null}
          {receipt.error ? (
            <section class='runtime-stderr'>
              <header>
                <span>error</span>
              </header>
              <pre>{receipt.error}</pre>
            </section>
          ) : null}
          {!receipt.stdout && !receipt.stderr && !receipt.error ? (
            <div class='runtime-no-output'>no output</div>
          ) : null}
        </div>
      ) : null}
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
  const [viewer, setViewer] = useState<{ url: string; name: string } | null>(
    null,
  );
  useEffect(() => {
    if (!viewer) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewer(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [viewer]);
  return (
    <>
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
                <button
                  class='attachment-image-button'
                  onClick={() => setViewer({ url, name: attachment.name })}
                  aria-label={`View ${attachment.name}`}
                >
                  <img src={url} alt={attachment.name} loading='lazy' />
                </button>
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
      {viewer ? (
        <div class='image-viewer-layer' onClick={() => setViewer(null)}>
          <div
            class='image-viewer'
            role='dialog'
            aria-modal='true'
            aria-label={viewer.name}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <strong>{viewer.name}</strong>
              <a href={viewer.url} target='_blank' rel='noreferrer'>
                open original
              </a>
              <button onClick={() => setViewer(null)} aria-label='Close image'>
                ×
              </button>
            </header>
            <img src={viewer.url} alt={viewer.name} />
          </div>
        </div>
      ) : null}
    </>
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

export interface ParsedMemoryContext {
  heading: string;
  source: string | null;
  frontmatter: Array<{ key: string; value: string }>;
  markdown: string;
}

export function parseMemoryContext(value: string): ParsedMemoryContext {
  const lines = value.trim().split('\n');
  const heading = /^\[person-memory[^\]]*\]$/.test(lines[0] ?? '')
    ? (lines.shift() ?? 'memory context')
    : 'memory context';
  const sourceMatch = (lines[0] ?? '').match(/^---\s+(.+?)\s+---$/);
  const source = sourceMatch ? (lines.shift(), sourceMatch[1] ?? null) : null;
  const frontmatter: Array<{ key: string; value: string }> = [];
  if (lines[0]?.trim() === '---') {
    lines.shift();
    while (lines.length && lines[0]?.trim() !== '---') {
      const line = lines.shift() ?? '';
      const colon = line.indexOf(':');
      if (colon > 0)
        frontmatter.push({
          key: line.slice(0, colon).trim(),
          value: line.slice(colon + 1).trim(),
        });
    }
    if (lines[0]?.trim() === '---') lines.shift();
  }
  return {
    heading,
    source,
    frontmatter,
    markdown: lines.join('\n').trim(),
  };
}

function MemoryContextCard({ entry }: { entry: StreamEntry }) {
  const memory = parseMemoryContext(utterance(entry.content));
  return (
    <details class='memory-context-surface' open>
      <summary>
        <span>◆</span>
        <strong>memory context</strong>
        {memory.source ? <code>{memory.source}</code> : null}
        <span class='surface-spacer' />
        <time>{clock(entry.ts)}</time>
      </summary>
      <div class='memory-context-body'>
        <small>{memory.heading}</small>
        {memory.frontmatter.length ? (
          <table>
            <tbody>
              {memory.frontmatter.map((field) => (
                <tr key={field.key}>
                  <th>{field.key}</th>
                  <td>{field.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <Markdown value={memory.markdown} className='memory-markdown' />
      </div>
    </details>
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
  if (kind === 'memory') return <MemoryContextCard entry={entry} />;
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
        const runtimeReceipts = runtimeOperationReceipts(result);
        const runtimeReceiptsDropped = runtimeOperationReceiptsDropped(result);
        const hasRuntimeCommands = hasRuntimeOperationLedger(result);
        return (
          <div class='tool-sequence' key={call.id}>
            <CodeCard call={call} result={result} startedAt={entry.ts} />
            {(call.operations ?? [])
              .filter(
                (operation) =>
                  !hasRuntimeCommands ||
                  (operation.kind !== 'shell' &&
                    operation.kind !== 'git' &&
                    operation.kind !== 'file'),
              )
              .map((operation, index) => (
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
            {runtimeReceipts.map((receipt) => (
              <RuntimeOperationCard
                key={`${receipt.kind}-${receipt.sequence}`}
                receipt={receipt}
                callId={call.id}
              />
            ))}
            {runtimeReceiptsDropped ? (
              <div class='runtime-operation-omitted'>
                +{runtimeReceiptsDropped.toLocaleString()} more command
                {runtimeReceiptsDropped === 1 ? '' : 's'} not retained
              </div>
            ) : null}
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
      {live?.content ? (
        <div class='thread-item'>
          <div class='message-row'>
            <div class='message-avatar agent-avatar live-avatar'>◆</div>
            <div class='message-copy'>
              <div class='message-meta message-meta-reply'>
                <strong>{agent}</strong>
                <span class='writing-pill'>writing</span>
              </div>
              <div class='message-prose reply-prose streaming-copy'>
                {live.content}
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
        agent={cleanTag(state.meta?.agentName || 'agent')}
        live={state.live}
        mindItems={state.mindItems}
        onOpenMind={(id) => {
          actions.selectMind(id, { view: 'thread', room: state.room });
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
