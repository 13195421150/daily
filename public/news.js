const base = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const $ = id => document.getElementById(id);
const embedded = new URLSearchParams(location.search).get('embed') === '1';
const storyContext = new URLSearchParams(location.search).get('story');
const itemId = location.pathname.split('/').filter(Boolean).at(-1);
const validStory = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || '');
const validId = value => /^[a-z0-9]{20,40}$/.test(value || '') || validStory(value);
const categories = { 'ai-models': '模型', 'ai-products': '产品', industry: '行业', paper: '论文', tip: '教程', opinion: '观点' };
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const localPath = (path, story) => {
  const query = new URLSearchParams();
  if (validStory(story)) query.set('story', story);
  if (embedded) query.set('embed', '1');
  return `${base}${path}${query.size ? `?${query}` : ''}`;
};
const localNews = (id, story) => validId(id) ? localPath(`/news/${id}`, story) : null;
const sourceName = value => value && !/aihot/i.test(value) ? value : '公开来源';
const dateTime = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value)) : null;
const safeOriginal = value => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return url.protocol === 'https:' && !url.username && !url.password && host !== 'aihot.news' && !host.endsWith('.aihot.news') ? url.href : null;
  } catch { return null; }
};
const externalLink = (label, value, className) => {
  const href = safeOriginal(value);
  if (!href) return null;
  const link = node('a', className, label);
  link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
};
const paragraphs = text => {
  const copy = node('div', 'news-copy');
  for (const paragraph of String(text || '').split(/\n\s*\n/).filter(value => value.trim())) copy.append(node('p', '', paragraph.trim()));
  return copy;
};
const section = (heading, text) => {
  const block = node('section', 'news-section');
  block.append(node('h2', '', heading), paragraphs(text));
  return block;
};
const sideSection = (heading, list) => {
  const block = node('section', 'news-side-section');
  block.append(node('h2', '', heading), list);
  return block;
};

if (embedded) document.body.classList.add('embedded');
for (const link of document.querySelectorAll(`a[href="/monitor"], a[href="/daily"], a[href="${base}/monitor"], a[href="${base}/daily"]`)) {
  const path = link.getAttribute('href');
  link.href = localPath(base && path.startsWith(`${base}/`) ? path.slice(base.length) : path);
}

function renderSources(item) {
  const list = node('ul', 'news-source-list');
  for (const source of item.sources || []) {
    const row = node('li', 'news-source');
    if (item.type === 'story') {
      const meta = node('div', 'news-source-meta');
      meta.append(node('span', '', sourceName(source.source?.name)));
      if (source.source?.firstParty) meta.append(node('span', 'news-first-party', '一手来源'));
      const published = dateTime(source.publishedAt);
      if (published) { const time = node('time', '', published); time.dateTime = source.publishedAt; meta.append(time); }
      const title = node('a', 'news-source-title', source.title);
      const href = localNews(source.id, item.id);
      if (href) title.href = href;
      row.append(meta, title);
      if (source.summary) row.append(node('p', 'news-source-summary', source.summary));
      if (href) { const detail = node('a', 'news-source-link', '查看详情 →'); detail.href = href; row.append(detail); }
      const original = externalLink('阅读原文 ↗', source.links?.original, 'news-source-link');
      if (original) { if (href) row.append(document.createTextNode(' · ')); row.append(original); }
    } else {
      row.append(node('strong', 'news-source-name', sourceName(source.name)));
      const original = externalLink('阅读原文 ↗', source.url, 'news-source-link');
      if (original) row.append(node('br'), original);
      else row.append(node('p', 'news-source-summary', '暂无可用的原文链接。'));
    }
    list.append(row);
  }
  return list;
}

function renderRelated(items, heading) {
  const list = node('ul', 'news-related-list');
  for (const item of items || []) {
    const href = localNews(item.id || item.publicId);
    if (!href) continue;
    const row = node('li', 'news-related');
    const link = node('a', '', item.title); link.href = href;
    row.append(link);
    if (item.relation) row.append(node('span', '', item.relation));
    list.append(row);
  }
  return list.childElementCount ? sideSection(heading, list) : null;
}

