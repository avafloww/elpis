import assert from "node:assert/strict";
import test from "node:test";
import {
  adviseWake,
  buildWakeAdvisorHistory,
  fallbackWakeAdvice,
  snapshotWakeAdvisorState,
  WAKE_ADVISOR_BUCKETS_MS,
  WAKE_ADVISOR_TIMEOUT_MS,
  type WakeAdvisorState,
} from "../src/sandbox/wake-advisor.js";
import type { SandboxDeps } from "../src/types.js";

const quiet: WakeAdvisorState = {
  turnKind: "autonomous",
  sendsThisTurn: 0,
  ranCode: false,
  continuedMindId: null,
  inProgress: [],
  ready: [],
  waiting: [],
  runningBg: 0,
  nextScheduledInMs: null,
};
const logger = { debug() {}, warn() {} };

function completion(content: string) {
  return {
    content,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

test("wake advisor exposes exactly the approved autonomy cadence buckets", () => {
  assert.deepEqual(
    WAKE_ADVISOR_BUCKETS_MS,
    [0, 1, 2, 5, 10, 15, 30, 45, 60].map((minutes) => minutes * 60_000),
  );
  assert.equal(WAKE_ADVISOR_TIMEOUT_MS, 30_000);
});

test("wake advisor snapshot is bounded to work facts and ignores reserved run wakes", () => {
  const mind = {
    list(filter: any) {
      if (filter.ready)
        return [{ id: "elm-b2b3k7q9", title: " ready   thing " }];
      if (filter.statuses?.includes("in_progress"))
        return [
          { id: "elm-a2b3k7q9", title: "ship\nthing" },
          { id: "elm-c2b3k7q9", title: "x".repeat(200) },
        ];
      if (filter.statuses?.includes("waiting"))
        return [{ id: "elm-d2b3k7q9", title: "wait" }];
      return [];
    },
  };
  const deps = {
    mind,
    bg: { list: () => [{ running: true }, { running: false }] },
    scheduler: {
      list: () => [
        { name: "__elpis_run_wake_v3__-old", nextRunAt: 10_100, doneAt: null },
        { name: "real", nextRunAt: 40_000, doneAt: null },
      ],
    },
  } as unknown as Pick<SandboxDeps, "mind" | "bg" | "scheduler">;
  const state = snapshotWakeAdvisorState(
    deps,
    {
      turnKind: "person",
      sendsThisTurn: 1,
      ranCode: false,
      continuedMindId: null,
    },
    10_000,
  );
  assert.deepEqual(state.inProgress[0], {
    id: "elm-a2b3k7q9",
    title: "ship thing",
  });
  assert.equal(state.inProgress[1]?.title.length, 120);
  assert.deepEqual(state.ready, [
    { id: "elm-b2b3k7q9", title: " ready thing " },
  ]);
  assert.equal(state.runningBg, 1);
  assert.equal(state.nextScheduledInMs, 30_000);
});

test("wake advisor history keeps the latest three same-channel model cycles", () => {
  const ended = (id: string, channel: string, code = "return 1") =>
    [
      { role: "user", content: `wake ${id}`, channel },
      {
        role: "assistant",
        content: `response ${id}`,
        channel,
        reasoning_content: `summary ${id}`,
        reasoning_items: [
          { type: "reasoning", summary: [], encrypted_content: `opaque-${id}` },
        ],
        tool_calls: [
          {
            id,
            type: "function",
            function: {
              name: "run",
              arguments: JSON.stringify({
                code,
                detail: `detail ${id}`,
                wake: { auto: true },
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: id,
        content: `[run ok] ${id}`,
        channel,
        run: {
          toolContractVersion: 4,
          ok: true,
          wake: { kind: "auto", state: "armed", requestedAt: 1, targetAt: 2 },
        },
      },
    ] as any[];
  const messages = [
    ...ended("other", "other-room"),
    ...ended("old", "room"),
    ...ended("middle", "room"),
    { role: "user", content: "current wake", channel: "room" },
    {
      role: "assistant",
      content: "current response",
      channel: "room",
      reasoning_items: [
        { type: "reasoning", summary: [], encrypted_content: "opaque-current" },
      ],
      tool_calls: [
        {
          id: "current",
          type: "function",
          function: {
            name: "run",
            arguments: JSON.stringify({
              code: "x".repeat(10_000),
              detail: "current detail",
              wake: { auto: true },
            }),
          },
        },
      ],
    },
  ] as any[];
  const history = buildWakeAdvisorHistory(messages, "room", {
    role: "tool",
    tool_call_id: "current",
    content: "y".repeat(10_000),
    run: { toolContractVersion: 4, ok: true },
  } as any);
  assert.equal(
    history.some((message) => message.content.includes("other")),
    false,
  );
  assert.deepEqual(
    history
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["wake old", "wake middle", "current wake"],
  );
  assert.deepEqual(
    history
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id),
    ["old", "middle", "current"],
  );
  assert.equal(
    history
      .filter((message) => message.role === "assistant")
      .every((message) => message.reasoning_items?.length === 1),
    true,
  );
  const current = history.find(
    (message) =>
      message.role === "assistant" && message.tool_calls?.[0]?.id === "current",
  )!;
  assert.ok(current.tool_calls![0].function.arguments.length < 5_000);
  assert.match(current.tool_calls![0].function.arguments, /omitted sha256=/);
  assert.ok(history.at(-1)!.content.length < 5_000);
  assert.match(history.at(-1)!.content, /omitted sha256=/);
});

test("wake advisor keeps exactly the newest three tool cycles inside one outer turn", () => {
  const messages: any[] = [{ role: "user", content: "start", channel: "room" }];
  for (let index = 0; index < 4; index++) {
    const id = `tool-cycle-${index}`;
    messages.push({
      role: "assistant",
      content: `cycle ${index}`,
      channel: "room",
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "run",
            arguments: JSON.stringify({
              code: `return ${index}`,
              detail: `cycle ${index}`,
            }),
          },
        },
      ],
    });
    if (index < 3)
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: `[run ok] ${index}`,
        channel: "room",
        run: { toolContractVersion: 4, ok: true },
      });
  }
  const history = buildWakeAdvisorHistory(messages, "room", {
    role: "tool",
    tool_call_id: "tool-cycle-3",
    content: "[run ok] 3",
    run: { toolContractVersion: 4, ok: true },
  } as any);
  assert.deepEqual(
    history
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.id),
    ["tool-cycle-1", "tool-cycle-2", "tool-cycle-3"],
  );
  assert.deepEqual(
    history
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id),
    ["tool-cycle-1", "tool-cycle-2", "tool-cycle-3"],
  );
});

