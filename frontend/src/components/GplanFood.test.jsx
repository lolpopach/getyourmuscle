// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store/useStore.js'
import { makePlan } from '../lib/gplan.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The meal sheet's food helpers on screen: writing what was eaten, the inbox for Claude, the
   calculator for a shared table, and the school lunch with dislikes. Sheets are captured instead
   of opened; the API answers from the table below. */
const sheets = vi.hoisted(() => [])
const calls = vi.hoisted(() => [])
const answers = vi.hoisted(() => ({}))
const toasts = vi.hoisted(() => [])
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: m => toasts.push(m), openSheet: render => { sheets.push(render); return {} } })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    calls.push({ path, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null })
    const a = answers[path.split('?')[0]]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a(path) : a
  }),
}))

const { mealSheet, GplanTodayCard } = await import('./GplanToday.jsx')
const { forgetLunchCache } = await import('./GplanFood.jsx')
const { findFood, setMyFoods } = await import('../lib/foods.js')

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
const stepper = (host, label) => [...host.querySelectorAll('.stp-w')].find(w => w.querySelector('.stp-l')?.textContent === label)
const foodRows = host => [...host.querySelectorAll('.food-row')]
// happy-dom decodes no images: stand in for the decode and the canvas, for one test.
function fakeImages() {
  const orig = globalThis.Image
  globalThis.Image = class { set src(_) { this.naturalWidth = 4000; this.naturalHeight = 3000; setTimeout(() => this.onload(), 0) } }
  URL.createObjectURL = () => 'blob:x'
  URL.revokeObjectURL = () => {}
  const sizes = []
  HTMLCanvasElement.prototype.getContext = function () { sizes.push([this.width, this.height]); return { drawImage() {} } }
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AAAA'
  return { sizes, restore: () => { globalThis.Image = orig } }
}
const pick = input => {
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'meal.jpg', { type: 'image/jpeg' })] })
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
}
const openTop = () => mount(sheets.at(-1)(vi.fn()))
const S = () => useStore.getState().S
const type = (el, v) => act(() => {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const entry = host => host.querySelector('input[aria-label="Write what you ate"]')
const inboxPosts = () => calls.filter(c => c.path === '/api/inbox' && c.method === 'POST')
const linkClaude = () => useStore.setState({ config: { lunch: true, claude: { linked: true } } })

beforeEach(() => {
  sheets.length = 0
  calls.length = 0
  toasts.length = 0
  for (const k of Object.keys(answers)) delete answers[k]
  forgetLunchCache()
  useStore.setState(s => ({
    S: { ...s.S, gplan: makePlan(OWNER, null, 1), gday: {}, bodycomp: {}, bodyweight: [], workouts: [], routines: [], week: {}, dayPlan: {} },
    user: { id: 'u1', name: 'Chan' },
    config: { lunch: true },
  }))
})
afterEach(() => {
  while (mounted.length) { const m = mounted.pop(); act(() => m.root.unmount()); m.host.remove() }
  setMyFoods([])
  localStorage.clear()
})

describe('writing what was eaten', () => {
  it('counts it as it is typed and saves it with one tap', async () => {
    mealSheet(DAY, 'd')
    const meal = openTop()
    type(entry(meal), '제육덮밥, 계란후라이 2개, 밥 반 공기')
    expect(meal.textContent).toContain('계란후라이 · 2pcs180 kcal')
    expect(meal.textContent).toContain('Total1,055 kcal · protein 43 g')
    act(() => exact(meal, 'Add').click())
    await settle()
    expect(S().gday[DAY].meals.d).toMatchObject([{ name: '제육덮밥, 계란후라이 2개, 밥 반 공기', kcal: 1055, p: 43 }])
    expect(S().gday[DAY].meals.d[0].pending).toBeUndefined()
    expect(entry(meal).value).toBe('')
    // Without Claude linked, nothing goes anywhere.
    expect(inboxPosts()).toEqual([])
  })

  it('takes numbers typed in over the table, and keeps a template when asked', () => {
    mealSheet(DAY, 'd')
    const meal = openTop()
    type(entry(meal), '엄마표 김밥')
    act(() => button(meal, 'Enter numbers yourself').click())
    const [kcal, p] = meal.querySelectorAll('.smart-entry label input')
    type(kcal, '480')
    type(p, '15')
    act(() => meal.querySelector('[role=switch][aria-label="Save as a template"]').click())
    act(() => exact(meal, 'Add').click())
    expect(S().gday[DAY].meals.d).toMatchObject([{ name: '엄마표 김밥', kcal: 480, p: 15 }])
    expect(S().gplan.templates.at(-1)).toMatchObject({ slot: 'd', name: '엄마표 김밥', kcal: 480 })
  })

  it('with Claude linked, saves at once and sends what the table cannot settle', async () => {
    linkClaude()
    answers['/api/inbox'] = { ok: true }
    mealSheet(DAY, 'd')
    const meal = openTop()
    type(entry(meal), '훠궈 1인분, 밥 1공기')
    expect(meal.textContent).toContain('Claude will check')
    act(() => button(meal, 'Save and send to Claude').click())
    await settle()
    const [item] = S().gday[DAY].meals.d
    expect(item).toMatchObject({ name: '훠궈 1인분, 밥 1공기', pending: expect.stringMatching(/^m/) })
    expect(item.kcal).toBeGreaterThan(310)
    expect(inboxPosts()).toEqual([{ path: '/api/inbox', method: 'POST', body: {
      id: item.pending, date: DAY, slot: 'd', mealId: item.id, text: '훠궈 1인분, 밥 1공기', photo: null,
      estimate: { kcal: item.kcal, p: item.p, c: item.c, f: item.f },
    } }])
    expect(toasts).toContain('Saved — Claude will work it out')
    expect(meal.textContent).toContain('waiting for Claude')
  })

  it('does not bother Claude with what the table knows', () => {
    linkClaude()
    mealSheet(DAY, 'd')
    const meal = openTop()
    type(entry(meal), '닭가슴살 2개')
    expect(button(meal, 'Save and send to Claude')).toBeUndefined()
    act(() => exact(meal, 'Add').click())
    expect(S().gday[DAY].meals.d).toMatchObject([{ kcal: 220 }])
    expect(inboxPosts()).toEqual([])
  })

  it('sends a photo as a small JPEG, with or without words', async () => {
    linkClaude()
    answers['/api/inbox'] = { ok: true }
    const images = fakeImages()
    try {
      mealSheet(DAY, 'd')
      const meal = openTop()
      pick(meal.querySelector('input[aria-label="Add a photo"]'))
      await settle(); await settle()
      expect(images.sizes).toEqual([[1024, 768]])
      expect(meal.textContent).toContain('Claude will look at this photo.')
      act(() => button(meal, 'Save and send to Claude').click())
      await settle()
      expect(S().gday[DAY].meals.d).toMatchObject([{ name: 'Meal photo', kcal: 0, pending: expect.any(String) }])
      expect(inboxPosts()[0].body).toMatchObject({ text: '', photo: 'data:image/jpeg;base64,AAAA' })
    } finally {
      images.restore()
    }
  })

  it('keeps the table\'s numbers when the inbox cannot be reached', async () => {
    linkClaude()
    answers['/api/inbox'] = new Error('offline')
    mealSheet(DAY, 'd')
    const meal = openTop()
    type(entry(meal), '훠궈')
    act(() => button(meal, 'Save and send to Claude').click())
    await settle()
    expect(S().gday[DAY].meals.d[0].pending).toBeUndefined()
    expect(toasts).toContain('Could not send it to Claude — saved with the food table’s numbers.')
  })

  it('offers no photo without Claude linked', () => {
    mealSheet(DAY, 'd')
    expect(openTop().querySelector('input[type=file]')).toBeNull()
  })
})

describe('Claude\'s answers', () => {
  it('replace the meal\'s numbers, are acknowledged, and teach the app the food', async () => {
    linkClaude()
    useStore.setState(s => ({ S: { ...s.S, gday: { [DAY]: { meals: { d: [{ id: 'x1', name: '훠궈', kcal: 250, p: 8, c: 30, f: 10, pending: 'mA1b2' }] } } } } }))
    answers['/api/inbox'] = { entries: [
      { id: 'mA1b2', date: DAY, slot: 'd', mealId: 'x1', status: 'done', result: { items: [{ name: '훠궈', amount: '1인분' }, { name: '흰쌀밥', amount: '1공기' }], kcal: 910, p: 42, c: 95, f: 38 } },
      { id: 'mWait', date: DAY, slot: 'd', status: 'pending', result: null },
    ] }
    answers['/api/foods'] = { foods: [{ name: '훠궈', g: 450, kcal: 600, p: 35, c: 25, f: 38 }] }
    answers['/api/inbox/ack'] = { ok: true }
    mount(<GplanTodayCard />)
    await settle(); await settle()
    expect(S().gday[DAY].meals.d[0]).toMatchObject({ kcal: 910, p: 42, by: 'claude', detail: '훠궈 1인분 · 흰쌀밥 1공기' })
    expect(S().gday[DAY].meals.d[0].pending).toBeUndefined()
    expect(calls.find(c => c.path === '/api/inbox/ack').body).toEqual({ ids: ['mA1b2'] })
    expect(findFood('훠궈')).toMatchObject({ how: 'mine', food: { kcal: 600 } })
    expect(JSON.parse(localStorage.getItem('gplan_my_foods'))).toHaveLength(1)
  })

  it('are not asked for without Claude linked', async () => {
    mount(<GplanTodayCard />)
    await settle()
    expect(calls.filter(c => c.path === '/api/inbox' || c.path === '/api/foods')).toEqual([])
  })
})

describe('the calculator', () => {
  const calcSheet = (text = '') => {
    mealSheet(DAY, 'd')
    const meal = openTop()
    if (text) type(entry(meal), text)
    act(() => button(meal, 'Shared table').click())
    return openTop()
  }

  it('counts a dish by name and amount, and logs it', async () => {
    const calc = calcSheet()
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

  it('starts from what was written', () => {
    const calc = calcSheet('삼겹살 9점, 밥 반 공기')
    expect(foodRows(calc).map(r => r.querySelector('input').value)).toEqual(['삼겹살', '밥'])
    expect(calc.textContent).toContain('Total660 kcal')
  })

  it('marks a dish the table only guesses at, or one Claude will check', () => {
    let calc = calcSheet()
    type(calc.querySelector('input[list="gplan-foods"]'), '오징어덮밥')
    expect(calc.textContent).toContain('counted as 덮밥')
    type(calc.querySelector('input[list="gplan-foods"]'), '훠궈')
    expect(calc.textContent).toContain('rough estimate')
    linkClaude()
    calc = calcSheet('훠궈')
    expect(calc.textContent).toContain('Claude will check')
    expect(button(calc, 'Save and send to Claude')).toBeTruthy()
  })
})

describe('a shared table', () => {
  const calcSheet = () => {
    mealSheet(DAY, 'd')
    const meal = openTop()
    act(() => button(meal, 'Shared table').click())
    return openTop()
  }

  it('counts the owner\'s share of the shared dishes, and all of what was only theirs', () => {
    const calc = calcSheet()
    type(calc.querySelector('input[list="gplan-foods"]'), '삼겹살')
    // 3 servings of 삼겹살 on the table.
    const meat = foodRows(calc)[0]
    for (let i = 0; i < 8; i++) act(() => meat.querySelector('.stp button[aria-label="Increase"]').click())
    expect(calc.textContent).toContain('Total990 kcal')

    act(() => calc.querySelector('[role=switch][aria-label="Shared with others"]').click())
    expect(calc.textContent).toContain('Total495 kcal')   // two people: half
    act(() => stepper(calc, 'People at the table').querySelector('button[aria-label="Increase"]').click())
    expect(calc.textContent).toContain('your 33%')
    expect(calc.textContent).toContain('Total327 kcal')

    // The owner's own bowl of rice: added as shared, marked as theirs.
    act(() => button(calc, 'Add a dish').click())
    type(foodRows(calc)[1].querySelector('input[list="gplan-foods"]'), '흰쌀밥')
    act(() => exact(foodRows(calc)[1], 'Shared').click())
    expect(exact(foodRows(calc)[1], 'Mine only')).toBeTruthy()
    expect(calc.textContent).toContain('Total637 kcal')

    act(() => exact(calc, 'Add').click())
    expect(S().gday[DAY].meals.d).toMatchObject([{ name: '삼겹살, 흰쌀밥 (shared, 33%)', kcal: 637 }])
  })

  it('counts 삼겹살 by the slice as what the owner ate', () => {
    const calc = calcSheet()
    act(() => calc.querySelector('[role=switch][aria-label="Shared with others"]').click())
    type(calc.querySelector('input[list="gplan-foods"]'), '삼겹살')
    act(() => exact(foodRows(calc)[0], 'slices').click())
    const meat = foodRows(calc)[0]
    expect(meat.querySelector('.stp .val i').textContent).toBe('slices')
    expect(exact(meat, 'Shared')).toBeUndefined()   // counted pieces are the owner's own
    type(meat.querySelector('.stp input'), '9')
    expect(calc.textContent).toContain('Total505 kcal · protein 26 g')
    act(() => exact(calc, 'Add').click())
    expect(S().gday[DAY].meals.d).toMatchObject([{ name: '삼겹살', kcal: 505 }])
  })

  it('tells Claude how many shared the table and the owner\'s share', async () => {
    linkClaude()
    answers['/api/inbox'] = { ok: true }
    const calc = calcSheet()
    act(() => calc.querySelector('[role=switch][aria-label="Shared with others"]').click())
    type(calc.querySelector('input[list="gplan-foods"]'), '훠궈')
    act(() => foodRows(calc)[0].querySelector('.stp button[aria-label="Increase"]').click())
    act(() => button(calc, 'Save and send to Claude').click())
    await settle()
    expect(inboxPosts()[0].body.text).toBe('훠궈 1 1/4serving (Shared) — 2 people at the table, my share 50%')
    expect(S().gday[DAY].meals.d[0]).toMatchObject({ name: '훠궈 (shared, 50%)', pending: expect.any(String) })
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
    useStore.setState({ config: { claude: { linked: true } } })
    mealSheet(DAY, 'l')
    expect(openTop().textContent).not.toContain('School lunch')
    expect(calls).toEqual([])
  })
})
