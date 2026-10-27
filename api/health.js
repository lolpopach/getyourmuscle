/* Apple Health sync through an iOS Shortcut (docs/dev/GETYOURMUSCLE_PLAN.md §4.11).
 *
 * HealthKit has no web API, so the web app cannot read it. A Shortcut on the person's iPhone can:
 * it sums today's walking + running distance, steps and active energy (and the latest weight and
 * body fat, when Health has them) and POSTs them to /api/health/ingest with a token of its own.
 *
 * The token is not a session. It can only add numbers to the profile's health file — it reads
 * nothing back — so a Shortcut shared by mistake, or a token left in an exported Shortcut, leaks
 * no history. One per profile; a new one replaces the one before. Stored only as a SHA-256, like
 * a device-link code: the token is random, so a slow hash would add nothing.
 *
 * Pure bookkeeping on `db.users[].healthTok` and on the per-profile document
 * `health-<uid>.json` ({ days: { 'YYYY-MM-DD': { distKm, steps, activeKcal, weight, bodyFat, at } },
 * last: { at, date } | { at, error } }). The routes, the throttle and the file I/O are server.js's
 * (and cloudflare/api.js's).
 *
 * Building the Shortcut is where people get stuck, so it is kept to five actions: two Health
 * reads, two sums and the request. The token rides in the address (`?key=`), so there is no header
 * to set up; the date is the server's, in the time zone the address names (`&tz=`); numbers are
 * read as kindly as they can be; and `last` tells the app what the latest call came to. */
import crypto from 'node:crypto';

const PREFIX = 'gymh_';
export const HEALTH_KEEP_DAYS = 400;
// A Shortcut sends today's totals; one that ran late (after midnight) or was re-run by hand may
// send an earlier day. Anything older than this, or more than a day ahead, is a wrong date.
const MAX_AGE_DAYS = 31;

export const hashHealthToken = tok => crypto.createHash('sha256').update('opengym-health:' + tok).digest('hex');

// → the token, returned once and never stored.
export function issueHealthToken(user, now = Date.now()) {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  user.healthTok = { h: hashHealthToken(token), created: now };
  return token;
}

export function revokeHealthToken(user) {
  const had = !!user.healthTok;
  delete user.healthTok;
  return had;
}

// The profile a token belongs to, or null. A disabled profile's token works no more than its
// sessions do.
export function findHealthUser(users, token) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 100) return null;
  const h = Buffer.from(hashHealthToken(token), 'hex');
  return users.find(u => {
    if (!u?.healthTok?.h || u.disabled) return false;
    const stored = Buffer.from(u.healthTok.h, 'hex');
    return stored.length === h.length && crypto.timingSafeEqual(stored, h);
  }) || null;
}

// The token a call carries: the Authorization header (Bearer …), or `key` in the address — what
// the app hands out, one string to paste and no header to set up in Shortcuts.
export function ingestToken(authorization, params) {
  const a = String(authorization || '');
  if (a.startsWith('Bearer ')) return a.slice(7).trim();
  return String(params?.get?.('key') || '').trim();
}

// Today in an IANA time zone ('Asia/Ho_Chi_Minh'); UTC without one, or with one Intl does not know.
export function todayIn(tz, now = Date.now()) {
  if (tz) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(now).map(x => [x.type, x.value]));
      if (p.year && p.month && p.day) return `${p.year}-${p.month}-${p.day}`;
    } catch { /* unknown zone */ }
  }
  return isoDay(now);
}

