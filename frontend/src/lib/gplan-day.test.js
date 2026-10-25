import { describe, expect, it } from 'vitest'
import { addMeal, removeMeal, toggleSupp, setDayValue, saveTemplate, removeTemplate, dayOf, dayTotals, slotTotals, remaining, suppStreak, checklist, nextHint, loggedDays } from './gplan-day.js'

const plan = () => ({ targets: { kcal: 2400, p: 170, c: 285, f: 65 }, supps: [{ id: 'creatine', name: '크레아틴' }], goals: { waterMl: 3500, steps: 9000 }, templates: [] })
const D = '2026-10-25'

describe('logging a day', () => {
  it('adds meals per slot, stamps the day and sums it', () => {
    const S = { gplan: plan() }
    addMeal(S, D, 'b', { name: '잠봉', kcal: 480, p: 18, c: 55, f: 20 }, 10)
    addMeal(S, D, 'b', { name: '음료', kcal: 150, p: 25, c: 8, f: 3, tpl: 'tpl-drink' }, 11)
    addMeal(S, D, 'l', { name: '급식', kcal: 750.4, p: '40', c: 95, f: 20 }, 12)
    expect(S.gday[D]._ts).toBe(12)
    expect(slotTotals(dayOf(S, D), 'b')).toEqual({ kcal: 630, p: 43, c: 63, f: 23 })
    expect(dayTotals(dayOf(S, D))).toEqual({ kcal: 1380, p: 83, c: 158, f: 43 })
    expect(S.gday[D].meals.b[1].tpl).toBe('tpl-drink')
  })
  it('refuses an unknown slot and removes by id', () => {
    const S = {}
    expect(addMeal(S, D, 'x', { kcal: 1 })).toBeNull()
    const item = addMeal(S, D, 'd', { name: '포케', kcal: 700, p: 53 })
    removeMeal(S, D, 'd', item.id, 20)
    expect(dayOf(S, D).meals.d).toEqual([])
    expect(S.gday[D]._ts).toBe(20)
  })
  it('toggles supplements and sets water, steps and km', () => {
    const S = {}
    expect(toggleSupp(S, D, 'creatine')).toBe(true)
    expect(toggleSupp(S, D, 'creatine')).toBe(false)
    setDayValue(S, D, 'water', 1500)
    setDayValue(S, D, 'steps', '8200')
    setDayValue(S, D, 'nonsense', 3)
    setDayValue(S, D, 'km', null)
    expect(dayOf(S, D)).toMatchObject({ water: 1500, steps: 8200 })
    expect(dayOf(S, D).nonsense).toBeUndefined()
  })
  it('saves a logged meal as a template of its slot and removes it', () => {
    const S = { gplan: plan() }
    const tpl = saveTemplate(S, 'd', { id: 'x', name: '연어 덮밥', kcal: 650, p: 40, tpl: 'old' }, 7)
    expect(tpl).toMatchObject({ slot: 'd', name: '연어 덮밥', kcal: 650, p: 40 })
    expect(tpl.tpl).toBeUndefined()
    expect(S.gplan.templates).toHaveLength(1)
    removeTemplate(S, tpl.id)
    expect(S.gplan.templates).toHaveLength(0)
  })
  it('reads an empty day without a guard', () => {
    expect(dayTotals(dayOf({}, D))).toEqual({ kcal: 0, p: 0, c: 0, f: 0 })
    expect(remaining({ kcal: 2400, p: 170 }, { kcal: 2500, p: 100, c: 0, f: 0 })).toMatchObject({ kcal: -100, p: 70 })
  })
})

describe('supplement streak', () => {
  const took = days => ({ gday: Object.fromEntries(days.map(d => [d, { supps: { creatine: true } }])) })
  it('counts back from today, or from yesterday while today is still open', () => {
    expect(suppStreak(took(['2026-10-23', '2026-10-24', '2026-10-25']), 'creatine', D)).toBe(3)
    expect(suppStreak(took(['2026-10-23', '2026-10-24']), 'creatine', D)).toBe(2)
    expect(suppStreak(took(['2026-10-22', '2026-10-24']), 'creatine', D)).toBe(1)
    expect(suppStreak(took(['2026-10-20']), 'creatine', D)).toBe(0)
    expect(suppStreak({}, 'creatine', D)).toBe(0)
  })
  it('runs across a month boundary', () => {
    expect(suppStreak(took(['2026-10-31', '2026-11-01']), 'creatine', '2026-11-01')).toBe(2)
  })
})

describe('checklist', () => {
  it('lists supplements, meals, workout, water and steps', () => {
    const S = { gplan: plan() }
    toggleSupp(S, D, 'creatine')
    addMeal(S, D, 'b', { kcal: 100 })
    setDayValue(S, D, 'water', 3500)
    const c = checklist(S, D, { workoutDone: false })
    expect(c.rows.map(r => r.key)).toEqual(['supp:creatine', 'meal:b', 'meal:l', 'meal:s', 'meal:d', 'workout', 'water', 'steps'])
    expect(c.done).toBe(3)
    expect(c.total).toBe(8)
  })
  it('counts a rest day as the workout done, and takes the larger of logged and synced steps', () => {
    const S = { gplan: plan() }
    setDayValue(S, D, 'steps', 4000)
    const c = checklist(S, D, { restDay: true, synced: { steps: 9500 } })
    expect(c.rows.find(r => r.key === 'workout').done).toBe(true)
    expect(c.rows.find(r => r.key === 'steps').done).toBe(true)
  })
})

describe('next hint', () => {
  const t = plan().targets
  it('names protein and the next open meal first', () => {
    const S = {}
    addMeal(S, D, 'b', { kcal: 630, p: 43 })
    expect(nextHint(t, dayOf(S, D))).toEqual({ key: 'protein-next', args: [127, 'l'] })
  })
  it('asks for a protein top-up once every meal is in, then flags going over', () => {
    const S = {}
    for (const slot of ['b', 'l', 's', 'd']) addMeal(S, D, slot, { kcal: 500, p: 35 })
    expect(nextHint(t, dayOf(S, D))).toEqual({ key: 'protein-short', args: [30] })
    addMeal(S, D, 's', { kcal: 600, p: 40 })
    expect(nextHint(t, dayOf(S, D))).toEqual({ key: 'over', args: [200] })
  })
  it('is on track with protein met inside the budget', () => {
    const S = {}
    addMeal(S, D, 'l', { kcal: 2300, p: 170 })
    expect(nextHint(t, dayOf(S, D)).key).toBe('on-track')
  })
})

describe('logged days', () => {
  it('lists days newest first with totals and meal count', () => {
    const S = {}
    addMeal(S, '2026-10-24', 'b', { kcal: 100, p: 10 })
    addMeal(S, D, 'b', { kcal: 200, p: 20 })
    addMeal(S, D, 'd', { kcal: 300, p: 30 })
    expect(loggedDays(S).map(d => [d.iso, d.totals.kcal, d.meals])).toEqual([[D, 500, 2], ['2026-10-24', 100, 1]])
  })
})
