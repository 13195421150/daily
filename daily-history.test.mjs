import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDailyHistory, beijingArchiveDay, validArchiveDate } from './daily-history.mjs';

const now = Date.parse('2026-10-11T16:00:00Z');
const day = 24 * 60 * 60 * 1000;
const item = (id, time = now) => ({
  id, selected: true, discoveredAt: new Date(time).toISOString(), title: `资讯 ${id}`,
  source: { name: '原作者' }, links: { original: `https://example.com/${id}`, aihot: `https://aihot.news/items/${id}` },
  attribution: { name: 'AIHOT', url: `https://aihot.news/items/${id}` }, summary: null,
});
const archive = (t, items = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archiveFile = join(dir, 'archive.json');
  writeFileSync(archiveFile, JSON.stringify({ schemaVersion: 1, updatedAt: new Date(now).toISOString(), items }));
  return { archiveFile, history: createDailyHistory({ archiveFile, clock: () => now }) };
};

test('history retains exact 180-day boundary and excludes expired or future discoveries', async t => {
  const { history } = archive(t, [item('old', now - 180 * day - 1), item('boundary', now - 180 * day), item('today'), item('future', now + 1)]);
  const result = await history.read();
  assert.deepEqual(result.items.map(entry => entry.id), ['today', 'boundary']);
  assert.equal(result.retentionDays, 180);
  assert.equal(result.updatedAt, new Date(now).toISOString());
});

test('calendar counts and date filtering use Beijing midnight, with all days retained', async t => {
  const { history } = archive(t, [item('before', now - 1), item('midnight'), item('previous', now - day)]);
  const result = await history.forDate('2026-10-12');
  assert.deepEqual(result.items.map(entry => entry.id), ['midnight']);
  assert.deepEqual(result.days, [{ date: '2026-10-12', count: 1 }, { date: '2026-10-11', count: 2 }]);
  assert.equal(beijingArchiveDay('2026-10-11T15:59:59.999Z'), '2026-10-11');
  assert.equal(beijingArchiveDay('2026-10-11T16:00:00Z'), '2026-10-12');
  assert.equal(beijingArchiveDay('not a date'), null);
});

test('only selected records with valid discovery times appear, preserving IDs and provenance', async t => {
  const original = item('original-id');
  const { history } = archive(t, [original, { ...item('unselected'), selected: false }, { ...item('truthy'), selected: 1 }, { ...item('invalid'), discoveredAt: 'invalid' }, { ...item('absent'), discoveredAt: null }, null]);
  assert.deepEqual((await history.read()).items, [original]);
});

test('forDate rejects malformed dates and invalid calendar dates with status 400', async t => {
  const { history } = archive(t);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-0', '../archive.json', '', null]) {
    assert.equal(validArchiveDate(date), false);
    await assert.rejects(history.forDate(date), error => error.status === 400);
  }
  assert.equal(validArchiveDate('2024-02-29'), true);
  assert.equal(validArchiveDate('2026-10-11'), true);
});

test('missing history returns an empty payload and corrupt history reports a concise site error', async t => {
  const { archiveFile } = archive(t);
  const missing = createDailyHistory({ archiveFile: `${archiveFile}.missing`, clock: () => new Date(now) });
  assert.deepEqual(await missing.read(), { items: [], updatedAt: null, days: [], retentionDays: 180 });
  for (const data of ['{bad json', '{}', '{"schemaVersion":1,"items":null}']) {
    writeFileSync(archiveFile, data);
    await assert.rejects(createDailyHistory({ archiveFile }).read(), { message: '日报历史暂时无法读取，请稍后重试。' });
  }
});
