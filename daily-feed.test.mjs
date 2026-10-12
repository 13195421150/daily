import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDailyFeed } from './daily-feed.mjs';

const TTL = 10 * 60 * 1000;
const start = Date.parse('2026-10-11T08:00:00Z');
const item = {
  id: 'selected-item', title: '精选资讯', summary: '资讯摘要', category: 'industry', reason: '推荐理由', selected: true,
  source: { name: '新闻来源' }, links: { aihot: 'https://aihot.news/items/selected-item', original: 'https://example.com/news' },
  publishedAt: '2026-10-11T07:00:00Z', discoveredAt: '2026-10-11T07:30:00Z',
};
const data = {
  schemaVersion: 1, query: { mode: 'selected', window: '7d', by: 'timeline' },
  items: [item], page: { count: 1, hasMore: false, nextCursor: null },
};
const response = (status = 200, headers = {}, value = data) => ({
  status, ok: status >= 200 && status < 300,
  headers: new Headers(headers), json: async () => value,
});
const diskCache = t => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-feed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'cache.json');
};

test('fixed selected source, GET headers, ten-minute cache and concurrent request sharing', async () => {
  let time = start;
  let calls = 0;
  let release;
  const get = createDailyFeed({ clock: () => time, fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://aihot.news/api/v1/items?mode=selected&window=7d&by=timeline&limit=100');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['User-Agent'], 'aihot-api/2.0.0');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['If-None-Match'], undefined);
    await new Promise(resolve => { release = resolve; });
    return response(200, { ETag: '"v1"' });
  } });
  const first = get();
  assert.equal(get(), first);
  release();
  const fresh = await first;
  assert.deepEqual(fresh, { data, stale: false, fetchedAt: new Date(start).toISOString() });
  time += TTL - 1;
  assert.deepEqual(await get(), fresh);
  assert.equal(calls, 1);
});

test('ETag 304 keeps item timestamps and starts another ten-minute cache period', async () => {
  let time = start;
  let calls = 0;
  const get = createDailyFeed({ clock: () => time, fetch: async (_, options) => {
    if (++calls === 1) return response(200, { ETag: '"v1"' });
    assert.equal(options.headers['If-None-Match'], '"v1"');
    return response(304);
  } });
  await get();
  time += TTL;
  const fresh = await get();
  assert.equal(fresh.data, data);
  assert.equal(fresh.data.items[0].discoveredAt, item.discoveredAt);
  assert.equal(fresh.fetchedAt, new Date(time).toISOString());
  assert.equal(fresh.stale, false);
  time += TTL - 1;
  await get();
  assert.equal(calls, 2);
});

test('expired cache survives a fetch error and failed attempts are throttled', async () => {
  let time = start;
  let calls = 0;
  const get = createDailyFeed({ clock: () => time, fetch: async () => {
    if (++calls === 1) return response();
    throw new Error('upstream unavailable');
  } });
  const fresh = await get();
  time += TTL;
  const stale = await get();
  assert.deepEqual(stale, { ...fresh, stale: true, error: 'upstream unavailable' });
  time += TTL - 1;
  assert.deepEqual(await get(), stale);
  assert.equal(calls, 2);
});

for (const [status, retryAfter] of [[429, '1200'], [503, new Date(start + 2 * TTL).toUTCString()]]) {
  test(`cold HTTP ${status} honors Retry-After and preserves status and retryAt`, async () => {
    let time = start;
    let calls = 0;
    const get = createDailyFeed({ clock: () => time, fetch: async () =>
      ++calls === 1 ? response(status, { 'Retry-After': retryAfter }) : response() });
    const expected = { status, retryAt: new Date(start + 2 * TTL).toISOString() };
    await assert.rejects(get(), expected);
    time += 2 * TTL - 1;
    await assert.rejects(get(), expected);
    assert.equal(calls, 1);
    time++;
    assert.equal((await get()).stale, false);
    assert.equal(calls, 2);
  });
}

test('a short Retry-After cannot shorten the ten-minute minimum request interval', async () => {
  let time = start;
  let calls = 0;
  const get = createDailyFeed({ clock: () => time, fetch: async () => {
    calls++;
    return response(429, { 'Retry-After': '1' });
  } });
  await assert.rejects(get(), { retryAt: new Date(start + TTL).toISOString() });
  time += TTL - 1;
  await assert.rejects(get(), /HTTP 429/);
  assert.equal(calls, 1);
});

test('an out-of-range Retry-After preserves last good data and the normal request interval', async () => {
  let time = start;
  let calls = 0;
  const get = createDailyFeed({ clock: () => time, fetch: async () =>
    ++calls === 1 ? response() : response(429, { 'Retry-After': '10000000000000' }) });
  const fresh = await get();
  time += TTL;
  const stale = await get();
  assert.deepEqual(stale, { ...fresh, stale: true, error: 'AIHOT 请求失败（HTTP 429）' });
  time += TTL - 1;
  assert.deepEqual(await get(), stale);
  assert.equal(calls, 2);
  time++;
  assert.equal((await get()).stale, true);
  assert.equal(calls, 3);
});

