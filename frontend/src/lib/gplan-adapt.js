// The weekly check of a G-PLAN (docs/dev/GETYOURMUSCLE_PLAN.md §4.7). The starting intake is an
// estimate; after two weeks of weigh-ins and logged meals the real burn can be read back:
//
//   real daily use ≈ average intake + (kg lost per week × 7,700 / 7)
//
// and the intake moved 125 kcal when the loss is outside the plan's band. Nothing is applied on
// its own: the screen shows the suggestion and the owner accepts it (applyAdjustment).
import { KCAL_PER_KG, SLOTS, macroTargets } from './gplan.js'
import { dayTotals, slotLogged } from './gplan-day.js'

const DAY = 86400000
const isoMinus = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') - n * DAY).toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY)
const mean = xs => xs.reduce((a, x) => a + x, 0) / xs.length

export const STEP_KCAL = 125
// The first two weeks move the scale with glycogen and water, not fat: no verdict before day 21.
export const SETTLE_DAYS = 21

// A day counts as logged once three of its four meals are in: a forgotten snack should not
// throw the week out, a forgotten dinner should.
const isLogged = day => SLOTS.filter(s => slotLogged(day, s)).length >= 3

/**
 * The verdict for the two weeks ending `todayIso`:
 *   { status: 'none' }                       no plan
 *   { status: 'wait', daysLeft }             too early (SETTLE_DAYS)
 *   { status: 'need-weighins', have }        fewer than 3 weigh-ins in one of the two weeks
 *   { status: 'need-logs', have }            fewer than 10 logged days of 14
 *   { status: 'ok' | 'lower' | 'raise' | 'floor', rate, pct, avgIntake, estTdee, suggested }
 * `rate` is kg lost per week (negative = gained); `suggested` the intake to switch to, or the
 * current one for 'ok' and 'floor' ('floor': it should go down but is at the plan's minimum —
 * walk more instead).
 */
export function weeklyCheck(S, todayIso) {
  const plan = S?.gplan
  if (!plan?.targets) return { status: 'none' }
  const since = plan.start ? daysBetween(plan.start, todayIso) : SETTLE_DAYS
  if (since < SETTLE_DAYS) return { status: 'wait', daysLeft: SETTLE_DAYS - since }

  const inRange = (b, from, to) => b?.d >= from && b?.d <= to && Number(b.w) > 0
  const bw = Array.isArray(S.bodyweight) ? S.bodyweight : []
  const weekA = bw.filter(b => inRange(b, isoMinus(todayIso, 13), isoMinus(todayIso, 7))).map(b => Number(b.w))
  const weekB = bw.filter(b => inRange(b, isoMinus(todayIso, 6), todayIso)).map(b => Number(b.w))
  if (weekA.length < 3 || weekB.length < 3) return { status: 'need-weighins', have: Math.min(weekA.length, weekB.length) }

  const days = Array.from({ length: 14 }, (_, i) => S.gday?.[isoMinus(todayIso, i)]).filter(d => d && isLogged(d))
  if (days.length < 10) return { status: 'need-logs', have: days.length }

  const rate = mean(weekA) - mean(weekB)
  const avgIntake = Math.round(mean(days.map(d => dayTotals(d).kcal)))
  const estTdee = Math.round(avgIntake + (rate * KCAL_PER_KG) / 7)
  const target = Number(plan.rateKgWk) || 0.45
  const cur = Number(plan.targets.kcal)
  const floor = Number(plan.minKcal) || 0
  let status = 'ok', suggested = cur
  if (rate < target * 0.6) {
    suggested = Math.max(floor, cur - STEP_KCAL)
    status = suggested < cur ? 'lower' : 'floor'
  } else if (rate > target * 1.6) {
    suggested = cur + STEP_KCAL
    status = 'raise'
  }
  return {
    status, rate: Math.round(rate * 100) / 100, pct: Math.round((rate / mean(weekA)) * 1000) / 10,
    avgIntake, estTdee, suggested,
  }
}

/** Accepts a suggestion: new intake, macros redone for the latest weight, the change recorded. */
export function applyAdjustment(S, kcal, weight, reason, now = Date.now()) {
  if (!S.gplan) return
  S.gplan.targets = macroTargets({ kcal, w: weight || S.gplan.startW })
  S.gplan.history = [...(S.gplan.history || []), { at: now, kcal, reason }].slice(-50)
  S.gplan._ts = now
}
