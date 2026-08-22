import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createWorkerCompletionHttpServer,
  listenWorkerCompletionHttpServer,
} from "../src/worker/http.js";
import { noopLogger } from "../src/lib/log.js";
import { SecretaryMindError } from "../src/secretary/mind.js";

const TOKEN = "a".repeat(43);
async function start(inject = false) {
  const server = createWorkerCompletionHttpServer({
    broker: {
      async complete() {
        throw new Error("worker not called");
      },
    },
    ...(inject
      ? {
          secretaryCompletion: {
            async complete(token, messages, signal) {
              return {
                binding: {
                  sessionId: "sec-" + "a".repeat(22),
                  rootMindId: "elm-root0001",
                  modelRef: "p/sec",
                  runtime: "kubernetes",
                },
                result: {
                  message: {
                    role: "assistant",
                    content: String((messages as any[]).length),
                  },
                  usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                  },
                  stripped: false,
                },
              };
            },
          },
          secretaryMind: {
            get() {
              throw new SecretaryMindError(
                "outside_scope",
                "Mind item is outside secretary scope",
              );
            },
            tree() {
              throw new Error("unused");
            },
          },
        }
      : {}),
    host: "127.0.0.1",
    port: 0,
    logger: noopLogger,
  });
  await listenWorkerCompletionHttpServer(server, "127.0.0.1", 0);
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
async function close(
  server: ReturnType<typeof createWorkerCompletionHttpServer>,
) {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
}
const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

test("secretary HTTP routes are unavailable unless services are injected", async () => {
  const f = await start();
  for (const path of ["/v1/secretary/complete", "/v1/secretary/mind"]) {
    const r = await fetch(f.base + path, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  await close(f.server);
});

test("secretary HTTP routes enforce protocol and distinct scope errors", async () => {
  const f = await start(true);
  let r = await fetch(f.base + "/v1/secretary/complete", {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: 1,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).protocol, 1);
  r = await fetch(f.base + "/v1/secretary/mind", {
    method: "POST",
    headers,
    body: JSON.stringify({ protocol: 1, operation: "get", id: "elm-other001" }),
  });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), {
    error: "Mind item is outside secretary scope",
    code: "outside_scope",
  });
  await close(f.server);
});
