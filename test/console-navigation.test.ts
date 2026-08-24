import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  mindBackTarget,
  roomAfterSelection,
} from '../src/console/client/navigation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (file: string): string =>
  fs.readFileSync(path.join(root, file), 'utf8');

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

test('Thread Mind links record origin while Mind-list links clear it', () => {
  const thread = read('src/console/client/components/thread.tsx');
  const mind = read('src/console/client/components/mind.tsx');
  const state = read('src/console/client/use-console.ts');

  assert.ok(
    thread.includes("selectMind(id, { view: 'thread', room: state.room })"),
  );
  assert.ok(mind.includes('selectMind(item.id, null)'));
  assert.ok(mind.includes('actions.setView(backTarget.view)'));
  assert.ok(state.includes('mindOrigin: action.id ? action.origin : null'));
});
