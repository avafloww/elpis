import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mindBackTarget,
  roomAfterSelection,
} from '../src/console/client/navigation.js';

test('selected room toggles back to all rooms', () => {
  assert.equal(roomAfterSelection('room-a', 'room-a'), 'all');
  assert.equal(roomAfterSelection('room-a', 'room-b'), 'room-b');
  assert.equal(roomAfterSelection('all', 'room-a'), 'room-a');
  assert.equal(roomAfterSelection('all', 'all'), 'all');
});

test('Mind back target uses Thread origin with a list fallback', () => {
  assert.deepEqual(mindBackTarget({ view: 'thread', room: 'room-a' }), {
    view: 'thread',
    room: 'room-a',
  });
  assert.deepEqual(mindBackTarget(null), { view: 'mind' });
});
