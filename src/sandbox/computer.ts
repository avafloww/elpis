import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ComputerProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

export interface ComputerRunOptions { timeout?: number }
export type ComputerRunner = (command: string, opts?: ComputerRunOptions) => Promise<ComputerProcessResult>;

export interface ComputerToolsOptions {
  computerDir: string;
  display?: string;
  xauthority?: string;
  serviceName?: string;
  xorgServiceName?: string;
  run: ComputerRunner;
  watch?: (paths: string[], note: string) => { ok: boolean; count: number };
}

export interface DesktopWindow {
  id: string;
  desktop: number;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  class: string;
  host: string;
  title: string;
}

export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function displayShellCommand(command: string, display: string, xauthority: string): string {
  if (typeof command !== 'string' || !command.trim()) throw new Error('elpis.computer: display command must be a non-empty string');
  return `env DISPLAY=${shellQuote(display)} XAUTHORITY=${shellQuote(xauthority)} /bin/sh -c ${shellQuote(command)}`;
}

export function parseWindows(text: string): DesktopWindow[] {
  const windows: DesktopWindow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^(\S+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    windows.push({
      id: match[1], desktop: Number(match[2]), pid: Number(match[3]),
      x: Number(match[4]), y: Number(match[5]), width: Number(match[6]), height: Number(match[7]),
      class: match[8], host: match[9], title: match[10],
    });
  }
  return windows;
}

function finiteInt(value: unknown, label: string, min = Number.MIN_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`elpis.computer: ${label} must be a finite number`);
  const n = Math.round(value);
  if (n < min) throw new Error(`elpis.computer: ${label} must be >= ${min}`);
  return n;
}

const MAX_HOLD_MS = 30_000;
const MAX_SEQUENCE_STEPS = 64;
const MAX_SEQUENCE_MS = 60_000;

function inputKeys(value: unknown, label = 'keys', unique = true): string[] {
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) throw new Error(`elpis.computer.${label}: provide at least one key`);
  const keys = raw.map((key) => {
    if (typeof key !== 'string' || !key || key.length > 128 || !/^[A-Za-z0-9_+:=.-]+$/.test(key)) {
      throw new Error(`elpis.computer.${label}: every key must be a non-empty xdotool key name`);
    }
    return key;
  });
  return unique ? [...new Set(keys)] : keys;
}

