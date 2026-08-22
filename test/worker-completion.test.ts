import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/config.js";
import {
  WorkerCompletionBroker,
  WorkerCompletionError,
  parseWorkerMessages,
} from "../src/worker/completion.js";
import { createWorkerControlCredential } from "../src/worker/auth.js";
import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  LLM,
} from "../src/llm/llm.js";
import { WORKER_RUN_TOOL } from "../src/kernel/run-tool.js";
import { createLlmModelRegistry } from "../src/llm/model-registry.js";
import { openDatabase, type Database } from "../src/store/db.js";
import { makeConfig } from "./helpers.js";

function config(): Config {
  const value = makeConfig();
  value.workers.maxConcurrent = 2;
  value.llm.registry = createLlmModelRegistry({
    providers: {
      p: {
        providerType: "openai-compatible",
        apiKey: "stub",
        baseUrl: "https://provider.test/v1",
        api: "responses",
        externalThinking: false,
        streamIdleTimeoutMs: 1_000,
        callTimeoutMs: 2_000,
        models: {
          main: {
            name: "wire-main",
            contextSize: 100_000,
            reasoningEffort: "high",
            reasoningSummary: null,
            reasoningContext: null,
          },
          worker: {
            name: "wire-worker",
            contextSize: 80_000,
            reasoningEffort: "medium",
            reasoningSummary: null,
            reasoningContext: null,
          },
        },
      },
    },
    roles: { main: "p/main", classifier: "p/main", motor: null },
  });
  value.llm.registrySource = "canonical";
  return value;
}

function fixture(): { dir: string; db: Database; token: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-completion-"));
  const db = openDatabase(dir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO mind_items (id, title, body, kind, status, priority, created_by, created_at, updated_at)
     VALUES ('elm-worker001', 'worker task', '', 'task', 'in_progress', 2, 'agent', ?, ?)`,
  ).run(now, now);
  const credential = createWorkerControlCredential();
  db.prepare(
    `INSERT INTO worker_sessions
      (id, slug, status, model_ref, mind_id, runtime, control_token_digest, created_at, updated_at)
     VALUES ('wrk-worker1', 'quiet-otter', 'running', 'p/worker', 'elm-worker001', 'kubernetes', ?, ?, ?)`,
  ).run(credential.digest, now, now);
  return { dir, db, token: credential.token };
}

function close(f: { dir: string; db: Database }): void {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

function result(content = "ok"): CompleteResult {
  return {
    message: { role: "assistant", content },
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    stripped: false,
  };
}

function fakeLlm(
  model: string,
  complete: (
    messages: ChatMessage[],
    options?: CompleteOptions,
  ) => Promise<CompleteResult>,
): LLM {
  return {
    model,
    runTool: {
      type: "function",
      function: {
        name: "run",
        description: "",
        parameters: { type: "object" },
      },
    },
    complete,
    async summarize() {
      throw new Error("not called");
    },
  };
}

test("completion token binds model, Mind, worker provenance, and one cached native client", async () => {
  const f = fixture();
  const created: string[] = [];
  const requests: ChatMessage[][] = [];
  const completeOptions: Array<CompleteOptions | undefined> = [];
  const broker = new WorkerCompletionBroker({
    db: f.db,
    config: config(),
    create(projected) {
      created.push(projected.llm.model);
      return fakeLlm(projected.llm.model, async (messages, options) => {
        requests.push(messages);
        completeOptions.push(options);
        return result();
      });
    },
  });
  const raw = [
    {
      role: "user",
      content: "work",
      channel: "spoof",
      provenance: { provider: "spoof" },
      sends: [{ channel: "home", text: "no" }],
    },
  ];
  const first = await broker.complete(f.token, raw);
  const second = await broker.complete(f.token, [
    { role: "user", content: "again" },
  ]);
  assert.deepEqual(first.binding, {
    sessionId: "wrk-worker1",
    worker: "worker:quiet-otter",
    modelRef: "p/worker",
    mindId: "elm-worker001",
    runtime: "kubernetes",
  });
  assert.equal(first.result.message.content, "ok");
  assert.equal(second.result.message.content, "ok");
  assert.deepEqual(created, ["wire-worker"]);
  assert.deepEqual(requests[0], [{ role: "user", content: "work" }]);
  assert.equal(completeOptions[0]?.runTool, WORKER_RUN_TOOL);
  assert.deepEqual(
    Object.keys(WORKER_RUN_TOOL.function.parameters.properties),
    ["code", "detail"],
  );
  close(f);
});

test("authentication and message validation fail before client construction", async () => {
  const f = fixture();
  let creates = 0;
  const broker = new WorkerCompletionBroker({
    db: f.db,
    config: config(),
    create() {
      creates++;
      return fakeLlm("bad", async () => result());
    },
  });
  await assert.rejects(
    () =>
      broker.complete(createWorkerControlCredential().token, [
        { role: "user", content: "x" },
      ]),
    (error: unknown) =>
      error instanceof WorkerCompletionError && error.code === "unauthorized",
  );
  await assert.rejects(
    () =>
      broker.complete(f.token, [
        { role: "user", content: "x", contentParts: [] },
      ]),
    (error: unknown) =>
      error instanceof WorkerCompletionError && error.code === "unsupported",
  );
  assert.throws(
    () => parseWorkerMessages(undefined),
    (error: unknown) =>
      error instanceof WorkerCompletionError &&
      error.code === "invalid_request",
  );
  assert.equal(creates, 0);
  close(f);
});

test("one worker session cannot overlap completion calls", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<CompleteResult>();
  const broker = new WorkerCompletionBroker({
    db: f.db,
    config: config(),
    create(projected) {
      return fakeLlm(projected.llm.model, async () => pending.promise);
    },
  });
  const first = broker.complete(f.token, [{ role: "user", content: "first" }]);
  await assert.rejects(
    () => broker.complete(f.token, [{ role: "user", content: "second" }]),
    (error: unknown) =>
      error instanceof WorkerCompletionError && error.code === "busy",
  );
  pending.resolve(result("first"));
  assert.equal((await first).result.message.content, "first");
  close(f);
});

test("session dismissal revokes completion even when a client was cached", async () => {
  const f = fixture();
  let calls = 0;
  const broker = new WorkerCompletionBroker({
    db: f.db,
    config: config(),
    create(projected) {
      return fakeLlm(projected.llm.model, async () => {
        calls++;
        return result();
      });
    },
  });
  await broker.complete(f.token, [{ role: "user", content: "before" }]);
  f.db
    .prepare(
      "UPDATE worker_sessions SET status = 'dismissed' WHERE id = 'wrk-worker1'",
    )
    .run();
  await assert.rejects(
    () => broker.complete(f.token, [{ role: "user", content: "after" }]),
    (error: unknown) =>
      error instanceof WorkerCompletionError && error.code === "unauthorized",
  );
  assert.equal(calls, 1);
  close(f);
});