test("wake advisor counts one plain response plus two tool generations as three cycles", () => {
  const messages: any[] = [
    { role: "user", content: "old request", channel: "room" },
    { role: "assistant", content: "old plain response", channel: "room" },
    { role: "user", content: "selected plain request", channel: "room" },
    { role: "assistant", content: "selected plain response", channel: "room" },
    { role: "user", content: "first tool request", channel: "room" },
    {
      role: "assistant",
      content: "first tool response",
      channel: "room",
      tool_calls: [
        {
          id: "mixed-1",
          type: "function",
          function: { name: "run", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "mixed-1",
      content: "[run ok] one",
      channel: "room",
      run: { toolContractVersion: 4, ok: true },
    },
    {
      role: "assistant",
      content: "second tool response",
      channel: "room",
      tool_calls: [
        {
          id: "mixed-2",
          type: "function",
          function: { name: "run", arguments: "{}" },
        },
      ],
    },
  ];
  const history = buildWakeAdvisorHistory(messages, "room", {
    role: "tool",
    tool_call_id: "mixed-2",
    content: "[run ok] two",
    run: { toolContractVersion: 4, ok: true },
  } as any);
  assert.deepEqual(
    history
      .filter((message) => message.role === "assistant")
      .map((message) => message.content),
    ["selected plain response", "first tool response", "second tool response"],
  );
  assert.deepEqual(
    history
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id),
    ["mixed-1", "mixed-2"],
  );
  assert.equal(
    history.some((message) => message.content === "old plain response"),
    false,
  );
  assert.equal(
    history.some((message) => message.content === "selected plain request"),
    true,
  );
});

test("wake advisor hard-bounds one oversized turn without orphaning tool chains", () => {
  const messages: any[] = [
    { role: "user", content: "one long current turn", channel: "room" },
  ];
  for (let index = 0; index < 12; index++) {
    const id = `cycle-${index}`;
    messages.push({
      role: "assistant",
      content: `assistant-${index}-` + "a".repeat(8_000),
      channel: "room",
      reasoning_items: [
        {
          type: "reasoning",
          summary: [],
          encrypted_content: "r".repeat(3_000),
        },
      ],
      tool_calls: [
        {
          id,
          type: "function",
          function: {
            name: "run",
            arguments: JSON.stringify({
              code: "x".repeat(10_000),
              detail: `cycle ${index}`,
            }),
          },
        },
      ],
    });
    if (index < 11)
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: `tool-${index}-` + "y".repeat(10_000),
        channel: "room",
        run: { toolContractVersion: 4, ok: true },
      });
  }
  const history = buildWakeAdvisorHistory(messages, "room", {
    role: "tool",
    tool_call_id: "cycle-11",
    content: "tool-11-" + "z".repeat(10_000),
    run: { toolContractVersion: 4, ok: true },
  } as any);
  const visible = history.reduce(
    (sum, message) =>
      sum +
      message.content.length +
      (message.tool_calls ?? []).reduce(
        (callSum, call) => callSum + call.function.arguments.length,
        0,
      ),
    0,
  );
  assert.ok(visible <= 48_000, `visible history exceeded hard cap: ${visible}`);
  const calls = history
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.id);
  const outputs = history
    .filter((message) => message.role === "tool")
    .map((message) => message.tool_call_id);
  assert.deepEqual(outputs, calls);
  assert.equal(calls.at(-1), "cycle-11");
  assert.equal(calls.includes("cycle-0"), false);
});

