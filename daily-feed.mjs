import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createDailyArchive } from './daily-archive.mjs';

const SOURCE = 'https://aihot.news/api/v1/items?mode=selected&window=7d&by=timeline&limit=100';
const CACHE_MS = 10 * 60 * 1000;
const nullableString = value => value === null || typeof value === 'string';
const validTime = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
const validData = data => data?.schemaVersion === 1 && data.query?.mode === 'selected' &&
  data.query?.window === '7d' && data.query?.by === 'timeline' &&
  typeof data.page?.hasMore === 'boolean' && Array.isArray(data.items) && data.items.every(item =>
    item && typeof item.id === 'string' && typeof item.title === 'string' && item.selected === true &&
    nullableString(item.summary) && nullableString(item.category) && nullableString(item.reason) &&
    typeof item.source?.name === 'string' && typeof item.links?.aihot === 'string' && typeof item.links?.original === 'string' &&
    typeof item.discoveredAt === 'string' && Number.isFinite(Date.parse(item.discoveredAt)) &&
    (item.publishedAt === null || (typeof item.publishedAt === 'string' && Number.isFinite(Date.parse(item.publishedAt)))));

export function createDailyFeed({ fetch: fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 20_000, cacheFile, archiveFile } = {}) {
  let cache;
  let cachedAt = 0;
  let etag;
  let inFlight;
  let nextRequestAt = 0;
  let lastError;
  const archive = archiveFile ? createDailyArchive({ archiveFile, clock }) : null;
  const saveArchive = () => {
    if (!archive || !cache) return;
    try { archive(cache.data); }
    catch (error) { console.warn('AI日报归档保存失败:', error.message); }
  };
  if (cacheFile) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (!saved || !validTime(saved.cachedAt) || !validTime(saved.nextRequestAt) ||
          (saved.cache !== undefined && (!validData(saved.cache?.data) || typeof saved.cache.fetchedAt !== 'string' || !Number.isFinite(Date.parse(saved.cache.fetchedAt)))) ||
          (saved.etag != null && typeof saved.etag !== 'string') ||
          (saved.error != null && typeof saved.error !== 'string') ||
          (saved.errorStatus != null && !Number.isInteger(saved.errorStatus))) throw new Error('AI日报缓存格式无效');
      cache = saved.cache;
      cachedAt = saved.cachedAt;
      etag = saved.etag;
      nextRequestAt = saved.nextRequestAt;
      if (saved.error) {
        lastError = new Error(saved.error);
        lastError.retryAt = new Date(nextRequestAt).toISOString();
        if (saved.errorStatus != null) lastError.status = saved.errorStatus;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('AI日报缓存读取失败:', error.message);
    }
  }
  saveArchive();
  const persist = () => {
    if (!cacheFile) return;
    try {
      writeFileSync(`${cacheFile}.tmp`, JSON.stringify({ cache, cachedAt, etag, nextRequestAt, error: lastError?.message, errorStatus: lastError?.status }));
      renameSync(`${cacheFile}.tmp`, cacheFile);
    } catch (error) {
      console.warn('AI日报缓存保存失败:', error.message);
    }
  };
  const result = (stale, error) => ({
    data: cache.data, stale, fetchedAt: cache.fetchedAt,
    ...(error ? { error } : {}),
  });

  const refresh = async () => {
    nextRequestAt = clock() + CACHE_MS;
    persist();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('AIHOT 请求超时')), timeoutMs);
    try {
      const headers = { 'User-Agent': 'aihot-api/2.0.0', Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = etag;
      const response = await fetchImpl(SOURCE, { method: 'GET', headers, signal: controller.signal });
      if ([429, 503].includes(response.status)) {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null && retryAfter.trim()) {
          const seconds = Number(retryAfter);
          const until = Number.isFinite(seconds) && seconds >= 0
            ? clock() + seconds * 1000 : Date.parse(retryAfter);
          if (validTime(until)) nextRequestAt = Math.max(nextRequestAt, until);
        }
      }
      if (response.status === 304) {
        if (!cache) throw new Error('AIHOT 返回 304，但没有可用日报缓存');
        etag = response.headers.get('etag') || etag;
      } else {
        if (!response.ok) throw Object.assign(new Error(`AIHOT 请求失败（HTTP ${response.status}）`), { status: response.status });
        const data = await response.json();
        if (!validData(data)) throw new Error('AIHOT 精选数据格式无效');
        cache = { data };
        etag = response.headers.get('etag');
      }
      cachedAt = clock();
      cache.fetchedAt = new Date(cachedAt).toISOString();
      lastError = undefined;
      persist();
      saveArchive();
      return result(false);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastError.retryAt = new Date(nextRequestAt).toISOString();
      persist();
      if (cache) return result(true, lastError.message);
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  };

  return function getDailyFeed() {
    if (inFlight) return inFlight;
    const now = clock();
    if (cache && now - cachedAt < CACHE_MS) return Promise.resolve(result(false));
    if (now < nextRequestAt) {
      if (!lastError) lastError = Object.assign(new Error('AIHOT 请求冷却中，请稍后重试'), { retryAt: new Date(nextRequestAt).toISOString() });
      return cache ? Promise.resolve(result(true, lastError.message)) : Promise.reject(lastError);
    }
    inFlight = refresh().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
