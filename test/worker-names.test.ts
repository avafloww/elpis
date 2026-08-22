import assert from "node:assert/strict";
import test from "node:test";
import {
  generateWorkerSlug,
  newWorkerId,
  validateWorkerSlug,
} from "../src/worker/names.js";

test("newWorkerId uses the reserved wrk namespace", () => {
  assert.match(newWorkerId(), /^wrk-[a-z0-9]{8}$/);
});

test("newWorkerId generates unique ids", () => {
  const ids = new Set(Array.from({ length: 100 }, () => newWorkerId()));
  assert.equal(ids.size, 100);
});

test("generateWorkerSlug avoids taken slugs", () => {
  const taken = new Set<string>();
  for (let i = 0; i < 700; i++) {
    const slug = generateWorkerSlug(taken);
    assert.equal(taken.has(slug), false);
    validateWorkerSlug(slug);
    taken.add(slug);
  }
});

test("validateWorkerSlug rejects malformed or reserved slugs", () => {
  for (const slug of [
    "",
    "has space",
    "UpperCase",
    "wrk-claimed",
    "a".repeat(81),
  ]) {
    assert.throws(() => validateWorkerSlug(slug));
  }
  assert.doesNotThrow(() => validateWorkerSlug("quiet-otter"));
});
