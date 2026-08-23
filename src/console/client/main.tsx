import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { ContextView } from './components/context.js';
import { MindView } from './components/mind.js';
import { SecretaryView } from './components/secretary.js';
import { ThreadView } from './components/thread.js';
import { WorkersView } from './components/workers.js';
import { clock } from './components/common.js';
import type { JsonObject, MindItem, ViewName } from './types.js';
import { number, text } from './types.js';
import { useConsole } from './use-console.js';
import './styles.css';

const NAV: Array<{ view: ViewName; glyph: string; label: string }> = [
  { view: 'thread', glyph: '◆', label: 'Thread' },
  { view: 'context', glyph: '◫', label: 'Context' },
  { view: 'mind', glyph: '✦', label: 'Mind' },
  { view: 'workers', glyph: '⬡', label: 'Workers' },
  { view: 'secretary', glyph: '◈', label: 'Secretary' },
];

function ContextMeter({ usage }: { usage: JsonObject | null }) {
  const current = number(usage?.current);
  const windowSize = number(usage?.window, 1);
  const trigger = number(usage?.trigger, windowSize);
  const ratio = Math.max(0, Math.min(100, (current / windowSize) * 100));
  const triggerRatio = Math.max(0, Math.min(100, (trigger / windowSize) * 100));
  return (
    <div class='context-meter'>
      <div class='meter-head'>
        <span>CONTEXT WINDOW</span>
        <strong>
          {Math.round(current / 1000)}k / {Math.round(windowSize / 1000)}k
        </strong>
        <span>{Math.round(ratio)}%</span>
      </div>
      <div class='meter-track'>
        <span style={{ width: `${ratio}%` }} />
        <i style={{ left: `${triggerRatio}%` }} />
      </div>
      <div class='meter-caption'>
        <span>compaction at {Math.round(triggerRatio)}%</span>
      </div>
    </div>
  );
}

function Rooms({
  rooms,
  active,
  onSelect,
}: {
  rooms: Array<{ id: string; name: string; count: number; color?: string }>;
  active: string;
  onSelect(id: string): void;
}) {
  const total = rooms.reduce((sum, room) => sum + room.count, 0);
  return (
    <div class='rooms'>
      <div class='group-label'>ROOMS</div>
      <button
        class={active === 'all' ? 'room-row active' : 'room-row'}
        onClick={() => onSelect('all')}
      >
        <span class='room-dot room-all' />
        <span>All rooms</span>
        <small>{total}</small>
      </button>
      {rooms.map((room) => (
        <button
          class={active === room.id ? 'room-row active' : 'room-row'}
          onClick={() => onSelect(room.id)}
        >
          <span
            class='room-dot'
            style={{ background: `var(--${room.color || 'muted'})` }}
          />
          <span>{room.name}</span>
          <small>{room.count}</small>
        </button>
      ))}
    </div>
  );
}

function LiveWorkers({
  sessions,
  onOpen,
}: {
  sessions: JsonObject[];
  onOpen(ref: string): void;
}) {
  const active = sessions
    .filter((session) =>
      ['spawning', 'running', 'idle'].includes(text(session.status)),
    )
    .slice(0, 3);
  return (
    <div class='rail-workers'>
      <div class='group-label'>
        WORKERS · LIVE<span>{active.length} running</span>
      </div>
      {active.map((session) => {
        const ref = text(session.worker, text(session.slug, text(session.id)));
        return (
          <button onClick={() => onOpen(ref)}>
            <code>{ref}</code>
            <span>
              {text(session.mindTitle, text(session.mindId, 'bounded episode'))}
            </span>
            <small>{text(session.status)}</small>
          </button>
        );
      })}
      {!active.length ? <div class='rail-empty'>no active episodes</div> : null}
    </div>
  );
}

