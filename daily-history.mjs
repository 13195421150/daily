import { readFile } from 'node:fs/promises';

const RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export function validArchiveDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

export function beijingArchiveDay(timestamp) {
  const milliseconds = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function createDailyHistory({ archiveFile, clock = Date.now }) {
  async function read() {
    let saved;
    try {
      saved = JSON.parse(await readFile(archiveFile, 'utf8'));
      if (saved?.schemaVersion !== 1 || !Array.isArray(saved.items)) throw new Error();
    } catch (error) {
      if (error.code === 'ENOENT') return { items: [], updatedAt: null, days: [], retentionDays: RETENTION_DAYS };
      throw new Error('日报历史暂时无法读取，请稍后重试。');
    }
    const now = Number(clock());
    const items = saved.items.filter(item => {
      const discoveredAt = typeof item?.discoveredAt === 'string' ? Date.parse(item.discoveredAt) : NaN;
      return item?.selected === true && Number.isFinite(discoveredAt) && discoveredAt >= now - RETENTION_DAYS * DAY_MS && discoveredAt <= now;
    }).sort((a, b) => Date.parse(b.discoveredAt) - Date.parse(a.discoveredAt));
    const counts = new Map();
    for (const item of items) {
      const date = beijingArchiveDay(item.discoveredAt);
      counts.set(date, (counts.get(date) || 0) + 1);
    }
    return {
      items, updatedAt: saved.updatedAt ?? null, retentionDays: RETENTION_DAYS,
      days: [...counts].sort(([a], [b]) => b.localeCompare(a)).map(([date, count]) => ({ date, count })),
    };
  }

  async function forDate(date) {
    if (!validArchiveDate(date)) throw Object.assign(new Error('请选择有效的日报日期。'), { status: 400 });
    const history = await read();
    return { ...history, items: history.items.filter(item => beijingArchiveDay(item.discoveredAt) === date) };
  }

  return { read, forDate };
}
