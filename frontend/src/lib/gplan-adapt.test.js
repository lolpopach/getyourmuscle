import { describe, expect, it } from 'vitest'
import { weeklyCheck, applyAdjustment } from './gplan-adapt.js'

const TODAY = '2026-11-20'
const isoMinus = n => new Date(Date.parse(TODAY + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10)

// Two weeks: weigh-ins every day falling `perWeek` kg a week from 78, and `logged` days of
// four meals at `kcal`.
function state({ perWeek = 0.45, kcal = 2400, logged = 14, start = '2026-10-13', weighIns = 14 } = {}) {
  const bodyweight = Array.from({ length: weighIns }, (_, i) => ({ d: isoMinus(13 - i), w: 78 - (perWeek / 7) * i, t: i }))
  const gday = {}
  for (let i = 0; i < logged; i++) {
    gday[isoMinus(i)] = { meals: { b: [{ kcal: kcal / 4 }], l: [{ kcal: kcal / 4 }], s: [{ kcal: kcal / 4 }], d: [{ kcal: kcal / 4 }] } }
  }
  return { bodyweight, gday, gplan: { start, rateKgWk: 0.45, minKcal: 2000, targets: { kcal: 2400, p: 170, c: 285, f: 65 } } }
}

describe('weekly check', () => {
  it('has nothing to say without a plan, and waits out the first three weeks', () => {
    expect(weeklyCheck({}, TODAY)).toEqual({ status: 'none' })
    expect(weeklyCheck(state({ start: '2026-11-10' }), TODAY)).toEqual({ status: 'wait', daysLeft: 11 })
  })
  it('asks for weigh-ins and logged meals before judging', () => {
    expect(weeklyCheck(state({ weighIns: 9 }), TODAY).status).toBe('need-weighins')
    expect(weeklyCheck(state({ logged: 9 }), TODAY)).toEqual({ status: 'need-logs', have: 9 })
  })
  it('keeps the intake while the loss is in the band, and reads the real burn back', () => {
    const r = weeklyCheck(state({ perWeek: 0.45, kcal: 2400 }), TODAY)
    expect(r.status).toBe('ok')
    expect(r.rate).toBeCloseTo(0.45, 1)
    expect(r.avgIntake).toBe(2400)
    expect(r.estTdee).toBeGreaterThan(2850)
    expect(r.suggested).toBe(2400)
  })
  it('suggests 125 kcal less when the loss stalls, and more when it runs too fast', () => {
    expect(weeklyCheck(state({ perWeek: 0.1 }), TODAY)).toMatchObject({ status: 'lower', suggested: 2275 })
    expect(weeklyCheck(state({ perWeek: 1.0 }), TODAY)).toMatchObject({ status: 'raise', suggested: 2525 })
  })
  it('never goes under the plan’s floor', () => {
    const S = state({ perWeek: 0 })
    S.gplan.targets.kcal = 2050
    expect(weeklyCheck(S, TODAY)).toMatchObject({ status: 'lower', suggested: 2000 })
    S.gplan.targets.kcal = 2000
    expect(weeklyCheck(S, TODAY)).toMatchObject({ status: 'floor', suggested: 2000 })
  })
  it('counts a day with three of four meals as logged', () => {
    const S = state({ logged: 14 })
    for (const d of Object.values(S.gday)) delete d.meals.s
    expect(weeklyCheck(S, TODAY).status).toBe('ok')
  })
})

describe('applying an adjustment', () => {
  it('redoes the macros for the latest weight and records why', () => {
    const S = state()
    applyAdjustment(S, 2275, 77, 'weekly', 9)
    expect(S.gplan.targets.kcal).toBe(2275)
    expect(S.gplan.targets.p).toBe(165)
    expect(S.gplan.history).toEqual([{ at: 9, kcal: 2275, reason: 'weekly' }])
    expect(S.gplan._ts).toBe(9)
  })
})
