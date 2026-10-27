// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppleHealthRow, AppleHealthSheet, ingestUrl, ingestProblem, runShortcutUrl } from './AppleHealth.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Apple Health sync on screen (api/health.js): the Settings row only on a server that knows the
   route, the address (token inside) shown once, replacing it behind a second tap, revoking it,
   what the last call came to, and the last week's days. The API is a stand-in; what each step
   sends is the point. */
const mocks = vi.hoisted(() => {
  const state = { sheets: [], answers: {}, calls: [] }
  state.toast = vi.fn()
  state.copyText = vi.fn(async () => true)
  state.api = vi.fn(async (path, init) => {
    const method = init?.method || 'GET'
    state.calls.push({ path, method })
    const a = state.answers[method + ' ' + path.split('?')[0]]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a() : a ?? {}
  })
  return state
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ api: (...a) => mocks.api(...a) }))
vi.mock('../lib/clipboard.js', () => ({ copyText: (...a) => mocks.copyText(...a) }))

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
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const click = async (host, text) => { act(() => button(host, text).click()); await settle() }

beforeEach(() => {
  mocks.sheets.length = 0
  mocks.answers = {}
  mocks.calls.length = 0
  mocks.toast.mockClear()
  mocks.copyText.mockClear()
})
afterEach(() => { while (mounted.length) { const m = mounted.pop(); act(() => m.root.unmount()); m.host.remove() } })

describe('AppleHealthRow', () => {
  it('stays hidden on a server without the route', async () => {
    mocks.answers['GET /api/account/health-token'] = Object.assign(new Error('not found'), { status: 404 })
    const host = mount(<AppleHealthRow />)
    await settle()
    expect(host.textContent).toBe('')
  })

  it('says how the sync stands and opens the sheet', async () => {
    mocks.answers['GET /api/account/health-token'] = { active: true, created: 1, lastSync: null }
    const host = mount(<AppleHealthRow />)
    await settle()
    expect(host.textContent).toContain('Apple Health sync')
    expect(host.textContent).toContain('waiting for the first sync')
    act(() => host.querySelector('.lrow').click())
    expect(mocks.sheets).toHaveLength(1)
  })
})

describe('AppleHealthSheet', () => {
  it('makes the address once, with the token in it, and copies it', async () => {
    mocks.answers['GET /api/account/health-token'] = { active: false, created: null, lastSync: null, last: null }
    mocks.answers['GET /api/health/daily'] = { days: {} }
    mocks.answers['POST /api/account/health-token'] = { token: 'gymh_abc', created: 2 }
    const host = mount(<AppleHealthSheet close={vi.fn()} />)
    await settle()
    expect(host.textContent).toContain('Nothing synced in the last 7 days.')
    await click(host, 'Make the Shortcut address')
    expect(mocks.calls.some(c => c.method === 'POST' && c.path === '/api/account/health-token')).toBe(true)
    const address = ingestUrl(location, { token: 'gymh_abc' })
    expect(address).toContain('key=gymh_abc')
    expect(host.textContent).toContain(address)
    // The steps point at Health, not Fitness, and stop at five actions with no header or date.
    expect(host.textContent).toContain('the Fitness app has no actions')
    expect(host.textContent).toContain('Find Health Samples')
    expect(host.textContent).not.toContain('Authorization')
    expect(host.textContent).not.toContain('Format Date')
    await click(host, 'Copy address')
    expect(mocks.copyText).toHaveBeenCalledWith(address)
  })

  it('says why the last try saved nothing, and offers to run the Shortcut', async () => {
    mocks.answers['GET /api/account/health-token'] = { active: true, created: 1, lastSync: null, last: { at: Date.now() - 60000, error: 'steps out of range' } }
    mocks.answers['GET /api/health/daily'] = { days: {} }
    const host = mount(<AppleHealthSheet close={vi.fn()} />)
    await settle()
    expect(host.textContent).toContain('saved nothing')
    expect(host.textContent).toContain('steps could not be read')
    expect(button(host, 'Sync now')).toBeTruthy()
  })

  it('does not blame a new address for what the old one sent', async () => {
    mocks.answers['GET /api/account/health-token'] = { active: true, created: 5000, lastSync: null, last: { at: 4000, error: 'invalid json' } }
    mocks.answers['GET /api/health/daily'] = { days: {} }
    const host = mount(<AppleHealthSheet close={vi.fn()} />)
    await settle()
    expect(host.textContent).not.toContain('saved nothing')
    expect(host.textContent).toContain('waiting for the first sync')
  })

  it('asks before replacing a live address, and revokes one', async () => {
    mocks.answers['GET /api/account/health-token'] = { active: true, created: 1, lastSync: Date.now() - 3600000, last: { at: Date.now() - 3600000, date: '2026-10-13' } }
    mocks.answers['GET /api/health/daily'] = { days: { '2026-10-13': { distKm: 7.84, steps: 10312, activeKcal: 612, at: 1 } } }
    const host = mount(<AppleHealthSheet close={vi.fn()} />)
    await settle()
    expect(host.textContent).toContain('7.84 km')
    expect(host.textContent).toContain('Last sync')
    await click(host, 'Make a new address')
    expect(mocks.calls.some(c => c.method === 'POST')).toBe(false)
    expect(host.textContent).toContain('A new address stops the current one.')
    await click(host, 'Cancel')
    await click(host, 'Revoke token')
    expect(mocks.calls.some(c => c.method === 'DELETE' && c.path === '/api/account/health-token')).toBe(true)
    expect(mocks.toast).toHaveBeenCalledWith('Sync token revoked')
  })
})

describe('ingestUrl', () => {
  it('keeps the subpath the app is served from', () => {
    expect(ingestUrl({ origin: 'https://gym.example.com', pathname: '/myGym/index.html' })).toBe('https://gym.example.com/myGym/api/health/ingest')
    expect(ingestUrl({ origin: 'https://gym.example.com', pathname: '/' })).toBe('https://gym.example.com/api/health/ingest')
  })

  it('carries the token and the time zone that decides today', () => {
    expect(ingestUrl({ origin: 'https://gym.example.com', pathname: '/' }, { token: 'gymh_x', tz: 'Asia/Ho_Chi_Minh' }))
      .toBe('https://gym.example.com/api/health/ingest?key=gymh_x&tz=Asia%2FHo_Chi_Minh')
    expect(ingestUrl({ origin: 'https://gym.example.com', pathname: '/' }, { token: 'gymh_x', tz: '' }))
      .toBe('https://gym.example.com/api/health/ingest?key=gymh_x')
  })
})

describe('the Shortcut', () => {
  it('is run by name', () => {
    expect(runShortcutUrl()).toBe('shortcuts://run-shortcut?name=G-PLAN')
  })

  it('gets told what to change for each refusal', () => {
    expect(ingestProblem('invalid json')).toContain('JSON, not Form')
    expect(ingestProblem('nothing to save')).toContain('type Number')
    expect(ingestProblem('date must be YYYY-MM-DD')).toContain('Leave the date out')
    expect(ingestProblem('dist must be a number')).toContain('dist could not be read')
    expect(ingestProblem('something new')).toBe('something new')
  })
})
