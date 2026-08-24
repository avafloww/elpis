import { useMemo, useState } from 'preact/hooks';
import { secretaryPendingStatus, type ConsoleActions } from '../use-console.js';
import type { ConsoleState, JsonObject, StreamEntry } from '../types.js';
import { array, number, object, text } from '../types.js';
import { ActivityStrip, ChatComposer } from './chat.js';
import { Empty, relative, statusLabel, statusTone } from './common.js';
import { ThreadStream } from './thread.js';

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

export function secretaryEntries(session: JsonObject | null): StreamEntry[] {
  if (!session) return [];
  const entries: StreamEntry[] = [];
  let id = 0;
  for (const turn of array<JsonObject>(session.turns)) {
    const status = text(turn.status);
    const createdAt = number(turn.createdAt, number(session.createdAt));
    const completedAt = number(turn.completedAt, createdAt);
    for (const message of turnMessages(turn)) {
      if (message.role === 'assistant') {
        entries.push({
          id: id++,
          kind: 'assistant',
          role: 'assistant',
          channel: 'secretary',
          content: message.content,
          ts: completedAt,
        });
      } else if (message.role === 'user') {
        entries.push({
          id: id++,
          kind: 'user',
          role: 'user',
          channel: 'secretary',
          content: message.content,
          eventKind: 'person',
          displayName: 'operator',
          ts: createdAt,
        });
      }
    }
    if (status === 'ambiguous' || status === 'cancelled')
      entries.push({
        id: id++,
        kind: 'notice',
        role: 'system',
        channel: 'secretary',
        content:
          status === 'ambiguous'
            ? 'Secretary stopped before completion; this turn may have partially executed and was not retried.'
            : 'This queued Secretary turn was cancelled before execution.',
        ts: number(turn.updatedAt, createdAt),
      });
  }
  return entries;
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
  const entries = useMemo(() => secretaryEntries(selected), [selected]);
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
          <div class='secretary-thread'>
            <ThreadStream
              entries={entries}
              room='all'
              agent='Secretary'
              mindItems={state.mindItems}
              onOpenMind={(id) => {
                actions.selectMind(id);
                actions.setView('mind');
              }}
            />
            {!entries.length && selected ? (
              <span class='muted-copy'>No turns in this session yet.</span>
            ) : null}
            {!selected ? (
              <span class='muted-copy'>
                Open a new session to begin a bounded Mind conversation.
              </span>
            ) : null}
          </div>
          {pending ? (
            <ActivityStrip
              label={
                pending === 'claimed'
                  ? 'Secretary is thinking'
                  : 'Waiting for Secretary'
              }
              tone={pending === 'claimed' ? 'thinking' : 'waiting'}
            />
          ) : null}
          {active ? (
            <ChatComposer
              contextLabel='secretary'
              disabled={pending !== null}
              placeholder='Ask the secretary…'
              onSend={(content) => {
                actions.control('secretary', 'enqueue', {
                  sessionId: sessionId(selected),
                  content,
                });
              }}
            />
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
