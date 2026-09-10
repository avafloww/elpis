import test from 'node:test';
import assert from 'node:assert/strict';
import { newLlmTargetGeneration } from '@elpis/gateway-protocol';
import {
  canonicalGatewayAuthority,
  parseGenerationProvenance,
  sameReplayIdentity,
  stampGeneration,
  TOOL_CONTRACT_VERSION,
} from '../src/llm/provenance.js';
import type { ChatMessage } from '../src/llm/llm.js';

const gateway = {
  authority: 'https://gateway.example.com/',
  modelRef: 'team/main',
  targetGeneration: newLlmTargetGeneration((size) =>
    new Uint8Array(size).fill(3),
  ),
};
const identity = {
  providerType: 'openai-compatible' as const,
  model: 'upstream-model',
  apiSurface: 'responses' as const,
  apiEndpoint: 'https://gateway.example.com/api/v1/resident/llm/request',
  toolContractVersion: TOOL_CONTRACT_VERSION,
  gateway,
};

for (const authority of [
  'http://gateway.example.com/',
  'https://user:password@gateway.example.com/',
  'https://gateway.example.com/upstream',
  'https://gateway.example.com/?token=fixture',
  'https://gateway.example.com/#fixture',
]) {
  test('reject non-authority replay URL: ' + authority, () => {
    assert.throws(() => canonicalGatewayAuthority(authority));
    const raw = {
      ...identity,
      gateway: { ...gateway, authority },
      generatedAt: '2026-01-01T00:00:00Z',
      harnessCommit: 'fixture',
    };
    assert.equal(parseGenerationProvenance(raw), undefined);
    assert.equal(sameReplayIdentity(raw, raw), false);
    const message: ChatMessage = { role: 'assistant', content: 'visible' };
    assert.throws(
      () => stampGeneration(message, raw),
      /Gateway replay identity/,
    );
    assert.equal(message.provenance, undefined);
  });
}

test('authority canonicalization does not make origin spelling part of identity', () => {
  const alternate = {
    ...identity,
    gateway: { ...gateway, authority: 'https://GATEWAY.example.com:443' },
  };
  assert.equal(sameReplayIdentity(identity, alternate), true);
});

test('stamping owns the Gateway tuple and preserves the explicit tool contract', () => {
  const tuple = { ...gateway };
  const message: ChatMessage = { role: 'assistant', content: 'visible' };
  stampGeneration(message, {
    ...identity,
    gateway: tuple,
    toolContractVersion: 'fixture-contract',
  });
  tuple.modelRef = 'team/other';
  assert.deepEqual(message.provenance?.gateway, gateway);
  assert.equal(message.provenance?.toolContractVersion, 'fixture-contract');
});

test('missing tool contract and invalid endpoints fail replay closed', () => {
  const { toolContractVersion: _contract, ...missing } = identity;
  assert.equal(
    sameReplayIdentity(missing as typeof identity, missing as typeof identity),
    false,
  );
  assert.equal(
    sameReplayIdentity(identity, { ...identity, apiEndpoint: 'invalid' }),
    false,
  );
});

for (const apiEndpoint of [
  'https://unrelated.example.com/api/v1/resident/llm/request',
  'https://gateway.example.com/responses',
  identity.apiEndpoint + '?token=fixture',
  identity.apiEndpoint + '#fixture',
  identity.apiEndpoint + '?',
  identity.apiEndpoint + '#',
  identity.apiEndpoint.replace('https://', 'https://user:password@'),
  identity.apiEndpoint.replace('/request', '/other/../request'),
]) {
  test('managed endpoint must be exactly bound: ' + apiEndpoint, () => {
    const raw = {
      ...identity,
      apiEndpoint,
      generatedAt: 'historical',
      harnessCommit: 'fixture',
    };
    assert.equal(parseGenerationProvenance(raw), undefined);
    assert.equal(sameReplayIdentity(raw, raw), false);
    assert.equal(sameReplayIdentity(raw, identity), false);
    const message: ChatMessage = { role: 'assistant', content: 'visible' };
    stampGeneration(message, identity);
    const before = message.provenance;
    assert.throws(
      () => stampGeneration(message, raw),
      /Gateway replay identity/,
    );
    assert.equal(message.provenance, before);
  });
}

test('canonical equivalent authority binds the canonical endpoint for parse and stamp', () => {
  const raw = {
    ...identity,
    gateway: { ...gateway, authority: 'https://GATEWAY.example.com:443' },
    generatedAt: 'historical',
    harnessCommit: 'fixture',
  };
  assert.deepEqual(parseGenerationProvenance(raw)?.gateway, gateway);
  const message: ChatMessage = { role: 'assistant', content: '' };
  stampGeneration(message, raw);
  assert.deepEqual(message.provenance?.gateway, gateway);
});

