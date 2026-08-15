import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { epochsFromJournal, attributeGeneration, qualifiesForModelSpecificMining } from '../bench/data/epochs.js';
import { buildTranscriptIndex } from '../bench/data/index.js';
import { privacyScan, sanitizeEpisode, assertRemoteSanitizationAllowed, sourceOverlap } from '../bench/data/sanitize.js';
import { publicEndpoint, publicizeEpisode } from '../bench/data/export.js';
import { assignedTeachers, behavioralPreference, selectTeacherCandidates, teacherWeight, teachersAfterFirstAttempt } from '../bench/data/teachers.js';
import { HARD_TEST_SCENARIO, ORDINARY_TEST_SCENARIO, SEEDED_HEARTBEAT_TEST_SCENARIO } from './bench-scenario-fixtures.js';
import { parseScenario, SCHEMA_VERSION, type Episode } from '../bench/schema.js';
import { TOOL_CONTRACT_VERSION } from '../src/llm/provenance.js';

test('journal epochs handle rapid swaps and boundary ambiguity',()=>{
  const e=epochsFromJournal([
    {at:'2026-01-01T00:00:00Z',processId:'p',message:'provider=openai-compatible model=sol surface=responses endpoint=https://a/v1/responses'},
    {at:'2026-01-01T00:00:01Z',processId:'p',message:'provider=anthropic-oauth model=opus surface=anthropic-messages endpoint=https://api.anthropic.com/v1/messages'},
  ]);
  assert.equal(e[0].endedAt,'2026-01-01T00:00:01Z'); assert.equal(attributeGeneration('2026-01-01T00:00:00.500Z',undefined,e).confidence,'high');
  assert.equal(qualifiesForModelSpecificMining('medium'),false);
});

test('transcript index deduplicates restart overlap and rejects truncated calls',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-index-')); const a=path.join(root,'a.jsonl'),b=path.join(root,'b.jsonl');
  const lines=[{role:'user',content:'hi',channel:'1'},{role:'assistant',content:'',tool_calls:[{id:'c',type:'function',function:{name:'run',arguments:'{"code":"x","end":true}'}}]}];
  fs.writeFileSync(a,lines.map(JSON.stringify).join('\n')+'\n'); fs.writeFileSync(b,lines.map(JSON.stringify).join('\n')+'\n');
  const index=buildTranscriptIndex([root]); assert.equal(index.turns.length,1); assert.equal(index.deduplicated,1); assert.equal(index.rejected,1);
  fs.rmSync(root,{recursive:true,force:true});
});

const episode: Episode={schemaVersion:SCHEMA_VERSION,id:'e',source:'synthetic',task:'email me at a@real.example',messages:[{role:'user',content:'token sk_secretvalue and /srv/example/private'}],provenance:[{apiEndpoint:'https://private.example/v1/responses',apiSurface:'responses'}],attributionConfidence:'exact',toolContractVersion:TOOL_CONTRACT_VERSION,accepted:true,review:{status:'approved',approvedAt:'2026-01-01',approvedBy:'tester'}};
test('sanitization removes contacts/secrets/paths and public export pseudonymizes private endpoints',()=>{
  const result=sanitizeEpisode(episode); assert.deepEqual(result.findings,[]); assert.deepEqual(privacyScan(result.episode),[]);
  assert.match(publicEndpoint('https://private.example/v1/responses','responses','salt'),/^opaque:\/\/responses\//);
  assert.equal(publicEndpoint('https://api.anthropic.com/v1/messages','anthropic-messages','salt'),'https://api.anthropic.com/v1/messages');
  assert.match(String(publicizeEpisode({...episode,task:'synthetic'},'salt').provenance[0].apiEndpoint),/^opaque:/);
  assert.throws(()=>publicizeEpisode({...episode,source:'private-real'},'salt'),/permanently private/);
  assert.throws(()=>assertRemoteSanitizationAllowed(true,false),/allow_private_input/); assert.ok(sourceOverlap('x'.repeat(200),'x'.repeat(200))>0.5);
});

test('structured world state requires a clock and valid graph/channel references', () => {
  const noClock = structuredClone(SEEDED_HEARTBEAT_TEST_SCENARIO) as typeof SEEDED_HEARTBEAT_TEST_SCENARIO & { fixture: { clockAt?: string } };
  delete noClock.fixture.clockAt;
  assert.throws(() => parseScenario(noClock), /structured state requires a deterministic clockAt/);

  const badDependency = structuredClone(SEEDED_HEARTBEAT_TEST_SCENARIO);
  badDependency.fixture.mind[2].dependsOn = ['missing'];
  assert.throws(() => parseScenario(badDependency), /unknown Mind seed key missing/);

  const badChannel = structuredClone(SEEDED_HEARTBEAT_TEST_SCENARIO);
  badChannel.fixture.scheduler[0].channel = 'missing';
  assert.throws(() => parseScenario(badChannel), /unknown fixture channel missing/);
});

test('Sol and Opus have equal eligibility and behavioral selection ignores identity',()=>{
  assert.equal(teacherWeight('sol'),teacherWeight('opus-5')); assert.equal(assignedTeachers(HARD_TEST_SCENARIO).length,2);
  assert.equal(teachersAfterFirstAttempt(ORDINARY_TEST_SCENARIO,false).length,2);
  const base={passesSafety:true,passesTargeting:true,outcome:true,protocol:true,efficiency:1,socialScore:4,payload:null};
  const selected=selectTeacherCandidates([{...base,teacher:'sol',normalizedToolTrace:'a'},{...base,teacher:'opus-5',normalizedToolTrace:'b'}]); assert.equal(selected.length,2);
  assert.equal(behavioralPreference({...base,teacher:'sol',normalizedToolTrace:'a'},{...base,teacher:'opus-5',normalizedToolTrace:'b'}),0);
});
