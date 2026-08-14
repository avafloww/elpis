// Unit tests for Agent.contextSnapshot — the console context-explorer's source.
//
// The snapshot must be the EXACT request body the next LLM call would send:
// system message first (built by the same builder the turn loop uses), the
// optional request-only Mind frontier last, and the request-assembly diet applied (reasoning stripped at/before the last ended
// turn — prepareForApi), and pure wire-shape messages (toApiMessage: no
// harness-only `channel`/`sends` stamps). It must also be a pure read — the
// in-memory history is never mutated. No network. Run with: npm run test:unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestAgent } from './helpers.js';
import { allowsMindFrontier, elideLargeImageUrls, formatMindFrontier, retainMindFrontierPermission } from '../src/agent.js';
import type { ChatMessage } from '../src/llm/llm.js';
import type { MindItem, MindListFilter, MindService, MindStats } from '../src/store/mind.js';

const history = (): ChatMessage[] => [
 // a COMPLETED turn (no tool_calls ends it) — its reasoning must be stripped
  { role: 'assistant', content: 'settled', reasoning_content: 'old thinking', channel: 'c1' },
  { role: 'user', content: '<incoming-message channel="agora" author="ari" time="2026-07-04T05:09:15.235Z" local-time="12:34">\nhey\n</incoming-message>', channel: 'c1' },
 // the OPEN chain (run call without end:true) — its reasoning must survive
  {
    role: 'assistant', content: '', reasoning_content: 'live thinking', channel: 'c1',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ code: '1+1' }) } }],
  },
  { role: 'tool', content: '[run ok — 12ms]\n2', tool_call_id: 'call_1', channel: 'c1', sends: [{ channel: 'agora', text: 'hi' }] },
];

