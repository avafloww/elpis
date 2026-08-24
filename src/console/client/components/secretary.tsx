import { useMemo, useState } from 'preact/hooks';
import { secretaryPendingStatus, type ConsoleActions } from '../use-console.js';
import type { ConsoleState, JsonObject } from '../types.js';
import { array, object, text } from '../types.js';
import {
  Empty,
  Markdown,
  relative,
  statusLabel,
  statusTone,
} from './common.js';

function sessionId(session: JsonObject): string {
  return text(session.id) || text(session.sessionId);
}

function sessionHint(session: JsonObject): string | null {
  return text(session.hintMindId) || text(session.rootMindId) || null;
}

export function turnMessages(
  turn: JsonObject,
): Array<{ role: string; content: string; status?: string }> {
  const status = text(turn.status);
  const request = object(turn.request);
  const response = object(turn.response);
  const rows: Array<{ role: string; content: string; status?: string }> = [];
  if (typeof request.content === 'string')
    rows.push({
      role: text(request.role, 'user'),
      content: request.content,
      status,
    });
  const records = array<JsonObject>(response.records);
  if (records.length) {
    for (const record of records) {
      if (typeof record.content === 'string')
        rows.push({
          role: text(record.role, 'assistant'),
          content: record.content,
          status,
        });
    }
  } else if (typeof response.content === 'string') {
    rows.push({
      role: text(response.role, 'assistant'),
      content: response.content,
      status,
    });
  }
  if (!rows.length)
    rows.push({
      role: 'system',
      content: JSON.stringify(turn, null, 2),
      status,
    });
  return rows;
}

function titleFor(
  session: JsonObject | null,
  state: ConsoleState,
  hintMindId: string | null,
): string {
  const hint = session ? sessionHint(session) : hintMindId;
  const item = hint
    ? state.mindItems.find((candidate) => candidate.id === hint)
    : null;
  return (
    item?.title || text(session?.title, hint ? 'Mind intake' : 'General intake')
  );
}

export function SecretaryView({
  state,
  actions,
  hintMindId,
  onClearHint,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  hintMindId: string | null;
  onClearHint(): void;
}) {
  const [draft, setDraft] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const sessions = state.secretary.sessions;
  const selected =
    sessions.find(
      (session) => sessionId(session) === state.selectedSecretaryId,
    ) ??
    sessions[0] ??
    null;
  const active =
    selected && ['starting', 'ready'].includes(text(selected.status));
  const messages = useMemo(
    () =>
      selected ? array<JsonObject>(selected.turns).flatMap(turnMessages) : [],
    [selected],
  );
  const title = titleFor(selected, state, hintMindId);
  const pending = selected ? secretaryPendingStatus(selected) : null;
  const start = (): void =>
    actions.control('secretary', 'start', hintMindId ? { hintMindId } : {});
  return (
    <div class='secretary-layout'>
      <div class='secretary-main reference-scroll'>
        <div class='secretary-conversation'>
          {!state.secretary.available ? (
            <Empty>
              {state.secretary.error ||
                'Secretary is unavailable — the isolated runtime or configured model cannot be reached right now.'}
            </Empty>
          ) : null}
          <header class='secretary-head'>
            <button
              class='mobile-session-toggle'
              onClick={() => setSessionsOpen(true)}
            >
              ☰
            </button>
            <h1>{title}</h1>
            {selected ? (
              <span class={`status-word tone-${statusTone(selected.status)}`}>
                {statusLabel(selected.status)}
              </span>
            ) : null}
            <span class='surface-spacer' />
            {active ? (
              <button
                class='dismiss-control'
                onClick={() =>
                  actions.control('secretary', 'close', {
                    sessionId: sessionId(selected),
                  })
                }
              >
                close
              </button>
            ) : (
              <button
                class='new-session-control'
                disabled={!state.secretary.available}
                onClick={start}
              >
                ＋ New session
              </button>
            )}
          </header>
          {hintMindId ? (
            <button class='source-context' onClick={onClearHint}>
              opened from:{' '}
              {state.mindItems.find((item) => item.id === hintMindId)?.title ||
                hintMindId}{' '}
              ×
            </button>
          ) : null}
          {selected && sessionHint(selected) ? (
            <button
              class='related-mind-link'
              onClick={() => {
                const id = sessionHint(selected);
                if (!id) return;
                actions.selectMind(id);
                actions.setView('mind');
              }}
            >
              <span>Related in Mind</span>
              <strong>
                {state.mindItems.find(
                  (item) => item.id === sessionHint(selected),
                )?.title || sessionHint(selected)}
              </strong>
              <i>→</i>
            </button>
          ) : null}
          <div class='secretary-turns'>
            {messages.map((message, index) => (
              <div
                class={`secretary-turn secretary-turn-${message.role}`}
                key={index}
              >
                <div>
                  <span>
                    {message.role === 'assistant' ? 'secretary' : message.role}
                  </span>
                  <small class={`tone-${statusTone(message.status)}`}>
                    {statusLabel(message.status)}
                  </small>
                </div>
                <Markdown value={message.content} />
              </div>
            ))}
            {pending ? (
              <div
                class={`secretary-activity secretary-activity-${pending}`}
                role='status'
                aria-live='polite'
              >
                <span class='secretary-activity-dots' aria-hidden='true'>
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  {pending === 'claimed'
                    ? 'Secretary is thinking'
                    : 'Waiting for Secretary'}
                </span>
              </div>
            ) : null}
            {!messages.length && selected ? (
              <span class='muted-copy'>No turns in this session yet.</span>
            ) : null}
            {!selected ? (
              <span class='muted-copy'>
                Open a new session to begin a bounded Mind conversation.
              </span>
            ) : null}
          </div>
          {active ? (
            <form
              class='secretary-composer'
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.trim()) return;
                actions.control('secretary', 'enqueue', {
                  sessionId: sessionId(selected),
                  content: draft.trim(),
                });
                setDraft('');
              }}
            >
              <input
                value={draft}
                onInput={(event) => setDraft(event.currentTarget.value)}
                placeholder='Ask the secretary…'
              />
              <button disabled={!draft.trim()}>Ask</button>
            </form>
          ) : null}
        </div>
      </div>
      <aside class={`session-rail ${sessionsOpen ? 'session-rail-open' : ''}`}>
        <div class='session-rail-head'>
          <span>Past sessions</span>
          <button
            class='session-rail-close'
            onClick={() => setSessionsOpen(false)}
          >
            ×
          </button>
        </div>
        <button
          class='session-new'
          onClick={start}
          disabled={!state.secretary.available}
        >
          ＋ New session
        </button>
        <div class='session-list'>
          {sessions.map((session) => {
            const id = sessionId(session);
            return (
              <button
                class={id === sessionId(selected ?? {}) ? 'selected' : ''}
                onClick={() => {
                  actions.selectSecretary(id);
                  setSessionsOpen(false);
                }}
              >
                <strong>{titleFor(session, state, null)}</strong>
                <span>
                  {relative(
                    session.updatedAt ?? session.createdAt ?? session.startedAt,
                  )}
                </span>
                <small class={`tone-${statusTone(session.status)}`}>
                  {statusLabel(session.status)}
                </small>
              </button>
            );
          })}
        </div>
      </aside>
      {sessionsOpen ? (
        <button class='session-scrim' onClick={() => setSessionsOpen(false)} />
      ) : null}
    </div>
  );
}
