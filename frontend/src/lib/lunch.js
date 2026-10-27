// The school lunch, read off the school's menu page (api/school-lunch.js), turned into how to eat
// it: which dishes to take, how much, and what that comes to — with the dishes the owner does not
// eat left out and the rest re-balanced to still reach lunch's protein. Pure functions; the
// numbers come from the food table (foods.js), so nothing here needs a model or a network.
import { findFood, scaled, sumNutrition, normName } from './foods.js'

/**
 * Lunch's share of the day (docs/dev/GETYOURMUSCLE_PLAN.md §2.2: 750 of 2,400 kcal, 40 of 170 g
 * protein), from the plan's daily targets.
 */
export function lunchTarget(targets) {
  const kcal = Number(targets?.kcal) > 0 ? Number(targets.kcal) : 2400
  const p = Number(targets?.p) > 0 ? Number(targets.p) : 170
  return { kcal: Math.round((kcal * 0.31) / 10) * 10, p: Math.round(p * 0.235) }
}

const EXTRA = /\(\s*추가\s*배식대\s*[:：-]?\s*([^)]*)\)/

/**
 * One menu line as the school writes it → [{ raw, name, sauce, portion, extra }]. Usually one
 * dish; a line that names the self-serve counter's dishes in parentheses adds those as extras.
 *   '순두부찌개(0.6)'                → 순두부찌개 (the number is the soup's salt %, not an amount)
 *   '돈까스*브라운소스'               → 돈까스, sauce 브라운소스
 *   '바나나1/2'                      → 바나나, half a serving
 *   '상추쌈(추가배식대-자율)'          → 상추쌈 from the extra counter
 *   '망고 (추가배식대 : 흰쌀밥, 배추된장국)' → 망고, plus 흰쌀밥 and 배추된장국 as extras
 */
export function parseDish(raw) {
  let s = String(raw || '').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim()
  const out = []
  let extra = false
  const ex = s.match(EXTRA)
  if (ex) {
    const named = ex[1].split(/[,，]/).map(x => x.trim()).filter(x => x && !/^자율$/.test(x))
    if (named.length) for (const n of named) out.push(...parseDish(n).map(d => ({ ...d, extra: true })))
    else extra = true
    s = s.replace(EXTRA, ' ')
  }
  s = s.replace(/\([^)]*\)/g, ' ').trim()
  let sauce = ''
  const star = s.indexOf('*')
  if (star >= 0) { sauce = s.slice(star + 1).trim(); s = s.slice(0, star).trim() }
  let portion = 1
  const frac = s.match(/(\d+)\s*\/\s*(\d+)\s*(개)?$/)
  if (frac && +frac[2] > 0) { portion = +frac[1] / +frac[2]; s = s.slice(0, frac.index).trim() }
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return out
  return [{ raw: String(raw || '').trim(), name: s, sauce, portion, extra }, ...out]
}

export const parseMenu = entries => (Array.isArray(entries) ? entries : []).flatMap(parseDish)

/** Whether a dish is one the owner marked: a mark is a dish or a word in it ('가지' → 가지볶음). */
export function isDisliked(name, dislikes) {
  const n = normName(name)
  return (Array.isArray(dislikes) ? dislikes : []).some(w => { const k = normName(w); return k && n.includes(k) })
}

/** Adds or removes one mark on the plan (S.gplan.dislikes), stamped for sync like the rest of it. */
export function setDislike(S, word, on, now = Date.now()) {
  if (!S?.gplan) return
  const w = String(word || '').trim().slice(0, 30)
  if (!w) return
  const list = (Array.isArray(S.gplan.dislikes) ? S.gplan.dislikes : []).filter(x => normName(x) !== normName(w))
  S.gplan.dislikes = on ? [...list, w].slice(-60) : list
  S.gplan._ts = now
}

const FRIED = /까스|가스|카츠|튀김|강정|치킨|너겟|탕수육|크로켓/
// A dish with less than this per serving is not where lunch's protein comes from (전, 떡볶이).
const PROTEIN_MIN = 10
const MAX_SERVINGS = 2

// How much of each kind a plate starts with, before balancing: the rice finished (it is the
// training fuel, §2.2), soup for what is in it rather than the broth, everything else once.
const START = { rice: 1, noodle: 1, soup: 0.6, stew: 1, main: 1, side: 1, kimchi: 1, free: 1, fruit: 1, dairy: 1, dessert: 1, drink: 1 }

const isProteinDish = r => !r.disliked && r.amount > 0 && r.food.p >= PROTEIN_MIN && (r.food.cat === 'main' || (['soup', 'stew'].includes(r.food.cat) && r.food.p >= 15))

/**
 * How to eat one lunch. `dishes` from parseMenu; `target` from lunchTarget; `dislikes` the owner's
 * marks. Returns { rows, totals, target, short } where each row is
 *   { name, sauce, extra, food, how, disliked, amount, tips, n }
 * — `amount` in servings of the canteen's portion (0 = leave it), `tips` keys for the screen
 * ('disliked', 'extra', 'seconds', 'soup', 'stew', 'fried', 'skip', 'half', 'less-rice',
 * 'more-rice'), `n` the nutrition of that amount — and `short` the protein still missing after
 * every protein dish is at its most (the snack's job then).
 *
 * The order of the rules is the plan's order of priorities: protein first, then the budget,
 * and the budget is met by dropping dessert and starch before the rice, and never by protein.
 */
