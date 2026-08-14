import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/store/db.js';
import { MindService, MindStore, formatMindDetail, parseMindId, type MindReminder } from '../src/store/mind.js';
import { makeConfig } from './helpers.js';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

function schedulerStub() {
  let next = 1;
  const tasks = new Map<number, any>();
  return {
    tasks,
    create(opts: any) { const task = { id: next++, ...opts, doneAt: null }; tasks.set(task.id, task); return task; },
    delete(id: number) { return tasks.delete(id); },
    update(id: number, patch: any) { const task = tasks.get(id); if (!task) return null; Object.assign(task, patch); return task; },
  };
}

const logger = makeConfig().logger;

test('mind migrations are idempotent and create the complete schema', () => {
  const db = database();
  runMigrations(db);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mind_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
  assert.deepEqual(tables, ['mind_comments', 'mind_dependencies', 'mind_events', 'mind_items', 'mind_reminders', 'mind_tags']);
  assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 9);
  db.close();
});

test('dependency chains derive blocked and ready state one bead at a time', () => {
  const db = database();
  const mind = new MindStore(db);
  const foundation = mind.create({ title: 'foundation', priority: 3 });
  const walls = mind.create({ title: 'walls', dependsOn: [foundation.id] });
  const roof = mind.create({ title: 'roof', dependsOn: [walls.id] });

  assert.deepEqual(mind.ready().map((x) => x.id), [foundation.id]);
  assert.equal(mind.get(walls.id)!.effectiveStatus, 'blocked');
  assert.deepEqual(mind.get(roof.id)!.blockedBy.map((x) => x.id), [walls.id]);

  mind.setStatus(foundation.id, 'done', 'test');
  assert.deepEqual(mind.ready().map((x) => x.id), [walls.id]);
  mind.setStatus(walls.id, 'done', 'test');
  assert.deepEqual(mind.ready().map((x) => x.id), [roof.id]);
  assert.throws(() => mind.addDependency(foundation.id, roof.id), /would create a cycle/);
  db.close();
});

test('hierarchy, graph traversal, tags and search share one item model', () => {
  const db = database();
  const mind = new MindStore(db);
  const project = mind.create({ title: 'Cerebral cortex', kind: 'project', tags: ['Harness', 'brain work'] });
  const store = mind.create({ title: 'Implement graph store', body: 'Recursive dependency CTE', parentId: project.id, tags: ['harness'] });
  const ui = mind.create({ title: 'Build dashboard', parentId: project.id, dependsOn: [store.id] });

  assert.equal(mind.get(project.id)!.childCount, 2);
  assert.deepEqual(new Set(mind.list({ tag: 'harness' }).map((x) => x.id)), new Set([store.id, project.id]));
  assert.deepEqual(mind.list({ query: 'recursive' }).map((x) => x.id), [store.id]);
  const graph = mind.graph(ui.id, 4);
  assert.deepEqual(new Set(graph.nodes.map((x) => x.id)), new Set([project.id, store.id, ui.id]));
  assert.ok(graph.edges.some((x) => x.type === 'depends_on' && x.from === ui.id && x.to === store.id));
  assert.ok(graph.edges.some((x) => x.type === 'parent' && x.from === ui.id && x.to === project.id));
  assert.throws(() => mind.update(project.id, { parentId: ui.id }), /would create a cycle/);
  db.close();
});

