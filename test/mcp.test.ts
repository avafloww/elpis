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
    ['mind_comment', 'mind_create', 'mind_get', 'mind_graph', 'mind_link', 'mind_list', 'mind_message', 'mind_ready', 'mind_unlink', 'mind_update'],
  );

  const created = value(await client.callTool({ name: 'mind_create', arguments: { title: 'Inspect the parser', tags: ['coding'] } }));
  assert.equal(created.title, 'Inspect the parser');
  assert.equal(created.createdBy, 'mcp:codex-worker-7');

  const comment = value(await client.callTool({ name: 'mind_comment', arguments: { id: created.id, body: 'Found the entry point.' } }));
  assert.equal(comment.author, 'mcp:codex-worker-7');
  assert.equal(wakes.length, 0, 'ordinary comments stay ambient');

  const message = value(await client.callTool({ name: 'mind_message', arguments: { id: created.id, body: 'Need a decision on the parser boundary.' } }));
  assert.equal(message.woke, true);
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0], {
    taskId: created.id,
    commentId: message.comment.id,
    actor: 'mcp:codex-worker-7',
    body: 'Need a decision on the parser boundary.',
  });

  mind.addComment(created.id, 'Keep the boundary at the decoder.', 'agent');
  const detail = value(await client.callTool({ name: 'mind_get', arguments: { id: created.id } }));
  assert.deepEqual(detail.comments.map((entry: any) => [entry.author, entry.body]), [
    ['mcp:codex-worker-7', 'Found the entry point.'],
    ['mcp:codex-worker-7', 'Need a decision on the parser boundary.'],
    ['agent', 'Keep the boundary at the decoder.'],
  ]);

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
