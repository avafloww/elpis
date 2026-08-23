import { useMemo, useState } from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import type { ConsoleState, JsonObject } from '../types.js';
import { array, object, text } from '../types.js';
import { Empty, Markdown, relative, Status } from './common.js';

function workerRef(session: JsonObject): string {
  return (
    text(session.worker) ||
    text(session.slug) ||
    text(session.id) ||
    text(session.sessionId)
  );
}

export function WorkersView({
  state,
  actions,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
}) {
  const [root, setRoot] = useState(state.selectedMindId ?? '');
  const [steering, setSteering] = useState('');
  const sessions = state.workers.sessions;
  const selected =
    sessions.find(
      (session) => workerRef(session) === state.selectedWorkerRef,
    ) ?? null;
  const detail =
    (state as ConsoleState & { workerDetail?: JsonObject }).workerDetail ??
    selected;
  const groups = useMemo(
    () => ({
      active: sessions.filter((session) =>
        ['spawning', 'running', 'idle'].includes(text(session.status)),
      ),
      inactive: sessions.filter(
        (session) =>
          !['spawning', 'running', 'idle'].includes(text(session.status)),
      ),
    }),
    [sessions],
  );
  if (selected && detail) {
    const ref = workerRef(detail);
    const messages = array<JsonObject>(detail.messages);
    const artifacts = array<JsonObject>(
      detail.artifacts ?? detail.artifactReceipts,
    );
    return (
      <div class='view-scroll'>
        <div class='view-column workers-column'>
          <button class='back-link' onClick={() => actions.selectWorker(null)}>
            ← All workers
          </button>
          <header class='detail-heading'>
            <div>
              <h1 class='mono'>{ref}</h1>
              <div class='pills'>
                <Status value={detail.status} />
                <span>{relative(detail.startedAt ?? detail.createdAt)}</span>
              </div>
            </div>
            {['spawning', 'running', 'idle'].includes(text(detail.status)) ? (
              <button
                class='danger'
                onClick={() =>
                  confirm(`Dismiss ${ref}?`) &&
                  actions.control('worker', 'dismiss', { ref })
                }
              >
                Dismiss
              </button>
            ) : null}
          </header>
          <div class='source-chip'>
            mandate from{' '}
            <button
              onClick={() => {
                const id = text(detail.mindId);
                if (id) {
                  actions.selectMind(id);
                  actions.setView('mind');
                }
              }}
            >
              {text(detail.mindId, 'unknown')}
            </button>
          </div>
          <section class='detail-section'>
            <div class='eyebrow'>MANDATE</div>
            <Markdown
              value={
                detail.prompt ??
                detail.mandate ??
                'Mandate text is not exposed in this receipt.'
              }
              className='prose'
            />
          </section>
          <section class='detail-section'>
            <div class='eyebrow'>THREAD / MAILBOX</div>
            {messages.length ? (
              messages.map((message, index) => (
                <div class='mail-row' key={index}>
                  <Status value={message.status} />
                  <Markdown
                    value={
                      message.body ?? message.content ?? JSON.stringify(message)
                    }
                  />
                  <small>{relative(message.createdAt)}</small>
                </div>
              ))
            ) : (
              <Empty>No bounded worker messages are exposed.</Empty>
            )}
          </section>
          {['spawning', 'running', 'idle'].includes(text(detail.status)) ? (
            <form
              class='steering-form'
              onSubmit={(event) => {
                event.preventDefault();
                if (steering.trim()) {
                  actions.control('worker', 'send', { ref, content: steering });
                  setSteering('');
                }
              }}
            >
              <input
                value={steering}
                onInput={(event) => setSteering(event.currentTarget.value)}
                placeholder='Steer this episode…'
              />
              <button disabled={!steering.trim()}>send</button>
            </form>
          ) : null}
          <section class='detail-section'>
            <div class='eyebrow'>ARTIFACTS</div>
            {artifacts.length ? (
              artifacts.map((artifact, index) => (
                <div class='artifact-row' key={index}>
                  <code>
                    {text(artifact.name, text(artifact.key, 'artifact'))}
                  </code>
                  <span>{text(artifact.type, 'receipt')}</span>
                  <small>
                    {text(artifact.sha256).slice(0, 12)} ·{' '}
                    {text(artifact.bytes)}
                  </small>
                </div>
              ))
            ) : (
              <Empty>No artifact returned by this episode.</Empty>
            )}
          </section>
        </div>
      </div>
    );
  }
  const renderGroup = (title: string, sessions: JsonObject[]) =>
    sessions.length ? (
      <section class='worker-group'>
        <div class='group-label'>
          {title}
          <span>{sessions.length}</span>
        </div>
        {sessions.map((session) => {
          const ref = workerRef(session);
          return (
            <button
              class='worker-row'
              onClick={() => actions.selectWorker(ref)}
            >
              <span class={`status-dot dot-${text(session.status)}`} />
              <code>{ref}</code>
              <span class='worker-mandate'>
                {text(
                  session.title,
                  text(
                    session.mindTitle,
                    text(session.mindId, 'bounded episode'),
                  ),
                )}
              </span>
              <span>{numberText(session.turns)} turns</span>
              <Status value={session.status} />
              <small>{relative(session.startedAt ?? session.createdAt)}</small>
            </button>
          );
        })}
      </section>
    ) : null;
  return (
    <div class='view-scroll'>
      <div class='view-column workers-column'>
        <div class='view-heading'>
          <div>
            <div class='eyebrow'>EPHEMERAL EXECUTION</div>
            <h1>Workers</h1>
          </div>
          <form
            class='inline-start'
            onSubmit={(event) => {
              event.preventDefault();
              if (root.trim())
                actions.control('worker', 'start', { mindId: root.trim() });
            }}
          >
            <input
              value={root}
              onInput={(event) => setRoot(event.currentTarget.value)}
              placeholder='elm-* mandate'
            />
            <button disabled={!root.trim() || !state.workers.available}>
              start
            </button>
          </form>
        </div>
        {!state.workers.available ? (
          <Empty>
            {state.workers.error || 'Worker control is unavailable.'}
          </Empty>
        ) : (
          <>
            {renderGroup('Active', groups.active)}
            {renderGroup('Inactive', groups.inactive)}
          </>
        )}
      </div>
    </div>
  );
}

function numberText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '0';
}
