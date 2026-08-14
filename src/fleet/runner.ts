// runner.ts — the detached fleet-session entry point. Kept deliberately tiny:
// it reads <sessionDir>/runner-config.json, wires the REAL SDK `query` into
// runner-core (the only injected seam), and maps the run outcome to a process
// exit code. All behavior lives in runner-core.ts.
//
// node dist/fleet/runner.js <sessionDir>
//
// Spawned detached by the harness-side registry; it talks to the
// harness only over <sessionDir>/ctl.sock and its events.jsonl.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runRunner, type QueryFn } from './runner-core.js';
import type { RunnerConfig } from './protocol.js';

const sessionDir = process.argv[2];
if (!sessionDir) {
  console.error('[fleet-runner] usage: runner.js <sessionDir>');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(path.join(sessionDir, 'runner-config.json'), 'utf8')) as RunnerConfig;

// The SDK's query returns a Query (AsyncGenerator + .interrupt/.close);
// runner-core only needs the AsyncSDKQueryLike surface, so the cast is safe.
const queryFn: QueryFn = (params) => query(params as never) as never;

runRunner({ sessionDir, config, queryFn }).then(
  () => process.exit(0),
  (e) => {
    console.error('[fleet-runner] fatal:', e);
    process.exit(1);
  },
);
