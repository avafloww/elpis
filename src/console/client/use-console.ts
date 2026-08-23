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

const initialState: ConsoleState = {
  connection: 'connecting',
  view: (['thread', 'context', 'mind', 'workers', 'secretary', 'logs'].includes(
    localStorage.getItem('elpis-view') ?? '',
  )
    ? localStorage.getItem('elpis-view')
    : 'thread') as ViewName,
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
      if (!next.selectedSecretaryId && sessions.length)
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
      if (frame.lane === 'worker' && frame.op === 'status')
        return {
          ...state,
          workerDetail: object(frame.result),
          notice: null,
        } as ConsoleState;
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
          if (frame.t === 'controlResult' && frame.ok !== false) {
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
