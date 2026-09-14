import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { loadExtensions } from '../src/extensions.js';
import { resolveDataLayout } from '../src/store/data-layout.js';
import { runMigrations } from '../src/store/db.js';

const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;

function fixture(): { data: string; extensions: string } {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-package-ext-'));
  const extensions = resolveDataLayout(data).extensions;
  fs.mkdirSync(extensions, { recursive: true });
  return { data, extensions };
}

function database(): DatabaseSync {
  const value = new DatabaseSync(':memory:');
  runMigrations(value);
  return value;
}

function writePackage(
  extensions: string,
  directory: string,
  declaration: Record<string, unknown>,
  source = 'export const extension = {};',
): string {
  const root = path.join(extensions, directory);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: directory,
      main: './never.js',
      exports: './never.js',
      elpis: declaration,
    }),
  );
  fs.writeFileSync(path.join(root, 'src', 'extension.ts'), source);
  fs.writeFileSync(
    path.join(root, 'never.js'),
    'throw new Error("main executed")',
  );
  return root;
}

test('a TypeScript extension package resolves its package-local bare dependency', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const root = writePackage(
    extensions,
    'friendly-package',
    { extension: './src/extension.ts', namespace: 'friendly' },
    `import answer from 'local-answer';
     export const extension = {
       description: 'package fixture',
       prompt: 'stable package prompt',
       migrations: [{ name: '0001-package', sql: 'CREATE TABLE friendly_state (value INTEGER);' }],
       activate(context) { return { answer, sourceFile: context.sourceFile, nested: { ok: true } }; },
     };`,
  );
  const dependency = path.join(root, 'node_modules', 'local-answer');
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(dependency, 'package.json'),
    JSON.stringify({ type: 'module', exports: './index.js' }),
  );
  fs.writeFileSync(path.join(dependency, 'index.js'), 'export default 42;');

  const db = database();
  const options = {
    dataDirectory: data,
    harnessRoot: process.cwd(),
    agentName: () => 'Aster',
    database: db,
  };
  const first = await loadExtensions(options);
  const second = await loadExtensions(options);
  assert.deepEqual(first.failures, []);
  assert.equal(first.apis.friendly.answer, 42);
  assert.equal(
    first.apis.friendly.sourceFile,
    'friendly-package/src/extension.ts',
  );
  assert.equal((first.apis.friendly.nested as { ok: boolean }).ok, true);
  assert.ok(Object.isFrozen(first.apis.friendly));
  assert.ok(Object.isFrozen(first.apis.friendly.nested));
  assert.deepEqual(
    first.summaries.map(({ namespace, file }) => ({ namespace, file })),
    [{ namespace: 'friendly', file: 'friendly-package/src/extension.ts' }],
  );
  assert.equal(second.apis.friendly.answer, 42);
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM elpis_migrations WHERE component = 'extension:friendly'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
});

test('flat files remain compatible and collide with packages before activation', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.writeFileSync(path.join(extensions, 'my-tool.ext.ts'), 'fixture');
  writePackage(extensions, 'pkg', {
    extension: './src/extension.ts',
    namespace: 'myTool',
  });
  let imports = 0;
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    database: database(),
    importModule: async () => {
      imports += 1;
      return { extension: {} };
    },
  });
  assert.equal(imports, 0);
  assert.deepEqual(registry.summaries, []);
  assert.deepEqual(
    registry.failures.map(({ file, namespace, stage }) => ({
      file,
      namespace,
      stage,
    })),
    [
      { file: 'my-tool.ext.ts', namespace: 'myTool', stage: 'namespace' },
      { file: 'pkg/src/extension.ts', namespace: 'myTool', stage: 'namespace' },
    ],
  );
});

test('a missing package extension field still blocks a colliding flat namespace before activation', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.writeFileSync(path.join(extensions, 'shared.ext.ts'), 'fixture');
  const packageRoot = path.join(extensions, 'broken-package');
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ elpis: { namespace: 'shared' } }),
  );
  let imports = 0;
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    database: database(),
    importModule: async () => {
      imports += 1;
      return { extension: { activate: () => ({ activated: true }) } };
    },
  });

  assert.equal(imports, 0);
  assert.equal(registry.apis.shared, undefined);
  assert.equal(
    registry.failures.some(
      ({ file, namespace, stage }) =>
        file === 'shared.ext.ts' &&
        namespace === 'shared' &&
        stage === 'namespace',
    ),
    true,
  );
});

