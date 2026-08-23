// Unit tests for the shared frontmatter parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../src/lib/frontmatter.js';

test('frontmatter: parses scalar keys and body', () => {
  const p = parseFrontmatter(
    '---\nname: Bramble\nrole: host\n---\nbody line one\nbody line two',
  );
  assert.ok(p);
  assert.equal(p.frontmatter.name, 'Bramble');
  assert.equal(p.frontmatter.role, 'host');
  assert.equal(p.body, 'body line one\nbody line two');
});

test('frontmatter: parses the ids: [..] list format elpis.memory.person writes', () => {
  const p = parseFrontmatter(
    '---\nname: Bramble\nids: [discord:111111111111111101, discord:42]\n---\n\n- [2026-07-02] a fact',
  );
  assert.ok(p);
  assert.deepEqual(p.frontmatter.ids, [
    'discord:111111111111111101',
    'discord:42',
  ]);
});

test('frontmatter: empty ids list becomes an empty array', () => {
  const p = parseFrontmatter('---\nname: Rowan\nids: []\n---\n');
  assert.ok(p);
  assert.deepEqual(p.frontmatter.ids, []);
});

test('frontmatter: strips surrounding quotes on scalars', () => {
  const p = parseFrontmatter('---\ncondition: "rm -rf"\n---\nbody');
  assert.ok(p);
  assert.equal(p.frontmatter.condition, 'rm -rf');
});

test('frontmatter: returns null when there is no frontmatter envelope', () => {
  assert.equal(parseFrontmatter('just some text\nno frontmatter'), null);
});

test('frontmatter: generic rule-shaped metadata parses', () => {
  const rule = [
    '---',
    'name: no-sudo-rm',
    'condition: sudo\\s+rm',
    'scope: [runtime:tool:run]',
    'interruptMode: always',
    '---',
    'Do not sudo rm.',
  ].join('\n');
  const p = parseFrontmatter(rule);
  assert.ok(p);
  assert.equal(p.frontmatter.name, 'no-sudo-rm');
  assert.equal(p.frontmatter.condition, 'sudo\\s+rm');
  assert.deepEqual(p.frontmatter.scope, ['runtime:tool:run']);
  assert.equal(p.frontmatter.interruptMode, 'always');
  assert.equal(p.body, 'Do not sudo rm.');
});
