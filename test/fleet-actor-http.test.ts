import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  createActorCompletionHttpServer,
  listenActorCompletionHttpServer,
} from "../src/fleet/actor-http.js";
import { ActorCompletionError } from "../src/fleet/actor-completion.js";
import { ActorMailboxError } from "../src/fleet/actor-mailbox.js";
import type { ActorMailboxService } from "../src/fleet/actor-mailbox-request.js";
import { ActorMindError } from "../src/fleet/actor-mind.js";
import type { ActorMindService } from "../src/fleet/actor-mind-request.js";
import { noopLogger } from "../src/lib/log.js";

const TOKEN = "a".repeat(43);

async function fixture(
  complete: Parameters<
    typeof createActorCompletionHttpServer
  >[0]["broker"]["complete"],
  maxBodyBytes?: number,
  mind?: ActorMindService,
  mailbox?: ActorMailboxService,
) {
  const server = createActorCompletionHttpServer({
    broker: { complete },
    mind,
    mailbox,
    host: "127.0.0.1",
    port: 0,
    logger: noopLogger,
    maxBodyBytes,
  });
  await listenActorCompletionHttpServer(server, "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}/v1/complete`,
    mindUrl: `http://127.0.0.1:${port}/v1/mind`,
    mailboxUrl: `http://127.0.0.1:${port}/v1/mailbox`,
  };
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

test("HTTP Mind transport passes only token and closed operation input to the broker", async () => {
  const calls: unknown[] = [];
  const mind: ActorMindService = {
    get(token, id) {
      calls.push({ method: "get", token, id });
      return {
        binding: {
          sessionId: "f-1",
          actor: "fleet:otter",
          modelRef: "p/actor",
          mindId: "elm-a2b3k7q9",
          runtime: "kubernetes",
        },
        item: { id: id ?? "elm-a2b3k7q9" } as never,
      };
    },
    createChild() {
      throw new Error("unused");
    },
    addComment() {
      throw new Error("unused");
    },
    setStatus() {
      throw new Error("unused");
    },
  };
  const f = await fixture(
    async () => {
      throw new Error("completion must not run");
    },
    undefined,
    mind,
  );
  const response = await fetch(f.mindUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocol: 1, operation: "get", id: "elm-b2b3k7q9" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(((await response.json()) as any).item.id, "elm-b2b3k7q9");
  assert.deepEqual(calls, [
    { method: "get", token: TOKEN, id: "elm-b2b3k7q9" },
  ]);

  const spoofed = await fetch(f.mindUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: 1,
      operation: "get",
      actor: "fleet:spoof",
    }),
  });
  assert.equal(spoofed.status, 400);
  assert.deepEqual(calls, [
    { method: "get", token: TOKEN, id: "elm-b2b3k7q9" },
  ]);
  await close(f.server);
});

test("HTTP Mind route is opt-in and maps authentication and scope failures", async () => {
  const disabled = await fixture(async () => {
    throw new Error("unused");
  });
  assert.equal((await fetch(disabled.mindUrl, { method: "POST" })).status, 404);
  await close(disabled.server);

  const mind: ActorMindService = {
    get() {
      throw new ActorMindError(
        "outside_scope",
        "Mind item is outside actor scope",
      );
    },
    createChild() {
      throw new Error("unused");
    },
    addComment() {
      throw new Error("unused");
    },
    setStatus() {
      throw new Error("unused");
    },
  };
  const f = await fixture(
    async () => {
      throw new Error("unused");
    },
    undefined,
    mind,
  );
  assert.equal(
    (
      await fetch(f.mindUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol: 1, operation: "get" }),
      })
    ).status,
    401,
  );
  const outside = await fetch(f.mindUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocol: 1, operation: "get", id: "elm-b2b3k7q9" }),
  });
  assert.equal(outside.status, 403);
  assert.deepEqual(await outside.json(), {
    error: "Mind item is outside actor scope",
    code: "outside_scope",
  });
  assert.equal((await fetch(f.mindUrl)).status, 405);
  await close(f.server);

  const failed = await fixture(
    async () => {
      throw new Error("unused");
    },
    undefined,
    {
      get() {
        throw new Error("database secret detail");
      },
      createChild() {
        throw new Error("unused");
      },
      addComment() {
        throw new Error("unused");
      },
      setStatus() {
        throw new Error("unused");
      },
    },
  );
  const response = await fetch(failed.mindUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ protocol: 1, operation: "get" }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "actor Mind request failed",
  });
  await close(failed.server);
});

