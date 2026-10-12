// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppleHealthRow, AppleHealthSheet, ingestUrl } from './AppleHealth.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Apple Health sync on screen (api/health.js): the Settings row only on a server that knows the
   route, the token shown once with the address the Shortcut posts to, replacing it behind a second
   tap, revoking it, and the last week's days. The API is a stand-in; what each step sends is the
   point. */
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
  it('issues a token, shows it once with the ingest address, and copies it', async () => {
    mocks.answers['GET /api/account/health-token'] = { active: false, created: null, lastSync: null }
    mocks.answers['GET /api/health/daily'] = { days: {} }
    mocks.answers['POST /api/account/health-token'] = { token: 'gymh_abc', created: 2 }
    const host = mount(<AppleHealthSheet close={vi.fn()} />)
    await settle()
    expect(host.textContent).toContain('Nothing synced in the last 7 days.')
    await click(host, 'Create a sync token')
    expect(mocks.calls.some(c => c.method === 'POST' && c.path === '/api/account/health-token')).toBe(true)
    expect(host.textContent).toContain('gymh_abc')
    expect(host.textContent).toContain(ingestUrl())
    expect(host.textContent).toContain('Find Health Samples')
    await click(host, 'Copy address')
    expect(mocks.copyText).toHaveBeenCalledWith(ingestUrl())
  })

  it('asks before replacing a live token, and revokes one', async () => {
    mocks.answers['GET /api/account/health-token'] = { active: true, created: 1, lastSync: Date.now() - 3600000 }
    mocks.answers['GET /api/health/daily'] = { days: { '2026-10-13': { distKm: 7.84, steps: 10312, activeKcal: 612, at: 1 } } }
    const host = mount(<AppleHealthSheet close={vi.fn()} />)
    await settle()
    expect(host.textContent).toContain('7.84 km')
    await click(host, 'Make a new token')
    expect(mocks.calls.some(c => c.method === 'POST')).toBe(false)
    expect(host.textContent).toContain('A new token stops the current one.')
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
})
