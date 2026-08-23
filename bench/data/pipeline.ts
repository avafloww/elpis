import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { ChatMessage } from '../../src/llm/llm.js';
import { SCHEMA_VERSION, episodeSchema, type Episode } from '../schema.js';
import { TOOL_CONTRACT_VERSION } from '../../src/llm/provenance.js';
import type { IndexedTurn, TranscriptIndex } from './index.js';
import { qualifiesForModelSpecificMining } from './epochs.js';

export function extractEpisodes(index: TranscriptIndex): {
  accepted: Episode[];
  rejected: { id: string; reason: string }[];
} {
  const accepted: Episode[] = [],
    rejected: { id: string; reason: string }[] = [];
  for (const turn of index.turns) {
    const reason = eligibilityReason(turn);
    if (reason) {
      rejected.push({ id: turn.id, reason });
      continue;
    }
    const messages = turn.messages.map(exportMessage);
    accepted.push(
      episodeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: turn.id,
        source: 'private-real',
        task: messages.find((m) => m.role === 'user')?.content ?? '',
        messages,
        provenance: turn.messages.flatMap((m) =>
          m.provenance ? [m.provenance] : [],
        ),
        attributionConfidence: turn.attributionConfidence,
        toolContractVersion: turn.toolContractVersion ?? TOOL_CONTRACT_VERSION,
        accepted: false,
        review: { status: 'pending' },
      }),
    );
  }
  return { accepted, rejected };
}
function eligibilityReason(turn: IndexedTurn): string | undefined {
  if (!turn.valid) return turn.rejection ?? 'invalid trajectory';
  if (!qualifiesForModelSpecificMining(turn.attributionConfidence))
    return 'model attribution is not exact/high';
  if (
    turn.toolContractVersion &&
    turn.toolContractVersion !== TOOL_CONTRACT_VERSION
  )
    return 'legacy/incompatible tool contract requires replay or repair';
  return undefined;
}
function exportMessage(message: ChatMessage): Episode['messages'][number] {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: {
              name: call.function.name,
              arguments: parseArgs(call.function.arguments),
            },
          })),
        }
      : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  };
}
function parseArgs(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('tool arguments must be an object');
  return parsed as Record<string, unknown>;
}
export function splitEpisodes(episodes: readonly Episode[]): Episode[] {
  return episodes.map((episode) => {
    const n =
      createHash('sha256').update(episode.id).digest().readUInt32BE(0) % 100;
    return {
      ...episode,
      split: n < 90 ? 'train' : n < 95 ? 'validation' : 'test',
    };
  });
}

export function preferenceMutations(
  episode: Episode,
): { chosen: Episode; rejected: Episode; mutation: string }[] {
  const mutations: {
    name: string;
    apply: (messages: Episode['messages']) => Episode['messages'];
  }[] = [
    {
      name: 'missing-end',
      apply: (messages) =>
        messages.map((m) =>
          m.role === 'assistant' && m.tool_calls
            ? {
                ...m,
                tool_calls: m.tool_calls.map((c) => ({
                  ...c,
                  function: {
                    ...c.function,
                    arguments: { ...c.function.arguments, end: false },
                  },
                })),
              }
            : m,
        ),
    },
    {
      name: 'surplus-dispatch',
      apply: (messages) => [
        ...messages,
        { role: 'assistant', content: 'I will keep checking.' },
      ],
    },
    {
      name: 'premature-claim',
      apply: (messages) => [
        { role: 'assistant', content: 'Done.' },
        ...messages,
      ],
    },
    {
      name: 'ask-user-to-act',
      apply: (messages) => [
        {
          role: 'assistant',
          content:
            'Could you run the available command and tell me what it says?',
        },
        ...messages,
      ],
    },
    {
      name: 'excessive-prose',
      apply: (messages) =>
        messages.map((m) =>
          m.role === 'assistant'
            ? {
                ...m,
                content: `${String(m.content)}\n\nHere is a lengthy status narration about every step I considered before acting.`,
              }
            : m,
        ),
    },
    {
      name: 'unchanged-retry',
      apply: (messages) => {
        const call = messages.find(
          (m) => m.role === 'assistant' && m.tool_calls,
        )?.tool_calls?.[0];
        return call
          ? [
              ...messages,
              { role: 'assistant', content: '', tool_calls: [call] },
            ]
          : messages;
      },
    },
    {
      name: 'wrong-channel-claim',
      apply: (messages) => [
        { role: 'assistant', content: 'Delivered this in the other channel.' },
        ...messages,
      ],
    },
  ];
  return mutations.map((m) => ({
    chosen: episode,
    rejected: {
      ...episode,
      id: `${episode.id}:${randomUUID()}`,
      messages: m.apply(episode.messages),
      accepted: false,
    },
    mutation: m.name,
  }));
}
export function readJsonl<T>(file: string): T[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
export function writeJsonl(file: string, rows: readonly unknown[]): void {
  fs.writeFileSync(
    file,
    rows.map((row) => JSON.stringify(row)).join('\n') +
      (rows.length ? '\n' : ''),
    { mode: 0o600 },
  );
}
