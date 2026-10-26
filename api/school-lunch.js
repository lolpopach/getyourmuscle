/* The school lunch menu, read off the school's own homepage (docs/dev/GETYOURMUSCLE_PLAN.md §2.2).
 *
 * The school publishes no API. Its homepage is a withschool.co.kr site whose 식단표 board
 * (?menu_no=34) lists every school day of a month — "1일 (목)", a meal label such as 중식, and
 * the dishes as one comma-separated line — and takes the month as ?ChangeDate=YYYY-M-1. The page
 * is EUC-KR. This module turns one such page into { month, days: { 'YYYY-MM-DD': [{ label,
 * dishes }] } }; what a dish line means (salt %, sauces, the self-serve counter) is the app's to
 * read (frontend/src/lib/lunch.js).
 *
 * The fetch, the cache and the routes are the server's (server.js, cloudflare/api.js), so this
 * stays pure apart from the one function that fetches with an injected fetch. */

// The owner's school. LUNCH_URL on either server points it elsewhere; LUNCH_URL='' turns it off.
export const DEFAULT_LUNCH_URL = 'http://kshcm.net/?menu_no=34';
// A month's page changes rarely (a dish swapped now and then); six hours keeps a swap visible the
// same day without asking the school's server more than four times a day.
export const LUNCH_CACHE_MS = 6 * 3600000;
const FETCH_TIMEOUT_MS = 10000;
const MAX_PAGE = 2 * 1024 * 1024;

export const lunchUrl = env => {
  const v = env && env.LUNCH_URL;
  return v == null ? DEFAULT_LUNCH_URL : String(v).trim();
};

/** The page for a month ('2026-10') of the board at `base`. */
export function monthUrl(base, month) {
  const [y, m] = month.split('-').map(Number);
  const u = new URL(base);
  u.searchParams.set('ChangeDate', `${y}-${m}-1`);
  return u.toString();
}

/** The page's text in the charset it declares (header first, then <meta>), EUC-KR when silent. */
export function decodePage(bytes, contentType = '') {
  const ascii = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const declared = (/charset=["']?([\w-]+)/i.exec(contentType) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii) || [])[1];
  for (const cs of [declared, 'euc-kr', 'utf-8']) {
    if (!cs) continue;
    try { return new TextDecoder(cs).decode(bytes); } catch { /* unknown label: try the next */ }
  }
  return new TextDecoder().decode(bytes);
}

const ENTITY = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const text = html => html
  .replace(/<br\s*\/?>/gi, ', ')
  .replace(/<[^>]*>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    }
    return ENTITY[e.toLowerCase()] ?? m;
  })
  .replace(/\s+/g, ' ')
  .trim();

/** A dish line split at its commas — not at those inside parentheses ("(추가배식대 : 밥, 국)"). */
export function splitDishes(line) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of line) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '，') && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean).slice(0, 30).map(s => s.slice(0, 80));
}

/**
 * One month's page → { month: 'YYYY-MM' | null, days }. A day with no meal (weekends, holidays)
 * is left out. Anything the page does not say is not invented: no caption, no month.
 */
export function parseMenuPage(html) {
  const cap = /<caption>\s*(\d{4})\s*년\s*(\d{1,2})\s*월/.exec(html);
  if (!cap) return { month: null, days: {} };
  const month = `${cap[1]}-${String(cap[2]).padStart(2, '0')}`;
  const days = {};
  for (const row of html.split(/<tr\b/i).slice(1)) {
    const d = />\s*(\d{1,2})\s*일\s*\(/.exec(row);
    if (!d || +d[1] < 1 || +d[1] > 31) continue;
    const meals = [];
    for (const m of row.matchAll(/class=["']?design_font["']?[^>]*>([^<]*)<[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const dishes = splitDishes(text(m[2]));
      if (dishes.length) meals.push({ label: text(m[1]).slice(0, 10) || '중식', dishes });
    }
    if (meals.length) days[`${month}-${String(d[1]).padStart(2, '0')}`] = meals;
  }
  return { month, days };
}

/**
 * The month's menu from the school, or { error }. `fetch` is the server's own (injectable for
 * tests); the page is read with a timeout and a size cap, because it is somebody else's server.
 */
export async function fetchMonth(base, month, { fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(monthUrl(base, month), { headers: { 'user-agent': 'G-PLAN lunch reader' }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) return { error: `the school site answered ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_PAGE) return { error: 'the school page is too large' };
    const doc = parseMenuPage(decodePage(bytes, res.headers.get('content-type') || ''));
    if (doc.month && doc.month !== month) return { error: 'the school page showed another month' };
    return { month, days: doc.days, at: now };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'the school site did not answer in time' : 'the school site could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}

export const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/**
 * The answer for one day, from a cached month (or none) and a way to fetch it. A fresh cache is
 * used as is; a stale one is refreshed, and kept when the school cannot be reached — yesterday's
 * menu beats an error. Returns { body, store } — `store` the month to cache, when it changed.
 */
export async function lunchFor(date, cached, fetchMonthFn, now = Date.now()) {
  const month = date.slice(0, 7);
  let doc = cached && cached.month === month ? cached : null;
  let store = null;
  if (!doc || now - (doc.at || 0) > LUNCH_CACHE_MS) {
    const fresh = await fetchMonthFn(month);
    if (!fresh.error) { doc = fresh; store = fresh; }
    else if (!doc) return { error: fresh.error };
  }
  return { body: { date, meals: doc.days[date] || [], fetchedAt: doc.at || null }, store };
}
