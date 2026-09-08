import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReplyTo, discordReplyOptions } from '../src/lib/outbound.js';
import { Agent } from '../src/agent.js';

test('reply ID validation is decimal, nonempty and bounded', () => {
  for (const value of ['', ' 123', '123\n', '1e3', '1'.repeat(21), 123, null])
    assert.throws(() => validateReplyTo(value), /replyTo/);
  for (const value of [undefined, '123', '1'.repeat(20)])
    validateReplyTo(value);
});
test('only first chunk references original without reply ping; no-reply stays unchanged', () => {
  assert.deepEqual(discordReplyOptions('123', 0), {
    reply: { messageReference: '123', failIfNotExists: true },
    allowedMentions: { repliedUser: false },
  });
  assert.deepEqual(discordReplyOptions('123', 1), {});
  assert.deepEqual(discordReplyOptions(undefined, 0), {});
});
test('Agent rejects console reply metadata before accounting', async () => {
  const agent = { turnSendScope: null, sendsThisTurn: 0 };
  await assert.rejects(
    Agent.prototype.send.call(agent as any, 'console', 'hello', {
      replyTo: '123',
    }),
    /console.*reply/i,
  );
  assert.equal(agent.sendsThisTurn, 0);
});

test('sandbox preserves explicit routing, attachments, failure and no-reply options', async () => {
  const { buildGlobals } = await import('../src/sandbox/globals.js');
  const calls: unknown[][] = [];
  let fail = false;
  const g = buildGlobals({
    config: {
      paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
      sandbox: {
        syncTimeoutMs: 5000,
        asyncDeadlineMs: 10000,
        previewMaxBytes: 2048,
        logMaxBytes: 2048,
      },
      kagi: { apiKey: null },
    },
    resolveChannel: () => '111',
    send: async (...args: unknown[]) => {
      calls.push(args);
      if (fail) throw new Error('reference unavailable');
    },
  } as any);
  const channel = (g.elpis as any).channel('room');
  const files = [{ path: '/tmp/example.txt' }];
  await channel.send('hello', { files, replyTo: '123' });
  assert.deepEqual(calls[0], ['111', 'hello', { files, replyTo: '123' }]);
  await channel.send('plain');
  assert.deepEqual(calls[1], ['111', 'plain', { files: undefined }]);
  await assert.rejects(channel.send('invalid', { replyTo: 'abc' }), /replyTo/);
  assert.equal(calls.length, 2);
  fail = true;
  await assert.rejects(
    channel.send('reply', { replyTo: '123' }),
    /reference unavailable/,
  );
  assert.equal(calls.length, 3);
});
