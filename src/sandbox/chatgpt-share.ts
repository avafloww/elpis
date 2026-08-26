const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_FLAT_VALUES = 200_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const SHARE_HOSTS = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'chat.openai.com',
]);

export interface ChatGptShareExtractResult {
  ok: boolean;
  url: string;
  markdown: string | null;
  error: string | null;
  raw: unknown;
}

export type ChatGptShareFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function isChatGptShareUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      (url.port === '' || url.port === '443') &&
      SHARE_HOSTS.has(url.hostname.toLowerCase()) &&
      /^\/share\/[A-Za-z0-9-]{8,128}\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    throw new Error('ChatGPT share response exceeded 8 MiB');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_HTML_BYTES) {
      throw new Error('ChatGPT share response exceeded 8 MiB');
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error('ChatGPT share response exceeded 8 MiB');
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchShare(
  input: string,
  fetchImpl: ChatGptShareFetch,
  signal: AbortSignal,
): Promise<{ response: Response; url: string }> {
  let current = new URL(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Elpis ChatGPT share extractor',
      },
    });
    if (response.status < 300 || response.status >= 400) {
      return { response, url: current.href };
    }
    const location = response.headers.get('location');
    if (!location || redirects === MAX_REDIRECTS) {
      throw new Error('ChatGPT share redirect was incomplete or excessive');
    }
    const next = new URL(location, current);
    if (!isChatGptShareUrl(next.href)) {
      throw new Error(
        'ChatGPT share redirected outside the pinned share route',
      );
    }
    current = next;
  }
  throw new Error('ChatGPT share redirect limit exceeded');
}