test("wake advisor drops incomplete tool edges even when the visible tail is under cap", () => {
  const messages: any[] = [
    { role: "user", content: "partial older edge", channel: "room" },
    {
      role: "assistant",
      content: "unfinished but readable",
      channel: "room",
      tool_calls: [
        {
          id: "missing",
          type: "function",
          function: { name: "run", arguments: "{}" },
        },
      ],
    },
    { role: "user", content: "current", channel: "room" },
    {
      role: "assistant",
      content: "current response",
      channel: "room",
      tool_calls: [
        {
          id: "current-edge",
          type: "function",
          function: { name: "run", arguments: "{}" },
        },
      ],
    },
  ];
  const history = buildWakeAdvisorHistory(messages, "room", {
    role: "tool",
    tool_call_id: "current-edge",
    content: "[run ok]",
    run: { toolContractVersion: 4, ok: true },
  } as any);
  const calls = history
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.id);
  const outputs = history
    .filter((message) => message.role === "tool")
    .map((message) => message.tool_call_id);
  assert.deepEqual(calls, ["current-edge"]);
  assert.deepEqual(outputs, calls);
  assert.equal(
    history.some((message) => message.content === "unfinished but readable"),
    true,
  );
});

test("wake advisor fits the newest complete subset of one oversized multi-call generation", () => {
  const calls = Array.from({ length: 12 }, (_, index) => ({
    id: `multi-${index}`,
    type: "function",
    function: {
      name: "run",
      arguments: JSON.stringify({
        code: "x".repeat(10_000),
        detail: `multi ${index}`,
      }),
    },
  }));
  const messages: any[] = [
    { role: "user", content: "one oversized generation", channel: "room" },
    {
      role: "assistant",
      content: "parallel calls",
      channel: "room",
      tool_calls: calls,
    },
    ...calls.slice(0, -1).map((call) => ({
      role: "tool",
      tool_call_id: call.id,
      content: "y".repeat(10_000),
      channel: "room",
      run: { toolContractVersion: 4, ok: true },
    })),
  ];
  const history = buildWakeAdvisorHistory(messages, "room", {
    role: "tool",
    tool_call_id: calls.at(-1)!.id,
    content: "z".repeat(10_000),
    run: { toolContractVersion: 4, ok: true },
  } as any);
  const visible = history.reduce(
    (sum, message) =>
      sum +
      message.content.length +
      (message.tool_calls ?? []).reduce(
        (callSum, call) => callSum + call.function.arguments.length,
        0,
      ),
    0,
  );
  assert.ok(visible <= 48_000, `visible history exceeded hard cap: ${visible}`);
  const keptCalls = history
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.id);
  const keptOutputs = history
    .filter((message) => message.role === "tool")
    .map((message) => message.tool_call_id);
  assert.deepEqual(keptOutputs, keptCalls);
  assert.equal(keptCalls.at(-1), "multi-11");
  assert.equal(keptCalls.includes("multi-0"), false);
});

