import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadExtensions, normalizeExtensionNamespace } from '../src/extensions.js';
import { build as buildPrompt } from '../src/llm/prompt.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

function tempData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-ext-'));
  fs.mkdirSync(resolveDataLayout(dir).extensions, { recursive: true });
  return dir;
}

function touch(data: string, name: string): void {
  fs.writeFileSync(path.join(resolveDataLayout(data).extensions, name), 'fixture');
}

test('extension namespaces are filename-owned and dot-safe', () => {
  assert.equal(normalizeExtensionNamespace('Unn.ext.ts'), 'unn');
  assert.equal(normalizeExtensionNamespace('My odd-tool.ext.mts'), 'myOddTool');
  assert.equal(normalizeExtensionNamespace('alreadyCamel.ext.ts'), 'alreadyCamel');
  assert.equal(normalizeExtensionNamespace('HTTP tools.ext.ts'), 'httpTools');
  assert.equal(normalizeExtensionNamespace('42.ext.js'), '_42');
  assert.throws(() => normalizeExtensionNamespace('nope.ts'), /must match/);
});

test('extensions activate sequentially in normalized namespace order and freeze prompt bytes', async () => {
  const data = tempData();
  touch(data, 'Zed.ext.ts');
  touch(data, 'alpha.ext.ts');
  const activations: string[] = [];
  const definitions: Record<string, Record<string, unknown>> = {
    'Zed.ext.ts': {
      description: 'zed',
      prompt: '  zed\r\nwords  ',
      activate: async () => { activations.push('zed'); return { z: 1 }; },
    },
    'alpha.ext.ts': {
      description: 'alpha',
      prompt: 'alpha words',
      activate: async () => { activations.push('alpha'); return { b: 2, a: () => 'a' }; },
    },
  };
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    importModule: async (file) => ({ extension: definitions[path.basename(file)] }),
  });
  assert.deepEqual(activations, ['alpha', 'zed']);
  assert.deepEqual(registry.summaries.map((x) => x.namespace), ['alpha', 'zed']);
  assert.deepEqual(registry.summaries[0].members, ['a', 'b']);
  assert.match(registry.prompt, /^#### `elpis\.ext\.alpha`/);
  assert.ok(registry.prompt.indexOf('alpha words') < registry.prompt.indexOf('zed\nwords'));
  assert.equal(Object.getPrototypeOf(registry.apis.alpha), null);
  assert.ok(Object.isFrozen(registry.apis));
  assert.ok(Object.isFrozen(registry.apis.alpha));
  assert.ok(Object.isFrozen(registry.summaries));
  fs.rmSync(data, { recursive: true, force: true });
});

test('literal prompt and API are copied before extension-owned mutation can move them', async () => {
  const data = tempData();
  touch(data, 'mutable.ext.ts');
  const definition: Record<string, unknown> = { prompt: 'before' };
  const api = { nested: { value: 1 } };
  definition.activate = () => {
    definition.prompt = 'after';
    return api;
  };
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    importModule: async () => ({ extension: definition }),
  });
  api.nested.value = 2;
  assert.match(registry.prompt, /before/);
  assert.doesNotMatch(registry.prompt, /after/);
  assert.equal((registry.apis.mutable.nested as { value: number }).value, 1);
  assert.equal(Object.getPrototypeOf(registry.apis.mutable.nested), null);
  assert.ok(Object.isFrozen(registry.apis.mutable.nested));
  fs.rmSync(data, { recursive: true, force: true });
});

test('namespace collisions and unsafe API shapes quarantine extensions without failing startup', async () => {
  const collision = tempData();
  touch(collision, 'my-tool.ext.ts');
  touch(collision, 'my_tool.ext.ts');
  const collisionRegistry = await loadExtensions({
    dataDirectory: collision,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    importModule: async () => ({ extension: {} }),
  });
  assert.deepEqual(collisionRegistry.summaries, []);
  assert.equal(collisionRegistry.failures.length, 2);
  assert.ok(collisionRegistry.failures.every((failure) => failure.stage === 'namespace'));
  assert.equal(collisionRegistry.prompt, '');
  fs.rmSync(collision, { recursive: true, force: true });

  const circular = tempData();
  touch(circular, 'loop.ext.ts');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  const circularRegistry = await loadExtensions({
    dataDirectory: circular,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    importModule: async () => ({ extension: { prompt: 'must stay absent', activate: () => loop } }),
  });
  assert.equal(circularRegistry.failures[0]?.stage, 'api');
  assert.match(circularRegistry.failures[0]?.error ?? '', /circular reference/);
  assert.equal(circularRegistry.apis.loop, undefined);
  assert.doesNotMatch(circularRegistry.prompt, /must stay absent/);
  fs.rmSync(circular, { recursive: true, force: true });
});

