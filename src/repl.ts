// repl.ts — dev-only CLI to test the sandbox without Discord/LLM.
// Pipes stdin → sandbox.run → prints RunResult.
//
// Usage: npm run repl

import * as readline from 'node:readline';
import { createSandbox } from './sandbox/index.js';
import { createMemory } from './store/memory.js';
import { loadConfigFile } from './config.js';

const config = loadConfigFile();
const memory = createMemory(config.paths.memoryPath);
const sandbox = createSandbox({
  config,
  memory,
  logbuf: [],
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
});

console.log('agent sandbox repl. type JS, blank line to evaluate multi-line. Ctrl-D to exit.');
rl.prompt();

let buf = '';
rl.on('line', (line) => {
  if (line.trim() === '') {
 // evaluate buffer
    if (buf.trim()) {
      void runAndPrint(buf);
    }
    buf = '';
    rl.prompt();
  } else {
    buf += line + '\n';
  }
});
rl.on('close', () => {
  if (buf.trim()) void runAndPrint(buf);
  process.exit(0);
});

async function runAndPrint(code: string) {
  const res = await sandbox.run(code);
  console.log(JSON.stringify(res, null, 2));
  rl.prompt();
}
