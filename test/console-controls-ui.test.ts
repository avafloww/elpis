import assert from 'node:assert/strict';
import test from 'node:test';
import { turnMessages } from '../src/console/client/components/secretary.js';
import { workerEntries } from '../src/console/client/components/workers.js';
import { clampLogRailHeight } from '../src/console/client/scroll.js';
import {
  appendSecretaryTurn,
  secretaryIdFromControl,
  secretaryPendingStatus,
  secretarySnapshotHasPending,
  upsertControlSession,
  workerDetailFromControl,
} from '../src/console/client/use-console.js';

test('log rail height stays within the viewport bounds', () => {
  assert.equal(clampLogRailHeight(40, 800), 96);
  assert.equal(clampLogRailHeight(208, 800), 208);
  assert.equal(clampLogRailHeight(9999, 800), 560);
});

test('control projections preserve worker identity and select a started Secretary session', () => {
  assert.deepEqual(
    workerDetailFromControl({
      session: {
        id: 'wrk-1',
        slug: 'quiet-fox',
        worker: 'worker:quiet-fox',
        status: 'failed',
        mindId: 'elm-example',
      },
      messages: [
        {
          id: 7,
          direction: 'worker_to_dispatcher',
          sender: 'worker',
          body: 'done',
          createdAt: 8,
        },
      ],
      artifacts: [{ key: 'workspace.patch.gz' }],
    }),
    {
      id: 'wrk-1',
      slug: 'quiet-fox',
      worker: 'worker:quiet-fox',
      status: 'failed',
      mindId: 'elm-example',
      messages: [
        {
          id: 7,
          direction: 'worker_to_dispatcher',
          sender: 'worker',
          body: 'done',
          createdAt: 8,
        },
      ],
      artifacts: [{ key: 'workspace.patch.gz' }],
    },
  );
  assert.deepEqual(
    workerEntries(
      [
        {
          id: 7,
          direction: 'worker_to_dispatcher',
          sender: 'worker',
          body: 'done',
          createdAt: 8,
        },
      ],
      'worker:quiet-fox',
    ),
    [
      {
        id: 7,
        kind: 'message',
        role: 'assistant',
        channel: 'worker',
        content: 'done',
        author: 'worker:quiet-fox',
        ts: 8,
      },
    ],
  );
  assert.equal(
    secretaryIdFromControl({ id: 'sec-test-session' }),
    'sec-test-session',
  );
  assert.equal(secretaryIdFromControl({ status: 'failed' }), null);
});

test('successful control receipts upsert sessions and append Secretary turns immediately', () => {
  const snapshot = {
    available: true,
    sessions: [
      { id: 'sec-old', status: 'failed', turns: [{ id: 'turn-old' }] },
    ],
  };
  assert.deepEqual(
    upsertControlSession(snapshot, { id: 'sec-new', status: 'ready' }),
    {
      available: true,
      sessions: [
        { id: 'sec-new', status: 'ready' },
        { id: 'sec-old', status: 'failed', turns: [{ id: 'turn-old' }] },
      ],
    },
  );
  assert.deepEqual(
    upsertControlSession(snapshot, { id: 'sec-old', status: 'closed' }),
    {
      available: true,
      sessions: [
        { id: 'sec-old', status: 'closed', turns: [{ id: 'turn-old' }] },
      ],
    },
  );
  assert.deepEqual(
    appendSecretaryTurn(snapshot, {
      id: 'turn-new',
      sessionId: 'sec-old',
      status: 'queued',
    }).sessions[0].turns,
    [
      { id: 'turn-old' },
      { id: 'turn-new', sessionId: 'sec-old', status: 'queued' },
    ],
  );
});

test('Secretary pending state distinguishes queued, claimed, and completed turns', () => {
  const snapshot = {
    available: true,
    sessions: [
      { id: 'sec-queued', turns: [{ status: 'queued' }] },
      { id: 'sec-claimed', turns: [{ status: 'claimed' }] },
    ],
  };
  assert.equal(secretaryPendingStatus(snapshot.sessions[0]), 'queued');
  assert.equal(secretaryPendingStatus(snapshot.sessions[1]), 'claimed');
  assert.equal(secretarySnapshotHasPending(snapshot), true);
  assert.equal(
    secretarySnapshotHasPending({
      available: true,
      sessions: [{ turns: [{ status: 'completed' }] }],
    }),
    false,
  );
});

test('secretary turn renderer preserves ordinary request and response wire records', () => {
  assert.deepEqual(
    turnMessages({
      status: 'completed',
      request: { role: 'user', content: 'question' },
      response: { role: 'assistant', content: 'answer' },
    }),
    [
      { role: 'user', content: 'question', status: 'completed' },
      { role: 'assistant', content: 'answer', status: 'completed' },
    ],
  );
});