test("wake advisor sends bounded historical tool context with authoritative current state", async () => {
  let cacheKey = "";
  let prompt = "";
  let captured: any[] = [];
  let options: any;
  const history = [
    { role: "user", content: "prior wake" },
    {
      role: "assistant",
      content: "checked job",
      tool_calls: [
        {
          id: "c",
          type: "function",
          function: { name: "run", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c", content: "[run ok] still running" },
  ] as any[];
  const deps = {
    completeStandalone: async (messages: any[], opts: any) => {
      captured = messages;
      options = opts;
      cacheKey = opts.cacheKey;
      prompt = messages.at(-1).content;
      return completion('{"minutes":5,"reason":"background-wait"}');
    },
  } as Pick<SandboxDeps, "completeStandalone">;
  const result = await adviseWake(
    deps,
    { ...quiet, runningBg: 1, inProgress: [{ id: 7, title: "keep going" }] },
    logger,
    100,
    history,
  );
  assert.deepEqual(result, {
    delayMs: 300_000,
    reason: "background-wait",
    source: "classifier",
  });
  assert.match(cacheKey, /^wake-advisor-/);
  assert.equal(options.allowHistoricalToolMessages, true);
  assert.deepEqual(captured.slice(1, -1), history);
  assert.match(prompt, /"runningBg":1/);
  assert.match(captured[0].content, /current structured state.*outranks/i);
});

test("wake advisor accepts zero only as immediate continuation", async () => {
  let system = "";
  const result = await adviseWake(
    {
      completeStandalone: async (messages: any[]) => {
        system = messages[0].content;
        return completion('{"minutes":0,"reason":"active-work"}');
      },
    },
    {
      ...quiet,
      ranCode: true,
      continuedMindId: "elm-a2b3k7q9",
      inProgress: [{ id: "elm-a2b3k7q9", title: "continue now" }],
    },
    logger,
    100,
    [{ role: "assistant", content: "I am continuing immediately." }],
  );
  assert.deepEqual(result, {
    delayMs: 0,
    reason: "active-work",
    source: "classifier",
  });
  assert.match(system, /Zero means continue immediately/);
  assert.match(system, /stop, rest, exit the loop, or wait/);
  assert.match(system, /never means no future wake/);
});

test("wake advisor failure and nonconforming output fall back deterministically without failing yield", async () => {
  const active = { ...quiet, inProgress: [{ id: 7, title: "work" }] };
  assert.deepEqual(fallbackWakeAdvice(active), {
    delayMs: 300_000,
    reason: "active-work",
    source: "fallback",
  });
  assert.deepEqual(
    fallbackWakeAdvice({ ...active, ranCode: true, continuedMindId: 7 }),
    { delayMs: 120_000, reason: "active-work", source: "fallback" },
  );
  assert.deepEqual(
    fallbackWakeAdvice({
      ...active,
      ranCode: true,
      continuedMindId: 7,
      runningBg: 1,
    }),
    { delayMs: 300_000, reason: "background-wait", source: "fallback" },
  );
  const malformed = await adviseWake(
    {
      completeStandalone: async () =>
        completion('{"minutes":3,"reason":"active-work"}'),
    },
    active,
    logger,
    100,
  );
  assert.deepEqual(malformed, fallbackWakeAdvice(active));
  const timedOut = await adviseWake(
    { completeStandalone: async () => await new Promise(() => {}) },
    quiet,
    logger,
    5,
  );
  assert.deepEqual(timedOut, {
    delayMs: 3_600_000,
    reason: "quiet-exploration",
    source: "fallback",
  });
  const warnings: string[] = [];
  const failed = await adviseWake(
    {
      completeStandalone: async () => {
        throw new Error("classifier lane broke");
      },
    },
    quiet,
    {
      debug() {},
      warn(message: string) {
        warnings.push(message);
      },
    },
    100,
  );
  assert.deepEqual(failed, fallbackWakeAdvice(quiet));
  assert.deepEqual(warnings, [
    "wake advisor unavailable: classifier lane broke",
  ]);
});
