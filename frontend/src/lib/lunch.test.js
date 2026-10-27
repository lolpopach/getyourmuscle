import { describe, expect, it } from 'vitest'
import { fmtServings, isDisliked, lunchMealItem, lunchTarget, parseDish, parseMenu, planLunch, setDislike } from './lunch.js'

// Lunches as the school's menu page lists them (kshcm.net, October and June 2026).
const OCT_1 = ['흰쌀밥', '순두부찌개(0.6)', '소불고기', '치즈계란말이*케찹', '열무김치', '파인애플']
const OCT_5 = ['흰쌀밥', '소고기미역국(0.5)', '치킨너겟*머스타드소스', '감자버터구이', '깍두기', '꿀떡']
const OCT_8 = ['햄계란볶음밥', '미니어묵우동(0.5)', '돈까스*브라운소스', '매콤떡볶이', '깍두기', '순대찜*소금']
const target = lunchTarget({ kcal: 2400, p: 170 })
const row = (plan, name) => plan.rows.find(r => r.name === name)

describe('reading the menu', () => {
  it('takes the salt %, sauces, fractions and the extra counter apart', () => {
    expect(parseDish('순두부찌개(0.6)')).toEqual([{ raw: '순두부찌개(0.6)', name: '순두부찌개', sauce: '', portion: 1, extra: false }])
    expect(parseDish('치즈계란말이*케찹')[0]).toMatchObject({ name: '치즈계란말이', sauce: '케찹' })
    expect(parseDish('바나나1/2')[0]).toMatchObject({ name: '바나나', portion: 0.5 })
    expect(parseDish('상추쌈(추가배식대-자율)')[0]).toMatchObject({ name: '상추쌈', extra: true })
    expect(parseDish('망고 (추가배식대 : 흰쌀밥, 배추된장국)').map(d => [d.name, d.extra])).toEqual([['망고', false], ['흰쌀밥', true], ['배추된장국', true]])
    expect(parseDish('타코야키&nbsp;<span style="x"></span>')[0].name).toBe('타코야키')
    expect(parseMenu(['', '  ', null])).toEqual([])
  })

  it('takes lunch as about a third of the day', () => {
    expect(lunchTarget({ kcal: 2400, p: 170 })).toEqual({ kcal: 740, p: 40 })
    expect(lunchTarget(null)).toEqual({ kcal: 740, p: 40 })
  })
})

describe('how to eat it', () => {
  it('finishes the rice, eats the soup for what is in it and reaches the protein', () => {
    const plan = planLunch(parseMenu(OCT_1), { target })
    expect(row(plan, '흰쌀밥').amount).toBe(1)
    expect(row(plan, '순두부찌개').tips).toContain('stew')
    expect(plan.totals.p).toBeGreaterThanOrEqual(target.p)
    expect(plan.short).toBe(0)
  })

  it('asks for seconds of the protein dish, and drops dessert before anything else', () => {
    const plan = planLunch(parseMenu(OCT_5), { target })
    expect(row(plan, '치킨너겟').amount).toBe(2)
    expect(row(plan, '치킨너겟').tips).toEqual(['fried', 'seconds'])
    expect(row(plan, '꿀떡')).toMatchObject({ amount: 0, tips: ['skip'] })
    expect(row(plan, '소고기미역국').tips).toContain('soup')
  })

  it('cuts the starch of a heavy day before the rice is ever below ¾, and never the protein', () => {
    const plan = planLunch(parseMenu(OCT_8), { target })
    expect(row(plan, '매콤떡볶이').amount).toBe(0)
    expect(row(plan, '미니어묵우동').amount).toBe(0)
    expect(row(plan, '햄계란볶음밥').amount).toBe(0.75)
    expect(row(plan, '돈까스').amount).toBe(1)
    expect(plan.totals.p).toBeGreaterThanOrEqual(target.p)
  })

  it('leaves out what the owner does not eat and makes the protein up elsewhere', () => {
    const plain = planLunch(parseMenu(OCT_1), { target })
    const plan = planLunch(parseMenu(OCT_1), { target, dislikes: ['소불고기'] })
    expect(row(plan, '소불고기')).toMatchObject({ amount: 0, disliked: true, tips: ['disliked'] })
    expect(row(plan, '치즈계란말이').amount).toBeGreaterThan(row(plain, '치즈계란말이').amount)
    expect(plan.totals.p).toBeGreaterThanOrEqual(target.p)
  })

  it('says how much protein is still missing when nothing on the menu can bring it', () => {
    const plan = planLunch(parseMenu(['흰쌀밥', '콩나물국', '시금치나물', '배추김치']), { target })
    expect(plan.short).toBeGreaterThan(20)
  })

  it('adds a little rice on a light day, never past one and a half bowls', () => {
    const plan = planLunch(parseMenu(['흰쌀밥', '닭가슴살', '닭가슴살구이', '배추김치']), { target: { kcal: 900, p: 40 } })
    expect(row(plan, '흰쌀밥').amount).toBe(1.5)
  })
})

describe('marks and the log', () => {
  it('marks a dish or a word in it, stamped on the plan', () => {
    const S = { gplan: { _ts: 1 } }
    setDislike(S, '가지', true, 5)
    setDislike(S, ' 가지 ', true, 6)
    setDislike(S, '버섯', true, 7)
    expect(S.gplan).toMatchObject({ dislikes: ['가지', '버섯'], _ts: 7 })
    expect(isDisliked('가지볶음', S.gplan.dislikes)).toBe(true)
    expect(isDisliked('새송이 버섯구이', S.gplan.dislikes)).toBe(true)
    expect(isDisliked('소불고기', S.gplan.dislikes)).toBe(false)
    setDislike(S, '가지', false, 8)
    expect(S.gplan.dislikes).toEqual(['버섯'])
    setDislike({}, '가지', true)
  })

  it('logs the plan as one meal named after its main dishes', () => {
    const plan = planLunch(parseMenu(OCT_1), { target })
    expect(lunchMealItem(plan, '급식')).toEqual({ name: '급식: 순두부찌개, 소불고기, 치즈계란말이', ...plan.totals })
  })

  it('writes servings as fractions', () => {
    expect([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(fmtServings)).toEqual(['0', '1/4', '1/2', '3/4', '1', '1 1/4', '1 1/2', '2'])
  })
})
