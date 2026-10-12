import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { createApp, startFeedCollection } from './server.mjs';

test('standalone daily routes redirect home, serve every required asset and keep data private', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartkey-daily-routes-'));
  const server = await createApp(directory);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/daily');
  for (const path of ['/daily', '/daily.css', '/daily.js', '/monitor.css', '/monitor-data.js', '/news/q4nihovltk9ofbhq1jn47lcgp', '/news.css', '/news.js']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
  const page = await (await fetch(`${base}/daily`)).text();
  assert.match(page, /href="https:\/\/shop\.smartkey\.fun\/membership\.html#monitor"/);
  const logo = await fetch(`${base}/smartkey-cat-loop.gif`);
  assert.equal(logo.headers.get('content-type'), 'image/gif');
  assert.equal(Buffer.from(await logo.arrayBuffer()).subarray(0, 6).toString(), 'GIF89a');
  for (const path of ['/data/daily-archive.json', '/api/status', '/api/aihot-reset', '/monitor', '/admin']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('DATA_DIR loads saved daily history outside the application directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartkey-daily-data-dir-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const entry = dailyItem('q4nihovltk9ofbhq1jn47lcgp');
  const date = new Date(Date.parse(entry.discoveredAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await writeFile(join(directory, 'daily-archive.json'), JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), items: [entry] }));
  server = await createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/daily?date=${date}`);
  const result = await response.json();
  assert.deepEqual(result.data.items, [entry]);
  assert.equal(result.history.retentionDays, 180);
});

test('local news routes forward story context and keep upstream errors out of the UI', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-signal-news-'));
  const uuid = '244f781e-a578-4493-804d-4b4cfa063ea3';
  const id = 'q4nihovltk9ofbhq1jn47lcgp';
  const hot = { data: { items: [{ id: uuid, rank: 1, title: '热点', heat: 120 }] }, stale: false };
  const server = await createApp(directory, { newsFeed: {
    getHot: async () => hot,
    getItem: async (value, story) => {
      if (value === id) return { data: { item: { id: value, title: '导读', story } } };
      throw Object.assign(new Error('AIHOT internal URL and error'), { status: value === 'limited' ? 429 : 404, retryAt: '2026-10-11T14:00:00Z' });
    },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/hot`)).json(), hot);
  const detail = await (await fetch(`${base}/api/news/${id}?story=${uuid}`)).json();
  assert.equal(detail.data.item.id, id);
  assert.equal(detail.data.item.story, uuid);
  assert.equal((await fetch(`${base}/api/hot`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/news/${id}`, { method: 'POST' })).status, 405);
  for (const [path, status] of [['missing', 404], ['limited', 429]]) {
    const response = await fetch(`${base}/api/news/${path}`);
    const error = await response.json();
    assert.equal(response.status, status);
    assert.equal(error.retryAt, '2026-10-11T14:00:00Z');
    assert.doesNotMatch(error.error, /AIHOT|https?:/i);
  }
});

const dailyItem = (id, time = Date.now()) => ({
  id, title: `资讯 ${id}`, summary: '来源摘要', originalTitle: 'Original title', reason: '推荐理由', category: 'industry', score: 80, selected: true,
  discoveredAt: new Date(time).toISOString(), publishedAt: null,
  source: { name: '原作者' }, links: { original: `https://example.com/${id}`, aihot: `https://aihot.news/items/${id}` },
  attribution: { name: 'AIHOT', url: `https://aihot.news/items/${id}` },
});
const dailyFixture = async (t, { items = [], dailyFeed, corrupt = false } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-signal-history-'));
  await writeFile(join(directory, 'daily-archive.json'), corrupt ? '{bad json' : JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), items }));
  const server = await createApp(directory, { dailyFeed });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
};
const recentDaily = items => ({ data: { schemaVersion: 1, query: { mode: 'selected', window: '7d', by: 'timeline' }, items, page: { count: items.length, hasMore: false, nextCursor: null } }, stale: false, fetchedAt: new Date().toISOString() });

