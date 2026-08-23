import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNearBottom,
  preservePrependScrollTop,
} from '../src/console/client/scroll.js';

test('near-bottom boundary follows only while the reader remains at latest', () => {
  assert.equal(
    isNearBottom({ scrollTop: 777, scrollHeight: 1000, clientHeight: 200 }),
    true,
  );
  assert.equal(
    isNearBottom({ scrollTop: 776, scrollHeight: 1000, clientHeight: 200 }),
    false,
  );
  assert.equal(
    isNearBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 200 }),
    false,
  );
});

test('archived prepend preserves the same visible content position', () => {
  assert.equal(preservePrependScrollTop(300, 1000, 1400), 700);
  assert.equal(preservePrependScrollTop(0, 1000, 900), 0);
});
