// web.ts — Kagi web search / page extraction, extracted from globals.ts.
//
// Native JS wrappers around the Kagi Search/Extract API. These are in-process
// fetch calls, not LLM tool_calls, so the agent composes them inside run
// code. Auth is read from deps.config.kagi.apiKey (`kagi.api_key` in config.yaml); when
// it is unset, search/extract throw a teachable error and nothing else is
// affected. `kagiSearch`/`kagiExtract` back the `search`/`extract` sandbox
// globals in globals.ts.

import type { SandboxDeps } from '../types.js';

export interface KagiSearchResult {
  title: string;
  url: string;
  snippet?: string;
  time?: string;
  [key: string]: unknown;
}

async function kagiRequest(
  path: string,
  body: unknown,
  apiKey: string,
): Promise<unknown> {
  const res = await fetch(`https://kagi.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kagi ${path} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function formatSearchResults(data: any): KagiSearchResult[] {
  const items: any[] = data?.data?.search ?? [];
  return items.map((item: any) => ({
    title: item.title ?? '',
    url: item.url ?? '',
    snippet: item.snippet ?? '',
    time: item.time ?? '',
  }));
}

/** search(query, opts?) — Kagi web search. Requires `kagi.api_key`. */
export async function kagiSearch(
  deps: SandboxDeps,
  query: string,
  opts: { limit?: number; workflow?: string } = {},
): Promise<{
  ok: true;
  query: string;
  results: KagiSearchResult[];
  raw: unknown;
}> {
  const apiKey = deps.config.kagi.apiKey;
  if (!apiKey)
    throw new Error(
      'search() requires a Kagi API key: set `kagi.api_key` in config.yaml',
    );
  const data = await kagiRequest(
    '/api/v1/search',
    {
      query,
      limit: opts.limit ?? 10,
      workflow: opts.workflow ?? 'search',
    },
    apiKey,
  );
  return { ok: true, query, results: formatSearchResults(data), raw: data };
}

/** extract(url, opts?) — Kagi page extraction (URL → markdown). Requires
 * `kagi.api_key`. */
export async function kagiExtract(
  deps: SandboxDeps,
  url: string,
  opts: { timeout?: number; format?: string } = {},
): Promise<{
  ok: boolean;
  url: string;
  markdown: string | null;
  error: string | null;
  raw: unknown;
}> {
  const apiKey = deps.config.kagi.apiKey;
  if (!apiKey)
    throw new Error(
      'extract() requires a Kagi API key: set `kagi.api_key` in config.yaml',
    );
  const data = (await kagiRequest(
    '/api/v1/extract',
    {
      pages: [{ url }],
      timeout: opts.timeout ?? 5,
      format: opts.format ?? 'json',
    },
    apiKey,
  )) as any;
  const page = data?.data?.[0] ?? {};
  // Success-shaped failure was the softness: ok:true + markdown:null meant a
  // dead extract looked like a valid one ( / hardness-audit lens 2).
  // Surface the API's own error on ok:false so chained .slice/.length fails
  // informatively instead of crashing on null in a later turn.
  const markdown = typeof page.markdown === 'string' ? page.markdown : null;
  const apiError =
    page.error ??
    (markdown === null ? 'no markdown returned from Kagi crawlers' : null);
  return { ok: markdown !== null, url, markdown, error: apiError, raw: data };
}
