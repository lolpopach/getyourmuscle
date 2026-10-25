// G-PLAN: the personal cut-and-build plan on top of the training log
// (docs/dev/GETYOURMUSCLE_PLAN.md). This module is the arithmetic of it — energy, daily targets,
// the projected path — plus the starter templates a fresh plan is seeded with. Pure functions
// only; the store and the screens call these.

// 1 kg of body weight lost ≈ 7,700 kcal: the working figure every weekly estimate below uses.
export const KCAL_PER_KG = 7700

const round = (v, step = 1) => Math.round(v / step) * step

// Basal metabolic rate from fat-free mass (Katch-McArdle) — the same formula InBody prints.
export const bmrKatch = ffmKg => 370 + 21.6 * ffmKg

// Basal metabolic rate from weight, height and age (Mifflin-St Jeor), for when there is no
// body-fat reading to go on.
export const bmrMifflin = ({ w, h, age, sex }) => 10 * w + 6.25 * h - 5 * age + (sex === 'female' ? -161 : 5)

// Fat-free mass from weight and body fat %, or null without a usable reading.
export const ffmOf = (w, bf) => (w > 0 && bf > 0 && bf < 70 ? w * (1 - bf / 100) : null)

/**
 * Daily energy use: basal rate × activity, plus walking/running on top (net cost ≈ 0.5 kcal per
 * kg per km walked, ≈ 1.0 running). `activity` covers daily life and lifting; cardio is added
 * separately because it is the part people change.
 */
export function estimateTdee({ w, h, age, sex, bf, activity = 1.5, walkKm = 0, runKm = 0 }) {
  const ffm = ffmOf(w, bf)
  const bmr = ffm ? bmrKatch(ffm) : bmrMifflin({ w, h, age, sex })
  return Math.round(bmr * activity + 0.5 * w * walkKm + 1.0 * w * runKm)
}

/**
 * Daily targets for an intake of `kcal`: protein fixed per kg (it is what keeps the muscle),
 * fat per kg with a floor, carbohydrate the rest. Grams round to 5 g, so they add up to within
 * a few kcal of `kcal`, which stays the number the day's budget is counted against.
 */
export function macroTargets({ kcal, w, proteinPerKg = 2.15, fatPerKg = 0.8, minFat = 55 }) {
  const p = round(w * proteinPerKg, 5)
  const f = Math.max(minFat, round(w * fatPerKg, 5))
  const c = Math.max(0, round((kcal - p * 4 - f * 9) / 4, 5))
  return { kcal: Math.round(kcal), p, c, f }
}

/**
 * The whole set-up from a profile: estimated use, intake for the chosen weekly loss, macros, and
 * the floor below which the weekly adjustment never goes. `rateKgWk` 0 means maintenance.
 */
export function planFromProfile({ w, h, age, sex = 'male', bf = null, activity = 1.5, walkKm = 6, runKm = 0, rateKgWk = 0.45 }) {
  const tdee = estimateTdee({ w, h, age, sex, bf, activity, walkKm, runKm })
  const deficit = Math.round((rateKgWk * KCAL_PER_KG) / 7)
  const intake = round(tdee - deficit, 50)
  const targets = macroTargets({ kcal: intake, w })
  const minKcal = round(Math.max(sex === 'female' ? 1400 : 1800, tdee - 900), 50)
  return { tdee, deficit, targets, minKcal }
}

/**
 * Where the plan expects to be on each check date: weight falling `rateKgWk` a week, of which
 * `fatShare` is fat. Returns [{ d, w, fatKg, bf }] (bf null without a starting fat mass).
 */
export function projectPath({ startIso, startW, startFatKg = null, rateKgWk, dates, fatShare = 0.95 }) {
  const t0 = Date.parse(startIso + 'T00:00:00Z')
  return dates.map(d => {
    const weeks = Math.max(0, (Date.parse(d + 'T00:00:00Z') - t0) / (7 * 86400000))
    const lost = rateKgWk * weeks
    const w = Math.round((startW - lost) * 10) / 10
    const fatKg = startFatKg == null ? null : Math.round((startFatKg - lost * fatShare) * 10) / 10
    return { d, w, fatKg, bf: fatKg == null ? null : Math.round((fatKg / w) * 1000) / 10 }
  })
}

// The four meal slots of a day, in order.
export const SLOTS = ['b', 'l', 's', 'd']

/**
 * What a new plan starts with: the owner's usual meals as one-tap templates and creatine as the
 * daily supplement (docs/dev/GETYOURMUSCLE_PLAN.md §2.2–2.3). Names are the owner's own, in
 * Korean, like any routine they would type — templates are user data, not UI copy.
 */
