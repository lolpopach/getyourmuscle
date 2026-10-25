// One G-PLAN day (S.gday[iso]): what was eaten per meal slot, which supplements were taken, and
// water, steps and distance. Each day carries its own `_ts`, so two devices that logged on
// different days both keep their days, and a day edited on both keeps the later edit
// (lib/sync-merge.js, mergeStampedMap). The mutations below take the draft S of store.update.
import { SLOTS } from './gplan.js'
import { uid } from './format.js'

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const list = v => (Array.isArray(v) ? v : [])

/** The day as stored, or an empty one. Never null, so readers need no guard. */
export function dayOf(S, iso) {
  const d = S?.gday?.[iso]
  return d && typeof d === 'object' ? d : { meals: {}, supps: {} }
}

// The day to write into: created, and stamped with the edit's time.
function touch(S, iso, now) {
  if (!S.gday || typeof S.gday !== 'object' || Array.isArray(S.gday)) S.gday = {}
  const d = S.gday[iso] && typeof S.gday[iso] === 'object' ? S.gday[iso] : {}
  d.meals = d.meals && typeof d.meals === 'object' ? d.meals : {}
  d.supps = d.supps && typeof d.supps === 'object' ? d.supps : {}
  d._ts = now
  S.gday[iso] = d
  return d
}

const clean = item => ({
  id: String(item.id || uid()),
  name: String(item.name || '').slice(0, 60),
  kcal: Math.round(num(item.kcal)), p: Math.round(num(item.p)), c: Math.round(num(item.c)), f: Math.round(num(item.f)),
  ...(item.tpl ? { tpl: String(item.tpl) } : {}),
})

/** Adds a food (or a template's copy) to a slot of the day. Returns the stored item. */
export function addMeal(S, iso, slot, item, now = Date.now()) {
  if (!SLOTS.includes(slot)) return null
  const d = touch(S, iso, now)
  const stored = clean(item)
  d.meals[slot] = [...list(d.meals[slot]), stored]
  return stored
}

export function removeMeal(S, iso, slot, id, now = Date.now()) {
  const d = touch(S, iso, now)
  d.meals[slot] = list(d.meals[slot]).filter(x => x?.id !== id)
}

export function toggleSupp(S, iso, suppId, now = Date.now()) {
  const d = touch(S, iso, now)
  if (d.supps[suppId]) delete d.supps[suppId]
  else d.supps[suppId] = true
  return !!d.supps[suppId]
}

/** Water (ml), steps or km for the day; a value of null clears it. */
export function setDayValue(S, iso, key, value, now = Date.now()) {
  if (!['water', 'steps', 'km'].includes(key)) return
  const d = touch(S, iso, now)
  if (value == null || value === '') delete d[key]
  else d[key] = Math.max(0, num(value))
}

/** A logged meal of the day saved as a template for its slot, under its name. */
export function saveTemplate(S, slot, item, now = Date.now()) {
  if (!S.gplan) return null
  const tpl = { ...clean(item), id: 'tpl-' + uid(), slot }
  delete tpl.tpl
  S.gplan.templates = [...list(S.gplan.templates), tpl]
  S.gplan._ts = now
  return tpl
}

export function removeTemplate(S, id, now = Date.now()) {
  if (!S.gplan) return
  S.gplan.templates = list(S.gplan.templates).filter(t => t?.id !== id)
  S.gplan._ts = now
}

/* ------------------------------------------------------------------ reading a day ------ */

const sum = items => items.reduce((a, x) => ({ kcal: a.kcal + num(x?.kcal), p: a.p + num(x?.p), c: a.c + num(x?.c), f: a.f + num(x?.f) }), { kcal: 0, p: 0, c: 0, f: 0 })

export const slotTotals = (day, slot) => sum(list(day?.meals?.[slot]))
export const dayTotals = day => sum(SLOTS.flatMap(s => list(day?.meals?.[s])))
export const slotLogged = (day, slot) => list(day?.meals?.[slot]).length > 0

/** What is left of the day's targets (negative once over). */
export function remaining(targets, totals) {
  const t = targets || {}
  return { kcal: num(t.kcal) - totals.kcal, p: num(t.p) - totals.p, c: num(t.c) - totals.c, f: num(t.f) - totals.f }
}

const isoMinus = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10)

/**
 * Days in a row the supplement was taken, ending today — or ending yesterday while today is
 * still open, so a morning check of the streak does not read 0 before the dose is due.
 */
export function suppStreak(S, suppId, todayIso) {
  const took = iso => !!S?.gday?.[iso]?.supps?.[suppId]
  let n = 0
  let iso = took(todayIso) ? todayIso : isoMinus(todayIso, 1)
  while (took(iso) && n < 3650) { n++; iso = isoMinus(iso, 1) }
  return n
}

/**
 * The day's checklist: every supplement, the four meals, the workout (done, or a rest day),
 * water and steps against the plan's goals. Each row { key, done }, plus how many are done.
 */
export function checklist(S, iso, { workoutDone = false, restDay = false, synced = null } = {}) {
  const plan = S?.gplan
  const day = dayOf(S, iso)
  const goals = plan?.goals || {}
  const steps = Math.max(num(day.steps), num(synced?.steps))
  const rows = [
    ...list(plan?.supps).map(s => ({ key: 'supp:' + s.id, done: !!day.supps?.[s.id] })),
    ...SLOTS.map(slot => ({ key: 'meal:' + slot, done: slotLogged(day, slot) })),
    { key: 'workout', done: workoutDone || restDay },
    { key: 'water', done: num(day.water) >= num(goals.waterMl || 3500) },
    { key: 'steps', done: steps >= num(goals.steps || 9000) },
  ]
  return { rows, done: rows.filter(r => r.done).length, total: rows.length }
}

/**
 * The one line that says what to do next, as a key and its numbers for t(): protein first (it
 * is the target that decides whether the cut keeps the muscle), then the budget.
 *   'protein-next' [grams, slot]  — protein still short, with a meal left to eat it in
 *   'protein-short' [grams]       — short and every meal logged: a shake or chicken breast
 *   'over' [kcal]                 — over the day's budget
 *   'on-track' []                 — protein met, within budget
 */
export function nextHint(targets, day) {
  const left = remaining(targets, dayTotals(day))
  const open = SLOTS.find(s => !slotLogged(day, s))
  if (left.p > 10) return open ? { key: 'protein-next', args: [Math.round(left.p), open] } : { key: 'protein-short', args: [Math.round(left.p)] }
  if (left.kcal < -150) return { key: 'over', args: [Math.round(-left.kcal)] }
  return { key: 'on-track', args: [] }
}

/** Kept days, newest first, with their totals — for the history list. */
export function loggedDays(S, n = 14) {
  return Object.keys(S?.gday || {}).sort().reverse().slice(0, n)
    .map(iso => ({ iso, totals: dayTotals(S.gday[iso]), meals: SLOTS.filter(s => slotLogged(S.gday[iso], s)).length }))
}