test('contextSnapshot: system message first, wire shape only, request-assembly diet applied', () => {
  const primed = history();
  const { agent, config, cleanup } = buildTestAgent({ agentDeps: { initialMessages: primed } });
  try {
    const snap = agent.contextSnapshot();
    assert.equal(snap.model, config.llm.model);
    assert.equal((snap.tools[0] as { function: { name: string } }).function.name, 'run');

    const msgs = snap.messages as Record<string, unknown>[];
    assert.equal(msgs.length, primed.length + 1, 'system message + the one history');
    assert.equal(msgs[0].role, 'system');
    assert.ok(typeof msgs[0].content === 'string' && (msgs[0].content as string).length > 0, 'system prompt built');
    assert.match(msgs[0].content as string, /## Mind practice[\s\S]*Recorded is not promised/);
    assert.doesNotMatch(msgs[0].content as string, /heartbeat digest|digest shows how long/);

 // wire shape: harness-only stamps never appear in what would be sent
    for (const m of msgs) {
      assert.ok(!('channel' in m), 'channel stamp must not reach the wire shape');
      assert.ok(!('sends' in m), 'sends stamp must not reach the wire shape');
    }

 // diet 3a: reasoning at/before the last ENDED turn is stripped; the open
 // chain's reasoning survives (indices shifted +1 by the system message)
    assert.ok(!('reasoning_content' in msgs[1]), 'completed-turn reasoning is stripped');
    assert.equal(msgs[3].reasoning_content, 'live thinking', 'open-chain reasoning survives');

 // pure read: the primed history objects are untouched
    assert.equal(primed[0].reasoning_content, 'old thinking');
    assert.equal(primed[3].sends?.[0].text, 'hi');
  } finally {
    cleanup();
  }
});

const mindItem = (patch: Partial<MindItem>): MindItem => ({
  id: 1, title: 'item', body: '', kind: 'task', status: 'open', effectiveStatus: 'open',
  priority: 2, parentId: null, dueAt: null, createdBy: 'aster', createdAt: 1, updatedAt: 1,
  closedAt: null, archivedAt: null, tags: [], blockedBy: [], blocks: [], childCount: 0,
  commentCount: 0, reminderCount: 0, ...patch,
});

function fakeMind(items: MindItem[], stats: MindStats) {
  return {
    stats: () => stats,
    list: (filter: MindListFilter = {}) => items.filter((item) => {
      if (filter.statuses && !filter.statuses.includes(item.status)) return false;
      if (filter.kinds && !filter.kinds.includes(item.kind)) return false;
      if (filter.ready && (!(item.status === 'open' || item.status === 'inbox') || item.effectiveStatus === 'blocked')) return false;
      if (filter.blocked && item.effectiveStatus !== 'blocked') return false;
      return true;
    }).slice(0, filter.limit),
  };
}

test('formatMindFrontier: commitments and held thoughts stay distinct; bodies stay behind get()', () => {
  const items = [
    mindItem({ id: 7, title: 'Ship it', body: 'private implementation body', status: 'in_progress', effectiveStatus: 'in_progress' }),
    mindItem({ id: 8, title: 'Wait honestly', status: 'waiting', effectiveStatus: 'waiting' }),
    mindItem({ id: 9, title: 'A half thought', kind: 'idea', status: 'open', effectiveStatus: 'open' }),
  ];
  const card = formatMindFrontier(fakeMind(items, { active: 3, ready: 1, blocked: 0, waiting: 1, overdue: 0, done: 0, inbox: 0 }))!;
  assert.match(card, /in progress:[\s\S]*#7 \[in progress\]/);
  assert.match(card, /waiting commitments:[\s\S]*#8 \[waiting\]/);
  assert.match(card, /held thoughts — recorded, not promised; do not auto-act:[\s\S]*#9/);
  assert.ok(!card.includes('private implementation body'), 'frontier must not duplicate item bodies');
});

test('formatMindFrontier: empty cortex emits no synthetic tail', () => {
  assert.equal(formatMindFrontier(fakeMind([], { active: 0, ready: 0, blocked: 0, waiting: 0, overdue: 0, done: 0, inbox: 0 })), null);
});

test('allowsMindFrontier: internal and home pass; social and unknown rooms fail closed', () => {
  const guilds = [{ id: 'g-home', slug: 'home' }, { id: 'g-social', slug: 'social' }];
  const channels = { guildOf: (id: string) => id === 'c-home' ? 'g-home' : id === 'c-social' ? 'g-social' : null };
  assert.equal(allowsMindFrontier(null, channels, guilds), true);
  assert.equal(allowsMindFrontier('c-home', channels, guilds), true);
  assert.equal(allowsMindFrontier('c-social', channels, guilds), false);
  assert.equal(allowsMindFrontier('c-unknown', channels, guilds), false);

  let permission = retainMindFrontierPermission(true, 'c-home', false, channels, guilds);
  permission = retainMindFrontierPermission(permission, 'c-social', false, channels, guilds);
  permission = retainMindFrontierPermission(permission, 'c-home', false, channels, guilds);
  assert.equal(permission, false, 'a later home message cannot reopen a mixed social turn');
});

test('contextSnapshot: wired Mind frontier is a final ephemeral request message', () => {
  const item = mindItem({ id: 12, title: 'Current commitment', status: 'in_progress', effectiveStatus: 'in_progress' });
  const mind = fakeMind([item], { active: 1, ready: 0, blocked: 0, waiting: 0, overdue: 0, done: 0, inbox: 0 });
  const { agent, cleanup } = buildTestAgent({ agentDeps: { mind: mind as unknown as MindService } });
  try {
    const messages = agent.contextSnapshot().messages as { role: string; content: string }[];
    assert.equal(messages.at(-1)?.role, 'user');
    assert.match(messages.at(-1)?.content ?? '', /^<mind-frontier>[\s\S]*#12/);
  } finally {
    cleanup();
  }
});

test('contextSnapshot: huge inline image payloads are elided with a marker; history is untouched', () => {

  const bigUrl = 'data:image/png;base64,' + 'A'.repeat(20000);
  const primed: ChatMessage[] = [{
    role: 'user', channel: 'c1', content: 'look at this frame',
    contentParts: [
      { type: 'text', text: 'look at this frame' },
      { type: 'image_url', image_url: { url: bigUrl } },
    ],
  }];
  const { agent, cleanup } = buildTestAgent({ agentDeps: { initialMessages: primed } });
  try {
    const msgs = agent.contextSnapshot().messages as { content: unknown }[];
    const parts = msgs[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    assert.equal(parts[0].text, 'look at this frame', 'text parts pass through untouched');
    assert.ok(parts[1].image_url!.url.includes('[elided by contextSnapshot: 20022 chars'), 'huge data URI is elided with an honest marker');
    assert.ok(parts[1].image_url!.url.length < 300);
 // the live contentParts array (shared by reference with the real request
 // path) must not have been mutated
    assert.equal(primed[0].contentParts?.[1].image_url?.url, bigUrl);
  } finally {
    cleanup();
  }
});

test('elideLargeImageUrls: small parts and string content pass through unchanged (same object)', () => {
  const small = { role: 'user' as const, content: [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } }] };
  assert.equal(elideLargeImageUrls(small), small, 'no copy when nothing crosses the cap');
  const plain = { role: 'user' as const, content: 'hello' };
  assert.equal(elideLargeImageUrls(plain), plain);
});
