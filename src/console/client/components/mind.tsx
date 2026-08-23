import { useMemo, useState } from 'preact/hooks';
import type { ConsoleActions } from '../use-console.js';
import type { ConsoleState, MindItem } from '../types.js';
import { copy, Empty, Markdown, relative, Status } from './common.js';

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

function MindForm({
  item,
  actions,
  onClose,
}: {
  item?: MindItem;
  actions: ConsoleActions;
  onClose(): void;
}) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [kind, setKind] = useState(item?.kind ?? 'task');
  const [status, setStatus] = useState(item?.status ?? 'inbox');
  const [priority, setPriority] = useState(item?.priority ?? 2);
  const [tags, setTags] = useState((item?.tags ?? []).join(', '));
  const submit = (event: Event): void => {
    event.preventDefault();
    const payload = {
      title: title.trim(),
      body,
      kind,
      status,
      priority,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      parentId: item?.parentId ?? null,
    };
    if (!payload.title) return;
    actions.mind(
      item ? 'update' : 'create',
      item ? { id: item.id, patch: payload } : { item: payload },
    );
    onClose();
  };
  return (
    <form class='mind-form' onSubmit={submit}>
      <label>
        title
        <input
          value={title}
          onInput={(event) => setTitle(event.currentTarget.value)}
          maxLength={240}
          required
        />
      </label>
      <label class='wide'>
        details
        <textarea
          value={body}
          onInput={(event) => setBody(event.currentTarget.value)}
          rows={8}
        />
      </label>
      <label>
        kind
        <select
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value)}
        >
          {['task', 'project', 'idea', 'question', 'reminder'].map((value) => (
            <option value={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        status
        <select
          value={status}
          onChange={(event) => setStatus(event.currentTarget.value)}
        >
          {[
            'proposal',
            'inbox',
            'open',
            'in_progress',
            'waiting',
            'done',
            'cancelled',
          ].map((value) => (
            <option value={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        priority
        <select
          value={priority}
          onChange={(event) => setPriority(Number(event.currentTarget.value))}
        >
          {[0, 1, 2, 3, 4].map((value) => (
            <option value={value}>p{value}</option>
          ))}
        </select>
      </label>
      <label>
        tags
        <input
          value={tags}
          onInput={(event) => setTags(event.currentTarget.value)}
        />
      </label>
      <div class='form-actions wide'>
        <button class='primary' type='submit'>
          {item ? 'save changes' : 'create item'}
        </button>
        <button type='button' onClick={onClose}>
          cancel
        </button>
      </div>
    </form>
  );
}

function MindDetail({
  item,
  actions,
  onAsk,
  onBack,
}: {
  item: MindItem;
  actions: ConsoleActions;
  onAsk(item: MindItem): void;
  onBack(): void;
}) {
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState('');
  if (editing)
    return (
      <div class='mind-detail'>
        <button class='back-link' onClick={onBack}>
          ← All Mind items
        </button>
        <MindForm
          item={item}
          actions={actions}
          onClose={() => setEditing(false)}
        />
      </div>
    );
  const dependencies = item.dependencies ?? item.blockedBy ?? [];
  return (
    <div class='mind-detail'>
      <button class='back-link' onClick={onBack}>
        ← All Mind items
      </button>
      <header class='detail-heading'>
        <div>
          <h1>{item.title}</h1>
          <div class='pills'>
            <span>{item.kind}</span>
            <Status value={item.effectiveStatus ?? item.status} />
            <span>p{item.priority}</span>
          </div>
        </div>
        <div class='heading-actions'>
          <button
            title='Copy raw item Markdown'
            onClick={() => void copy(item.body)}
          >
            ⧉ copy
          </button>
          <button
            class='secretary-launch'
            title='Ask secretary about this'
            onClick={() => onAsk(item)}
          >
            ◈
          </button>
        </div>
      </header>
      <Markdown value={item.body} className='prose detail-body' />
      {dependencies.length ? (
        <section class='detail-section'>
          <div class='eyebrow'>BLOCKED BY / DEPENDENCIES</div>
          {dependencies.map((dep) => (
            <button
              class='relation-row'
              onClick={() => actions.selectMind(dep.id)}
            >
              #{dep.id} · {dep.title ?? 'Mind item'}
            </button>
          ))}
        </section>
      ) : null}
      <section class='detail-section'>
        <div class='section-head'>
          <div class='eyebrow'>COMMENTS</div>
          <button onClick={() => setEditing(true)}>edit item</button>
        </div>
        {(item.comments ?? []).length ? (
          [...(item.comments ?? [])]
            .sort(
              (a, b) =>
                Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0) ||
                Number(b.id ?? 0) - Number(a.id ?? 0),
            )
            .map((entry, index) => {
              const comment = entry as Record<string, unknown>;
              return (
                <div class='comment' key={index}>
                  <div class='comment-avatar'>◆</div>
                  <div>
                    <Markdown value={comment.body} />
                    <small>
                      {String(comment.author ?? 'unknown')} ·{' '}
                      {relative(comment.createdAt)} ·{' '}
                      <button
                        onClick={() => void copy(String(comment.body ?? ''))}
                      >
                        copy raw
                      </button>
                    </small>
                  </div>
                </div>
              );
            })
        ) : (
          <Empty>No comments yet.</Empty>
        )}
        <form
          class='comment-form'
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim()) {
              actions.mind('comment', { id: item.id, body: comment });
              setComment('');
            }
          }}
        >
          <textarea
            value={comment}
            onInput={(event) => setComment(event.currentTarget.value)}
            placeholder='Add a durable comment…'
            rows={2}
          />
          <button disabled={!comment.trim()}>add</button>
        </form>
      </section>
      {item.status === 'proposal' ? (
        <div class='proposal-actions'>
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
              actions.mind('update', { id: item.id, patch: { status: 'open' } })
            }
          >
            accept open
          </button>
          <button
            class='danger'
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
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const selected =
    state.mindDetail?.id === state.selectedMindId
      ? state.mindDetail
      : (state.mindItems.find((item) => item.id === state.selectedMindId) ??
        null);
  const items = useMemo(
    () =>
      state.mindItems.filter(
        (item) =>
          !search ||
          `${item.title} ${item.body} ${(item.tags ?? []).join(' ')}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [state.mindItems, search],
  );
  if (creating)
    return (
      <div class='view-scroll'>
        <div class='view-column'>
          <button class='back-link' onClick={() => setCreating(false)}>
            ← All Mind items
          </button>
          <MindForm actions={actions} onClose={() => setCreating(false)} />
        </div>
      </div>
    );
  if (selected)
    return (
      <div class='view-scroll'>
        <div class='view-column'>
          <MindDetail
            item={selected}
            actions={actions}
            onAsk={onAskSecretary}
            onBack={() => actions.selectMind(null)}
          />
        </div>
      </div>
    );
  return (
    <div class='view-scroll'>
      <div class='view-column mind-column'>
        <div class='view-heading'>
          <div>
            <div class='eyebrow'>DURABLE WORK GRAPH</div>
            <h1>Mind</h1>
          </div>
          <div class='heading-actions'>
            <input
              class='search'
              value={search}
              onInput={(event) => setSearch(event.currentTarget.value)}
              placeholder='search Mind…'
            />
            <button onClick={() => actions.requestMind()}>↻</button>
            <button class='primary' onClick={() => setCreating(true)}>
              ＋ new
            </button>
          </div>
        </div>
        {!state.mindAvailable ? (
          <Empty>Mind is unavailable.</Empty>
        ) : (
          GROUPS.map((group) => {
            const grouped = items.filter(group.match);
            if (!grouped.length) return null;
            return (
              <section class={`mind-group mind-group-${group.key}`}>
                <div class='group-label'>
                  {group.title}
                  <span>{grouped.length}</span>
                </div>
                <div class='mind-list'>
                  {grouped.map((item) => (
                    <button
                      class={`mind-row ${item.status === 'proposal' ? 'proposal' : ''}`}
                      onClick={() => actions.selectMind(item.id)}
                    >
                      <span
                        class={`status-dot dot-${item.effectiveStatus ?? item.status}`}
                      />
                      <span class='mind-row-title'>{item.title}</span>
                      <span class='mind-row-meta'>
                        {item.kind} · {relative(item.updatedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
