import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createDailyFeed } from './daily-feed.mjs';

const ORIGIN = 'https://aihot.news';
const CACHE_MS = 10 * 60 * 1000;
const ITEM_ID = /^[a-z0-9]{20,40}$/;
const STORY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validTime = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableText = value => value === null || typeof value === 'string';
const count = value => Number.isInteger(value) && value >= 0;
const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const decode = value => value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  if (entity[0] !== '#') return named[entity.toLowerCase()];
  const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '\ufffd';
});
const visible = value => value.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
const text = value => decode(visible(value).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '')).trim();

function parseHot(html) {
  // Only the server-rendered, visible ranking is read; scripts are never evaluated.
  const section = visible(html).match(/<section\b[^>]*aria-labelledby="hot-topics"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  if (!section) throw fail('当前热点数据格式已变化，请稍后再试。');
  const rows = [...section.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)];
  const items = rows.map(([, row]) => {
    const path = row.match(/<a\b[^>]*href="(\/(?:story|items)\/[^"?#]+)"/)?.[1];
    const rankText = text(row.match(/<span\b[^>]*class="[^"]*\bnum\b[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    const title = text(row.match(/<span\b[^>]*class="[^"]*\bline-clamp-1\b[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    const heatText = text(row.match(/title="热度指数"[^>]*>\s*<span\b[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    const id = path?.split('/').pop();
    const detailType = path?.startsWith('/story/') ? 'story' : 'news';
    if (!id || !(detailType === 'story' ? STORY_ID : ITEM_ID).test(id) || !/^\d+$/.test(rankText) ||
        !/^\d+(?:\.\d+)?$/.test(heatText) || !title) throw fail('当前热点数据格式已变化，请稍后再试。');
    const trend = row.match(/aria-label="热度(上升|回落|持平)"/)?.[1] || null;
    return { id, rank: Number(rankText), title, heat: Number(heatText), trend, detailType,
      meta: { canonical: `${ORIGIN}${path}`, attribution: { name: 'AIHOT', url: ORIGIN } } };
  });
  const data = { schemaVersion: 1, count: items.length, items };
  if (!validHot(data)) throw fail('当前热点数据格式已变化，请稍后再试。');
  return data;
}

const validHot = data => data?.schemaVersion === 1 && Array.isArray(data.items) && data.items.length > 0 &&
  data.items.length <= 5 && data.count === data.items.length && data.items.every((item, i) =>
    item && item.rank === i + 1 && typeof item.title === 'string' && item.title.length > 0 &&
    Number.isFinite(item.heat) && item.heat >= 0 && (item.detailType === 'story' ? STORY_ID : ITEM_ID).test(item.id));

const validStory = data => data?.schemaVersion === 1 && STORY_ID.test(data.story?.publicId) &&
  typeof data.story?.title === 'string' && ['active', 'settled'].includes(data.story.status) &&
  nullableText(data.story.digest) && typeof data.story.latest === 'string' &&
  typeof data.story.links?.aihot === 'string' && (data.story.digestUpdatedAt === null || timestamp(data.story.digestUpdatedAt)) &&
  count(data.story.sourceCount) && count(data.story.reportCount) && timestamp(data.story.firstReportAt) &&
  timestamp(data.story.latestAt) && Array.isArray(data.story.reports) && data.story.reports.every(item =>
    ITEM_ID.test(item?.id) && typeof item.title === 'string' && nullableText(item.summary) &&
    typeof item.source?.name === 'string' && typeof item.source.firstParty === 'boolean' &&
    timestamp(item.publishedAt) && typeof item.links?.aihot === 'string') &&
  ['storyline', 'related'].every(key => Array.isArray(data.story[key]) && data.story[key].every(item =>
    STORY_ID.test(item?.publicId) && typeof item.title === 'string' && typeof item.relation === 'string'));

const validItem = item => ITEM_ID.test(item?.id) && typeof item.title === 'string' && nullableText(item.summary) &&
  nullableText(item.originalTitle) && nullableText(item.reason) && nullableText(item.category) &&
  (item.score === null || (Number.isFinite(item.score) && item.score >= 0 && item.score <= 100)) &&
  typeof item.source?.name === 'string' && typeof item.links?.original === 'string' &&
  typeof item.links?.aihot === 'string' && timestamp(item.discoveredAt) &&
  (item.publishedAt === null || timestamp(item.publishedAt));

export function createNewsFeed({ fetch: fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 20_000, cacheFile, getDailyFeed } = {}) {
  const entries = new Map();
  const pending = new Map();
  const daily = getDailyFeed || createDailyFeed({ fetch: fetchImpl, clock, timeoutMs });
  const validate = (key, data) => key === 'hot' ? validHot(data) : validStory(data) && data.story.publicId === key.slice(6);
  if (cacheFile) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.entries)) throw fail('资讯缓存格式无效');
      for (const [key, entry] of saved.entries) {
        if ((key !== 'hot' && !/^story:[a-f\d-]+$/i.test(key)) || !validTime(entry.cachedAt) || !validTime(entry.nextRequestAt) ||
            (entry.cache && (!validate(key, entry.cache.data) || !timestamp(entry.cache.fetchedAt))) ||
            (entry.etag != null && typeof entry.etag !== 'string') || (entry.error != null && typeof entry.error !== 'string') ||
            (entry.status != null && !Number.isInteger(entry.status))) throw fail('资讯缓存格式无效');
      }
      for (const [key, entry] of saved.entries) entries.set(key, entry);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('资讯缓存读取失败:', error.message);
    }
  }
  const persist = () => {
    if (!cacheFile) return;
    try {
      writeFileSync(`${cacheFile}.tmp`, JSON.stringify({ schemaVersion: 1, entries: [...entries] }));
      renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch (error) { console.warn('资讯缓存保存失败:', error.message); }
  };
  const result = (entry, stale) => ({ ...entry.cache, stale, ...(stale && entry.error ? { error: entry.error } : {}) });
  const cachedError = entry => Object.assign(fail(entry.error || '资讯暂时无法读取，请稍后再试。', entry.status || 503),
    { retryAt: new Date(entry.nextRequestAt).toISOString() });

  function get(key, path, parser) {
    if (pending.has(key)) return pending.get(key);
    const entry = entries.get(key) || { cachedAt: 0, nextRequestAt: 0 };
    entries.set(key, entry);
    if (entry.cache && clock() - entry.cachedAt < CACHE_MS) return Promise.resolve(result(entry, false));
    if (clock() < entry.nextRequestAt) return entry.cache ? Promise.resolve(result(entry, true)) : Promise.reject(cachedError(entry));
    entry.nextRequestAt = clock() + CACHE_MS;
    persist();
    const request = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = { 'User-Agent': 'aihot-api/2.0.0', Accept: key === 'hot' ? 'text/html' : 'application/json' };
        if (entry.etag) headers['If-None-Match'] = entry.etag;
        const response = await fetchImpl(`${ORIGIN}${path}`, { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
        if ([429, 503].includes(response.status)) {
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter?.trim()) {
            const seconds = Number(retryAfter);
            const until = Number.isFinite(seconds) && seconds >= 0 ? clock() + seconds * 1000 : Date.parse(retryAfter);
            if (validTime(until)) entry.nextRequestAt = Math.max(entry.nextRequestAt, until);
          }
        }
        if (response.status === 304) {
          if (!entry.cache) throw fail('资讯暂时没有可用缓存，请稍后再试。');
        } else {
          if (response.status === 404) {
            delete entry.cache;
            delete entry.etag;
            throw fail('该资讯不存在或已撤下。', 404);
          }
          if (!response.ok) throw fail(response.status === 429 ? '资讯请求频率受限，请稍后再试。' : '资讯暂时无法读取，请稍后再试。', response.status);
          const data = parser ? parser(await response.text()) : await response.json();
          if (!validate(key, data)) throw fail('资讯数据格式已变化，请稍后再试。');
          entry.cache = { data };
        }
        entry.etag = response.headers.get('etag') || entry.etag;
        entry.cachedAt = clock();
        entry.cache.fetchedAt = new Date(entry.cachedAt).toISOString();
        delete entry.error;
        delete entry.status;
        persist();
        return result(entry, false);
      } catch (error) {
        entry.error = error.status ? error.message : controller.signal.aborted ? '资讯读取超时，请稍后再试。' : '资讯暂时无法读取，请稍后再试。';
        entry.status = error.status || 503;
        persist();
        if (entry.cache) return result(entry, true);
        throw cachedError(entry);
      } finally { clearTimeout(timer); }
    })().finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  const api = {
    getHot: () => get('hot', '/', parseHot),
    async getItem(id, storyId) {
      if (typeof id !== 'string' || (!ITEM_ID.test(id) && !STORY_ID.test(id))) throw fail('资讯编号无效。', 400);
      if (storyId !== undefined && (typeof storyId !== 'string' || !STORY_ID.test(storyId))) throw fail('事件编号无效。', 400);
      if (STORY_ID.test(id)) {
        const response = await get(`story:${id}`, `/api/v1/stories/${id}`);
        const story = response.data.story;
        const relatedItems = [...story.storyline, ...story.related].map(item => ({ ...item, id: item.publicId, detailType: 'story' }));
        return { ...response, data: { schemaVersion: 1, item: { ...story, id, type: 'story', summary: story.digest,
          contentText: story.digest, originalTitle: null, originalText: null, relatedItems, sources: story.reports,
          meta: { canonical: story.links.aihot, attribution: { name: 'AIHOT', url: ORIGIN } } } } };
      }
      if (storyId !== undefined) {
        const response = await api.getItem(storyId);
        const item = response.data.item.reports.find(value => value.id === id);
        if (!item) throw fail('该资讯不存在或已撤下。', 404);
        return { ...response, data: { schemaVersion: 1, item: { ...item, type: 'summary',
          originalTitle: null, reason: null, score: null, category: null, discoveredAt: null,
          contentText: null, originalText: null, sources: [{ name: item.source.name, url: item.links.original || null }],
          meta: { canonical: item.links.aihot, attribution: item.attribution || { name: 'AIHOT', url: item.links.aihot }, storyId } } } };
      }
      let response;
      try { response = await daily(); }
      catch (error) { throw Object.assign(fail('精选资讯暂时无法读取，请稍后再试。', error.status || 503), { retryAt: error.retryAt }); }
      const item = response.data?.items?.find(value => value.id === id);
      if (!item) throw fail('该资讯不存在或已撤下。', 404);
      if (!validItem(item)) throw fail('资讯数据格式已变化，请稍后再试。');
      return { ...response, ...(response.error ? { error: '资讯暂时无法更新，正在显示已保存内容。' } : {}),
        data: { schemaVersion: 1, item: { ...item, type: 'summary', contentText: null, originalText: null,
          sources: [{ name: item.source.name, url: item.links.original }],
          meta: { canonical: item.links.aihot, attribution: item.attribution || { name: 'AIHOT', url: ORIGIN } } } } };
    },
  };
  return api;
}
