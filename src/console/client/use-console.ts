import { useCallback, useEffect, useReducer, useRef } from 'preact/hooks';
import type {
  ConsoleState,
  ControlSnapshot,
  JsonObject,
  LiveStream,
  LogLine,
  MindItem,
  RoomFact,
  ServerFrame,
  StreamEntry,
  ViewName,
} from './types.js';
import { array, number, object, text } from './types.js';

const EMPTY_CONTROL: ControlSnapshot = { available: false, sessions: [] };

function initialView(): ViewName {
  if (typeof localStorage === 'undefined') return 'thread';
  const stored = localStorage.getItem('elpis-view') ?? '';
  return ['thread', 'context', 'mind', 'workers', 'secretary', 'logs'].includes(
    stored,
  )
    ? (stored as ViewName)
    : 'thread';
}

const initialState: ConsoleState = {
  connection: 'connecting',
  view: initialView(),
  room: 'all',
  rooms: [],
  participants: 0,
  usage: null,
  subUsage: null,
  meta: null,
  messages: [],
  hasMore: false,
  loadingHistory: false,
  live: null,
  logs: [],
  context: null,
  contextReqId: 0,
  mindAvailable: false,
  mindItems: [],
  mindStats: null,
  mindDetail: null,
  selectedMindId: null,
  workers: EMPTY_CONTROL,
  secretary: EMPTY_CONTROL,
  selectedWorkerRef: null,
  selectedSecretaryId: null,
  notice: null,
};

type Action =
  | { type: 'connection'; value: ConsoleState['connection'] }
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'view'; value: ViewName }
  | { type: 'room'; value: string }
  | { type: 'history-loading'; value: boolean }
  | { type: 'context-request'; reqId: number }
  | { type: 'select-mind'; id: string | null }
  | { type: 'select-worker'; ref: string | null }
  | { type: 'select-secretary'; id: string | null }
  | { type: 'notice'; value: string | null };

function controlSnapshot(value: unknown): ControlSnapshot {
  const source = object(value);
  return {
    ...source,
    available: source.available === true,
    sessions: array<JsonObject>(source.sessions),
    error: typeof source.error === 'string' ? source.error : undefined,
  };
}

export function workerDetailFromControl(value: unknown): JsonObject {
  const result = object(value);
  return {
    ...object(result.session),
    messages: array<JsonObject>(result.messages),
    artifacts: array<JsonObject>(result.artifacts),
  };
}

export function secretaryIdFromControl(value: unknown): string | null {
  return text(object(value).id) || null;
}

export function upsertControlSession(
  snapshot: ControlSnapshot,
  value: unknown,
): ControlSnapshot {
  const incoming = object(value);
  const id = text(incoming.id);
  if (!id) return snapshot;
  const previous = snapshot.sessions.find((session) => text(session.id) === id);
  const merged = { ...previous, ...incoming };
  return {
    ...snapshot,
    available: true,
    sessions: [
      merged,
      ...snapshot.sessions.filter((session) => text(session.id) !== id),
    ],
  };
}

export function secretaryPendingStatus(
  session: unknown,
): 'queued' | 'claimed' | null {
  const turns = array<JsonObject>(object(session).turns);
  if (turns.some((turn) => text(turn.status) === 'claimed')) return 'claimed';
  if (turns.some((turn) => text(turn.status) === 'queued')) return 'queued';
  return null;
}

export function secretarySnapshotHasPending(
  snapshot: ControlSnapshot,
): boolean {
  return snapshot.sessions.some((session) => secretaryPendingStatus(session));
}

export function appendSecretaryTurn(
  snapshot: ControlSnapshot,
  value: unknown,
): ControlSnapshot {
  const turn = object(value);
  const sessionId = text(turn.sessionId);
  if (!sessionId) return snapshot;
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session) =>
      text(session.id) === sessionId
        ? {
            ...session,
            turns: [...array<JsonObject>(session.turns), turn].slice(-20),
          }
        : session,
    ),
  };
}

function workerRefFromSession(value: unknown): string | null {
  const session = object(value);
  return text(session.worker, text(session.slug, text(session.id))) || null;
}

