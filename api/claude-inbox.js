/* G-PLAN's inbox for Claude (docs/dev/CLAUDE_MEALS.md).
 *
 * The owner writes what they ate, or photographs it, and the app saves it at once with the food
 * table's estimate. What the table cannot settle — a dish it does not have, a photo — also goes
 * into this inbox. A Claude session, scheduled on the owner's own Claude account, reads the inbox
 * with a token of its own, works the nutrition out (looking at the photo), writes the result back,
 * and keeps a dataset of the foods it has worked out. The app applies the results to its log and
 * looks the dataset up before its own table, so a food worked out once is instant afterwards.
 *
 * The token is not a session: it reads the inbox and the dataset and writes results and foods,
 * nothing else — no state document, no history. One per profile; a new one replaces the old.
 * Stored only as a SHA-256 (it is random, a slow hash adds nothing), like the Apple Health token.
 *
 * Pure: validation, token hashing and the dataset merge. Storage and routes are the servers'
 * (server.js, cloudflare/api.js). */
import crypto from 'node:crypto';

const PREFIX = 'gplanc_';
export const hashClaudeToken = tok => crypto.createHash('sha256').update('gplan-claude:' + tok).digest('hex');
export const newClaudeToken = () => PREFIX + crypto.randomBytes(32).toString('base64url');
export const looksLikeClaudeToken = tok => typeof tok === 'string' && tok.startsWith(PREFIX) && tok.length <= 100;
/** The token from an Authorization: Bearer header, or ''. */
export const bearerOf = header => {
  const h = String(header || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

// A day's worth of meals and then some; an inbox nobody reads stops growing here.
export const MAX_PENDING = 30;
// The app sends a ~1024 px JPEG of a few hundred kB. 1 MB is 1.4 MB as base64: inside one Durable
// Object row (2 MB) with the rest of the entry, and both servers' 5 MB request limit.
export const MAX_PHOTO_BYTES = 1024 * 1024;
export const MAX_FOODS = 2000;
// The food table's categories (frontend/src/lib/foods.js): how the lunch planner portions a dish.
export const FOOD_CATS = ['rice', 'noodle', 'soup', 'stew', 'main', 'side', 'kimchi', 'free', 'fruit', 'dairy', 'dessert', 'drink'];
const SLOTS = new Set(['b', 'l', 's', 'd']);
const PHOTO = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** The same normalisation as the app's food table (frontend/src/lib/foods.js normName). */
export const normName = s => String(s || '').toLowerCase().replace(/[\s·.,*&()[\]{}'"!?~:;/\\-]+/g, '');

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(max, n) : null; };
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/**
 * The app's entry → { entry } or { error }: the meal as written (`text`), an optional photo, the
 * log item it belongs to (`mealId`) and the table's estimate the app logged meanwhile.
 */
export function parseInboxEntry(body, now = Date.now()) {
  const id = typeof body?.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(body.id) ? body.id : null;
  if (!id) return { error: 'id must be 4–40 letters, digits, _ or -' };
  if (!isDay(body.date)) return { error: 'date must be YYYY-MM-DD' };
  if (!SLOTS.has(body.slot)) return { error: 'slot must be b, l, s or d' };
  const text = str(body.text, 500);
  let photo = null;
  if (body.photo != null && body.photo !== '') {
    const m = PHOTO.exec(typeof body.photo === 'string' ? body.photo : '');
    if (!m) return { error: 'photo must be a JPEG, PNG or WebP data URL' };
    if (Math.floor(m[2].length * 3 / 4) > MAX_PHOTO_BYTES) return { error: 'photo is too large' };
    photo = body.photo;
  }
  if (!text && !photo) return { error: 'write what you ate, or add a photo' };
  const est = body.estimate && typeof body.estimate === 'object' ? body.estimate : null;
  const estimate = est ? { kcal: Math.round(num(est.kcal, 20000) || 0), p: Math.round(num(est.p, 2000) || 0), c: Math.round(num(est.c, 4000) || 0), f: Math.round(num(est.f, 2000) || 0) } : null;
  return { entry: { id, date: body.date, slot: body.slot, mealId: str(body.mealId, 40) || null, text, photo, estimate, status: 'pending', created: now, result: null, doneAt: null } };
}

/** What the app sees of an entry: everything but the photo itself. */
export const appEntry = e => ({ id: e.id, date: e.date, slot: e.slot, mealId: e.mealId, text: e.text, hasPhoto: !!e.photo, status: e.status, created: e.created, result: e.result || null, doneAt: e.doneAt || null });

/** What Claude reads of a pending entry: the text, the photo and the app's estimate. */
export const claudeEntry = e => ({ id: e.id, date: e.date, slot: e.slot, text: e.text, photo: e.photo || null, estimate: e.estimate || null, created: e.created });

/**
 * Claude's answer for one entry → { id, result } or { error }. Totals are added up here from the
 * items, so a result can never disagree with itself.
 */
export function parseResult(body) {
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id) return { error: 'id required' };
  const list = Array.isArray(body.items) ? body.items : [];
  if (!list.length || list.length > 30) return { error: 'items must list 1–30 foods' };
  const items = [];
  for (const it of list) {
    const name = str(it?.name, 40);
    const kcal = num(it?.kcal, 5000);
    if (!name || kcal == null) return { error: 'every item needs a name and kcal' };
    items.push({ name, amount: str(it.amount, 40), kcal: Math.round(kcal), p: Math.round(num(it.p, 500) || 0), c: Math.round(num(it.c, 800) || 0), f: Math.round(num(it.f, 500) || 0) });
  }
  const sum = k => items.reduce((a, x) => a + x[k], 0);
  return { id, result: { items, kcal: sum('kcal'), p: sum('p'), c: sum('c'), f: sum('f'), note: str(body.note, 300), by: 'claude' } };
}

/**
 * Foods Claude worked out, merged into the dataset ({ foods: [...] }) by name: one serving each,
 * `g` its weight, `cat` one of FOOD_CATS (a main dish when left out), `tray` the school lunch day
 * whose tray photo the serving was checked against. The school posts those photos irregularly,
 * several weeks at once, so a dish worked out from the menu alone is looked at again once a photo
 * of it appears. A name already there is replaced (a better answer wins); the newest last.
 */
export function mergeFoods(doc, foods, now = Date.now()) {
  const list = Array.isArray(foods) ? foods.slice(0, 300) : [];
  const add = [];
  for (const f of list) {
    const name = str(f?.name, 40);
    const kcal = num(f?.kcal, 5000);
    const g = num(f?.g, 3000);
    if (!name || kcal == null || !g) return { error: 'every food needs a name, kcal and g (one serving\'s weight)' };
    add.push({ name, cat: FOOD_CATS.includes(f.cat) ? f.cat : 'main', g: Math.round(g), kcal: Math.round(kcal), p: Math.round((num(f.p, 500) || 0) * 10) / 10, c: Math.round((num(f.c, 800) || 0) * 10) / 10, f: Math.round((num(f.f, 500) || 0) * 10) / 10, note: str(f.note, 120), ...(isDay(f.tray) ? { tray: f.tray } : {}), at: now });
  }
  const keys = new Set(add.map(x => normName(x.name)));
  const kept = (Array.isArray(doc?.foods) ? doc.foods : []).filter(x => !keys.has(normName(x?.name)));
  return { doc: { foods: [...kept, ...add].slice(-MAX_FOODS) }, added: add.length };
}
