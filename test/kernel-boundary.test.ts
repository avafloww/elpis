import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const forbidden = [
  "/agent.js",
  "/types.js",
  "/discord/",
  "/store/memory.js",
  "/store/soul.js",
  "/store/scheduler.js",
  "/store/channels.js",
  "/store/mutes.js",
];

test("kernel modules do not depend on resident continuity or social ingress", () => {
  const root = path.resolve("src/kernel");
  const files = fs.readdirSync(root).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "kernel must contain at least one module");
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const dependency of forbidden) {
      assert.equal(
        source.includes(dependency),
        false,
        `${file} imports resident dependency ${dependency}`,
      );
    }
  }
});
