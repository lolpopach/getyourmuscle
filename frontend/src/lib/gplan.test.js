import { describe, expect, it } from 'vitest'
import { bmrKatch, bmrMifflin, estimateTdee, macroTargets, planFromProfile, projectPath, makePlan, saveBodycomp, removeBodycomp, bodycompList, starterTemplates } from './gplan.js'

// The owner's InBody of 2026-10-13 and the plan written from it (docs/dev/GETYOURMUSCLE_PLAN.md):
// 79.1 kg, 181 cm, 18, 18.4 % fat → 2,400 kcal, P170 C285 F65, never below 2,000.
const OWNER = { w: 79.1, h: 181, age: 18, sex: 'male', bf: 18.4 }

describe('energy', () => {
  it('matches the InBody basal rate from fat-free mass', () => {
    expect(Math.round(bmrKatch(64.5))).toBe(1763)
  })
  it('falls back to Mifflin-St Jeor without a body-fat reading', () => {
    expect(Math.round(bmrMifflin({ w: 79.1, h: 181, age: 18, sex: 'male' }))).toBe(1837)
    expect(estimateTdee({ w: 79.1, h: 181, age: 18, sex: 'male', activity: 1 })).toBe(1837)
  })
  it('adds walking and running on top of the activity factor', () => {
    const base = estimateTdee({ ...OWNER, activity: 1.5 })
    // ±1: the whole day is rounded once, not each part
    expect(Math.abs(estimateTdee({ ...OWNER, activity: 1.5, walkKm: 8 }) - base - 316)).toBeLessThanOrEqual(1)
    expect(Math.abs(estimateTdee({ ...OWNER, activity: 1.5, runKm: 3 }) - base - 237)).toBeLessThanOrEqual(1)
  })
})

describe('targets', () => {
  it('reproduces the written plan for the owner', () => {
    const plan = planFromProfile(OWNER)
    expect(plan.targets).toEqual({ kcal: 2400, p: 170, c: 285, f: 65 })
    expect(plan.minKcal).toBe(2000)
  })
  it('keeps the grams within a few kcal of the intake', () => {
    for (const kcal of [1800, 2150, 2400, 2900]) {
      const t = macroTargets({ kcal, w: 79 })
      expect(Math.abs(t.p * 4 + t.c * 4 + t.f * 9 - kcal)).toBeLessThan(25)
    }
  })
  it('never lets fat fall under its floor, nor carbs under zero', () => {
    const t = macroTargets({ kcal: 1200, w: 60, fatPerKg: 0.5 })
    expect(t.f).toBe(55)
    expect(t.c).toBeGreaterThanOrEqual(0)
  })
})

describe('projected path', () => {
  it('lands on the plan’s check dates', () => {
    const path = projectPath({ startIso: '2026-10-13', startW: 79.1, startFatKg: 14.6, rateKgWk: 0.45, dates: ['2026-11-09', '2026-12-07', '2027-01-11'] })
    expect(path.map(p => p.w)).toEqual([77.4, 75.6, 73.3])
    expect(path.at(-1).bf).toBe(12.4)
  })
  it('has no body fat without a starting fat mass, and never runs backwards in time', () => {
    const [p] = projectPath({ startIso: '2026-10-13', startW: 80, rateKgWk: 0.5, dates: ['2026-10-01'] })
    expect(p).toEqual({ d: '2026-10-01', w: 80, fatKg: null, bf: null })
  })
})

describe('makePlan', () => {
  const answers = { ...OWNER, activity: 1.5, walkKm: 6, runKm: 0, rateKgWk: 0.45, targetW: 73.5, targetBf: 12, start: '2026-10-13', end: '2027-01-11' }
  it('seeds the owner’s meals and creatine', () => {
    const plan = makePlan(answers, null, 1)
    expect(plan.templates).toEqual(starterTemplates())
    expect(plan.supps.map(s => s.id)).toEqual(['creatine'])
    expect(plan.targets.kcal).toBe(2400)
    expect(plan.history).toEqual([{ at: 1, kcal: 2400, reason: 'start' }])
  })
  it('keeps edited templates and supplements when the numbers change', () => {
    const prev = { ...makePlan(answers, null, 1), templates: [{ id: 'mine', slot: 'b', name: 'x' }], supps: [] }
    const next = makePlan({ ...answers, rateKgWk: 0.6 }, prev, 2)
    expect(next.templates).toEqual(prev.templates)
    expect(next.supps).toEqual([])
    expect(next.history.map(h => h.reason)).toEqual(['start', 'edit'])
    expect(next.targets.kcal).toBeLessThan(prev.targets.kcal)
  })
})

describe('body composition', () => {
  it('stores a reading, derives fat-free mass and logs the weight as a weigh-in', () => {
    const S = { bodyweight: [{ d: '2026-10-20', w: 78.2, t: 1 }] }
    saveBodycomp(S, '2026-10-13', { w: 79.1, smm: 36.6, fatKg: 14.6, bf: 18.4, visceral: 6, junk: 'x', note: '20:13' }, 5)
    expect(S.bodycomp['2026-10-13']).toEqual({ _ts: 5, w: 79.1, smm: 36.6, fatKg: 14.6, bf: 18.4, visceral: 6, ffm: 64.5, note: '20:13' })
    expect(S.bodyweight.map(b => b.d)).toEqual(['2026-10-13', '2026-10-20'])
    saveBodycomp(S, '2026-10-20', { w: 78 }, 6)
    expect(S.bodyweight.find(b => b.d === '2026-10-20')).toEqual({ d: '2026-10-20', w: 78, t: 6 })
    expect(bodycompList(S).map(r => r.d)).toEqual(['2026-10-13', '2026-10-20'])
    removeBodycomp(S, '2026-10-20')
    expect(bodycompList(S).map(r => r.d)).toEqual(['2026-10-13'])
  })
})
