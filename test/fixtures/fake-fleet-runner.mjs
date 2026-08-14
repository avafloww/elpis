// fake-fleet-runner.mjs — a protocol-speaking stand-in for dist/fleet/runner.js,
// used by test/fleet-registry.test.ts to drive src/fleet/index.ts over a real
// unix control socket + real events.jsonl WITHOUT the SDK or the network.
//
//   node test/fixtures/fake-fleet-runner.mjs <sessionDir>
//
// It reads runner-config.json, opens ctl.sock, greets every connection with a
// `hello`, honors `subscribe` (replays events.jsonl frames with seq > sinceSeq),
// echoes each `send` back as a `turn-end` (appended to events.jsonl with a real
// seq so it is durable + replayable), and shuts down on `shutdown`.
//
// Scripting seams (env vars, read once at boot):
//   FAKE_SCRIPT   JSON array of partial frames emitted on boot (seq is assigned
//                 here) — e.g. '[{"ev":"mailbox","text":"hi"}]'.
//   FAKE_AUTORUN  if set and config.prompt is non-null, emit a turn-end for the
//                 initial prompt on boot (models a runner that runs immediately).
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const sessionDir = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(sessionDir, 'runner-config.json'), 'utf8'));
const eventsFile = path.join(sessionDir, 'events.jsonl');
const sockPath = path.join(sessionDir, 'ctl.sock');

function parseFrames(buf) {
  const lines = buf.split('\n');
  const rest = lines.pop() ?? '';
  const frames = [];
  for (const l of lines) { if (!l) continue; try { frames.push(JSON.parse(l)); } catch { /* skip torn line */ } }
  return { frames, rest };
}

function initialSeq() {
  try {
    const { frames } = parseFrames(fs.readFileSync(eventsFile, 'utf8'));
    let max = 0;
    for (const f of frames) if (typeof f.seq === 'number' && f.seq > max) max = f.seq;
    return max + 1;
  } catch { return 1; }
}

let seq = initialSeq();
let state = 'starting';
const sdkSessionId = config.resume ?? 'sdk-fake-1';
const clients = new Set();

function emit(frame) {
  const line = JSON.stringify(frame) + '\n';
  try { fs.appendFileSync(eventsFile, line); } catch { /* durability best-effort */ }
  for (const c of clients) { try { c.write(line); } catch { /* dropped on its own error */ } }
}
function setState(s) { state = s; emit({ ev: 'state', seq: seq++, state: s }); }
function turnEnd(text) {
  emit({
    ev: 'turn-end', seq: seq++, result: `echo: ${text}`, isError: false,
    usage: { input: 10, output: 20 }, costUsd: 0.0123, turns: 1, sdkSessionId,
  });
  setState('idle');
}

try { fs.rmSync(sockPath, { force: true }); } catch { /* nothing to remove */ }

const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  try { sock.write(JSON.stringify({ ev: 'hello', id: config.id, pid: process.pid, seq, state }) + '\n'); } catch { /* client hung up */ }
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    const { frames, rest } = parseFrames(buf);
    buf = rest;
    for (const op of frames) {
      if (op.op === 'subscribe') {
        let content = '';
        try { content = fs.readFileSync(eventsFile, 'utf8'); } catch { /* nothing yet */ }
        for (const fr of parseFrames(content).frames) {
          if (typeof fr.seq === 'number' && fr.seq > (op.sinceSeq ?? 0)) {
            try { sock.write(JSON.stringify(fr) + '\n'); } catch { /* dropped */ }
          }
        }
        clients.add(sock);
      } else if (op.op === 'send') {
        if (op.text === '__BLIP__') {
          // Simulate a control-socket blip: drop every client connection while
          // keeping the process (and the listening server) alive, so the
          // registry must RECONNECT on the next send rather than revive-spawn.
          for (const c of clients) { try { c.destroy(); } catch { /* ignore */ } }
          clients.clear();
          continue;
        }
        if (state === 'idle' || state === 'starting') state = 'running';
        turnEnd(op.text);
      } else if (op.op === 'interrupt') {
        /* no-op */
      } else if (op.op === 'shutdown') {
        setState('exited');
        for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 200).unref();
      }
    }
  });
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => clients.delete(sock));
});

server.listen(sockPath, () => {
  setState('starting');
  if (process.env.FAKE_SCRIPT) {
    try {
      for (const f of JSON.parse(process.env.FAKE_SCRIPT)) emit({ ...f, seq: seq++ });
    } catch { /* bad script — ignore */ }
  }
  if (process.env.FAKE_AUTORUN && config.prompt) turnEnd(config.prompt);
});
