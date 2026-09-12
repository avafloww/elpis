import { useCallback, useEffect, useReducer, useRef } from 'preact/hooks';
import type { ConsoleTransport, ConsoleTransportEvent } from './transport.js';
import type {
  ConsoleState,
  ControlSnapshot,
  JsonObject,
  LiveStream,
  LogLine,
  MindItem,
  MindOrigin,
  RoomFact,
  ServerFrame,
  StreamEntry,
  ViewName,
} from './types.js';
import { array, number, object, text } from './types.js';
import { applyCollectionPatch } from '../sync.js';

const EMPTY_CONTROL: ControlSnapshot = { available: false, sessions: [] };

const VIEWS: readonly ViewName[] = [
  'thread',
  'context',
  'mind',
  'workers',
  'secretary',
  'logs',
];

export const initialState: ConsoleState = {
  connection: 'connecting',
  view: 'thread',
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
  snapshotVersion: 0,
  mindAvailable: false,
  mindItems: [],
  mindStats: null,
  mindDetail: null,
  selectedMindId: null,
  mindOrigin: null,
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
  | { type: 'select-mind'; id: string | null; origin: MindOrigin | null }
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
  const detail: JsonObject = {
    ...object(result.session),
    messages: array<JsonObject>(result.messages),
    artifacts: array<JsonObject>(result.artifacts),
  };
  if (typeof result.mindTitle === 'string') detail.mindTitle = result.mindTitle;
  if (typeof result.mandate === 'string') detail.mandate = result.mandate;
  return detail;
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
            turns: array<JsonObject>(session.turns).some(
              (existing) => existing.id === turn.id,
            )
              ? session.turns
              : [...array<JsonObject>(session.turns), turn].slice(-20),
          }
        : session,
    ),
  };
}

function workerRefFromSession(value: unknown): string | null {
  const session = object(value);
  return text(session.worker, text(session.slug, text(session.id))) || null;
}

function workerMatches(value: unknown, ref: string | null): boolean {
  const session = object(value);
  return (
    ref !== null && [session.worker, session.slug, session.id].includes(ref)
  );
}

function mergeMessages(
  before: StreamEntry[],
  incoming: StreamEntry[],
): StreamEntry[] {
  if (
    incoming.length === 1 &&
    (!before.length || incoming[0].id > before[before.length - 1].id)
  )
    return [...before, ...incoming];
  return [
    ...new Map(
      [...before, ...incoming].map((entry) => [entry.id, entry]),
    ).values(),
  ].sort((a, b) => a.id - b.id);
}

function mindSnapshot(state: ConsoleState, value: unknown): ConsoleState {
  const source = object(value);
  const items = array<MindItem>(source.items);
  return {
    ...state,
    mindAvailable: source.available === true,
    mindItems: items,
    mindStats: source.stats ? object(source.stats) : null,
    notice: typeof source.error === 'string' ? source.error : state.notice,
  };
}