function extractStreamChunks(html: string): string[] {
  const marker = 'streamController.enqueue';
  const chunks: string[] = [];
  let total = 0;
  let cursor = 0;
  while (cursor < html.length) {
    const found = html.indexOf(marker, cursor);
    if (found < 0) break;
    let at = found + marker.length;
    while (/\s/.test(html[at] ?? '')) at++;
    if (html[at] !== '(') {
      cursor = at;
      continue;
    }
    at++;
    while (/\s/.test(html[at] ?? '')) at++;
    if (html[at] !== '"') {
      cursor = at;
      continue;
    }
    const start = at;
    at++;
    let escaped = false;
    for (; at < html.length; at++) {
      const char = html[at];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    if (at >= html.length) throw new Error('unterminated ChatGPT stream chunk');
    let chunk: unknown;
    try {
      chunk = JSON.parse(html.slice(start, at + 1));
    } catch {
      throw new Error('invalid ChatGPT stream string');
    }
    if (typeof chunk !== 'string')
      throw new Error('non-string ChatGPT stream chunk');
    total += Buffer.byteLength(chunk);
    if (total > MAX_STREAM_BYTES)
      throw new Error('ChatGPT stream exceeded 8 MiB');
    chunks.push(chunk);
    cursor = at + 1;
  }
  if (chunks.length === 0)
    throw new Error('ChatGPT share contained no loader stream');
  return chunks;
}

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function unflatten(values: JsonValue[]): unknown {
  if (values.length === 0 || values.length > MAX_FLAT_VALUES) {
    throw new Error('invalid ChatGPT flattened value count');
  }
  const state = new Uint8Array(values.length);
  const hydrated: unknown[] = new Array(values.length);

  const hydrate = (index: number, depth: number): unknown => {
    if (index === -1) return undefined;
    if (index === -2) return Number.NaN;
    if (index === -3) return Number.NEGATIVE_INFINITY;
    if (index === -4) return -0;
    if (index === -5) return null;
    if (index === -6) return Number.POSITIVE_INFINITY;
    if (index === -7) return undefined;
    if (!Number.isInteger(index) || index < 0 || index >= values.length) {
      throw new Error('ChatGPT flattened reference was out of bounds');
    }
    if (depth > 256)
      throw new Error('ChatGPT flattened value nesting was excessive');
    if (state[index] === 2 || state[index] === 1) return hydrated[index];
    const value = values[index];
    if (value === null || typeof value !== 'object') {
      hydrated[index] = value;
      state[index] = 2;
      return value;
    }
    state[index] = 1;
    if (Array.isArray(value)) {
      if (typeof value[0] === 'string') {
        if (value[0] === 'P') {
          hydrated[index] = undefined;
          state[index] = 2;
          return undefined;
        }
        throw new Error(`unsupported ChatGPT flattened type ${value[0]}`);
      }
      const result: unknown[] = [];
      hydrated[index] = result;
      for (const reference of value) {
        if (reference === -1) {
          result.length++;
        } else if (typeof reference === 'number') {
          result.push(hydrate(reference, depth + 1));
        } else {
          throw new Error('invalid ChatGPT flattened array reference');
        }
      }
      state[index] = 2;
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    hydrated[index] = result;
    for (const [encodedKey, reference] of Object.entries(value)) {
      if (!/^_[0-9]+$/.test(encodedKey) || typeof reference !== 'number') {
        throw new Error('invalid ChatGPT flattened object reference');
      }
      const key = hydrate(Number(encodedKey.slice(1)), depth + 1);
      if (typeof key !== 'string')
        throw new Error('invalid ChatGPT flattened object key');
      Object.defineProperty(result, key, {
        value: hydrate(reference, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    state[index] = 2;
    return result;
  };

  return hydrate(0, 0);
}

function decodeLoaderRoot(chunks: string[]): unknown {
  const stream = chunks.join('');
  for (const line of stream.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    try {
      const root = unflatten(parsed as JsonValue[]);
      if (root && typeof root === 'object' && 'loaderData' in root) return root;
    } catch {
      continue;
    }
  }
  throw new Error('ChatGPT share loader data could not be decoded');
}

function findConversationData(root: unknown): Record<string, unknown> {
  if (!root || typeof root !== 'object')
    throw new Error('invalid ChatGPT loader root');
  const loaderData = (root as Record<string, unknown>).loaderData;
  if (!loaderData || typeof loaderData !== 'object')
    throw new Error('missing ChatGPT loader data');
  for (const route of Object.values(loaderData)) {
    if (!route || typeof route !== 'object') continue;
    const serverResponse = (route as Record<string, unknown>).serverResponse;
    if (!serverResponse || typeof serverResponse !== 'object') continue;
    const data = (serverResponse as Record<string, unknown>).data;
    if (!data || typeof data !== 'object') continue;
    const mapping = (data as Record<string, unknown>).mapping;
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
      return data as Record<string, unknown>;
    }
  }
  throw new Error('ChatGPT share contained no conversation mapping');
}

function orderedNodes(
  mapping: Record<string, unknown>,
): Record<string, unknown>[] {
  const entries = Object.entries(mapping);
  const byId = new Map(entries.map(([id, node]) => [id, node]));
  const visited = new Set<string>();
  const result: Record<string, unknown>[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const raw = byId.get(id);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const node = raw as Record<string, unknown>;
    result.push(node);
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) if (typeof child === 'string') visit(child);
    }
  };
  for (const [id, raw] of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const parent = (raw as Record<string, unknown>).parent;
    if (typeof parent !== 'string' || !byId.has(parent)) visit(id);
  }
  for (const [id] of entries) visit(id);
  return result;
}

function visibleText(
  node: Record<string, unknown>,
): { role: 'User' | 'Assistant'; text: string } | null {
  const message = node.message;
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const metadata = msg.metadata;
  if (
    metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>)
      .is_visually_hidden_from_conversation === true
  ) {
    return null;
  }
  const author = msg.author;
  if (!author || typeof author !== 'object') return null;
  const role = (author as Record<string, unknown>).role;
  if (role !== 'user' && role !== 'assistant') return null;
  const content = msg.content;
  if (!content || typeof content !== 'object') return null;
  const body = content as Record<string, unknown>;
  if (
    (body.content_type !== 'text' && body.content_type !== 'multimodal_text') ||
    !Array.isArray(body.parts)
  ) {
    return null;
  }
  const parts = body.parts.flatMap((part): string[] => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const type = (part as Record<string, unknown>).content_type;
    if (type === 'image_asset_pointer') return ['[image]'];
    if (type === 'audio_asset_pointer') return ['[audio]'];
    return [];
  });
  const text = parts.join('\n\n').trim();
  if (!text) return null;
  return { role: role === 'user' ? 'User' : 'Assistant', text };
}

function formatMarkdown(data: Record<string, unknown>): {
  markdown: string;
  title: string;
  count: number;
} {
  const mapping = data.mapping;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('invalid ChatGPT conversation mapping');
  }
  const messages = orderedNodes(mapping as Record<string, unknown>)
    .map(visibleText)
    .filter(
      (message): message is NonNullable<typeof message> => message !== null,
    );
  if (messages.length === 0)
    throw new Error('ChatGPT share contained no visible text messages');
  const title =
    typeof data.title === 'string' && data.title.trim()
      ? data.title.replace(/\s+/g, ' ').trim().slice(0, 500)
      : 'ChatGPT conversation';
  const markdown = [
    `# ${title}`,
    ...messages.map((m) => `## ${m.role}\n\n${m.text}`),
  ].join('\n\n');
  if (Buffer.byteLength(markdown) > MAX_OUTPUT_BYTES) {
    throw new Error('ChatGPT conversation markdown exceeded 4 MiB');
  }
  return { markdown, title, count: messages.length };
}

export async function extractChatGptShare(
  url: string,
  opts: { timeout?: number } = {},
  fetchImpl: ChatGptShareFetch = fetch,
): Promise<ChatGptShareExtractResult> {
  if (!isChatGptShareUrl(url)) {
    return {
      ok: false,
      url,
      markdown: null,
      error: 'not a supported ChatGPT share URL',
      raw: null,
    };
  }
  const requestedTimeout = opts.timeout ?? 10;
  const timeout = Number.isFinite(requestedTimeout)
    ? Math.min(30, Math.max(1, requestedTimeout))
    : 10;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const fetched = await fetchShare(url, fetchImpl, controller.signal);
    if (!fetched.response.ok) {
      return {
        ok: false,
        url,
        markdown: null,
        error: `ChatGPT share HTTP ${fetched.response.status}`,
        raw: { source: 'chatgpt-share', status: fetched.response.status },
      };
    }
    const html = await readBoundedText(fetched.response);
    const root = decodeLoaderRoot(extractStreamChunks(html));
    const formatted = formatMarkdown(findConversationData(root));
    return {
      ok: true,
      url,
      markdown: formatted.markdown,
      error: null,
      raw: {
        source: 'chatgpt-share',
        title: formatted.title,
        messageCount: formatted.count,
      },
    };
  } catch (error) {
    return {
      ok: false,
      url,
      markdown: null,
      error: error instanceof Error ? error.message : String(error),
      raw: { source: 'chatgpt-share' },
    };
  } finally {
    clearTimeout(timer);
  }
}