test('an invalid package entry still blocks a colliding flat namespace before activation', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.writeFileSync(path.join(extensions, 'shared.ext.ts'), 'fixture');
  writePackage(extensions, 'broken-package', {
    extension: './src/missing.ts',
    namespace: 'shared',
  });
  let imports = 0;
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    database: database(),
    importModule: async () => {
      imports += 1;
      return { extension: { activate: () => ({ activated: true }) } };
    },
  });

  assert.equal(imports, 0);
  assert.equal(registry.apis.shared, undefined);
  assert.equal(
    registry.failures.some(
      ({ file, namespace, stage }) =>
        file === 'shared.ext.ts' &&
        namespace === 'shared' &&
        stage === 'namespace',
    ),
    true,
  );
});

test('package-package collisions are sorted and checked before activation', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  writePackage(extensions, 'z-package', {
    extension: './src/extension.ts',
    namespace: 'shared',
  });
  writePackage(extensions, 'a-package', {
    extension: './src/extension.ts',
    namespace: 'shared',
  });
  let imports = 0;
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/harness',
    agentName: () => 'Aster',
    database: database(),
    importModule: async () => {
      imports += 1;
      return { extension: {} };
    },
  });
  assert.equal(imports, 0);
  assert.deepEqual(
    registry.failures.map((failure) => failure.file),
    ['a-package/src/extension.ts', 'z-package/src/extension.ts'],
  );
});

test('missing entries and dependencies quarantine only their packages', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  writePackage(extensions, 'missing-entry', {
    extension: './src/nope.ts',
    namespace: 'missingEntry',
  });
  writePackage(
    extensions,
    'missing-dependency',
    { extension: './src/extension.ts', namespace: 'missingDependency' },
    "import 'certainly-not-an-elpis-fixture-package'; export const extension = {};",
  );
  writePackage(
    extensions,
    'working',
    { extension: './src/extension.ts', namespace: 'working' },
    'export const extension = { activate: () => ({ ok: true }) };',
  );
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: process.cwd(),
    agentName: () => 'Aster',
    database: database(),
  });
  assert.equal(registry.apis.working.ok, true);
  assert.deepEqual(
    registry.failures.map(({ namespace, stage }) => [namespace, stage]),
    [
      ['missingEntry', 'discovery'],
      ['missingDependency', 'import'],
    ],
  );
});

test('malformed, non-UTF8, and oversized manifests fail with bounded safe diagnostics', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  for (const name of ['malformed', 'non-utf8', 'oversized'])
    fs.mkdirSync(path.join(extensions, name));
  fs.writeFileSync(
    path.join(extensions, 'malformed', 'package.json'),
    '{"elpis": SECRET_PAYLOAD',
  );
  fs.writeFileSync(
    path.join(extensions, 'non-utf8', 'package.json'),
    Buffer.from([0xff, 0xfe]),
  );
  fs.writeFileSync(
    path.join(extensions, 'oversized', 'package.json'),
    'x'.repeat(64 * 1024 + 1),
  );
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/h',
    agentName: () => 'Aster',
    database: database(),
  });
  assert.equal(registry.failures.length, 3);
  assert.ok(
    registry.failures.every((failure) => failure.stage === 'discovery'),
  );
  assert.ok(registry.failures.every((failure) => failure.error.length <= 1024));
  assert.ok(
    registry.failures.every(
      (failure) =>
        !failure.error.includes(data) &&
        !failure.error.includes('SECRET_PAYLOAD'),
    ),
  );
});

