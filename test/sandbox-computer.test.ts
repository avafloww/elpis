import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { coordinateGridFilter, createComputerTools, displayShellCommand, heldKeysScript, parseWindows, shellQuote, type ComputerProcessResult } from '../src/sandbox/computer.js';

test('parseWindows reads wmctrl geometry, class, and spaced titles', () => {
  const rows = parseWindows('0x04600007  0 1234 10 20 800 600 Navigator.Firefox host Example Domain - Mozilla Firefox\n');
  assert.deepEqual(rows, [{
    id: '0x04600007', desktop: 0, pid: 1234, x: 10, y: 20,
    width: 800, height: 600, class: 'Navigator.Firefox', host: 'host',
    title: 'Example Domain - Mozilla Firefox',
  }]);
});

test('shellQuote preserves apostrophes as one shell argument', () => {
  assert.equal(shellQuote("don't"), "'don'\\''t'");
});

test('display shell wrapper keeps credentials across a compound command', () => {
  assert.equal(
    displayShellCommand('xdotool keydown Up; sleep 1; xdotool keyup Up', ':77', '/tmp/x auth'),
    "env DISPLAY=':77' XAUTHORITY='/tmp/x auth' /bin/sh -c 'xdotool keydown Up; sleep 1; xdotool keyup Up'",
  );
});

test('held key script traps cleanup and releases chords in reverse order', () => {
  assert.equal(
    heldKeysScript(['Up', 'f'], 750),
    "set -eu; cleanup() { xdotool keyup 'f' || true; xdotool keyup 'Up' || true; }; trap cleanup EXIT INT TERM; xdotool keydown 'Up'; xdotool keydown 'f'; sleep 0.75",
  );
  assert.throws(() => heldKeysScript(['Up', 'bad key'], 100), /xdotool key name/);
  assert.throws(() => heldKeysScript('Up', 30_001), /durationMs must be <= 30000/);
});

test('coordinate grid filter uses magenta and labels the top and left edges', () => {
  const filter = coordinateGridFilter(320, 240, 100);
  assert.match(filter, /drawgrid=width=100:height=100/);
  assert.match(filter, /color=0xff00ff@0\.58/);
  assert.match(filter, /text='300':x=303:y=4/);
  assert.match(filter, /text='200':x=4:y=203/);
  assert.throws(() => coordinateGridFilter(320, 240, 20), /grid spacing must be >= 25/);
});

