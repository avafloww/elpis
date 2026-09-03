import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ContextResourceInterrupt,
  ContextResources,
  MAX_AGENTS_BYTES,
} from '../src/context-resources.js';

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-context-resources-'),
  );
  const data = path.join(root, 'work', 'nested');
  const harness = path.join(root, 'harness');
  const home = path.join(root, 'home');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(harness, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    root,
    data,
    harness,
    home,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeSkill(root: string, directory: string, text: string): string {
  const file = path.join(root, '.agents', 'skills', directory, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('ContextResources discovers standard skill roots and loads full bodies', () => {
  const f = fixture();
  try {
    writeSkill(
      f.data,
      'alpha',
      '---\nname: alpha\ndescription: Alpha workflow\n---\n\nDo alpha exactly.\n',
    );
    writeSkill(
      f.home,
      'beta',
      '---\nname: beta\ndescription: Beta workflow\n---\n\nDo beta carefully.\n',
    );
    writeSkill(
      path.dirname(f.data),
      'shadow',
      '---\nname: alpha\ndescription: Shadowed alpha\n---\n\nWrong alpha.\n',
    );
    const resources = new ContextResources({
      dataDirectory: f.data,
      harnessRoot: f.harness,
      homeDirectory: f.home,
    });

    assert.deepEqual(
      resources
        .catalog()
        .map(({ name, description }) => ({ name, description })),
      [
        { name: 'alpha', description: 'Alpha workflow' },
        { name: 'beta', description: 'Beta workflow' },
      ],
    );
    const loaded = resources.loadSkills(['alpha', 'beta']);
    assert.match(loaded, /Do alpha exactly\./);
    assert.match(loaded, /Do beta carefully\./);
    assert.doesNotMatch(loaded, /Wrong alpha/);
    assert.deepEqual(resources.snapshot().skills, ['alpha', 'beta']);
    assert.equal(
      resources.loadSkills(['alpha']),
      '[skills already present in the current context: alpha]',
    );
    assert.throws(
      () => resources.loadSkills(['../alpha']),
      /invalid skill name/,
    );
    assert.throws(
      () => resources.loadSkills(['missing']),
      /available: alpha, beta/,
    );
  } finally {
    f.cleanup();
  }
});

test('ContextResources rejects duplicate, over-count, and aggregate skill selections', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 9; index++) {
      const name = `skill-${index}`;
      writeSkill(
        f.data,
        name,
        `---\nname: ${name}\ndescription: Workflow ${index}\n---\n\n${'x'.repeat(50 * 1024)}`,
      );
    }
    const resources = new ContextResources({
      dataDirectory: f.data,
      harnessRoot: f.harness,
      homeDirectory: f.home,
    });
    assert.throws(
      () => resources.loadSkills(['skill-0', 'skill-0']),
      /duplicate names/,
    );
    assert.throws(
      () =>
        resources.loadSkills(
          Array.from({ length: 9 }, (_, index) => `skill-${index}`),
        ),
      /at most 8 skills/,
    );
    assert.throws(
      () => resources.loadSkills(['skill-0', 'skill-1', 'skill-2', 'skill-3']),
      /selected SKILL\.md files total .* limit is 196608/,
    );
    assert.deepEqual(resources.snapshot().skills, []);
  } finally {
    f.cleanup();
  }
});

test('ContextResources catalogs oversized skills and rejects them explicitly on load', () => {
  const f = fixture();
  try {
    writeSkill(
      f.data,
      'large',
      '---\nname: large\ndescription: Oversized workflow\n---\n\n' +
        'x'.repeat(70 * 1024),
    );
    const resources = new ContextResources({
      dataDirectory: f.data,
      harnessRoot: f.harness,
      homeDirectory: f.home,
    });
    assert.deepEqual(
      resources.catalog().map(({ name }) => name),
      ['large'],
    );
    assert.throws(
      () => resources.loadSkills(['large']),
      /SKILL\.md exceeds the 65536-byte context limit/,
    );
    assert.deepEqual(resources.snapshot().skills, []);
  } finally {
    f.cleanup();
  }
});

