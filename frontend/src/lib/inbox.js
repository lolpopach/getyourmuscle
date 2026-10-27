// The app's side of the inbox for Claude (api/claude-inbox.js, docs/dev/CLAUDE_MEALS.md): which
// meals to send, and Claude's answers put into the log. A meal is logged the moment it is written,
// with the food table's numbers; one the table cannot settle carries `pending` (the inbox entry's
// id) until the answer replaces its numbers. Pure; components/GplanFood.jsx does the requests.
import { SLOTS } from './gplan.js'
import { rowKnown } from './food-calc.js'

/** Whether a meal needs Claude: a photo, nothing the table could read, or a dish it cannot settle. */
export const needsClaude = (rows, photo) => !!photo || !rows.length || rows.some(r => !rowKnown(r))

/** Claude's answer as the meal's detail line: "흰쌀밥 1공기 · 제육볶음 1인분". */
export const resultDetail = result => (Array.isArray(result?.items) ? result.items : [])
  .map(i => (i.amount ? `${i.name} ${i.amount}` : i.name)).join(' · ').slice(0, 200)

/**
 * Puts each answered entry into its meal (found by the pending mark, or by `mealId`), the day
 * stamped for sync. Returns the ids of the entries the app is done with — applied, or whose meal
 * was deleted meanwhile — for it to acknowledge.
 */
export function applyInboxResults(S, entries, now = Date.now()) {
  const done = []
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e?.status !== 'done' || !e.result) continue
    const day = S?.gday?.[e.date]
    const list = Array.isArray(day?.meals?.[e.slot]) ? day.meals[e.slot] : []
    const item = list.find(x => x && (x.pending === e.id || (e.mealId && x.id === e.mealId)))
    if (item) {
      const r = e.result
      Object.assign(item, { kcal: Math.round(+r.kcal || 0), p: Math.round(+r.p || 0), c: Math.round(+r.c || 0), f: Math.round(+r.f || 0), by: 'claude', detail: resultDetail(r) })
      delete item.pending
      day._ts = now
    }
    done.push(e.id)
  }
  return done
}

/** How many of a day's meals still wait for Claude. */
export const pendingCount = day => SLOTS.reduce((n, s) => n + (Array.isArray(day?.meals?.[s]) ? day.meals[s] : []).filter(x => x?.pending).length, 0)
