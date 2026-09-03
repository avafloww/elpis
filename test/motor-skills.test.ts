import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BUNDLED_MOTOR_SKILLS_DIRECTORY,
  MAX_MOTOR_SKILLS_PER_EPISODE,
  MotorSkills,
} from '../src/motor-skills.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-motor-skills-'));
  const data = path.join(root, 'data');
  const dataSkills = path.join(data, 'elpis-data', 'motor-skills');
  const bundled = path.join(root, 'bundled');
  const ambient = path.join(data, '.agents', 'skills');
  fs.mkdirSync(dataSkills, { recursive: true });
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(ambient, { recursive: true });
  return {
    root,
    data,
    dataSkills,
    bundled,
    ambient,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeSkill(
  root: string,
  name: string,
  body = 'move carefully',
): string {
  const file = path.join(root, name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${name} controls\n---\n\n${body}\n`,
  );
  return file;
}

test('MotorSkills discovers only dedicated package roots and inspects resources', () => {
  const f = fixture();
  try {
    const dataPath = writeSkill(
      f.dataSkills,
      'pixel-game',
      'press one tile at a time',
    );
    const resourcePath = path.join(
      f.dataSkills,
      'pixel-game',
      'TROUBLESHOOTING.md',
    );
    fs.writeFileSync(resourcePath, 'recover from the pause menu\n');
    writeSkill(f.bundled, 'retroarch', 'save through the menu');
    writeSkill(f.ambient, 'poison', 'ambient instructions');
    const skills = new MotorSkills({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });
    assert.deepEqual(skills.catalog(), [
      { name: 'pixel-game', description: 'pixel-game controls' },
      { name: 'retroarch', description: 'retroarch controls' },
    ]);
    const inspected = skills.inspect('pixel-game');
    assert.equal(inspected.path, dataPath);
    assert.equal(inspected.rootPath, path.dirname(dataPath));
    assert.equal(inspected.source, 'data');
    assert.match(inspected.body, /press one tile at a time/);
    assert.equal(
      inspected.sha256,
      createHash('sha256').update(inspected.body).digest('hex'),
    );
    assert.deepEqual(inspected.resources, [
      {
        handle: 'skill:pixel-game/TROUBLESHOOTING.md',
        relativePath: 'TROUBLESHOOTING.md',
        path: resourcePath,
        sha256: createHash('sha256')
          .update('recover from the pause menu\n')
          .digest('hex'),
        bytes: 28,
      },
    ]);
    assert.equal(Object.isFrozen(inspected), true);
    assert.equal(Object.isFrozen(inspected.resources), true);
    assert.equal(Object.isFrozen(inspected.resources[0]), true);
    assert.throws(() => skills.inspect('poison'), /unknown motor skill/);
  } finally {
    f.cleanup();
  }
});

test('MotorSkills preserves selection order and freezes package resource bodies', () => {
  const f = fixture();
  try {
    writeSkill(f.dataSkills, 'pixel-game');
    const resource = path.join(f.dataSkills, 'pixel-game', 'REFERENCE.txt');
    fs.writeFileSync(resource, 'frozen reference');
    writeSkill(f.bundled, 'retroarch');
    const skills = new MotorSkills({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });
    const selected = skills.select(['retroarch', 'pixel-game']);
    assert.deepEqual(
      selected.map((skill) => skill.name),
      ['retroarch', 'pixel-game'],
    );
    assert.equal(selected[1].resources[0].body, 'frozen reference');
    fs.writeFileSync(resource, 'later mutation');
    assert.equal(selected[1].resources[0].body, 'frozen reference');
    assert.equal(Object.isFrozen(selected), true);

    fs.writeFileSync(
      path.join(f.bundled, 'retroarch', 'SKILL.md'),
      '---\nname: retroarch\ndescription: changed after boot\n---\n\nchanged\n',
    );
    assert.throws(
      () => skills.inspect('retroarch'),
      /metadata changed before selection/,
    );
    assert.throws(
      () => skills.select(['pixel-game', 'pixel-game']),
      /duplicate motor skill selection/,
    );
    assert.throws(
      () =>
        skills.select(
          Array.from(
            { length: MAX_MOTOR_SKILLS_PER_EPISODE + 1 },
            (_, index) => `skill-${index}`,
          ),
        ),
      /at most 4 skills/,
    );

    writeSkill(f.dataSkills, 'large-a', 'a'.repeat(17 * 1024));
    writeSkill(f.dataSkills, 'large-b', 'b'.repeat(17 * 1024));
    const large = new MotorSkills({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });
    assert.throws(
      () => large.select(['large-a', 'large-b']),
      /aggregate limit/,
    );
  } finally {
    f.cleanup();
  }
});

test('MotorSkills rejects duplicate packages and symlink resources', () => {
  const f = fixture();
  try {
    writeSkill(f.dataSkills, 'collision');
    writeSkill(f.bundled, 'collision');
    assert.throws(
      () =>
        new MotorSkills({
          dataDirectory: f.data,
          bundledSkillsDirectory: f.bundled,
        }),
      /duplicate motor skill name "collision"/,
    );

    fs.rmSync(path.join(f.bundled, 'collision'), { recursive: true });
    const target = path.join(f.root, 'outside.txt');
    fs.writeFileSync(target, 'outside');
    fs.symlinkSync(target, path.join(f.dataSkills, 'collision', 'LINK.txt'));
    const skills = new MotorSkills({
      dataDirectory: f.data,
      bundledSkillsDirectory: f.bundled,
    });
    assert.throws(() => skills.select(['collision']), /may not be symlinks/);

    fs.rmSync(path.join(f.dataSkills, 'collision', 'LINK.txt'));
    fs.writeFileSync(path.join(f.dataSkills, 'collision', 'binary.bin'), 'x');
    assert.throws(
      () => skills.select(['collision']),
      /unsupported.*resource type/,
    );
  } finally {
    f.cleanup();
  }
});

test('source-mode motor-skill root is repository-owned', () => {
  assert.equal(
    DEFAULT_BUNDLED_MOTOR_SKILLS_DIRECTORY,
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'motor-skills',
    ),
  );
});
