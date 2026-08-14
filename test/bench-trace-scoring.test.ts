import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, type RunRecord } from '../bench/schema.js';
import { TraceRecorder, traceMetrics, successfulTerminalEnd } from '../bench/trace.js';
import { aggregateJudgePanel, buildSuiteSummary, compareSummaries, mechanicalCategoryScore } from '../bench/scoring.js';

test('trace metrics distinguish malformed/failed/blocked/missing-end/duplicates/post-outcome', () => {
  const t=new TraceRecorder(); t.add({kind:'natural-turn'}); t.add({kind:'dispatch'});
  t.add({kind:'tool-call',callId:'1',code:'x()',end:false,data:{malformed:true}}); t.add({kind:'tool-result',callId:'1',ok:false,data:{blocked:true,unchanged:true}});
  t.add({kind:'tool-call',callId:'2',code:'x()',end:true}); t.add({kind:'tool-result',callId:'2',ok:true,end:true}); t.add({kind:'outcome',ok:true}); t.add({kind:'dispatch'}); t.add({kind:'tool-call',callId:'3',code:'y()',end:true}); t.add({kind:'tool-result',callId:'3',ok:true,end:true}); t.add({kind:'send'});
  const m=traceMetrics(t.snapshot());
  assert.equal(m.malformedCalls,1); assert.equal(m.failedCalls,1); assert.equal(m.blockedCalls,1); assert.equal(m.unchangedRetries,1);
  assert.equal(m.missingTerminalFlags,1); assert.equal(m.duplicateWork,1); assert.equal(m.postOutcomeDispatches,1); assert.equal(successfulTerminalEnd(t.snapshot()),true);
  const missing=new TraceRecorder(); missing.add({kind:'tool-call',code:'x()',end:false}); missing.add({kind:'tool-result',ok:true,end:false}); assert.equal(traceMetrics(missing.snapshot()).missingTerminalFlags,1);
});

function record(gates=true): RunRecord { return {schemaVersion:SCHEMA_VERSION,runId:'r',scenarioId:'tool/x',scenarioDigest:'d',startedAt:'x',finishedAt:'y',harnessCommit:'h',containerImage:'i',providerType:'openai-compatible',model:'m',events:[],metrics:{naturalTurns:1,dispatchCount:1,usefulActionLatency:1,malformedCalls:0,failedCalls:0,blockedCalls:0,unchangedRetries:0,missingTerminalFlags:0,failedTerminalFlags:0,emptyTerminalCalls:0,postOutcomeDispatches:0,duplicateWork:0,sendsPerRun:1,surplusModelTurns:0},gates:{outcome:gates,targeting:true,containment:true,terminalEnd:true,bounded:true,quiescent:true},artifacts:{},timedOut:false}; }
test('hard gates zero scores and judge median/range detect instability',()=>{
  assert.equal(mechanicalCategoryScore(record(false),'tool'),0);
  const panel=aggregateJudgePanel([
    {runId:'r',profile:'a',family:'x',criterion:'natural',score:0,evidence:[],rationale:''},{runId:'r',profile:'b',family:'y',criterion:'natural',score:2,evidence:[],rationale:''},{runId:'r',profile:'c',family:'z',criterion:'natural',score:4,evidence:[],rationale:''},
  ]); assert.equal(panel.scores.natural,2); assert.deepEqual(panel.unstable,['natural']);
});
test('comparisons are inconclusive inside 0.03 or above 10% instability',()=>{
  const a=buildSuiteSummary('a',[{record:record(),category:'tool'}]); const b={...a,suiteId:'b',weightedScore:a.weightedScore+0.02};
  assert.equal(compareSummaries(a,b).verdict,'inconclusive'); assert.equal(compareSummaries(a,{...b,inconclusive:true}).verdict,'inconclusive');
});

test('universal trajectory hygiene lowers every category and remains a judge ceiling', () => {
  const messy = record();
  messy.metrics = { ...messy.metrics, postOutcomeDispatches: 1, sendsPerRun: 2, surplusModelTurns: 6 };
  for (const category of ['tool', 'proactivity', 'protocol', 'social'] as const) assert.ok(mechanicalCategoryScore(messy, category) < 1, category);
  const judges = [
    { runId: 'r', profile: 'a', family: 'x', criterion: 'natural', score: 4, evidence: [], rationale: '' },
    { runId: 'r', profile: 'b', family: 'y', criterion: 'natural', score: 4, evidence: [], rationale: '' },
    { runId: 'r', profile: 'c', family: 'z', criterion: 'natural', score: 4, evidence: [], rationale: '' },
  ];
  const summary = buildSuiteSummary('judged', [{ record: messy, category: 'tool', judges }]);
  assert.equal(summary.categoryScores.tool, mechanicalCategoryScore(messy, 'tool'));
});
