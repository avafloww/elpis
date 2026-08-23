import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkerMindRequestError,
  dispatchWorkerMindRequest,
  type WorkerMindService,
} from '../src/worker/mind-request.js';

const TOKEN = 't'.repeat(43);
const ROOT = 'elm-a2b3k7q9' as const;
const CHILD = 'elm-b2b3k7q9' as const;

function service(calls: unknown[]): WorkerMindService {
  return {
    get(token, id) {
      calls.push({ method: 'get', token, id });
      return {
        binding: {
          sessionId: 'f-1',
          worker: 'worker:otter',
          modelRef: 'p/worker',
          mindId: ROOT,
          runtime: 'kubernetes',
        },
        item: { id: id ?? ROOT } as never,
      };
    },
    createChild(token, input) {
      calls.push({ method: 'create', token, input });
      return { id: CHILD } as never;
    },
    addComment(token, id, body) {
      calls.push({ method: 'comment', token, id, body });
      return {
        id: 7,
        itemId: id,
        author: 'worker:otter',
        body,
        replyToId: null,
        createdAt: 1,
        updatedAt: null,
      };
    },
    setStatus(token, id, status) {
      calls.push({ method: 'status', token, id, status });
      return { id, status } as never;
    },
  };
}

test('worker Mind requests dispatch closed get, create, comment, and status operations', () => {
  const calls: unknown[] = [];
  const broker = service(calls);
  assert.equal(
    (
      dispatchWorkerMindRequest(broker, TOKEN, {
        protocol: 1,
        operation: 'get',
      }) as any
    ).item.id,
    ROOT,
  );
  assert.equal(
    (
      dispatchWorkerMindRequest(broker, TOKEN, {
        protocol: 1,
        operation: 'create',
        parentId: ROOT,
        item: {
          title: 'child',
          body: 'work',
          kind: 'task',
          status: 'open',
          priority: 3,
          dueAt: null,
          tags: ['one'],
        },
      }) as any
    ).item.id,
    CHILD,
  );
  assert.equal(
    (
      dispatchWorkerMindRequest(broker, TOKEN, {
        protocol: 1,
        operation: 'comment',
        id: CHILD,
        body: 'progress',
      }) as any
    ).comment.author,
    'worker:otter',
  );
  assert.equal(
    (
      dispatchWorkerMindRequest(broker, TOKEN, {
        protocol: 1,
        operation: 'status',
        id: CHILD,
        status: 'done',
      }) as any
    ).item.status,
    'done',
  );
  assert.deepEqual(calls, [
    { method: 'get', token: TOKEN, id: undefined },
    {
      method: 'create',
      token: TOKEN,
      input: {
        title: 'child',
        parentId: ROOT,
        body: 'work',
        kind: 'task',
        status: 'open',
        priority: 3,
        dueAt: null,
        tags: ['one'],
      },
    },
    { method: 'comment', token: TOKEN, id: CHILD, body: 'progress' },
    { method: 'status', token: TOKEN, id: CHILD, status: 'done' },
  ]);
});

test('worker Mind requests reject spoofed authority and malformed fields before dispatch', () => {
  const calls: unknown[] = [];
  const broker = service(calls);
  const rejected = [
    { protocol: 1, operation: 'get', worker: 'worker:spoof' },
    {
      protocol: 1,
      operation: 'create',
      item: { title: 'x', worker: 'worker:spoof' },
    },
    {
      protocol: 1,
      operation: 'create',
      item: { title: 'x', dependsOn: [ROOT] },
    },
    { protocol: 1, operation: 'comment', id: 'not-elm', body: 'x' },
    { protocol: 1, operation: 'status', id: CHILD, status: 'archived' },
    { protocol: 1, operation: 'create', item: { title: 'x', priority: 9 } },
    { protocol: 1, operation: 'create', item: { title: 'x', tags: ['!!!'] } },
    { protocol: 1, operation: 'delete', id: CHILD },
  ];
  for (const value of rejected)
    assert.throws(
      () => dispatchWorkerMindRequest(broker, TOKEN, value),
      WorkerMindRequestError,
    );
  assert.deepEqual(calls, []);
});
