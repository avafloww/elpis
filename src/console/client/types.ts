export type ConnectionState =
  'connecting' | 'connected' | 'reconnecting' | 'unavailable';
export type ViewName =
  'thread' | 'context' | 'mind' | 'workers' | 'secretary' | 'logs';
export type JsonObject = Record<string, unknown>;

export interface RoomFact {
  id: string;
  name: string;
  count: number;
  color?: string;
  group?: string;
  guildSlug?: string;
}

export interface UsageInfo {
  current: number;
  window: number;
  trigger: number;
  triggerRatio: number;
  ratio: number;
  prompt?: number;
  completion?: number;
  cache?: JsonObject;
}

export interface MetaInfo {
  gitHash?: string;
  treeClean?: boolean;
  uptimeMs?: number;
  model?: string;
  botTag?: string;
}

export interface StreamEntry {
  id: number;
  kind: string;
  role: string;
  channel: string;
  content: string;
  reasoning_content?: string;
  author?: string;
  eventKind?:
    'person' | 'harness' | 'watch' | 'background' | 'restart' | 'memory';
  displayName?: string;
  frameUrl?: string;
  ts?: number | null;
  toolCalls?: Array<{
    id: string;
    code: string;
    detail?: string;
    display?: {
      code: string;
      heredocs: Array<{ token: string; source: string }>;
    };
    operations?: Array<{
      kind: 'edit' | 'mind' | 'shell' | 'file' | 'git' | 'computer';
      name: string;
      target: string;
      targetLiteral?: boolean;
      args?: string[];
      before?: string;
      after?: string;
    }>;
  }>;
  tool_call_id?: string;
  sends?: Array<{ channel: string; text: string }>;
  run?: JsonObject;
  replaced?: number;
  rewritten?: number;
  count?: number;
}

export interface LogLine {
  ts?: number;
  level?: string;
  msg?: string;
  message?: string;
}

export interface LiveStream {
  streamId: number;
  channel: string;
  content: string;
  reasoning: string;
}

export interface MindItem extends JsonObject {
  id: string;
  title: string;
  body: string;
  kind: string;
  status: string;
  effectiveStatus?: string;
  priority: number;
  parentId?: string | null;
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number | null;
  dueAt?: number | null;
  blockedBy?: Array<{ id: string; title?: string }>;
  dependencies?: Array<{
    id: string;
    title?: string;
    effectiveStatus?: string;
  }>;
  children?: Array<{ id: string; title?: string }>;
  comments?: Array<JsonObject>;
  reminders?: Array<JsonObject>;
}

export interface ControlSnapshot extends JsonObject {
  available: boolean;
  sessions: JsonObject[];
  error?: string;
}

export interface ConsoleState {
  connection: ConnectionState;
  view: ViewName;
  room: string;
  rooms: RoomFact[];
  participants: number;
  usage: UsageInfo | null;
  subUsage: JsonObject | null;
  meta: MetaInfo | null;
  messages: StreamEntry[];
  hasMore: boolean;
  loadingHistory: boolean;
  live: LiveStream | null;
  logs: LogLine[];
  context: JsonObject | null;
  contextReqId: number;
  mindAvailable: boolean;
  mindItems: MindItem[];
  mindStats: JsonObject | null;
  mindDetail: MindItem | null;
  selectedMindId: string | null;
  workers: ControlSnapshot;
  secretary: ControlSnapshot;
  selectedWorkerRef: string | null;
  workerDetail?: JsonObject | null;
  selectedSecretaryId: string | null;
  notice: string | null;
}

export type ServerFrame = JsonObject & { t: string };

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function array<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
