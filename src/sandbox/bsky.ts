// Bluesky/atproto client — raw XRPC, no npm dependency.
// Auth: com.atproto.server.createSession with an app password → accessJwt.
// Writes: com.atproto.repo.createRecord (app.bsky.feed.post).
// Reads: app.bsky.feed.getAuthorFeed, getNotifications, etc.

export interface BskyConfig {
  service: string; // PDS host, e.g. https://bsky.social
  identifier: string; // handle, e.g. agent.example.com
  appPassword: string;
}

export interface BskySession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

let session: BskySession | null = null;
let sessionConfig: BskyConfig | null = null;

async function xrpc(cfg: BskyConfig, method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>, jwt?: string): Promise<any> {
  const url = new URL(cfg.service.replace(/\/$/, '') + '/xrpc/' + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { 'Authorization': `Bearer ${jwt}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message ?? data?.error ?? text.slice(0, 300);
    throw new Error(`bsky ${path} HTTP ${res.status}: ${msg}`);
  }
  return data;
}

async function ensureSession(cfg: BskyConfig): Promise<BskySession> {
  if (session && sessionConfig && sessionConfig.identifier === cfg.identifier) return session;
  const data = await xrpc(cfg, 'POST', 'com.atproto.server.createSession', {
    identifier: cfg.identifier,
    password: cfg.appPassword,
  });
  session = { accessJwt: data.accessJwt, refreshJwt: data.refreshJwt, did: data.did, handle: data.handle };
  sessionConfig = cfg;
  return session;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

interface BskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, string>>;
}

/** Resolve and encode @mentions + URLs using AT Protocol's UTF-8 byte offsets. */
async function detectFacets(cfg: BskyConfig, text: string): Promise<BskyFacet[]> {
  const facets: BskyFacet[] = [];
  const add = (start: number, end: number, feature: Record<string, string>) => {
    facets.push({ index: { byteStart: utf8Length(text.slice(0, start)), byteEnd: utf8Length(text.slice(0, end)) }, features: [feature] });
  };
  const mentionRe = /(^|\s)(@[a-zA-Z0-9.-]+)(?![a-zA-Z0-9.-])/g;
  for (const match of text.matchAll(mentionRe)) {
    const handle = match[2].slice(1);
    try {
      const resolved = await xrpc(cfg, 'GET', 'com.atproto.identity.resolveHandle', undefined, { handle });
      add(match.index + match[1].length, match.index + match[1].length + match[2].length, {
        $type: 'app.bsky.richtext.facet#mention',
        did: resolved.did,
      });
    } catch {
 // An unresolved @word is ordinary text, not a failed post.
    }
  }
  const urlRe = /https?:\/\/[^\s<>]+/g;
  for (const match of text.matchAll(urlRe)) {
    add(match.index, match.index + match[0].length, {
      $type: 'app.bsky.richtext.facet#link',
      uri: match[0],
    });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

async function createRecord(cfg: BskyConfig, s: BskySession, record: Record<string, unknown>): Promise<{ uri: string; cid: string }> {
  const data = await xrpc(cfg, 'POST', 'com.atproto.repo.createRecord', {
    repo: s.did,
    collection: 'app.bsky.feed.post',
    record,
  }, undefined, s.accessJwt);
  return { uri: data.uri, cid: data.cid };
}

/** Post a text to bluesky, with mention/link facets. Returns { uri, cid }. */
export async function bskyPost(cfg: BskyConfig, text: string): Promise<{ uri: string; cid: string }> {
  const s = await ensureSession(cfg);
  return createRecord(cfg, s, {
    $type: 'app.bsky.feed.post',
    text,
    facets: await detectFacets(cfg, text),
    createdAt: new Date().toISOString(),
  });
}

/** Reply with correct root/parent refs and mention/link facets. */
export async function bskyReply(cfg: BskyConfig, text: string, parent: { uri: string; cid: string }, root?: { uri: string; cid: string }): Promise<{ uri: string; cid: string }> {
  const s = await ensureSession(cfg);
  const actualRoot = root ?? parent;
  return createRecord(cfg, s, {
    $type: 'app.bsky.feed.post',
    text,
    facets: await detectFacets(cfg, text),
    reply: { root: actualRoot, parent },
    createdAt: new Date().toISOString(),
  });
}

/** Like a post. Returns the created like record. */
export async function bskyLike(cfg: BskyConfig, uri: string, cid: string): Promise<{ uri: string; cid: string }> {
  const s = await ensureSession(cfg);
  const data = await xrpc(cfg, 'POST', 'com.atproto.repo.createRecord', {
    repo: s.did,
    collection: 'app.bsky.feed.like',
    record: { $type: 'app.bsky.feed.like', subject: { uri, cid }, createdAt: new Date().toISOString() },
  }, undefined, s.accessJwt);
  return { uri: data.uri, cid: data.cid };
}

/** Follow a DID. Returns the created follow record. */
export async function bskyFollow(cfg: BskyConfig, did: string): Promise<{ uri: string; cid: string }> {
  const s = await ensureSession(cfg);
  const data = await xrpc(cfg, 'POST', 'com.atproto.repo.createRecord', {
    repo: s.did,
    collection: 'app.bsky.graph.follow',
    record: { $type: 'app.bsky.graph.follow', subject: did, createdAt: new Date().toISOString() },
  }, undefined, s.accessJwt);
  return { uri: data.uri, cid: data.cid };
}

/** Read the authenticated home timeline; post text is external/untrusted. */
export async function bskyTimeline(cfg: BskyConfig, limit = 20): Promise<Array<{ text: string; author: string; uri: string; cid: string; likes: number; reposts: number }>> {
  const s = await ensureSession(cfg);
  const data = await xrpc(cfg, 'GET', 'app.bsky.feed.getTimeline', undefined, { limit: String(Math.min(limit, 100)) }, s.accessJwt);
  return (data.feed ?? []).map((p: any) => ({
    text: p.post?.record?.text ?? '',
    author: p.post?.author?.handle ?? '',
    uri: p.post?.uri ?? '',
    cid: p.post?.cid ?? '',
    likes: p.post?.likeCount ?? 0,
    reposts: p.post?.repostCount ?? 0,
  }));
}

/** Fetch my own recent posts. */
export async function bskyFeed(cfg: BskyConfig, limit = 10): Promise<Array<{ text: string; likes: number; reposts: number; uri: string }>> {
  const s = await ensureSession(cfg);
  const data = await xrpc(cfg, 'GET', 'app.bsky.feed.getAuthorFeed', undefined, { actor: s.handle, limit: String(limit) }, s.accessJwt);
  return (data.feed ?? []).map((p: any) => ({
    text: p.post?.record?.text ?? '',
    likes: p.post?.likeCount ?? 0,
    reposts: p.post?.repostCount ?? 0,
    uri: p.post?.uri ?? '',
  }));
}

/** Unread notification count + recent notifications. */
export async function bskyNotifications(cfg: BskyConfig, limit = 10): Promise<{ unread: number; items: Array<{ reason: string; author: string; text?: string }> }> {
  const s = await ensureSession(cfg);
  const count = await xrpc(cfg, 'GET', 'app.bsky.notification.getUnreadCount', undefined, {}, s.accessJwt);
  const list = await xrpc(cfg, 'GET', 'app.bsky.notification.listNotifications', undefined, { limit: String(limit) }, s.accessJwt);
  return {
    unread: count.count ?? 0,
    items: (list.notifications ?? []).map((n: any) => ({
      reason: n.reason,
      author: n.author?.handle ?? '',
      text: n.record?.text,
    })),
  };
}
