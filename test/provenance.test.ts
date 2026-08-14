import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalEndpoint, endpointAt, isTrustedOpaqueReplay, replayIdentityForConfig, stampGeneration, TOOL_CONTRACT_VERSION } from '../src/llm/provenance.js';
import { toApiMessage, prepareForApi, type ChatMessage } from '../src/llm/llm.js';
import { toResponsesInput } from '../src/llm/responses.js';
import { translate } from '../src/llm/anthropic-client.js';
import { createTranscriptStore, loadMostRecentMain, MAIN_TRANSCRIPT_ID } from '../src/store/sessions.js';
import { buildTestAgent } from './helpers.js';
import { makeConfig, makeStubLLM } from './helpers.js';
import { createLLM } from '../src/llm/llm.js';
import { createServer } from 'node:http';
import { createContextTracker } from '../src/llm/context-tracker.js';
import { createCompactor } from '../src/llm/compactor.js';

const provenance = () => ({
  providerType: 'openai-compatible' as const, model: 'gpt-5.6-sol', apiSurface: 'responses' as const,
  apiEndpoint: new URL('/v1/responses?token=fixture#frag', `https://${'user'}:${'pass'}@private.example`).href,
  reasoningEffort: 'high', generatedAt: '2026-08-08T12:00:00.000Z', requestId: 'req-1', harnessCommit: 'abc123',
});

test('generation provenance strips URL credentials/query/fragment and records contract', () => {
  const message: ChatMessage = { role: 'assistant', content: 'ok' };
  stampGeneration(message, provenance());
  assert.equal(message.provenance!.apiEndpoint, 'https://private.example/v1/responses');
  assert.equal(message.provenance!.toolContractVersion, TOOL_CONTRACT_VERSION);
});

test('endpointAt preserves configured API base paths', () => {
  assert.equal(endpointAt('https://api.example/coding/v1/', '/chat/completions'), 'https://api.example/coding/v1/chat/completions');
  assert.equal(canonicalEndpoint(new URL('/x?q=1#x', `https://${'u'}:${'p'}@a.test`).href), 'https://a.test/x');
});

test('provenance is excluded from every provider request surface', () => {
  const assistant: ChatMessage = { role: 'assistant', content: 'ok' }; stampGeneration(assistant, provenance());
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, assistant];
  assert.doesNotMatch(JSON.stringify(toApiMessage(assistant)), /provenance|private\.example/);
  assert.doesNotMatch(JSON.stringify(toResponsesInput(prepareForApi(messages))), /provenance|private\.example/);
  assert.doesNotMatch(JSON.stringify(translate(messages)), /provenance|private\.example/);
});

test('provenance survives transcript restoration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-session-')); const store = createTranscriptStore(dir);
  const message: ChatMessage = { role: 'assistant', content: 'ok' }; stampGeneration(message, provenance());
  store.append(MAIN_TRANSCRIPT_ID, message);
  const loaded = loadMostRecentMain(dir)!.messages[0];
  assert.deepEqual(loaded.provenance, message.provenance);
  fs.rmSync(dir, { recursive: true, force: true });
});