test('list sorting covers created, updated, and last-comment timestamps in both directions', () => {
  const db = database();
  const mind = new MindStore(db);
  const a = mind.create({ title: 'oldest, no comment' });
  const b = mind.create({ title: 'middle, newest comment' });
  const c = mind.create({ title: 'newest, oldest comment' });
  const cb = mind.addComment(b.id, 'new comment');
  const cc = mind.addComment(c.id, 'old comment');
  db.prepare('UPDATE mind_items SET created_at = ?, updated_at = ? WHERE id = ?').run(100, 300, a.id);
  db.prepare('UPDATE mind_items SET created_at = ?, updated_at = ? WHERE id = ?').run(200, 100, b.id);
  db.prepare('UPDATE mind_items SET created_at = ?, updated_at = ? WHERE id = ?').run(300, 200, c.id);
  db.prepare('UPDATE mind_comments SET created_at = ? WHERE id = ?').run(300, cb.id);
  db.prepare('UPDATE mind_comments SET created_at = ? WHERE id = ?').run(200, cc.id);

  assert.deepEqual(mind.list({ sort: 'created_asc' }).map((x) => x.id), [a.id, b.id, c.id]);
  assert.deepEqual(mind.list({ sort: 'created_desc' }).map((x) => x.id), [c.id, b.id, a.id]);
  assert.deepEqual(mind.list({ sort: 'updated_asc' }).map((x) => x.id), [b.id, c.id, a.id]);
  assert.deepEqual(mind.list().map((x) => x.id), [a.id, c.id, b.id], 'updated_desc is the default');
  assert.deepEqual(mind.list({ sort: 'last_comment_asc' }).map((x) => x.id), [c.id, b.id, a.id]);
  const byComment = mind.list({ sort: 'last_comment_desc' });
  assert.deepEqual(byComment.map((x) => x.id), [b.id, c.id, a.id]);
  assert.deepEqual(byComment.map((x) => x.lastCommentAt), [300, 200, null]);
  assert.throws(() => mind.list({ sort: 'nonsense' as any }), /invalid sort/);
  db.close();
});

test('comments are CRUD-capable while events preserve the audit trail', () => {

  const db = database();
  const mind = new MindStore(db);
  const item = mind.create({ title: 'Read the body' });
  const comment = mind.addComment(item.id, 'first note', 'bramble');
  mind.updateComment(comment.id, 'corrected note', 'bramble');
  mind.update(item.id, { priority: 4, status: 'in_progress' }, 'aster');

  let detail = mind.get(item.id)!;
  assert.equal(detail.comments[0].body, 'corrected note');
  assert.ok(detail.events.some((x) => x.type === 'comment.added'));
  assert.ok(detail.events.some((x) => x.type === 'comment.updated'));
  assert.ok(detail.events.some((x) => x.type === 'item.updated'));

  assert.equal(mind.deleteComment(comment.id, 'bramble'), true);
  detail = mind.get(item.id)!;
  assert.equal(detail.comments.length, 0);
  assert.ok(detail.events.some((x) => x.type === 'comment.deleted'));
  db.close();
});

test('MindService links reminders to scheduler tasks, fires and cancels them', () => {
  const db = database();
  const scheduler = schedulerStub();
  let changes = 0;
  const service = new MindService({ db, scheduler, logger, onChanged: () => { changes++; } });
  const fireAt = Date.now() + 60_000;
  const item = service.create({ title: 'wake me', remindAt: fireAt, reminderChannelId: 'home', actor: 'aster' });
  const reminder = item.reminders[0] as MindReminder;
  assert.equal(scheduler.tasks.get(reminder.scheduledTaskId).nextRunAt, fireAt);

  service.onScheduledTaskWake({ id: reminder.scheduledTaskId, name: `mind-${item.id}-x` } as any);
  assert.ok(service.get(item.id)!.reminders[0].firedAt);

  const second = service.addReminder(item.id, Date.now() + 120_000, 'bramble', 'home');
  service.setStatus(item.id, 'done', 'aster');
  assert.equal(scheduler.tasks.has(second.scheduledTaskId), false);
  assert.ok(service.get(item.id)!.reminders.find((x) => x.id === second.id)!.cancelledAt);
  assert.ok(changes >= 4);
  db.close();
});

test('archive is soft, ids parse from human forms, and detail formatting is useful', () => {
  const db = database();
  const mind = new MindStore(db);
  const item = mind.create({ title: 'A small true task', body: 'Do the next thing', dueAt: Date.now() + 1000 });
  assert.equal(parseMindId(`#${item.id}`), item.id);
  assert.equal(parseMindId(`m-${item.id}`), item.id);
  assert.match(formatMindDetail(item), new RegExp(`#${item.id}.*A small true task`));
  mind.archive(item.id);
  assert.equal(mind.list().length, 0);
  assert.equal(mind.list({ includeArchived: true }).length, 1);
  mind.restore(item.id);
  assert.equal(mind.list().length, 1);
  db.close();
});
