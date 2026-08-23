import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createBrowserTools,
  parseBrowserJson,
  type BrowserProcessResult,
} from '../src/sandbox/browser.js';

test('parseBrowserJson returns structured JSON and preserves non-JSON output', () => {
  assert.deepEqual(parseBrowserJson('{"snapshot":"tree"}\n'), {
    snapshot: 'tree',
  });
  assert.deepEqual(parseBrowserJson('plain output'), { raw: 'plain output' });
  assert.deepEqual(parseBrowserJson(''), {});
});

test('browser namespace maps default and named sessions to argument arrays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-browser-test-'));
  const calls: { args: string[]; timeout?: number }[] = [];
  const run = async (
    args: string[],
    opts?: { timeout?: number },
  ): Promise<BrowserProcessResult> => {
    calls.push({ args, timeout: opts?.timeout });
    return { stdout: '{"snapshot":"ok"}', stderr: '', code: 0, signal: null };
  };
  const config = path.join(dir, 'maximized.json');
  const browser: any = createBrowserTools({
    browserDir: dir,
    maximizedChromiumConfig: config,
    run,
  });

  const opened = await browser.open('https://example.com', {
    persistent: true,
    timeout: 1234,
  });
  assert.equal(opened.ok, true);
  assert.deepEqual(calls[0], {
    args: [
      '-s=elpis',
      'open',
      'https://example.com',
      '--headed',
      `--config=${config}`,
      '--persistent',
      '--json',
    ],
    timeout: 1234,
  });

  await browser
    .session('headless')
    .open('https://example.com', { headless: true });
  assert.deepEqual(calls[1].args, [
    '-s=headless',
    'open',
    'https://example.com',
    `--config=${config}`,
    '--json',
  ]);

  await browser.session('work_2').fill('e5', 'hello world', { submit: true });
  assert.deepEqual(calls[2].args, [
    '-s=work_2',
    'fill',
    'e5',
    'hello world',
    '--submit',
    '--json',
  ]);

  await browser.list();
  assert.deepEqual(calls[3].args, ['list', '--json']);
  assert.throws(() => browser.session('bad name'), /letters, digits/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('browser commands fail loudly on a nonzero CLI result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-browser-test-'));
  const browser: any = createBrowserTools({
    browserDir: dir,
    run: async () => ({
      stdout: '',
      stderr: 'session not found',
      code: 1,
      signal: null,
    }),
  });
  await assert.rejects(browser.snapshot(), /session not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('browser look captures a deterministic file and queues multimodal delivery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-browser-test-'));
  const watched: { paths: string[]; note: string }[] = [];
  const browser: any = createBrowserTools({
    browserDir: dir,
    run: async (args) => {
      const filename = args
        .find((arg) => arg.startsWith('--filename='))
        ?.slice('--filename='.length);
      if (filename) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, 'png');
      }
      return { stdout: '{}', stderr: '', code: 0, signal: null };
    },
    watch: (paths, note) => {
      watched.push({ paths, note });
      return { ok: true, count: paths.length };
    },
  });

  const result = await browser.session('visual').look('check the deployed UI');
  assert.equal(result.ok, true);
  assert.equal(result.watched.count, 1);
  assert.equal(watched[0].note, 'check the deployed UI');
  assert.match(watched[0].paths[0], /screenshots\/visual-\d+\.png$/);
  assert.equal(fs.existsSync(watched[0].paths[0]), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
