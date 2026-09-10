import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LLM_PROXY_PATHS,
  newLlmTargetGeneration,
} from '@elpis/gateway-protocol';
import {
  parseGenerationProvenance,
  sameReplayIdentity,
  stampGeneration,
  TOOL_CONTRACT_VERSION,
} from '../src/llm/provenance.js';
import type { ChatMessage } from '../src/llm/llm.js';
import {
  createTranscriptStore,
  loadMostRecentMain,
  MAIN_TRANSCRIPT_ID,
} from '../src/store/sessions.js';

const authority = 'https://gateway.example.com/';
const generation = newLlmTargetGeneration((size) =>
  new Uint8Array(size).fill(1),
);
const nextGeneration = newLlmTargetGeneration((size) =>
  new Uint8Array(size).fill(2),
);
const gateway = {
  authority,
  modelRef: 'team/main',
  targetGeneration: generation,
};
const identity = () => ({
  providerType: 'openai-compatible' as const,
  model: 'upstream-model',
  apiSurface: 'responses' as const,
  apiEndpoint: new URL(LLM_PROXY_PATHS.request, authority).href,
  toolContractVersion: TOOL_CONTRACT_VERSION,
  gateway: { ...gateway },
});
const provenance = () => ({
  ...identity(),
  generatedAt: '2026-01-01T00:00:00.000Z',
  harnessCommit: 'fixture-commit',
  requestId: 'fixture-request',
});

test('managed provenance stamp and JSON parser preserve the whole Gateway identity', () => {
  const message: ChatMessage = { role: 'assistant', content: 'visible answer' };
  const stamp = provenance();
  stampGeneration(message, stamp);
  assert.deepEqual(message.provenance, stamp);
  assert.deepEqual(
    parseGenerationProvenance(JSON.parse(JSON.stringify(stamp))),
    stamp,
  );
});
test('parsed managed attribution preserves actual upstream provider and surface', () => {
  for (const target of [
    { providerType: 'openai-compatible', apiSurface: 'chat-completions' },
    { providerType: 'anthropic-oauth', apiSurface: 'anthropic-messages' },
    { providerType: 'codex-oauth', apiSurface: 'codex-responses' },
  ]) {
    const raw = { ...provenance(), ...target };
    assert.deepEqual(parseGenerationProvenance(raw), raw);
  }
});
test('direct provenance remains parseable without a Gateway tuple', () => {
  const { gateway: _gateway, ...direct } = provenance();
  assert.deepEqual(parseGenerationProvenance(direct), direct);
});
for (const key of ['authority', 'modelRef', 'targetGeneration']) {
  test('partial Gateway provenance fails parsing: missing ' + key, () => {
    const partial: Record<string, unknown> = { ...gateway };
    delete partial[key];
    assert.equal(
      parseGenerationProvenance({ ...provenance(), gateway: partial }),
      undefined,
    );
  });
}
for (const tuple of [
  null,
  [],
  'gateway',
  {},
  { ...gateway, authority: 'not-an-authority' },
  { ...gateway, modelRef: 'team/main/extra' },
  { ...gateway, modelRef: 'Team/main' },
  { ...gateway, targetGeneration: 'revision-1' },
  { ...gateway, targetGeneration: '' },
]) {
  test(
    'malformed Gateway provenance fails parsing: ' + JSON.stringify(tuple),
    () => {
      assert.equal(
        parseGenerationProvenance({ ...provenance(), gateway: tuple }),
        undefined,
      );
    },
  );
}
for (const [label, changed] of [
  ['authority', { ...gateway, authority: 'https://other.example.com/' }],
  ['model ref', { ...gateway, modelRef: 'team/other' }],
  ['target generation', { ...gateway, targetGeneration: nextGeneration }],
] as const) {
  test('replay equality includes Gateway ' + label, () => {
    assert.equal(
      sameReplayIdentity(identity(), { ...identity(), gateway: changed }),
      false,
    );
  });
}
test('replay equality includes the tool contract', () => {
  assert.equal(
    sameReplayIdentity(identity(), {
      ...identity(),
      toolContractVersion: 'other-contract',
    }),
    false,
  );
});
test('missing and present Gateway identities differ in both directions', () => {
  const { gateway: _gateway, ...direct } = identity();
  assert.equal(sameReplayIdentity(direct, identity()), false);
  assert.equal(sameReplayIdentity(identity(), direct), false);
});
test('replay identity ignores catalog revision, credential epoch, and diagnostic attribution', () => {
  const before = { ...provenance(), catalogRevision: 1, credentialEpoch: 1 };
  const after = {
    ...provenance(),
    catalogRevision: 2,
    credentialEpoch: 2,
    harnessCommit: 'other-commit',
    requestId: 'other-request',
    generatedAt: '2026-01-02T00:00:00.000Z',
  };
  assert.equal(sameReplayIdentity(before, after), true);
});
test('transcript restoration strips opaque state on target generation change but keeps visible history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-replay-'));
  try {
    const message: ChatMessage = {
      role: 'assistant',
      content: 'visible answer',
      provenance: provenance(),
      reasoning_items: [
        { type: 'reasoning', summary: [], encrypted_content: 'fixture-opaque' },
      ],
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"1"}' },
        },
      ],
    };
    createTranscriptStore(root).append(MAIN_TRANSCRIPT_ID, message);
    const same = loadMostRecentMain(root, { opaqueReplayIdentity: identity() })!
      .messages[0];
    assert.deepEqual(same.provenance, message.provenance);
    assert.deepEqual(same.reasoning_items, message.reasoning_items);
    const changed = {
      ...identity(),
      gateway: { ...gateway, targetGeneration: nextGeneration },
    };
    const restored = loadMostRecentMain(root, {
      opaqueReplayIdentity: changed,
    })!.messages[0];
    assert.equal(restored.reasoning_items, undefined);
    assert.equal(restored.content, message.content);
    assert.deepEqual(restored.tool_calls, message.tool_calls);
    assert.deepEqual(restored.provenance, message.provenance);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
