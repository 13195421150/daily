import { beijingDay } from './monitor-data.js';
const base = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
if (new URLSearchParams(location.search).get('embed') === '1') document.body.classList.add('embedded');
for (const link of document.querySelectorAll('a[href="/monitor"], a[href="/daily"]')) link.href = `${base}${link.getAttribute('href')}`;

const $ = id => document.getElementById(id);
const categories = { 'ai-models': '模型', 'ai-products': '产品', industry: '行业', paper: '论文', tip: '教程', opinion: '观点' };
let items = [];
let historyDays = null;
let category = 'all';
let loaded = false;
let busy = false;
let loadRequest = 0;
let retryAt = 0;
let retryTimer;
let selectedDay = null;
let calendarMonth = beijingDay(new Date().toISOString()).slice(0, 7);
const collapsedDays = new Set();
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const safeLink = value => {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.+$/, '');
    return url.protocol === 'https:' && !url.username && !url.password && host !== 'aihot.news' && !host.endsWith('.aihot.news') ? url.href : null;
  } catch { return null; }
};
const detailLink = (label, id) => {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/i.test(id)) return null;
  const link = node('a', '', label);
  link.href = `${base}/news/${encodeURIComponent(id)}${document.body.classList.contains('embedded') ? '?embed=1' : ''}`;
  return link;
};
const sourceLink = (text, value) => {
  const href = safeLink(value);
  if (!href) return null;
  const el = node('a', '', text);
  el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer';
  return el;
};
const itemTime = item => item.discoveredAt || item.publishedAt;
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

function updateDate() {
  const day = selectedDay || beijingDay(new Date().toISOString());
  $('today-label').textContent = `${day.slice(0, 4)} · 北京时间`;
  $('today-date').textContent = day.slice(5).replace('-', '.');
  $('today-weekday').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(new Date(`${day}T12:00:00+08:00`));
}

function renderCalendar() {
  const [year, month] = calendarMonth.split('-').map(Number);
  $('daily-month-label').textContent = `${year} 年 ${month} 月`;
  $('daily-all-dates').setAttribute('aria-pressed', String(selectedDay === null));
  const counts = new Map();
  if (historyDays) {
    for (const { date, count } of historyDays) counts.set(date, count);
  } else {
    for (const item of items) {
      const day = beijingDay(itemTime(item));
      counts.set(day, (counts.get(day) || 0) + 1);
    }
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < (first.getUTCDay() + 6) % 7; i++) fragment.append(node('span'));
  for (let d = 1; d <= days; d++) {
    const day = `${calendarMonth}-${String(d).padStart(2, '0')}`;
    const count = counts.get(day) || 0;
    const button = node('button', `${count ? 'daily-has-news ' : ''}${day === selectedDay ? 'selected' : ''}`, String(d));
    button.type = 'button'; button.disabled = !count;
    button.setAttribute('aria-pressed', String(day === selectedDay));
    button.setAttribute('aria-label', `${year}年${month}月${d}日，${count ? `${count}条精选` : '暂无已保存精选'}`);
    if (count) button.append(node('span', 'daily-day-count', `${count} 条`));
    button.addEventListener('click', () => selectDay(day));
    fragment.append(button);
  }
  $('daily-calendar-grid').replaceChildren(fragment);
}

function renderItem(item) {
  const row = node('article', 'daily-item');
  const timestamp = node('time', 'daily-time', time(itemTime(item)));
  timestamp.dateTime = itemTime(item);
  const card = node('div', 'daily-article');
  const meta = node('div', 'daily-article-meta');
  meta.append(node('span', '', item.source?.name || '公开来源'));
  if (categories[item.category]) meta.append(node('span', 'daily-category', categories[item.category]));
  if (Number.isFinite(item.score)) meta.append(node('span', 'daily-score', `AI 评分 ${item.score}`));
  const heading = node('h4');
  heading.append(detailLink(item.title || item.originalTitle || '精选动态', item.id) || node('span', '', item.title || item.originalTitle || '精选动态'));
  card.append(meta, heading);
  if (item.summary) card.append(node('p', 'daily-summary', item.summary));
  if (item.reason) {
    const reason = node('p', 'daily-reason');
    reason.append(node('strong', '', '推荐理由：'), document.createTextNode(item.reason));
    card.append(reason);
  }
  const links = node('div', 'daily-links');
  const detail = detailLink('查看详情 →', item.id);
  const original = sourceLink('阅读原文 ↗', item.links?.original);
  if (detail) links.append(detail);
  if (original) links.append(original);
  if (links.childElementCount) card.append(links);
  row.append(timestamp, card);
  return row;
}