function applyFrame(state: ConsoleState, frame: ServerFrame): ConsoleState {
  switch (frame.t) {
    case 'sync': {
      let next = { ...state };
      for (const key of ['workers', 'secretary'] as const) {
        if (frame[key])
          next[key] = applyCollectionPatch(
            next[key],
            object(frame[key]),
            'sessions',
          ) as ControlSnapshot;
      }
      if (frame.mind)
        next = mindSnapshot(
          next,
          applyCollectionPatch(
            { items: state.mindItems },
            object(frame.mind),
            'items',
          ),
        );
      if ('meta' in frame) next.meta = frame.meta ? object(frame.meta) : null;
      if ('usage' in frame) next.usage = frame.usage as ConsoleState['usage'];
      if ('subUsage' in frame)
        next.subUsage = frame.subUsage ? object(frame.subUsage) : null;
      if ('rooms' in frame) next.rooms = array<RoomFact>(frame.rooms);
      if ('participants' in frame)
        next.participants = number(frame.participants);
      if ('context' in frame && state.view === 'context')
        next.context = frame.context ? object(frame.context) : null;
      const worker = object(frame.workerDetail);
      if (worker.ref === state.selectedWorkerRef) {
        next.workerDetail = worker.result
          ? workerDetailFromControl(worker.result)
          : null;
        if (worker.error) next.notice = text(worker.error);
      } else if (frame.workers && next.workerDetail) {
        const session = next.workers.sessions.find((s) =>
          workerMatches(s, next.selectedWorkerRef),
        );
        next.workerDetail = session
          ? { ...next.workerDetail, ...session }
          : null;
      }
      const mind = object(frame.mindDetail);
      if (mind.id === state.selectedMindId)
        next.mindDetail = mind.item ? (object(mind.item) as MindItem) : null;
      return next;
    }
    case 'snapshot': {
      const incoming = array<StreamEntry>(frame.messages);
      const sameProcess =
        state.meta?.startedAt != null &&
        state.meta.startedAt === object(frame.meta).startedAt;
      const overlaps = incoming.some((entry) =>
        state.messages.some((old) => old.id === entry.id),
      );
      let next: ConsoleState = {
        ...state,
        usage: frame.usage
          ? (object(frame.usage) as unknown as ConsoleState['usage'])
          : null,
        subUsage: frame.subUsage ? object(frame.subUsage) : null,
        meta: frame.meta ? object(frame.meta) : null,
        rooms: array<RoomFact>(frame.rooms),
        participants: number(frame.participants),
        messages:
          sameProcess && overlaps
            ? mergeMessages(state.messages, incoming)
            : incoming,
        hasMore:
          sameProcess && overlaps ? state.hasMore : frame.hasMore === true,
        loadingHistory: false,
        snapshotVersion: state.snapshotVersion + 1,
        context: null,
        mindDetail: null,
        workerDetail: null,
        live: frame.stream
          ? (object(frame.stream) as unknown as LiveStream)
          : null,
        logs: array<LogLine>(frame.logs),
        workers: controlSnapshot(frame.workers),
        secretary: controlSnapshot(frame.secretary),
      };
      next = mindSnapshot(next, frame.mind);
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
        messages: mergeMessages(state.messages, [
          object(frame.msg) as unknown as StreamEntry,
        ]),
        live: object(frame.msg).role === 'assistant' ? null : state.live,
      };
    case 'history':
      return {
        ...state,
        messages: mergeMessages(
          state.messages,
          array<StreamEntry>(frame.messages),
        ),
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
      return state.live?.streamId === number(frame.streamId)
        ? { ...state, live: null }
        : state;
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
      return object(frame.item).id === state.selectedMindId
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
        if (frame.op === 'status') {
          if (
            !workerMatches(
              object(frame.result).session,
              state.selectedWorkerRef,
            )
          )
            return state;
          return {
            ...state,
            workerDetail: workerDetailFromControl(frame.result),
            notice: null,
          };
        }
        if (frame.op === 'start' || frame.op === 'followup') {
          const result = object(frame.result);
          const session =
            frame.op === 'followup' ? object(result.session) : result;
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
            workerDetail:
              state.workerDetail &&
              state.workerDetail.id === object(frame.result).sessionId
                ? {
                    ...state.workerDetail,
                    messages: [
                      ...new Map(
                        [
                          ...array<JsonObject>(state.workerDetail.messages),
                          object(frame.result),
                        ].map((message) => [message.id, message]),
                      ).values(),
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

export function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.value, loadingHistory: false };
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
        mindDetail:
          action.id === state.selectedMindId ? state.mindDetail : null,
        mindOrigin: action.id ? action.origin : null,
      };
    case 'select-worker':
      return {
        ...state,
        selectedWorkerRef: action.ref,
        workerDetail:
          action.ref === state.selectedWorkerRef ? state.workerDetail : null,
      };
    case 'select-secretary':
      return { ...state, selectedSecretaryId: action.id };
    case 'notice':
      return { ...state, notice: action.value };
  }
}

export interface ConsoleViewPreferences {
  read(): string | null;
  write(view: ViewName): void;
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
  selectMind(id: string | null, origin?: MindOrigin | null): void;
  selectWorker(ref: string | null): void;
  selectSecretary(id: string | null): void;
  clearNotice(): void;
}

function readRequestKey(frame: JsonObject): string | null {
  if (frame.t === 'context') return 'context';
  if (frame.t === 'mindDetail' || (frame.t === 'mind' && frame.op === 'get'))
    return 'mind:get';
  if (
    frame.t === 'mindSnapshot' ||
    (frame.t === 'mind' && frame.op === 'snapshot')
  )
    return 'mind:snapshot';
  if (
    (frame.t === 'control' || frame.t === 'controlResult') &&
    ['snapshot', 'list', 'status'].includes(text(frame.op))
  )
    return `${text(frame.lane)}:${text(frame.op)}`;
  return null;
}

export function useConsole(
  transport: ConsoleTransport,
  preferences?: ConsoleViewPreferences,
): [ConsoleState, ConsoleActions] {
  const [state, dispatch] = useReducer(
    reducer,
    initialState,
    (base): ConsoleState => {
      let stored: string | null = null;
      try {
        stored = preferences?.read() ?? null;
      } catch {}
      return {
        ...base,
        view: VIEWS.includes(stored as ViewName)
          ? (stored as ViewName)
          : 'thread',
      };
    },
  );
  const requestId = useRef(0);
  const pendingReads = useRef(new Map<string, number>());
  const stateRef = useRef(state);
  stateRef.current = state;

  const send = useCallback(
    (frame: JsonObject): boolean => {
      const key = readRequestKey(frame);
      if (key) pendingReads.current.set(key, number(frame.reqId));
      if (transport.send(frame)) return true;
      if (key) pendingReads.current.delete(key);
      dispatch({ type: 'notice', value: 'Backend is not connected.' });
      return false;
    },
    [transport],
  );

  useEffect(() => {
    const unsubscribe = transport.subscribe((event: ConsoleTransportEvent) => {
      if (event.type === 'connection') {
        if (event.value !== 'connected') pendingReads.current.clear();
        dispatch({ type: 'connection', value: event.value });
        return;
      }
      if (event.type === 'malformed') {
        dispatch({
          type: 'notice',
          value: 'Ignored a malformed console frame.',
        });
        return;
      }

      const frame = event.frame;
      const key = readRequestKey(frame);
      if (key && pendingReads.current.get(key) !== frame.reqId) return;
      if (key) pendingReads.current.delete(key);
      if (frame.t === 'snapshot') pendingReads.current.clear();
      if (frame.t === 'sync') {
        if ('context' in frame) pendingReads.current.delete('context');
        if ('mindDetail' in frame) pendingReads.current.delete('mind:get');
        if ('workerDetail' in frame)
          pendingReads.current.delete('worker:status');
        if ('mind' in frame) pendingReads.current.delete('mind:snapshot');
        for (const lane of ['worker', 'secretary']) {
          if ((lane === 'worker' ? 'workers' : 'secretary') in frame) {
            pendingReads.current.delete(`${lane}:snapshot`);
            pendingReads.current.delete(`${lane}:list`);
          }
        }
      }
      dispatch({ type: 'frame', frame });
    });
    return unsubscribe;
  }, [send, transport]);

  useEffect(() => {
    if (state.connection !== 'connected') return;
    send({
      t: 'watch',
      workerRef: state.view === 'workers' ? state.selectedWorkerRef : null,
      mindId: state.view === 'mind' ? state.selectedMindId : null,
      context: state.view === 'context',
    });
    if (state.view === 'context') {
      const reqId = ++requestId.current;
      dispatch({ type: 'context-request', reqId });
      send({ t: 'context', reqId });
    }
  }, [
    send,
    state.connection,
    state.view,
    state.selectedWorkerRef,
    state.selectedMindId,
    state.snapshotVersion,
  ]);

  const setView = useCallback(
    (view: ViewName) => {
      try {
        preferences?.write(view);
      } catch {}
      dispatch({ type: 'view', value: view });
    },
    [preferences],
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
    selectMind: (id, origin = null) => {
      dispatch({ type: 'select-mind', id, origin });
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