test('ContextResources follows a symlinked skill folder', () => {
  const f = fixture();
  try {
    const external = path.join(f.root, 'external-skill');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(
      path.join(external, 'SKILL.md'),
      '---\nname: linked\ndescription: Linked workflow\n---\n\nLinked body.\n',
    );
    const skills = path.join(f.data, '.agents', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(external, path.join(skills, 'linked'));
    const resources = new ContextResources({
      dataDirectory: f.data,
      harnessRoot: f.harness,
      homeDirectory: f.home,
    });
    assert.deepEqual(
      resources.catalog().map((skill) => skill.name),
      ['linked'],
    );
    assert.match(resources.loadSkills(['linked']), /Linked body\./);
  } finally {
    f.cleanup();
  }
});

test('ContextResources interrupts once for each nearest AGENTS.md scope', () => {
  const f = fixture();
  try {
    const rootAgents = path.join(f.root, 'AGENTS.md');
    const nestedAgents = path.join(f.data, 'AGENTS.md');
    fs.writeFileSync(rootAgents, 'root instructions\n');
    fs.writeFileSync(nestedAgents, 'nested instructions\n');
    const resources = new ContextResources({
      dataDirectory: f.data,
      harnessRoot: f.harness,
      homeDirectory: f.home,
    });
    const nestedTarget = path.join(f.data, 'src', 'file.ts');
    fs.mkdirSync(path.dirname(nestedTarget), { recursive: true });
    fs.writeFileSync(nestedTarget, 'x');

    assert.throws(
      () => resources.beforeFileAccess(nestedTarget, 'file'),
      (error: unknown) => {
        assert.ok(error instanceof ContextResourceInterrupt);
        assert.match(error.message, /nested instructions/);
        assert.doesNotMatch(error.message, /root instructions/);
        assert.match(error.message, /retry the run/);
        return true;
      },
    );
    let repeated: ContextResourceInterrupt | null = null;
    assert.throws(
      () => resources.beforeFileAccess(nestedTarget, 'file'),
      (error: unknown) => {
        assert.ok(error instanceof ContextResourceInterrupt);
        repeated = error;
        return true;
      },
    );
    resources.acknowledge([repeated!.resource]);
    assert.doesNotThrow(() => resources.beforeFileAccess(nestedTarget, 'file'));
    assert.doesNotThrow(() =>
      resources.beforeFileAccess(path.join(f.data, 'another.ts'), 'file'),
    );

    const rootTarget = path.join(f.root, 'elsewhere', 'file.ts');
    fs.mkdirSync(path.dirname(rootTarget), { recursive: true });
    fs.writeFileSync(rootTarget, 'x');
    let rootInterrupted: ContextResourceInterrupt | null = null;
    assert.throws(
      () => resources.beforeFileAccess(rootTarget, 'file'),
      (error: unknown) => {
        assert.ok(error instanceof ContextResourceInterrupt);
        rootInterrupted = error;
        assert.match(error.message, /root instructions/);
        return true;
      },
    );
    resources.acknowledge([rootInterrupted!.resource]);
    assert.deepEqual(
      resources.snapshot().agentsFiles,
      [nestedAgents, rootAgents].sort(),
    );
  } finally {
    f.cleanup();
  }
});

test('ContextResources compaction reminder clears and requires deliberate reload', () => {
  const f = fixture();
  try {
    writeSkill(
      f.data,
      'alpha',
      '---\nname: alpha\ndescription: Alpha workflow\n---\n\nAlpha body.\n',
    );
    const agents = path.join(f.data, 'AGENTS.md');
    const target = path.join(f.data, 'src', 'file.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(agents, 'local contract\n');
    fs.writeFileSync(target, 'x');
    const resources = new ContextResources({
      dataDirectory: f.data,
      harnessRoot: f.harness,
      homeDirectory: f.home,
    });
    resources.loadSkills(['alpha']);
    let interrupted: ContextResourceInterrupt | null = null;
    assert.throws(
      () => resources.beforeFileAccess(target, 'file'),
      (error: unknown) => {
        assert.ok(error instanceof ContextResourceInterrupt);
        interrupted = error;
        return true;
      },
    );
    resources.acknowledge([interrupted!.resource]);

    const reminder = resources.takeCompactionReminder();
    assert.match(reminder ?? '', /skills: "alpha"/);
    assert.match(
      reminder ?? '',
      new RegExp(agents.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.deepEqual(resources.snapshot(), { skills: [], agentsFiles: [] });
    assert.equal(resources.takeCompactionReminder(), null);

    resources.loadSkills(['alpha']);
    const second = resources.takeCompactionReminder();
    assert.match(second ?? '', /skills: "alpha"/);
    assert.doesNotMatch(second ?? '', /AGENTS\.md:/);
  } finally {
    f.cleanup();
  }
});

test('ContextResources refuses oversized AGENTS.md without marking it loaded', () => {
  const f = fixture();
  try {
    const agents = path.join(f.data, 'AGENTS.md');
    const target = path.join(f.data, 'file.ts');
    fs.writeFileSync(agents, 'x'.repeat(MAX_AGENTS_BYTES + 1));
    fs.writeFileSync(target, 'x');
    const resources = new ContextResources({
      dataDirectory: f.data,
      harnessRoot: f.harness,
      homeDirectory: f.home,
    });
    assert.throws(
      () => resources.beforeFileAccess(target, 'file'),
      /exceeds the 65536-byte context limit/,
    );
    assert.deepEqual(resources.snapshot().agentsFiles, []);
  } finally {
    f.cleanup();
  }
});