function sleepSeconds(ms: number): string {
  return (ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function heldKeysScript(keysValue: string | string[], durationValue: number): string {
  const keys = inputKeys(keysValue, 'hold(keys)');
  const durationMs = finiteInt(durationValue, 'durationMs', 1);
  if (durationMs > MAX_HOLD_MS) throw new Error(`elpis.computer: durationMs must be <= ${MAX_HOLD_MS}`);
  const release = keys.slice().reverse().map((key) => `xdotool keyup ${shellQuote(key)} || true`).join('; ');
  const press = keys.map((key) => `xdotool keydown ${shellQuote(key)}`).join('; ');
  return `set -eu; cleanup() { ${release}; }; trap cleanup EXIT INT TERM; ${press}; sleep ${sleepSeconds(durationMs)}`;
}

export interface ComputerSequenceStep {
  keys: string | string[];
  durationMs: number;
  waitMs?: number;
}

function windowId(value: unknown): string {
  const id = String(value);
  if (!/^0x[0-9a-f]+$/i.test(id)) throw new Error('elpis.computer: window id must look like 0x0123abcd (use windows())');
  return id;
}

function appName(value: unknown): string {
  const name = String(value || 'app').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return name || 'app';
}

export function coordinateGridFilter(width: number, height: number, spacing = 100): string {
  const w = finiteInt(width, 'grid width', 1);
  const h = finiteInt(height, 'grid height', 1);
  const gap = finiteInt(spacing, 'grid spacing', 25);
  const color = '0xff00ff';
  const filters = [`drawgrid=width=${gap}:height=${gap}:thickness=1:color=${color}@0.58`];
  for (let x = 0; x < w; x += gap) {
    filters.push(`drawtext=text='${x}':x=${x + 3}:y=4:fontsize=13:fontcolor=${color}:box=1:boxcolor=black@0.62:boxborderw=2`);
  }
  for (let y = gap; y < h; y += gap) {
    filters.push(`drawtext=text='${y}':x=4:y=${y + 3}:fontsize=13:fontcolor=${color}:box=1:boxcolor=black@0.62:boxborderw=2`);
  }
  return filters.join(',');
}

export function createComputerTools(options: ComputerToolsOptions): Record<string, unknown> {
  const display = options.display ?? ':0';
  const xauthority = options.xauthority ?? path.join(options.computerDir, 'Xauthority');
  const serviceName = options.serviceName ?? 'elpis-desktop';
  const xorgServiceName = options.xorgServiceName ?? 'elpis-xorg';
  const screenshotsDir = path.join(options.computerDir, 'screenshots');
  fs.mkdirSync(options.computerDir, { recursive: true });

  const exec = async (label: string, command: string, opts: ComputerRunOptions & { allowNonzero?: boolean } = {}) => {
    const result = await options.run(command, { timeout: opts.timeout ?? 60_000 });
    if (!opts.allowNonzero && (result.code !== 0 || result.signal)) {
      const detail = (result.stderr || result.stdout || `exit ${result.code ?? result.signal}`).trim().slice(0, 4000);
      throw new Error(`elpis.computer.${label} failed: ${detail}`);
    }
    return result;
  };

  const screenshot = async (opts: ComputerRunOptions & { filename?: string } = {}) => {
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const file = opts.filename ? path.resolve(opts.filename) : path.join(screenshotsDir, `desktop-${Date.now()}.png`);
    await exec('screenshot', `scrot --overwrite ${shellQuote(file)}`, opts);
    if (!fs.existsSync(file)) throw new Error(`elpis.computer.screenshot failed: scrot did not create ${file}`);
    return { ok: true, file, display };
  };

  const hold = async (keysValue: string | string[], durationValue: number, opts: ComputerRunOptions = {}) => {
    const keys = inputKeys(keysValue, 'hold(keys)');
    const durationMs = finiteInt(durationValue, 'durationMs', 1);
    const script = heldKeysScript(keys, durationMs);
    if (opts.timeout !== undefined && opts.timeout < durationMs + 1000) {
      throw new Error('elpis.computer.hold: timeout must allow durationMs plus 1000ms cleanup margin');
    }
    await exec('hold', script, { ...opts, timeout: opts.timeout ?? Math.max(60_000, durationMs + 5000) });
    return { ok: true, keys, durationMs };
  };

  const release = async (keysValue: string | string[], opts: ComputerRunOptions = {}) => {
    const keys = inputKeys(keysValue, 'release(keys)');
    const command = keys.slice().reverse().map((key) => `xdotool keyup ${shellQuote(key)}`).join('; ');
    await exec('release', command, opts);
    return { ok: true, keys };
  };

  const look = async (note = `desktop ${display}`, opts: ComputerRunOptions & { filename?: string; grid?: boolean | number } = {}) => {
    if (!options.watch) throw new Error('elpis.computer.look(): multimodal watch delivery is not wired');
    const shot = await screenshot(opts);
    if (opts.grid === false) {
      const watched = options.watch([shot.file], note);
      return { ...shot, rawFile: shot.file, grid: false, watched, note };
    }
    const spacing = opts.grid === undefined || opts.grid === true ? 100 : finiteInt(opts.grid, 'grid spacing', 25);
    const dimensions = await exec('look.grid', `xdpyinfo | awk '/dimensions:/{print $2; exit}'`, opts);
    const match = dimensions.stdout.trim().match(/^(\d+)x(\d+)$/);
    if (!match) throw new Error(`elpis.computer.look failed: could not parse display dimensions from ${JSON.stringify(dimensions.stdout.trim())}`);
    const ext = path.extname(shot.file) || '.png';
    const gridFile = `${shot.file.slice(0, -ext.length)}-grid-${spacing}${ext}`;
    const filter = coordinateGridFilter(Number(match[1]), Number(match[2]), spacing);
    await exec('look.grid', `ffmpeg -y -loglevel error -i ${shellQuote(shot.file)} -vf ${shellQuote(filter)} ${shellQuote(gridFile)}`, opts);
    if (!fs.existsSync(gridFile)) throw new Error(`elpis.computer.look failed: ffmpeg did not create ${gridFile}`);
    const deliveredNote = `${note} [${spacing}px magenta coordinate grid; origin top-left]`;
    const watched = options.watch([gridFile], deliveredNote);
    return { ...shot, file: gridFile, rawFile: shot.file, grid: spacing, watched, note: deliveredNote };
  };

  return {
    start: async (opts: ComputerRunOptions = {}) => {
      await exec('start', `sudo -n systemctl start ${shellQuote(xorgServiceName)}`, opts);
      await exec('start', `systemctl --user start ${shellQuote(serviceName)}`, opts);
      return { ok: true, xorgService: xorgServiceName, desktopService: serviceName };
    },
    stop: async (opts: ComputerRunOptions = {}) => {
      await exec('stop', `systemctl --user stop ${shellQuote(serviceName)}`, opts);
      await exec('stop', `sudo -n systemctl stop ${shellQuote(xorgServiceName)}`, opts);
      return { ok: true, xorgService: xorgServiceName, desktopService: serviceName };
    },
    restart: async (opts: ComputerRunOptions = {}) => {
      await exec('restart', `systemctl --user stop ${shellQuote(serviceName)}`, opts);
      await exec('restart', `sudo -n systemctl restart ${shellQuote(xorgServiceName)}`, opts);
      await exec('restart', `systemctl --user restart ${shellQuote(serviceName)}`, opts);
      return { ok: true, xorgService: xorgServiceName, desktopService: serviceName };
    },
    status: async (opts: ComputerRunOptions = {}) => {
      const xorg = await exec('status', `sudo -n systemctl is-active ${shellQuote(xorgServiceName)}`, { ...opts, allowNonzero: true });
      const service = await exec('status', `systemctl --user is-active ${shellQuote(serviceName)}`, { ...opts, allowNonzero: true });
      const screen = await exec('status', `xdpyinfo | awk '/dimensions:/{print $2; exit}'`, { ...opts, allowNonzero: true });
      return {
        ok: xorg.stdout.trim() === 'active' && service.stdout.trim() === 'active' && screen.code === 0,
        xorg: xorg.stdout.trim() || 'unknown', desktop: service.stdout.trim() || 'unknown', display,
        dimensions: screen.stdout.trim() || null,
        error: screen.code === 0 ? null : (screen.stderr || screen.stdout).trim().slice(0, 1000),
      };
    },
    launch: async (command: string, opts: ComputerRunOptions & { name?: string; cwd?: string } = {}) => {
      if (typeof command !== 'string' || !command.trim()) throw new Error('elpis.computer.launch(command): command must be a non-empty string');
      const unit = `elpis-app-${appName(opts.name)}-${Date.now()}`;
      const cwd = path.resolve(opts.cwd ?? options.computerDir);
      const cmd = [
        'systemd-run --user --collect', `--unit=${shellQuote(unit)}`,
        `--working-directory=${shellQuote(cwd)}`,
        `--setenv=${shellQuote(`DISPLAY=${display}`)}`,
        `--setenv=${shellQuote(`XAUTHORITY=${xauthority}`)}`,
        '/bin/bash -lc', shellQuote(command),
      ].join(' ');
      const result = await exec('launch', cmd, opts);
      return { ok: true, unit, command, note: result.stdout.trim() };
    },
    windows: async (opts: ComputerRunOptions = {}) => {
 // wmctrl 1.07 can segfault on this real Xorg/Openbox session when tint2
 // is the sole EWMH client. Preflight the root list and treat a panel-only
 // desktop as having no controllable app windows.
      const root = await exec('windows', 'xprop -root _NET_CLIENT_LIST', opts);
      const ids = root.stdout.match(/0x[0-9a-f]+/gi) ?? [];
      if (ids.length === 0) return [];
      if (ids.length === 1) {
        const klass = await exec('windows', `xprop -id ${shellQuote(ids[0])} WM_CLASS`, { ...opts, allowNonzero: true });
        if (/tint2/i.test(klass.stdout)) return [];
      }
      const result = await exec('windows', 'wmctrl -lpGx', opts);
      return parseWindows(result.stdout).filter((window) => !/tint2/i.test(window.class));
    },
    focus: async (id: string, opts: ComputerRunOptions = {}) => {
      const target = windowId(id); await exec('focus', `wmctrl -ia ${shellQuote(target)}`, opts);
      return { ok: true, window: target };
    },
    closeWindow: async (id: string, opts: ComputerRunOptions = {}) => {
      const target = windowId(id); await exec('closeWindow', `wmctrl -ic ${shellQuote(target)}`, opts);
      return { ok: true, window: target };
    },
    move: async (x: number, y: number, opts: ComputerRunOptions = {}) => {
      const px = finiteInt(x, 'x', 0), py = finiteInt(y, 'y', 0);
      await exec('move', `xdotool mousemove --sync ${px} ${py}`, opts);
      return { ok: true, x: px, y: py };
    },
    click: async (x: number, y: number, opts: ComputerRunOptions & { button?: 'left' | 'middle' | 'right'; count?: number } = {}) => {
      const px = finiteInt(x, 'x', 0), py = finiteInt(y, 'y', 0);
      const buttonName = opts.button ?? 'left';
      const buttons: Record<string, number> = { left: 1, middle: 2, right: 3 };
      const button = buttons[buttonName];
      if (!button) throw new Error('elpis.computer.click: button must be left, middle, or right');
      const count = finiteInt(opts.count ?? 1, 'count', 1);
      await exec('click', `xdotool mousemove --sync ${px} ${py} click --repeat ${count} ${button}`, opts);
      return { ok: true, x: px, y: py, button: buttonName, count };
    },
    drag: async (fromX: number, fromY: number, toX: number, toY: number, opts: ComputerRunOptions = {}) => {
      const x1 = finiteInt(fromX, 'fromX', 0), y1 = finiteInt(fromY, 'fromY', 0);
      const x2 = finiteInt(toX, 'toX', 0), y2 = finiteInt(toY, 'toY', 0);
      await exec('drag', `xdotool mousemove --sync ${x1} ${y1} mousedown 1 mousemove --sync ${x2} ${y2} mouseup 1`, opts);
      return { ok: true, from: [x1, y1], to: [x2, y2] };
    },
    type: async (text: string, opts: ComputerRunOptions & { delay?: number } = {}) => {
      if (typeof text !== 'string') throw new Error('elpis.computer.type(text): text must be a string');
      const delay = finiteInt(opts.delay ?? 10, 'delay', 0);
      await exec('type', `xdotool type --clearmodifiers --delay ${delay} -- ${shellQuote(text)}`, opts);
      return { ok: true, length: text.length };
    },
    key: async (keysValue: string | string[], opts: ComputerRunOptions = {}) => {
      const keys = inputKeys(keysValue, 'key(keys)', false);
      await exec('key', `xdotool key --clearmodifiers ${keys.map(shellQuote).join(' ')}`, opts);
      return { ok: true, keys };
    },
    hold,
    chord: hold,
    release,
    sequence: async (stepsValue: ComputerSequenceStep[], opts: ComputerRunOptions = {}) => {
      if (!Array.isArray(stepsValue) || stepsValue.length === 0) throw new Error('elpis.computer.sequence(steps): provide at least one step');
      if (stepsValue.length > MAX_SEQUENCE_STEPS) throw new Error(`elpis.computer.sequence: at most ${MAX_SEQUENCE_STEPS} steps`);
      const steps = stepsValue.map((step, index) => {
        if (typeof step !== 'object' || step === null) throw new Error(`elpis.computer.sequence: step ${index} must be an object`);
        const keys = inputKeys(step.keys, `sequence step ${index} keys`);
        const durationMs = finiteInt(step.durationMs, `sequence step ${index} durationMs`, 1);
        if (durationMs > MAX_HOLD_MS) throw new Error(`elpis.computer.sequence: step ${index} durationMs must be <= ${MAX_HOLD_MS}`);
        const waitMs = finiteInt(step.waitMs ?? 0, `sequence step ${index} waitMs`, 0);
        return { keys, durationMs, waitMs };
      });
      const totalMs = steps.reduce((sum, step) => sum + step.durationMs + step.waitMs, 0);
      if (totalMs > MAX_SEQUENCE_MS) throw new Error(`elpis.computer.sequence: total duration must be <= ${MAX_SEQUENCE_MS}`);
      for (const step of steps) {
        await hold(step.keys, step.durationMs, opts);
        if (step.waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, step.waitMs));
      }
      return { ok: true, steps, totalMs };
    },
    step: async (keysValue: string | string[], durationValue: number, note = 'computer game step', opts: ComputerRunOptions & { filename?: string; grid?: boolean | number; settleMs?: number } = {}) => {
      const action = await hold(keysValue, durationValue, opts);
      const settleMs = finiteInt(opts.settleMs ?? 100, 'settleMs', 0);
      if (settleMs > 5000) throw new Error('elpis.computer.step: settleMs must be <= 5000');
      if (settleMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
      const observation = await look(note, opts);
      return { ok: true, action, observation };
    },
    scroll: async (clicks: number, opts: ComputerRunOptions = {}) => {
      const amount = finiteInt(clicks, 'clicks');
      if (amount === 0) return { ok: true, clicks: 0 };
      const button = amount > 0 ? 5 : 4;
      await exec('scroll', `xdotool click --repeat ${Math.abs(amount)} ${button}`, opts);
      return { ok: true, clicks: amount };
    },
    clipboard: {
      get: async (opts: ComputerRunOptions = {}) => {
        const result = await exec('clipboard.get', 'xclip -selection clipboard -out', opts);
        return result.stdout;
      },
      set: async (text: string, opts: ComputerRunOptions = {}) => {
        if (typeof text !== 'string') throw new Error('elpis.computer.clipboard.set(text): text must be a string');
        const file = path.join(options.computerDir, `.clipboard-${randomUUID()}`);
        fs.writeFileSync(file, text, { mode: 0o600 });
        try { await exec('clipboard.set', `xclip -selection clipboard -in < ${shellQuote(file)}`, opts); }
        finally { fs.rmSync(file, { force: true }); }
        return { ok: true, length: text.length };
      },
    },
    screenshot,
    look,
    raw: async (command: string, opts: ComputerRunOptions = {}) => {
      if (typeof command !== 'string' || !command.trim()) throw new Error('elpis.computer.raw(command): command must be a non-empty string');
      const result = await exec('raw', command, opts);
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    },
  };
}
