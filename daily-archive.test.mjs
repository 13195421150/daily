import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDailyArchive } from './daily-archive.mjs';
import { createDailyFeed } from './daily-feed.mjs';

const start = Date.parse('2026-10-11T08:00:00Z');
const day = 24 * 60 * 60 * 1000;
const item = (id, discoveredAt = new Date(start).toISOString()) => ({
  id, title: `资讯 ${id}`, summary: null, category: null, reason: null, selected: true,
  source: { name: '新闻来源' }, links: { aihot: `https://aihot.news/items/${id}`, original: 'https://example.com/news' },
  publishedAt: null, discoveredAt,
});
const directory = t => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const read = file => JSON.parse(readFileSync(file, 'utf8'));

test('archive merges separate batches, updates duplicate IDs and survives restart', t => {
  const archiveFile = join(directory(t), 'archive.json');
  createDailyArchive({ archiveFile, clock: () => start })({ items: [item('a'), item('b')] });
  const update = { ...item('a'), title: '更新后的标题', summary: '新摘要' };
  createDailyArchive({ archiveFile, clock: () => start + day })({ items: [update, item('c')] });
  const archived = read(archiveFile);
  assert.equal(archived.retentionDays, 180);
  assert.equal(archived.updatedAt, new Date(start + day).toISOString());
  assert.equal(archived.items.length, 3);
  assert.deepEqual(new Map(archived.items.map(entry => [entry.id, entry])), new Map([['a', update], ['b', item('b')], ['c', item('c')]]));
});

test('archive removes expired content and retains the exact 180-day boundary', t => {
  const archiveFile = join(directory(t), 'archive.json');
  let time = start - day;
  const archive = createDailyArchive({ archiveFile, clock: () => time });
  archive({ items: [item('expired', new Date(start - 180 * day - 1).toISOString()), item('boundary', new Date(start - 180 * day).toISOString()), item('recent')] });
  assert.equal(read(archiveFile).items.length, 3);
  time = start;
  archive({ items: [] });
  assert.deepEqual(read(archiveFile).items.map(entry => entry.id), ['boundary', 'recent']);
  assert.equal(read(archiveFile).items[0].discoveredAt, new Date(start - 180 * day).toISOString());
});

test('archiving leaves the seven-day API payload, cache interval and ETag 304 unchanged', async t => {
  const dir = directory(t);
  const archiveFile = join(dir, 'archive.json');
  const data = { schemaVersion: 1, query: { mode: 'selected', window: '7d', by: 'timeline' }, items: [item('current')], page: { count: 1, hasMore: false, nextCursor: null } };
  createDailyArchive({ archiveFile, clock: () => start })({ items: [item('previous')] });
  let time = start;
  let calls = 0;
  const get = createDailyFeed({ archiveFile, cacheFile: join(dir, 'cache.json'), clock: () => time, fetch: async (_, options) => {
    if (++calls === 1) return { status: 200, ok: true, headers: new Headers({ ETag: '"v1"' }), json: async () => data };
    assert.equal(options.headers['If-None-Match'], '"v1"');
    return { status: 304, headers: new Headers() };
  } });
  assert.deepEqual((await get()).data, data);
  time += 10 * 60 * 1000 - 1;
  assert.deepEqual((await get()).data.items.map(entry => entry.id), ['current']);
  assert.equal(calls, 1);
  time++;
  assert.equal((await get()).stale, false);
  assert.equal(calls, 2);
  assert.deepEqual(read(archiveFile).items.map(entry => entry.id), ['previous', 'current']);
});

test('archive storage failure does not turn a successful feed into stale or failed data', async t => {
  t.mock.method(console, 'warn', () => {});
  const data = { schemaVersion: 1, query: { mode: 'selected', window: '7d', by: 'timeline' }, items: [item('current')], page: { hasMore: false } };
  const get = createDailyFeed({ archiveFile: join(directory(t), 'missing-directory', 'archive.json'), clock: () => start, fetch: async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => data }) });
  assert.deepEqual(await get(), { data, stale: false, fetchedAt: new Date(start).toISOString() });
  assert.equal(console.warn.mock.callCount(), 1);
});
