import { describe, expect, it } from 'vitest'
import { FOODS, findFood, foodNames, normName, scaled, setMyFoods, sumNutrition } from './foods.js'

describe('the food table', () => {
  it('has one row per spelling and numbers that add up', () => {
    const seen = new Set()
    for (const f of FOODS) {
      for (const n of [f.name, ...f.aliases]) {
        expect(seen.has(normName(n)), n).toBe(false)
        seen.add(normName(n))
      }
      // 4/4/9 kcal per gram of protein/carbs/fat, within what fibre, alcohol-free rounding and
      // sugar alcohols leave over: a row that is far off has a typo in it.
      const fromMacros = f.p * 4 + f.c * 4 + f.f * 9
      expect(Math.abs(fromMacros - f.kcal), f.name).toBeLessThanOrEqual(Math.max(25, f.kcal * 0.2))
    }
  })

  it('reads a bowl of rice as 310 kcal', () => {
    expect(findFood('흰쌀밥')).toMatchObject({ how: 'exact', food: { cat: 'rice', g: 210, kcal: 310 } })
    expect(findFood('밥 1공기'.replace(' 1공기', ''))?.food.name).toBe('흰쌀밥')
  })
})

describe('finding a dish', () => {
  it('matches spellings, spaces and sauces as written on a menu', () => {
    expect(findFood('흑미밥').food.name).toBe('흑미밥')
    expect(findFood('잡곡밥').food.name).toBe('흑미밥')
    expect(findFood('흰 쌀밥').how).toBe('exact')
    expect(findFood('돈까스*브라운소스')).toMatchObject({ how: 'exact', food: { name: '돈까스' } })
    expect(findFood('소고기미역국').food.name).toBe('미역국')
  })

  it('takes a dish it does not know by the dish it ends in', () => {
    expect(findFood('오징어덮밥')).toMatchObject({ how: 'similar', food: { name: '덮밥' } })
    expect(findFood('매운닭갈비')).toMatchObject({ how: 'similar', food: { name: '닭갈비' } })
  })

  it('lets the meat in a name decide over a vegetable dish it ends in', () => {
    // 김치볶음 alone is a 50 kcal side; with pork in it, it is the meal's protein dish.
    const r = findFood('돼지김치볶음')
    expect(r.how).toBe('guess')
    expect(r.food.cat).toBe('main')
    expect(r.food.p).toBeGreaterThanOrEqual(15)
  })

  it('guesses from how a dish was cooked, and from nothing as a light side', () => {
    expect(findFood('가지볶음')).toMatchObject({ how: 'guess', food: { cat: 'side', name: '가지볶음' } })
    expect(findFood('고등어조림').food.cat).toBe('main')
    expect(findFood('소고기콩나물국').food.cat).toBe('soup')
    expect(findFood('훠궈').how).toBe('guess')
    expect(findFood('')).toBeNull()
  })
})

describe('amounts', () => {
  it('scales a serving and sums a plate', () => {
    const rice = findFood('흰쌀밥').food
    expect(scaled(rice, 0.5)).toEqual({ kcal: 155, p: 3, c: 34, f: 0.5 })
    expect(scaled(rice, -1)).toEqual({ kcal: 0, p: 0, c: 0, f: 0 })
    const chicken = findFood('닭가슴살').food
    expect(sumNutrition([scaled(rice, 1), scaled(chicken, 2)])).toEqual({ kcal: 530, p: 52, c: 70, f: 5 })
  })
})

describe('the owner\'s own foods', () => {
  it('are looked up before the table, by the same spelling rules, and can be replaced', () => {
    setMyFoods([{ name: '꿔 바로우', g: 200, kcal: 520, p: 18, c: 60, f: 22 }, { name: '흰쌀밥', cat: 'rice', g: 200, kcal: 290, p: 5, c: 64, f: 1 }, { name: '', kcal: 5 }, { name: '빈 것', kcal: 0 }, { name: '무쌈', cat: 'pickle', g: 30, kcal: 10 }])
    try {
      expect(findFood('꿔바로우')).toMatchObject({ how: 'mine', food: { name: '꿔 바로우', cat: 'main', g: 200, kcal: 520 } })
      // The owner's own bowl of rice wins over the table's, and is still a bowl of rice.
      expect(findFood('흰쌀밥')).toMatchObject({ how: 'mine', food: { cat: 'rice', kcal: 290 } })
      // A category the table does not have is a main dish.
      expect(findFood('무쌈').food.cat).toBe('main')
      expect(findFood('빈것').how).toBe('guess')
      expect(foodNames()).toContain('꿔 바로우')
    } finally {
      setMyFoods([])
    }
    expect(findFood('흰쌀밥').how).toBe('exact')
  })
})
