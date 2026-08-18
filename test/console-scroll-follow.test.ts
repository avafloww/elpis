import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function fixture() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/scroll-follow.js'), 'utf8');
  const window: Record<string, unknown> = {};
  vm.runInNewContext(src, { window });
  const scrollListeners: Array<() => void> = [];
  const clickListeners: Array<() => void> = [];
  const scroller = {
    scrollHeight: 1000, scrollTop: 800, clientHeight: 200,
    addEventListener(type: string, fn: () => void) { if (type === 'scroll') scrollListeners.push(fn); },
  };
  const button = {
    hidden: false,
    addEventListener(type: string, fn: () => void) { if (type === 'click') clickListeners.push(fn); },
  };
  const api = (window.ElpisScrollFollow as { createScrollFollower: (s: typeof scroller, b: typeof button, threshold?: number) => {
    isFollowing(): boolean; capture(): { following: boolean; scrollTop: number }; restore(x: { following: boolean; scrollTop: number }): void; afterGrowth(): void;
  } }).createScrollFollower(scroller, button, 80);
  return { scroller, button, api, scroll: () => scrollListeners.forEach(fn => fn()), click: () => clickListeners.forEach(fn => fn()) };
}

test('scroll follower pauses when the reader moves up and new growth does not yank them down', () => {
  const f = fixture();
  assert.equal(f.api.isFollowing(), true);
  assert.equal(f.button.hidden, true);
  f.scroller.scrollTop = 300;
  f.scroll();
  assert.equal(f.api.isFollowing(), false);
  assert.equal(f.button.hidden, false);
  f.scroller.scrollHeight = 1400;
  f.api.afterGrowth();
  assert.equal(f.scroller.scrollTop, 300);
  assert.equal(f.button.hidden, false);
});

test('scroll follower follows growth at latest and click-to-latest resumes following', () => {
  const f = fixture();
  f.scroller.scrollHeight = 1200;
  f.api.afterGrowth();
  assert.equal(f.scroller.scrollTop, 1200);
  f.scroller.scrollTop = 200;
  f.scroll();
  f.click();
  assert.equal(f.scroller.scrollTop, 1200);
  assert.equal(f.api.isFollowing(), true);
  assert.equal(f.button.hidden, true);
});

test('scroll follower preserves a paused position across a full Context rerender', () => {
  const f = fixture();
  f.scroller.scrollTop = 420;
  f.scroll();
  const before = f.api.capture();
  f.scroller.scrollHeight = 2200;
  f.scroller.scrollTop = 0;
  f.api.restore(before);
  assert.equal(f.scroller.scrollTop, 420);
  assert.equal(f.api.isFollowing(), false);
  assert.equal(f.button.hidden, false);
});
