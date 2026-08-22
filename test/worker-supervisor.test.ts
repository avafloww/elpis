import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { noopLogger } from "../src/lib/log.js";
import { openDatabase } from "../src/store/db.js";
import { MindService } from "../src/store/mind.js";
import { WorkerMailboxBroker } from "../src/worker/mailbox.js";
import { WorkerWorkspaceStore } from "../src/worker/workspace.js";
import type {
  WorkerPodRuntime,
  WorkerProvisionRequest,
  WorkerProvisionState,
  WorkerSession,
} from "../src/worker/spawn.js";
import { startWorkerSupervisor } from "../src/worker/supervisor.js";
import { makeConfig } from "./helpers.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-supervisor-"));
  const db = openDatabase(root);
  const mind = new MindService({
    db,
    scheduler: {
      create() {
        throw new Error("unused");
      },
      delete() {
        return true;
      },
      update() {
        return null;
      },
    } as never,
    logger: noopLogger,
  });
  const config = makeConfig();
  config.workers.enabled = true;
  config.workers.server.enabled = true;
  config.workers.kubernetes = {
    enabled: true,
    namespace: "workers",
    template: "elpis-worker",
    container: "worker",
    brokerUrl: "https://broker.example.com",
    kubectlPath: "kubectl",
    context: null,
  };
  const requests: WorkerProvisionRequest[] = [];
  const cleaned: string[] = [];
  const states = new Map<string, WorkerProvisionState>();
  const runtime: WorkerPodRuntime = {
    async provision(request) {
      requests.push(request);
      const receipt = {
        podName: `pod-${request.sessionId}`,
        podUid: `uid-${request.sessionId}`,
        workspaceRef: `pod/workers/${request.sessionId}`,
      };
      states.set(request.sessionId, { state: "ready", receipt });
      return receipt;
    },
    async inspect(session) {
      return states.get(session.id) ?? { state: "missing" };
    },
    async cleanup(session: WorkerSession) {
      cleaned.push(session.id);
      states.delete(session.id);
    },
  };
  return {
    root,
    db,
    mind,
    config,
    runtime,
    requests,
    cleaned,
    mailbox: new WorkerMailboxBroker(db),
    workspace: new WorkerWorkspaceStore({
      db,
      storageRoot: path.join(root, "custody"),
      sourceRoot: null,
      maxSourceBytes: 8 * 1024 * 1024,
      maxArtifactBytes: 8 * 1024 * 1024,
    }),
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("supervisor owns spawn, live refresh, mailbox steering, and dismissal", async () => {
  const f = fixture();
  const runtime = await startWorkerSupervisor({
    db: f.db,
    config: f.config,
    mind: f.mind,
    mailbox: f.mailbox,
    workspace: f.workspace,
    logger: noopLogger,
    runtime: f.runtime,
  });
  assert.ok(runtime);
  const item = f.mind.create({ title: "bounded worker task" });
  const session = await runtime.api.start(item.id);
  const token = f.requests[0].token;
  f.mailbox.postFromWorker(token, "progress-1", "message", "evidence ready");
  const status = await runtime.api.status(session.id);
  assert.equal(status.session.status, "running");
  assert.equal(status.messages[0].body, "evidence ready");
  assert.deepEqual(status.artifacts, []);

  f.db
    .prepare(
      `UPDATE worker_sessions
       SET source_revision = ?, source_sha256 = ?, source_bytes = ?
       WHERE id = ?`,
    )
    .run("a".repeat(40), "b".repeat(64), 10, session.id);
  const artifactData = Buffer.from("review patch");
  const artifact = f.workspace.putArtifactForWorker({
    token,
    key: "workspace.patch.gz",
    kind: "unified_patch_gzip",
    sourceSha256: "b".repeat(64),
    data: artifactData,
  });
  const withArtifact = await runtime.api.status(session.id);
  assert.equal(withArtifact.artifacts.length, 1);
  assert.equal(withArtifact.artifacts[0].sha256, artifact.sha256);
  assert.equal(Object.hasOwn(withArtifact.artifacts[0], "relativePath"), false);
  const review = await runtime.api.artifact(session.id);
  assert.equal(review.sha256, artifact.sha256);
  assert.equal(fs.readFileSync(review.localPath, "utf8"), "review patch");

  const sent = await runtime.api.send(session.worker, "verify once more");
  assert.equal(sent.direction, "dispatcher_to_worker");
  assert.equal(
    f.mailbox.pullForWorker(token).messages[0].body,
    "verify once more",
  );
  assert.equal((await runtime.api.list()).length, 1);

  const dismissed = await runtime.api.dismiss(session.slug);
  assert.equal(dismissed.status, "dismissed");
  assert.deepEqual(f.cleaned, [session.id]);
  f.close();
});

test("supervisor is absent when the fixed Kubernetes runtime is disabled", async () => {
  const f = fixture();
  f.config.workers.kubernetes.enabled = false;
  const runtime = await startWorkerSupervisor({
    db: f.db,
    config: f.config,
    mind: f.mind,
    mailbox: null,
    logger: noopLogger,
    runtime: f.runtime,
  });
  assert.equal(runtime, null);
  assert.equal(f.requests.length, 0);
  f.close();
});
