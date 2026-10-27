// What the owner wrote — "제육덮밥, 계란후라이 2개, 밥 반 공기" — read as dishes and amounts, so the
// meal sheet can count it from the food table the moment it is written. Whatever the table cannot
// settle goes to Claude with the text as written (components/GplanFood.jsx); this only has to be
// right about the common cases, and never invent an amount that was not written. Pure.
import { findFood } from './foods.js'
import { calcRow, setPieces } from './food-calc.js'

// Number words, only ever read right before a unit ("두 개", "한 공기"): alone, 이/삼/사 are the
// start of 이면수, 삼겹살 and 사과.
const NUM_WORDS = { 반: 0.5, 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 석: 3, 네: 4, 넷: 4, 넉: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 }
const SERVING_UNITS = ['인분', '공기', '그릇', '접시', '컵', '잔', '팩', '봉지', '봉', '스쿱', '줄', '장', '캔', '병', '판']
const PIECE_UNITS = ['개', '조각', '점', '알', '쪽', '덩이', '피스']
const GRAM_UNITS = ['g', 'G', '그램', 'ml', 'mL', 'ML', '미리', '밀리']
const UNITS = [...SERVING_UNITS, ...PIECE_UNITS, ...GRAM_UNITS, '마리'].sort((a, b) => b.length - a.length)
const NUMBER = `\\d+(?:\\.\\d+)?(?:\\s*/\\s*\\d+)?|${Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|')}`
// "2개", "1.5 공기", "1/2공기", "한 공기 반", "반마리", "200g"
const AMOUNT = new RegExp(`(${NUMBER})\\s*(${UNITS.join('|')})(\\s*반)?(?![가-힣a-zA-Z])`)
// A number on its own at the end: "계란 2", "바나나 하나" (counting words only; 한/두/세 need a unit).
const COUNT_WORDS = { 하나: 1, 둘: 2, 셋: 3, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 }
const BARE = new RegExp(`(?:^|\\s)(\\d+(?:\\.\\d+)?|${Object.keys(COUNT_WORDS).join('|')})\\s*$`)
// A word that is an amount on its own ("2조각", "1캔", "반공기") or a unit after a number word
// ("한 공기"): the dish it belongs to ends there, so "피자 2조각 콜라 1캔" is two dishes.
const AMOUNT_WORD = new RegExp(`^(?:\\d+(?:\\.\\d+)?|반)?(?:${[...UNITS].join('|')})반?$`)
// Words that change an amount without a unit, and words that say nothing about the food.
const MODIFIERS = [[/(?:^|\s)(?:반만|절반|반)(?=\s|$)/, 0.5], [/(?:^|\s)(?:조금|약간|살짝)(?=\s|$)/, 0.5], [/(?:^|\s)(?:많이|곱빼기|가득)(?=\s|$)/, 1.5]]
const FILLER = /(?:^|\s)(?:먹었어요|먹었어|먹었음|먹었다|먹음|정도|쯤|약|대충|한|그리고)(?=\s|$)/g

const toNumber = s => {
  if (NUM_WORDS[s] != null) return NUM_WORDS[s]
  if (COUNT_WORDS[s] != null) return COUNT_WORDS[s]
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/.exec(s)
  if (m) return +m[2] ? +m[1] / +m[2] : 0
  return Number(s)
}
const exactOrMine = name => ['exact', 'mine'].includes(findFood(name)?.how)

/**
 * The text as separate dishes: split at commas, plus signs, new lines and "그리고", and after a
 * word ending in 랑 / 이랑 / 하고 ("제육이랑 밥"), or in 과 / 와 when the word without it is a dish
 * the table knows and the word with it is not ("계란과" splits, "사과" does not).
 */
export function splitMeal(text) {
  const out = []
  for (const part of String(text || '').split(/[,，+\n/&;·]|\s(?:그리고|and)\s/)) {
    let cur = []
    const words = part.trim().split(/\s+/).filter(Boolean)
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      const m = /^(.+?)(이랑|랑|하고)$/.exec(w)
      const m2 = /^(.{2,})(과|와)$/.exec(w)
      if (m) { cur.push(m[1]); out.push(cur.join(' ')); cur = [] }
      else if (m2 && !exactOrMine(w) && exactOrMine(m2[1])) { cur.push(m2[1]); out.push(cur.join(' ')); cur = [] }
      else if (AMOUNT_WORD.test(w) && (/\d|반/.test(w) || NUM_WORDS[cur.at(-1)] != null) && i < words.length - 1 && cur.length) {
        // An amount closes its dish; a "반" right after it ("한 공기 반") still belongs to it.
        cur.push(w)
        if (words[i + 1] === '반') cur.push(words[++i])
        if (i < words.length - 1) { out.push(cur.join(' ')); cur = [] }
      } else cur.push(w)
    }
    if (cur.length) out.push(cur.join(' '))
  }
  return out.map(s => s.trim()).filter(Boolean)
}

/**
 * One dish as written → { name, qty, unit, kind } or null when nothing names a food. `kind` is
 * how the amount was given: 'serving', 'piece', 'gram', 'whole' (마리) or null for none.
 */
export function parseDishText(raw) {
  let s = ' ' + String(raw || '').replace(/\s+/g, ' ').trim() + ' '
  let qty = null, unit = null
  const m = AMOUNT.exec(s)
  if (m) {
    qty = toNumber(m[1]) + (m[3] ? 0.5 : 0)
    unit = m[2]
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)
  } else {
    const b = BARE.exec(s.trimEnd())
    if (b) { qty = toNumber(b[1]); s = s.trimEnd().slice(0, b.index) + ' ' }
  }
  for (const [re, factor] of MODIFIERS) {
    if (re.test(s)) { qty = (qty ?? 1) * factor; s = s.replace(re, ' ') }
  }
  s = s.replace(FILLER, ' ').replace(/\s+/g, ' ').trim()
  // A trailing particle that only gets in the way of the name ("김치찌개를" → 김치찌개).
  const bare = /^(.{2,}?)(을|를|은|는|이|가|도|만)$/.exec(s)
  if (bare && !exactOrMine(s) && exactOrMine(bare[1])) s = bare[1]
  if (!s) return null
  const kind = !unit ? null : SERVING_UNITS.includes(unit) ? 'serving' : PIECE_UNITS.includes(unit) ? 'piece' : unit === '마리' ? 'whole' : 'gram'
  return { name: s, qty: qty != null && Number.isFinite(qty) && qty > 0 ? qty : null, unit, kind }
}

// A whole fried chicken is about five of the table's servings (150 g each, ~2,000 kcal in all);
// a whole fish one.
const WHOLE_SERVINGS = food => (/치킨|닭/.test(food.name) && food.cat === 'main' ? 5 : 1)

/** One parsed dish as a calculator row: the amount turned into servings or pieces of the table's food. */
export function rowFromDish(d) {
  const food = findFood(d.name)?.food
  const q = d.qty ?? 1
  if (!food) return calcRow(d.name, q)
  if (d.kind === 'gram') return calcRow(d.name, q / food.g)
  if (d.kind === 'whole') return calcRow(d.name, q * WHOLE_SERVINGS(food))
  if (d.unit === '판' && food.piece) return setPieces(calcRow(d.name, 1), q * 8)
  if ((d.kind === 'piece' || (!d.kind && d.qty != null)) && food.piece) return setPieces(calcRow(d.name, 1), q)
  return calcRow(d.name, q)
}

/** The whole text as calculator rows, in the order written. */
export const rowsFromText = text => splitMeal(text).map(parseDishText).filter(Boolean).map(rowFromDish)
