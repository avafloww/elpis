import { useMemo, useState } from 'preact/hooks';
import type { ConsoleActions } from '../use-console';
import type { ConsoleState, JsonObject } from '../types';
import { array, object, text } from '../types';
import { Empty, Markdown, relative, Status } from './common';

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
      if (typeof record.content === 'string') {
        rows.push({
          role: text(record.role, 'assistant'),
          content: record.content,
          status,
        });
      }
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
  const start = (): void => {
    actions.control('secretary', 'start', hintMindId ? { hintMindId } : {});
  };
  return (
    <div class='secretary-layout'>
      <div class='secretary-main'>
        <div class='secretary-header'>
          <div>
            <div class='eyebrow'>GLOBAL MIND INTAKE</div>
            <h1>
              {selected
                ? `Secretary · ${sessionId(selected).slice(-6)}`
                : 'Secretary'}
            </h1>
            <div class='pills'>
              {selected ? <Status value={selected.status} /> : null}
              {hintMindId ? (
                <button class='source-chip' onClick={onClearHint}>
                  prompt hint: {hintMindId} ×
                </button>
              ) : null}
              {selected && sessionHint(selected) ? (
                <span class='source-chip'>
                  opened from: {sessionHint(selected)}
                </span>
              ) : null}
            </div>
          </div>
          <div class='heading-actions'>
            {active ? (
              <button
                class='danger'
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
                class='primary'
                disabled={!state.secretary.available}
                onClick={start}
              >
                ＋ New session
              </button>
            )}
          </div>
        </div>
        {!state.secretary.available ? (
          <Empty>
            {state.secretary.error ||
              'Secretary is unavailable — the isolated runtime or configured model cannot be reached.'}
          </Empty>
        ) : !selected ? (
          <Empty>
            Start an ephemeral secretary chat. Its durable turn history remains
            here after the runtime closes.
          </Empty>
        ) : (
          <div class='secretary-thread'>
            {messages.map((message, index) => (
              <article
                class={`secretary-bubble secretary-${message.role}`}
                key={index}
              >
                <div>
                  <strong>{message.role}</strong>
                  {message.status ? <Status value={message.status} /> : null}
                </div>
                <Markdown value={message.content} className='prose' />
              </article>
            ))}
          </div>
        )}
        <form
          class='composer secretary-composer'
          onSubmit={(event) => {
            event.preventDefault();
            if (selected && active && draft.trim()) {
              actions.control('secretary', 'enqueue', {
                sessionId: sessionId(selected),
                content: draft,
              });
              setDraft('');
            }
          }}
        >
          <textarea
            value={draft}
            onInput={(event) => setDraft(event.currentTarget.value)}
            disabled={!selected || !active || state.connection !== 'connected'}
            placeholder='Give the secretary a rough thought…'
            rows={2}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <span>secretary</span>
          <button disabled={!draft.trim() || !selected || !active}>↑</button>
        </form>
      </div>
      <aside class='session-rail'>
        <div class='group-label'>
          PAST SESSIONS<span>{sessions.length}</span>
        </div>
        <button
          class='new-session'
          disabled={
            !state.secretary.available ||
            sessions.some((session) =>
              ['starting', 'ready'].includes(text(session.status)),
            )
          }
          onClick={start}
        >
          ＋ New session
        </button>
        {sessions.map((session) => (
          <button
            class={`session-row ${sessionId(session) === state.selectedSecretaryId ? 'active' : ''}`}
            onClick={() => actions.selectSecretary(sessionId(session))}
          >
            <span class={`status-dot dot-${text(session.status)}`} />
            <span>
              <strong>
                {sessionHint(session)
                  ? `From ${sessionHint(session)}`
                  : `Session ${sessionId(session).slice(-6)}`}
              </strong>
              <small>
                {array(session.turns).length} turns ·{' '}
                {relative(session.updatedAt ?? session.createdAt)}
              </small>
            </span>
            <Status value={session.status} />
          </button>
        ))}
      </aside>
    </div>
  );
}
