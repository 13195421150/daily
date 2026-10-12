import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDailyFeed } from './daily-feed.mjs';
import { createNewsFeed } from './news-feed.mjs';
import { createDailyHistory, beijingArchiveDay, validArchiveDate } from './daily-history.mjs';

const root = dirname(fileURLToPath(import.meta.url));

export async function createApp(dataDir = process.env.DATA_DIR || join(root, 'data'), { newsFeed, dailyFeed } = {}) {
  await mkdir(dataDir, { recursive: true });
  const archiveFile = join(dataDir, 'daily-archive.json');
  const getRecentDaily = dailyFeed || createDailyFeed({ cacheFile: join(dataDir, 'daily-feed.json'), archiveFile });
  const dailyHistory = createDailyHistory({ archiveFile });
  const readHistory = async () => {
    try { return await dailyHistory.read(); }
    catch (error) { console.warn(error.message); return null; }
  };
  const historyMetadata = history => ({ retentionDays: 180, days: history?.days || [] });
  const storedDaily = (history, stale = false) => ({
    data: { schemaVersion: 1, items: history.items, page: { count: history.items.length, hasMore: false, nextCursor: null } },
    fetchedAt: history.updatedAt, stale, history: historyMetadata(history),
    ...(stale ? { error: '精选内容暂时无法更新，正在显示已保存内容。' } : {}),
  });
  const getDaily = async (merge = false) => {
    let recent, failure;
    try { recent = await getRecentDaily(); } catch (error) { failure = error; }
    const history = await readHistory();
    if (!recent) {
      if (history?.items.length) return storedDaily(history, true);
      throw failure;
    }
    const items = merge ? [...new Map([...(history?.items || []), ...recent.data.items].map(item => [item.id, item])).values()] : recent.data.items;
    return { ...recent, data: { ...recent.data, items }, history: historyMetadata(history) };
  };
  const news = newsFeed || createNewsFeed({ cacheFile: join(dataDir, 'news-feed.json'), getDailyFeed: () => getDaily(true) });
  const send = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/hot' || /^\/api\/news\/[^/]+$/.test(url.pathname)) {
        if (req.method !== 'GET') return send(res, 405, { error: '请求方式不支持' });
        try {
          const result = url.pathname === '/api/hot' ? await news.getHot() : await news.getItem(url.pathname.slice('/api/news/'.length), url.searchParams.get('story') || undefined);
          return send(res, 200, result);
        } catch (error) {
          const code = [400, 404, 429].includes(error.status) ? error.status : 503;
          return send(res, code, { error: code === 404 ? '该资讯不存在或已撤下。' : code === 400 ? '资讯编号无效。' : code === 429 ? '资讯更新频率受限，请稍后重试。' : '资讯暂时无法读取，请稍后重试。', retryAt: error.retryAt });
        }
      }
      if (url.pathname === '/api/daily') {
        if (req.method !== 'GET') return send(res, 405, { error: '请求方式不支持' });
        const date = url.searchParams.get('date');
        if (date !== null && !validArchiveDate(date)) return send(res, 400, { error: '请选择有效的日报日期。' });
        try {
          if (date === null) return send(res, 200, await getDaily());
          const history = await readHistory();
          if (history) return send(res, 200, storedDaily({ ...history, items: history.items.filter(item => beijingArchiveDay(item.discoveredAt) === date) }));
          const recent = await getDaily();
          return send(res, 200, { ...recent, data: { ...recent.data, items: recent.data.items.filter(item => beijingArchiveDay(item.discoveredAt) === date) } });
        } catch (error) { return send(res, 503, { error: error.status === 429 ? '精选数据请求频率受限，页面会自动重试。' : '精选内容暂时无法读取，请稍后再试。', retryAt: error.retryAt }); }
      }
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(302, { Location: '/daily', 'Cache-Control': 'no-store' });
        return res.end();
      }
      const files = { '/monitor.css': 'monitor.css', '/monitor-data.js': 'monitor-data.js', '/smartkey-cat-loop.gif': 'smartkey-cat-loop.gif', '/daily': 'daily.html', '/daily.css': 'daily.css', '/daily.js': 'daily.js', '/news.css': 'news.css', '/news.js': 'news.js' };
      if (/^\/news\/[a-z0-9-]+$/i.test(url.pathname)) files[url.pathname] = 'news.html';
      if (!files[url.pathname] || req.method !== 'GET') return send(res, 404, { error: '页面不存在' });
      const ext = files[url.pathname].split('.').pop();
      const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', gif: 'image/gif' };
      res.writeHead(200, { 'Content-Type': `${types[ext]}${ext === 'gif' ? '' : '; charset=utf-8'}`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(await readFile(join(root, 'public', files[url.pathname])));
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, { error: '保存失败，请重试' });
      else res.end();
    }
  });
}

export function startFeedCollection(server, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const collect = () => Promise.allSettled(['/api/daily', '/api/hot'].map(async path => {
    const response = await fetchImpl(`${origin}${path}`, { signal: AbortSignal.timeout(25_000), redirect: 'error' });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`日报定时采集暂未完成（HTTP ${response.status}）。`);
  })).then(results => { for (const result of results) if (result.status === 'rejected') console.warn(result.reason.message); });
  const interval = setInterval(collect, 600_000);
  server.once('close', () => clearInterval(interval));
  void collect();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  const port = Number(process.env.PORT || 4319);
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    startFeedCollection(server);
    console.log(`AI 日报已启动，端口 ${port}，首页 /daily`);
  });
}
