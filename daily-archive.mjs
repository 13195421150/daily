import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export function createDailyArchive({ archiveFile, clock = Date.now }) {
  let items;
  return function archiveDaily(data) {
    if (!items) {
      try {
        const saved = JSON.parse(readFileSync(archiveFile, 'utf8'));
        if (saved.schemaVersion !== 1 || !Array.isArray(saved.items)) throw new Error('AI日报归档格式无效');
        items = new Map(saved.items.map(item => [item.id, item]));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        items = new Map();
      }
    }
    for (const item of data.items) items.set(item.id, item);
    const now = clock();
    for (const [id, item] of items) {
      if (Date.parse(item.discoveredAt) < now - RETENTION_MS) items.delete(id);
    }
    const archive = {
      schemaVersion: 1, retentionDays: 180,
      updatedAt: new Date(now).toISOString(), items: [...items.values()],
    };
    writeFileSync(`${archiveFile}.tmp`, JSON.stringify(archive));
    renameSync(`${archiveFile}.tmp`, archiveFile);
  };
}
