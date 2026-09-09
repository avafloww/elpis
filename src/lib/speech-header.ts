import type { CompleteResult } from '../llm/llm.js';

export interface SpeechHeader {
  target: string;
  replyTo?: string;
  text: string;
}

export function parseSpeechHeader(
  content: string | null | undefined,
): SpeechHeader | null {
  if (typeof content !== 'string') return null;
  const match =
    /^\[send to=([^\s\[\]]+)(?: replyTo=([0-9]{1,20}))?\]\r?\n/u.exec(content);
  if (!match || !/^[a-z0-9][a-z0-9-]*\/[^/\s\[\]]+$/u.test(match[1]))
    return null;
  const text = content.slice(match[0].length);
  if (!text.trim()) return null;
  return {
    target: match[1],
    ...(match[2] === undefined ? {} : { replyTo: match[2] }),
    text,
  };
}

export function eligibleSpeechHeader(
  result: Pick<CompleteResult, 'message' | 'stripped' | 'completionStatus'>,
): SpeechHeader | null {
  if (
    result.message.role !== 'assistant' ||
    result.completionStatus !== 'complete' ||
    result.stripped !== false
  )
    return null;
  return parseSpeechHeader(result.message.content);
}