test('timeout without cache is explicit and subsequent calls remain throttled', async () => {
  let calls = 0;
  const get = createDailyFeed({ clock: () => start, timeoutMs: 5, fetch: async (_, { signal }) => {
    calls++;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(get(), /超时/);
  await assert.rejects(get(), /超时/);
  assert.equal(calls, 1);
});

test('invalid JSON and a cold 304 fail explicitly', async () => {
  const invalidJson = createDailyFeed({ fetch: async () => ({ ...response(), json: async () => { throw new SyntaxError('invalid JSON'); } }) });
  await assert.rejects(invalidJson(), /invalid JSON/);
  await assert.rejects(createDailyFeed({ fetch: async () => response(304) })(), /304.*没有可用日报缓存/);
});

test('malformed or non-selected data never replaces the last good snapshot', async () => {
  for (const value of [
    { ...data, schemaVersion: 2 }, { ...data, query: { ...data.query, mode: 'all' } },
    { ...data, items: null }, { ...data, items: [null] },
    { ...data, items: [{ ...item, selected: false }] }, { ...data, items: [{ ...item, links: null }] },
    { ...data, items: [{ ...item, discoveredAt: 'invalid' }] }, { ...data, items: [{ ...item, discoveredAt: 0 }] },
    { ...data, items: [{ ...item, publishedAt: 0 }] }, { ...data, page: null },
  ]) {
    let time = start;
    let calls = 0;
    const get = createDailyFeed({ clock: () => time, fetch: async () => ++calls === 1 ? response() : response(200, {}, value) });
    const fresh = await get();
    time += TTL;
    assert.deepEqual(await get(), { ...fresh, stale: true, error: 'AIHOT 精选数据格式无效' });
  }
});

test('empty selections and nullable summary, category, reason and publication date are valid', async () => {
  for (const items of [[], [{ ...item, summary: null, category: null, reason: null, publishedAt: null }]]) {
    const value = { ...data, items };
    const get = createDailyFeed({ fetch: async () => response(200, {}, value) });
    assert.equal((await get()).data, value);
  }
});

test('restart reuses fresh disk cache and persists ETag and fetchedAt', async t => {
  const cacheFile = diskCache(t);
  let time = start;
  const fresh = await createDailyFeed({ cacheFile, clock: () => time, fetch: async () => response(200, { ETag: '"v1"' }) })();
  let calls = 0;
  time += TTL - 1;
  const get = createDailyFeed({ cacheFile, clock: () => time, fetch: async (_, options) => {
    calls++;
    assert.equal(options.headers['If-None-Match'], '"v1"');
    return response(304);
  } });
  assert.deepEqual(await get(), fresh);
  assert.equal(calls, 0);
  time++;
  assert.deepEqual((await get()).data, data);
  assert.equal(calls, 1);
});

test('restart preserves last good cache and Retry-After after failure', async t => {
  const cacheFile = diskCache(t);
  let time = start;
  let calls = 0;
  const first = createDailyFeed({ cacheFile, clock: () => time, fetch: async () =>
    ++calls === 1 ? response() : response(429, { 'Retry-After': '1200' }) });
  const fresh = await first();
  time += TTL;
  const stale = await first();
  assert.equal(stale.fetchedAt, fresh.fetchedAt);
  const get = createDailyFeed({ cacheFile, clock: () => time, fetch: async () => { calls++; return response(); } });
  time += 2 * TTL - 1;
  assert.deepEqual(await get(), stale);
  assert.equal(calls, 2);
  time++;
  assert.equal((await get()).stale, false);
  assert.equal(calls, 3);
});

test('cold failure backoff survives restart with status and retryAt', async t => {
  const cacheFile = diskCache(t);
  let calls = 0;
  const first = createDailyFeed({ cacheFile, clock: () => start, fetch: async () => {
    calls++;
    return response(503, { 'Retry-After': '1200' });
  } });
  const expected = { status: 503, retryAt: new Date(start + 2 * TTL).toISOString() };
  await assert.rejects(first(), expected);
  const get = createDailyFeed({ cacheFile, clock: () => start + TTL, fetch: async () => { calls++; return response(); } });
  await assert.rejects(get(), expected);
  assert.equal(calls, 1);
});

test('restart during an unfinished request preserves the request cooldown', async t => {
  const cacheFile = diskCache(t);
  let release;
  const first = createDailyFeed({ cacheFile, clock: () => start, fetch: async () => {
    await new Promise(resolve => { release = resolve; });
    return response();
  } });
  const pending = first();
  const restarted = createDailyFeed({ cacheFile, clock: () => start + 1, fetch: async () => { assert.fail('must wait'); } });
  await assert.rejects(restarted(), error => error instanceof Error && error.retryAt === new Date(start + TTL).toISOString());
  release();
  await pending;
});

test('corrupt cache is ignored and replaced by a verified upstream snapshot', async t => {
  const cacheFile = diskCache(t);
  writeFileSync(cacheFile, JSON.stringify({ cache: { data: { ...data, items: [null] }, fetchedAt: new Date(start).toISOString() }, cachedAt: start, nextRequestAt: start + TTL }));
  const get = createDailyFeed({ cacheFile, clock: () => start, fetch: async () => response() });
  assert.deepEqual((await get()).data, data);
});

test('out-of-range saved timestamps cannot block requests after restart', async t => {
  const cacheFile = diskCache(t);
  for (const timestamps of [{ cachedAt: 1e20, nextRequestAt: start }, { cachedAt: start, nextRequestAt: 1e20 }]) {
    writeFileSync(cacheFile, JSON.stringify({ cache: { data, fetchedAt: new Date(start).toISOString() }, ...timestamps }));
    let calls = 0;
    const get = createDailyFeed({ cacheFile, clock: () => start, fetch: async () => { calls++; return response(); } });
    assert.equal((await get()).stale, false);
    assert.equal(calls, 1);
  }
});
