import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractChatGptShare,
  isChatGptShareUrl,
  type ChatGptShareFetch,
} from '../src/sandbox/chatgpt-share.js';

type Value =
  null | boolean | number | string | Value[] | { [key: string]: Value };

function flatten(root: unknown): Value[] {
  const values: Value[] = [];
  const seen = new Map<object, number>();
  const intern = (value: unknown): number => {
    if (value === undefined) return -7;
    if (value === null) return -5;
    if (typeof value === 'number' && Number.isNaN(value)) return -2;
    if (value === Number.NEGATIVE_INFINITY) return -3;
    if (Object.is(value, -0)) return -4;
    if (value === Number.POSITIVE_INFINITY) return -6;
    if (typeof value !== 'object') {
      const index = values.length;
      values.push(value as Value);
      return index;
    }
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const index = values.length;
    values.push(null);
    seen.set(value, index);
    if (Array.isArray(value)) {
      values[index] = value.map(intern);
    } else {
      const encoded: Record<string, Value> = Object.create(null);
      for (const [key, child] of Object.entries(value)) {
        encoded[`_${intern(key)}`] = intern(child);
      }
      values[index] = encoded;
    }
    return index;
  };
  assert.equal(intern(root), 0);
  return values;
}

function message(
  role: string,
  contentType: string,
  parts: unknown[],
  hidden = false,
): Record<string, unknown> {
  return {
    author: { role },
    content: { content_type: contentType, parts },
    metadata: hidden ? { is_visually_hidden_from_conversation: true } : {},
  };
}

function shareHtml(): string {
  const mapping = {
    root: { parent: null, children: ['user'], message: null },
    assistant: {
      parent: 'thought',
      children: ['hidden'],
      message: message('assistant', 'multimodal_text', [
        'answer with **markdown**',
        { content_type: 'image_asset_pointer', asset_pointer: 'must-not-leak' },
        { content_type: 'unknown_private_metadata', value: 'must-not-leak' },
      ]),
    },
    user: {
      parent: 'root',
      children: ['thought'],
      message: message('user', 'text', ['question']),
    },
    hidden: {
      parent: 'assistant',
      children: [],
      message: message('user', 'text', ['hidden user text'], true),
    },
    thought: {
      parent: 'user',
      children: ['assistant'],
      message: message('assistant', 'thoughts', ['private chain of thought']),
    },
    tool: {
      parent: null,
      children: [],
      message: message('tool', 'text', ['private tool output']),
    },
  };
  const root = {
    loaderData: {
      root: { irrelevant: true },
      'routes/share.$shareId.($action)': {
        serverResponse: {
          type: 'data',
          data: { title: 'Synthetic\nConversation', mapping },
        },
      },
    },
    actionData: null,
    errors: null,
  };
  const payload = `${JSON.stringify(flatten(root))}\nP99:[{}]\n`;
  const split = Math.floor(payload.length / 2);
  return `<html><body><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(payload.slice(0, split))});</script><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(payload.slice(split))});</script></body></html>`;
}

function fetchHtml(html: string, status = 200): ChatGptShareFetch {
  return async () =>
    new Response(html, {
      status,
      headers: {
        'content-type': 'text/html',
        'content-length': String(Buffer.byteLength(html)),
      },
    });
}

const SHARE = 'https://chatgpt.com/share/12345678-abcd-1234-abcd-1234567890ab';

test('recognizes only pinned HTTPS ChatGPT share routes', () => {
  assert.equal(isChatGptShareUrl(SHARE), true);
  assert.equal(
    isChatGptShareUrl('https://www.chatgpt.com/share/abcdefgh'),
    true,
  );
  assert.equal(
    isChatGptShareUrl('https://chat.openai.com/share/abcdefgh'),
    true,
  );
  assert.equal(isChatGptShareUrl('http://chatgpt.com/share/abcdefgh'), false);
  assert.equal(
    isChatGptShareUrl('https://chatgpt.com.evil/share/abcdefgh'),
    false,
  );
  assert.equal(
    isChatGptShareUrl('https://chatgpt.com/backend-api/conversation/x'),
    false,
  );
  assert.equal(
    isChatGptShareUrl('https://user@chatgpt.com/share/abcdefgh'),
    false,
  );
});

test('decodes chunked loader data in graph order and emits only visible text', async () => {
  const result = await extractChatGptShare(SHARE, {}, fetchHtml(shareHtml()));
  assert.equal(result.ok, true);
  assert.equal(
    result.markdown,
    '# Synthetic Conversation\n\n## User\n\nquestion\n\n## Assistant\n\nanswer with **markdown**\n\n[image]',
  );
  assert.deepEqual(result.raw, {
    source: 'chatgpt-share',
    title: 'Synthetic Conversation',
    messageCount: 2,
  });
  assert.doesNotMatch(
    result.markdown ?? '',
    /chain of thought|tool output|hidden user|must-not-leak/,
  );
});

test('fails closed on malformed and missing loader streams', async () => {
  const missing = await extractChatGptShare(
    SHARE,
    {},
    fetchHtml('<html></html>'),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /no loader stream/);

  const malformed = await extractChatGptShare(
    SHARE,
    {},
    fetchHtml('<script>streamController.enqueue("not-json\\n");</script>'),
  );
  assert.equal(malformed.ok, false);
  assert.match(malformed.error ?? '', /could not be decoded/);
});

test('reports deleted shares and refuses redirect escape', async () => {
  const deleted = await extractChatGptShare(SHARE, {}, fetchHtml('gone', 404));
  assert.equal(deleted.ok, false);
  assert.equal(deleted.error, 'ChatGPT share HTTP 404');

  const redirect: ChatGptShareFetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/private' },
    });
  const escaped = await extractChatGptShare(SHARE, {}, redirect);
  assert.equal(escaped.ok, false);
  assert.match(escaped.error ?? '', /outside the pinned share route/);
});

test('rejects oversized responses before reading the body', async () => {
  const oversized: ChatGptShareFetch = async () =>
    new Response('small', {
      headers: { 'content-length': String(9 * 1024 * 1024) },
    });
  const result = await extractChatGptShare(SHARE, {}, oversized);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /exceeded 8 MiB/);
});

test('never fetches an unsupported URL', async () => {
  let calls = 0;
  const fetchImpl: ChatGptShareFetch = async () => {
    calls++;
    throw new Error('must not run');
  };
  const result = await extractChatGptShare(
    'https://example.com/share/abcdefgh',
    {},
    fetchImpl,
  );
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
