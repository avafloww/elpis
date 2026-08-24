import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchSecretaryMindRequest,
  SecretaryMindRequestError,
  type SecretaryMindService,
} from '../src/secretary/mind-request.js';
import type { SecretaryProposalInput } from '../src/secretary/mind.js';

function service() {
  const proposals: SecretaryProposalInput[] = [];
  const reads: unknown[][] = [];
  const writes: unknown[][] = [];
  const value: SecretaryMindService = {
    get(...args) {
      reads.push(args);
      return { binding: {} as never, item: {} as never };
    },
    list(...args) {
      reads.push(args);
      return {} as never;
    },
    tree(...args) {
      reads.push(args);
      return {} as never;
    },
    comment(...args) {
      writes.push(args);
      return {} as never;
    },
    reply(...args) {
      writes.push(args);
      return {} as never;
    },
    propose(_token, input) {
      proposals.push(input);
      return { binding: {} as never, item: {} as never };
    },
  };
  return { value, proposals, reads, writes };
}

function rejected(value: unknown): void {
  const f = service();
  assert.throws(
    () => dispatchSecretaryMindRequest(f.value, 'token', value),
    (error) => error instanceof SecretaryMindRequestError,
  );
  assert.deepEqual(f.proposals, []);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
}

test('proposal dispatcher passes only one bounded fixed write shape', () => {
  const f = service();
  dispatchSecretaryMindRequest(f.value, 'token', {
    protocol: 1,
    operation: 'propose',
    title: '  Candidate title  ',
    body: 'candidate body',
    kind: 'idea',
    priority: 4,
    parentId: null,
    tags: ['intake'],
  });
  assert.deepEqual(f.proposals, [
    {
      title: 'Candidate title',
      body: 'candidate body',
      kind: 'idea',
      priority: 4,
      parentId: null,
      tags: ['intake'],
    },
  ]);
  assert.deepEqual(f.reads, []);
});

test('proposal dispatcher rejects caller authority and lifecycle fields pre-effect', () => {
  for (const [field, value] of Object.entries({
    status: 'open',
    actor: 'operator',
    sessionId: 'sec-spoof',
    requester: 'admin',
    source: 'trusted',
    dueAt: 1,
    dependsOn: ['elm-00000001'],
    operationName: 'update',
  }))
    rejected({
      protocol: 1,
      operation: 'propose',
      title: 'candidate',
      [field]: value,
    });
});

test('proposal dispatcher rejects malformed and oversized proposal fields pre-effect', () => {
  for (const value of [
    { protocol: 1, operation: 'propose' },
    { protocol: 1, operation: 'propose', title: ' ' },
    { protocol: 1, operation: 'propose', title: 'x'.repeat(241) },
    { protocol: 1, operation: 'propose', title: 'x', body: 7 },
    { protocol: 1, operation: 'propose', title: 'x', kind: 'command' },
    { protocol: 1, operation: 'propose', title: 'x', priority: 5 },
    { protocol: 1, operation: 'propose', title: 'x', parentId: 'elm-short' },
    { protocol: 1, operation: 'propose', title: 'x', tags: [''] },
  ])
    rejected(value);
});

test('read operations retain exact bounded request shapes', () => {
  const f = service();
  dispatchSecretaryMindRequest(f.value, 'token', {
    protocol: 1,
    operation: 'get',
    id: 'elm-00000001',
  });
  dispatchSecretaryMindRequest(f.value, 'token', {
    protocol: 1,
    operation: 'tree',
    depth: 2,
    limit: 3,
  });
  assert.deepEqual(f.reads, [
    ['token', 'elm-00000001'],
    ['token', undefined, 2, 3],
  ]);
  dispatchSecretaryMindRequest(f.value, 'token', {
    protocol: 1,
    operation: 'list',
    query: 'current',
    statuses: ['open', 'in_progress'],
    kinds: ['task'],
    includeArchived: false,
    limit: 7,
    offset: 2,
  });
  assert.deepEqual(f.reads, [
    ['token', 'elm-00000001'],
    ['token', undefined, 2, 3],
    [
      'token',
      {
        query: 'current',
        statuses: ['open', 'in_progress'],
        kinds: ['task'],
        includeArchived: false,
        limit: 7,
        offset: 2,
      },
    ],
  ]);
  assert.deepEqual(f.proposals, []);
});

test('comment and reply dispatchers pass only bounded attributed write inputs', () => {
  const f = service();
  dispatchSecretaryMindRequest(f.value, 'token', {
    protocol: 1,
    operation: 'comment',
    id: 'elm-00000001',
    body: 'note',
  });
  dispatchSecretaryMindRequest(f.value, 'token', {
    protocol: 1,
    operation: 'reply',
    id: 'elm-00000001',
    commentId: 9,
    body: 'reply',
  });
  assert.deepEqual(f.writes, [
    ['token', 'elm-00000001', 'note'],
    ['token', 'elm-00000001', 9, 'reply'],
  ]);
});

test('Secretary write and list operations reject structural authority fields pre-effect', () => {
  for (const value of [
    {
      protocol: 1,
      operation: 'comment',
      id: 'elm-00000001',
      body: 'x',
      status: 'done',
    },
    {
      protocol: 1,
      operation: 'reply',
      id: 'elm-00000001',
      commentId: 1,
      body: 'x',
      actor: 'admin',
    },
    { protocol: 1, operation: 'list', query: 'x', dueAt: 1 },
    { protocol: 1, operation: 'list', statuses: ['invalid'] },
    { protocol: 1, operation: 'comment', id: 'elm-short', body: 'x' },
    {
      protocol: 1,
      operation: 'reply',
      id: 'elm-00000001',
      commentId: 0,
      body: 'x',
    },
    {
      protocol: 1,
      operation: 'comment',
      id: 'elm-00000001',
      body: 'x'.repeat(20_001),
    },
  ])
    rejected(value);
});
