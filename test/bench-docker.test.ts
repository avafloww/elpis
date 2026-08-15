import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advanceClockFile, dockerRunArgs, prepareEpisodeMounts } from '../bench/docker.js';

test('Docker episodes deny network/capabilities and mount only explicit episode paths', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-docker-')), work=path.join(root,'work'), results=path.join(root,'results'), clock=path.join(root,'clock');
  prepareEpisodeMounts(work,results,clock,new Date('2026-01-01T00:00:00Z'));
  const args=dockerRunArgs({image:'elpisbench:test',name:'ep-test',workDir:work,resultDir:results,clockFile:clock});
  const joined=args.join(' ');
  assert.match(joined,/--read-only/); assert.match(joined,/--network none/); assert.match(joined,/--cap-drop ALL/);
  assert.match(joined,/no-new-privileges:true/); assert.match(joined,/--pids-limit/); assert.match(joined,/--tmpfs/);
  assert.match(joined,/FAKETIME_DONT_FAKE_MONOTONIC=1/);
  assert.doesNotMatch(joined,/docker\.sock/); assert.match(joined,/dst=\/home\/agent\/data(?:\s|$)/); assert.match(joined,/dst=\/run\/elpis-clock,readonly/);
  assert.doesNotMatch(joined,/\/episode\//);
  fs.rmSync(root,{recursive:true,force:true});
});

test('clock advancement is deterministic and bounded', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bench-clock-')), clock=path.join(root,'clock');
  prepareEpisodeMounts(path.join(root,'w'),path.join(root,'r'),clock,new Date('2026-01-01T00:00:00Z'));
  advanceClockFile(clock,90_000); assert.equal(fs.readFileSync(clock,'utf8'),'@2026-01-01 00:01:30\n');
  assert.throws(()=>advanceClockFile(clock,15*86400000),/14 days/); fs.rmSync(root,{recursive:true,force:true});
});
