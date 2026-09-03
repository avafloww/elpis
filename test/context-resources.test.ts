import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContextResourceInterrupt,
  ContextResources,
  DEFAULT_BUNDLED_SKILLS_DIRECTORY,
  MAX_AGENTS_BYTES,
} from '../src/context-resources.js';

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-context-resources-'),
  );
  const data = path.join(root, 'work', 'nested');
  const harness = path.join(root, 'harness');
  const home = path.join(root, 'home');
  const dataSkills = path.join(data, 'elpis-data', 'skills');
  const bundled = path.join(root, 'bundled-skills');
  fs.mkdirSync(dataSkills, { recursive: true });
  fs.mkdirSync(harness, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bundled, { recursive: true });
  return {
    root,
    data,
    dataSkills,
    bundled,
    harness,
    home,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeSkill(root: string, directory: string, text: string): string {
  const file = path.join(root, directory, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('source-mode default resolves repository bundled skills', () => {
  assert.equal(
    DEFAULT_BUNDLED_SKILLS_DIRECTORY,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills'),
  );
});

test('ContextResources discovers only Elpis-owned skill roots and loads full bodies', () => {
  const f = fixture();
  try {
    writeSkill(
      f.dataSkills,
      'alpha',
      '---\nname: alpha\ndescription: Alpha workflow\n---\n\nDo alpha exactly.\n',
    );
    writeSkill(
      f.bundled,
      'beta',
      '---\nname: beta\ndescription: Beta workflow\n---\n\nDo beta carefully.\n',
    );
    writeSkill(
      path.join(f.home, '.agents', 'skills'),
      'poison',
      '---\nname: poison\ndescription: Ambient poison\n---\n\nWrong body.\n',
    );
    const resources = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
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
    assert.doesNotMatch(loaded, /Wrong body/);
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

test('ContextResources rejects duplicate names across owned roots', () => {
  const f = fixture();
  try {
    const body =
      '---\nname: collision\ndescription: Conflicting workflow\n---\n\nbody\n';
    writeSkill(f.dataSkills, 'data-copy', body);
    writeSkill(f.bundled, 'bundled-copy', body);
    assert.throws(
      () =>
        new ContextResources({
          dataDirectory: f.data,
          bundledSkillsDirectory: f.bundled,
        }),
      /duplicate skill name "collision"/,
    );
  } finally {
    f.cleanup();
  }
});

test('ContextResources checks duplicates before refusing an overfull catalog', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 128; index++) {
      const name = `data-${String(index).padStart(3, '0')}`;
      writeSkill(
        f.dataSkills,
        name,
        `---\nname: ${name}\ndescription: Data workflow\n---\n\nbody\n`,
      );
    }
    const duplicate = writeSkill(
      f.bundled,
      'duplicate',
      '---\nname: data-000\ndescription: Duplicate workflow\n---\n\nbody\n',
    );
    assert.throws(
      () =>
        new ContextResources({
          dataDirectory: f.data,
          bundledSkillsDirectory: f.bundled,
        }),
      /duplicate skill name "data-000"/,
    );

    fs.rmSync(path.dirname(duplicate), { recursive: true });
    writeSkill(
      f.bundled,
      'extra',
      '---\nname: bundled-extra\ndescription: Extra workflow\n---\n\nbody\n',
    );
    assert.throws(
      () =>
        new ContextResources({
          dataDirectory: f.data,
          bundledSkillsDirectory: f.bundled,
        }),
      /skill catalog exceeds the 128-skill limit/,
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
        f.dataSkills,
        name,
        `---\nname: ${name}\ndescription: Workflow ${index}\n---\n\n${'x'.repeat(50 * 1024)}`,
      );
    }
    const resources = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
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
      f.dataSkills,
      'large',
      '---\nname: large\ndescription: Oversized workflow\n---\n\n' +
        'x'.repeat(70 * 1024),
    );
    const resources = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
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
    const skills = f.dataSkills;
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(external, path.join(skills, 'linked'));
    const resources = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
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

test('ContextResources checks lexical and physical AGENTS.md scopes for symlinked files', () => {
  const f = fixture();
  try {
    const lexical = path.join(f.data, 'lexical');
    const physical = path.join(f.home, 'physical');
    fs.mkdirSync(lexical, { recursive: true });
    fs.mkdirSync(physical, { recursive: true });
    fs.writeFileSync(path.join(lexical, 'AGENTS.md'), 'lexical rules\n');
    fs.writeFileSync(path.join(physical, 'AGENTS.md'), 'physical rules\n');
    const target = path.join(physical, 'file.ts');
    const link = path.join(lexical, 'link.ts');
    fs.writeFileSync(target, 'value\n');
    fs.symlinkSync(target, link);
    const resources = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });

    let first: ContextResourceInterrupt | null = null;
    assert.throws(
      () => resources.beforeFileAccess(link, 'file'),
      (error: unknown) => {
        assert.ok(error instanceof ContextResourceInterrupt);
        first = error;
        assert.match(error.message, /lexical rules/);
        return true;
      },
    );
    resources.acknowledge([first!.resource]);
    let second: ContextResourceInterrupt | null = null;
    assert.throws(
      () => resources.beforeFileAccess(link, 'file'),
      (error: unknown) => {
        assert.ok(error instanceof ContextResourceInterrupt);
        second = error;
        assert.match(error.message, /physical rules/);
        return true;
      },
    );
    resources.acknowledge([second!.resource]);
    assert.doesNotThrow(() => resources.beforeFileAccess(link, 'file'));
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
      bundledSkillsDirectory: f.bundled,
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

test('ContextResources restart restoration uses the latest descriptor for each key', () => {
  const f = fixture();
  try {
    const skillPath = writeSkill(
      f.dataSkills,
      'changing',
      '---\nname: changing\ndescription: Changes\n---\n\nversion one\n',
    );
    const original = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });
    const v1 = original.loadSkillContext(['changing']).resources[0];
    original.acknowledge([v1]);
    fs.writeFileSync(
      skillPath,
      '---\nname: changing\ndescription: Changes\n---\n\nversion two\n',
    );
    const v2 = original.loadSkillContext(['changing']).resources[0];
    original.acknowledge([v2]);
    fs.writeFileSync(
      skillPath,
      '---\nname: changing\ndescription: Changes\n---\n\nversion one\n',
    );

    const restored = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });
    restored.restore([v1, v2]);
    assert.deepEqual(restored.snapshot().skills, []);
  } finally {
    f.cleanup();
  }
});

test('ContextResources keeps post-start survivors out of the compaction reminder', () => {
  const f = fixture();
  try {
    writeSkill(
      f.dataSkills,
      'survivor',
      '---\nname: survivor\ndescription: Remains\n---\n\nbody\n',
    );
    const resources = new ContextResources({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });
    const descriptor = resources.loadSkillContext(['survivor']).resources[0];
    resources.acknowledge([descriptor]);
    assert.equal(resources.takeCompactionReminder([descriptor]), null);
    assert.deepEqual(resources.snapshot().skills, ['survivor']);
  } finally {
    f.cleanup();
  }
});

test('ContextResources compaction reminder clears and requires deliberate reload', () => {
  const f = fixture();
  try {
    writeSkill(
      f.dataSkills,
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
      bundledSkillsDirectory: f.bundled,
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
      bundledSkillsDirectory: f.bundled,
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
