import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkerWorkspaceRequestError,
  dispatchWorkerWorkspaceRequest,
  type WorkerWorkspaceService,
} from '../src/worker/workspace-request.js';

const binding = {
  sessionId: 'wrk-a1b2c3d4',
  worker: 'worker:quiet-otter',
  modelRef: 'provider/model',
  mindId: 'elm-a1b2c3d4',
  runtime: 'kubernetes' as const,
};

test('workspace request protocol serves bound source and strips host artifact paths', () => {
  const calls: unknown[] = [];
  const sourceData = Buffer.from('source archive');
  const service: WorkerWorkspaceService = {
    sourceForWorker(token) {
      calls.push({ operation: 'source', token });
      return {
        binding,
        revision: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
        sizeBytes: sourceData.length,
        data: sourceData,
      };
    },
    putArtifactForWorker(input) {
      calls.push({ operation: 'put', ...input, data: input.data.toString() });
      return {
        id: 7,
        sessionId: binding.sessionId,
        key: input.key,
        kind: input.kind,
        sourceSha256: input.sourceSha256,
        sha256: input.sha256!,
        sizeBytes: input.data.length,
        relativePath: 'artifacts/opaque/host/path',
        createdAt: 1234,
      };
    },
  };
  const source = dispatchWorkerWorkspaceRequest(service, 'token', {
    protocol: 1,
    operation: 'source',
  }) as any;
  assert.equal(source.binding.sessionId, binding.sessionId);
  assert.equal(source.source.data, sourceData.toString('base64'));
  const artifact = dispatchWorkerWorkspaceRequest(service, 'token', {
    protocol: 1,
    operation: 'put_artifact',
    key: 'workspace.patch.gz',
    kind: 'unified_patch_gzip',
    sourceSha256: 'b'.repeat(64),
    sha256: 'c'.repeat(64),
    data: Buffer.from('patch').toString('base64'),
  }) as any;
  assert.equal(artifact.artifact.sessionId, binding.sessionId);
  assert.equal(Object.hasOwn(artifact.artifact, 'relativePath'), false);
  assert.equal(Object.hasOwn(artifact.artifact, 'id'), false);
  assert.equal(calls.length, 2);
});

test('workspace request protocol rejects spoofable fields and malformed base64', () => {
  const service = {
    sourceForWorker() {
      return null;
    },
    putArtifactForWorker() {
      throw new Error('must not call');
    },
  } satisfies WorkerWorkspaceService;
  assert.throws(
    () =>
      dispatchWorkerWorkspaceRequest(service, 'token', {
        protocol: 1,
        operation: 'source',
        sessionId: 'wrk-spoofed',
      }),
    (error: unknown) =>
      error instanceof WorkerWorkspaceRequestError &&
      /unknown request field/.test(error.message),
  );
  assert.throws(
    () =>
      dispatchWorkerWorkspaceRequest(service, 'token', {
        protocol: 1,
        operation: 'put_artifact',
        key: 'workspace.patch.gz',
        kind: 'unified_patch_gzip',
        sourceSha256: 'b'.repeat(64),
        sha256: 'c'.repeat(64),
        data: 'not base64',
      }),
    (error: unknown) =>
      error instanceof WorkerWorkspaceRequestError &&
      /canonical base64/.test(error.message),
  );
});
