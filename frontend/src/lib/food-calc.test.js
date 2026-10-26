import { describe, expect, it } from 'vitest'
import { calcMealItem, calcRow, calcTotals, clampServings, renameRow, rowFood, rowNutrition, rowsFromPhoto } from './food-calc.js'

describe('the calculator', () => {
  it('counts half a bowl of rice from the table, not from anything typed', () => {
    const rice = calcRow('흰쌀밥', 0.5)
    expect(rowNutrition(rice)).toEqual({ kcal: 155, p: 3, c: 34, f: 0.5 })
    expect(rowFood(rice).how).toBe('exact')
  })

  it('keeps servings in quarter steps between 0 and 6', () => {
    expect([0.6, -1, 9, 'x', 1.25].map(clampServings)).toEqual([0.5, 0, 6, 1, 1.25])
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