function mindSnapshot(state: ConsoleState, value: unknown): ConsoleState {
  const source = object(value);
  const items = array<MindItem>(source.items);
  const selectedMindId =
    state.selectedMindId &&
    items.some((item) => item.id === state.selectedMindId)
      ? state.selectedMindId
      : state.selectedMindId;
  return {
    ...state,
    mindAvailable: source.available === true,
    mindItems: items,
    mindStats: source.stats ? object(source.stats) : null,
    selectedMindId,
    notice: typeof source.error === 'string' ? source.error : state.notice,
  };
}

function applyFrame(state: ConsoleState, frame: ServerFrame): ConsoleState {
  switch (frame.t) {
    case 'snapshot': {
      let next: ConsoleState = {
        ...state,
        usage: frame.usage
          ? (object(frame.usage) as unknown as ConsoleState['usage'])
          : null,
        subUsage: frame.subUsage ? object(frame.subUsage) : null,
        meta: frame.meta ? object(frame.meta) : null,
        rooms: array<RoomFact>(frame.rooms),
        participants: number(frame.participants),
        messages: array<StreamEntry>(frame.messages),
        hasMore: frame.hasMore === true,
        live: frame.stream
          ? (object(frame.stream) as unknown as LiveStream)
          : null,
        logs: array<LogLine>(frame.logs),
        workers: controlSnapshot(frame.workers),
        secretary: controlSnapshot(frame.secretary),
      };
      if (frame.mind) next = mindSnapshot(next, frame.mind);
      const sessions = next.secretary.sessions;
      const selectedStillPresent = sessions.some(
        (session) => text(session.id) === next.selectedSecretaryId,
      );
      if (
        (!next.selectedSecretaryId || !selectedStillPresent) &&
        sessions.length
      )
        next = { ...next, selectedSecretaryId: text(sessions[0].id) || null };
      return next;
    }
    case 'message':
      return {
        ...state,
        messages: [
          ...state.messages,
          object(frame.msg) as unknown as StreamEntry,
        ],
        live: null,
      };
    case 'history':
      return {
        ...state,
        messages: [...array<StreamEntry>(frame.messages), ...state.messages],
        hasMore: frame.hasMore === true,
        loadingHistory: false,
      };
    case 'streamStart':
      return {
        ...state,
        live: {
          streamId: number(frame.streamId),
          channel: text(frame.channel, 'internal'),
          content: '',
          reasoning: '',
        },
      };
    case 'delta': {
      const current =
        state.live?.streamId === number(frame.streamId)
          ? state.live
          : {
              streamId: number(frame.streamId),
              channel: text(frame.channel, 'internal'),
              content: '',
              reasoning: '',
            };
      const value = text(frame.text);
      return {
        ...state,
        live:
          frame.kind === 'content'
            ? { ...current, content: current.content + value }
            : { ...current, reasoning: current.reasoning + value },
      };
    }
    case 'streamEnd':
      return { ...state, live: null };
    case 'usage':
      return {
        ...state,
        usage: object(frame.usage) as unknown as ConsoleState['usage'],
      };
    case 'subUsage':
      return { ...state, subUsage: frame.usage ? object(frame.usage) : null };
    case 'rooms':
      return {
        ...state,
        rooms: array<RoomFact>(frame.rooms),
        participants: number(frame.participants, state.participants),
      };
    case 'log':
      return {
        ...state,
        logs: [...state.logs, object(frame.line) as LogLine].slice(-600),
      };
    case 'context':
      return number(frame.reqId) === state.contextReqId
        ? { ...state, context: frame.context ? object(frame.context) : null }
        : state;
    case 'mindSnapshot':
      return mindSnapshot(state, frame);
    case 'mindDetail':
      return number(frame.reqId) >= 0
        ? {
            ...state,
            mindDetail: frame.item ? (object(frame.item) as MindItem) : null,
          }
        : state;
    case 'mindResult':
      return {
        ...state,
        notice:
          frame.ok === false
            ? text(frame.error, 'Mind operation failed')
            : null,
      };
    case 'chatResult':
    case 'moderateResult':
      return {
        ...state,
        notice:
          frame.ok === false ? text(frame.note, 'operation failed') : null,
      };
    case 'controlResult': {
      if (frame.ok === false)
        return {
          ...state,
          notice: text(frame.error, 'control operation failed'),
        };
      if (frame.lane === 'worker') {
        if (frame.op === 'snapshot')
          return {
            ...state,
            workers: controlSnapshot(frame.result),
            notice: null,
          };
        if (frame.op === 'status')
          return {
            ...state,
            workerDetail: workerDetailFromControl(frame.result),
            notice: null,
          } as ConsoleState;
        if (frame.op === 'start') {
          const session = object(frame.result);
          const ref = workerRefFromSession(session);
          return {
            ...state,
            workers: upsertControlSession(state.workers, session),
            selectedWorkerRef: ref ?? state.selectedWorkerRef,
            workerDetail: {
              ...session,
              messages: [],
              artifacts: [],
            },
            notice: null,
          };
        }
        if (frame.op === 'send')
          return {
            ...state,
            workerDetail: state.workerDetail
              ? {
                  ...state.workerDetail,
                  messages: [
                    ...array<JsonObject>(state.workerDetail.messages),
                    object(frame.result),
                  ].slice(-20),
                }
              : state.workerDetail,
            notice: null,
          };
        if (frame.op === 'dismiss') {
          const session = object(frame.result);
          const detail = state.workerDetail;
          return {
            ...state,
            workers: upsertControlSession(state.workers, session),
            workerDetail:
              detail && text(detail.id) === text(session.id)
                ? { ...detail, ...session }
                : detail,
            notice: null,
          };
        }
      }
      if (frame.lane === 'secretary') {
        if (frame.op === 'snapshot')
          return {
            ...state,
            secretary: controlSnapshot(frame.result),
            notice: null,
          };
        if (frame.op === 'start') {
          const session = object(frame.result);
          return {
            ...state,
            secretary: upsertControlSession(state.secretary, session),
            selectedSecretaryId:
              secretaryIdFromControl(session) ?? state.selectedSecretaryId,
            notice: null,
          };
        }
        if (frame.op === 'enqueue')
          return {
            ...state,
            secretary: appendSecretaryTurn(state.secretary, frame.result),
            notice: null,
          };
        if (frame.op === 'close')
          return {
            ...state,
            secretary: upsertControlSession(state.secretary, frame.result),
            notice: null,
          };
      }
      return { ...state, notice: null };
    }
    default:
      return state;
  }
}

