import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWorkerControlCredential } from "../src/worker/auth.js";
import {
  WorkerWorkspaceError,
  WorkerWorkspaceStore,
} from "../src/worker/workspace.js";
import { openDatabase } from "../src/store/db.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-workspace-"));
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "custody");
  fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, ".gitignore"),
    "node_modules/\ndist/\n",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "src", "value.ts"),
    "export const value = 1;\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: sourceRoot });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: sourceRoot,
  });
  execFileSync("git", ["add", "."], { cwd: sourceRoot });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: sourceRoot });
  const db = openDatabase(root);
  db.prepare(
    `INSERT INTO mind_items
     (id, title, body, kind, status, priority, parent_id, due_at, created_by, created_at, updated_at, closed_at, archived_at)
     VALUES ('elm-work0001', 'worker task', '', 'task', 'in_progress', 2, NULL, NULL, 'test', 1, 1, NULL, NULL)`,
  ).run();
  const credential = createWorkerControlCredential();
  const store = new WorkerWorkspaceStore({
    db,
    storageRoot,
    sourceRoot,
    maxSourceBytes: 1024 * 1024,
    maxArtifactBytes: 1024 * 1024,
    now: () => 1234,
  });
  return { root, sourceRoot, storageRoot, db, credential, store };
}

function insertSession(
  db: ReturnType<typeof openDatabase>,
  tokenDigest: string,
  source: { revision: string; sha256: string; sizeBytes: number },
) {
  db.prepare(
    `INSERT INTO worker_sessions
     (id, slug, status, model_ref, mind_id, runtime, control_token_digest,
      source_revision, source_sha256, source_bytes, created_at, updated_at)
     VALUES ('wrk-a1b2c3d4', 'careful-cod', 'running', 'provider/model',
      'elm-work0001', 'kubernetes', ?, ?, ?, ?, 1, 1)`,
  ).run(tokenDigest, source.revision, source.sha256, source.sizeBytes);
}

test("workspace source export is exact, private, token-bound, and rejects dirty roots", async () => {
  const f = fixture();
  try {
    const source = await f.store.prepareSource("wrk-a1b2c3d4");
    assert.ok(source);
    assert.match(source.revision, /^[0-9a-f]{40}$/);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    insertSession(f.db, f.credential.digest, source);
    const served = f.store.sourceForWorker(f.credential.token);
    assert.equal(served?.revision, source.revision);
    assert.equal(served?.sha256, source.sha256);
    assert.equal(served?.sizeBytes, served?.data.length);
    const archive = path.join(
      f.storageRoot,
      "sources",
      "wrk-a1b2c3d4",
      "source.tar.gz",
    );
    assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
    assert.throws(
      () => f.store.sourceForWorker("x".repeat(43)),
      (error: unknown) =>
        error instanceof WorkerWorkspaceError && error.code === "unauthorized",
    );
    fs.writeFileSync(path.join(f.sourceRoot, "src", "value.ts"), "changed\n");
    await assert.rejects(
      () => f.store.prepareSource("wrk-b1b2c3d4"),
      (error: unknown) =>
        error instanceof WorkerWorkspaceError && error.code === "conflict",
    );
    assert.equal(
      fs.existsSync(path.join(f.storageRoot, "sources", "wrk-b1b2c3d4")),
      false,
    );
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("artifact custody recomputes receipts, is idempotent, and exposes verified parent paths", async () => {
  const f = fixture();
  try {
    const source = (await f.store.prepareSource("wrk-a1b2c3d4"))!;
    insertSession(f.db, f.credential.digest, source);
    const data = Buffer.from("deterministic patch bytes");
    const first = f.store.putArtifactForWorker({
      token: f.credential.token,
      key: "workspace.patch.gz",
      kind: "unified_patch_gzip",
      sourceSha256: source.sha256,
      data,
    });
    const again = f.store.putArtifactForWorker({
      token: f.credential.token,
      key: "workspace.patch.gz",
      kind: "unified_patch_gzip",
      sourceSha256: source.sha256,
      data,
      sha256: first.sha256,
    });
    assert.deepEqual(again, first);
    assert.equal(f.store.listArtifacts("wrk-a1b2c3d4").length, 1);
    const file = f.store.artifactFile("wrk-a1b2c3d4", "workspace.patch.gz");
    assert.deepEqual(fs.readFileSync(file.localPath), data);
    assert.equal(fs.statSync(file.localPath).mode & 0o777, 0o600);
    assert.throws(
      () =>
        f.store.putArtifactForWorker({
          token: f.credential.token,
          key: "workspace.patch.gz",
          kind: "unified_patch_gzip",
          sourceSha256: source.sha256,
          data: Buffer.from("different"),
        }),
      (error: unknown) =>
        error instanceof WorkerWorkspaceError && error.code === "conflict",
    );
    assert.throws(
      () =>
        f.store.putArtifactForWorker({
          token: f.credential.token,
          key: "../escape",
          kind: "unified_patch_gzip",
          sourceSha256: source.sha256,
          data,
        }),
      (error: unknown) =>
        error instanceof WorkerWorkspaceError &&
        error.code === "invalid_request",
    );
    fs.writeFileSync(file.localPath, "corrupt");
    assert.throws(
      () => f.store.artifactFile("wrk-a1b2c3d4", "workspace.patch.gz"),
      (error: unknown) =>
        error instanceof WorkerWorkspaceError && error.code === "corrupt",
    );
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
