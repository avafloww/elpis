import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createActorCompletionHttpServer,
  listenActorCompletionHttpServer,
} from "../src/fleet/actor-http.js";
import { ActorCompletionError } from "../src/fleet/actor-completion.js";
import { noopLogger } from "../src/lib/log.js";

const TOKEN = "a".repeat(43);

async function fixture(
  complete: Parameters<
    typeof createActorCompletionHttpServer
  >[0]["broker"]["complete"],
  maxBodyBytes?: number,
) {
  const server = createActorCompletionHttpServer({
    broker: { complete },
    host: "127.0.0.1",
    port: 0,
    logger: noopLogger,
    maxBodyBytes,
  });
  await listenActorCompletionHttpServer(server, "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/v1/complete` };
}

async function close(
  server: ReturnType<typeof createActorCompletionHttpServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("HTTP completion transport passes only token and messages to bound broker", async () => {
  const calls: unknown[] = [];
  const f = await fixture(async (token, messages, signal) => {
    calls.push({ token, messages, aborted: signal?.aborted });
    return {
      binding: {
        sessionId: "f-1",
        actor: "fleet:otter",
        modelRef: "p/actor",
        mindId: "elm-actor001",
        runtime: "kubernetes",
      },
      result: {
        message: { role: "assistant", content: "ok" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        stripped: false,
      },
    };
  });
  const response = await fetch(f.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: 1,
      messages: [{ role: "user", content: "work" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.protocol, 1);
  assert.deepEqual(calls, [
    {
      token: TOKEN,
      messages: [{ role: "user", content: "work" }],
      aborted: false,
    },
  ]);
  await close(f.server);
});

test("HTTP transport rejects spoofable routing fields, bad auth, methods, and oversized bodies", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw new Error("must not call");
  }, 80);
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          protocol: 1,
          messages: [],
          modelRef: "spoof/model",
        }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        body: JSON.stringify({ protocol: 1, messages: [] }),
      })
    ).status,
    401,
  );
  assert.equal((await fetch(f.url)).status, 405);
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          protocol: 1,
          messages: [{ role: "user", content: "x".repeat(100) }],
        }),
      })
    ).status,
    413,
  );
  assert.equal(calls, 0);
  await close(f.server);
});

test("HTTP transport maps actor errors without leaking generic failures", async () => {
  const busy = await fixture(async () => {
    throw new ActorCompletionError("busy", "already running");
  });
  let response = await fetch(busy.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocol: 1, messages: [] }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "already running",
    code: "busy",
  });
  await close(busy.server);

  const failed = await fixture(async () => {
    throw new Error("provider secret detail");
  });
  response = await fetch(failed.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocol: 1, messages: [] }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "actor completion failed" });
  await close(failed.server);
});
