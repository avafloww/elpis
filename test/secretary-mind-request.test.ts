import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchSecretaryMindRequest,
  SecretaryMindRequestError,
  type SecretaryMindService,
} from "../src/secretary/mind-request.js";
import type { SecretaryProposalInput } from "../src/secretary/mind.js";

function service() {
  const proposals: SecretaryProposalInput[] = [];
  const reads: unknown[][] = [];
  const value: SecretaryMindService = {
    get(...args) {
      reads.push(args);
      return { binding: {} as never, item: {} as never };
    },
    tree(...args) {
      reads.push(args);
      return {} as never;
    },
    propose(_token, input) {
      proposals.push(input);
      return { binding: {} as never, item: {} as never };
    },
  };
  return { value, proposals, reads };
}

function rejected(value: unknown): void {
  const f = service();
  assert.throws(
    () => dispatchSecretaryMindRequest(f.value, "token", value),
    (error) => error instanceof SecretaryMindRequestError,
  );
  assert.deepEqual(f.proposals, []);
  assert.deepEqual(f.reads, []);
}

test("proposal dispatcher passes only one bounded fixed write shape", () => {
  const f = service();
  dispatchSecretaryMindRequest(f.value, "token", {
    protocol: 1,
    operation: "propose",
    title: "  Candidate title  ",
    body: "candidate body",
    kind: "idea",
    priority: 4,
    parentId: null,
    tags: ["intake"],
  });
  assert.deepEqual(f.proposals, [
    {
      title: "Candidate title",
      body: "candidate body",
      kind: "idea",
      priority: 4,
      parentId: null,
      tags: ["intake"],
    },
  ]);
  assert.deepEqual(f.reads, []);
});

test("proposal dispatcher rejects caller authority and lifecycle fields pre-effect", () => {
  for (const [field, value] of Object.entries({
    status: "open",
    actor: "operator",
    sessionId: "sec-spoof",
    requester: "admin",
    source: "trusted",
    dueAt: 1,
    dependsOn: ["elm-00000001"],
    operationName: "update",
  }))
    rejected({
      protocol: 1,
      operation: "propose",
      title: "candidate",
      [field]: value,
    });
});

test("proposal dispatcher rejects malformed and oversized proposal fields pre-effect", () => {
  for (const value of [
    { protocol: 1, operation: "propose" },
    { protocol: 1, operation: "propose", title: " " },
    { protocol: 1, operation: "propose", title: "x".repeat(241) },
    { protocol: 1, operation: "propose", title: "x", body: 7 },
    { protocol: 1, operation: "propose", title: "x", kind: "command" },
    { protocol: 1, operation: "propose", title: "x", priority: 5 },
    { protocol: 1, operation: "propose", title: "x", parentId: "elm-short" },
    { protocol: 1, operation: "propose", title: "x", tags: [""] },
  ])
    rejected(value);
});

test("read operations retain exact bounded request shapes", () => {
  const f = service();
  dispatchSecretaryMindRequest(f.value, "token", {
    protocol: 1,
    operation: "get",
    id: "elm-00000001",
  });
  dispatchSecretaryMindRequest(f.value, "token", {
    protocol: 1,
    operation: "tree",
    depth: 2,
    limit: 3,
  });
  assert.deepEqual(f.reads, [
    ["token", "elm-00000001"],
    ["token", undefined, 2, 3],
  ]);
  assert.deepEqual(f.proposals, []);
});
