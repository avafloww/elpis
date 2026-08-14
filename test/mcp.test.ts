import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createConsoleServer } from '../src/console/server.js';
import { ConsoleHub } from '../src/console/hub.js';
import { createMcpEndpoint, type McpWakeMessage } from '../src/mcp/server.js';
import { runMigrations } from '../src/store/db.js';
import { MindService } from '../src/store/mind.js';
import { makeConfig } from './helpers.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function schedulerStub() {
  let next = 1;
  const tasks = new Map<number, any>();
  return {
    create(opts: any) { const task = { id: next++, ...opts, doneAt: null }; tasks.set(task.id, task); return task; },
    delete(id: number) { return tasks.delete(id); },
    update(id: number, patch: any) { const task = tasks.get(id); if (!task) return null; Object.assign(task, patch); return task; },
  };
}

function value(result: Awaited<ReturnType<Client['callTool']>>): any {
  const text = result.content.find((part) => part.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text);
}

test('Streamable HTTP MCP uses canonical Mind, client provenance, task-bound wake, and session cleanup', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  t.after(() => db.close());

  const config = makeConfig();
  const mind = new MindService({ db, scheduler: schedulerStub(), logger: config.logger });
  const wakes: McpWakeMessage[] = [];
  const endpoint = createMcpEndpoint({ mind, logger: config.logger, wake: (message) => wakes.push(message) });
  const port = await freePort();
  const serverConfig = makeConfig({ console: { enabled: true, mcpEnabled: true, port, host: '127.0.0.1' } });
  const server = createConsoleServer(serverConfig, new ConsoleHub([]), endpoint);
  await server.start();
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: 'Codex Worker 7', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  assert.equal(endpoint.sessionCount, 1);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['mind_ask', 'mind_await', 'mind_block', 'mind_claim', 'mind_comment', 'mind_context', 'mind_create', 'mind_discover', 'mind_finish', 'mind_get', 'mind_graph', 'mind_link', 'mind_list', 'mind_log', 'mind_message', 'mind_ready', 'mind_release', 'mind_renew', 'mind_unlink', 'mind_update'],
  );

  const lifecycle = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Repair parser cache invalidation', body: 'src/parser/cache.ts loses decoder state', tags: ['parser', 'cache'] } }));
  const discovered = value(await client.callTool({ name: 'mind_discover', arguments: { context: 'working in src/parser/cache.ts on decoder cache invalidation' } }));
  assert.equal(discovered[0].item.id, lifecycle.id);
  const context = value(await client.callTool({ name: 'mind_context', arguments: { id: lifecycle.id } }));
  assert.equal(context.item.id, lifecycle.id);
  value(await client.callTool({ name: 'mind_claim', arguments: { id: lifecycle.id, note: 'reproducing cache loss' } }));
  const logged = value(await client.callTool({ name: 'mind_log', arguments: { id: lifecycle.id, kind: 'decision', body: 'invalidate only decoder-local entries' } }));
  assert.ok(logged.comments.some((entry: any) => entry.body === 'Decision: invalidate only decoder-local entries'));
  const shortcut = await client.callTool({ name: 'mind_update', arguments: { id: lifecycle.id, status: 'done' } });
  assert.equal(shortcut.isError, true);
  const finished = value(await client.callTool({ name: 'mind_finish', arguments: {
    id: lifecycle.id,
    result: 'Decoder-local invalidation implemented.',
    verification: 'Focused parser tests pass.',
    omissions: 'Full integration suite not run.',
  } }));
  assert.equal(finished.status, 'done');
  assert.equal(finished.claim, null);
  assert.match(finished.comments.at(-1).body, /Result:\nDecoder-local invalidation implemented\.[\s\S]*Verification:\nFocused parser tests pass\.[\s\S]*Omissions:\nFull integration suite not run\./);

  const race = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Atomic claim race' } }));
  const claimed = value(await client.callTool({ name: 'mind_claim', arguments: { id: race.id, note: 'worker 7 starts' } }));
  assert.equal(claimed.claim.owner, 'mcp:codex-worker-7');

  const otherClient = new Client({ name: 'Codex Worker 7', version: '1.0.0' });
  const otherTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await otherClient.connect(otherTransport);
  const deniedClaim = await otherClient.callTool({ name: 'mind_claim', arguments: { id: race.id } });
  assert.equal(deniedClaim.isError, true);
  assert.match(deniedClaim.content.find((part) => part.type === 'text')?.text ?? '', /claimed by mcp:codex-worker-7/);

  value(await client.callTool({ name: 'mind_renew', arguments: { id: race.id, ttl_minutes: 60 } }));
  value(await client.callTool({ name: 'mind_release', arguments: { id: race.id, note: 'handoff test' } }));
  const claimedAfterRelease = value(await otherClient.callTool({ name: 'mind_claim', arguments: { id: race.id } }));
  assert.equal(claimedAfterRelease.claim.owner, 'mcp:codex-worker-7');
  value(await otherClient.callTool({ name: 'mind_release', arguments: { id: race.id, note: 'test complete' } }));

  const awaitItem = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Await direct reply' } }));
  const awaitMessage = value(await client.callTool({ name: 'mind_message', arguments: { id: awaitItem.id, body: 'One bounded continuation wait?' } }));
  const awaitPromise = client.callTool({ name: 'mind_await', arguments: { id: awaitItem.id, comment_id: awaitMessage.comment.id, wait_seconds: 2 } });
  setTimeout(() => mind.addReply(awaitItem.id, awaitMessage.comment.id, 'Yes, one wait.', 'agent'), 20);
  const awaited = value(await awaitPromise);
  assert.equal(awaited.timedOut, false);
  assert.equal(awaited.reply.body, 'Yes, one wait.');

  const created = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Inspect the parser', tags: ['coding'] } }));
  assert.equal(created.title, 'Inspect the parser');
  assert.equal(created.createdBy, 'mcp:codex-worker-7');

  const wakeBase = wakes.length;
  const comment = value(await client.callTool({ name: 'mind_comment', arguments: { id: created.id, body: 'Found the entry point.' } }));
  assert.equal(comment.author, 'mcp:codex-worker-7');
  assert.equal(wakes.length, wakeBase, 'ordinary comments stay ambient');

  const message = value(await client.callTool({ name: 'mind_message', arguments: { id: created.id, body: 'Need a decision on the parser boundary.' } }));
  assert.equal(message.woke, true);
  assert.equal(wakes.length, wakeBase + 1);
  assert.deepEqual(wakes.at(-1), {
    taskId: created.id,
    commentId: message.comment.id,
    actor: 'mcp:codex-worker-7',
    body: 'Need a decision on the parser boundary.',
  });

  mind.addComment(created.id, 'Keep the boundary at the decoder.', 'agent');
  const askPromise = client.callTool({ name: 'mind_ask', arguments: { id: created.id, body: 'Should this stay decoder-local?', wait_seconds: 2 } });
  for (let i = 0; i < 20 && wakes.length < wakeBase + 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(wakes.length, wakeBase + 2);
  const askWake = wakes.at(-1)!;
  mind.addReply(created.id, askWake.commentId, 'Yes, keep it decoder-local.', 'agent');
  const answer = value(await askPromise);
  assert.equal(answer.timedOut, false);
  assert.equal(answer.reply.body, 'Yes, keep it decoder-local.');
  assert.equal(answer.reply.replyToId, askWake.commentId);

  const detail = value(await client.callTool({ name: 'mind_get', arguments: { id: created.id } }));
  assert.deepEqual(detail.comments.map((entry: any) => [entry.author, entry.body, entry.replyToId]), [
    ['mcp:codex-worker-7', 'Found the entry point.', null],
    ['mcp:codex-worker-7', 'Need a decision on the parser boundary.', null],
    ['agent', 'Keep the boundary at the decoder.', null],
    ['mcp:codex-worker-7', 'Should this stay decoder-local?', null],
    ['agent', 'Yes, keep it decoder-local.', askWake.commentId],
  ]);

  await otherTransport.terminateSession();
  await otherClient.close();
  await transport.terminateSession();
  await client.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(endpoint.sessionCount, 0);

  const denied = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(denied.status, 403);
});

test('/mcp is absent unless explicitly enabled and wired', async (t) => {
  const port = await freePort();
  const config = makeConfig({ console: { enabled: true, mcpEnabled: false, port, host: '127.0.0.1' } });
  const server = createConsoleServer(config, new ConsoleHub([]));
  await server.start();
  t.after(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(response.status, 404);
});
