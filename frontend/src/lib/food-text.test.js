import { describe, expect, it } from 'vitest'
import { parseDishText, rowsFromText, splitMeal } from './food-text.js'
import { calcTotals, rowFood, rowNutrition, rowServings } from './food-calc.js'

const read = text => rowsFromText(text).map(r => [rowFood(r).food.name, Math.round(rowServings(r) * 100) / 100, r.pieces, rowNutrition(r).kcal])

describe('splitting what was written into dishes', () => {
  it('splits at commas, plus signs, new lines and 랑 / 이랑 / 하고', () => {
    expect(splitMeal('제육덮밥, 계란후라이 2개\n밥 반 공기 + 김치')).toEqual(['제육덮밥', '계란후라이 2개', '밥 반 공기', '김치'])
    expect(splitMeal('닭가슴살 2개랑 바나나 하나')).toEqual(['닭가슴살 2개', '바나나 하나'])
    expect(splitMeal('치킨이랑 콜라')).toEqual(['치킨', '콜라'])
    expect(splitMeal('라면하고 공기밥')).toEqual(['라면', '공기밥'])
  })

  it('splits after an amount, keeping "반" with it', () => {
    expect(splitMeal('피자 2조각 콜라 1캔')).toEqual(['피자 2조각', '콜라 1캔'])
    expect(splitMeal('밥 한 공기 반 김치')).toEqual(['밥 한 공기 반', '김치'])
    expect(splitMeal('제육볶음 1인분 밥 1공기 계란후라이 1개')).toEqual(['제육볶음 1인분', '밥 1공기', '계란후라이 1개'])
  })

  it('splits at 과 / 와 only where the word without it is a dish ("사과" stays)', () => {
    expect(splitMeal('계란과 토스트')).toEqual(['계란', '토스트'])
    expect(splitMeal('사과 2개')).toEqual(['사과 2개'])
  })
})

describe('reading one dish', () => {
  it('reads numbers, number words, fractions and "반"', () => {
    expect(parseDishText('계란후라이 2개')).toEqual({ name: '계란후라이', qty: 2, unit: '개', kind: 'piece' })
    expect(parseDishText('밥 한 공기 반')).toEqual({ name: '밥', qty: 1.5, unit: '공기', kind: 'serving' })
    expect(parseDishText('밥 1/2공기')).toMatchObject({ qty: 0.5, kind: 'serving' })
    expect(parseDishText('치킨 반마리')).toMatchObject({ name: '치킨', qty: 0.5, kind: 'whole' })
    expect(parseDishText('우유 200ml')).toMatchObject({ name: '우유', qty: 200, kind: 'gram' })
    expect(parseDishText('바나나 하나')).toMatchObject({ name: '바나나', qty: 1, kind: null })
    expect(parseDishText('계란 2')).toMatchObject({ name: '계란', qty: 2 })
  })

  it('reads amounts said in words, drops what says nothing, and keeps names it does not know', () => {
    expect(parseDishText('된장찌개 조금')).toMatchObject({ name: '된장찌개', qty: 0.5 })
    expect(parseDishText('짜장면 곱빼기')).toMatchObject({ name: '짜장면', qty: 1.5 })
    expect(parseDishText('밥 반만 먹었어')).toMatchObject({ name: '밥', qty: 0.5 })
    expect(parseDishText('김치찌개를 먹었어')).toMatchObject({ name: '김치찌개', qty: null })
    expect(parseDishText('편의점 크림빵')).toMatchObject({ name: '편의점 크림빵', qty: null })
    // A number word alone is not an amount: 삼겹살 is not three of anything.
    expect(parseDishText('삼겹살')).toMatchObject({ name: '삼겹살', qty: null })
    expect(parseDishText('반')).toBeNull()
  })
})

describe('the rows the meal sheet counts', () => {
  it('turns amounts into servings or pieces of the table\'s food', () => {
    expect(read('제육덮밥, 계란후라이 2개, 밥 반 공기')).toEqual([['제육덮밥', 1, null, 720], ['계란후라이', 2, 2, 180], ['흰쌀밥', 0.5, null, 155]])
    expect(read('삼겹살 9점')).toEqual([['삼겹살구이', 1.53, 9, 505]])
    expect(read('우유 200ml, 프로틴 1스쿱')).toEqual([['우유', 1, null, 130], ['프로틴', 1, null, 120]])
    expect(read('치킨 반마리')).toEqual([['후라이드치킨', 2.5, null, 1000]])
    expect(read('피자 1판')).toEqual([['피자', 8, 8, 2240]])
    expect(read('사과 2개')).toEqual([['사과', 2, null, 160]])
    expect(calcTotals(rowsFromText('라면 1개 + 공기밥'))).toMatchObject({ kcal: 810 })
  })

  it('reads nothing into an empty text', () => {
    expect(rowsFromText('')).toEqual([])
    expect(rowsFromText(' , ,')).toEqual([])
  })
})