// A Shortcut's "Number" field arrives as a number. Anything else is read as kindly as it can be:
// text with a unit after it ("6.4 km", "9300 걸음"), a decimal comma ("5,25"), digit grouping
// ("9,300", "9.300", "9 300") in whole-number fields and wherever both separators appear, and a
// list, which is summed — what arrives when the samples go in without "Calculate Statistics".
function num(v, whole = false) {
  if (Array.isArray(v)) {
    if (!v.length || v.length > 5000) return null;
    let sum = 0;
    for (const x of v) { const n = num(x, whole); if (n == null) return null; sum += n; }
    return sum;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = v.trim();
  const m = t.match(/^-?\d[\d.,\s\u00a0\u202f']*/);
  if (!m || /\d/.test(t.slice(m[0].length))) return null;
  let s = m[0].replace(/[\s\u00a0\u202f']/g, '');
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) {
    // Both: the later one is the decimal mark, the other groups digits.
    s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (dot >= 0 || comma >= 0) {
    const sep = dot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const grouped = parts.length > 2 || (whole && parts[1].length === 3);
    s = grouped ? parts.join('') : parts.join('.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

const UNIT = { km: 1, m: 0.001, mi: 1.609344 };
const SAID_UNIT = { km: 'km', m: 'm', mi: 'mi', '킬로미터': 'km', '미터': 'm', '마일': 'mi' };

// A date a Shortcut may send: 'YYYY-MM-DD', the same with a time after it, or a Korean-style
// '2026. 10. 26.'. '' when it is none of those.
function dayOf(v) {
  const m = typeof v === 'string' && v.trim().match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?![\d])/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

/* The body of one ingest, checked and normalised: { date, values } or { error }.
 *   date        'YYYY-MM-DD'; left out, today in `tz` (the address's), else in UTC
 *   dist, unit  walking + running distance; unit km (default), m or mi
 *   steps, activeKcal, weight (kg), bodyFat (% — or the 0–1 fraction Health stores)
 * Each value is optional, but at least one has to be there. */
export function parseIngest(body, now = Date.now(), { tz } = {}) {
  const given = body?.date != null && body.date !== '';
  const date = given ? dayOf(body.date) : todayIn(tz, now);
  if (!date || isoDay(Date.parse(date + 'T00:00:00Z') || 0) !== date) {
    return { error: 'date must be YYYY-MM-DD' };
  }
  const day = Date.parse(date + 'T00:00:00Z');
  if (day < now - MAX_AGE_DAYS * 86400000 || day > now + 86400000) return { error: 'date out of range' };

  const values = {};
  // No unit field: a distance sent as text may carry its own ("4200 m", "6.4km", "3 mi").
  const said = typeof body.dist === 'string' && body.dist.trim().match(/\d\s*(km|m|mi|킬로미터|미터|마일)\.?\s*$/i)?.[1].toLowerCase();
  const unit = typeof body.unit === 'string' ? body.unit.trim().toLowerCase() : (SAID_UNIT[said] || 'km');
  if (!UNIT[unit]) return { error: 'unit must be km, m or mi' };
  const dist = num(body.dist);
  if (body.dist != null && body.dist !== '') {
    if (dist == null || dist < 0) return { error: 'dist must be a number' };
    const km = dist * UNIT[unit];
    if (km > 150) return { error: 'dist out of range' };
    values.distKm = round(km, 2);
  }
  const steps = num(body.steps, true);
  if (body.steps != null && body.steps !== '') {
    if (steps == null || steps < 0 || steps > 200000) return { error: 'steps out of range' };
    values.steps = Math.round(steps);
  }
  const kcal = num(body.activeKcal, true);
  if (body.activeKcal != null && body.activeKcal !== '') {
    if (kcal == null || kcal < 0 || kcal > 10000) return { error: 'activeKcal out of range' };
    values.activeKcal = Math.round(kcal);
  }
  const w = num(body.weight);
  if (body.weight != null && body.weight !== '') {
    if (w == null || w < 20 || w > 400) return { error: 'weight out of range' };
    values.weight = round(w, 1);
  }
  let bf = num(body.bodyFat);
  if (body.bodyFat != null && body.bodyFat !== '') {
    if (bf != null && bf > 0 && bf <= 1) bf *= 100;
    if (bf == null || bf < 2 || bf > 70) return { error: 'bodyFat out of range' };
    values.bodyFat = round(bf, 1);
  }
  if (!Object.keys(values).length) return { error: 'nothing to save' };
  return { date, values };
}

// The document with one day's values merged in. A Shortcut sends running totals for the day, so
// a later sync replaces what an earlier one said; a field it leaves out keeps its value. Only the
// newest HEALTH_KEEP_DAYS days are kept.
export function mergeIngest(doc, date, values, now = Date.now()) {
  const days = { ...(doc && typeof doc.days === 'object' && doc.days ? doc.days : {}) };
  days[date] = { ...(days[date] || {}), ...values, at: now };
  const keep = Object.keys(days).sort().slice(-HEALTH_KEEP_DAYS);
  const out = {};
  for (const k of keep) out[k] = days[k];
  return { days: out, last: { at: now, date } };
}

// The document after a call that carried the right token but nothing usable: the days stay, and
// `last` says why, for the app to show. A wrong token is never recorded — it names no profile.
export function failedIngest(doc, error, now = Date.now()) {
  const days = doc && typeof doc.days === 'object' && doc.days ? doc.days : {};
  return { days, last: { at: now, error: String(error).slice(0, 80) } };
}

// The days on or after `from` ('YYYY-MM-DD'), all of them without one.
export function daysFrom(doc, from) {
  const days = doc && typeof doc.days === 'object' && doc.days ? doc.days : {};
  if (!from) return days;
  const out = {};
  for (const [k, v] of Object.entries(days)) if (k >= from) out[k] = v;
  return out;
}
