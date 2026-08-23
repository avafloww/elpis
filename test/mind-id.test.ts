import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMindId,
  newMindId,
  resolveMindRef,
  type MindId,
} from '../src/store/mind-id.js';

const items = [
  { id: 'elm-a2b3k7q9' as MindId, title: 'First' },
  { id: 'elm-a2b9m4n8' as MindId, title: 'Second' },
  { id: 'elm-z8y7x6w5' as MindId, title: 'First' },
];

test('Mind ids are namespaced fixed-entropy strings', () => {
  const id = newMindId(() => Buffer.from([0, 0, 0, 0, 0, 1]));
  assert.equal(id, 'elm-00000001');
  assert.equal(isMindId(id), true);
  assert.equal(isMindId('elm-123'), false);
});

test('Mind refs resolve exact ids, unique prefixes, and unique exact titles', () => {
  assert.equal(resolveMindRef(items, 'elm-a2b3').title, 'First');
  assert.equal(resolveMindRef(items, 'elm-z8y').id, 'elm-z8y7x6w5');
  assert.equal(resolveMindRef(items, 'Second').id, 'elm-a2b9m4n8');
  assert.throws(() => resolveMindRef(items, 'elm-a2b'), /ambiguous id prefix/);
  assert.throws(() => resolveMindRef(items, 'First'), /ambiguous exact title/);
  assert.throws(() => resolveMindRef(items, 'missing'), /no item matching/);
});
