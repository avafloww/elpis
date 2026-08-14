import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type { Logger } from '../lib/log.js';
import {
  MIND_KINDS,
  MIND_LOG_KINDS,
  MIND_SORTS,
  MIND_STATUSES,
  parseMindId,
  type MindComment,
  type MindKind,
  type MindListFilter,
  type MindLogKind,
  type MindService,
  type MindSort,
  type MindStatus,
  type UpdateMindItem,
} from '../store/mind.js';

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
const SESSION_REAP_MS = 5 * 60 * 1000;
const ID = z.union([z.number().int().positive(), z.string().min(1).max(32)]);

export interface McpWakeMessage {
  taskId: number;
  commentId: number;
  actor: string;
  body: string;
}

export interface McpEndpointDeps {
  mind: MindService;
  logger: Logger;
  wake: (message: McpWakeMessage) => void;
}

export interface McpHttpEndpoint {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
  readonly sessionCount: number;
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export async function readMcpJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error(`MCP request body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  if (size === 0) throw new Error('MCP request body is empty');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('MCP request body is not valid JSON'); }
}

function sanitizeClientName(name: string | undefined): string {
  const clean = (name ?? 'client').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return clean || 'client';
}

function textResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function waitForReply(mind: MindService, itemId: number, replyToId: number, timeoutMs: number, signal?: AbortSignal): Promise<MindComment | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reply: MindComment | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(reply);
    };
    const check = () => {
      const reply = mind.get(itemId)?.comments.find((comment) => comment.replyToId === replyToId) ?? null;
      if (reply) finish(reply);
    };
    const onAbort = () => finish(null);
    const unsubscribe = mind.subscribe(check);
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort(); else check();
  });
}

function createSessionServer(deps: McpEndpointDeps): McpServer {
  const principal = randomUUID();
  const server = new McpServer(
    { name: 'elpis', version: '0.1.0' },
    {
      instructions: [
        'This is the resident agent’s durable collaboration surface.',
        'You are a bounded external collaborator, not another instance of the resident agent.',
        'At the start of coding work, call mind_discover with fresh repository/task context unless an item was assigned, then call mind_context.',
        'Read the item and acquire mind_claim before editing; never work an unclaimed item.',
        'Renew long work before its lease expires. Record decisions, results, blockers, verification, and omissions as comments.',
        'Ask the resident agent before guessing about architecture, external behavior, security/privacy, scope conflicts, or ambiguous acceptance criteria.',
        'Use mind_ask for clarification: it posts to one item, wakes the resident agent, and waits for a structured reply; use mind_await only after a timeout.',
        'Recorded ideas/questions are not commitments. Do not start unrelated work merely because it exists in Mind.',
      ].join(' '),
    },
  );

  const actor = (): string => `mcp:${sanitizeClientName(server.server.getClientVersion()?.name)}`;

  server.registerTool('mind_list', {
    description: 'List canonical Mind items with optional filters.',
    inputSchema: {
      statuses: z.array(z.enum(MIND_STATUSES)).max(MIND_STATUSES.length).optional(),
      kinds: z.array(z.enum(MIND_KINDS)).max(MIND_KINDS.length).optional(),
      tag: z.string().min(1).max(80).optional(),
      query: z.string().min(1).max(500).optional(),
      parent_id: ID.nullable().optional(),
      ready: z.boolean().optional(),
      blocked: z.boolean().optional(),
      overdue: z.boolean().optional(),
      include_archived: z.boolean().optional(),
      sort: z.enum(MIND_SORTS).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    const filter: MindListFilter = {
      ...(input.statuses ? { statuses: input.statuses as MindStatus[] } : {}),
      ...(input.kinds ? { kinds: input.kinds as MindKind[] } : {}),
      ...(input.tag ? { tag: input.tag } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.parent_id !== undefined ? { parentId: input.parent_id === null ? null : parseMindId(input.parent_id) } : {}),
      ...(input.ready !== undefined ? { ready: input.ready } : {}),
      ...(input.blocked !== undefined ? { blocked: input.blocked } : {}),
      ...(input.overdue !== undefined ? { overdue: input.overdue } : {}),
      ...(input.include_archived !== undefined ? { includeArchived: input.include_archived } : {}),
      ...(input.sort ? { sort: input.sort as MindSort } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
    };
    return textResult(deps.mind.list(filter));
  });

  server.registerTool('mind_get', {
    description: 'Read one Mind item with dependencies, children, comments, events, and reminders.',
    inputSchema: { id: ID },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const itemId = parseMindId(id);
    const item = deps.mind.get(itemId);
    if (!item) throw new Error(`mind: no item #${itemId}`);
    return textResult(item);
  });

  server.registerTool('mind_ready', {
    description: 'List executable Mind items whose dependencies are satisfied.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => textResult(deps.mind.ready(limit)));

  server.registerTool('mind_graph', {
    description: 'Read a dependency/parent graph around one Mind item.',
    inputSchema: { id: ID, depth: z.number().int().min(1).max(8).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, depth }) => textResult(deps.mind.graph(parseMindId(id), depth)));
  server.registerTool('mind_discover', {
    description: 'Find relevant executable Mind work from fresh repository/task context. Call when context is fresh before starting related work; results are ranked but not claimed.',
    inputSchema: {
      context: z.string().max(50_000),
      tags: z.array(z.string().min(1).max(80)).max(20).optional(),
      parent_id: ID.nullable().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ context, tags, parent_id, limit }) => textResult(deps.mind.discover(context, {
    tags, parentId: parent_id === undefined ? undefined : parent_id === null ? null : parseMindId(parent_id), limit,
  })));

  server.registerTool('mind_context', {
    description: 'Get one item’s full durable context, dependency graph, and related ready work before claiming or deciding.',
    inputSchema: { id: ID, depth: z.number().int().min(1).max(6).optional(), related_limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, depth, related_limit }) => {
    const itemId = parseMindId(id); const item = deps.mind.get(itemId);
    if (!item) throw new Error(`mind: no item #${itemId}`);
    const related = deps.mind.discover(`${item.title}\n${item.body}\n${item.tags.join(' ')}`, { tags: item.tags, limit: (related_limit ?? 6) + 1 })
      .filter((match) => match.item.id !== itemId).slice(0, related_limit ?? 6);
    return textResult({ item, graph: deps.mind.graph(itemId, depth ?? 2), related });
  });


  server.registerTool('mind_create', {
    description: 'Create one canonical open Mind item for newly discovered follow-up work. Recorded does not mean promised.',
    inputSchema: {
      title: z.string().min(1).max(500),
      body: z.string().max(100_000).optional(),
      kind: z.enum(MIND_KINDS).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      parent_id: ID.nullable().optional(),
      due_at: z.number().int().positive().nullable().optional(),
      tags: z.array(z.string().min(1).max(80)).max(50).optional(),
      depends_on: z.array(ID).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input) => textResult(deps.mind.create({
    title: input.title,
    body: input.body,
    kind: input.kind as MindKind | undefined,
    priority: input.priority,
    parentId: input.parent_id === undefined ? undefined : input.parent_id === null ? null : parseMindId(input.parent_id),
    dueAt: input.due_at,
    tags: input.tags,
    dependsOn: input.depends_on?.map(parseMindId),
    actor: actor(),
  })));

  server.registerTool('mind_claim', {
    description: 'Atomically claim one ready Mind item before coding. Fails if blocked, manually in progress, or claimed by another worker. The lease prevents duplicate work.',
    inputSchema: {
      id: ID,
      note: z.string().max(20_000).optional(),
      ttl_minutes: z.number().int().min(1).max(240).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, note, ttl_minutes }) => textResult(deps.mind.claim(parseMindId(id), {
    owner: actor(), principal, note, ttlMs: ttl_minutes === undefined ? undefined : ttl_minutes * 60_000,
  })));

  server.registerTool('mind_renew', {
    description: 'Renew this MCP session’s lease on a claimed item before it expires. Use during long-running work.',
    inputSchema: { id: ID, ttl_minutes: z.number().int().min(1).max(240).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, ttl_minutes }) => textResult(deps.mind.renewClaim(parseMindId(id), principal, ttl_minutes === undefined ? undefined : ttl_minutes * 60_000)));

  server.registerTool('mind_release', {
    description: 'Release this MCP session’s claim without completing the item, return it to open work, and record why.',
    inputSchema: { id: ID, note: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, note }) => textResult(deps.mind.releaseClaim(parseMindId(id), principal, 'open', note)));

  server.registerTool('mind_log', {
    description: 'Append a typed progress/decision/result/verification/omission record to this session’s claimed item and renew its lease. Use throughout coding work.',
    inputSchema: {
      id: ID,
      kind: z.enum(MIND_LOG_KINDS),
      body: z.string().min(1).max(20_000),
      ttl_minutes: z.number().int().min(1).max(240).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, kind, body, ttl_minutes }) => textResult(deps.mind.logClaim(
    parseMindId(id), principal, actor(), kind as MindLogKind, body, ttl_minutes === undefined ? undefined : ttl_minutes * 60_000,
  )));

  server.registerTool('mind_block', {
    description: 'Stop claimed work, record the blocker or unresolved clarification, release the lease, and move the item to waiting.',
    inputSchema: { id: ID, blocker: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, blocker }) => textResult(deps.mind.releaseClaim(parseMindId(id), principal, 'waiting', blocker)));

  server.registerTool('mind_finish', {
    description: 'Atomically record result, verification, and omissions, release this session’s claim, and mark the item done. All three receipts are required.',
    inputSchema: {
      id: ID,
      result: z.string().min(1).max(10_000),
      verification: z.string().min(1).max(10_000),
      omissions: z.string().min(1).max(10_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ id, result, verification, omissions }) => textResult(deps.mind.finishClaim(
    parseMindId(id), principal, actor(), result, verification, omissions,
  )));

  server.registerTool('mind_update', {
    description: 'Update metadata on one Mind item. Lifecycle status is intentionally excluded; use mind_claim, mind_block, mind_release, or mind_finish.',
    inputSchema: {
      id: ID,
      title: z.string().min(1).max(500).optional(),
      body: z.string().max(100_000).optional(),
      kind: z.enum(MIND_KINDS).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      parent_id: ID.nullable().optional(),
      due_at: z.number().int().positive().nullable().optional(),
      tags: z.array(z.string().min(1).max(80)).max(50).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (input) => {
    const patch: UpdateMindItem = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.kind !== undefined ? { kind: input.kind as MindKind } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.parent_id !== undefined ? { parentId: input.parent_id === null ? null : parseMindId(input.parent_id) } : {}),
      ...(input.due_at !== undefined ? { dueAt: input.due_at } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    if (Object.keys(patch).length === 0) throw new Error('mind_update requires at least one changed field');
    return textResult(deps.mind.update(parseMindId(input.id), patch, actor()));
  });

  server.registerTool('mind_comment', {
    description: 'Add a durable comment to one Mind item without waking the resident agent.',
    inputSchema: { id: ID, body: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, body }) => textResult(deps.mind.addComment(parseMindId(id), body, actor())));

  server.registerTool('mind_link', {
    description: 'Make one item depend on another. Cycles are rejected.',
    inputSchema: { id: ID, depends_on: ID },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, depends_on }) => textResult(deps.mind.addDependency(parseMindId(id), parseMindId(depends_on), actor())));

  server.registerTool('mind_unlink', {
    description: 'Remove one dependency edge.',
    inputSchema: { id: ID, depends_on: ID },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ id, depends_on }) => textResult(deps.mind.removeDependency(parseMindId(id), parseMindId(depends_on), actor())));

  server.registerTool('mind_ask', {
    description: 'Ask the resident agent a task-bound clarification and wait up to 45 seconds by default for the exact structured reply. Use before guessing about architecture, behavior, security/privacy, scope conflicts, or acceptance criteria.',
    inputSchema: { id: ID, body: z.string().min(1).max(32_768), wait_seconds: z.number().int().min(1).max(300).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, body, wait_seconds }, extra) => {
    const taskId = parseMindId(id); const from = actor();
    const comment = deps.mind.addComment(taskId, body, from);
    let woke = true;
    try { deps.wake({ taskId, commentId: comment.id, actor: from, body }); }
    catch (error) { woke = false; deps.logger.warn(`mcp: comment c#${comment.id} persisted but wake failed: ${error instanceof Error ? error.message : String(error)}`); }
    const reply = woke ? await waitForReply(deps.mind, taskId, comment.id, (wait_seconds ?? 45) * 1000, extra.signal) : null;
    return textResult({ comment, woke, reply, timedOut: woke && reply === null, next: reply ? null : { tool: 'mind_await', id: taskId, comment_id: comment.id } });
  });

  server.registerTool('mind_await', {
    description: 'Wait once for the structured reply to a prior mind_ask or mind_message comment. This replaces repeated mind_get polling.',
    inputSchema: { id: ID, comment_id: z.number().int().positive(), wait_seconds: z.number().int().min(1).max(300).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, comment_id, wait_seconds }, extra) => {
    const taskId = parseMindId(id);
    const source = deps.mind.get(taskId)?.comments.find((comment) => comment.id === comment_id);
    if (!source) throw new Error(`mind: no comment #${comment_id} on item #${taskId}`);
    const reply = await waitForReply(deps.mind, taskId, comment_id, (wait_seconds ?? 45) * 1000, extra.signal);
    return textResult({ reply, timedOut: reply === null, next: reply ? null : { tool: 'mind_await', id: taskId, comment_id } });
  });

  server.registerTool('mind_message', {
    description: 'Post a task-bound message and wake the resident agent, returning immediately. Use mind_await with the returned comment ID instead of polling mind_get.',
    inputSchema: { id: ID, body: z.string().min(1).max(32_768) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, body }) => {
    const taskId = parseMindId(id);
    const from = actor();
    const comment = deps.mind.addComment(taskId, body, from);
    let woke = true;
    try { deps.wake({ taskId, commentId: comment.id, actor: from, body }); }
    catch (error) {
      woke = false;
      deps.logger.warn(`mcp: comment c#${comment.id} persisted but wake failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return textResult({ comment, woke, next: { tool: 'mind_await', id: taskId, comment_id: comment.id } });
  });

  return server;
}

export function createMcpEndpoint(deps: McpEndpointDeps): McpHttpEndpoint {
  const sessions = new Map<string, McpSession>();

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    try { await session.server.close(); } catch { /* already closed */ }
  };
  deps.mind.expireClaims();
  const reaper = setInterval(() => {
    deps.mind.expireClaims();
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < cutoff) void closeSession(id);
    }
  }, SESSION_REAP_MS);
  reaper.unref();

  return {
    get sessionCount() { return sessions.size; },
    async handle(req, res): Promise<void> {
      if (req.headers.origin) { rpcError(res, 403, 'Browser-origin MCP requests are forbidden'); return; }
      const method = req.method ?? 'GET';
      const sessionId = header(req, 'mcp-session-id');
      try {
        if (method === 'POST') {
          const body = await readMcpJsonBody(req);
          const existing = sessionId ? sessions.get(sessionId) : undefined;
          if (existing) { existing.lastSeenAt = Date.now(); await existing.transport.handleRequest(req, res, body); return; }
          if (sessionId || !isInitializeRequest(body)) { rpcError(res, 400, 'Invalid or missing MCP session ID'); return; }

          const server = createSessionServer(deps);
          let transport!: StreamableHTTPServerTransport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport, lastSeenAt: Date.now() });
              deps.logger.info(`mcp: session initialized ${id}`);
            },
            onsessionclosed: (id) => { void closeSession(id); },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id && sessions.get(id)?.transport === transport) sessions.delete(id);
          };
          transport.onerror = (error) => deps.logger.warn(`mcp transport: ${error.message}`);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        if (method === 'GET' || method === 'DELETE') {
          if (!sessionId) { rpcError(res, 400, 'Missing MCP session ID'); return; }
          const session = sessions.get(sessionId);
          if (!session) { rpcError(res, 404, 'Unknown MCP session ID'); return; }
          session.lastSeenAt = Date.now();
          await session.transport.handleRequest(req, res);
          return;
        }

        res.writeHead(405, { allow: 'GET, POST, DELETE' });
        res.end('method not allowed');
      } catch (error) {
        deps.logger.warn(`mcp request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) rpcError(res, /exceeds/.test(String(error)) ? 413 : 400, error instanceof Error ? error.message : String(error));
      }
    },
    async close(): Promise<void> {
      clearInterval(reaper);
      await Promise.allSettled([...sessions.keys()].map(closeSession));
      sessions.clear();
    },
  };
}
