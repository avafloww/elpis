import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createActorControlCredential } from "../src/fleet/actor-auth.js";
import { startScopedActorServer } from "../src/fleet/actor-runtime.js";
import type { LLM } from "../src/llm/llm.js";
import { createLlmModelRegistry } from "../src/llm/model-registry.js";
import { noopLogger } from "../src/lib/log.js";
import { openDatabase } from "../src/store/db.js";
import { MindService } from "../src/store/mind.js";
import { makeConfig } from "./helpers.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-runtime-"));
  const db = openDatabase(dir);
  const scheduler = {
    create() {
      throw new Error("unused");
    },
    delete() {
      return true;
    },
    update() {
      return null;
    },
  };
  const mind = new MindService({
    db,
    scheduler: scheduler as never,
    logger: noopLogger,
  });
  const root = mind.create({ title: "actor root", kind: "project" });
  const credential = createActorControlCredential();
  const now = Date.now();
  db.prepare(
    `INSERT INTO fleet_sessions
     (id,name,cwd,status,model,effort,created_at,updated_at,model_ref,mind_id,runtime,control_token_digest)
     VALUES ('f-runtime','quiet-otter','/work','running','wire','','${now}','${now}','p/actor',?,'kubernetes',?)`,
  ).run(root.id, credential.digest);
  const config = makeConfig();
  config.fleet.enabled = true;
  config.fleet.actorServer = { enabled: true, host: "127.0.0.1", port: 0 };
  config.llm.registry = createLlmModelRegistry({
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
    roles: { main: "p/actor", classifier: "p/actor", motor: null },
  });
  config.llm.registrySource = "canonical";
  return { dir, db, mind, root, token: credential.token, config };
}

function fakeLlm(model: string): LLM {
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
    async complete() {
      return {
        message: { role: "assistant", content: "ACTOR_OK" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        stripped: false,
      };
    },
    async summarize() {
      throw new Error("unused");
    },
  };
}

function closeFixture(f: ReturnType<typeof fixture>) {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test("scoped actor server remains absent unless explicitly enabled", async () => {
  const f = fixture();
  f.config.fleet.actorServer.enabled = false;
  assert.equal(
    await startScopedActorServer({
      db: f.db,
      config: f.config,
      mind: f.mind,
      logger: noopLogger,
    }),
    null,
  );
  f.config.fleet.actorServer.enabled = true;
  f.config.fleet.enabled = false;
  assert.equal(
    await startScopedActorServer({
      db: f.db,
      config: f.config,
      mind: f.mind,
      logger: noopLogger,
    }),
    null,
  );
  closeFixture(f);
});

test("scoped actor server owns completion, Mind, mailbox, and clean stop", async () => {
  const f = fixture();
  const runtime = await startScopedActorServer({
    db: f.db,
    config: f.config,
    mind: f.mind,
    logger: noopLogger,
    create(projected) {
      return fakeLlm(projected.llm.model);
    },
  });
  assert.ok(runtime);
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    authorization: `Bearer ${f.token}`,
    "content-type": "application/json",
  };

  let response = await fetch(`${base}/v1/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: 1,
      messages: [{ role: "user", content: "work" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as any).result.message.content,
    "ACTOR_OK",
  );

  response = await fetch(`${base}/v1/mind`, {
    method: "POST",
    headers,
    body: JSON.stringify({ protocol: 1, operation: "get" }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any).item.id, f.root.id);

  const sent = runtime.mailbox.sendToActor("f-runtime", "dispatch-1", "hello");
  response = await fetch(`${base}/v1/mailbox`, {
    method: "POST",
    headers,
    body: JSON.stringify({ protocol: 1, operation: "pull" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    ((await response.json()) as any).messages.map((message: any) => message.id),
    [sent.id],
  );

  const closed = once(runtime.server, "close");
  runtime.stop();
  runtime.stop();
  await closed;
  assert.equal(runtime.server.listening, false);
  closeFixture(f);
});