function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.value };
    case 'frame':
      return applyFrame(state, action.frame);
    case 'view':
      return { ...state, view: action.value };
    case 'room':
      return { ...state, room: action.value };
    case 'history-loading':
      return { ...state, loadingHistory: action.value };
    case 'context-request':
      return { ...state, contextReqId: action.reqId };
    case 'select-mind':
      return {
        ...state,
        selectedMindId: action.id,
        mindDetail: action.id ? state.mindDetail : null,
      };
    case 'select-worker':
      return { ...state, selectedWorkerRef: action.ref };
    case 'select-secretary':
      return { ...state, selectedSecretaryId: action.id };
    case 'notice':
      return { ...state, notice: action.value };
  }
}

export interface ConsoleActions {
  setView(view: ViewName): void;
  setRoom(room: string): void;
  sendChat(content: string): boolean;
  requestBackfill(): void;
  requestContext(): void;
  requestMind(): void;
  requestMindDetail(id: string): void;
  mind(op: string, payload?: JsonObject): void;
  control(lane: 'worker' | 'secretary', op: string, payload?: JsonObject): void;
  selectMind(id: string | null): void;
  selectWorker(ref: string | null): void;
  selectSecretary(id: string | null): void;
  clearNotice(): void;
}

export function useConsole(): [ConsoleState, ConsoleActions] {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socket = useRef<WebSocket | null>(null);
  const retry = useRef(500);
  const retryTimer = useRef<number | null>(null);
  const requestId = useRef(0);
  const contextRefreshTimer = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const send = useCallback((frame: JsonObject): boolean => {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      dispatch({ type: 'notice', value: 'Backend is not connected.' });
      return false;
    }
    socket.current.send(JSON.stringify(frame));
    return true;
  }, []);

  useEffect(() => {
    let disposed = false;
    const connect = (): void => {
      if (disposed) return;
      dispatch({
        type: 'connection',
        value: retry.current === 500 ? 'connecting' : 'reconnecting',
      });
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        retry.current = 500;
        dispatch({ type: 'connection', value: 'connected' });
      };
      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as ServerFrame;
          dispatch({ type: 'frame', frame });
          if (frame.t === 'message' && stateRef.current.view === 'context') {
            if (contextRefreshTimer.current !== null)
              window.clearTimeout(contextRefreshTimer.current);
            contextRefreshTimer.current = window.setTimeout(() => {
              const reqId = ++requestId.current;
              dispatch({ type: 'context-request', reqId });
              send({ t: 'context', reqId });
              contextRefreshTimer.current = null;
            }, 150);
          }
          if (frame.t === 'mindResult') {
            send({ t: 'mind', op: 'snapshot', reqId: ++requestId.current });
            const selected = stateRef.current.selectedMindId;
            if (selected)
              send({
                t: 'mind',
                op: 'get',
                id: selected,
                reqId: ++requestId.current,
              });
          }
          if (
            frame.t === 'controlResult' &&
            frame.ok !== false &&
            frame.op !== 'snapshot'
          ) {
            const lane = frame.lane === 'secretary' ? 'secretary' : 'worker';
            send({
              t: 'control',
              lane,
              op: 'snapshot',
              reqId: ++requestId.current,
            });
          }
        } catch {
          dispatch({
            type: 'notice',
            value: 'Ignored a malformed console frame.',
          });
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (disposed) return;
        dispatch({ type: 'connection', value: 'reconnecting' });
        const delay = retry.current;
        retry.current = Math.min(8000, delay * 2);
        retryTimer.current = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      if (contextRefreshTimer.current !== null)
        window.clearTimeout(contextRefreshTimer.current);
      socket.current?.close();
    };
  }, [send]);

  useEffect(() => {
    if (
      state.connection !== 'connected' ||
      state.view !== 'secretary' ||
      !secretarySnapshotHasPending(state.secretary)
    )
      return;
    const timer = window.setTimeout(() => {
      send({
        t: 'control',
        lane: 'secretary',
        op: 'snapshot',
        reqId: ++requestId.current,
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [send, state.connection, state.secretary, state.view]);

  const setView = useCallback(
    (view: ViewName) => {
      localStorage.setItem('elpis-view', view);
      dispatch({ type: 'view', value: view });
      if (view === 'context') {
        const reqId = ++requestId.current;
        dispatch({ type: 'context-request', reqId });
        send({ t: 'context', reqId });
      }
      if (view === 'mind')
        send({ t: 'mind', op: 'snapshot', reqId: ++requestId.current });
    },
    [send],
  );

  const actions: ConsoleActions = {
    setView,
    setRoom: (room) => dispatch({ type: 'room', value: room }),
    sendChat: (content) => {
      const value = content.trim();
      if (!value) return false;
      const nonce = `console:${crypto.randomUUID()}`;
      return send({ t: 'chat', nonce, content: value });
    },
    requestBackfill: () => {
      if (stateRef.current.loadingHistory || !stateRef.current.hasMore) return;
      dispatch({ type: 'history-loading', value: true });
      const first = stateRef.current.messages[0]?.id ?? 0;
      if (!send({ t: 'backfill', beforeId: first }))
        dispatch({ type: 'history-loading', value: false });
    },
    requestContext: () => {
      const reqId = ++requestId.current;
      dispatch({ type: 'context-request', reqId });
      send({ t: 'context', reqId });
    },
    requestMind: () =>
      send({ t: 'mind', op: 'snapshot', reqId: ++requestId.current }),
    requestMindDetail: (id) =>
      send({ t: 'mind', op: 'get', id, reqId: ++requestId.current }),
    mind: (op, payload = {}) =>
      send({ t: 'mind', op, reqId: ++requestId.current, ...payload }),
    control: (lane, op, payload = {}) =>
      send({ t: 'control', lane, op, reqId: ++requestId.current, ...payload }),
    selectMind: (id) => {
      dispatch({ type: 'select-mind', id });
      if (id) send({ t: 'mind', op: 'get', id, reqId: ++requestId.current });
    },
    selectWorker: (ref) => {
      dispatch({ type: 'select-worker', ref });
      if (ref)
        send({
          t: 'control',
          lane: 'worker',
          op: 'status',
          ref,
          reqId: ++requestId.current,
        });
    },
    selectSecretary: (id) => dispatch({ type: 'select-secretary', id }),
    clearNotice: () => dispatch({ type: 'notice', value: null }),
  };
  return [state, actions];
}
