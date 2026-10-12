import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNewsFeed } from './news-feed.mjs';

const TTL = 10 * 60 * 1000;
const start = Date.parse('2026-10-11T08:00:00Z');
const uuid = '244f781e-a578-4493-804d-4b4cfa063ea3';
const itemId = 'q4nihovltk9ofbhq1jn47lcgp';
const item = {
  id: itemId, title: '公开资讯标题', originalTitle: 'Original title', summary: '公开摘要', reason: '推荐理由',
  score: 85, category: 'industry', source: { name: '原始报道来源' }, publishedAt: '2026-10-11T07:00:00Z',
  discoveredAt: '2026-10-11T07:30:00Z', selected: true,
  links: { aihot: `https://aihot.news/items/${itemId}`, original: 'https://example.com/news' },
  attribution: { name: 'AIHOT', url: 'https://aihot.news' },
};
const daily = { data: { schemaVersion: 1, items: [item] }, stale: false, fetchedAt: new Date(start).toISOString() };
const story = {
  schemaVersion: 1, story: {
    publicId: uuid, title: '当前热点标题', status: 'active', sourceCount: 4, reportCount: 1,
    firstReportAt: '2026-10-10T18:48:35Z', latestAt: '2026-10-10T22:51:00Z', latest: '最新进展',
    digest: '事件综述第一段。\n\n第二段。', digestUpdatedAt: '2026-10-10T23:24:54Z',
    links: { aihot: `https://aihot.news/story/${uuid}` },
    reports: [{ id: itemId, title: '相关报道', summary: '报道摘要', source: { name: '原始报道来源', firstParty: false },
      publishedAt: '2026-10-10T21:00:00Z', links: item.links }],
    storyline: [], related: [],
  },
};
const row = (rank, heat, title = `热点 ${rank}`) => `<li><a href="/story/${uuid.slice(0, -1)}${rank}">
  <span class="num text-rank-${rank}">${rank}</span><span class="line-clamp-1 text-ink">${title}</span>
  <span title="热度指数"><span class="num">${heat}</span> 热度</span><svg aria-label="热度持平"></svg></a></li>`;
const home = `<header>AIHOT站点导航</header><section aria-labelledby="hot-topics"><h2>当前热点</h2><ol>${
  [120, 104, 102, 95, 80].map((heat, i) => row(i + 1, heat)).join('')}</ol></section>
  <script>throw new Error('must never execute');</script>`;
