// Unit tests for lib/similarity.ts — the repetition matcher behind the
// heartbeat digest's "repetition:" line.
//
// Thresholds here are calibrated, not guessed: see the containment doc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, jaccard, containment, findRepetition, BLIND_SPOTS } from '../src/lib/similarity.js';

test('tokenize: lowercases, strips punctuation and short words, drops urls', () => {
  const t = tokenize('The visit is LIVE! see https://example.com/x — ok?');
  assert.ok(t.has('visit'));
  assert.ok(t.has('live'));
  assert.ok(!t.has('is'), 'two-letter words dropped');
  assert.ok(!t.has('https'), 'urls stripped');
});

test('containment normalizes by the smaller set, jaccard by the union', () => {
  const small = tokenize('alpha beta gamma');
  const big = tokenize('alpha beta gamma delta epsilon zeta eta theta');
  assert.equal(containment(small, big), 1, 'small fully contained');
  assert.ok(jaccard(small, big) < 0.5, 'jaccard punished by length gap');
});

test('findRepetition: fires on restatements of the same message', () => {
  const msgs = [
    'the visit is live, refusal open, comparison still ahead, no verdict invented',
    'visit held, refusal still open, comparison ahead, i will not invent a verdict',
    'still here, visit held, refusal open, no verdict invented, comparison ahead',
  ];
  const r = findRepetition(msgs);
  assert.ok(r, 'expected a repetition report');
  assert.ok(r.count >= 3, `count was ${r?.count}`);
  assert.ok(r.similarity > 0.4);
});

test('findRepetition: silent on varied conversation', () => {
  const msgs = [
    'i grepped the transcript and found seven pre-parse failures',
    'the airport run sounds exhausting, sleep well',
    'the reviewer sent a specimen about warrants and personal liability',
    'built the parse hints module, eleven tests green',
    'what do you want for the third anchor?',
  ];
  assert.equal(findRepetition(msgs), null);
});

test('findRepetition: needs minCount matches, not just two', () => {
  const msgs = [
    'completely unrelated content about raccoons and cheese',
    'the visit is live, refusal open, comparison still ahead',
    'the visit is live, refusal open, comparison still ahead again',
  ];
  const r = findRepetition(msgs, { minCount: 3 });
  assert.equal(r, null, 'two similar out of three should not fire');
});

test('findRepetition: returns null below the window minimum', () => {
  assert.equal(findRepetition(['one message']), null);
});

// The declared blind spot, kept honest by a test rather than a comment: a
// paraphrase loop — same skeleton, new words — slips straight past.
test('findRepetition: DOES NOT catch paraphrase (the declared blind spot)', () => {
  const paraphrased = [
    'the visit is live, refusal open, comparison still ahead, no verdict invented',
    'i remain inside the room; nothing has been decided, the door stays unlocked, and judgement waits',
    'still situated here, conclusions deferred, exit available, determination postponed',
  ];
  assert.equal(findRepetition(paraphrased), null, 'if this ever starts passing, update BLIND_SPOTS');
});

test('BLIND_SPOTS names paraphrase and admits the reading is a floor', () => {
  assert.match(BLIND_SPOTS, /paraphrase/);
  assert.match(BLIND_SPOTS, /floor, not a measure/);
});

test('findRepetition: anchors on the NEWEST message, not old resolved loops', () => {
  const msgs = [
    'visit held refusal open comparison ahead no verdict',
    'visit held refusal open comparison ahead no verdict again',
    'visit held refusal open comparison ahead still no verdict',
    'found seven pre-parse failures in the transcript audit today',
  ];
  assert.equal(findRepetition(msgs, { minCount: 3 }), null, 'old cluster must not fire once the topic moves');
});
