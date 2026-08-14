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

function envelope(result: Awaited<ReturnType<Client['callTool']>>): any {
  const text = result.content.find((part) => part.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  if (!result.isError) assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  else assert.match(text.text, /^\[[A-Z_]+\] /);
  return result.structuredContent;
}

function value(result: Awaited<ReturnType<Client['callTool']>>): any {
  const resultEnvelope = envelope(result);
  assert.equal(resultEnvelope.ok, true);
  return resultEnvelope.data;
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
  assert.match(client.getInstructions() ?? '', /structuredContent with compact receipts/);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['mind_archive_created', 'mind_ask', 'mind_await', 'mind_block', 'mind_claim', 'mind_comment', 'mind_context', 'mind_create', 'mind_discover', 'mind_finish', 'mind_get', 'mind_graph', 'mind_link', 'mind_list', 'mind_log', 'mind_message', 'mind_ready', 'mind_release', 'mind_renew', 'mind_resume', 'mind_unlink', 'mind_update'],
  );
  assert.ok(tools.tools.every((tool) => tool.outputSchema?.type === 'object'));
  const prioritySchema = tools.tools.find((tool) => tool.name === 'mind_create')!.inputSchema.properties!.priority as Record<string, unknown>;
  assert.deepEqual({ minimum: prioritySchema.minimum, maximum: prioritySchema.maximum }, { minimum: 0, maximum: 4 });

  const lifecycle = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Repair parser cache invalidation', body: 'src/parser/cache.ts loses decoder state', tags: ['parser', 'cache'] } })).item;
  const discovered = value(await client.callTool({ name: 'mind_discover', arguments: { context: 'working in src/parser/cache.ts on decoder cache invalidation' } }));
  assert.equal(discovered.matches[0].item.id, lifecycle.id);
  const context = value(await client.callTool({ name: 'mind_context', arguments: { id: lifecycle.id } }));
  assert.equal(context.detail.item.id, lifecycle.id);
  value(await client.callTool({ name: 'mind_claim', arguments: { id: lifecycle.id, note: 'reproducing cache loss' } }));
  const logged = envelope(await client.callTool({ name: 'mind_log', arguments: { id: lifecycle.id, kind: 'decision', body: 'invalidate only decoder-local entries' } }));
  assert.equal(logged.receipt.operation, 'log');
  assert.ok(mind.get(lifecycle.id)!.comments.some((entry) => entry.body === 'Decision: invalidate only decoder-local entries'));
  const shortcut = await client.callTool({ name: 'mind_update', arguments: { id: lifecycle.id, status: 'done' } });
  assert.equal(shortcut.isError, true);
  const finished = value(await client.callTool({ name: 'mind_finish', arguments: {
    id: lifecycle.id,
    result: 'Decoder-local invalidation implemented.',
    verification: 'Focused parser tests pass.',
    omissions: 'Full integration suite not run.',
  } }));
  assert.equal(finished.item.status, 'done');
  assert.equal(finished.item.claim, null);
  assert.match(mind.get(lifecycle.id)!.comments.at(-1)!.body, /Result:\nDecoder-local invalidation implemented\.[\s\S]*Verification:\nFocused parser tests pass\.[\s\S]*Omissions:\nFull integration suite not run\./);

  const race = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Atomic claim race' } })).item;
  const claimed = value(await client.callTool({ name: 'mind_claim', arguments: { id: race.id, note: 'worker 7 starts' } }));
  assert.equal(claimed.item.claim.owner, 'mcp:codex-worker-7');

  const otherClient = new Client({ name: 'Codex Worker 7', version: '1.0.0' });
  const otherTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await otherClient.connect(otherTransport);
  const deniedClaim = await otherClient.callTool({ name: 'mind_claim', arguments: { id: race.id } });
  assert.equal(deniedClaim.isError, true);
  assert.equal(envelope(deniedClaim).error.code, 'CLAIM_CONFLICT');
  assert.match(deniedClaim.content.find((part) => part.type === 'text')?.text ?? '', /claimed by mcp:codex-worker-7/);

  value(await client.callTool({ name: 'mind_renew', arguments: { id: race.id, ttl_minutes: 60 } }));
  value(await client.callTool({ name: 'mind_release', arguments: { id: race.id, note: 'handoff test' } }));
  const claimedAfterRelease = value(await otherClient.callTool({ name: 'mind_claim', arguments: { id: race.id } }));
  assert.equal(claimedAfterRelease.item.claim.owner, 'mcp:codex-worker-7');
  value(await otherClient.callTool({ name: 'mind_release', arguments: { id: race.id, note: 'test complete' } }));

  const awaitItem = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Await direct reply' } })).item;
  const awaitMessage = value(await client.callTool({ name: 'mind_message', arguments: { id: awaitItem.id, body: 'One bounded continuation wait?' } }));
  const awaitPromise = client.callTool({ name: 'mind_await', arguments: { id: awaitItem.id, comment_id: awaitMessage.comment.id, wait_seconds: 2 } });
  setTimeout(() => mind.addReply(awaitItem.id, awaitMessage.comment.id, 'Yes, one wait.', 'agent'), 20);
  const awaited = value(await awaitPromise);
  assert.equal(awaited.timedOut, false);
  assert.equal(awaited.reply.body, 'Yes, one wait.');

  const created = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Inspect the parser', tags: ['coding'] } })).item;
  assert.equal(created.title, 'Inspect the parser');
  assert.equal(mind.get(created.id)!.createdBy, 'mcp:codex-worker-7');

  const wakeBase = wakes.length;
  const comment = value(await client.callTool({ name: 'mind_comment', arguments: { id: created.id, body: 'Found the entry point.' } }));
  assert.equal(comment.comment.author, 'mcp:codex-worker-7');
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
  assert.equal(detail.events, undefined, 'events are opt-in');
  const withEvents = value(await client.callTool({ name: 'mind_get', arguments: { id: created.id, include: ['events'], event_limit: 2 } }));
  assert.equal(withEvents.events.length, 2);

  const unchanged = envelope(await client.callTool({ name: 'mind_update', arguments: { id: created.id, title: created.title } }));
  assert.equal(unchanged.receipt.changed, false);

  const dueIso = '2031-02-03T04:05:06.000Z';
  const dated = value(await client.callTool({ name: 'mind_create', arguments: { title: 'ISO due date', due_at: dueIso, tags: ['strict-filter'] } })).item;
  assert.equal(mind.get(dated.id)!.dueAt, Date.parse(dueIso));
  value(await client.callTool({ name: 'mind_create', arguments: { title: 'Different tag', tags: ['other-filter'] } }));
  const strict = value(await client.callTool({ name: 'mind_discover', arguments: { context: 'ISO due date', filter_tags: ['strict-filter'] } }));
  assert.deepEqual(strict.matches.map((match: any) => match.item.id), [dated.id]);

  const firstPage = envelope(await client.callTool({ name: 'mind_list', arguments: { limit: 2, sort: 'created_asc' } }));
  assert.equal(firstPage.data.items.length, 2);
  assert.ok(firstPage.page.total_count >= 6);
  assert.ok(firstPage.page.next_cursor);
  const secondPage = envelope(await client.callTool({ name: 'mind_list', arguments: { limit: 2, sort: 'created_asc', cursor: firstPage.page.next_cursor } }));
  assert.notEqual(secondPage.data.items[0].id, firstPage.data.items[0].id);
  assert.equal(secondPage.page.total_count, firstPage.page.total_count);

  const resumable = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Resume blocked work' } })).item;
  value(await client.callTool({ name: 'mind_claim', arguments: { id: resumable.id } }));
  value(await client.callTool({ name: 'mind_block', arguments: { id: resumable.id, blocker: 'Need fixture' } }));
  const resumed = value(await client.callTool({ name: 'mind_resume', arguments: { id: resumable.id, note: 'Fixture arrived' } }));
  assert.equal(resumed.item.status, 'in_progress');
  assert.equal(resumed.item.claim.owner, 'mcp:codex-worker-7');
  assert.match(mind.get(resumable.id)!.comments.at(-1)!.body, /Resumed and claimed through MCP/);
  value(await client.callTool({ name: 'mind_release', arguments: { id: resumable.id, note: 'resume tested' } }));

  const graph = value(await client.callTool({ name: 'mind_graph', arguments: { id: created.id } }));
  assert.equal(graph.nodes[0].body, undefined, 'graph nodes are compact');

  const cleanup = value(await client.callTool({ name: 'mind_create', arguments: { title: '[MCP TEST] cleanup target' } })).item;
  value(await client.callTool({ name: 'mind_claim', arguments: { id: cleanup.id, note: 'cleanup lease protection' } }));
  const claimedCleanup = await client.callTool({ name: 'mind_archive_created', arguments: { ids: [cleanup.id], note: 'must not revoke live work' } });
  assert.equal(claimedCleanup.isError, true);
  assert.equal(envelope(claimedCleanup).error.code, 'CLAIM_CONFLICT');
  value(await client.callTool({ name: 'mind_release', arguments: { id: cleanup.id, note: 'ready for cleanup' } }));
  const deniedCleanup = await otherClient.callTool({ name: 'mind_archive_created', arguments: { ids: [cleanup.id], note: 'wrong session' } });
  assert.equal(deniedCleanup.isError, true);
  assert.equal(envelope(deniedCleanup).error.code, 'SESSION_SCOPE');
  const archived = envelope(await client.callTool({ name: 'mind_archive_created', arguments: { ids: [cleanup.id], note: 'test cleanup' } }));
  assert.equal(archived.receipt.changed, true);
  assert.ok(mind.get(cleanup.id)!.archivedAt);
  const archivedAgain = envelope(await client.callTool({ name: 'mind_archive_created', arguments: { ids: [cleanup.id], note: 'idempotence' } }));
  assert.equal(archivedAgain.receipt.changed, false);

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
