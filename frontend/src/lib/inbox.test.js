import { describe, expect, it } from 'vitest'
import { addMeal, dayOf, dayTotals } from './gplan-day.js'
import { applyInboxResults, needsClaude, pendingCount, resultDetail } from './inbox.js'
import { calcRow } from './food-calc.js'

const D = '2026-10-27'
const answer = (id, mealId, kcal = 570) => ({ id, date: D, slot: 'd', mealId, status: 'done', result: { items: [{ name: '꿔바로우', amount: '1/3접시', kcal: kcal - 310, p: 9, c: 30, f: 11 }, { name: '흰쌀밥', amount: '1공기', kcal: 310, p: 6, c: 68, f: 1 }], kcal, p: 15, c: 98, f: 12, note: '', by: 'claude' } })

describe('what goes to Claude', () => {
  it('sends a photo, an empty reading or a dish the table cannot settle; not a plain known meal', () => {
    expect(needsClaude([calcRow('제육덮밥', 1), calcRow('흰쌀밥', 1)], null)).toBe(false)
    expect(needsClaude([calcRow('제육덮밥', 1)], 'data:image/jpeg;base64,AAAA')).toBe(true)
    expect(needsClaude([calcRow('훠궈', 1)], null)).toBe(true)
    expect(needsClaude([calcRow('오징어덮밥', 1)], null)).toBe(true)
    expect(needsClaude([], null)).toBe(true)
  })
})

describe('putting Claude\'s answers into the log', () => {
  it('replaces the table\'s numbers of the pending meal, stamps the day and keeps the name', () => {
    const S = {}
    const meal = addMeal(S, D, 'd', { name: '꿔바로우, 밥', kcal: 390, p: 14, pending: 'm0001' }, 1)
    expect(pendingCount(dayOf(S, D))).toBe(1)
    const ids = applyInboxResults(S, [answer('m0001', meal.id)], 5)
    expect(ids).toEqual(['m0001'])
    expect(dayOf(S, D).meals.d[0]).toEqual({ id: meal.id, name: '꿔바로우, 밥', kcal: 570, p: 15, c: 98, f: 12, by: 'claude', detail: '꿔바로우 1/3접시 · 흰쌀밥 1공기' })
    expect(S.gday[D]._ts).toBe(5)
    expect(dayTotals(dayOf(S, D)).kcal).toBe(570)
    expect(pendingCount(dayOf(S, D))).toBe(0)
  })

  it('acknowledges an answer whose meal was deleted, and skips what is not answered yet', () => {
    const S = {}
    const ids = applyInboxResults(S, [answer('gone', 'x'), { id: 'wait', date: D, slot: 'd', status: 'pending', result: null }])
    expect(ids).toEqual(['gone'])
    expect(applyInboxResults(S, null)).toEqual([])
  })

  it('writes an answer\'s detail line', () => {
    expect(resultDetail({ items: [{ name: '김치', amount: '' }, { name: '밥', amount: '1공기' }] })).toBe('김치 · 밥 1공기')
    expect(resultDetail(null)).toBe('')
  })
})
