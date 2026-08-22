import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  WorkerEpisode,
  WorkerEpisodeError,
  type WorkerEpisodeBroker,
  type WorkerGuidance,
} from "../src/kernel/worker-episode.js";
import { WorkerJournal } from "../src/kernel/worker-journal.js";
import type { ChatMessage, CompleteResult } from "../src/llm/llm.js";

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worker-episode-"));
}

function result(message: ChatMessage): CompleteResult {
  return {
    message,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    stripped: false,
  };
}

function runTurn(id: string, args: Record<string, unknown>): CompleteResult {
  return result({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: "run", arguments: JSON.stringify(args) },
      },
    ],
  });
}

class FakeBroker implements WorkerEpisodeBroker {
  readonly requests: ChatMessage[][] = [];
  readonly acknowledgements: number[][] = [];
  readonly finishes: Array<{ key: string; body: string }> = [];
  mandateCalls = 0;
  pullCalls = 0;

  constructor(
    private readonly completions: CompleteResult[],
    private readonly guidance: (call: number) => WorkerGuidance[] = () => [],
  ) {}

  async getMandate() {
    this.mandateCalls++;
    return {
      id: "elm-work0001",
      title: "verify the fixture",
      body: "Run the calculation and report it.",
      status: "in_progress",
      dependencies: [],
      comments: [{ body: "keep the receipt" }],
    };
  }

  async pullGuidance(): Promise<WorkerGuidance[]> {
    this.pullCalls++;
    return this.guidance(this.pullCalls);
  }

  async acknowledgeGuidance(ids: number[]): Promise<void> {
    this.acknowledgements.push(ids);
  }

  async complete(messages: ChatMessage[]): Promise<CompleteResult> {
    this.requests.push(messages);
    const next = this.completions.shift();
    if (!next) throw new Error("unexpected completion");
    return next;
  }

  async finish(key: string, body: string): Promise<void> {
    this.finishes.push({ key, body });
  }
}