test("HTTP mailbox transport exposes only token-bound pull, ack, and post", async () => {
  const calls: unknown[] = [];
  const message = {
    id: 7,
    sessionId: "f-1",
    direction: "actor_to_dispatcher" as const,
    kind: "message" as const,
    messageKey: "progress-1",
    sender: "fleet:otter",
    body: "working",
    createdAt: 1,
    acknowledgedAt: null,
  };
  const mailbox: ActorMailboxService = {
    pullForActor(token, limit) {
      calls.push({ method: "pull", token, limit });
      return {
        binding: {
          sessionId: "f-1",
          actor: "fleet:otter",
          modelRef: "p/actor",
          mindId: "elm-a2b3k7q9",
          runtime: "kubernetes",
        },
        messages: [],
      };
    },
    acknowledgeForActor(token, ids) {
      calls.push({ method: "ack", token, ids });
      return ids.length;
    },
    postFromActor(token, messageKey, kind, body) {
      calls.push({ method: "post", token, messageKey, kind, body });
      return { ...message, messageKey, kind, body };
    },
  };
  const f = await fixture(
    async () => {
      throw new Error("unused");
    },
    undefined,
    undefined,
    mailbox,
  );
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  let response = await fetch(f.mailboxUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ protocol: 1, operation: "pull", limit: 5 }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any).binding.actor, "fleet:otter");
  response = await fetch(f.mailboxUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: 1,
      operation: "post",
      messageKey: "progress-1",
      kind: "message",
      body: "working",
    }),
  });
  assert.equal(response.status, 200);
  response = await fetch(f.mailboxUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ protocol: 1, operation: "ack", ids: [3, 4] }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any).acknowledged, 2);
  assert.deepEqual(calls, [
    { method: "pull", token: TOKEN, limit: 5 },
    {
      method: "post",
      token: TOKEN,
      messageKey: "progress-1",
      kind: "message",
      body: "working",
    },
    { method: "ack", token: TOKEN, ids: [3, 4] },
  ]);

  response = await fetch(f.mailboxUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: 1,
      operation: "post",
      messageKey: "x",
      kind: "message",
      body: "x",
      sender: "fleet:spoof",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 3);
  await close(f.server);
});

test("HTTP mailbox route is opt-in and redacts failures", async () => {
  const disabled = await fixture(async () => {
    throw new Error("unused");
  });
  assert.equal(
    (await fetch(disabled.mailboxUrl, { method: "POST" })).status,
    404,
  );
  await close(disabled.server);

  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  const conflict = await fixture(
    async () => {
      throw new Error("unused");
    },
    undefined,
    undefined,
    {
      pullForActor() {
        throw new Error("unused");
      },
      acknowledgeForActor() {
        throw new Error("unused");
      },
      postFromActor() {
        throw new ActorMailboxError(
          "conflict",
          "actor session already has a finish message",
        );
      },
    },
  );
  let response = await fetch(conflict.mailboxUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: 1,
      operation: "post",
      messageKey: "finish-2",
      kind: "finish",
      body: "again",
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "actor session already has a finish message",
    code: "conflict",
  });
  await close(conflict.server);

  const failed = await fixture(
    async () => {
      throw new Error("unused");
    },
    undefined,
    undefined,
    {
      pullForActor() {
        throw new Error("database secret detail");
      },
      acknowledgeForActor() {
        throw new Error("unused");
      },
      postFromActor() {
        throw new Error("unused");
      },
    },
  );
  response = await fetch(failed.mailboxUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ protocol: 1, operation: "pull" }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "actor mailbox request failed",
  });
  await close(failed.server);
});