export function starterTemplates() {
  return [
    { id: 'tpl-jambon', slot: 'b', name: '잠봉 샌드위치 + 단백질 음료', kcal: 630, p: 43, c: 63, f: 23 },
    { id: 'tpl-jambon-only', slot: 'b', name: '잠봉 샌드위치', kcal: 480, p: 18, c: 55, f: 20 },
    { id: 'tpl-drink', slot: 'b', name: '단백질 음료 + 바나나', kcal: 250, p: 26, c: 33, f: 3 },
    { id: 'tpl-school', slot: 'l', name: '급식 (밥 1공기 + 고기 많이)', kcal: 750, p: 40, c: 95, f: 20 },
    { id: 'tpl-snack', slot: 's', name: '프로틴 + 바나나 + 닭가슴살', kcal: 330, p: 48, c: 29, f: 4 },
    { id: 'tpl-chicken', slot: 's', name: '닭가슴살 1개', kcal: 110, p: 23, c: 1, f: 2 },
    { id: 'tpl-poke', slot: 'd', name: '닭가슴살 포케', kcal: 700, p: 53, c: 82, f: 13 },
    { id: 'tpl-eggjjim', slot: 'd', name: '계란찜 + 밥', kcal: 730, p: 38, c: 78, f: 26 },
    { id: 'tpl-moksal', slot: 'd', name: '목살 쌈 + 밥', kcal: 650, p: 40, c: 50, f: 27 },
    { id: 'tpl-samgyup', slot: 'd', name: '삼겹살 + 밥 반 공기', kcal: 650, p: 26, c: 35, f: 42 },
  ]
}

export const starterSupplements = () => [{ id: 'creatine', name: '크레아틴', dose: '3 g' }]

/**
 * A fresh plan object (S.gplan) from the set-up sheet's answers. Templates and supplements are
 * kept from `prev` when there is one, so changing the numbers never throws away edited meals.
 */
export function makePlan(answers, prev = null, now = Date.now()) {
  const { w, h, age, sex, bf, activity, walkKm, runKm, rateKgWk, targetW, targetBf, start, end, waterMl = 3500, steps = 9000 } = answers
  const { tdee, targets, minKcal } = planFromProfile({ w, h, age, sex, bf, activity, walkKm, runKm, rateKgWk })
  return {
    profile: { h, age, sex, activity, walkKm, runKm },
    start, end, startW: w, startBf: bf ?? null, targetW: targetW ?? null, targetBf: targetBf ?? null, rateKgWk,
    tdee, targets, minKcal, goals: { waterMl, steps },
    templates: prev?.templates || starterTemplates(),
    supps: prev?.supps || starterSupplements(),
    history: [...(prev?.history || []), { at: now, kcal: targets.kcal, reason: prev ? 'edit' : 'start' }].slice(-50),
    _ts: now,
  }
}

/* --------------------------------------------------------------- body composition ------ */
// S.bodycomp: InBody readings keyed by day, each stamped (`_ts`) so two devices keep both days
// and the later edit of the same day (lib/sync-merge.js). A reading's weight is also a weigh-in.

const BC_FIELDS = ['w', 'smm', 'fatKg', 'bf', 'ffm', 'visceral', 'waist', 'bmr']

export function saveBodycomp(S, iso, entry, now = Date.now()) {
  const rec = { _ts: now }
  for (const k of BC_FIELDS) {
    const v = Number(entry?.[k])
    if (Number.isFinite(v) && v > 0) rec[k] = Math.round(v * 10) / 10
  }
  if (entry?.note) rec.note = String(entry.note).slice(0, 80)
  // Fat-free mass follows from the two numbers every printout has, when it was not typed.
  if (rec.ffm == null && rec.w && rec.bf) rec.ffm = Math.round(ffmOf(rec.w, rec.bf) * 10) / 10
  if (!S.bodycomp || typeof S.bodycomp !== 'object' || Array.isArray(S.bodycomp)) S.bodycomp = {}
  S.bodycomp[iso] = rec
  if (rec.w) {
    if (!Array.isArray(S.bodyweight)) S.bodyweight = []
    const ex = S.bodyweight.find(b => b.d === iso)
    if (ex) { ex.w = rec.w; ex.t = now } else S.bodyweight.push({ d: iso, w: rec.w, t: now })
    S.bodyweight.sort((a, b) => (a.d < b.d ? -1 : 1))
  }
  return rec
}

export function removeBodycomp(S, iso) {
  if (S.bodycomp && typeof S.bodycomp === 'object') delete S.bodycomp[iso]
}

/** Readings oldest first, each with its day: [{ d, w, smm, … }]. */
export const bodycompList = S => Object.entries(S?.bodycomp && typeof S.bodycomp === 'object' ? S.bodycomp : {})
  .filter(([, v]) => v && typeof v === 'object')
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([d, v]) => ({ d, ...v }))
