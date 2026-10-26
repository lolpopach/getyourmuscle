// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store/useStore.js'
import { makePlan } from '../lib/gplan.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The meal sheet's food helpers on screen: the calculator by name, a photo read through the
   server, and the school lunch with dislikes. Sheets are captured instead of opened; the API
   answers from the table below. */
const sheets = vi.hoisted(() => [])
const calls = vi.hoisted(() => [])
const answers = vi.hoisted(() => ({}))
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: render => { sheets.push(render); return {} } })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null })
    const a = answers[path.split('?')[0]]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a(path) : a
  }),
}))

const { mealSheet } = await import('./GplanToday.jsx')
const { forgetLunchCache } = await import('./GplanFood.jsx')

const OWNER = { w: 79.1, h: 181, age: 18, sex: 'male', bf: 18.4, activity: 1.5, walkKm: 6, runKm: 0, rateKgWk: 0.45, targetW: 73.5, targetBf: 12, start: '2026-10-13', end: '2027-01-11' }
const DAY = '2026-10-01'
const OCT_1 = ['흰쌀밥', '순두부찌개(0.6)', '소불고기', '치즈계란말이*케찹', '열무김치', '파인애플']

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}
const settle = () => act(() => new Promise(r => setTimeout(r, 0)))
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text))
const exact = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const openTop = () => mount(sheets.at(-1)(vi.fn()))
const S = () => useStore.getState().S
const type = (el, v) => act(() => {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => {
  sheets.length = 0
  calls.length = 0
  for (const k of Object.keys(answers)) delete answers[k]
  forgetLunchCache()
  useStore.setState(s => ({
    S: { ...s.S, gplan: makePlan(OWNER, null, 1), gday: {}, bodycomp: {}, bodyweight: [], workouts: [], routines: [], week: {}, dayPlan: {} },
    user: { id: 'u1', name: 'Chan' },
    config: { lunch: true, meal_photo: true },
  }))
})
afterEach(() => { while (mounted.length) { const m = mounted.pop(); act(() => m.root.unmount()); m.host.remove() } })

describe('the calculator', () => {
  it('counts a dish by name and amount, and logs it', async () => {
    mealSheet(DAY, 'd')
    const meal = openTop()
    act(() => button(meal, 'By food name').click())
    const calc = openTop()
    const [name] = calc.querySelectorAll('input[list="gplan-foods"]')
    type(name, '흰쌀밥')
    await settle()
    expect(calc.textContent).toContain('310 kcal')
    act(() => calc.querySelector('.stp button[aria-label="Decrease"]').click())
    act(() => calc.querySelector('.stp button[aria-label="Decrease"]').click())
    expect(calc.textContent).toContain('155 kcal')
    act(() => button(calc, 'Add a dish').click())
    type(calc.querySelectorAll('input[list="gplan-foods"]')[1], '닭가슴살')
    expect(calc.textContent).toContain('Total265 kcal · protein 26 g')
    act(() => exact(calc, 'Add').click())
    expect(S().gday[DAY].meals.d).toMatchObject([{ name: '흰쌀밥, 닭가슴살', kcal: 265, p: 26 }])
  })

  it('marks a dish the table only guesses at', async () => {
    mealSheet(DAY, 'd')
    const meal = openTop()
    act(() => button(meal, 'By food name').click())
    const calc = openTop()
    type(calc.querySelector('input[list="gplan-foods"]'), '오징어덮밥')
    expect(calc.textContent).toContain('counted as 덮밥')
    type(calc.querySelector('input[list="gplan-foods"]'), '유린기')
    expect(calc.textContent).toContain('rough estimate')
  })
})

describe('a meal photo', () => {
  it('sends a small JPEG, lists what the server named, and logs it from the food table', async () => {
    // happy-dom decodes no images: stand in for the decode and the canvas.
    const origImage = globalThis.Image
    globalThis.Image = class { set src(_) { this.naturalWidth = 4000; this.naturalHeight = 3000; setTimeout(() => this.onload(), 0) } }
    URL.createObjectURL = () => 'blob:x'
    URL.revokeObjectURL = () => {}
    const sizes = []
    HTMLCanvasElement.prototype.getContext = function () { sizes.push([this.width, this.height]); return { drawImage() {} } }
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AAAA'
    answers['/api/meal/photo'] = { items: [{ name: '흰쌀밥', servings: 0.5, kcal: 999 }, { name: '제육볶음', servings: 1, kcal: 340, p: 20 }], provider: 'workers-ai' }
    try {
      mealSheet(DAY, 'd')
      const meal = openTop()
      const file = meal.querySelector('input[type=file]')
      Object.defineProperty(file, 'files', { value: [new File(['x'], 'meal.jpg', { type: 'image/jpeg' })] })
      act(() => file.dispatchEvent(new Event('change', { bubbles: true })))
      const sheet = openTop()
      expect(sheet.textContent).toContain('Reading the photo')
      await settle(); await settle(); await settle()
      expect(sizes).toEqual([[1024, 768]])
      expect(calls.at(-1)).toEqual({ path: '/api/meal/photo', body: { image: 'data:image/jpeg;base64,AAAA', note: '' } })
      // The table's half bowl, not the model's 999.
      expect(sheet.textContent).toContain('Total485 kcal · protein 23 g')
      act(() => exact(sheet, 'Add').click())
      expect(S().gday[DAY].meals.d).toMatchObject([{ name: '흰쌀밥, 제육볶음', kcal: 485 }])
    } finally {
      globalThis.Image = origImage
    }
  })

  it('offers no photo button when the server reads no photos', () => {
    useStore.setState({ config: { lunch: false } })
    mealSheet(DAY, 'd')
    const meal = openTop()
    expect(meal.querySelector('input[type=file]')).toBeNull()
    expect(button(meal, 'By food name')).toBeTruthy()
  })
})

describe('the school lunch', () => {
  it('shows how to eat the day\'s menu and logs it as suggested', async () => {
    answers['/api/lunch'] = { date: DAY, meals: [{ label: '중식', dishes: OCT_1 }] }
    mealSheet(DAY, 'l')
    const sheet = openTop()
    await settle()
    expect(calls[0].path).toBe('/api/lunch?date=2026-10-01')
    expect(sheet.textContent).toContain('School lunch')
    expect(sheet.textContent).toContain('흰쌀밥1 bowl')
    expect(sheet.textContent).toContain('순두부찌개1 serving · mostly the solids')
    expect(sheet.textContent).toContain('Eaten this way990 kcal · protein 52 g')
    act(() => button(sheet, 'Log it as suggested').click())
    expect(S().gday[DAY].meals.l).toMatchObject([{ name: 'School lunch: 순두부찌개, 소불고기, 치즈계란말이', kcal: 990, p: 52 }])
  })

  it('leaves out a dish tapped as disliked, re-balances, and keeps the mark', async () => {
    answers['/api/lunch'] = { date: DAY, meals: [{ label: '중식', dishes: OCT_1 }] }
    mealSheet(DAY, 'l')
    const sheet = openTop()
    await settle()
    act(() => sheet.querySelector('button[aria-label="소불고기"]').click())
    expect(S().gplan.dislikes).toEqual(['소불고기'])
    expect(sheet.textContent).toContain('You don’t eat this — left out')
    expect(sheet.textContent).toContain('치즈계란말이2 servings — ask for seconds')
    // Unmarked from its chip.
    act(() => sheet.querySelector('button[aria-label="Delete 소불고기"]').click())
    expect(S().gplan.dislikes).toEqual([])
  })

  it('takes a word as a mark, and says when there is no lunch', async () => {
    answers['/api/lunch'] = { date: DAY, meals: [] }
    mealSheet(DAY, 'l')
    const sheet = openTop()
    await settle()
    expect(sheet.textContent).toContain('No school lunch on this day.')
    const word = sheet.querySelector('input[placeholder^="A food you"]')
    type(word, '가지')
    act(() => word.parentElement.querySelector('button').click())
    expect(S().gplan.dislikes).toEqual(['가지'])
  })

  it('is not there on other meals, or without the school menu', async () => {
    answers['/api/lunch'] = { date: DAY, meals: [] }
    mealSheet(DAY, 'b')
    expect(openTop().textContent).not.toContain('School lunch')
    useStore.setState({ config: { meal_photo: true } })
    mealSheet(DAY, 'l')
    expect(openTop().textContent).not.toContain('School lunch')
    expect(calls).toEqual([])
  })
})
