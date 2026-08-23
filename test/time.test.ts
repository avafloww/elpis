// Unit tests for time display helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localHm, localStamp } from '../src/lib/time.js';

test('localHm produces a [HH:MM] shape', () => {
  const s = localHm(Date.now());
  assert.match(s, /^\[\d{2}:\d{2}\]$/);
});

test('localStamp produces a [Weekday Month Day · HH:MM] shape', () => {
  const s = localStamp(Date.now());
  assert.match(s, /^\[[A-Za-z]{3} [A-Z][a-z]{2} \d{1,2} · \d{2}:\d{2}\]$/);
});

test('localHm honors an explicit timezone for a fixed epoch', () => {
  // 2024-07-15 22:47 UTC → Vancouver 14:27 (PDT)
  const epoch = 1721078820000;
  assert.equal(localHm(epoch, 'America/Vancouver'), '[14:27]');
});

test('localStamp honors an explicit timezone for a fixed epoch', () => {
  // 2024-07-15 22:47 UTC → Mon Jul 15 · 14:27 in Vancouver (PDT)
  const epoch = 1721078820000;
  assert.equal(localStamp(epoch, 'America/Vancouver'), '[Mon Jul 15 · 14:27]');
});

test('hourCycle h23 keeps midnight as 00:00, not 24:00', () => {
  // 2024-07-15 07:00 UTC → midnight in Vancouver (PDT)
  const vancouverMidnight = 1721026800000;
  assert.equal(localHm(vancouverMidnight, 'America/Vancouver'), '[00:00]');
  assert.equal(
    localStamp(vancouverMidnight, 'America/Vancouver'),
    '[Mon Jul 15 · 00:00]',
  );
});
