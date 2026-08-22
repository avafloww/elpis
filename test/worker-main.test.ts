import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { WorkerEpisodeBroker } from "../src/kernel/worker-episode.js";
import {
  createWorkerSandbox,
  runWorkerProcess,
  workerEnvironment,
} from "../src/worker-main.js";

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
