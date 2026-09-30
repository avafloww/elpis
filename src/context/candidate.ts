import { createHash } from 'node:crypto';

import type { ChatMessage } from '../llm/llm.js';
import type { LocalBranchRequestViewId } from '../store/context-graph.js';

export const MAX_LOCAL_BRANCH_REQUEST_CANDIDATE_BYTES = 8 * 1024 * 1024;

export interface MaterializedLocalBranchRequest {
  readonly requestViewId: LocalBranchRequestViewId;
  readonly messages: readonly ChatMessage[];
  readonly candidateJson: string;
  readonly candidateHash: string;
  readonly candidateBytes: number;
  readonly executionMode: 'dark';
  readonly scope: 'local-only';
  readonly runnable: false;
  readonly toolMode: 'none';
}

export function assertLocalBranchRequestContentFits(
  contents: readonly string[],
): void {
  let bytes = 0;
  for (const content of contents) {
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_LOCAL_BRANCH_REQUEST_CANDIDATE_BYTES) {
      throw new Error('local branch request candidate exceeds byte limit');
    }
  }
}

export function buildMaterializedLocalBranchRequest(input: {
  requestViewId: LocalBranchRequestViewId;
  messages: readonly ChatMessage[];
}): MaterializedLocalBranchRequest {
  assertLocalBranchRequestContentFits(input.messages.map((message) => message.content));
  const messages = input.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const candidateJson = JSON.stringify({
    schemaVersion: 1,
    surface: 'provider-neutral-messages',
    messages,
  });
  const candidateBytes = Buffer.byteLength(candidateJson);
  if (candidateBytes > MAX_LOCAL_BRANCH_REQUEST_CANDIDATE_BYTES) {
    throw new Error('local branch request candidate exceeds byte limit');
  }
  return {
    requestViewId: input.requestViewId,
    messages,
    candidateJson,
    candidateHash: createHash('sha256').update(candidateJson).digest('hex'),
    candidateBytes,
    executionMode: 'dark',
    scope: 'local-only',
    runnable: false,
    toolMode: 'none',
  };
}