test('daily history dates expose stored Beijing days without requesting the upstream', async t => {
  const entry = dailyItem('q4nihovltk9ofbhq1jn47lcgp');
  const date = new Date(Date.parse(entry.discoveredAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let calls = 0;
  const latest = recentDaily([entry]);
  const base = await dailyFixture(t, { items: [entry], dailyFeed: async () => { calls++; return latest; } });
  assert.equal(calls, 0, 'imported createApp must not start a collector on listen');
  for (const invalid of ['2026-02-29', '../data', '']) assert.equal((await fetch(`${base}/api/daily?date=${invalid}`)).status, 400);
  const stored = await (await fetch(`${base}/api/daily?date=${date}`)).json();
  assert.deepEqual(stored.data.items, [entry]);
  assert.deepEqual(stored.history, { retentionDays: 180, days: [{ date, count: 1 }] });
  assert.equal(calls, 0);
  const recent = await (await fetch(`${base}/api/daily`)).json();
  assert.deepEqual(recent, { ...latest, history: stored.history });
  assert.equal(calls, 1);
});

test('news details retain archived IDs and prefer the latest version of duplicate IDs', async t => {
  const old = dailyItem('q4nihovltk9ofbhq1jn47lcgp', Date.now() - 30 * 24 * 60 * 60 * 1000);
  const duplicate = dailyItem('q4nihovltk9ofbhq1jn47lcgq');
  const current = { ...duplicate, title: '最新修订标题', summary: '最新摘要' };
  const base = await dailyFixture(t, { items: [old, duplicate], dailyFeed: async () => recentDaily([current]) });
  const historic = await (await fetch(`${base}/api/news/${old.id}`)).json();
  assert.equal(historic.data.item.id, old.id);
  assert.deepEqual(historic.data.item.source, old.source);
  assert.deepEqual(historic.data.item.attribution, old.attribution);
  assert.equal(historic.data.item.contentText, null);
  const latest = await (await fetch(`${base}/api/news/${duplicate.id}`)).json();
  assert.equal(latest.data.item.title, current.title);
  assert.equal(latest.data.item.summary, current.summary);
  const daily = await (await fetch(`${base}/api/daily`)).json();
  assert.deepEqual(daily.data.items, [current], 'default daily stays limited to the latest upstream payload');
});

test('saved archive keeps daily and historic details available when the upstream is unavailable', async t => {
  const entry = dailyItem('q4nihovltk9ofbhq1jn47lcgp');
  const base = await dailyFixture(t, { items: [entry], dailyFeed: async () => { throw Object.assign(new Error('upstream AIHOT failed'), { status: 503 }); } });
  const response = await fetch(`${base}/api/daily`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data.items, [entry]);
  assert.equal(result.stale, true);
  assert.doesNotMatch(result.error, /AIHOT|https?:/i);
  const detail = await (await fetch(`${base}/api/news/${entry.id}`)).json();
  assert.equal(detail.stale, true);
  assert.equal(detail.data.item.id, entry.id);
});

test('corrupt history falls back to recent daily content without breaking the page', async t => {
  t.mock.method(console, 'warn', () => {});
  const entry = dailyItem('q4nihovltk9ofbhq1jn47lcgp');
  const latest = recentDaily([entry]);
  const base = await dailyFixture(t, { corrupt: true, dailyFeed: async () => latest });
  const result = await (await fetch(`${base}/api/daily`)).json();
  assert.deepEqual(result.data, latest.data);
  assert.deepEqual(result.history, { retentionDays: 180, days: [] });
  const date = new Date(Date.parse(entry.discoveredAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.deepEqual((await (await fetch(`${base}/api/daily?date=${date}`)).json()).data.items, [entry]);
});

test('standalone collector starts immediately, runs every ten minutes, and stops on server close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const server = new EventEmitter();
  server.address = () => ({ port: 4318 });
  const calls = [];
  let consumed = 0;
  startFeedCollection(server, { fetch: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, arrayBuffer: async () => { consumed++; return new ArrayBuffer(0); } };
  } });
  await setImmediate();
  assert.deepEqual(calls, ['http://127.0.0.1:4318/api/daily', 'http://127.0.0.1:4318/api/hot']);
  assert.equal(consumed, 2);
  t.mock.timers.tick(599_999);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls.length, 4);
  assert.equal(consumed, 4);
  server.emit('close');
  t.mock.timers.tick(600_000);
  await setImmediate();
  assert.equal(calls.length, 4);
});