test('package manifests are read through a bounded descriptor', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const root = writePackage(
    extensions,
    'bounded',
    { extension: './src/extension.ts', namespace: 'bounded' },
    'export const extension = { activate: () => ({ ok: true }) };',
  );
  const manifestPath = path.join(root, 'package.json');
  const originals = {
    openSync: mutableFs.openSync,
    readFileSync: mutableFs.readFileSync,
    readSync: mutableFs.readSync,
  };
  let manifestDescriptor: number | null = null;
  const requestedLengths: number[] = [];
  const methods = mutableFs as unknown as Record<string, unknown>;
  methods.openSync = ((...args: unknown[]) => {
    const descriptor = Reflect.apply(originals.openSync, mutableFs, args);
    if (path.resolve(String(args[0])) === manifestPath)
      manifestDescriptor = descriptor;
    return descriptor;
  }) as typeof fs.openSync;
  methods.readFileSync = ((...args: unknown[]) => {
    if (path.resolve(String(args[0])) === manifestPath)
      throw new Error('whole-file manifest read attempted');
    return Reflect.apply(originals.readFileSync, mutableFs, args);
  }) as typeof fs.readFileSync;
  methods.readSync = ((...args: unknown[]) => {
    if (args[0] === manifestDescriptor) {
      if (typeof args[3] !== 'number')
        throw new Error('manifest read did not declare a byte bound');
      requestedLengths.push(args[3]);
      if (args[3] > 64 * 1024 + 1)
        throw new Error('manifest descriptor read exceeded its bound');
    }
    return Reflect.apply(originals.readSync, mutableFs, args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();

  let registry;
  try {
    registry = await loadExtensions({
      dataDirectory: data,
      harnessRoot: process.cwd(),
      agentName: () => 'Aster',
      database: database(),
      importModule: async () => ({
        extension: { activate: () => ({ ok: true }) },
      }),
    });
  } finally {
    Object.assign(methods, originals);
    syncBuiltinESMExports();
  }

  assert.equal(registry.apis.bounded.ok, true);
  assert.ok(requestedLengths.length > 0);
  assert.ok(requestedLengths.every((length) => length <= 64 * 1024 + 1));
});

test('invalid package namespaces and helper directories are not activated', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.mkdirSync(path.join(extensions, 'helper-no-manifest'));
  fs.mkdirSync(path.join(extensions, 'helper-package'));
  fs.writeFileSync(
    path.join(extensions, 'helper-package', 'package.json'),
    JSON.stringify({ name: 'helper' }),
  );
  for (const [directory, namespace] of [
    ['punctuation', 'my-tool'],
    ['reserved', '$help'],
    ['normalized', 'Friendly'],
  ] as const)
    writePackage(extensions, directory, {
      extension: './src/extension.ts',
      namespace,
    });
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/h',
    agentName: () => 'Aster',
    database: database(),
    importModule: async () => ({ extension: {} }),
  });
  assert.deepEqual(
    registry.summaries.map((summary) => summary.namespace),
    ['Friendly'],
  );
  assert.deepEqual(
    registry.failures.map(({ file, stage }) => [file, stage]),
    [
      ['punctuation/package.json', 'namespace'],
      ['reserved/package.json', 'namespace'],
    ],
  );
});

test('absolute, dot-dot, and symlink package entries are rejected', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  writePackage(extensions, 'absolute', {
    extension: path.join(extensions, 'outside.ts'),
    namespace: 'absolute',
  });
  writePackage(extensions, 'dotdot', {
    extension: '../outside.ts',
    namespace: 'dotdot',
  });
  const symlinkRoot = writePackage(extensions, 'symlink', {
    extension: './src/linked.ts',
    namespace: 'symlink',
  });
  fs.writeFileSync(
    path.join(extensions, 'outside.ts'),
    'export const extension = {};',
  );
  fs.symlinkSync(
    path.join(extensions, 'outside.ts'),
    path.join(symlinkRoot, 'src', 'linked.ts'),
  );
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/h',
    agentName: () => 'Aster',
    database: database(),
  });
  assert.deepEqual(
    registry.failures.map(({ namespace, stage }) => [namespace, stage]),
    [
      ['absolute', 'discovery'],
      ['dotdot', 'discovery'],
      ['symlink', 'discovery'],
    ],
  );
  assert.ok(
    registry.failures.every((failure) => !failure.error.includes(data)),
  );
});

test('package directory symlinks fail without inspecting target manifests', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const external = path.join(data, 'external-package');
  fs.mkdirSync(external);
  fs.writeFileSync(
    path.join(external, 'package.json'),
    '{"outside-root-sentinel":',
  );
  fs.symlinkSync(external, path.join(extensions, 'linked-package'));

  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/h',
    agentName: () => 'Aster',
    database: database(),
  });
  assert.deepEqual(registry.failures, [
    {
      file: 'linked-package',
      namespace: null,
      stage: 'discovery',
      error: 'package directory must not be a symlink',
    },
  ]);
});