const response = (status = 200, value = home, headers = {}) => ({
  status, ok: status >= 200 && status < 300, headers: new Headers(headers),
  text: async () => value, json: async () => value,
});
const diskCache = t => {
  const dir = mkdtempSync(join(tmpdir(), 'news-feed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'cache.json');
};

test('homepage visible heat is preserved, no invented score or HTML, fixed origin GET and concurrent cache', async () => {
  let time = start;
  let calls = 0;
  let release;
  const news = createNewsFeed({ clock: () => time, fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://aihot.news/');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['User-Agent'], 'aihot-api/2.0.0');
    await new Promise(resolve => { release = resolve; });
    return response(200, home, { ETag: '"hot1"' });
  } });
  const first = news.getHot();
  assert.equal(news.getHot(), first);
  release();
  const fresh = await first;
  assert.deepEqual(fresh.data.items.map(value => value.heat), [120, 104, 102, 95, 80]);
  assert.deepEqual(fresh.data.items.map(value => value.rank), [1, 2, 3, 4, 5]);
  assert.ok(fresh.data.items.every(value => value.detailType === 'story' && value.meta.attribution.name === 'AIHOT'));
  assert.equal(fresh.data.items[0].score, undefined);
  assert.equal(fresh.data.items[0].html, undefined);
  time += TTL - 1;
  assert.deepEqual(await news.getHot(), fresh);
  assert.equal(calls, 1);
});

test('304 reuses validated data and ETag while moving fetchedAt', async () => {
  let time = start;
  let calls = 0;
  const news = createNewsFeed({ clock: () => time, fetch: async (_, options) => {
    if (++calls === 1) return response(200, home, { ETag: '"hot1"' });
    assert.equal(options.headers['If-None-Match'], '"hot1"');
    return response(304);
  } });
  const first = await news.getHot();
  time += TTL;
  const next = await news.getHot();
  assert.equal(next.data, first.data);
  assert.equal(next.fetchedAt, new Date(time).toISOString());
  assert.equal(next.stale, false);
});

test('invalid or missing heat never replaces last good cache, script-only fake section is ignored', async () => {
  for (const bad of [
    home.replace('title="热度指数"', 'title="来源数量"'), home.replace('>120</span>', '>很多</span>'),
    `<script>${home}</script>`, home.replace('text-rank-1">1', 'text-rank-1">7'),
    home.replace(`/story/${uuid.slice(0, -1)}1`, '/story/../../secret'),
  ]) {
    let time = start;
    let calls = 0;
    const news = createNewsFeed({ clock: () => time, fetch: async () => response(200, ++calls === 1 ? home : bad) });
    const first = await news.getHot();
    time += TTL;
    const stale = await news.getHot();
    assert.equal(stale.stale, true);
    assert.equal(stale.data, first.data);
    assert.equal(stale.fetchedAt, first.fetchedAt);
    await news.getHot();
    assert.equal(calls, 2);
  }
});

test('encoded visible title is decoded as text and script code is discarded', async () => {
  const news = createNewsFeed({ fetch: async () => response(200, home.replace('热点 1', 'A &amp; B &#x1f680;<script>evil()</script>')) });
  assert.equal((await news.getHot()).data.items[0].title, 'A & B 🚀');
});

test('Retry-After applies to failures and survives restart without leaking upstream errors', async t => {
  let time = start;
  let calls = 0;
  const cacheFile = diskCache(t);
  const news = createNewsFeed({ cacheFile, clock: () => time, fetch: async () => ++calls === 1 ? response() : response(429, '', { 'Retry-After': '1200' }) });
  await news.getHot();
  time += TTL;
  const stale = await news.getHot();
  assert.equal(stale.stale, true);
  assert.match(stale.error, /频率/);
  const restarted = createNewsFeed({ cacheFile, clock: () => time, fetch: async () => { calls++; return response(); } });
  time += 2 * TTL - 1;
  assert.deepEqual(await restarted.getHot(), stale);
  assert.equal(calls, 2);
  time++;
  assert.equal((await restarted.getHot()).stale, false);
  assert.equal(calls, 3);
});

test('cold forbidden response is explicit, is not bypassed and is cooled down', async () => {
  let calls = 0;
  const news = createNewsFeed({ clock: () => start, fetch: async () => { calls++; return response(403); } });
  await assert.rejects(news.getHot(), { status: 403, retryAt: new Date(start + TTL).toISOString() });
  await assert.rejects(news.getHot(), { status: 403 });
  assert.equal(calls, 1);
});

test('timeout is cooled down and raw network messages never reach output', async () => {
  let calls = 0;
  const news = createNewsFeed({ clock: () => start, timeoutMs: 5, fetch: async (_, { signal }) => {
    calls++;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('AIHOT https://aihot.news secret')), { once: true }));
  } });
  await assert.rejects(news.getHot(), /读取超时/);
  await assert.rejects(news.getHot(), /读取超时/);
  assert.equal(calls, 1);
});

test('illegal id or URL cannot trigger a network request', async () => {
  const news = createNewsFeed({ fetch: async () => assert.fail('no upstream request'), getDailyFeed: async () => assert.fail('no daily request') });
  for (const value of ['https://evil.test/', '../../etc/passwd', `${itemId}?url=bad`, `${uuid}/original`, null, 123]) {
    await assert.rejects(news.getItem(value), { status: 400 });
  }
});

test('ordinary news uses shared daily snapshot, preserves provenance and is explicitly summary-only', async () => {
  const news = createNewsFeed({ fetch: async () => assert.fail('must use shared daily'), getDailyFeed: async () => daily });
  const result = await news.getItem(itemId);
  assert.equal(result.data.item.type, 'summary');
  assert.equal(result.data.item.contentText, null);
  assert.equal(result.data.item.originalText, null);
  for (const key of ['title', 'summary', 'reason', 'score', 'source', 'links', 'attribution']) assert.deepEqual(result.data.item[key], item[key]);
  assert.equal(result.fetchedAt, daily.fetchedAt);
  await assert.rejects(news.getItem('aaaaaaaaaaaaaaaaaaaaaaaaa'), { status: 404 });
});

test('malformed daily fields fail and upstream daily exceptions are translated', async () => {
  const broken = createNewsFeed({ getDailyFeed: async () => ({ ...daily, data: { items: [{ ...item, score: 101 }] } }) });
  await assert.rejects(broken.getItem(itemId), /格式/);
  const failed = createNewsFeed({ getDailyFeed: async () => { throw Object.assign(new Error('AIHOT bad'), { status: 429, retryAt: 'later' }); } });
  await assert.rejects(failed.getItem(itemId), { message: '精选资讯暂时无法读取，请稍后再试。', status: 429, retryAt: 'later' });
});