export function planLunch(dishes, { target = lunchTarget(null), dislikes = [] } = {}) {
  const rows = (dishes || []).map(d => {
    const { food, how } = findFood(d.name)
    const disliked = isDisliked(d.name, dislikes)
    const tips = []
    // A 탕 that is the meal's meat (삼계탕, 갈비탕) is eaten whole; a plain 국 for what is in it.
    const brothy = food.cat === 'soup' && food.p < 15
    let amount = (brothy ? START.soup : START[food.cat] ?? 1) * (d.portion || 1)
    if (brothy) tips.push('soup')
    if (food.cat === 'stew') tips.push('stew')
    if (food.cat === 'main' && FRIED.test(d.name)) tips.push('fried')
    if (d.extra && food.cat !== 'free') { amount = 0; tips.push('extra') }
    if (disliked) { amount = 0; tips.length = 0; tips.push('disliked') }
    return { name: d.name, sauce: d.sauce || '', extra: !!d.extra, food, how, disliked, amount, tips, n: null }
  })
  const total = () => {
    for (const r of rows) r.n = scaled(r.food, r.amount)
    return sumNutrition(rows.map(r => r.n))
  }

  // 1. Protein: more of the protein dish that brings the most protein per calorie, half a
  //    serving at a time, up to seconds.
  let t = total()
  for (let guard = 0; t.p < target.p && guard < 20; guard++) {
    const best = rows.filter(r => isProteinDish(r) && r.amount < MAX_SERVINGS)
      .sort((a, b) => b.food.p / Math.max(1, b.food.kcal) - a.food.p / Math.max(1, a.food.kcal))[0]
    if (!best) break
    best.amount = Math.min(MAX_SERVINGS, best.amount + 0.5)
    if (!best.tips.includes('seconds')) best.tips.push('seconds')
    t = total()
  }

  // 2. Over budget. The target is a share of the day, so a canteen lunch a little over it is
  //    fine; past the band, in this order (§2.2: the rice is training fuel, protein is fixed):
  //    a. dessert and sweet drinks, the biggest first — gone as soon as lunch is over at all;
  //    b. starchy dishes with little protein (떡볶이, 전, a second noodle, buttered potatoes):
  //       halved;
  //    c. only on a heavy day — still 300 over, when a usual canteen lunch of rice, a stew and
  //       two protein dishes is ~990 kcal and the plan says to finish the rice — the rice to ¾
  //       and those starchy dishes left out.
  const band = target.kcal + 150
  for (const r of rows.filter(r => r.amount > 0 && (r.food.cat === 'dessert' || (r.food.cat === 'drink' && r.food.p < 5))).sort((a, b) => b.food.kcal - a.food.kcal)) {
    if (t.kcal <= target.kcal + 50) break
    r.amount = 0
    r.tips.push('skip')
    t = total()
  }
  const hasRice = rows.some(r => r.amount > 0 && r.food.cat === 'rice')
  const starchy = rows.filter(r => r.amount > 0 && !isProteinDish(r) && r.food.kcal >= 150 && r.food.p / r.food.kcal < 0.04 &&
    (['main', 'side'].includes(r.food.cat) || (r.food.cat === 'noodle' && hasRice))).sort((a, b) => b.food.kcal - a.food.kcal)
  for (const r of starchy) {
    if (t.kcal <= band) break
    r.amount = Math.min(r.amount, 0.5)
    r.tips.push('half')
    t = total()
  }
  if (t.kcal > target.kcal + 300) {
    for (const r of rows.filter(r => r.amount >= 1 && ['rice', 'noodle'].includes(r.food.cat) && !starchy.includes(r))) {
      r.amount = 0.75
      r.tips.push('less-rice')
    }
    t = total()
    for (const r of starchy) {
      if (t.kcal <= band) break
      if (r.amount === 0) continue
      r.amount = 0
      r.tips = r.tips.filter(x => x !== 'half').concat('skip')
      t = total()
    }
  }

  // 3. Under budget with protein met: a little more rice, never past one and a half bowls.
  const rice = rows.find(r => r.food.cat === 'rice' && r.amount >= 1 && !r.disliked)
  for (let guard = 0; rice && t.p >= target.p && t.kcal < target.kcal - 120 && rice.amount < 1.5 && guard < 4; guard++) {
    rice.amount += 0.25
    if (!rice.tips.includes('more-rice')) rice.tips.push('more-rice')
    t = total()
  }

  return { rows, totals: t, target, short: Math.max(0, Math.round(target.p - t.p)) }
}

/** The plan as one meal for the log, named after its main dishes. */
export function lunchMealItem(plan, label) {
  const eaten = plan.rows.filter(r => r.amount > 0)
  const mains = eaten.filter(r => ['main', 'stew', 'soup', 'noodle'].includes(r.food.cat)).map(r => r.name)
  const names = (mains.length ? mains : eaten.map(r => r.name)).slice(0, 3).join(', ')
  return { name: (label + (names ? ': ' + names : '')).slice(0, 60), ...plan.totals }
}

/** Servings written as a cook would: 0.75 → '3/4', 1.5 → '1 1/2'. */
export function fmtServings(v) {
  const n = Math.round((Number(v) || 0) * 4) / 4
  const whole = Math.floor(n)
  const part = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' }[n - whole] || ''
  return whole && part ? whole + ' ' + part : part || String(whole)
}
