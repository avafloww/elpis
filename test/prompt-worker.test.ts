import assert from "node:assert/strict";
import test from "node:test";
import { build } from "../src/llm/prompt.js";

const baseInputs = {
  soul: "",
  memory: "",
  now: "",
  harnessRoot: "/tmp",
  dataDirectory: "/tmp",
};

test("disabled worker section is explicit without advertising verbs", () => {
  const prompt = build(baseInputs);
  assert.match(prompt, /### `elpis\.worker`/);
  assert.match(prompt, /workers are disabled in config/i);
  assert.doesNotMatch(prompt, /elpis\.worker\.start/);
  assert.doesNotMatch(prompt, /elpis\.fleet/);
});

test("enabled worker section is Mind-rooted and has no arbitrary prompt field", () => {
  const prompt = build({ ...baseInputs, workersEnabled: true });
  assert.match(prompt, /elpis\.worker\.start\(mindId, \{ modelRef\? \}\)/);
  assert.match(prompt, /there is no arbitrary prompt field/);
  assert.match(prompt, /elpis\.worker\.send\(ref, text\)/);
  assert.match(prompt, /elpis\.worker\.dismiss\(ref\)/);
  assert.match(prompt, /fixed restricted Pod/);
  assert.doesNotMatch(prompt, /Claude Code|elpis\.fleet/);
});