test('captured URL constructor and getters resist post-import poisoning', () => {
  const OriginalURL = globalThis.URL;
  const descriptor = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const keys = [
    'protocol',
    'username',
    'password',
    'pathname',
    'search',
    'hash',
    'href',
  ] as const;
  const saved = keys.map(
    (key) => [key, descriptor(OriginalURL.prototype, key)!] as const,
  );
  const invalid = {
    ...identity,
    gateway: {
      ...gateway,
      authority: 'http://user:secret@gateway.example.com/wrong?query#hash',
    },
    generatedAt: 'historical',
    harnessCommit: 'fixture',
  };
  let parsed: unknown, replay: unknown, endpointReplay: unknown, valid: unknown;
  let threw = false;
  try {
    for (const key of keys)
      define(OriginalURL.prototype, key, {
        configurable: true,
        get: () =>
          ({
            protocol: 'https:',
            username: '',
            password: '',
            pathname: '/',
            search: '',
            hash: '',
            href: gateway.authority,
          })[key],
      });
    globalThis.URL = class {
      constructor() {
        return new OriginalURL(gateway.authority);
      }
    } as unknown as typeof URL;
    parsed = parseGenerationProvenance(invalid);
    replay = sameReplayIdentity(invalid, invalid);
    const wrongEndpoint = {
      ...identity,
      apiEndpoint: 'https://unrelated.example.com/responses',
    };
    endpointReplay = sameReplayIdentity(wrongEndpoint, wrongEndpoint);
    valid = sameReplayIdentity(identity, identity);
    try {
      stampGeneration({ role: 'assistant', content: '' }, invalid);
    } catch {
      threw = true;
    }
  } finally {
    globalThis.URL = OriginalURL;
    for (const [key, value] of saved) define(OriginalURL.prototype, key, value);
  }
  assert.equal(parsed, undefined);
  assert.equal(replay, false);
  assert.equal(endpointReplay, false);
  assert.equal(valid, true);
  assert.equal(threw, true);
});

test('tuple exactness uses captured object, reflect and array intrinsics', () => {
  const ownKeys = Reflect.ownKeys,
    getDescriptor = Object.getOwnPropertyDescriptor;
  const hasOwn = Object.hasOwn,
    isArray = Array.isArray,
    apply = Reflect.apply;
  const raw = {
    ...identity,
    gateway: { ...gateway, extra: 'not replay identity' },
    generatedAt: 'historical',
    harnessCommit: 'fixture',
  };
  let parsed: unknown, replay: unknown, valid: unknown;
  try {
    Reflect.ownKeys = () => ['authority', 'modelRef', 'targetGeneration'];
    Object.getOwnPropertyDescriptor = () => ({ value: gateway.authority });
    Object.hasOwn = () => false;
    Array.isArray = (() => false) as typeof Array.isArray;
    Reflect.apply = () => true;
    parsed = parseGenerationProvenance(raw);
    replay = sameReplayIdentity(raw, raw);
    valid = sameReplayIdentity(identity, identity);
  } finally {
    Reflect.ownKeys = ownKeys;
    Object.getOwnPropertyDescriptor = getDescriptor;
    Object.hasOwn = hasOwn;
    Array.isArray = isArray;
    Reflect.apply = apply;
  }
  assert.equal(parsed, undefined);
  assert.equal(replay, false);
  assert.equal(valid, true);
});

test('untrusted accessors and revoked proxies never escape parser or equality', () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const raw of [
    revoked.proxy,
    {
      get providerType() {
        throw new Error('untrusted');
      },
    },
    {
      ...identity,
      get gateway() {
        throw new Error('untrusted');
      },
    },
  ]) {
    assert.equal(parseGenerationProvenance(raw), undefined);
    assert.equal(
      sameReplayIdentity(raw as typeof identity, raw as typeof identity),
      false,
    );
  }
});

test('Gateway tuple rejects non-enumerable and symbol extras and accessor fields', () => {
  const hidden = Object.defineProperty({ ...gateway }, 'extra', {
    value: true,
  });
  const symbol = { ...gateway, [Symbol('extra')]: true };
  const accessor = {
    ...gateway,
    get modelRef() {
      return gateway.modelRef;
    },
  };
  for (const tuple of [hidden, symbol, accessor]) {
    const raw = {
      ...identity,
      gateway: tuple,
      generatedAt: 'historical',
      harnessCommit: 'fixture',
    };
    assert.equal(parseGenerationProvenance(raw), undefined);
    assert.equal(sameReplayIdentity(raw, raw), false);
  }
});

test('non-enumerable Gateway presence cannot downgrade managed records to direct', () => {
  const raw = Object.defineProperty(
    { ...identity, generatedAt: 'historical', harnessCommit: 'fixture' },
    'gateway',
    { value: { ...gateway, modelRef: 'invalid' }, enumerable: false },
  );
  assert.equal(parseGenerationProvenance(raw), undefined);
  assert.equal(sameReplayIdentity(raw, raw), false);
  assert.throws(() => stampGeneration({ role: 'assistant', content: '' }, raw));
});