test('restart replay keeps opaque reasoning only for an exact provider/model/surface/endpoint identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-replay-'));
  const store = createTranscriptStore(dir);
  const message: ChatMessage = {
    role: 'assistant', content: 'visible answer',
    reasoning_items: [{ type: 'reasoning', summary: [], encrypted_content: 'opaque' }],
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'run', arguments: '{"code":"1"}' } }],
  };
  stampGeneration(message, {
    providerType: 'openai-compatible', model: 'model-a', apiSurface: 'responses',
    apiEndpoint: 'https://api.example/v1/responses', harnessCommit: 'abc',
  });
  store.append(MAIN_TRANSCRIPT_ID, message);
  const exact = { providerType: 'openai-compatible' as const, model: 'model-a', apiSurface: 'responses' as const, apiEndpoint: 'https://api.example/v1/responses' };
  const kept = loadMostRecentMain(dir, { opaqueReplayIdentity: exact })!.messages[0];
  assert.equal(kept.reasoning_items?.length, 1);
  const stripped = loadMostRecentMain(dir, { opaqueReplayIdentity: { ...exact, model: 'model-b' } })!.messages[0];
  assert.equal(stripped.reasoning_items, undefined);
  assert.equal(stripped.content, 'visible answer');
  assert.equal(stripped.tool_calls?.[0].id, 'call-1');
  assert.equal(stripped.provenance?.model, 'model-a');
  const unprovenanced = { ...message, provenance: undefined };
  store.append(MAIN_TRANSCRIPT_ID, unprovenanced);
  assert.equal(loadMostRecentMain(dir, { opaqueReplayIdentity: exact })!.messages.at(-1)?.reasoning_items, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('offline transcript parsing remains lossless when no replay boundary is requested', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-offline-'));
  const store = createTranscriptStore(dir);
  store.append(MAIN_TRANSCRIPT_ID, { role: 'assistant', content: 'x', reasoning_items: [{ type: 'reasoning', summary: [], encrypted_content: 'raw' }] });
  assert.equal(loadMostRecentMain(dir)!.messages[0].reasoning_items?.[0].encrypted_content, 'raw');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('configured replay identity is exact and Chat Completions has no opaque replay identity', () => {
  const base = makeConfig();
  const responses = makeConfig({ llm: { ...base.llm, providerType: 'openai-compatible', model: 'm', baseUrl: 'https://api.example/v1', api: 'responses' } });
  assert.deepEqual(replayIdentityForConfig(responses), {
    providerType: 'openai-compatible', model: 'm', apiSurface: 'responses', apiEndpoint: 'https://api.example/v1/responses',
  });
  assert.equal(replayIdentityForConfig(makeConfig({ llm: { ...base.llm, api: 'chat' } })), null);
  assert.equal(isTrustedOpaqueReplay(undefined, replayIdentityForConfig(responses)), false);
});

test('clear-thinking removes native reasoning but retains provenance', () => {
  const built = buildTestAgent();
  const message: ChatMessage = { role: 'assistant', content: 'ok', reasoning_items: [{ type: 'reasoning', summary: [] }], thinking_blocks: [{ type: 'redacted_thinking', data: 'opaque' }] };
  stampGeneration(message, provenance()); built.agent.messagesForTest.push(message);
  built.agent.clearThinking();
  assert.equal(message.reasoning_items, undefined); assert.equal(message.thinking_blocks, undefined);
  assert.equal(message.provenance?.model, 'gpt-5.6-sol');
  assert.equal(loadMostRecentMain(path.join(built.tmpDir,'sessions'))?.messages.at(-1)?.provenance?.requestId,'req-1'); built.cleanup();
});

test('a later provider/model stamp replaces attribution without mixing epochs', () => {
  const message: ChatMessage = { role: 'assistant', content: '' }; stampGeneration(message, provenance());
  stampGeneration(message, { providerType:'anthropic-oauth',model:'claude-opus-5',apiSurface:'anthropic-messages',apiEndpoint:'https://api.anthropic.com/v1/messages',generatedAt:'2026-08-08T13:00:00Z',harnessCommit:'def' });
  assert.equal(message.provenance?.providerType, 'anthropic-oauth'); assert.equal(message.provenance?.model, 'claude-opus-5');
  assert.equal(message.provenance?.apiSurface, 'anthropic-messages');
});

test('automatic Responses fallback attributes the successful Chat endpoint', async () => {
  let responses = 0, chats = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/responses') { responses++; res.writeHead(404, {'content-type':'application/json'}).end('{"error":{"message":"missing"}}'); return; }
    if (req.url === '/v1/chat/completions') { chats++; res.writeHead(200, {'content-type':'text/event-stream','x-request-id':'req-fallback'}); res.end('data: '+JSON.stringify({id:'x',object:'chat.completion.chunk',created:1,model:'swap-model',choices:[{index:0,finish_reason:'tool_calls',delta:{tool_calls:[{index:0,id:'c',type:'function',function:{name:'run',arguments:'{"code":"","end":true}'}}]}}]})+'\n\ndata: '+JSON.stringify({id:'x',object:'chat.completion.chunk',created:1,model:'swap-model',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n'); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve)); const address=server.address(); if (!address || typeof address==='string') throw new Error('no address');
  try {
    const llm=createLLM(makeConfig({llm:{...makeConfig().llm,baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test',model:'swap-model',api:'auto'}}));
    const result=await llm.complete([{role:'user',content:'hi'}]);
    assert.equal(result.message.provenance?.apiSurface,'chat-completions');
    assert.equal(result.message.provenance?.apiEndpoint,`http://127.0.0.1:${address.port}/v1/chat/completions`);
    assert.equal(result.message.provenance?.requestId,'req-fallback');
    await llm.complete([{role:'user',content:'again'}]); assert.equal(responses,1); assert.equal(chats,2);
  } finally { await new Promise<void>((resolve)=>server.close(()=>resolve())); }
});

test('transport retry retains the endpoint and request id of the successful generation', async () => {
  let calls=0;
  const server=createServer((req,res)=>{ calls++; if(calls===1){res.writeHead(500,{'content-type':'application/json'}).end('{"error":{"message":"retry"}}');return;} res.writeHead(200,{'content-type':'text/event-stream','x-request-id':'req-after-retry'}); res.end('data: '+JSON.stringify({id:'x',object:'chat.completion.chunk',created:1,model:'retry-model',choices:[{index:0,finish_reason:'tool_calls',delta:{tool_calls:[{index:0,id:'c',type:'function',function:{name:'run',arguments:'{"code":"","end":true}'}}]}}]})+'\n\ndata: '+JSON.stringify({id:'x',object:'chat.completion.chunk',created:1,model:'retry-model',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n'); });
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve)); const address=server.address(); if(!address||typeof address==='string')throw new Error('no address');
  try { const llm=createLLM(makeConfig({llm:{...makeConfig().llm,baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'test',model:'retry-model',api:'chat'}})); const result=await llm.complete([{role:'user',content:'hi'}]); assert.equal(calls,2); assert.equal(result.message.provenance?.apiSurface,'chat-completions'); assert.equal(result.message.provenance?.requestId,'req-after-retry'); }
  finally { await new Promise<void>((resolve)=>server.close(()=>resolve())); }
});

test('compaction preserves provenance on the verbatim tail', async () => {
  const tracker=createContextTracker(10_000,100); const llm=makeStubLLM({summarize:async()=> 'A sufficiently detailed summary of the earlier context for this test.'});
  const compactor=createCompactor(llm,tracker,{keepTokens:20});
  const tail: ChatMessage={role:'assistant',content:'latest generation '.repeat(10)}; stampGeneration(tail,provenance());
  const messages: ChatMessage[]=[...Array.from({length:8},(_,i)=>({role:'user' as const,content:`old ${i} `.repeat(30)})),tail];
  compactor.start(messages); await compactor.done(); const next=compactor.applyCompaction(messages);
  assert.equal(next.find((m)=>m.content===tail.content)?.provenance?.requestId,'req-1');
});