test('computer maps input and app launch onto deterministic X11 commands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-computer-test-'));
  const calls: string[] = [];
  const run = async (command: string): Promise<ComputerProcessResult> => {
    calls.push(command);
    const stdout = command.startsWith('xprop -root') ? '_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2\n' : command.startsWith('wmctrl') ? '0x1 0 1 0 0 100 100 app.Class host Title\n' : 'ok\n';
    return { stdout, stderr: '', code: 0, signal: null };
  };
  const computer: any = createComputerTools({ computerDir: dir, display: ':77', xauthority: dir + '/auth', run });

  await computer.click(12.4, 33.6, { button: 'right', count: 2 });
  assert.equal(calls[0], 'xdotool mousemove --sync 12 34 click --repeat 2 3');

  const launched = await computer.launch('firefox-esr https://example.com', { name: 'web', cwd: '/tmp' });
  assert.match(calls[1], /^systemd-run --user --collect /);
  assert.match(calls[1], /DISPLAY=:77/);
  assert.match(calls[1], /XAUTHORITY=.*auth/);
  assert.match(launched.unit, /^elpis-app-web-\d+$/);

  const windows = await computer.windows();
  assert.equal(windows[0].title, 'Title');
  await assert.rejects(computer.click(1, 2, { button: 'side' }), /button must be/);
  await computer.key(['Return', 'Return']);
  assert.equal(calls.at(-1), "xdotool key --clearmodifiers 'Return' 'Return'");
  await assert.rejects(computer.key([]), /at least one key/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computer exposes safe holds, release, bounded sequences, and chord alias', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-computer-test-'));
  const calls: string[] = [];
  const computer: any = createComputerTools({
    computerDir: dir,
    run: async (command) => { calls.push(command); return { stdout: '', stderr: '', code: 0, signal: null }; },
  });
  assert.deepEqual(await computer.hold(['Up', 'f'], 25), { ok: true, keys: ['Up', 'f'], durationMs: 25 });
  assert.match(calls[0], /trap cleanup EXIT INT TERM/);
  assert.match(calls[0], /keydown 'Up'.*keydown 'f'.*sleep 0\.025/);
  await computer.chord(['Left', 'f'], 10);
  await computer.release(['Left', 'f']);
  assert.equal(calls[2], "xdotool keyup 'f'; xdotool keyup 'Left'");
  const sequence = await computer.sequence([
    { keys: 'Up', durationMs: 10 },
    { keys: ['Right', 'f'], durationMs: 10 },
  ]);
  assert.equal(sequence.steps.length, 2);
  assert.equal(sequence.totalMs, 20);
  await assert.rejects(computer.hold('Up', 100, { timeout: 500 }), /cleanup margin/);
  await assert.rejects(computer.sequence([{ keys: 'Up', durationMs: 30_000, waitMs: 30_001 }]), /total duration/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computer treats a tint2-only desktop as an empty app window list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-computer-test-'));
  const calls: string[] = [];
  const computer: any = createComputerTools({
    computerDir: dir,
    run: async (command) => {
      calls.push(command);
      if (command.startsWith('xprop -root')) return { stdout: '_NET_CLIENT_LIST(WINDOW): window id # 0x200008\\n', stderr: '', code: 0, signal: null };
      if (command.includes('WM_CLASS')) return { stdout: 'WM_CLASS(STRING) = "tint2", "Tint2"\\n', stderr: '', code: 0, signal: null };
      throw new Error(`unexpected command: ${command}`);
    },
  });
  assert.deepEqual(await computer.windows(), []);
  assert.equal(calls.some((command) => command.startsWith('wmctrl')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computer lifecycle coordinates root Xorg before the user desktop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-computer-test-'));
  const calls: string[] = [];
  const computer: any = createComputerTools({
    computerDir: dir,
    run: async (command) => { calls.push(command); return { stdout: '', stderr: '', code: 0, signal: null }; },
  });
  await computer.start();
  assert.deepEqual(calls, ["sudo -n systemctl start 'elpis-xorg'", "systemctl --user start 'elpis-desktop'"]);
  calls.length = 0;
  await computer.stop();
  assert.deepEqual(calls, ["systemctl --user stop 'elpis-desktop'", "sudo -n systemctl stop 'elpis-xorg'"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computer look captures a screenshot and queues multimodal delivery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-computer-test-'));
  const watched: { paths: string[]; note: string }[] = [];
  const computer: any = createComputerTools({
    computerDir: dir,
    run: async (command) => {
      const file = command.match(/^scrot --overwrite '([^']+)'$/)?.[1];
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); }
      if (command.startsWith('xdpyinfo')) return { stdout: '1280x800\n', stderr: '', code: 0, signal: null };
      if (command.startsWith('ffmpeg ')) {
        const output = command.match(/'([^']+)'$/)?.[1];
        if (output) fs.writeFileSync(output, 'grid png');
      }
      return { stdout: '', stderr: '', code: 0, signal: null };
    },
    watch: (paths, note) => { watched.push({ paths, note }); return { ok: true, count: paths.length }; },
  });
  const result = await computer.look('desktop check');
  assert.equal(result.ok, true);
  assert.equal(result.grid, 100);
  assert.equal(result.watched.count, 1);
  assert.equal(result.note, 'desktop check [100px magenta coordinate grid; origin top-left]');
  assert.match(watched[0].paths[0], /-grid-100\.png$/);
  assert.equal(fs.existsSync(result.rawFile), true);
  assert.equal(fs.existsSync(result.file), true);

  const raw = await computer.look('raw check', { grid: false });
  assert.equal(raw.grid, false);
  assert.equal(raw.file, raw.rawFile);
  assert.equal(watched[1].note, 'raw check');

  const stepped = await computer.step(['Up', 'f'], 10, 'game step', { grid: false, settleMs: 0 });
  assert.deepEqual(stepped.action, { ok: true, keys: ['Up', 'f'], durationMs: 10 });
  assert.equal(stepped.observation.grid, false);
  assert.equal(watched[2].note, 'game step');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computer commands fail loudly with bounded process errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-computer-test-'));
  const computer: any = createComputerTools({
    computerDir: dir,
    run: async () => ({ stdout: '', stderr: 'no display', code: 1, signal: null }),
  });
  await assert.rejects(computer.windows(), /no display/);
  fs.rmSync(dir, { recursive: true, force: true });
});