test('story details use JSON endpoint, retain digest and every report and keep shared cache', async () => {
  let calls = 0;
  const news = createNewsFeed({ fetch: async (url, options) => {
    calls++;
    assert.equal(url, `https://aihot.news/api/v1/stories/${uuid}`);
    assert.equal(options.headers.Accept, 'application/json');
    return response(200, story);
  } });
  const result = await news.getItem(uuid);
  assert.equal(result.data.item.type, 'story');
  assert.equal(result.data.item.contentText, story.story.digest);
  assert.equal(result.data.item.originalText, null);
  assert.deepEqual(result.data.item.reports, story.story.reports);
  assert.deepEqual(result.data.item.sources, story.story.reports);
  assert.equal(result.data.item.meta.canonical, story.story.links.aihot);
  await news.getItem(uuid);
  assert.equal(calls, 1);
});

test('story response with missing reports or wrong identity cannot poison good cache', async () => {
  for (const broken of [{ ...story, story: { ...story.story, reports: null } }, { ...story, story: { ...story.story, publicId: uuid.slice(0, -1) + '1' } }]) {
    let time = start;
    let calls = 0;
    const news = createNewsFeed({ clock: () => time, fetch: async () => response(200, ++calls === 1 ? story : broken) });
    const first = await news.getItem(uuid);
    time += TTL;
    const stale = await news.getItem(uuid);
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.data, first.data);
  }
});

test('withdrawn story clears old snapshot, returns 404 and does not keep serving removed content', async () => {
  let time = start;
  let calls = 0;
  const news = createNewsFeed({ clock: () => time, fetch: async () => ++calls === 1 ? response(200, story) : response(404) });
  await news.getItem(uuid);
  time += TTL;
  await assert.rejects(news.getItem(uuid), { status: 404 });
  await assert.rejects(news.getItem(uuid), { status: 404 });
  assert.equal(calls, 2);
});

test('corrupt persisted cache is ignored and rebuilt from validated source', async t => {
  const cacheFile = diskCache(t);
  writeFileSync(cacheFile, JSON.stringify({ schemaVersion: 1, entries: [['hot', { cache: { data: { items: [] } } }]] }));
  let calls = 0;
  const news = createNewsFeed({ cacheFile, fetch: async () => { calls++; return response(); } });
  assert.equal((await news.getHot()).data.items.length, 5);
  assert.equal(calls, 1);
});

test('non-selected story report opens from shared story cache without calling daily', async () => {
  let calls = 0;
  const news = createNewsFeed({ fetch: async () => { calls++; return response(200, story); },
    getDailyFeed: async () => assert.fail('story reports must not depend on daily availability') });
  await news.getItem(uuid);
  const result = await news.getItem(itemId, uuid);
  const report = story.story.reports[0];
  for (const key of ['title', 'summary', 'source', 'links', 'publishedAt']) assert.deepEqual(result.data.item[key], report[key]);
  for (const key of ['originalTitle', 'reason', 'score', 'category', 'discoveredAt', 'contentText', 'originalText']) assert.equal(result.data.item[key], null);
  assert.equal(result.data.item.type, 'summary');
  assert.equal(result.data.item.meta.storyId, uuid);
  assert.equal(result.data.item.meta.canonical, report.links.aihot);
  assert.equal(calls, 1);
  await assert.rejects(news.getItem('aaaaaaaaaaaaaaaaaaaaaaaaa', uuid), { status: 404 });
});

test('invalid story context cannot request upstream or use daily fallback', async () => {
  const news = createNewsFeed({ fetch: async () => assert.fail('no upstream request'), getDailyFeed: async () => assert.fail('no daily request') });
  for (const value of ['https://evil.test/', '../../secret', itemId, null, 123]) await assert.rejects(news.getItem(itemId, value), { status: 400 });
});

test('withdrawn story report cannot revive old cached article and never falls back to daily', async () => {
  let time = start;
  let calls = 0;
  const news = createNewsFeed({ clock: () => time, fetch: async () => ++calls === 1 ? response(200, story) : response(404),
    getDailyFeed: async () => assert.fail('removed reports must not use daily fallback') });
  await news.getItem(itemId, uuid);
  time += TTL;
  await assert.rejects(news.getItem(itemId, uuid), { status: 404 });
  await assert.rejects(news.getItem(itemId, uuid), { status: 404 });
  assert.equal(calls, 2);
});

test('temporarily unavailable story report retains existing stale snapshot behavior', async () => {
  let time = start;
  let calls = 0;
  const news = createNewsFeed({ clock: () => time, fetch: async () => ++calls === 1 ? response(200, story) : response(503),
    getDailyFeed: async () => assert.fail('cached reports must not depend on daily') });
  const first = await news.getItem(itemId, uuid);
  time += TTL;
  const stale = await news.getItem(itemId, uuid);
  assert.deepEqual(stale.data, first.data);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.equal(stale.stale, true);
});
