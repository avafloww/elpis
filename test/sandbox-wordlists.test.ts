import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  aliasCandidates,
  BUNDLED_ALIAS_WORDLISTS,
  loadAliasWordlists,
} from '../src/sandbox/wordlists.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

function directory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-words-'));
}
const logger = () => {
  const warnings: string[] = [];
  return {
    warnings,
    value: { warn: (message: string) => warnings.push(message) },
  };
};

test('bundled alias pools have at least 100 unique simple words and meme teeth', () => {
  for (const words of Object.values(BUNDLED_ALIAS_WORDLISTS)) {
    assert.ok(words.length >= 100);
    assert.equal(new Set(words).size, words.length);
    assert.ok(words.every((word) => /^[a-z][a-z0-9]*$/.test(word)));
  }
  assert.ok(BUNDLED_ALIAS_WORDLISTS.adjectives.includes('saucy'));
  assert.ok(BUNDLED_ALIAS_WORDLISTS.nouns.includes('blahaj'));
});

test('missing wordlists seed atomically under elpis-data/config and hot-reload authored words', () => {
  const dataDirectory = directory();
  const log = logger();
  const seeded = loadAliasWordlists(dataDirectory, log.value as any);
  assert.deepEqual(seeded, BUNDLED_ALIAS_WORDLISTS);
  const wordlistDirectory = resolveDataLayout(dataDirectory).wordlists;
  assert.equal(fs.statSync(wordlistDirectory).mode & 0o777, 0o700);
  for (const file of ['adverbs.txt', 'adjectives.txt', 'nouns.txt']) {
    assert.equal(
      fs.statSync(path.join(wordlistDirectory, file)).mode & 0o777,
      0o600,
    );
  }
  fs.writeFileSync(
    path.join(wordlistDirectory, 'adverbs.txt'),
    'suspiciously\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(wordlistDirectory, 'adjectives.txt'), 'saucy\n', {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(wordlistDirectory, 'nouns.txt'), 'blahaj\n', {
    mode: 0o600,
  });
  const reloaded = loadAliasWordlists(dataDirectory, log.value as any);
  assert.deepEqual(reloaded, {
    adverbs: ['suspiciously'],
    adjectives: ['saucy'],
    nouns: ['blahaj'],
  });
  assert.equal(log.warnings.length, 0);
});

test('invalid authored files remain byte-identical while bundled fallback is used', () => {
  const dataDirectory = directory();
  const initial = logger();
  loadAliasWordlists(dataDirectory, initial.value as any);
  const file = path.join(
    resolveDataLayout(dataDirectory).wordlists,
    'adjectives.txt',
  );
  const invalid = Buffer.from('saucy\nNOT VALID\n');
  fs.writeFileSync(file, invalid);
  const log = logger();
  const loaded = loadAliasWordlists(dataDirectory, log.value as any);
  assert.deepEqual(
    fs.readFileSync(file),
    invalid,
    'invalid authored content is preserved',
  );
  assert.deepEqual(loaded.adjectives, BUNDLED_ALIAS_WORDLISTS.adjectives);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /preserving invalid.*adjectives\.txt/);
});

test('candidate walk visits the complete product once from a randomized rotation', () => {
  const lists = {
    adverbs: ['softly', 'boldly'],
    adjectives: ['saucy', 'tiny'],
    nouns: ['blahaj', 'moth'],
  };
  const aliases = [...aliasCandidates(lists, () => 3)];
  assert.equal(aliases.length, 8);
  assert.equal(new Set(aliases).size, 8);
  assert.equal(aliases[0], 'softly-tiny-moth');
  assert.ok(aliases.includes('boldly-saucy-blahaj'));
  assert.throws(() => [...aliasCandidates(lists, () => 8)], /out of range/);
});