function render() {
  const query = $('daily-search').value.trim().toLocaleLowerCase();
  const visible = items.filter(item => (!selectedDay || beijingDay(itemTime(item)) === selectedDay) && (category === 'all' || item.category === category) && (!query || `${item.title || ''} ${item.summary || ''} ${item.source?.name || ''}`.toLocaleLowerCase().includes(query)));
  $('daily-count').textContent = loaded ? `显示 ${visible.length} 条 · ${selectedDay || `近 7 日最新 ${items.length} 条`}` : '正在读取精选内容…';
  for (const button of document.querySelectorAll('[data-category]')) button.setAttribute('aria-pressed', String(button.dataset.category === category));
  const groups = new Map();
  for (const item of visible) {
    const day = beijingDay(itemTime(item));
    if (!day) continue;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(item);
  }
  const fragment = document.createDocumentFragment();
  for (const [day, entries] of groups) {
    const section = node('details', 'daily-day');
    section.open = !collapsedDays.has(day);
    const header = node('summary', 'daily-day-header');
    const date = new Date(`${day}T12:00:00+08:00`);
    const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(date);
    const label = `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
    const toggleLabel = node('span', 'daily-day-toggle');
    toggleLabel.setAttribute('aria-hidden', 'true');
    toggleLabel.innerHTML = '<svg viewBox="0 0 16 16"><path d="m3 6 5 5 5-5"/></svg>';
    header.append(node('h3', '', label), toggleLabel, node('span', '', `${weekday} · ${entries.length} 条`));
    header.setAttribute('aria-label', `${section.open ? '收起' : '展开'}${label}的精选`);
    section.addEventListener('toggle', () => {
      if (section.open) collapsedDays.delete(day); else collapsedDays.add(day);
      header.setAttribute('aria-label', `${section.open ? '收起' : '展开'}${label}的精选`);
    });
    const list = node('div', 'daily-items');
    for (const item of entries) list.append(renderItem(item));
    section.append(header, list);
    fragment.append(section);
  }
  if (!groups.size) {
    const empty = node('div', 'daily-empty');
    empty.append(node('strong', '', loaded ? '暂时没有匹配的精选' : '精选内容尚未载入'), node('span', '', loaded ? selectedDay ? '当天没有符合当前筛选的已保存精选，试试其他分类或关键词。' : '试试其他分类或关键词。' : '连接恢复后会自动加载。'));
    fragment.append(empty);
  }
  $('daily-content').replaceChildren(fragment);
}

function selectDay(day) {
  selectedDay = day; items = []; loaded = false;
  updateDate(); renderCalendar(); render(); load(true);
}

async function load(force = false) {
  if (!force && (busy || Date.now() < retryAt)) return;
  const request = ++loadRequest;
  busy = true;
  clearTimeout(retryTimer);
  $('daily-content').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`${base}/api/daily${selectedDay ? `?date=${selectedDay}` : ''}`, { cache: 'no-store' });
    const result = await response.json();
    if (request !== loadRequest) return;
    if (!response.ok) {
      retryAt = Date.parse(result.retryAt) || Date.now() + 600_000;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => load(), Math.max(1000, retryAt - Date.now() + 250));
      throw new Error(result.error || '精选内容暂时无法读取，请稍后再试。');
    }
    if (!Array.isArray(result.data?.items)) throw new Error('精选数据格式暂时无法识别。');
    items = result.data.items.filter(item => item && item.selected === true && beijingDay(itemTime(item))).sort((a, b) => Date.parse(itemTime(b)) - Date.parse(itemTime(a)));
    historyDays = Array.isArray(result.history?.days) ? result.history.days : null;
    loaded = true; retryAt = 0; clearTimeout(retryTimer);
    $('daily-message').hidden = !result.stale;
    $('daily-message').textContent = result.stale ? '暂时无法获取更新，目前显示上次成功读取的精选。' : '';
    $('daily-freshness').textContent = `更新于 ${beijingDay(result.fetchedAt)} ${time(result.fetchedAt)}`;
    renderCalendar(); render();
  } catch (error) {
    if (request !== loadRequest) return;
    $('daily-message').hidden = false;
    $('daily-message').textContent = error.message;
    if (!loaded) $('daily-content').replaceChildren(node('div', 'daily-empty', '精选内容暂未载入，页面会自动重试。'));
  } finally {
    if (request === loadRequest) { busy = false; $('daily-content').setAttribute('aria-busy', 'false'); }
  }
}

let hotBusy = false;
let hotRetryAt = 0;
async function loadHot() {
  if (hotBusy || Date.now() < hotRetryAt) return;
  hotBusy = true;
  try {
    const response = await fetch(`${base}/api/hot`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) {
      hotRetryAt = Date.parse(result.retryAt) || Date.now() + 600_000;
      throw new Error(result.error || '热点暂时无法更新。');
    }
    if (!Array.isArray(result.data?.items)) throw new Error('热点数据暂时无法识别。');
    const fragment = document.createDocumentFragment();
    for (const item of result.data.items) {
      const link = detailLink('', item.id);
      if (!link || !Number.isFinite(item.heat)) continue;
      const row = node('li');
      const title = node('span', 'daily-hot-title', item.title);
      title.title = item.title;
      const heat = node('span', 'daily-hot-heat');
      heat.append(node('strong', '', String(item.heat)), node('span', '', '热度'));
      link.append(node('span', 'daily-hot-rank', String(item.rank)), title, heat);
      row.append(link); fragment.append(row);
    }
    if (!fragment.childElementCount) throw new Error('暂时没有可显示的热点。');
    $('hot-items').replaceChildren(fragment);
    $('hot-freshness').textContent = result.stale ? '暂未更新 · 上次热度' : `更新于 ${time(result.fetchedAt)}`;
    hotRetryAt = 0;
  } catch (error) {
    $('hot-freshness').textContent = '稍后自动重试';
    if (!$('hot-items').querySelector('a')) $('hot-items').replaceChildren(node('li', 'daily-hot-empty', error.message));
  } finally { hotBusy = false; }
}

for (const button of document.querySelectorAll('[data-category]')) button.addEventListener('click', () => { category = button.dataset.category; render(); });
$('daily-search').addEventListener('input', render);
for (const [id, offset] of [['daily-prev-month', -1], ['daily-next-month', 1]]) $(id).addEventListener('click', () => {
  const [year, month] = calendarMonth.split('-').map(Number);
  calendarMonth = new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
  renderCalendar();
});
$('daily-current-month').addEventListener('click', () => { calendarMonth = beijingDay(new Date().toISOString()).slice(0, 7); renderCalendar(); });
$('daily-all-dates').addEventListener('click', () => selectDay(null));
updateDate(); renderCalendar(); load(); loadHot();
setInterval(() => { if (!document.hidden) { updateDate(); load(); loadHot(); } }, 600_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateDate(); });