function renderItem(item) {
  document.title = `${item.title} · SmartKey`;
  const fragment = document.createDocumentFragment();
  const header = node('header', 'news-header');
  header.append(node('div', 'small-label', item.type === 'story' ? 'AI / CURRENT TOPIC' : 'AI / DAILY READ'), node('h1', '', item.title));
  const meta = node('div', 'news-meta');
  if (item.type === 'story') {
    const latest = dateTime(item.latestAt);
    if (latest) meta.append(node('span', '', `最近报道 ${latest}`));
    meta.append(node('span', '', `${item.sourceCount} 个来源 · ${item.reportCount} 篇报道`));
    const first = dateTime(item.firstReportAt);
    if (first) meta.append(node('span', '', `首次报道 ${first}`));
  } else {
    meta.append(node('span', '', sourceName(item.source?.name)));
    const published = dateTime(item.publishedAt);
    const discovered = dateTime(item.discoveredAt);
    if (published) meta.append(node('span', '', `发布于 ${published}`));
    else if (discovered) meta.append(node('span', '', `收录于 ${discovered}`));
    if (categories[item.category]) meta.append(node('span', 'news-category', categories[item.category]));
    if (Number.isFinite(item.score)) meta.append(node('span', '', `AI 评分 ${item.score}`));
  }
  meta.append(node('span', '', '北京时间')); header.append(meta); fragment.append(header);
  const layout = node('div', 'news-layout');
  const body = node('article', 'news-body');
  const side = node('aside', 'news-side'); side.setAttribute('aria-label', '来源与关联资讯');
  if (item.type === 'story') {
    if (item.latest) {
      const latest = node('section', 'news-latest');
      latest.append(node('h2', '', '最新进展'), node('p', '', item.latest)); body.append(latest);
    }
    const digest = section('事件综述', item.contentText || item.digest || '这条热点暂未提供综述，可查看右侧公开报道。');
    const updated = dateTime(item.digestUpdatedAt);
    if (updated) {
      const time = node('time', 'news-section-time', `综述更新于 ${updated}`); time.dateTime = item.digestUpdatedAt;
      digest.insertBefore(time, digest.lastChild);
    }
    body.append(digest);
    if (item.sources?.length) side.append(sideSection('关联报道', renderSources(item)));
    const storyline = renderRelated(item.storyline, '事件脉络');
    const related = renderRelated(item.related, '相关热点');
    if (storyline) side.append(storyline);
    if (related) side.append(related);
  } else {
    body.append(section('资讯导读', item.summary || '这条资讯暂未提供导读。'));
    if (item.reason) body.append(section('推荐理由', item.reason));
    if (item.originalTitle && item.originalTitle !== item.title) {
      const originalTitle = node('section', 'news-section');
      originalTitle.append(node('h2', '', '原文标题'), node('p', 'news-original-title', item.originalTitle)); body.append(originalTitle);
    }
    body.append(node('p', 'news-reading-note', '本页展示资讯导读与推荐理由，完整报道可通过原文链接阅读。'));
    const original = externalLink('阅读完整原文 ↗', item.links?.original, 'news-original-link');
    if (original) body.append(original);
    side.append(sideSection('原始来源', renderSources(item)));
  }
  layout.append(body, side); fragment.append(layout);
  $('news-content').replaceChildren(fragment);
}

let busy = false;
let retryAt = 0;
let retryTimer;
function renderError(status) {
  const state = node('section', 'news-state');
  state.append(node('span', 'small-label', 'AI / DAILY READ'), node('h1', '', status === 404 ? '这条资讯暂不可用' : '资讯暂时无法读取'));
  state.append(node('p', '', status === 404 ? '该资讯不存在、已撤下，或尚未收录。可以返回日报查看其他消息。' : status === 429 ? '请求暂时较多，稍后重试即可。' : '暂时无法连接资讯数据，稍后重试即可。'));
  const retry = node('button', 'news-retry', '重试'); retry.type = 'button';
  const wait = Math.max(0, retryAt - Date.now());
  if (wait) {
    retry.disabled = true; retry.textContent = `稍后重试（${Math.max(1, Math.ceil(wait / 60_000))} 分钟）`;
    retryTimer = setTimeout(() => { retry.disabled = false; retry.textContent = '重试'; }, wait + 250);
  }
  retry.addEventListener('click', load);
  const back = node('a', 'news-error-back', '返回 AI 日报'); back.href = localPath('/daily');
  state.append(retry, back); $('news-content').replaceChildren(state);
}

async function load() {
  if (busy || Date.now() < retryAt) return;
  busy = true; clearTimeout(retryTimer); $('news-content').setAttribute('aria-busy', 'true');
  const retryButton = document.querySelector('.news-retry');
  if (retryButton) { retryButton.disabled = true; retryButton.textContent = '正在读取…'; }
  try {
    if (!validId(itemId)) throw Object.assign(new Error(), { status: 404 });
    const response = await fetch(`${base}/api/news/${itemId}${validStory(storyContext) ? `?story=${storyContext}` : ''}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) {
      retryAt = Date.parse(result.retryAt) || 0;
      throw Object.assign(new Error(), { status: response.status });
    }
    const item = result.data?.item;
    if (!item || typeof item.title !== 'string' || !['summary', 'story'].includes(item.type)) throw new Error('invalid data');
    renderItem(item); retryAt = 0;
    $('news-message').hidden = !result.stale;
    $('news-message').textContent = result.stale ? '暂时无法获取更新，目前显示上次保存的资讯。' : '';
    $('news-freshness').textContent = dateTime(result.fetchedAt) ? `数据更新于 ${dateTime(result.fetchedAt)}` : '资讯已载入';
  } catch (error) {
    $('news-message').hidden = true; $('news-freshness').textContent = '数据暂未载入'; renderError(error.status);
  } finally { busy = false; $('news-content').setAttribute('aria-busy', 'false'); }
}

load();