test('direct endpoint equality resists post-import string method poisoning', () => {
  const replace = String.prototype.replace;
  const slice = String.prototype.slice;
  const { gateway: _gateway, ...directIdentity } = identity;
  const first = {
    ...directIdentity,
    apiEndpoint: 'https://first.example.com/v1/responses/',
  };
  const second = {
    ...first,
    apiEndpoint: 'https://second.example.com/v1/responses/',
  };
  let equal: boolean | undefined;
  try {
    String.prototype.replace = () => first.apiEndpoint;
    String.prototype.slice = () => first.apiEndpoint;
    equal = sameReplayIdentity(first, second);
  } finally {
    String.prototype.replace = replace;
    String.prototype.slice = slice;
  }
  assert.equal(equal, false);
});

test('invalid explicit tool contracts fail stamping without mutation', () => {
  const message: ChatMessage = { role: 'assistant', content: 'visible' };
  stampGeneration(message, identity);
  const before = message.provenance;
  for (const toolContractVersion of ['', 1, null]) {
    assert.throws(
      () =>
        stampGeneration(message, {
          ...identity,
          toolContractVersion,
        } as unknown as Parameters<typeof stampGeneration>[1]),
      /tool contract/i,
    );
    assert.equal(message.provenance, before);
  }
});

test('inherited replay fields cannot fill missing own identity data', () => {
  const { gateway: _gateway, ...direct } = identity;
  for (const key of [
    'providerType',
    'model',
    'apiSurface',
    'apiEndpoint',
    'toolContractVersion',
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const missing = { ...direct } as Record<string, unknown>;
    const inherited = missing[key];
    delete missing[key];
    const raw = {
      ...missing,
      generatedAt: 'historical',
      harnessCommit: 'fixture',
    };
    try {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        value: inherited,
      });
      assert.equal(parseGenerationProvenance(raw), undefined, key);
      assert.equal(sameReplayIdentity(missing, direct), false, key);
    } finally {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete (Object.prototype as Record<string, unknown>)[key];
    }
  }
});

test('required own-data checks resist poisoned iteration helpers', () => {
  const some = Array.prototype.some;
  const values = Object.values;
  const { gateway: _gateway, model: _model, ...missingModel } = identity;
  const raw = {
    ...missingModel,
    generatedAt: 'historical',
    harnessCommit: 'fixture',
  };
  let parsed: ReturnType<typeof parseGenerationProvenance>;
  let equal: boolean | undefined;
  try {
    Array.prototype.some = () => false;
    Object.values = () => [];
    parsed = parseGenerationProvenance(raw);
    equal = sameReplayIdentity(missingModel, missingModel);
  } finally {
    Array.prototype.some = some;
    Object.values = values;
  }
  assert.equal(parsed, undefined);
  assert.equal(equal, false);
});

test('accessor tool contracts cannot default or replace provenance', () => {
  const message: ChatMessage = { role: 'assistant', content: 'visible' };
  stampGeneration(message, identity);
  const before = message.provenance;
  const accessor = Object.defineProperty(
    {
      ...identity,
      generatedAt: 'historical',
      harnessCommit: 'fixture',
    },
    'toolContractVersion',
    { get: () => TOOL_CONTRACT_VERSION },
  );
  assert.throws(() => stampGeneration(message, accessor), /tool contract/i);
  assert.equal(message.provenance, before);
  assert.equal(parseGenerationProvenance(accessor), undefined);
});

test('inherited Gateway attribution cannot upgrade a direct replay identity', () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'gateway',
  );
  const direct = { ...identity };
  delete direct.gateway;
  const raw = {
    ...direct,
    generatedAt: 'historical',
    harnessCommit: 'fixture',
  };
  let parsed: ReturnType<typeof parseGenerationProvenance>;
  let stamped: ChatMessage['provenance'];
  let directToManaged: boolean | undefined;
  let managedToDirect: boolean | undefined;
  try {
    Object.defineProperty(Object.prototype, 'gateway', {
      configurable: true,
      value: { ...gateway },
    });
    parsed = parseGenerationProvenance(raw);
    const message: ChatMessage = { role: 'assistant', content: 'visible' };
    stampGeneration(message, direct);
    stamped = message.provenance;
    directToManaged = sameReplayIdentity(direct, identity);
    managedToDirect = sameReplayIdentity(identity, direct);
  } finally {
    if (descriptor)
      Object.defineProperty(Object.prototype, 'gateway', descriptor);
    else delete (Object.prototype as { gateway?: unknown }).gateway;
  }
  assert.ok(parsed);
  assert.equal(Object.hasOwn(parsed, 'gateway'), false);
  assert.ok(stamped);
  assert.equal(Object.hasOwn(stamped, 'gateway'), false);
  assert.equal(directToManaged, false);
  assert.equal(managedToDirect, false);
});
