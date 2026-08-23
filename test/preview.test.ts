import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preview } from '../src/sandbox/preview.js';

test('preview: URL renders as a readable string', () => {
  const url = new URL('https://example.com/path?query=1');
  const out = preview(url, 1000);
  assert.ok(
    out.includes('https://example.com/path?query=1'),
    'URL should render as its href string',
  );
});
