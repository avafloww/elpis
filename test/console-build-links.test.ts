import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): string =>
  readFileSync(path.join(root, file), 'utf8');

test('console keeps build identity compact without weakening exact links', () => {
  const main = read('src/console/client/main.tsx');
  const styles = read('src/console/client/styles.css');
  assert.equal((main.match(/revision\.slice\(0, 7\)/g) ?? []).length, 2);
  assert.doesNotMatch(main, /revision\.slice\(0, 12\)/);
  assert.match(
    styles,
    /\.sidebar-brand a \{[\s\S]*?white-space: nowrap;[\s\S]*?\}/,
  );
  assert.match(main, /title=\{revision\}/);
  assert.match(main, /href=\{revisionUrl\}/);
});
