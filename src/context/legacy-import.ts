import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ContextGraphStore,
  branchId,
  capsuleId,
  legacyImportReceiptId,
  type LegacyImportReceipt,
} from '../store/context-graph.js';

export interface LegacyArtifactReceipt {
  artifactId: string;
  sourcePath: string;
  artifactPath: string;
  sha256: string;
  sizeBytes: number;
}

export interface LegacyGraphImportReceipt {
  artifact: LegacyArtifactReceipt;
  graph: LegacyImportReceipt;
}

function hashFile(filePath: string): { sha256: string; sizeBytes: number } {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('legacy context source must be a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sizeBytes = 0;
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      sizeBytes += read;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== stats.size || sizeBytes !== after.size) {
      throw new Error('legacy context source changed during import');
    }
    return { sha256: hash.digest('hex'), sizeBytes };
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyArtifact(
  artifactPath: string,
  expected: { sha256: string; sizeBytes: number },
): void {
  const actual = hashFile(artifactPath);
  if (
    actual.sha256 !== expected.sha256 ||
    actual.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error('legacy context artifact conflicts with its content address');
  }
  fs.chmodSync(artifactPath, 0o600);
}

export function preserveLegacyTranscript(
  sourcePath: string,
  contextRoot: string,
): LegacyArtifactReceipt {
  const source = path.resolve(sourcePath);
  const sourceStats = fs.lstatSync(source);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new Error('legacy context source must be a regular non-symlink file');
  }
  const expected = hashFile(source);
  const graphRoot = path.resolve(contextRoot);
  fs.mkdirSync(graphRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(graphRoot, 0o700);
  const legacyRoot = path.join(graphRoot, 'legacy');
  fs.mkdirSync(legacyRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(legacyRoot, 0o700);
  const artifactPath = path.join(legacyRoot, `${expected.sha256}.jsonl`);
  if (fs.existsSync(artifactPath)) {
    const artifactStats = fs.lstatSync(artifactPath);
    if (artifactStats.isSymbolicLink() || !artifactStats.isFile()) {
      throw new Error('legacy context artifact path is not a regular file');
    }
    verifyArtifact(artifactPath, expected);
  } else {
    const temporary = path.join(
      legacyRoot,
      `.${expected.sha256}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, 0o600);
      verifyArtifact(temporary, expected);
      try {
        fs.linkSync(temporary, artifactPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        verifyArtifact(artifactPath, expected);
      }
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* preserve the import result or original error */
      }
    }
  }
  return Object.freeze({
    artifactId: `legacy:${expected.sha256}`,
    sourcePath: source,
    artifactPath,
    sha256: expected.sha256,
    sizeBytes: expected.sizeBytes,
  });
}

export function importLegacyTranscriptIntoGraph(input: {
  sourcePath: string;
  contextRoot: string;
  store: ContextGraphStore;
  importedAt: number;
}): LegacyGraphImportReceipt {
  const artifact = preserveLegacyTranscript(input.sourcePath, input.contextRoot);
  const graph = input.store.importLegacyArtifact({
    receiptId: legacyImportReceiptId(`legacy-import:${artifact.sha256}`),
    sourceRef: `transcript:main:sha256:${artifact.sha256}`,
    sourceHash: artifact.sha256,
    sourceSize: artifact.sizeBytes,
    artifactRef: artifact.artifactId,
    importGeneration: 1,
    branchId: branchId(`branch:legacy:${artifact.sha256}`),
    capsuleId: capsuleId(`capsule:legacy:${artifact.sha256}`),
    importedAt: input.importedAt,
  });
  return Object.freeze({ artifact, graph });
}
