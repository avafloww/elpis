import { parseRunMessageMetadata, type RunMessageMetadata } from '../src/sandbox/metadata.js';
import { SCHEMA_VERSION, type TraceEvent, type TraceMetrics } from './schema.js';

export function runResultTraceData(raw: unknown, content: string): { ok: boolean; data: Record<string, unknown> } {
  const metadata = parseRunMessageMetadata(raw);
  return {
    ok: metadata?.ok ?? /^\[run ok/m.test(content),
    data: {
      blocked: /\bblocked\b/i.test(content),
      ...(metadata?.wake ? { wake: metadata.wake } : {}),
    },
  };
}

export class TraceRecorder {
  private readonly events: TraceEvent[];
  private seq: number;
  constructor(initial: readonly TraceEvent[] = []) { this.events = initial.map((e) => ({ ...e })); this.seq = this.events.reduce((n, e) => Math.max(n, e.seq + 1), 0); }
  add(event: Omit<TraceEvent, 'schemaVersion' | 'seq' | 'at'> & { at?: string }): TraceEvent {
    const { at, ...rest } = event;
    const recorded = { schemaVersion: SCHEMA_VERSION, seq: this.seq++, at: at ?? new Date().toISOString(), ...rest } as TraceEvent;
    this.events.push(recorded);
    return recorded;
  }
  snapshot(): TraceEvent[] { return this.events.map((e) => ({ ...e, data: e.data ? { ...e.data } : undefined })); }
}

function normalizedWork(event: TraceEvent): string | null {
  if (event.kind !== 'tool-call') return null;
  return JSON.stringify({ code: event.code?.trim().replace(/\s+/g, ' ') });
}

export function traceMetrics(events: readonly TraceEvent[], idealDispatches = 1): TraceMetrics {
  let firstUseful: number | null = null;
  let outcomeSeq: number | null = null;
  let malformedCalls = 0, failedCalls = 0, blockedCalls = 0, nonTerminalCalls = 0;
  let failedTerminalFlags = 0, emptyTerminalCalls = 0, duplicateWork = 0;
  const work = new Set<string>();
  for (const e of events) {
    if (firstUseful === null && (e.kind === 'send' || (e.kind === 'tool-result' && e.ok))) firstUseful = e.seq;
    if (e.kind === 'outcome' && e.ok && outcomeSeq === null) outcomeSeq = e.seq;
    if (e.kind === 'tool-call') {
      if (e.data?.malformed === true) malformedCalls++;
      if (e.end !== true) nonTerminalCalls++;
      if (e.end === true && !(e.code ?? '').trim()) emptyTerminalCalls++;
      const key = normalizedWork(e);
      if (key && work.has(key)) duplicateWork++; else if (key) work.add(key);
    }
    if (e.kind === 'tool-result' && e.ok === false) {
      failedCalls++;
      if (e.data?.blocked === true) blockedCalls++;
      if (e.end === true) failedTerminalFlags++;
    }
  }
  const dispatchCount = events.filter((e) => e.kind === 'dispatch').length;
  const naturalTurns = events.filter((e) => e.kind === 'natural-turn').length;
  // A later successful terminal call does not erase an earlier omitted flag:
  // that omission consumed a surplus model turn and is part of the trajectory.
  const missingTerminalFlags = nonTerminalCalls;
  return {
    naturalTurns, dispatchCount, usefulActionLatency: firstUseful,
    malformedCalls, failedCalls, blockedCalls,
    unchangedRetries: events.filter((e) => e.kind === 'tool-result' && e.data?.unchanged === true).length,
    missingTerminalFlags, failedTerminalFlags, emptyTerminalCalls,
    postOutcomeDispatches: outcomeSeq === null ? 0 : events.filter((e) => e.kind === 'dispatch' && e.seq > outcomeSeq!).length,
    duplicateWork, sendsPerRun: events.filter((e) => e.kind === 'send').length,
    surplusModelTurns: Math.max(0, dispatchCount - idealDispatches),
  };
}

export function successfulTerminalEnd(events: readonly TraceEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'tool-result') return e.ok === true && e.end === true;
  }
  return false;
}
