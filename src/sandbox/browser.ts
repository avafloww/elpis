import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BrowserProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

export interface BrowserRunOptions { timeout?: number }
export type BrowserRunner = (args: string[], opts?: BrowserRunOptions) => Promise<BrowserProcessResult>;

export interface BrowserToolsOptions {
  browserDir: string;
  run: BrowserRunner;
  watch?: (paths: string[], note: string) => { ok: boolean; count: number };
  maximizedChromiumConfig?: string;
}

function sessionName(value: unknown): string {
  const name = String(value || 'elpis');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error('elpis.browser.session(name): use 1-64 letters, digits, underscores, or hyphens');
  }
  return name;
}

function stringArg(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`elpis.browser: ${label} must be a non-empty string`);
  return value;
}

export function parseBrowserJson(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export function createBrowserTools(options: BrowserToolsOptions): Record<string, unknown> {
  fs.mkdirSync(options.browserDir, { recursive: true });
  const screenshotsDir = path.join(options.browserDir, 'screenshots');

  const run = async (session: string | null, command: string, args: string[] = [], timeout = 60_000): Promise<Record<string, unknown>> => {
    stringArg(command, 'command');
    if (args.some((arg) => typeof arg !== 'string')) throw new Error('elpis.browser: command args must all be strings');
    const argv = [...(session ? [`-s=${sessionName(session)}`] : []), command, ...args, '--json'];
    const result = await options.run(argv, { timeout });
    if (result.code !== 0 || result.signal) {
      const detail = (result.stderr || result.stdout || `exit ${result.code ?? result.signal}`).trim().slice(0, 4000);
      throw new Error(`elpis.browser.${command} failed: ${detail}`);
    }
    const parsed = parseBrowserJson(result.stdout);
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { result: parsed };
    return { ok: true, command, ...(session ? { session } : {}), ...body };
  };

  const makeSession = (rawName: string) => {
    const session = sessionName(rawName);
    const command = (name: string, args: string[] = [], timeout?: number) => run(session, name, args, timeout);
    const screenshot = async (target?: string, opts: BrowserRunOptions & { filename?: string; hires?: boolean } = {}) => {
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const filename = path.resolve(opts.filename ?? path.join(screenshotsDir, `${session}-${Date.now()}.png`));
      const args = [...(target ? [target] : []), `--filename=${filename}`, ...(opts.hires ? ['--hires'] : [])];
      const result = await command('screenshot', args, opts.timeout);
      return { ...result, file: filename };
    };
    return {
      open: (url?: string, opts: { browser?: 'chrome' | 'firefox' | 'webkit' | 'msedge'; headless?: boolean; persistent?: boolean; profile?: string; timeout?: number } = {}) => {
        const args = url ? [stringArg(url, 'url')] : [];
        if (opts.browser) args.push(`--browser=${opts.browser}`);
        if (!opts.headless) args.push('--headed');
        if (options.maximizedChromiumConfig && (!opts.browser || (!opts.headless && (opts.browser === 'chrome' || opts.browser === 'msedge')))) {
          args.push(`--config=${options.maximizedChromiumConfig}`);
        }
        if (opts.persistent) args.push('--persistent');
        if (opts.profile) args.push(`--profile=${opts.profile}`);
        return command('open', args, opts.timeout ?? 60_000);
      },
      goto: (url: string, opts: BrowserRunOptions = {}) => command('goto', [stringArg(url, 'url')], opts.timeout),
      snapshot: (target?: string, opts: BrowserRunOptions = {}) => command('snapshot', target ? [target] : [], opts.timeout),
      click: (target: string, button?: 'left' | 'right' | 'middle', opts: BrowserRunOptions = {}) => command('click', [stringArg(target, 'target'), ...(button ? [button] : [])], opts.timeout),
      dblclick: (target: string, button?: 'left' | 'right' | 'middle', opts: BrowserRunOptions = {}) => command('dblclick', [stringArg(target, 'target'), ...(button ? [button] : [])], opts.timeout),
      fill: (target: string, text: string, opts: BrowserRunOptions & { submit?: boolean } = {}) => command('fill', [stringArg(target, 'target'), text, ...(opts.submit ? ['--submit'] : [])], opts.timeout),
      type: (text: string, opts: BrowserRunOptions = {}) => command('type', [text], opts.timeout),
      press: (key: string, opts: BrowserRunOptions = {}) => command('press', [stringArg(key, 'key')], opts.timeout),
      hover: (target: string, opts: BrowserRunOptions = {}) => command('hover', [stringArg(target, 'target')], opts.timeout),
      select: (target: string, value: string, opts: BrowserRunOptions = {}) => command('select', [stringArg(target, 'target'), value], opts.timeout),
      check: (target: string, opts: BrowserRunOptions = {}) => command('check', [stringArg(target, 'target')], opts.timeout),
      uncheck: (target: string, opts: BrowserRunOptions = {}) => command('uncheck', [stringArg(target, 'target')], opts.timeout),
      eval: (expression: string, target?: string, opts: BrowserRunOptions = {}) => command('eval', [stringArg(expression, 'expression'), ...(target ? [target] : [])], opts.timeout),
      runCode: (code: string, opts: BrowserRunOptions = {}) => command('run-code', [stringArg(code, 'code')], opts.timeout),
      reload: (opts: BrowserRunOptions = {}) => command('reload', [], opts.timeout),
      back: (opts: BrowserRunOptions = {}) => command('go-back', [], opts.timeout),
      forward: (opts: BrowserRunOptions = {}) => command('go-forward', [], opts.timeout),
      requests: (opts: BrowserRunOptions = {}) => command('requests', [], opts.timeout),
      request: (index: number, opts: BrowserRunOptions = {}) => command('request', [String(index)], opts.timeout),
      console: (level?: 'error' | 'warning' | 'info' | 'debug', opts: BrowserRunOptions = {}) => command('console', level ? [level] : [], opts.timeout),
      tabs: (opts: BrowserRunOptions = {}) => command('tab-list', [], opts.timeout),
      newTab: (url?: string, opts: BrowserRunOptions = {}) => command('tab-new', url ? [url] : [], opts.timeout),
      selectTab: (index: number, opts: BrowserRunOptions = {}) => command('tab-select', [String(index)], opts.timeout),
      closeTab: (index?: number, opts: BrowserRunOptions = {}) => command('tab-close', index === undefined ? [] : [String(index)], opts.timeout),
      stateSave: (file?: string, opts: BrowserRunOptions = {}) => command('state-save', file ? [file] : [], opts.timeout),
      stateLoad: (file: string, opts: BrowserRunOptions = {}) => command('state-load', [stringArg(file, 'file')], opts.timeout),
      screenshot,
      look: async (note = `browser session ${session}`, opts: BrowserRunOptions & { target?: string; filename?: string; hires?: boolean } = {}) => {
        if (!options.watch) throw new Error('elpis.browser.look(): multimodal watch delivery is not wired');
        const shot = await screenshot(opts.target, opts);
        const watched = options.watch([shot.file], note);
        return { ...shot, watched, note };
      },
      close: (opts: BrowserRunOptions = {}) => command('close', [], opts.timeout),
      raw: (name: string, args: string[] = [], opts: BrowserRunOptions = {}) => command(stringArg(name, 'command'), args, opts.timeout),
    };
  };

  const primary = makeSession('elpis');
  return Object.assign(primary, {
    session: (name: string) => makeSession(name),
    list: (opts: BrowserRunOptions = {}) => run(null, 'list', [], opts.timeout),
    closeAll: (opts: BrowserRunOptions = {}) => run(null, 'close-all', [], opts.timeout),
    killAll: (opts: BrowserRunOptions = {}) => run(null, 'kill-all', [], opts.timeout),
  });
}
