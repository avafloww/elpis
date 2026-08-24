import { useMemo } from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import { mindBackTarget } from '../navigation.js';
import type { ConsoleState, MindItem, MindOrigin } from '../types.js';
import {
  Empty,
  Markdown,
  relative,
  statusLabel,
  statusTone,
} from './common.js';

const GROUPS: Array<{
  key: string;
  title: string;
  match(item: MindItem): boolean;
}> = [
  {
    key: 'proposals',
    title: 'Proposals',
    match: (item) => item.status === 'proposal',
  },
  {
    key: 'active',
    title: 'Active',
    match: (item) => ['in_progress', 'waiting'].includes(item.status),
  },
  { key: 'open', title: 'Open', match: (item) => item.status === 'open' },
  { key: 'inbox', title: 'Inbox', match: (item) => item.status === 'inbox' },
  {
    key: 'reviewed',
    title: 'Reviewed',
    match: (item) =>
      ['done', 'cancelled'].includes(item.status) || item.archivedAt != null,
  },
];

function MindDetail({
  item,
  actions,
  onAsk,
  origin,
}: {
  item: MindItem;
  actions: ConsoleActions;
  onAsk(item: MindItem): void;
  origin: MindOrigin | null;
}) {
  const backTarget = mindBackTarget(origin);
  const back = (): void => {
    actions.selectMind(null);
    if (backTarget.view === 'thread') actions.setRoom(backTarget.room);
    actions.setView(backTarget.view);
  };
  const dependencies = item.dependencies ?? item.blockedBy ?? [];
  return (
    <div class='reference-scroll'>
      <article class='mind-detail reference-column'>
        <button class='reference-back' onClick={back}>
          ←{' '}
          <span>
            {backTarget.view === 'thread' ? 'Thread' : 'All Mind items'}
          </span>
        </button>
        <header class='mind-detail-head'>
          <h1>{item.title}</h1>
          <button
            class='secretary-glyph'
            title='Ask secretary about this'
            onClick={() => onAsk(item)}
          >
            ◈
          </button>
        </header>
        <div class='detail-pills'>
          <span class='kind-pill'>{item.kind}</span>
          <span
            class={`status-pill tone-${statusTone(item.effectiveStatus ?? item.status)}`}
          >
            {statusLabel(item.effectiveStatus ?? item.status)}
          </span>
          <span class='priority-label'>p{item.priority}</span>
        </div>
        <Markdown value={item.body} className='mind-body' />
        {dependencies.length ? (
          <div class='blocked-surface'>
            <span>⟂</span>
            <div>
              {dependencies.map((dep) => (
                <button onClick={() => actions.selectMind(dep.id, origin)}>
                  {dep.title ?? dep.id}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {(item as Record<string, unknown>).createdBy &&
        String((item as Record<string, unknown>).createdBy).startsWith(
          'secretary:',
        ) ? (
          <span class='secretary-origin'>from secretary intake →</span>
        ) : null}
        {(item.comments ?? []).length ? (
          <section class='mind-comments'>
            <div class='section-label'>Comments</div>
            {[...(item.comments ?? [])]
              .sort(
                (a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0),
              )
              .map((entry, index) => (
                <div class='mind-comment' key={index}>
                  <div class='message-avatar agent-avatar'>◆</div>
                  <div>
                    <Markdown value={entry.body} />
                    <small>
                      {String(entry.author ?? 'unknown')} ·{' '}
                      {relative(entry.createdAt)}
                    </small>
                  </div>
                </div>
              ))}
          </section>
        ) : null}
        {item.status === 'proposal' ? (
          <div class='proposal-controls'>
            <button
              onClick={() =>
                actions.mind('update', {
                  id: item.id,
                  patch: { status: 'inbox' },
                })
              }
            >
              accept to inbox
            </button>
            <button
              onClick={() =>
                actions.mind('update', {
                  id: item.id,
                  patch: { status: 'open' },
                })
              }
            >
              accept open
            </button>
            <button
              class='danger-control'
              onClick={() =>
                actions.mind('update', {
                  id: item.id,
                  patch: { status: 'cancelled' },
                })
              }
            >
              decline
            </button>
          </div>
        ) : null}
      </article>
    </div>
  );
}

export function MindView({
  state,
  actions,
  onAskSecretary,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  onAskSecretary(item: MindItem): void;
}) {
  const selected =
    state.mindDetail?.id === state.selectedMindId
      ? state.mindDetail
      : (state.mindItems.find((item) => item.id === state.selectedMindId) ??
        null);
  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: state.mindItems.filter(group.match),
      })).filter((group) => group.items.length),
    [state.mindItems],
  );
  if (selected)
    return (
      <MindDetail
        item={selected}
        actions={actions}
        onAsk={onAskSecretary}
        origin={state.mindOrigin}
      />
    );
  return (
    <div class='reference-scroll'>
      <div class='mind-list-view reference-column'>
        {!state.mindAvailable ? <Empty>Mind is unavailable.</Empty> : null}
        {groups.map((group) => (
          <section class={`mind-group mind-group-${group.key}`}>
            <div class='group-label tone-label'>
              {group.title}
              <span>{group.items.length}</span>
            </div>
            <div class='mind-list'>
              {group.items.map((item) => (
                <button
                  class={`mind-row ${item.status === 'proposal' ? 'proposal-row' : ''}`}
                  onClick={() => actions.selectMind(item.id, null)}
                >
                  <i
                    class={`tone-dot tone-${statusTone(item.effectiveStatus ?? item.status)}`}
                  />
                  <strong>{item.title}</strong>
                  <span class='mind-row-kind'>{item.kind}</span>
                  <span>{relative(item.updatedAt)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
