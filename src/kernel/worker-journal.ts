import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "../llm/llm.js";

export type WorkerToolCall = NonNullable<ChatMessage["tool_calls"]>[number];

interface PreparedTool {
  call: WorkerToolCall;
  preparedAt: number;
}

export interface WorkerJournalState {
  messages: ChatMessage[];
  guidanceIds: Set<number>;
  pendingTools: Map<string, PreparedTool>;
  pendingFinish: { key: string; body: string } | null;
  finished: { key: string; body: string } | null;
}

type WorkerJournalRecord =
  | { type: "initialized"; messages: ChatMessage[] }
  | { type: "message"; message: ChatMessage }
  | { type: "guidance"; id: number; message: ChatMessage }
  | { type: "tool_prepared"; call: WorkerToolCall; preparedAt: number }
  | { type: "tool_completed"; callId: string; message: ChatMessage }
  | { type: "finish_prepared"; key: string; body: string }
  | { type: "finished"; key: string; body: string };

function record(value: unknown, line: number): WorkerJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`worker journal line ${line} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== "string") {
    throw new Error(`worker journal line ${line} has no record type`);
  }
  return candidate as unknown as WorkerJournalRecord;
}

function reduce(records: WorkerJournalRecord[]): WorkerJournalState {
  const state: WorkerJournalState = {
    messages: [],
    guidanceIds: new Set(),
    pendingTools: new Map(),
    pendingFinish: null,
    finished: null,
  };
  for (const entry of records) {
    switch (entry.type) {
      case "initialized":
        if (state.messages.length > 0 || entry.messages.length === 0) {
          throw new Error("worker journal contains invalid initialization");
        }
        state.messages.push(...entry.messages);
        break;
      case "message":
        state.messages.push(entry.message);
        break;
      case "guidance":
        if (!Number.isSafeInteger(entry.id) || entry.id <= 0) {
          throw new Error("worker journal contains an invalid guidance id");
        }
        if (!state.guidanceIds.has(entry.id)) {
          state.guidanceIds.add(entry.id);
          state.messages.push(entry.message);
        }
        break;
      case "tool_prepared":
        if (state.pendingTools.has(entry.call.id)) {
          throw new Error(
            `worker journal prepared tool ${entry.call.id} twice`,
          );
        }
        state.pendingTools.set(entry.call.id, {
          call: entry.call,
          preparedAt: entry.preparedAt,
        });
        break;
      case "tool_completed":
        if (!state.pendingTools.delete(entry.callId)) {
          throw new Error(
            `worker journal completed unprepared tool ${entry.callId}`,
          );
        }
        state.messages.push(entry.message);
        break;
      case "finish_prepared":
        if (
          state.pendingFinish &&
          (state.pendingFinish.key !== entry.key ||
            state.pendingFinish.body !== entry.body)
        ) {
          throw new Error(
            "worker journal contains conflicting prepared finishes",
          );
        }
        state.pendingFinish = { key: entry.key, body: entry.body };
        break;
      case "finished":
        if (
          !state.pendingFinish ||
          state.pendingFinish.key !== entry.key ||
          state.pendingFinish.body !== entry.body
        ) {
          throw new Error("worker journal completed an unprepared finish");
        }
        if (
          state.finished &&
          (state.finished.key !== entry.key ||
            state.finished.body !== entry.body)
        ) {
          throw new Error("worker journal contains conflicting finish records");
        }
        state.pendingFinish = null;
        state.finished = { key: entry.key, body: entry.body };
        break;
      default:
        throw new Error(
          `worker journal contains unknown record type ${(entry as { type: string }).type}`,
        );
    }
  }
  return state;
}

export class WorkerJournal {
  private readonly fd: number;
  private readonly current: WorkerJournalState;

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (existing && !existing.endsWith("\n")) {
      throw new Error("worker journal ends with a partial record");
    }
    const records = existing
      .split("\n")
      .filter(Boolean)
      .map((line, index) => record(JSON.parse(line), index + 1));
    this.current = reduce(records);
    this.fd = fs.openSync(file, "a", 0o600);
    fs.chmodSync(file, 0o600);
  }

  state(): WorkerJournalState {
    return {
      messages: [...this.current.messages],
      guidanceIds: new Set(this.current.guidanceIds),
      pendingTools: new Map(this.current.pendingTools),
      pendingFinish: this.current.pendingFinish
        ? { ...this.current.pendingFinish }
        : null,
      finished: this.current.finished ? { ...this.current.finished } : null,
    };
  }

  private append(entry: WorkerJournalRecord): void {
    fs.writeSync(this.fd, `${JSON.stringify(entry)}\n`);
    fs.fdatasyncSync(this.fd);
  }

  initialize(messages: ChatMessage[]): void {
    if (this.current.messages.length > 0 || messages.length === 0) {
      throw new Error("worker journal is already initialized");
    }
    this.append({ type: "initialized", messages });
    this.current.messages.push(...messages);
  }

  appendMessage(message: ChatMessage): void {
    this.append({ type: "message", message });
    this.current.messages.push(message);
  }

  appendGuidance(id: number, message: ChatMessage): boolean {
    if (this.current.guidanceIds.has(id)) return false;
    this.append({ type: "guidance", id, message });
    this.current.guidanceIds.add(id);
    this.current.messages.push(message);
    return true;
  }

  prepareTool(call: WorkerToolCall): void {
    if (this.current.pendingTools.has(call.id)) {
      throw new Error(`worker tool ${call.id} is already prepared`);
    }
    const preparedAt = this.now();
    this.append({ type: "tool_prepared", call, preparedAt });
    this.current.pendingTools.set(call.id, { call, preparedAt });
  }

  completeTool(callId: string, message: ChatMessage): void {
    if (!this.current.pendingTools.has(callId)) {
      throw new Error(`worker tool ${callId} was not prepared`);
    }
    this.append({ type: "tool_completed", callId, message });
    this.current.pendingTools.delete(callId);
    this.current.messages.push(message);
  }

  prepareFinish(key: string, body: string): void {
    if (this.current.finished) {
      if (
        this.current.finished.key !== key ||
        this.current.finished.body !== body
      ) {
        throw new Error("worker episode already finished differently");
      }
      return;
    }
    if (this.current.pendingFinish) {
      if (
        this.current.pendingFinish.key !== key ||
        this.current.pendingFinish.body !== body
      ) {
        throw new Error("worker episode has a different prepared finish");
      }
      return;
    }
    this.append({ type: "finish_prepared", key, body });
    this.current.pendingFinish = { key, body };
  }

  completeFinish(key: string, body: string): void {
    if (
      !this.current.pendingFinish ||
      this.current.pendingFinish.key !== key ||
      this.current.pendingFinish.body !== body
    ) {
      throw new Error("worker finish was not prepared");
    }
    this.append({ type: "finished", key, body });
    this.current.pendingFinish = null;
    this.current.finished = { key, body };
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
