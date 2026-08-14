// Unit tests for outbound @Name -> <@id> mention resolution.
// Run with: node --test --import tsx/esm test/discord-mentions.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOutboundMentions } from '../src/discord/discord.js';

test('outbound @Name → <@id> when the name is known', () => {
  const dir = new Map([['clover', '123'], ['bramble', '456']]);
  assert.equal(applyOutboundMentions('hey @clover and @bramble', dir), 'hey <@123> and <@456>');
});

test('unknown @Name is left verbatim', () => {
  assert.equal(applyOutboundMentions('hi @nobody', new Map()), 'hi @nobody');
});

test('escaped or code-spanned @ is not mangled (best-effort word-boundary)', () => {
  assert.equal(applyOutboundMentions('email a@b.com', new Map([['b', '1']])), 'email a@b.com');
});
