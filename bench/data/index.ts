import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTranscriptFile } from '../../src/store/sessions.js';
import type { ChatMessage } from '../../src/llm/llm.js';
import {
  attributeGeneration,
  type AttributionConfidence,
  type ModelEpoch,
} from './epochs.js';
import { TOOL_CONTRACT_VERSION } from '../../src/llm/provenance.js';

export interface IndexedTurn {
  id: string;
  sourceFiles: string[];
  messages: ChatMessage[];
  sends: { channel: string; text: string }[];
  channel?: string;
  wakeType: 'discord' | 'heartbeat' | 'harness' | 'unknown';
  provider?: string;
  model?: string;
  apiSurface?: string;
  apiEndpoint?: string;
  attributionConfidence: AttributionConfidence;
  toolContractVersion?: string;
  valid: boolean;
  rejection?: string;
}
export interface TranscriptIndex {
  version: 1;
  createdAt: string;
  roots: string[];
  turns: IndexedTurn[];
  rejected: number;
  deduplicated: number;
}

function filesBelow(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.name.endsWith('.jsonl')) out.push(p);
    }
  };
  visit(root);
  return out.sort();
}
function observable(message: ChatMessage): ChatMessage {
  const {
    reasoning_content: _r,
    reasoning_items: _ri,
    thinking_blocks: _tb,
    contentParts: _cp,
    ephemeral: _e,
    ...kept
  } = message;
  return kept;
}
function fingerprint(messages: readonly ChatMessage[]): string {
  const normalized = messages.map((m) => ({
    role: m.role,
    content: m.content.trim().replace(/\s+/g, ' '),
    tool_calls: m.tool_calls?.map((c) => ({
      name: c.function.name,
      arguments: normalizeJson(c.function.arguments),
    })),
    tool_call_id: m.tool_call_id,
    sends: m.sends,
  }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
function normalizeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function validateTrajectory(
  messages: readonly ChatMessage[],
): string | undefined {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant')
      for (const call of message.tool_calls ?? []) {
        if (!call.id || pending.has(call.id)) return 'ambiguous tool call id';
        pending.add(call.id);
      }
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id))
        return 'orphan tool result';
    }
  }
  if (pending.size) return 'truncated/interrupted tool trajectory';
  return undefined;
}
function wakeType(message: ChatMessage): IndexedTurn['wakeType'] {
  if (message.channel && !['internal', 'harness'].includes(message.channel))
    return 'discord';
  if (/heartbeat/i.test(message.content)) return 'heartbeat';
  if (message.channel === 'harness' || /\[harness/.test(message.content))
    return 'harness';
  return 'unknown';
}

export function buildTranscriptIndex(
  roots: readonly string[],
  epochs: readonly ModelEpoch[] = [],
): TranscriptIndex {
  const seen = new Map<string, IndexedTurn>();
  let rejected = 0,
    deduplicated = 0;
  for (const root of roots)
    for (const file of filesBelow(path.resolve(root))) {
      const all = parseTranscriptFile(file);
      let turn: ChatMessage[] = [];
      const flush = () => {
        if (!turn.length) return;
        const messages = turn.map(observable);
        turn = [];
        const hash = fingerprint(messages);
        const duplicate = seen.get(hash);
        if (duplicate) {
          duplicate.sourceFiles.push(file);
          deduplicated++;
          return;
        }
        const rejection = validateTrajectory(messages);
        if (rejection) rejected++;
        const assistant = [...messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        const fallbackTime = (() => {
          try {
            return fs.statSync(file).mtime.toISOString();
          } catch {
            return undefined;
          }
        })();
        const attribution = attributeGeneration(
          assistant?.provenance?.generatedAt ?? fallbackTime,
          assistant?.provenance,
          epochs,
        );
        const p = attribution.provenance;
        const e = attribution.epoch;
        const hasCurrentEnd = messages.some(
          (m) =>
            m.role === 'assistant' &&
            m.tool_calls?.some((c) => {
              try {
                return (
                  typeof JSON.parse(c.function.arguments).end === 'boolean'
                );
              } catch {
                return false;
              }
            }),
        );
        seen.set(hash, {
          id: hash,
          sourceFiles: [file],
          messages,
          sends: messages.flatMap((m) => m.sends ?? []),
          channel: messages.find((m) => m.role === 'user')?.channel,
          wakeType: wakeType(messages[0]),
          provider: p?.providerType ?? e?.providerType,
          model: p?.model ?? e?.model,
          apiSurface: p?.apiSurface ?? e?.apiSurface,
          apiEndpoint: p?.apiEndpoint ?? e?.apiEndpoint,
          attributionConfidence: attribution.confidence,
          toolContractVersion:
            p?.toolContractVersion ??
            (hasCurrentEnd ? TOOL_CONTRACT_VERSION : 'legacy-run-no-end'),
          valid: !rejection,
          ...(rejection ? { rejection } : {}),
        });
      };
      for (const message of all) {
        if (
          message.role === 'user' &&
          turn.length &&
          !turn.some((m) => m.role === 'assistant' && m.tool_calls)
        )
          flush();
        turn.push(message);
        if (message.role === 'tool') {
          const assistant = [...turn]
            .reverse()
            .find(
              (m) =>
                m.role === 'assistant' &&
                m.tool_calls?.some((c) => c.id === message.tool_call_id),
            );
          const call = assistant?.tool_calls?.find(
            (c) => c.id === message.tool_call_id,
          );
          try {
            if (
              JSON.parse(call?.function.arguments ?? '{}').end === true &&
              /^\[run ok/m.test(message.content)
            )
              flush();
          } catch {
            /* validator rejects later */
          }
        }
      }
      flush();
    }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    roots: roots.map((r) => path.resolve(r)),
    turns: [...seen.values()],
    rejected,
    deduplicated,
  };
}
