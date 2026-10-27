import { describe, expect, it } from 'vitest'
import { calcMealItem, calcRow, calcTotals, clampServings, countInPieces, renameRow, rowFood, rowNutrition, rowPiece, rowServings, rowsFromPhoto, setPieces } from './food-calc.js'

describe('the calculator', () => {
  it('counts half a bowl of rice from the table, not from anything typed', () => {
    const rice = calcRow('흰쌀밥', 0.5)
    expect(rowNutrition(rice)).toEqual({ kcal: 155, p: 3, c: 34, f: 0.5 })
    expect(rowFood(rice).how).toBe('exact')
  })

  it('keeps servings in quarter steps between 0 and 12', () => {
    expect([0.6, -1, 20, 'x', 1.25].map(clampServings)).toEqual([0.5, 0, 12, 1, 1.25])
  })

  it('takes a photo row from the table when the table knows the dish, whatever the model said', () => {
    const [row] = rowsFromPhoto([{ name: '제육볶음', servings: 1, kcal: 900, p: 5, c: 1, f: 1 }])
    expect(rowNutrition(row).kcal).toBe(330)
    expect(rowFood(row).how).toBe('exact')
  })

  it('uses the model\'s numbers, per serving, only for a dish the table can only guess', () => {
    const [row] = rowsFromPhoto([{ name: '유린기', servings: 2, kcal: 600, p: 40, c: 30, f: 30 }])
    expect(rowFood(row).how).toBe('ai')
    expect(rowNutrition(row)).toMatchObject({ kcal: 600, p: 40 })
    expect(rowNutrition({ ...row, servings: 1 })).toMatchObject({ kcal: 300, p: 20 })
    // Renamed, the estimate belonged to another dish.
    const renamed = renameRow(row, '깐풍기')
    expect(renamed.ai).toBeNull()
    expect(rowFood(renamed).how).toBe('guess')
  })

  it('adds up a plate and names the meal after its dishes', () => {
    const rows = [calcRow('흰쌀밥', 1), calcRow('닭가슴살', 2), calcRow('배추김치', 1), calcRow('바나나', 1), calcRow('', 1), calcRow('사과', 0)]
    expect(calcTotals(rows)).toEqual({ kcal: 635, p: 54, c: 96, f: 5 })
    expect(calcMealItem(rows, 'Meal')).toEqual({ name: '흰쌀밥, 닭가슴살, 배추김치 …', kcal: 635, p: 54, c: 96, f: 5 })
    expect(calcMealItem([], 'Meal')).toEqual({ name: 'Meal', kcal: 0, p: 0, c: 0, f: 0 })
  })
})

describe('a shared table', () => {
  // Three people: 3 servings of 삼겹살 and a pot of 김치찌개 for three on the table, and the
  // owner's own bowl of rice.
  const table = () => [calcRow('삼겹살', 3, null, { shared: true }), calcRow('김치찌개', 3, null, { shared: true }), calcRow('흰쌀밥', 1)]

  it('counts the owner\'s share of the shared dishes and all of their own', () => {
    const rows = table()
    // A third of 990 + 540 kcal, and the whole 310 kcal bowl.
    expect(calcTotals(rows, 1 / 3)).toMatchObject({ kcal: 820, p: 34 })
    expect(calcTotals(rows, 0.5).kcal).toBe(1075)
    expect(calcTotals(rows, 1).kcal).toBe(1840)
    expect(rowNutrition(rows[0], 1 / 3).kcal).toBe(330)
  })

  it('names a meal with shared dishes in it, and only then', () => {
    const sharedName = (names, pct) => `${names} (shared ${pct}%)`
    expect(calcMealItem(table(), 'Meal', { share: 0.35, sharedName }).name).toBe('삼겹살, 김치찌개, 흰쌀밥 (shared 35%)')
    expect(calcMealItem([calcRow('흰쌀밥', 1)], 'Meal', { share: 0.35, sharedName }).name).toBe('흰쌀밥')
  })

  it('counts 삼겹살 by the slice as what the owner ate, never shared again', () => {
    const [meat] = table()
    expect(rowPiece(meat)).toEqual({ kind: 'slice', g: 17 })
    const counted = countInPieces(meat, true)
    expect(counted).toMatchObject({ pieces: 18, shared: false })
    const nine = setPieces(counted, 9)
    expect(rowServings(nine)).toBeCloseTo(1.53, 2)
    expect(rowNutrition(nine, 1 / 3)).toMatchObject({ kcal: 505, p: 26 })
    // Back in servings, rounded to a quarter; renamed, the pieces were of the old dish.
    expect(countInPieces(nine, false)).toMatchObject({ pieces: null, servings: 1.5 })
    expect(renameRow(nine, '목살')).toMatchObject({ pieces: null, servings: 1.5 })
    expect(setPieces(nine, 99).pieces).toBe(60)
  })

  it('has no pieces for a dish nobody counts', () => {
    const stew = calcRow('김치찌개', 1)
    expect(rowPiece(stew)).toBeNull()
    expect(countInPieces(stew, true)).toBe(stew)
  })

  it('keeps each photo\'s rows apart, so one photo can be read again on its own', () => {
    const rows = rowsFromPhoto([{ name: '치킨', servings: 2 }], { src: 'p2', shared: true })
    expect(rows[0]).toMatchObject({ src: 'p2', shared: true, servings: 2 })
  })
})