function Sidebar({
  state,
  actions,
  proposals,
  onClose,
}: {
  state: ReturnType<typeof useConsole>[0];
  actions: ReturnType<typeof useConsole>[1];
  proposals: number;
  onClose?(): void;
}) {
  const selectRoom = (id: string): void => {
    actions.setRoom(id);
    actions.setView('thread');
    onClose?.();
  };
  return (
    <aside class='sidebar'>
      <div class='brand-block'>
        <img src='./elpis-logo-dark.svg' alt='Elpis' />
        <div class='brand-meta'>
          <a
            href={`https://github.com/avafloww/elpis/commit/${state.meta?.gitHash || ''}`}
            target='_blank'
            rel='noreferrer'
          >
            {state.meta?.gitHash?.slice(0, 7) || 'local'}
          </a>
          <span>
            <i class={`connection-dot connection-${state.connection}`} />
            {state.connection === 'connected'
              ? `up ${Math.floor(number(state.meta?.uptimeMs) / 3_600_000)}h`
              : state.connection}
          </span>
        </div>
      </div>
      <nav>
        {NAV.map((item) => (
          <button
            class={state.view === item.view ? 'active' : ''}
            onClick={() => {
              actions.setView(item.view);
              onClose?.();
            }}
          >
            <span>{item.glyph}</span>
            {item.label}
            {item.view === 'mind' && proposals ? (
              <small>{proposals}</small>
            ) : null}
          </button>
        ))}
      </nav>
      <Rooms rooms={state.rooms} active={state.room} onSelect={selectRoom} />
      <LiveWorkers
        sessions={state.workers.sessions}
        onOpen={(ref) => {
          actions.selectWorker(ref);
          actions.setView('workers');
          onClose?.();
        }}
      />
      <div class='sidebar-spacer' />
      <ContextMeter usage={state.usage as JsonObject | null} />
    </aside>
  );
}

function StatusBar({ state }: { state: ReturnType<typeof useConsole>[0] }) {
  const activeWorkers = state.workers.sessions.filter((session) =>
    ['spawning', 'running', 'idle'].includes(text(session.status)),
  ).length;
  const activity = state.live
    ? 'writing · live turn'
    : activeWorkers
      ? `${activeWorkers} worker${activeWorkers === 1 ? '' : 's'} running`
      : 'idle';
  return (
    <div class='status-bar'>
      <span class={state.live ? 'activity active' : 'activity'}>
        <i />
        {activity}
      </span>
      {!['workers', 'secretary'].includes(state.view) ? (
        <>
          <b />
          <span>
            {state.room === 'all'
              ? 'all rooms'
              : state.rooms.find((room) => room.id === state.room)?.name ||
                state.room}
          </span>
        </>
      ) : null}
    </div>
  );
}

function ThreadComposer({
  connected,
  send,
}: {
  connected: boolean;
  send(value: string): boolean;
}) {
  const [draft, setDraft] = useState('');
  return (
    <form
      class='composer thread-composer'
      onSubmit={(event) => {
        event.preventDefault();
        if (send(draft)) setDraft('');
      }}
    >
      <textarea
        value={draft}
        disabled={!connected}
        onInput={(event) => setDraft(event.currentTarget.value)}
        placeholder='Write a message…'
        rows={2}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <span>console</span>
      <button disabled={!draft.trim() || !connected}>↑</button>
    </form>
  );
}