test('real TypeScript extension files load through tsx at runtime', async () => {
  const data = tempData();
  fs.writeFileSync(path.join(resolveDataLayout(data).extensions, 'typed.ext.ts'), `
    type NumberBox = { value: number };
    export const extension = {
      description: 'typed fixture',
      prompt: 'Use elpis.ext.typed.double(value).',
      activate(context: { agentName(): string }) {
        const box: NumberBox = { value: 21 };
        return { agent: context.agentName(), double: (value: number) => value * 2, box };
      },
    };
  `);
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
  });
  const typed = registry.apis.typed as { agent: string; double(value: number): number; box: { value: number } };
  assert.equal(typed.agent, 'Aster');
  assert.equal(typed.double(21), 42);
  assert.equal(typed.box.value, 21);
  assert.equal(Object.getPrototypeOf(typed.box), null);
  assert.ok(Object.isFrozen(typed.box));
  assert.match(registry.prompt, /elpis\.ext\.typed\.double/);
  fs.rmSync(data, { recursive: true, force: true });
});

test('real TS parse and activation failures are recorded while later extensions still load', async () => {
  const data = tempData();
  fs.writeFileSync(path.join(resolveDataLayout(data).extensions, 'broken.ext.ts'), `export const extension = {`);
  fs.writeFileSync(path.join(resolveDataLayout(data).extensions, 'throws.ext.ts'), `export const extension = { prompt: 'never inject this', activate() { throw new Error('activation boom'); } };`);
  fs.writeFileSync(path.join(resolveDataLayout(data).extensions, 'working.ext.ts'), `export const extension = { prompt: 'working prompt', activate() { return { value: 42 }; } };`);
  const logs: string[] = [];
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    log: (level, ...args) => logs.push(`${level}:${args.join(' ')}`),
  });
  assert.equal(registry.summaries.length, 1);
  assert.equal(registry.summaries[0].namespace, 'working');
  assert.equal(registry.apis.working.value, 42);
  assert.deepEqual(registry.failures.map((failure) => [failure.namespace, failure.stage]), [['broken', 'import'], ['throws', 'activation']]);
  assert.match(registry.prompt, /working prompt/);
  assert.doesNotMatch(registry.prompt, /never inject this/);
  assert.ok(Object.isFrozen(registry.failures));
  assert.ok(registry.failures.every(Object.isFrozen));
  assert.equal(logs.filter((line) => line.startsWith('error:extension skipped')).length, 2);
  fs.rmSync(data, { recursive: true, force: true });
});

test('failure diagnostics cannot make optional extensions a boot dependency', async () => {
  const data = tempData();
  touch(data, 'broken.ext.ts');
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    log: () => { throw new Error('logger unavailable'); },
    importModule: async () => { throw new Error('parse failed'); },
  });
  assert.equal(registry.failures.length, 1);
  assert.equal(registry.failures[0].stage, 'import');
  assert.equal(registry.prompt, '');
  fs.rmSync(data, { recursive: true, force: true });
});

test('the exact documented example copies, loads, and runs', async () => {
  const data = tempData();
  fs.copyFileSync(path.join(process.cwd(), 'docs', 'example.ext.ts'), path.join(resolveDataLayout(data).extensions, 'example.ext.ts'));
  const runLogs: string[] = [];
  const registry = await loadExtensions({ dataDirectory: data, harnessRoot: process.cwd(), agentName: () => 'Aster', runLog: (...args) => runLogs.push(args.join(' ')) });
  assert.deepEqual(registry.failures, []);
  const example = registry.apis.example as { greet(name: string): string };
  assert.equal(example.greet('Bramble'), 'hello, Bramble — from Aster');
  assert.deepEqual(runLogs, ['example.greet: Bramble']);
  assert.match(registry.prompt, /elpis\.ext\.example\.greet/);
  fs.rmSync(data, { recursive: true, force: true });
});

test('extension prompt blocks are injected once at the stable tool-documentation seam', () => {
  const marker = '#### `elpis.ext.alpha`\nalpha-only-instruction';
  const prompt = buildPrompt({ soul: '', memory: '', now: '', harnessRoot: '/h', dataDirectory: '/d', extensionPrompt: marker });
  assert.equal(prompt.split(marker).length - 1, 1);
  assert.ok(prompt.indexOf('### `elpis.ext`') < prompt.indexOf(marker));
  assert.match(prompt, /elpis\.ext\.\$help\(namespace\)/);
  assert.match(prompt, /elpis\.ext\.\$failures\(\)/);
  assert.match(prompt, /failed extension exposes neither API nor prompt text/i);
  assert.ok(prompt.indexOf(marker) < prompt.indexOf('### `fs`'));
  assert.doesNotMatch(prompt, /elpis\.(?:marginalia|metacog)/);
  const empty = buildPrompt({ soul: '', memory: '', now: '', harnessRoot: '/h', dataDirectory: '/d' });
  assert.match(empty, /No extensions are loaded\./);
  assert.doesNotMatch(empty, /alpha-only-instruction/);
});
