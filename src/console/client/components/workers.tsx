import { useMemo, useState } from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import type { ConsoleState, JsonObject, StreamEntry } from '../types.js';
import { array, text } from '../types.js';
import {
  Empty,
  Markdown,
  relative,
  statusLabel,
  statusTone,
} from './common.js';
import { ThreadStream } from './thread.js';

function workerRef(session: JsonObject): string {
  return (
    text(session.worker) ||
    text(session.slug) ||
    text(session.id) ||
    text(session.sessionId)
  );
}

function workerTitle(session: JsonObject, state: ConsoleState): string {
  const mindId = text(session.mindId);
  return text(
    session.title,
    text(
      session.mindTitle,
      state.mindItems.find((item) => item.id === mindId)?.title ||
        text(session.mindId, 'bounded episode'),
    ),
  );
}

export function workerEntries(
  messages: JsonObject[],
  worker: string,
): StreamEntry[] {
  return messages.map((message, index) => {
    const sender = text(message.sender, text(message.actor));
    const direction = text(message.direction);
    const workerAuthored =
      direction === 'worker_to_dispatcher' ||
      sender === 'worker' ||
      sender.startsWith('worker:');
    return {
      id: Number(message.id ?? index),
      kind: text(message.kind, 'message'),
      role: text(message.role, workerAuthored ? 'assistant' : 'user'),
      channel: 'worker',
      content: text(
        message.body,
        text(message.content, JSON.stringify(message)),
      ),
      author: workerAuthored
        ? sender === 'worker'
          ? worker
          : sender || worker
        : sender,
      ts: Number(message.createdAt ?? message.ts ?? 0),
    };
  });
}

function WorkerDetail({
  state,
  actions,
  detail,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  detail: JsonObject;
}) {
  const [steering, setSteering] = useState('');
  const ref = workerRef(detail);
  const active = ['spawning', 'running', 'idle'].includes(text(detail.status));
  const messages = array<JsonObject>(detail.messages);
  const artifacts = array<JsonObject>(
    detail.artifacts ?? detail.artifactReceipts,
  );
  const mindId = text(detail.mindId);
  return (
    <div class='reference-scroll'>
      <article class='worker-detail reference-column'>
        <button
          class='reference-back'
          onClick={() => actions.selectWorker(null)}
        >
          ← <span>All workers</span>
        </button>
        <header class='worker-detail-head'>
          <code>{ref}</code>
          <i class={`tone-dot tone-${statusTone(detail.status)}`} />
          <span class={`status-word tone-${statusTone(detail.status)}`}>
            {statusLabel(detail.status)}
          </span>
          <small>
            started{' '}
            {relative(detail.startedAt ?? detail.createdAt).replace(' ago', '')}{' '}
            ago
          </small>
          <span class='surface-spacer' />
          {active ? (
            <button
              class='dismiss-control'
              onClick={() =>
                confirm(`Dismiss ${ref}?`) &&
                actions.control('worker', 'dismiss', { ref })
              }
            >
              Dismiss
            </button>
          ) : null}
        </header>
        <button
          class='mandate-link'
          onClick={() => {
            if (!mindId) return;
            actions.selectMind(mindId);
            actions.setView('mind');
          }}
        >
          <span>mandate from</span>
          <strong>{workerTitle(detail, state)}</strong>
          <i>→</i>
        </button>
        <section class='worker-section'>
          <div class='section-label'>Mandate</div>
          <Markdown
            value={
              detail.prompt ??
              detail.mandate ??
              'Mandate text is not exposed in this receipt.'
            }
            className='mandate-body'
          />
        </section>
        <section class='worker-section'>
          <div class='section-label'>Thread</div>
          <ThreadStream
            entries={workerEntries(messages, ref || 'worker')}
            room='all'
            agent={ref || 'worker'}
            mindItems={state.mindItems}
            onOpenMind={(id) => {
              actions.selectMind(id);
              actions.setView('mind');
            }}
          />
        </section>
        {active ? (
          <form
            class='steering-box'
            onSubmit={(event) => {
              event.preventDefault();
              if (!steering.trim()) return;
              actions.control('worker', 'send', {
                ref,
                content: steering.trim(),
              });
              setSteering('');
            }}
          >
            <div class='section-label'>Steering mailbox</div>
            <div>
              <input
                value={steering}
                onInput={(event) => setSteering(event.currentTarget.value)}
                placeholder='Send bounded steering…'
              />
              <button disabled={!steering.trim()}>Send</button>
            </div>
          </form>
        ) : null}
        <section class='worker-section'>
          <div class='section-label'>Artifacts</div>
          {artifacts.length ? (
            artifacts.map((artifact, index) => (
              <div class='artifact-card' key={index}>
                <div>
                  <code>
                    {text(artifact.name, text(artifact.key, 'artifact'))}
                  </code>
                  <span>{text(artifact.type, 'receipt')}</span>
                </div>
                <small>
                  rev {text(artifact.revision, text(artifact.rev, '—'))} ·{' '}
                  {text(artifact.bytes, text(artifact.size, '—'))} ·{' '}
                  {text(artifact.sha256).slice(0, 16)}
                </small>
              </div>
            ))
          ) : (
            <span class='muted-copy'>No artifact returned.</span>
          )}
        </section>
      </article>
    </div>
  );
}

export function WorkersView({
  state,
  actions,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
}) {
  const selected =
    state.workers.sessions.find(
      (session) => workerRef(session) === state.selectedWorkerRef,
    ) ?? null;
  const detail = state.workerDetail ?? selected;
  const groups = useMemo(
    () =>
      [
        {
          label: 'Active',
          items: state.workers.sessions.filter((session) =>
            ['spawning', 'running', 'idle'].includes(text(session.status)),
          ),
        },
        {
          label: 'Inactive',
          items: state.workers.sessions.filter(
            (session) =>
              !['spawning', 'running', 'idle'].includes(text(session.status)),
          ),
        },
      ].filter((group) => group.items.length),
    [state.workers.sessions],
  );
  if (selected && detail)
    return <WorkerDetail state={state} actions={actions} detail={detail} />;
  return (
    <div class='reference-scroll'>
      <div class='workers-list-view reference-column'>
        {!state.workers.available ? (
          <Empty>
            {state.workers.error || 'Worker control is unavailable.'}
          </Empty>
        ) : null}
        {groups.map((group) => (
          <section class='worker-group'>
            <div class='group-label'>
              {group.label}
              <span>{group.items.length}</span>
            </div>
            {group.items.map((session) => {
              const ref = workerRef(session);
              return (
                <button
                  class='worker-row'
                  onClick={() => actions.selectWorker(ref)}
                >
                  <i class={`tone-dot tone-${statusTone(session.status)}`} />
                  <code>{ref}</code>
                  <strong>{workerTitle(session, state)}</strong>
                  <span>{Number(session.turns ?? 0)} turns</span>
                  <span
                    class={`status-word tone-${statusTone(session.status)}`}
                  >
                    {statusLabel(session.status)}
                  </span>
                  <small>
                    {relative(session.startedAt ?? session.createdAt)}
                  </small>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