function LogRail({
  logs,
  open,
  setOpen,
  full = false,
}: {
  logs: Array<JsonObject>;
  open: boolean;
  setOpen(value: boolean): void;
  full?: boolean;
}) {
  const latest = logs.at(-1);
  return (
    <section
      class={`${full ? 'logs-full ' : ''}log-rail ${open ? 'open' : ''}`}
    >
      <header>
        <span>LOGS</span>
        {latest ? (
          <>
            <time>{clock(latest.ts)}</time>
            <code>{text(latest.msg, text(latest.message))}</code>
          </>
        ) : (
          <code>no recent log lines</code>
        )}
        <button onClick={() => setOpen(!open)}>{open ? 'hide' : 'show'}</button>
      </header>
      {open || full ? (
        <div class='log-lines'>
          {logs.map((line, index) => (
            <div class={`log-line log-${text(line.level, 'info')}`} key={index}>
              <time>{clock(line.ts)}</time>
              <span>{text(line.msg, text(line.message))}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function MobileTop({
  state,
  open,
}: {
  state: ReturnType<typeof useConsole>[0];
  open(): void;
}) {
  const usage = state.usage as JsonObject | null;
  return (
    <header class='mobile-top'>
      <img src='./elpis-logo-dark.svg' alt='Elpis' />
      <code>{state.meta?.gitHash?.slice(0, 7) || 'local'}</code>
      <span class='spacer' />
      <i class={`connection-dot connection-${state.connection}`} />
      <span>{Math.round(number(usage?.ratio) * 100)}%</span>
      <button onClick={open}>☰</button>
    </header>
  );
}

function MobileTabs({
  view,
  setView,
  openLogs,
}: {
  view: ViewName;
  setView(view: ViewName): void;
  openLogs(): void;
}) {
  const tabs = NAV.filter((item) => item.view !== 'context');
  return (
    <nav class='mobile-tabs'>
      {tabs.map((item) => (
        <button
          class={view === item.view ? 'active' : ''}
          onClick={() => setView(item.view)}
        >
          <span>{item.glyph}</span>
          <small>{item.label}</small>
        </button>
      ))}
      <button class={view === 'logs' ? 'active' : ''} onClick={openLogs}>
        <span>≡</span>
        <small>Logs</small>
      </button>
    </nav>
  );
}

function App() {
  const [state, actions] = useConsole();
  const [drawer, setDrawer] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [hintMindId, setHintMindId] = useState<string | null>(null);
  const proposals = useMemo(
    () => state.mindItems.filter((item) => item.status === 'proposal').length,
    [state.mindItems],
  );
  const askSecretary = (item: MindItem): void => {
    setHintMindId(item.id);
    actions.setView('secretary');
  };
  let body;
  if (state.view === 'thread')
    body = <ThreadView state={state} actions={actions} />;
  else if (state.view === 'context')
    body = <ContextView state={state} actions={actions} />;
  else if (state.view === 'mind')
    body = (
      <MindView state={state} actions={actions} onAskSecretary={askSecretary} />
    );
  else if (state.view === 'workers')
    body = <WorkersView state={state} actions={actions} />;
  else if (state.view === 'secretary')
    body = (
      <SecretaryView
        state={state}
        actions={actions}
        hintMindId={hintMindId}
        onClearHint={() => setHintMindId(null)}
      />
    );
  else
    body = (
      <LogRail
        logs={state.logs as JsonObject[]}
        open
        setOpen={() => undefined}
        full
      />
    );
  return (
    <div class='app-shell'>
      <MobileTop state={state} open={() => setDrawer(true)} />
      {drawer ? (
        <div class='drawer-scrim' onClick={() => setDrawer(false)}>
          <div onClick={(event) => event.stopPropagation()}>
            <Sidebar
              state={state}
              actions={actions}
              proposals={proposals}
              onClose={() => setDrawer(false)}
            />
          </div>
        </div>
      ) : null}
      <Sidebar state={state} actions={actions} proposals={proposals} />
      <main>
        <StatusBar state={state} />
        {state.notice ? (
          <button class='global-notice' onClick={() => actions.clearNotice()}>
            {state.notice} ×
          </button>
        ) : null}
        <div class='main-view'>{body}</div>
        {state.view === 'thread' ? (
          <ThreadComposer
            connected={state.connection === 'connected'}
            send={actions.sendChat}
          />
        ) : null}
        <LogRail
          logs={state.logs as JsonObject[]}
          open={logsOpen}
          setOpen={setLogsOpen}
        />
      </main>
      <MobileTabs
        view={state.view}
        setView={actions.setView}
        openLogs={() => actions.setView('logs')}
      />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
