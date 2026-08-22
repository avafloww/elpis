import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import type { WorkerEpisodeBroker } from "../src/kernel/worker-episode.js";
import {
  createWorkerSandbox,
  runWorkerProcess,
  workerEnvironment,
  type WorkerWorkspaceBroker,
} from "../src/worker-main.js";
import type { WorkerWorkspaceSource } from "../src/worker/client.js";

const token = "t".repeat(43);

function environment(root: string): NodeJS.ProcessEnv {
  return {
    ELPIS_WORKER_TOKEN: token,
    ELPIS_WORKER_BROKER_URL: "https://broker.example.com",
    ELPIS_WORKER_SESSION_ID: "wrk-a1b2c3d4",
    ELPIS_WORKER_WORKSPACE: path.join(root, "workspace"),
    ELPIS_WORKER_DATA_DIR: path.join(root, "data"),
  };
}

function sourceFixture(root: string): WorkerWorkspaceSource {
  const repo = path.join(root, "source");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "src", "value.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: repo,
  });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const archive = path.join(root, "source.tar.gz");
  execFileSync(
    "git",
    ["archive", "--format=tar.gz", `--output=${archive}`, "HEAD"],
    { cwd: repo },
  );
  const data = fs.readFileSync(archive);
  return {
    revision,
    sha256: createHash("sha256").update(data).digest("hex"),
    sizeBytes: data.length,
    data,
  };
}

test("worker process runs one journaled episode without resident bootstrap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-main-"));
  const finishes: Array<{ key: string; body: string }> = [];
  const broker: WorkerEpisodeBroker = {
    async getMandate() {
      return {
        id: "elm-a1b2c3d4",
        title: "bounded task",
        body: "report completion",
        status: "in_progress",
        dependencies: [],
        comments: [],
      };
    },
    async pullGuidance() {
      return [];
    },
    async acknowledgeGuidance() {},
    async complete() {
      return {
        message: { role: "assistant", content: "completed with evidence" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        stripped: false,
      };
    },
    async finish(key, body) {
      finishes.push({ key, body });
    },
  };
  await runWorkerProcess({
    env: environment(root),
    broker,
    sandbox: {
      async run() {
        throw new Error("not called");
      },
    },
  });
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].body, "completed with evidence");
  const journal = path.join(root, "data", "worker-episode.jsonl");
  assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  const raw = fs.readFileSync(journal, "utf8");
  assert.match(raw, /"finish_prepared"/);
  assert.match(raw, /"finished"/);
  assert.equal(raw.includes(token), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker process checks out bound source and uploads artifact before finish", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-main-source-"));
  const source = sourceFixture(root);
  const workspace = path.join(root, "workspace");
  const events: string[] = [];
  let sourceCalls = 0;
  let uploaded: Buffer | null = null;
  const broker: WorkerEpisodeBroker & WorkerWorkspaceBroker = {
    async getWorkspaceSource() {
      sourceCalls++;
      return source;
    },
    async putWorkspaceArtifact(input) {
      events.push("artifact");
      uploaded = input.data;
      assert.equal(input.sourceSha256, source.sha256);
      return {
        sessionId: "wrk-a1b2c3d4",
        key: input.key,
        kind: input.kind,
        sourceSha256: input.sourceSha256,
        sha256: createHash("sha256").update(input.data).digest("hex"),
        sizeBytes: input.data.length,
        createdAt: 1,
      };
    },
    async getMandate() {
      return {
        id: "elm-a1b2c3d4",
        title: "bounded task",
        body: "change the source",
        status: "in_progress",
        dependencies: [],
        comments: [],
      };
    },
    async pullGuidance() {
      return [];
    },
    async acknowledgeGuidance() {},
    async complete() {
      events.push("complete");
      assert.equal(
        fs.readFileSync(path.join(workspace, "src", "value.ts"), "utf8"),
        "export const value = 1;\n",
      );
      fs.writeFileSync(
        path.join(workspace, "src", "value.ts"),
        "export const value = 2;\n",
      );
      return {
        message: { role: "assistant", content: "changed with evidence" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        stripped: false,
      };
    },
    async finish() {
      events.push("finish");
      assert.ok(uploaded, "artifact must be uploaded before finish");
    },
  };
  try {
    await runWorkerProcess({
      env: environment(root),
      broker,
      sandbox: {
        async run() {
          throw new Error("not called");
        },
      },
    });
    assert.equal(sourceCalls, 2);
    assert.deepEqual(events, ["complete", "artifact", "finish"]);
    assert.ok(uploaded);
    assert.match(gunzipSync(uploaded).toString("utf8"), /value = 2/);
    const raw = fs.readFileSync(
      path.join(root, "data", "worker-episode.jsonl"),
      "utf8",
    );
    assert.ok(raw.indexOf('"finish_prepared"') < raw.indexOf('"finished"'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worker sandbox exposes only the worker tool surface", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-sandbox-"));
  const before = process.cwd();
  try {
    const env = workerEnvironment(environment(root));
    const sandbox = createWorkerSandbox(env);
    const result = await sandbox.run("Object.keys(elpis).sort()");
    assert.equal(result.ok, true);
    assert.match(result.preview ?? "", /edit/);
    assert.match(result.preview ?? "", /sh/);
    for (const forbidden of ["channel", "memory", "mind", "schedule", "worker"])
      assert.doesNotMatch(
        result.preview ?? "",
        new RegExp(`\\b${forbidden}\\b`),
      );
  } finally {
    process.chdir(before);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worker environment requires exact scoped credentials", () => {
  assert.throws(() => workerEnvironment({}), /ELPIS_WORKER_TOKEN is required/);
  assert.throws(
    () =>
      workerEnvironment({
        ...environment("/tmp"),
        ELPIS_WORKER_TOKEN: "short",
      }),
    /TOKEN is invalid/,
  );
  assert.throws(
    () =>
      workerEnvironment({
        ...environment("/tmp"),
        ELPIS_WORKER_SESSION_ID: "fleet-1",
      }),
    /SESSION_ID is invalid/,
  );
});
