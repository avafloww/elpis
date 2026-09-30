import { SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1 } from './scoped-system.js';
import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import { preview } from '../sandbox/preview.js';
import {
  ContextGraphStore,
  type ResidentSourceInspectionCaptureV1,
} from '../store/context-graph.js';
import { readPromptFacingSoulSnapshot } from '../store/soul.js';

function previewIsExact(value: string, maxBytes: number): boolean {
  return (
    preview(value, maxBytes) === `string(${value.length} chars):\n${value}`
  );
}

function prefixEnd(bytes: Buffer, targetBytes: number): number {
  let end = Math.min(bytes.length, Math.max(0, targetBytes));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

function tailStart(bytes: Buffer, targetBytes: number): number {
  let start = Math.max(0, bytes.length - Math.max(0, targetBytes));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return start;
}

function renderPresentation(
  capture: ResidentSourceInspectionCaptureV1,
  bodyView: string,
  status: 'complete' | 'incomplete',
): string {
  const { candidate, soul } = capture;
  return [
    'CANDIDATE ONLY — NOT AUTHORIZED',
    `inspection_status: ${status}`,
    `scope_kind: ${candidate.scopeKind}`,
    `execution_context: ${candidate.executionContext}`,
    `candidate_id: ${candidate.candidateId}`,
    `soul_snapshot_id: ${soul.snapshotId}`,
    `inspection_batch_id: ${candidate.inspectBatchId}`,
    `inspection_batch_sha256: ${candidate.inspectBatchSha256}`,
    `inspection_call: ${candidate.inspectCallIndex}/${candidate.inspectCallCount}`,
    `inspection_arguments_sha256: ${candidate.inspectArgumentsSha256}`,
    `contract_artifact_id: ${candidate.contractArtifactId}`,
    `contract_content_hash: ${candidate.contractContentHash}`,
    `contract_content_bytes: ${candidate.contractContentBytes}`,
    `soul_source_hash: ${soul.sourceFileHash}`,
    `soul_source_bytes: ${soul.sourceFileBytes}`,
    `soul_body_hash: ${soul.bodyHash}`,
    `soul_body_bytes: ${soul.bodyBytes}`,
    '',
    'SCOPED_RUNTIME_CONTRACT_BEGIN',
    SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.content,
    'SCOPED_RUNTIME_CONTRACT_END',
    '',
    'PROMPT_FACING_SOUL_BODY_BEGIN',
    bodyView,
    'PROMPT_FACING_SOUL_BODY_END',
    '',
    'Authorization does not exist in this action.',
    'Any future authorization must occur in a later assistant tool batch with a different batch ID.',
  ].join('\n');
}

export function formatResidentSourceInspectionPresentation(
  capture: ResidentSourceInspectionCaptureV1,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error('resident source inspection preview budget is invalid');

  const complete = renderPresentation(capture, capture.soul.body, 'complete');
  if (previewIsExact(complete, maxBytes)) return complete;

  const bodyBytes = Buffer.from(capture.soul.body, 'utf8');
  let low = 0;
  let high = Math.max(0, bodyBytes.length - 1);
  let best: string | null = null;
  while (low <= high) {
    const shownBytes = Math.floor((low + high) / 2);
    const headTarget = Math.ceil((shownBytes * 2) / 3);
    const tailTarget = shownBytes - headTarget;
    const headEnd = prefixEnd(bodyBytes, headTarget);
    const start = tailStart(bodyBytes, tailTarget);
    const tail = Math.max(headEnd, start);
    const bodyView =
      bodyBytes.subarray(0, headEnd).toString('utf8') +
      `\nSOUL_BODY_OMITTED_BYTES [${headEnd},${tail})\n` +
      bodyBytes.subarray(tail).toString('utf8');
    const candidate = renderPresentation(capture, bodyView, 'incomplete');
    if (previewIsExact(candidate, maxBytes)) {
      best = candidate;
      low = shownBytes + 1;
    } else {
      high = shownBytes - 1;
    }
  }
  if (!best)
    throw new Error(
      'resident source inspection preview budget cannot present exact candidate metadata',
    );
  return best;
}

export interface ResidentSourceInspectionRecorderOptions {
  store: ContextGraphStore;
  soulPath: string;
  previewMaxBytes: number;
  redactForOutput: (text: string) => string;
  now?: () => number;
}

export function createResidentSourceInspectionRecorder(
  options: ResidentSourceInspectionRecorderOptions,
): (provenance: ResidentToolCallSnapshotV1) => string {
  const now = options.now ?? Date.now;
  return (provenance) => {
    if (provenance.toolName !== 'run')
      throw new Error('resident source inspection requires run provenance');
    const soul = readPromptFacingSoulSnapshot(options.soulPath);
    return options.store.createResidentSourceInspectionCandidate(
      { soul, provenance, observedAt: now() },
      (capture) => {
        const presentation = formatResidentSourceInspectionPresentation(
          capture,
          options.previewMaxBytes,
        );
        if (options.redactForOutput(presentation) !== presentation) {
          throw new Error(
            'resident source inspection cannot present exact candidate because secret redaction would alter it',
          );
        }
        return presentation;
      },
    );
  };
}
