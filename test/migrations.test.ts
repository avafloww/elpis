import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runComponentMigrations } from '../src/store/migrations.js';

const fixedNow = (): string => '2030-01-02T03:04:05.000Z';

function database(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

test('named migrations apply once in sorted order and write immutable receipts', () => {
  const db = database();
  const migrations = [
    {
      name: '0001-create',
      sql: 'CREATE TABLE sample (value INTEGER NOT NULL);',
    },
    { name: '0002-seed', sql: 'INSERT INTO sample (value) VALUES (42);' },
  ] as const;
  const first = runComponentMigrations(db, 'extension:sample', migrations, {
    now: fixedNow,
  });
  assert.deepEqual(first, {
    component: 'extension:sample',
    existing: [],
    applied: ['0001-create', '0002-seed'],
  });
  assert.equal(
    (db.prepare('SELECT value FROM sample').get() as { value: number }).value,
    42,
  );
  const receipts = db
    .prepare(
      `
    SELECT component, name, checksum, applied_at
    FROM elpis_migrations
    WHERE component = ?
    ORDER BY name
  `,
    )
    .all('extension:sample') as {
    component: string;
    name: string;
    checksum: string;
    applied_at: string;
  }[];
  assert.deepEqual(
    receipts.map(({ component, name, applied_at }) => ({
      component,
      name,
      applied_at,
    })),
    [
      {
        component: 'extension:sample',
        name: '0001-create',
        applied_at: fixedNow(),
      },
      {
        component: 'extension:sample',
        name: '0002-seed',
        applied_at: fixedNow(),
      },
    ],
  );
  assert.ok(receipts.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)));

  const second = runComponentMigrations(db, 'extension:sample', migrations, {
    now: () => {
      throw new Error('must not run');
    },
  });
  assert.deepEqual(second, {
    component: 'extension:sample',
    existing: ['0001-create', '0002-seed'],
    applied: [],
  });
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM sample').get() as { n: number }).n,
    1,
  );
  assert.throws(
    () => db.exec(`UPDATE elpis_migrations SET applied_at = 'changed'`),
    /immutable/,
  );
  assert.throws(() => db.exec('DELETE FROM elpis_migrations'), /append-only/);
  db.close();
});

test('migration failure rolls schema and receipt back atomically', () => {
  const db = database();
  assert.throws(
    () =>
      runComponentMigrations(db, 'extension:broken', [
        {
          name: '0001-broken',
          checksum: 'a'.repeat(64),
          up(database) {
            database.exec(
              'CREATE TABLE must_rollback (value INTEGER); INSERT INTO must_rollback VALUES (1);',
            );
            throw new Error('deliberate failure');
          },
        },
      ]),
    /extension:broken\/0001-broken failed: deliberate failure/,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'must_rollback'",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM elpis_migrations WHERE component = 'extension:broken'",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  db.close();
});

test('failed code migration revokes database and statement access before queued microtasks run', async () => {
  const db = database();
  let escaped: Promise<void> | undefined;
  assert.throws(
    () =>
      runComponentMigrations(db, 'extension:broken', [
        {
          name: '0001-queued-write',
          checksum: 'c'.repeat(64),
          up(database) {
            database.exec('CREATE TABLE synchronous_write (value INTEGER);');
            const insert = database.prepare(
              'INSERT INTO synchronous_write VALUES (?)',
            );
            escaped = Promise.resolve().then(() => {
              assert.throws(
                () =>
                  database.exec('CREATE TABLE escaped_write (value INTEGER);'),
                /scope is closed/,
              );
              assert.throws(() => insert.run(1), /scope is closed/);
            });
            throw new Error('rollback before microtask');
          },
        },
      ]),
    /rollback before microtask/,
  );
  await escaped;
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  assert.ok(!tables.includes('synchronous_write'));
  assert.ok(!tables.includes('escaped_write'));
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM elpis_migrations WHERE component = 'extension:broken'",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  db.close();
});

test('migration history rejects checksum drift, removed entries, and non-prefix insertions', () => {
  const drift = database();
  runComponentMigrations(drift, 'extension:sample', [
    { name: '0001-create', sql: 'CREATE TABLE sample (value INTEGER);' },
  ]);
  assert.throws(
    () =>
      runComponentMigrations(drift, 'extension:sample', [
        { name: '0001-create', sql: 'CREATE TABLE sample (other INTEGER);' },
      ]),
    /checksum drift/,
  );
  assert.throws(
    () => runComponentMigrations(drift, 'extension:sample', []),
    /undeclared entries/,
  );
  drift.close();

  const prefix = database();
  runComponentMigrations(prefix, 'extension:sample', [
    { name: '0002-late', sql: 'CREATE TABLE late (value INTEGER);' },
  ]);
  assert.throws(
    () =>
      runComponentMigrations(prefix, 'extension:sample', [
        { name: '0001-early', sql: 'CREATE TABLE early (value INTEGER);' },
        { name: '0002-late', sql: 'CREATE TABLE late (value INTEGER);' },
      ]),
    /not an exact declared prefix/,
  );
  prefix.close();
});

test('migration validation is strict and component histories are isolated', () => {
  const db = database();
  assert.throws(
    () => runComponentMigrations(db, 'sample', []),
    /component must match/,
  );
  assert.throws(
    () =>
      runComponentMigrations(db, 'extension:sample', [
        { name: '0002-second', sql: 'SELECT 2;' },
        { name: '0001-first', sql: 'SELECT 1;' },
      ]),
    /strictly sorted/,
  );
  assert.throws(
    () =>
      runComponentMigrations(db, 'extension:sample', [
        { name: 'bad name', sql: 'SELECT 1;' },
      ]),
    /name must match/,
  );
  assert.throws(
    () =>
      runComponentMigrations(db, 'extension:sample', [
        { name: '0001-code', checksum: 'nope', up() {} },
      ]),
    /lowercase SHA-256/,
  );
  assert.throws(
    () =>
      runComponentMigrations(db, 'extension:sample', [
        { name: '0001-extra', sql: 'SELECT 1;', typo: true } as never,
      ]),
    /unknown field typo/,
  );
  assert.throws(
    () =>
      runComponentMigrations(db, 'extension:sample', [
        { name: '0001-async', checksum: 'b'.repeat(64), async up() {} },
      ]),
    /must be synchronous/,
  );
  assert.doesNotThrow(() =>
    runComponentMigrations(db, `extension:${'a'.repeat(200)}`, []),
  );

  runComponentMigrations(db, 'extension:alpha', [
    { name: '0001-create', sql: 'CREATE TABLE alpha (value INTEGER);' },
  ]);
  runComponentMigrations(db, 'extension:beta', [
    { name: '0001-create', sql: 'CREATE TABLE beta (value INTEGER);' },
  ]);
  const components = (
    db
      .prepare(
        'SELECT DISTINCT component FROM elpis_migrations ORDER BY component',
      )
      .all() as { component: string }[]
  ).map((row) => row.component);
  assert.deepEqual(components, ['extension:alpha', 'extension:beta']);
  db.close();
});
