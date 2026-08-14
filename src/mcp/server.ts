import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import type { Logger } from '../lib/log.js';
import {
  MIND_KINDS,
  MIND_LOG_KINDS,
  MIND_SORTS,
  MIND_STATUSES,
  parseMindId,
  type MindComment,
  type MindDetail,
  type MindGraph,
  type MindItem,
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
const TIMESTAMP = z.union([z.number().int().positive(), z.string().min(1).max(64)]).describe('Epoch milliseconds or an ISO-8601 timestamp');

function parseTimestamp(value: number | string | null | undefined, field: string): number | null | undefined {
  if (value === undefined || value === null || typeof value === 'number') return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be epoch milliseconds, ISO-8601, or null`);
  return parsed;
}

function encodeListCursor(offset: number): string {
  return Buffer.from(`mind-list:${offset}`, 'utf8').toString('base64url');
}

function decodeListCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^mind-list:(\d+)$/.exec(decoded);
  if (!match) throw new Error('invalid mind_list cursor');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('invalid mind_list cursor');
  return offset;
}

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

const TOOL_OUTPUT_SCHEMA = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  receipt: z.object({
    operation: z.string(),
    itemId: z.number().int().positive().optional(),
    changed: z.boolean().optional(),
    status: z.string().optional(),
  }).optional(),
  page: z.object({
    next_cursor: z.string().nullable().optional(),
    total_count: z.number().int().min(0).optional(),
  }).optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
};

interface ToolResultOptions {
  text?: string;
  receipt?: { operation: string; itemId?: number; changed?: boolean; status?: string };
  page?: { next_cursor?: string | null; total_count?: number };
}

function toolResult(data: unknown, opts: ToolResultOptions = {}): CallToolResult {
  const structuredContent: Record<string, unknown> = { ok: true, data };
  if (opts.receipt) structuredContent.receipt = opts.receipt;
  if (opts.page) structuredContent.page = opts.page;
  return {
    structuredContent,
    content: [{ type: 'text', text: opts.text ?? JSON.stringify(structuredContent) }],
  };
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const rules: [RegExp, string, boolean][] = [
    [/no item|no comment/i, 'NOT_FOUND', false],
    [/not created by this MCP session/i, 'SESSION_SCOPE', false],
    [/claimed by .* until|claimed by another collaborator|has an active claim/i, 'CLAIM_CONFLICT', true],
    [/no active claim/i, 'CLAIM_REQUIRED', true],
    [/blocked by dependencies|became blocked by dependencies/i, 'DEPENDENCY_BLOCKED', true],
    [/cycle/i, 'DEPENDENCY_CYCLE', false],
    [/archived/i, 'ARCHIVED', false],
    [/not waiting|not open work|already in progress|not an executable task|is a .*not an executable task/i, 'INVALID_LIFECYCLE', false],
    [/requires|must be|invalid|at least one/i, 'INVALID_ARGUMENT', false],
  ];
  const matched = rules.find(([pattern]) => pattern.test(message));
  const detail = { code: matched?.[1] ?? 'MIND_ERROR', message, retryable: matched?.[2] ?? false };
  const structuredContent = { ok: false, error: detail };
  return { isError: true, structuredContent, content: [{ type: 'text', text: `[${detail.code}] ${message}` }] };
}

const DETAIL_PARTS = ['body', 'relations', 'comments', 'events', 'reminders'] as const;
type DetailPart = (typeof DETAIL_PARTS)[number];
const DEFAULT_DETAIL_PARTS: DetailPart[] = ['body', 'relations', 'comments', 'reminders'];

function compactItem(item: MindItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    status: item.status,
    effectiveStatus: item.effectiveStatus,
    priority: item.priority,
    parentId: item.parentId,
    dueAt: item.dueAt,
    tags: item.tags,
    blockedBy: item.blockedBy.map((link) => link.id),
    blocks: item.blocks.map((link) => link.id),
    childCount: item.childCount,
    commentCount: item.commentCount,
    reminderCount: item.reminderCount,
    claim: item.claim ? { owner: item.claim.owner, expiresAt: item.claim.expiresAt, expired: item.claim.expired } : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastCommentAt: item.lastCommentAt,
  };
}

function projectDetail(item: MindDetail, parts = DEFAULT_DETAIL_PARTS, commentLimit = 20, eventLimit = 50): Record<string, unknown> {
  const include = new Set(parts);
  const result: Record<string, unknown> = { item: compactItem(item) };
  if (include.has('body')) result.body = item.body;
  if (include.has('relations')) {
    result.parent = item.parent;
    result.children = item.children;
    result.dependencies = item.dependencies;
  }
  if (include.has('comments')) result.comments = item.comments.slice(-commentLimit);
  if (include.has('events')) result.events = item.events.slice(-eventLimit);
  if (include.has('reminders')) result.reminders = item.reminders;
  return result;
}

function compactGraph(graph: MindGraph): Record<string, unknown> {
  return { rootId: graph.rootId, nodes: graph.nodes.map(compactItem), edges: graph.edges };
}

function mutationResult(operation: string, item: MindDetail, changed = true, extra: Record<string, unknown> = {}): CallToolResult {
  return toolResult({ item: compactItem(item), ...extra }, {
    receipt: { operation, itemId: item.id, changed, status: item.status },
  });
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
  const createdItemIds = new Set<number>();
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
        'Tool results use native structuredContent with compact receipts; runtime errors include stable codes and retryability.',
      ].join(' '),
    },
  );

  const actor = (): string => `mcp:${sanitizeClientName(server.server.getClientVersion()?.name)}`;

  const registerTool = <Input extends z.ZodRawShape>(
    name: string,
    config: { description?: string; inputSchema: Input; annotations?: ToolAnnotations },
    handler: (args: z.output<z.ZodObject<Input>>, extra: { signal?: AbortSignal }) => CallToolResult | Promise<CallToolResult>,
  ) => {
    const callback = (async (args, extra) => {
      try { return await handler(args as z.output<z.ZodObject<Input>>, extra); }
      catch (error) { deps.logger.warn(`mcp tool ${name}: ${error instanceof Error ? error.message : String(error)}`); return toolError(error); }
    }) as ToolCallback<Input>;
    return server.registerTool<typeof TOOL_OUTPUT_SCHEMA, Input>(name, { ...config, outputSchema: TOOL_OUTPUT_SCHEMA }, callback);
  };

  registerTool('mind_list', {
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
      cursor: z.string().min(1).max(256).optional(),
      offset: z.number().int().min(0).max(100_000).optional().describe('Deprecated compatibility input; prefer cursor'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (input) => {
    if (input.cursor !== undefined && input.offset !== undefined) throw new Error('mind_list accepts cursor or offset, not both');
    const limit = input.limit ?? 50;
    const offset = input.cursor === undefined ? (input.offset ?? 0) : decodeListCursor(input.cursor);
    const base: MindListFilter = {
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
    };
    const totalCount = deps.mind.count(base);
    const items = deps.mind.list({ ...base, limit, offset });
    const nextOffset = offset + items.length;
    return toolResult({ items: items.map(compactItem), returned: items.length }, {
      page: { next_cursor: nextOffset < totalCount ? encodeListCursor(nextOffset) : null, total_count: totalCount },
    });
  });

  registerTool('mind_get', {
    description: 'Read one item. Summary is always returned; choose optional detail parts explicitly.',
    inputSchema: {
      id: ID,
      include: z.array(z.enum(DETAIL_PARTS)).max(DETAIL_PARTS.length).optional(),
      comment_limit: z.number().int().min(0).max(100).optional(),
      event_limit: z.number().int().min(0).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, include, comment_limit, event_limit }) => {
    const itemId = parseMindId(id);
    const item = deps.mind.get(itemId);
    if (!item) throw new Error(`mind: no item #${itemId}`);
    return toolResult(projectDetail(item, include as DetailPart[] | undefined, comment_limit, event_limit));
  });

  registerTool('mind_ready', {
    description: 'List executable Mind items whose dependencies are satisfied.',
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => { const items = deps.mind.ready(limit); return toolResult({ items: items.map(compactItem), returned: items.length }); });

  registerTool('mind_graph', {
    description: 'Read a dependency/parent graph around one Mind item.',
    inputSchema: { id: ID, depth: z.number().int().min(1).max(8).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, depth }) => toolResult(compactGraph(deps.mind.graph(parseMindId(id), depth))));
  registerTool('mind_discover', {
    description: 'Rank open dependency-ready tasks against fresh context; filters constrain and boosts only rank.',
    inputSchema: {
      context: z.string().max(50_000),
      filter_tags: z.array(z.string().min(1).max(80)).max(20).optional().describe('Strict tag filter; defaults to requiring every listed tag'),
      filter_mode: z.enum(['all', 'any']).optional(),
      boost_tags: z.array(z.string().min(1).max(80)).max(20).optional().describe('Ranking hints; do not exclude unmatched tasks'),
      tags: z.array(z.string().min(1).max(80)).max(20).optional().describe('Deprecated alias for boost_tags'),
      parent_id: ID.nullable().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ context, filter_tags, filter_mode, boost_tags, tags, parent_id, limit }) => {
    const matches = deps.mind.discover(context, {
      tags,
      boostTags: boost_tags,
      filterTags: filter_tags,
      filterMode: filter_mode,
      parentId: parent_id === undefined ? undefined : parent_id === null ? null : parseMindId(parent_id),
      limit,
    });
    return toolResult({ matches: matches.map((match) => ({ score: match.score, matched: match.matched, item: compactItem(match.item) })) });
  });

  registerTool('mind_context', {
    description: 'Read a compact work bundle: projected item detail, compact graph, and related ready tasks.',
    inputSchema: {
      id: ID,
      depth: z.number().int().min(1).max(6).optional(),
      related_limit: z.number().int().min(1).max(20).optional(),
      include: z.array(z.enum(DETAIL_PARTS)).max(DETAIL_PARTS.length).optional(),
      comment_limit: z.number().int().min(0).max(100).optional(),
      event_limit: z.number().int().min(0).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, depth, related_limit, include, comment_limit, event_limit }) => {
    const itemId = parseMindId(id); const item = deps.mind.get(itemId);
    if (!item) throw new Error(`mind: no item #${itemId}`);
    const related = deps.mind.discover(`${item.title}\n${item.body}\n${item.tags.join(' ')}`, { boostTags: item.tags, limit: (related_limit ?? 6) + 1 })
      .filter((match) => match.item.id !== itemId).slice(0, related_limit ?? 6);
    return toolResult({
      detail: projectDetail(item, include as DetailPart[] | undefined, comment_limit, event_limit),
      graph: compactGraph(deps.mind.graph(itemId, depth ?? 2)),
      related: related.map((match) => ({ score: match.score, matched: match.matched, item: compactItem(match.item) })),
    });
  });


  registerTool('mind_create', {
    description: 'Create one canonical open Mind item for newly discovered follow-up work. Recorded does not mean promised.',
    inputSchema: {
      title: z.string().min(1).max(500),
      body: z.string().max(100_000).optional(),
      kind: z.enum(MIND_KINDS).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      parent_id: ID.nullable().optional(),
      due_at: TIMESTAMP.nullable().optional(),
      tags: z.array(z.string().min(1).max(80)).max(50).optional(),
      depends_on: z.array(ID).max(100).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    const item = deps.mind.create({
      title: input.title,
      body: input.body,
      kind: input.kind as MindKind | undefined,
      priority: input.priority,
      parentId: input.parent_id === undefined ? undefined : input.parent_id === null ? null : parseMindId(input.parent_id),
      dueAt: parseTimestamp(input.due_at, 'due_at'),
      tags: input.tags,
      dependsOn: input.depends_on?.map(parseMindId),
      actor: actor(),
    });
    createdItemIds.add(item.id);
    return mutationResult('create', item);
  });

  registerTool('mind_claim', {
    description: 'Claim one open dependency-ready task with this session’s lease.',
    inputSchema: {
      id: ID,
      note: z.string().max(20_000).optional(),
      ttl_minutes: z.number().int().min(1).max(240).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, note, ttl_minutes }) => {
    const item = deps.mind.claim(parseMindId(id), {
      owner: actor(), principal, note, ttlMs: ttl_minutes === undefined ? undefined : ttl_minutes * 60_000,
    });
    return mutationResult('claim', item, true, { commentId: item.comments.at(-1)?.id });
  });

  registerTool('mind_renew', {
    description: 'Renew this session’s active claim lease.',
    inputSchema: { id: ID, ttl_minutes: z.number().int().min(1).max(240).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, ttl_minutes }) => { const item = deps.mind.renewClaim(parseMindId(id), principal, ttl_minutes === undefined ? undefined : ttl_minutes * 60_000); return mutationResult('renew', item); });

  registerTool('mind_release', {
    description: 'Release this session’s claim to open with a reason.',
    inputSchema: { id: ID, note: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, note }) => { const item = deps.mind.releaseClaim(parseMindId(id), principal, 'open', note); return mutationResult('release', item, true, { commentId: item.comments.at(-1)?.id }); });

  registerTool('mind_log', {
    description: 'Append a typed log to claimed work and renew its lease.',
    inputSchema: {
      id: ID,
      kind: z.enum(MIND_LOG_KINDS),
      body: z.string().min(1).max(20_000),
      ttl_minutes: z.number().int().min(1).max(240).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, kind, body, ttl_minutes }) => {
    const item = deps.mind.logClaim(
      parseMindId(id), principal, actor(), kind as MindLogKind, body, ttl_minutes === undefined ? undefined : ttl_minutes * 60_000,
    );
    return mutationResult('log', item, true, { kind, commentId: item.comments.at(-1)?.id });
  });

  registerTool('mind_block', {
    description: 'Move claimed work to waiting with a blocker and release its lease.',
    inputSchema: { id: ID, blocker: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, blocker }) => { const item = deps.mind.releaseClaim(parseMindId(id), principal, 'waiting', blocker); return mutationResult('block', item, true, { commentId: item.comments.at(-1)?.id }); });

  registerTool('mind_resume', {
    description: 'Atomically resume one waiting dependency-ready task and claim it for this session.',
    inputSchema: { id: ID, note: z.string().min(1).max(20_000), ttl_minutes: z.number().int().min(1).max(240).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, note, ttl_minutes }) => {
    const item = deps.mind.resumeClaim(parseMindId(id), { owner: actor(), principal, note, ttlMs: ttl_minutes === undefined ? undefined : ttl_minutes * 60_000 });
    return mutationResult('resume', item, true, { commentId: item.comments.at(-1)?.id });
  });

  registerTool('mind_finish', {
    description: 'Complete claimed work atomically; result, verification, and omissions are required.',
    inputSchema: {
      id: ID,
      result: z.string().min(1).max(10_000),
      verification: z.string().min(1).max(10_000),
      omissions: z.string().min(1).max(10_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ id, result, verification, omissions }) => {
    const item = deps.mind.finishClaim(parseMindId(id), principal, actor(), result, verification, omissions);
    return mutationResult('finish', item, true, { commentId: item.comments.at(-1)?.id });
  });

  registerTool('mind_update', {
    description: 'Update item metadata; lifecycle status is excluded.',
    inputSchema: {
      id: ID,
      title: z.string().min(1).max(500).optional(),
      body: z.string().max(100_000).optional(),
      kind: z.enum(MIND_KINDS).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      parent_id: ID.nullable().optional(),
      due_at: TIMESTAMP.nullable().optional(),
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
      ...(input.due_at !== undefined ? { dueAt: parseTimestamp(input.due_at, 'due_at') } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    if (Object.keys(patch).length === 0) throw new Error('mind_update requires at least one changed field');
    const itemId = parseMindId(input.id);
    const before = deps.mind.get(itemId);
    if (!before) throw new Error(`mind: no item #${itemId}`);
    const item = deps.mind.update(itemId, patch, actor());
    const changed = Object.keys(patch).some((key) => JSON.stringify(before[key as keyof MindDetail]) !== JSON.stringify(item[key as keyof MindDetail]));
    return mutationResult('update', item, changed);
  });

  registerTool('mind_archive_created', {
    description: 'Archive explicit items created by this exact MCP session.',
    inputSchema: { ids: z.array(ID).min(1).max(100), note: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ ids, note }) => {
    const itemIds = Array.from(new Set(ids.map(parseMindId)));
    const items = itemIds.map((id) => {
      if (!createdItemIds.has(id)) throw new Error(`mind: item #${id} was not created by this MCP session`);
      const item = deps.mind.get(id);
      if (!item) throw new Error(`mind: no item #${id}`);
      if (item.claim) throw new Error(`mind: item #${id} has an active claim; release it before session cleanup`);
      return item;
    });
    const archived = items.map((item) => {
      if (item.archivedAt != null) return item;
      deps.mind.addComment(item.id, `Session-scoped archive: ${note}`, actor());
      return deps.mind.archive(item.id, actor());
    });
    const changed = archived.filter((item, index) => items[index].archivedAt == null && item.archivedAt != null).length;
    return toolResult({ items: archived.map(compactItem), archivedIds: archived.filter((item) => item.archivedAt != null).map((item) => item.id) }, { receipt: { operation: 'archive-created', changed: changed > 0 } });
  });

  registerTool('mind_comment', {
    description: 'Add a durable comment to one Mind item without waking the resident agent.',
    inputSchema: { id: ID, body: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, body }) => { const itemId = parseMindId(id); const comment = deps.mind.addComment(itemId, body, actor()); return toolResult({ comment }, { receipt: { operation: 'comment', itemId, changed: true } }); });

  registerTool('mind_link', {
    description: 'Make one item depend on another. Cycles are rejected.',
    inputSchema: { id: ID, depends_on: ID },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, depends_on }) => { const itemId = parseMindId(id); const dependencyId = parseMindId(depends_on); const before = deps.mind.get(itemId)?.dependencies.some((link) => link.id === dependencyId) ?? false; const item = deps.mind.addDependency(itemId, dependencyId, actor()); return mutationResult('link', item, !before, { dependsOnId: dependencyId }); });

  registerTool('mind_unlink', {
    description: 'Remove one dependency edge.',
    inputSchema: { id: ID, depends_on: ID },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ id, depends_on }) => { const itemId = parseMindId(id); const dependencyId = parseMindId(depends_on); const before = deps.mind.get(itemId)?.dependencies.some((link) => link.id === dependencyId) ?? false; const item = deps.mind.removeDependency(itemId, dependencyId, actor()); return mutationResult('unlink', item, before, { dependsOnId: dependencyId }); });

  registerTool('mind_ask', {
    description: 'Post a task-bound clarification, wake the resident agent, and wait for its exact structured reply.',
    inputSchema: { id: ID, body: z.string().min(1).max(32_768), wait_seconds: z.number().int().min(1).max(300).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ id, body, wait_seconds }, extra) => {
    const taskId = parseMindId(id); const from = actor();
    const comment = deps.mind.addComment(taskId, body, from);
    let woke = true;
    try { deps.wake({ taskId, commentId: comment.id, actor: from, body }); }
    catch (error) { woke = false; deps.logger.warn(`mcp: comment c#${comment.id} persisted but wake failed: ${error instanceof Error ? error.message : String(error)}`); }
    const reply = woke ? await waitForReply(deps.mind, taskId, comment.id, (wait_seconds ?? 45) * 1000, extra.signal) : null;
    return toolResult({ comment, woke, reply, timedOut: woke && reply === null, next: reply ? null : { tool: 'mind_await', id: taskId, comment_id: comment.id } });
  });

  registerTool('mind_await', {
    description: 'Wait once for a structured reply to a prior comment cursor.',
    inputSchema: { id: ID, comment_id: z.number().int().positive(), wait_seconds: z.number().int().min(1).max(300).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, comment_id, wait_seconds }, extra) => {
    const taskId = parseMindId(id);
    const source = deps.mind.get(taskId)?.comments.find((comment) => comment.id === comment_id);
    if (!source) throw new Error(`mind: no comment #${comment_id} on item #${taskId}`);
    const reply = await waitForReply(deps.mind, taskId, comment_id, (wait_seconds ?? 45) * 1000, extra.signal);
    return toolResult({ reply, timedOut: reply === null, next: reply ? null : { tool: 'mind_await', id: taskId, comment_id } });
  });

  registerTool('mind_message', {
    description: 'Post a task-bound message, wake the resident agent, and return a mind_await cursor.',
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
    return toolResult({ comment, woke, next: { tool: 'mind_await', id: taskId, comment_id: comment.id } });
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
