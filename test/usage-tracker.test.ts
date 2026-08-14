// Unit tests for the provider subscription-usage tracker (src/usage-tracker.ts).
// Pure parsing + detection + poller behavior with an injected fetch stub.
// No network. Run with: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageTracker, parseKimiUsages, windowLabel, detectProvider,
  type ProviderUsageSnapshot,
} from '../src/llm/usage-tracker.js';
import { makeConfig } from './helpers.js';

// The REAL /usages response captured live on (user ids scrubbed).
const KIMI_FIXTURE = JSON.parse('{"user":{"userId":"u1","region":"REGION_OVERSEA","membership":{"level":"LEVEL_INTERMEDIATE"},"businessId":""},"usage":{"limit":"100","used":"21","remaining":"79","resetTime":"2026-07-28T19:36:03.631117Z"},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","used":"4","remaining":"96","resetTime":"2026-07-22T05:36:03.631117Z"}}],"parallel":{"limit":"20"},"totalQuota":{},"authentication":{"method":"METHOD_API_KEY","scope":"FEATURE_CODING"},"subType":"TYPE_PURCHASE","domain":"DOMAIN_NEXUS"}');

const kimiConfig = (over: Partial<ReturnType<typeof makeConfig>['usageTracker']> = {}) =>
  makeConfig({
    llm: { ...makeConfig().llm, baseUrl: 'https://api.kimi.com/coding/v1', apiKey: 'sk-kimi-test' },
    usageTracker: { enabled: true, pollIntervalMs: 300000, ...over },
  });

// A fetch stub that replays canned {status, json} responses in order.
function stubFetch(responses: { status: number; body?: unknown }[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

// ---------- detection ----------

test('detectProvider: matches api.kimi.com/coding/*, rejects others', () => {
  assert.equal(detectProvider('https://api.kimi.com/coding/v1')?.id, 'kimi');
  assert.deepEqual(detectProvider('https://api.kimi.com/coding/v1/'), { id: 'kimi', label: 'Kimi' });
  assert.equal(detectProvider('https://api.code.umans.ai/v1'), null);
  assert.equal(detectProvider('https://api.openai.com/v1'), null);
  assert.equal(detectProvider('not a url'), null);
});

test('createUsageTracker: null when no provider matches or tracking disabled', () => {
  assert.equal(createUsageTracker(makeConfig(), () => {}), null); // http://stub
  assert.equal(createUsageTracker(kimiConfig({ enabled: false }), () => {}), null);
  assert.notEqual(createUsageTracker(kimiConfig(), () => {}), null);
});

// ---------- parsing ----------

test('windowLabel: synthesizes 5h / 7d / 1mo style labels from duration+unit', () => {
  assert.equal(windowLabel(300, 'TIME_UNIT_MINUTE'), '5h');
  assert.equal(windowLabel(7, 'TIME_UNIT_DAY'), '7d');
  assert.equal(windowLabel(1, 'TIME_UNIT_MONTH'), '1mo');
  assert.equal(windowLabel(90, 'TIME_UNIT_MINUTE'), '90m');
});

test('parseKimiUsages: real fixture → 5h and 7d windows, shortest first, string→pct math', () => {
  const w = parseKimiUsages(KIMI_FIXTURE);
  assert.equal(w.length, 2);
  assert.equal(w[0].label, '5h');
  assert.equal(w[0].usedPct, 4);
  assert.equal(w[0].resetAt, '2026-07-22T05:36:03.631117Z');
  assert.equal(w[1].label, '7d');
  assert.equal(w[1].usedPct, 21);
  assert.equal(w[1].resetAt, '2026-07-28T19:36:03.631117Z');
});

test('parseKimiUsages: rows with missing/zero limit are skipped; garbage tolerated', () => {
  assert.deepEqual(parseKimiUsages({}), []);
  assert.deepEqual(parseKimiUsages(null), []);
  assert.deepEqual(parseKimiUsages({ usage: { limit: '0', used: '5' } }), []);
  const only5h = parseKimiUsages({ limits: KIMI_FIXTURE.limits });
  assert.equal(only5h.length, 1);
  assert.equal(only5h[0].label, '5h');
});

// ---------- poller ----------

test('fetchNow: GETs {base}/usages with bearer key + KimiCLI UA, snapshot carries windows', async () => {
  const { fn, calls } = stubFetch([{ status: 200, body: KIMI_FIXTURE }]);
  let updates = 0;
  const t = createUsageTracker(kimiConfig(), () => { updates++; }, fn)!;
  assert.equal(t.snapshot(), null, 'no snapshot before the first poll');
  const snap = await t.fetchNow();
  assert.equal(calls[0].url, 'https://api.kimi.com/coding/v1/usages');
  assert.equal(calls[0].headers['Authorization'], 'Bearer sk-kimi-test');
  assert.equal(calls[0].headers['User-Agent'], 'KimiCLI/1.6');
  assert.equal(snap!.provider, 'kimi');
  assert.equal(snap!.windows.length, 2);
  assert.equal(snap!.error, null);
  assert.ok(snap!.fetchedAt);
  assert.equal(updates, 1, 'onUpdate fired after the poll');
  assert.equal(t.snapshot(), snap, 'snapshot() returns the same object');
});

test('fetchNow: falls back to /usage (singular) on 404', async () => {
  const { fn, calls } = stubFetch([{ status: 404 }, { status: 200, body: KIMI_FIXTURE }]);
  const t = createUsageTracker(kimiConfig(), () => {}, fn)!;
  const snap = await t.fetchNow();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.kimi.com/coding/v1/usage');
  assert.equal(snap!.windows.length, 2);
});

test('fetchNow: failure keeps prior windows, sets error, still fires onUpdate', async () => {
  const { fn } = stubFetch([{ status: 200, body: KIMI_FIXTURE }, { status: 500 }]);
  let updates = 0;
  const t = createUsageTracker(kimiConfig(), () => { updates++; }, fn)!;
  const good = await t.fetchNow();
  const bad = await t.fetchNow();
  assert.equal(updates, 2);
  assert.ok(bad!.error, 'error recorded');
  assert.deepEqual(bad!.windows, good!.windows, 'stale windows kept');
  assert.equal(bad!.fetchedAt, good!.fetchedAt, 'fetchedAt stays at the last success');
});

test('fetchNow: failure before any success → empty windows + error (never throws)', async () => {
  const fn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const t = createUsageTracker(kimiConfig(), () => {}, fn)!;
  const snap = await t.fetchNow();
  assert.deepEqual(snap!.windows, []);
  assert.match(snap!.error!, /ECONNREFUSED/);
});

test('start/stop: first poll ~5s after start, chained reschedule, stop cancels', async () => {
  const { fn, calls } = stubFetch([{ status: 200, body: KIMI_FIXTURE }]);
  const t = createUsageTracker(kimiConfig({ pollIntervalMs: 20 }), () => {}, fn)!;
  t.start();
  assert.equal(calls.length, 0, 'start() alone does not fetch synchronously');
  t.stop();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls.length, 0, 'stop() before the first delay cancels the chain');
});
