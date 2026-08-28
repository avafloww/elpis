import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChatComposer, ActivityStrip } from './components/chat.js';
import { clock, statusLabel, statusTone } from './components/common.js';
import { ContextView } from './components/context.js';
import { MindView } from './components/mind.js';
import { SecretaryView } from './components/secretary.js';
import { ThreadView } from './components/thread.js';
import { WorkersView } from './components/workers.js';
import type { ConsoleActions } from './use-console.js';
import type { ConsoleState, JsonObject, MindItem, ViewName } from './types.js';
import { roomAfterSelection } from './navigation.js';
import { clampLogRailHeight } from './scroll.js';
import { number, text } from './types.js';
import './styles.css';

const NAV: Array<{ view: ViewName; glyph: string; label: string }> = [
  { view: 'thread', glyph: '◆', label: 'Thread' },
  { view: 'context', glyph: '◫', label: 'Context' },
  { view: 'mind', glyph: '✦', label: 'Mind' },
  { view: 'workers', glyph: '⬡', label: 'Workers' },
  { view: 'secretary', glyph: '◈', label: 'Secretary' },
];

function BuildLinks({ state }: { state: ConsoleState }) {
  const meta = state.meta;
  const revision = text(meta?.gitHash);
  const versionLabel = text(meta?.versionLabel);
  const versionUrl = text(meta?.versionUrl);
  const revisionUrl = text(meta?.revisionUrl);
  if (versionLabel && versionUrl) {
    return (
      <>
        <a
          href={versionUrl}
          target='_blank'
          rel='noreferrer'
          title={`Elpis ${versionLabel}`}
        >
          {versionLabel}
        </a>
        {!meta?.exactRelease &&
        revision &&
        revision !== 'unknown' &&
        revisionUrl ? (
          <a
            href={revisionUrl}
            target='_blank'
            rel='noreferrer'
            title={revision}
          >
            {revision.slice(0, 7)}
          </a>
        ) : null}
      </>
    );
  }
  return revision && revision !== 'unknown' ? (
    <a
      href={`https://github.com/avafloww/elpis/commit/${revision}`}
      target='_blank'
      rel='noreferrer'
      title={revision}
    >
      {revision.slice(0, 7)}
    </a>
  ) : (
    <span>local</span>
  );
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const update = (): void => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function connectionLabel(state: ConsoleState, now: number): string {
  if (state.connection !== 'connected')
    return state.connection.replaceAll('_', '…');
  const startedAt = number(state.meta?.startedAt);
  const uptimeMs =
    startedAt > 0
      ? Math.max(0, now - startedAt)
      : Math.max(0, number(state.meta?.uptimeMs));
  const minutes = Math.floor(uptimeMs / 60_000);
  if (minutes < 1) return 'up <1m';
  if (minutes < 60) return `up ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours >= 24
    ? `up ${Math.floor(hours / 24)}d ${hours % 24}h`
    : `up ${hours}h`;
}

function connectionTone(state: ConsoleState): string {
  if (state.connection === 'connected') return '#8fb89a';
  if (state.connection === 'connecting' || state.connection === 'reconnecting')
    return '#d9b24f';
  return '#d98f8c';
}

function ratio(state: ConsoleState): number {
  const current = number(state.usage?.current);
  const windowSize = number(state.usage?.window, 1);
  return Math.max(0, Math.min(100, (current / windowSize) * 100));
}

function roomName(value: string): string {
  return value.replace('/', ' / ');
}

function roomLabel(room: { name: string; guildSlug?: string }): string {
  const name = roomName(room.name);
  return room.guildSlug && !name.startsWith(`${room.guildSlug} / `)
    ? `${room.guildSlug} / ${name}`
    : name;
}

function workerRef(session: JsonObject): string {
  return (
    text(session.worker) ||
    text(session.slug) ||
    text(session.id) ||
    text(session.sessionId)
  );
}

function ContextMeter({
  state,
  compact = false,
}: {
  state: ConsoleState;
  compact?: boolean;
}) {
  const current = number(state.usage?.current);
  const windowSize = number(state.usage?.window, 1);
  const trigger = number(state.usage?.trigger, windowSize);
  const percent = ratio(state);
  const triggerPercent = Math.max(
    0,
    Math.min(100, (trigger / windowSize) * 100),
  );
  return (
    <div class={`context-meter ${compact ? 'context-meter-compact' : ''}`}>
      <div>
        <span>Context window</span>
        <strong>
          {Math.round(current / 1000)}k / {Math.round(windowSize / 1000)}k
        </strong>
        <em>{Math.round(percent)}%</em>
      </div>
      <span class='meter-track'>
        <i style={{ width: `${percent}%` }} />
        <b style={{ left: `${triggerPercent}%` }} />
      </span>
      {!compact ? (
        <small>
          <span>compaction at {Math.round(triggerPercent)}%</span>
          <span>
            cache{' '}
            {Math.round(
              number(
                state.usage?.cache && (state.usage.cache as JsonObject).ratio,
              ) * 100,
            ) || 0}
            %
          </span>
        </small>
      ) : null}
    </div>
  );
}

function Rooms({
  state,
  actions,
  close,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  close?(): void;
}) {
  const total = state.rooms.reduce((sum, room) => sum + room.count, 0);
  const choose = (id: string): void => {
    actions.setRoom(roomAfterSelection(state.room, id));
    actions.selectMind(null);
    actions.selectWorker(null);
    actions.setView('thread');
    close?.();
  };
  const rows = [
    { id: 'all', name: 'All rooms', count: total, color: '#d8b877' },
    ...state.rooms,
  ];
  return (
    <section class='sidebar-section room-section'>
      <div class='section-label'>Rooms</div>
      {rows.map((room) => (
        <button
          class={state.room === room.id ? 'selected' : ''}
          onClick={() => choose(room.id)}
        >
          <i style={{ background: room.color || '#767a70' }} />
          <strong>{roomLabel(room)}</strong>
          <span>{room.count}</span>
        </button>
      ))}
    </section>
  );
}

function LiveWorkers({
  state,
  actions,
  close,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  close?(): void;
}) {
  const active = state.workers.sessions
    .filter((session) =>
      ['spawning', 'running', 'idle'].includes(text(session.status)),
    )
    .slice(0, 3);
  const open = (session: JsonObject): void => {
    actions.selectWorker(workerRef(session));
    actions.setView('workers');
    close?.();
  };
  return (
    <section class='sidebar-section sidebar-workers'>
      <div class='section-label'>
        Workers · live <span>{active.length} running</span>
      </div>
      {active.map((session) => (
        <button onClick={() => open(session)}>
          <div>
            <i class={`tone-dot tone-${statusTone(session.status)}`} />
            <code>{workerRef(session)}</code>
          </div>
          <strong>
            {text(
              session.mindTitle,
              state.mindItems.find((item) => item.id === text(session.mindId))
                ?.title ||
                text(session.title, text(session.mindId, 'bounded episode')),
            )}
          </strong>
          <small>
            <span class={`tone-${statusTone(session.status)}`}>
              {statusLabel(session.status)}
            </span>
            <time>{text(session.startedAgo)}</time>
          </small>
        </button>
      ))}
      <button
        class='all-workers-link'
        onClick={() => {
          actions.selectWorker(null);
          actions.setView('workers');
          close?.();
        }}
      >
        All {state.workers.sessions.length} workers →
      </button>
    </section>
  );
}

function Sidebar({
  state,
  actions,
  proposals,
  close,
  drawer = false,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  proposals: number;
  close?(): void;
  drawer?: boolean;
}) {
  const now = useNow();
  const chooseView = (view: ViewName): void => {
    actions.selectMind(null);
    actions.selectWorker(null);
    actions.setView(view);
    close?.();
  };
  return (
    <aside class={`sidebar ${drawer ? 'sidebar-drawer' : ''}`}>
      <header class='sidebar-brand'>
        <img src='./elpis-logo-dark.svg' alt='Elpis' />
        <span class='surface-spacer' />
        {drawer ? (
          <button onClick={close}>×</button>
        ) : (
          <>
            <BuildLinks state={state} />
            <span>{connectionLabel(state, now)}</span>
            <i style={{ background: connectionTone(state) }} />
          </>
        )}
      </header>
      {drawer ? (
        <ContextMeter state={state} compact />
      ) : (
        <nav class='view-nav'>
          {NAV.map((item) => (
            <button
              class={state.view === item.view ? 'selected' : ''}
              onClick={() => chooseView(item.view)}
            >
              <i>{item.glyph}</i>
              <strong>{item.label}</strong>
              {item.view === 'mind' && proposals ? (
                <span>{proposals}</span>
              ) : null}
            </button>
          ))}
        </nav>
      )}
      <div class='sidebar-scroll'>
        <Rooms state={state} actions={actions} close={close} />
        <LiveWorkers state={state} actions={actions} close={close} />
      </div>
      {!drawer ? <ContextMeter state={state} /> : null}
    </aside>
  );
}

const LOG_RAIL_KEY = 'ep-logdock-h';

function savedLogRailHeight(): number {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined')
    return 208;
  const stored = Number.parseInt(localStorage.getItem(LOG_RAIL_KEY) ?? '', 10);
  return clampLogRailHeight(
    Number.isFinite(stored) ? stored : 208,
    window.innerHeight,
  );
}

function LogRail({
  state,
  open,
  setOpen,
  full = false,
}: {
  state: ConsoleState;
  open: boolean;
  setOpen(value: boolean): void;
  full?: boolean;
}) {
  const latest = state.logs.at(-1);
  const [height, setHeight] = useState(savedLogRailHeight);
  const heightRef = useRef(height);
  const drag = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const applyHeight = (value: number): number => {
    const next = clampLogRailHeight(value, window.innerHeight);
    heightRef.current = next;
    setHeight(next);
    return next;
  };
  const persistHeight = (value: number): void => {
    try {
      localStorage.setItem(LOG_RAIL_KEY, String(value));
    } catch {
      // Storage can be blocked without disabling the rail.
    }
  };
  const stopResize = (target: HTMLDivElement, pointerId: number): void => {
    if (drag.current?.pointerId !== pointerId) return;
    if (target.hasPointerCapture(pointerId))
      target.releasePointerCapture(pointerId);
    drag.current = null;
    document.body.classList.remove('resizing-logs');
    persistHeight(heightRef.current);
  };
  useEffect(() => {
    if (full) return;
    const reClamp = (): void => {
      const next = applyHeight(heightRef.current);
      persistHeight(next);
    };
    window.addEventListener('resize', reClamp);
    return () => {
      window.removeEventListener('resize', reClamp);
      document.body.classList.remove('resizing-logs');
    };
  }, [full]);
  return (
    <section
      class={`log-rail ${open ? 'log-rail-open' : ''} ${full ? 'log-view-full' : ''}`}
      style={!full && open ? { height: `${height}px` } : undefined}
    >
      {!full ? (
        <>
          <div
            class='log-resizer'
            role='separator'
            aria-label='Resize logs'
            aria-orientation='horizontal'
            aria-valuemin={96}
            aria-valuemax={clampLogRailHeight(
              Number.MAX_SAFE_INTEGER,
              window.innerHeight,
            )}
            aria-valuenow={open ? height : 96}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              if (!open) {
                applyHeight(96);
                setOpen(true);
              }
              const startHeight = open ? heightRef.current : 96;
              drag.current = {
                pointerId: event.pointerId,
                startY: event.clientY,
                startHeight,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              document.body.classList.add('resizing-logs');
            }}
            onPointerMove={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              applyHeight(current.startHeight + current.startY - event.clientY);
            }}
            onPointerUp={(event) =>
              stopResize(event.currentTarget, event.pointerId)
            }
            onPointerCancel={(event) =>
              stopResize(event.currentTarget, event.pointerId)
            }
            onDblClick={() => persistHeight(applyHeight(208))}
            onKeyDown={(event) => {
              let next: number | null = null;
              if (event.key === 'ArrowUp') next = heightRef.current + 16;
              if (event.key === 'ArrowDown') next = heightRef.current - 16;
              if (event.key === 'Home') next = 96;
              if (event.key === 'End') next = Number.MAX_SAFE_INTEGER;
              if (next === null) return;
              event.preventDefault();
              if (!open) setOpen(true);
              persistHeight(applyHeight(next));
            }}
          />
          <header>
            <span>Logs</span>
            <time>{latest ? clock(latest.ts) : ''}</time>
            <code>
              {latest
                ? text(latest.msg, text(latest.message))
                : 'no recent log lines'}
            </code>
            <button onClick={() => setOpen(!open)}>
              {open ? 'hide' : 'show'}
            </button>
          </header>
        </>
      ) : null}
      {open || full ? (
        <div class='log-lines'>
          {state.logs.map((line, index) => (
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

function ViewBody({
  state,
  actions,
  hintMindId,
  setHintMindId,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  hintMindId: string | null;
  setHintMindId(value: string | null): void;
}) {
  const askSecretary = (item: MindItem): void => {
    setHintMindId(item.id);
    actions.setView('secretary');
  };
  if (state.view === 'thread')
    return <ThreadView state={state} actions={actions} />;
  if (state.view === 'context')
    return <ContextView state={state} actions={actions} />;
  if (state.view === 'mind')
    return (
      <MindView state={state} actions={actions} onAskSecretary={askSecretary} />
    );
  if (state.view === 'workers')
    return <WorkersView state={state} actions={actions} />;
  if (state.view === 'secretary')
    return (
      <SecretaryView
        state={state}
        actions={actions}
        hintMindId={hintMindId}
        onClearHint={() => setHintMindId(null)}
      />
    );
  return <LogRail state={state} open setOpen={() => undefined} full />;
}

function DesktopApp({
  state,
  actions,
  proposals,
  hintMindId,
  setHintMindId,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  proposals: number;
  hintMindId: string | null;
  setHintMindId(value: string | null): void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  return (
    <div class='desktop-shell'>
      <Sidebar state={state} actions={actions} proposals={proposals} />
      <main class='desktop-main'>
        <div class='view-body'>
          <ViewBody
            state={state}
            actions={actions}
            hintMindId={hintMindId}
            setHintMindId={setHintMindId}
          />
        </div>
        {state.view === 'thread' ? (
          <>
            {state.live && !state.live.content ? (
              <ActivityStrip
                label={`${text(state.meta?.agentName, 'agent')} is thinking`}
                detail={state.live.reasoning || undefined}
              />
            ) : null}
            <ChatComposer
              disabled={state.connection !== 'connected'}
              contextLabel='console'
              onSend={actions.sendChat}
            />
          </>
        ) : null}
        <LogRail state={state} open={logsOpen} setOpen={setLogsOpen} />
      </main>
    </div>
  );
}

function MobileTop({ state, open }: { state: ConsoleState; open(): void }) {
  return (
    <header class='mobile-topbar'>
      <img src='./elpis-logo-dark.svg' alt='Elpis' />
      <BuildLinks state={state} />
      <span class='surface-spacer' />
      <i style={{ background: connectionTone(state) }} />
      <span>{Math.round(ratio(state))}%</span>
      <button onClick={open}>☰</button>
    </header>
  );
}

function MobileTabs({
  state,
  actions,
  proposals,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  proposals: number;
}) {
  const tabs = [
    ...NAV.filter((item) => item.view !== 'context'),
    { view: 'logs' as ViewName, glyph: '≡', label: 'Logs' },
  ];
  return (
    <nav class='mobile-tabs'>
      {tabs.map((item) => (
        <button
          class={state.view === item.view ? 'selected' : ''}
          onClick={() => {
            actions.selectMind(null);
            actions.selectWorker(null);
            actions.setView(item.view);
          }}
        >
          <i>{item.glyph}</i>
          <span>{item.label}</span>
          {item.view === 'mind' && proposals ? <b>{proposals}</b> : null}
        </button>
      ))}
    </nav>
  );
}

function MobileApp({
  state,
  actions,
  proposals,
  hintMindId,
  setHintMindId,
}: {
  state: ConsoleState;
  actions: ConsoleActions;
  proposals: number;
  hintMindId: string | null;
  setHintMindId(value: string | null): void;
}) {
  const [drawer, setDrawer] = useState(false);
  return (
    <div class='mobile-shell'>
      <MobileTop state={state} open={() => setDrawer(true)} />
      <div class='mobile-body'>
        <ViewBody
          state={state}
          actions={actions}
          hintMindId={hintMindId}
          setHintMindId={setHintMindId}
        />
      </div>
      {state.view === 'thread' ? (
        <>
          {state.live && !state.live.content ? (
            <ActivityStrip
              label={`${text(state.meta?.agentName, 'agent')} is thinking`}
              detail={state.live.reasoning || undefined}
            />
          ) : null}
          <ChatComposer
            disabled={state.connection !== 'connected'}
            mobile
            onSend={actions.sendChat}
          />
        </>
      ) : null}
      <MobileTabs state={state} actions={actions} proposals={proposals} />
      {drawer ? (
        <div class='drawer-layer'>
          <button class='drawer-scrim' onClick={() => setDrawer(false)} />
          <Sidebar
            state={state}
            actions={actions}
            proposals={proposals}
            close={() => setDrawer(false)}
            drawer
          />
        </div>
      ) : null}
    </div>
  );
}

export interface ConsoleDashboardProps {
  state: ConsoleState;
  actions: ConsoleActions;
}

export function ConsoleDashboard({ state, actions }: ConsoleDashboardProps) {
  const [hintMindId, setHintMindId] = useState<string | null>(null);
  const narrow = useNarrow();
  const proposals = useMemo(
    () => state.mindItems.filter((item) => item.status === 'proposal').length,
    [state.mindItems],
  );
  const body = narrow ? (
    <MobileApp
      state={state}
      actions={actions}
      proposals={proposals}
      hintMindId={hintMindId}
      setHintMindId={setHintMindId}
    />
  ) : (
    <DesktopApp
      state={state}
      actions={actions}
      proposals={proposals}
      hintMindId={hintMindId}
      setHintMindId={setHintMindId}
    />
  );
  return (
    <div class='app-root'>
      {body}
      {state.notice ? (
        <button class='global-notice' onClick={() => actions.clearNotice()}>
          {state.notice} ×
        </button>
      ) : null}
    </div>
  );
}
