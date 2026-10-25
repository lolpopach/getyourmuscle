// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store/useStore.js'
import { makePlan } from '../lib/gplan.js'
import { todayISO } from '../lib/format.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* G-PLAN on screen: the today card (budget, supplement, meals through the meal sheet), the set-up
   sheet and the progress card's weekly check. The store is the real one; sheets are captured
   instead of opened, and the API (Apple Health) never answers. */
const sheets = vi.hoisted(() => [])
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: render => { sheets.push(render); return {} } })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.reject(new Error('offline'))) }))

const { GplanTodayCard } = await import('./GplanToday.jsx')
const { GplanProgressCard, GplanStartCard } = await import('./GplanSetup.jsx')

const OWNER = { w: 79.1, h: 181, age: 18, sex: 'male', bf: 18.4, activity: 1.5, walkKm: 6, runKm: 0, rateKgWk: 0.45, targetW: 73.5, targetBf: 12, start: '2026-10-13', end: '2027-01-11' }
const today = todayISO()

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
const rowTitled = (host, title) => [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text))
const openTop = () => mount(sheets.at(-1)(vi.fn()))
const S = () => useStore.getState().S

beforeEach(() => {
  sheets.length = 0
  useStore.setState(s => ({ S: { ...s.S, gplan: makePlan(OWNER, null, 1), gday: {}, bodycomp: {}, bodyweight: [], workouts: [], routines: [], week: {}, dayPlan: {} }, user: null }))
})
afterEach(() => { while (mounted.length) { const m = mounted.pop(); act(() => m.root.unmount()); m.host.remove() } })

describe('today card', () => {
  it('starts with the whole budget and the protein first', () => {
    const host = mount(<GplanTodayCard />)
    expect(host.textContent).toContain('2,400 kcal left')
    expect(host.textContent).toContain('Protein 170 g left')
    expect(host.textContent).toContain('170 g protein to go — make Breakfast count')
    expect(host.textContent).toContain('Rest day')
  })

  it('checks creatine off and counts the streak', async () => {
    const host = mount(<GplanTodayCard />)
    act(() => rowTitled(host, '크레아틴 3 g').click())
    expect(S().gday[today].supps.creatine).toBe(true)
    expect(host.textContent).toContain('1-day streak')
  })

  it('logs a meal from a template in one tap, and the budget follows', async () => {
    const host = mount(<GplanTodayCard />)
    act(() => rowTitled(host, 'Breakfast').click())
    const sheet = openTop()
    act(() => button(sheet, '잠봉 샌드위치 + 단백질 음료').click())
    expect(S().gday[today].meals.b).toMatchObject([{ name: '잠봉 샌드위치 + 단백질 음료', kcal: 630, p: 43, tpl: 'tpl-jambon' }])
    await settle()
    expect(host.textContent).toContain('1,770 kcal left')
    expect(rowTitled(host, 'Breakfast').textContent).toContain('630 kcal · protein 43 g')
  })

  it('adds a quick entry and keeps it as a template when asked', async () => {
    mount(<GplanTodayCard />)
    act(() => rowTitled(document.body, 'Dinner').click())
    const sheet = openTop()
    const inputs = sheet.querySelectorAll('input')
    const type = (el, v) => act(() => {
      Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    type(inputs[0], '연어 덮밥')
    type(inputs[1], '650')
    type(inputs[2], '40')
    act(() => sheet.querySelector('[role=switch]').click())
    act(() => button(sheet, 'Add').click())
    expect(S().gday[today].meals.d).toMatchObject([{ name: '연어 덮밥', kcal: 650, p: 40 }])
    expect(S().gplan.templates.at(-1)).toMatchObject({ slot: 'd', name: '연어 덮밥', kcal: 650 })
  })
})

describe('set-up and progress', () => {
  it('offers the set-up while there is no plan', () => {
    useStore.setState(s => ({ S: { ...s.S, gplan: null } }))
    const host = mount(<GplanStartCard />)
    act(() => button(host, 'Start G-PLAN').click())
    const sheet = openTop()
    expect(sheet.textContent).toContain('Enter height, weight and age to see your targets.')
  })

  it('shows the plan for the next check date and waits out the first weeks', () => {
    useStore.setState(s => ({ S: { ...s.S, gplan: { ...s.S.gplan, start: today } } }))
    const host = mount(<GplanProgressCard />)
    expect(host.textContent).toContain('Starts in 21 days')
    expect(host.textContent).toContain('Today: 2,400 kcal · protein 170 g')
  })

  it('applies a suggested intake only when accepted', () => {
    const iso = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
    const bodyweight = Array.from({ length: 14 }, (_, i) => ({ d: iso(13 - i), w: 78, t: i }))   // no loss
    const gday = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [iso(i), { meals: { b: [{ kcal: 600 }], l: [{ kcal: 600 }], s: [{ kcal: 600 }], d: [{ kcal: 600 }] } }]))
    useStore.setState(s => ({ S: { ...s.S, bodyweight, gday, gplan: { ...s.S.gplan, start: iso(40) } } }))
    const host = mount(<GplanProgressCard />)
    expect(S().gplan.targets.kcal).toBe(2400)
    act(() => button(host, 'Switch to 2,275 kcal').click())
    expect(S().gplan.targets.kcal).toBe(2275)
    expect(S().gplan.history.at(-1)).toMatchObject({ kcal: 2275, reason: 'weekly' })
  })
})
