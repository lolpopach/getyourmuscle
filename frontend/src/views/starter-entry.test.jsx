// @vitest-environment happy-dom
// Home and Plan both offer the starter plan to someone who has no routines yet. Both used to
// wire the button straight to the loader, which quietly handed the click event in as the plan
// id and loaded nothing at all — so both entry points are pinned here.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { loadStarterPlan, starterPlanSheet } from '../sheets.jsx'
import Home from './Home.jsx'
import Plan from './Plan.jsx'

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), loadStarterPlan: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(),
  dayAssignSheet: vi.fn(), planToolsSheet: vi.fn(),
}))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  starterPlanSheet.mockClear()
  loadStarterPlan.mockClear()
  useStore.setState(s => ({ S: { ...s.S, routines: [], week: {}, active: null }, user: null }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const starterButton = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Load starter plan')

describe.each([['Home', Home], ['Plan', Plan]])('%s empty state', (_name, View) => {
  it('opens the starter plan chooser instead of loading one plan blind', () => {
    act(() => root.render(<View />))
    const button = starterButton()
    expect(button).toBeTruthy()

    act(() => { button.click() })
    expect(starterPlanSheet).toHaveBeenCalledTimes(1)
  })

  it('drops the offer once the user has routines', () => {
    useStore.setState(s => ({ S: { ...s.S, routines: [{ id: 'r', name: 'Mine', emoji: 'star', ex: [] }] } }))
    act(() => root.render(<View />))
    expect(starterButton()).toBeFalsy()
  })
})

describe('Home empty state', () => {
  const gplanButton = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Load my G-PLAN routine')

  it('puts G-PLAN’s own routine in with one tap, without opening the chooser', () => {
    act(() => root.render(<Home />))
    act(() => { gplanButton().click() })
    expect(loadStarterPlan).toHaveBeenCalledTimes(1)
    expect(loadStarterPlan).toHaveBeenCalledWith('gplan-solid')
    expect(starterPlanSheet).not.toHaveBeenCalled()
  })

  it('drops it with the rest of the welcome card once there are routines', () => {
    useStore.setState(s => ({ S: { ...s.S, routines: [{ id: 'r', name: 'Mine', emoji: 'star', ex: [] }] } }))
    act(() => root.render(<Home />))
    expect(gplanButton()).toBeFalsy()
  })
})
