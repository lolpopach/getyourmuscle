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
 * `health-<uid>.json` ({ days: { 'YYYY-MM-DD': { distKm, steps, activeKcal, weight, bodyFat, at } } }).
 * The routes, the throttle and the file I/O are server.js's. */
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

// A Shortcut's "Number" field arrives as a number; a "Text" field holding one as a string, and in
// some regions with a decimal comma. Anything else is not a number.
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

const UNIT = { km: 1, m: 0.001, mi: 1.609344 };

/* The body of one ingest, checked and normalised: { date, values } or { error }.
 *   date        'YYYY-MM-DD' (required)
 *   dist, unit  walking + running distance; unit km (default), m or mi
 *   steps, activeKcal, weight (kg), bodyFat (% — or the 0–1 fraction Health stores)
 * Each value is optional, but at least one has to be there. */
export function parseIngest(body, now = Date.now()) {
  const date = typeof body?.date === 'string' ? body.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isoDay(Date.parse(date + 'T00:00:00Z') || 0) !== date) {
    return { error: 'date must be YYYY-MM-DD' };
  }
  const day = Date.parse(date + 'T00:00:00Z');
  if (day < now - MAX_AGE_DAYS * 86400000 || day > now + 86400000) return { error: 'date out of range' };

  const values = {};
  const unit = typeof body.unit === 'string' ? body.unit.trim().toLowerCase() : 'km';
  if (!UNIT[unit]) return { error: 'unit must be km, m or mi' };
  const dist = num(body.dist);
  if (body.dist != null && body.dist !== '') {
    if (dist == null || dist < 0) return { error: 'dist must be a number' };
    const km = dist * UNIT[unit];
    if (km > 150) return { error: 'dist out of range' };
    values.distKm = round(km, 2);
  }
  const steps = num(body.steps);
  if (body.steps != null && body.steps !== '') {
    if (steps == null || steps < 0 || steps > 200000) return { error: 'steps out of range' };
    values.steps = Math.round(steps);
  }
  const kcal = num(body.activeKcal);
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
  return { days: out };
}

// The days on or after `from` ('YYYY-MM-DD'), all of them without one.
export function daysFrom(doc, from) {
  const days = doc && typeof doc.days === 'object' && doc.days ? doc.days : {};
  if (!from) return days;
  const out = {};
  for (const [k, v] of Object.entries(days)) if (k >= from) out[k] = v;
  return out;
}
