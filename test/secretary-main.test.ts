import assert from "node:assert/strict";
import test from "node:test";
import {
  runSecretaryProcess,
  secretaryEnvironment,
  type SecretaryProcessClient,
} from "../src/secretary-main.js";

const token = "t".repeat(43);
const sessionId = "sec-AAAAAAAAAAAAAAAAAAAAAA";
const env = {
  ELPIS_SECRETARY_TOKEN: token,
  ELPIS_SECRETARY_BROKER_URL: "https://broker.example.com",
  ELPIS_SECRETARY_SESSION_ID: sessionId,
};

test("secretary process claims one turn, completes, and posts exact final answer", async () => {
  const events: string[] = [];
  const client: SecretaryProcessClient = {
    async pull() {
      events.push("pull");
      return {
        id: "stn-BBBBBBBBBBBBBBBBBBBBBB",
        sequence: 1,
        messages: [{ role: "user", content: "question" }],
      };
    },
    async complete(messages) {
      events.push("complete");
      assert.equal(messages[0].role, "system");
      return {
        message: { role: "assistant", content: "answer" },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        stripped: false,
      };
    },
    async mind() {
      throw new Error("mind must not run");
    },
    async finish(turnId, response) {
      events.push("finish");
      assert.equal(turnId, "stn-BBBBBBBBBBBBBBBBBBBBBB");
      assert.deepEqual(response, { role: "assistant", content: "answer" });
    },
  };
  await runSecretaryProcess({ env, client, once: true });
  assert.deepEqual(events, ["pull", "complete", "finish"]);
});

test("secretary process never retries an ambiguous model failure", async () => {
  let completions = 0;
  let finishes = 0;
  await assert.rejects(
    () =>
      runSecretaryProcess({
        env,
        once: true,
        client: {
          async pull() {
            return {
              id: "stn-BBBBBBBBBBBBBBBBBBBBBB",
              sequence: 1,
              messages: [{ role: "user", content: "question" }],
            };
          },
          async complete() {
            completions++;
            throw new Error("completion response was lost");
          },
          async mind() {
            throw new Error("unused");
          },
          async finish() {
            finishes++;
          },
        },
      }),
    /response was lost/,
  );
  assert.equal(completions, 1);
  assert.equal(finishes, 0);
});

test("secretary process does not complete or finish an empty queue", async () => {
  let effects = 0;
  await runSecretaryProcess({
    env,
    once: true,
    client: {
      async pull() {
        return null;
      },
      async complete() {
        effects++;
        throw new Error("unused");
      },
      async mind() {
        effects++;
        throw new Error("unused");
      },
      async finish() {
        effects++;
      },
    },
  });
  assert.equal(effects, 0);
});

test("secretary environment requires exact scoped credentials", () => {
  assert.throws(() => secretaryEnvironment({}), /TOKEN is required/);
  assert.throws(
    () => secretaryEnvironment({ ...env, ELPIS_SECRETARY_TOKEN: "short" }),
    /TOKEN is invalid/,
  );
  assert.throws(
    () =>
      secretaryEnvironment({
        ...env,
        ELPIS_SECRETARY_SESSION_ID: "wrk-a1b2c3d4",
      }),
    /SESSION_ID is invalid/,
  );
});