test('non-file entries, symlink manifests, and symlink package directories are rejected', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const directoryEntry = writePackage(extensions, 'directory-entry', {
    extension: './src',
    namespace: 'directoryEntry',
  });
  assert.ok(fs.statSync(path.join(directoryEntry, 'src')).isDirectory());

  const danglingManifest = path.join(extensions, 'dangling-manifest');
  fs.mkdirSync(danglingManifest);
  fs.symlinkSync(
    path.join(data, 'missing-package.json'),
    path.join(danglingManifest, 'package.json'),
  );

  const manifestLink = path.join(extensions, 'manifest-link');
  fs.mkdirSync(manifestLink);
  const externalManifest = path.join(data, 'external-package.json');
  fs.writeFileSync(
    externalManifest,
    JSON.stringify({
      elpis: { extension: './src/extension.ts', namespace: 'manifestLink' },
    }),
  );
  fs.symlinkSync(externalManifest, path.join(manifestLink, 'package.json'));

  const realPackage = writePackage(extensions, 'real-package', {
    extension: './src/extension.ts',
    namespace: 'linkedPackage',
  });
  fs.symlinkSync(realPackage, path.join(extensions, 'linked-package'));

  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: '/h',
    agentName: () => 'Aster',
    database: database(),
  });
  assert.deepEqual(
    registry.failures.map(({ file, namespace, stage }) => ({
      file,
      namespace,
      stage,
    })),
    [
      {
        file: 'dangling-manifest/package.json',
        namespace: null,
        stage: 'discovery',
      },
      {
        file: 'directory-entry/package.json',
        namespace: 'directoryEntry',
        stage: 'discovery',
      },
      {
        file: 'linked-package',
        namespace: null,
        stage: 'discovery',
      },
      {
        file: 'manifest-link/package.json',
        namespace: null,
        stage: 'discovery',
      },
    ],
  );
  assert.equal(registry.apis.linkedPackage.ok, undefined);
});

test('non-string package errors remain quarantined as diagnostics', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  writePackage(
    extensions,
    'strange-error',
    { extension: './src/extension.ts', namespace: 'strangeError' },
    `const error = new Error();
     Object.defineProperty(error, 'message', { value: {} });
     export const extension = { activate() { throw error; } };`,
  );

  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: process.cwd(),
    agentName: () => 'Aster',
    database: database(),
  });
  assert.deepEqual(
    registry.failures.map(({ namespace, stage, error }) => ({
      namespace,
      stage,
      error,
    })),
    [
      {
        namespace: 'strangeError',
        stage: 'activation',
        error: '[object Object]',
      },
    ],
  );
});

test('package discovery diagnostics are deterministic across loads', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  writePackage(extensions, 'z-missing', {
    extension: './src/missing.ts',
    namespace: 'zMissing',
  });
  fs.mkdirSync(path.join(extensions, 'a-malformed'));
  fs.writeFileSync(path.join(extensions, 'a-malformed', 'package.json'), '{');
  const load = () =>
    loadExtensions({
      dataDirectory: data,
      harnessRoot: '/h',
      agentName: () => 'Aster',
      database: database(),
    });
  const first = await load();
  const second = await load();
  assert.deepEqual(first.failures, second.failures);
  assert.deepEqual(
    first.failures.map((failure) => failure.file),
    ['a-malformed/package.json', 'z-missing/package.json'],
  );
});

test('package lifecycle scripts and package main or exports never execute', async (t) => {
  const { data, extensions } = fixture();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const marker = path.join(data, 'lifecycle-ran');
  const root = writePackage(
    extensions,
    'safe',
    { extension: './src/extension.ts', namespace: 'safe' },
    'export const extension = { activate: () => ({ ok: true }) };',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  manifest.scripts = {
    preinstall: `touch ${marker}`,
    install: `touch ${marker}`,
    postinstall: `touch ${marker}`,
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  const registry = await loadExtensions({
    dataDirectory: data,
    harnessRoot: process.cwd(),
    agentName: () => 'Aster',
    database: database(),
  });
  assert.equal(registry.apis.safe.ok, true);
  assert.equal(fs.existsSync(marker), false);
});
