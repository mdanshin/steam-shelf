import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('every exact client id lookup exists in the production page shell', async () => {
  const [source, html] = await Promise.all([
    readFile(new URL('../client/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../site/index.html', import.meta.url), 'utf8'),
  ]);
  const usedIds = [...source.matchAll(/\$\('(#[A-Za-z][\w-]*)'\)/g)].map((match) => match[1].slice(1));
  const declaredIds = new Set([...html.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((match) => match[1]));
  const missing = [...new Set(usedIds)].filter((id) => !declaredIds.has(id));
  assert.deepEqual(missing, []);
});