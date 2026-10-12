export function beijingDay(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

export function eventDay(event) {
  if (!event || typeof event !== 'object') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(event.occurredOn || '')) return event.occurredOn;
  return beijingDay(event.occurredOn || event.confirmedAt || event.createdAt);
}

export function nextWindow(events, now = Date.now()) {
  // A completed event can retain its earlier estimate. It is never a future forecast.
  return events.filter(event => event.status === 'announced' && !['confirmed', 'expired_unconfirmed', 'likely_completed'].includes(event.presentation?.status) && forecast(event) &&
    Date.parse(forecast(event).through || forecast(event).from) > now)
    .sort((a, b) => Date.parse(forecast(a).from) - Date.parse(forecast(b).from))[0] || null;
}

export const forecast = event => event.estimate || event.schedule;

export function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['x.com', 'twitter.com', 'aihot.news', 'www.x.com', 'www.twitter.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

export function todayBroadcast(feed, now = Date.now()) {
  if (feed?.data?.schemaVersion !== 1 || !Array.isArray(feed.data.events) ||
      !feed.data.events.every(event => event && typeof event === 'object' && typeof event.status === 'string') ||
      typeof feed.stale !== 'boolean' || !Number.isFinite(Date.parse(feed.fetchedAt))) {
    throw new Error('今日播报数据格式无效');
  }
  const date = beijingDay(new Date(now).toISOString());
  const confirmedDay = event => (event.occurredOn ? eventDay({ occurredOn: event.occurredOn }) : null) || beijingDay(event.confirmedAt);
  const timestamp = event => Date.parse(event.confirmedAt) || Date.parse(event.updatedAt) || 0;
  const unavailable = feed.stale || Boolean(feed.error);
  const event = unavailable ? null : feed.data.events.filter(event => event.status === 'confirmed' && confirmedDay(event) === date)
    .sort((a, b) => timestamp(b) - timestamp(a) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
      String(a.id).localeCompare(String(b.id)))[0];
  const confirmedAt = Number.isFinite(Date.parse(event?.confirmedAt)) ? event.confirmedAt : null;
  return {
    reset: event ? true : null, state: unavailable ? 'unavailable' : event ? 'confirmed' : 'no-announcement',
    date, updatedAt: confirmedAt, fetchedAt: feed.fetchedAt, stale: unavailable,
    event: event ? {
      id: event.id, title: event.title,
      sourceUrl: event.posts?.map(post => sourceUrl(post.url)).find(Boolean) || sourceUrl(event.url),
      occurredOn: event.occurredOn || null, date: confirmedDay(event),
      confirmedAt, updatedAt: event.updatedAt || null,
    } : null,
  };
}
