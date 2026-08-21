import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/config.js";
import {
  ActorCompletionBroker,
  ActorCompletionError,
  parseActorMessages,
} from "../src/fleet/actor-completion.js";
import { createActorControlCredential } from "../src/fleet/actor-auth.js";
import type { ChatMessage, CompleteResult, LLM } from "../src/llm/llm.js";
import { createLlmModelRegistry } from "../src/llm/model-registry.js";
import { openDatabase, type Database } from "../src/store/db.js";
import { makeConfig } from "./helpers.js";

function config(): Config {
  const value = makeConfig();
  value.fleet.maxConcurrent = 2;
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
          actor: {
            name: "wire-actor",
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-completion-"));
  const db = openDatabase(dir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO mind_items (id, title, body, kind, status, priority, created_by, created_at, updated_at)
     VALUES ('elm-actor001', 'actor task', '', 'task', 'in_progress', 2, 'agent', ?, ?)`,
  ).run(now, now);
  const credential = createActorControlCredential();
  db.prepare(
    `INSERT INTO fleet_sessions
      (id, name, cwd, status, model, effort, created_at, updated_at, model_ref, mind_id, runtime, control_token_digest)
     VALUES ('f-actor1', 'quiet-otter', '/work', 'running', 'wire-actor', '', ?, ?, 'p/actor', 'elm-actor001', 'kubernetes', ?)`,
  ).run(now, now, credential.digest);
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
  complete: (messages: ChatMessage[]) => Promise<CompleteResult>,
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

test("completion token binds model, Mind, actor provenance, and one cached native client", async () => {
  const f = fixture();
  const created: string[] = [];
  const requests: ChatMessage[][] = [];
  const broker = new ActorCompletionBroker({
    db: f.db,
    config: config(),
    create(projected) {
      created.push(projected.llm.model);
      return fakeLlm(projected.llm.model, async (messages) => {
        requests.push(messages);
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
    sessionId: "f-actor1",
    actor: "fleet:quiet-otter",
    modelRef: "p/actor",
    mindId: "elm-actor001",
    runtime: "kubernetes",
  });
  assert.equal(first.result.message.content, "ok");
  assert.equal(second.result.message.content, "ok");
  assert.deepEqual(created, ["wire-actor"]);
  assert.deepEqual(requests[0], [{ role: "user", content: "work" }]);
  close(f);
});

test("authentication and message validation fail before client construction", async () => {
  const f = fixture();
  let creates = 0;
  const broker = new ActorCompletionBroker({
    db: f.db,
    config: config(),
    create() {
      creates++;
      return fakeLlm("bad", async () => result());
    },
  });
  await assert.rejects(
    () =>
      broker.complete(createActorControlCredential().token, [
        { role: "user", content: "x" },
      ]),
    (error: unknown) =>
      error instanceof ActorCompletionError && error.code === "unauthorized",
  );
  await assert.rejects(
    () =>
      broker.complete(f.token, [
        { role: "user", content: "x", contentParts: [] },
      ]),
    (error: unknown) =>
      error instanceof ActorCompletionError && error.code === "unsupported",
  );
  assert.throws(
    () => parseActorMessages(undefined),
    (error: unknown) =>
      error instanceof ActorCompletionError && error.code === "invalid_request",
  );
  assert.equal(creates, 0);
  close(f);
});

test("one actor session cannot overlap completion calls", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<CompleteResult>();
  const broker = new ActorCompletionBroker({
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
      error instanceof ActorCompletionError && error.code === "busy",
  );
  pending.resolve(result("first"));
  assert.equal((await first).result.message.content, "first");
  close(f);
});

test("session dismissal revokes completion even when a client was cached", async () => {
  const f = fixture();
  let calls = 0;
  const broker = new ActorCompletionBroker({
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
      "UPDATE fleet_sessions SET status = 'dismissed' WHERE id = 'f-actor1'",
    )
    .run();
  await assert.rejects(
    () => broker.complete(f.token, [{ role: "user", content: "after" }]),
    (error: unknown) =>
      error instanceof ActorCompletionError && error.code === "unauthorized",
  );
  assert.equal(calls, 1);
  close(f);
});