test("worker episode executes with durable receipts and idempotent guidance", async () => {
  const root = dir();
  const file = path.join(root, "episode.jsonl");
  const journal = new WorkerJournal(file, () => 1234);
  const broker = new FakeBroker(
    [
      runTurn("call-1", { code: "6 * 7", detail: "calculate answer" }),
      result({ role: "assistant", content: "The answer is 42." }),
    ],
    (call) =>
      call <= 2 ? [{ id: 7, sender: "dispatcher", body: "show evidence" }] : [],
  );
  const executed: string[] = [];
  const episode = new WorkerEpisode({
    broker,
    journal,
    sandbox: {
      async run(code) {
        executed.push(code);
        return { ok: true, preview: "42", savedAs: "_" };
      },
    },
  });

  const finished = await episode.run();
  assert.equal(finished.body, "The answer is 42.");
  assert.equal(finished.turns, 2);
  assert.equal(finished.resumed, false);
  assert.deepEqual(executed, ["6 * 7"]);
  assert.deepEqual(broker.acknowledgements, [[7], [7]]);
  assert.equal(broker.finishes.length, 1);
  assert.match(broker.finishes[0].key, /^worker-finish-[0-9a-f]{24}$/);
  assert.equal(
    broker.requests[1].filter((message) =>
      message.content.includes("show evidence"),
    ).length,
    1,
  );
  const tool = broker.requests[1].find((message) => message.role === "tool");
  assert.deepEqual(JSON.parse(tool?.content ?? ""), {
    ok: true,
    preview: "42",
    savedAs: "_",
  });
  assert.match(broker.requests[0][0].content, /ephemeral Elpis worker/);
  assert.match(broker.requests[0][1].content, /elm-work0001/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  journal.close();
  const reopened = new WorkerJournal(file);
  const state = reopened.state();
  assert.equal(state.pendingTools.size, 0);
  assert.equal(state.pendingFinish, null);
  assert.equal(state.finished?.body, "The answer is 42.");
  const resumedBroker = new FakeBroker([]);
  const resumed = await new WorkerEpisode({
    broker: resumedBroker,
    journal: reopened,
    sandbox: {
      async run() {
        throw new Error("not called");
      },
    },
  }).run();
  assert.equal(resumed.turns, 0);
  assert.equal(resumed.resumed, true);
  assert.equal(resumedBroker.mandateCalls, 0);
  assert.equal(resumedBroker.requests.length, 0);
  reopened.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker completes custody hook before preparing and sending finish", async () => {
  const root = dir();
  const journal = new WorkerJournal(path.join(root, "episode.jsonl"));
  const order: string[] = [];
  const broker = new FakeBroker([
    result({ role: "assistant", content: "finished" }),
  ]);
  const originalFinish = broker.finish.bind(broker);
  broker.finish = async (key, body) => {
    order.push("finish");
    assert.equal(journal.state().pendingFinish?.key, key);
    await originalFinish(key, body);
  };
  await new WorkerEpisode({
    broker,
    journal,
    sandbox: {
      async run() {
        throw new Error("not called");
      },
    },
    async beforeFinish(value) {
      order.push("custody");
      assert.equal(value.body, "finished");
      assert.equal(journal.state().pendingFinish, null);
    },
  }).run();
  assert.deepEqual(order, ["custody", "finish"]);
  journal.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("custody failure leaves no prepared finish or dispatcher result", async () => {
  const root = dir();
  const journal = new WorkerJournal(path.join(root, "episode.jsonl"));
  const broker = new FakeBroker([
    result({ role: "assistant", content: "finished" }),
  ]);
  await assert.rejects(
    () =>
      new WorkerEpisode({
        broker,
        journal,
        sandbox: {
          async run() {
            throw new Error("not called");
          },
        },
        async beforeFinish() {
          throw new Error("artifact upload failed");
        },
      }).run(),
    /artifact upload failed/,
  );
  assert.equal(journal.state().pendingFinish, null);
  assert.equal(journal.state().finished, null);
  assert.equal(broker.finishes.length, 0);
  journal.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker rejects wake and sandbox fields before code execution", async () => {
  const root = dir();
  const journal = new WorkerJournal(path.join(root, "episode.jsonl"));
  const broker = new FakeBroker([
    runTurn("bad-call", {
      code: "danger()",
      detail: "try forbidden fields",
      wake: { auto: true },
    }),
    result({ role: "assistant", content: "Rejected the invalid request." }),
  ]);
  let executions = 0;
  const finished = await new WorkerEpisode({
    broker,
    journal,
    sandbox: {
      async run() {
        executions++;
        return { ok: true };
      },
    },
  }).run();
  assert.equal(finished.turns, 2);
  assert.equal(executions, 0);
  const tool = broker.requests[1].find((message) => message.role === "tool");
  assert.match(tool?.content ?? "", /exactly code, detail/);
  assert.equal(journal.state().pendingTools.size, 0);
  journal.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("sandbox transport failure leaves a prepared tool ambiguous", async () => {
  const root = dir();
  const file = path.join(root, "episode.jsonl");
  const journal = new WorkerJournal(file);
  const broker = new FakeBroker([
    runTurn("ambiguous-call", { code: "effect()", detail: "perform effect" }),
  ]);
  const episode = new WorkerEpisode({
    broker,
    journal,
    sandbox: {
      async run() {
        throw new Error("transport lost");
      },
    },
  });
  await assert.rejects(() => episode.run(), /transport lost/);
  assert.equal(journal.state().pendingTools.has("ambiguous-call"), true);
  journal.close();

  const reopened = new WorkerJournal(file);
  const untouched = new FakeBroker([]);
  await assert.rejects(
    () =>
      new WorkerEpisode({
        broker: untouched,
        journal: reopened,
        sandbox: {
          async run() {
            return { ok: true };
          },
        },
      }).run(),
    (error: unknown) =>
      error instanceof WorkerEpisodeError && error.code === "ambiguous_tool",
  );
  assert.equal(untouched.requests.length, 0);
  reopened.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("prepared finish is retried with the same key and body", async () => {
  const root = dir();
  const file = path.join(root, "episode.jsonl");
  const journal = new WorkerJournal(file);
  journal.initialize([
    { role: "system", content: "worker" },
    { role: "user", content: "mandate" },
  ]);
  journal.appendMessage({ role: "assistant", content: "finished body" });
  journal.prepareFinish("worker-finish-fixed", "finished body");
  journal.close();

  const reopened = new WorkerJournal(file);
  const broker = new FakeBroker([]);
  const result = await new WorkerEpisode({
    broker,
    journal: reopened,
    sandbox: {
      async run() {
        throw new Error("not called");
      },
    },
  }).run();
  assert.deepEqual(broker.finishes, [
    { key: "worker-finish-fixed", body: "finished body" },
  ]);
  assert.equal(result.turns, 0);
  assert.equal(reopened.state().pendingFinish, null);
  assert.equal(reopened.state().finished?.key, "worker-finish-fixed");
  reopened.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker journal refuses a partial final record", () => {
  const root = dir();
  const file = path.join(root, "episode.jsonl");
  fs.writeFileSync(file, '{"type":"message"');
  assert.throws(() => new WorkerJournal(file), /partial record/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("detached worker tool remains prepared and cannot be replayed", async () => {
  const root = dir();
  const file = path.join(root, "episode.jsonl");
  const journal = new WorkerJournal(file);
  const broker = new FakeBroker([
    runTurn("call-detached", {
      code: "await new Promise(() => {})",
      detail: "wait forever",
    }),
  ]);
  const options = {
    broker,
    journal,
    sandbox: {
      async run() {
        return { ok: true, detached: true, note: "still running" };
      },
    },
  };
  await assert.rejects(
    () => new WorkerEpisode(options).run(),
    /detached before completion.*ambiguous/,
  );
  assert.deepEqual([...journal.state().pendingTools.keys()], ["call-detached"]);
  journal.close();

  const reopened = new WorkerJournal(file);
  await assert.rejects(
    () => new WorkerEpisode({ ...options, journal: reopened }).run(),
    (error: unknown) =>
      error instanceof WorkerEpisodeError && error.code === "ambiguous_tool",
  );
  reopened.close();
  fs.rmSync(root, { recursive: true, force: true });
});
