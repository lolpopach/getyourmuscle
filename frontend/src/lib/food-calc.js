// The meal sheet's calculator: dishes and how much of each — read off a photo, or typed by name —
// with every number from the food table (foods.js). Pure; components/GplanFood.jsx lays it out.
//
// A photo row also carries the model's own estimate for what it saw (`ai`). It is used for one
// case only: a dish the table can only guess at. The moment the owner renames a row, the estimate
// belonged to another dish and is dropped.
import { findFood, scaled, sumNutrition } from './foods.js'

let seq = 0
const newId = () => 'r' + Date.now().toString(36) + (seq++).toString(36)

export const MAX_SERVINGS = 6
/** Servings in quarter steps, 0 to 6. */
export const clampServings = v => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(MAX_SERVINGS, Math.max(0, Math.round(n * 4) / 4)) : 1
}

/** A row: a dish name, its servings, and (from a photo) the model's numbers for that amount. */
export function calcRow(name = '', servings = 1, ai = null) {
  const per = clampServings(ai?.servings ?? servings) || 1
  return {
    id: newId(),
    name: String(name || '').slice(0, 40),
    servings: clampServings(servings),
    ai: ai && Number(ai.kcal) > 0 ? { kcal: +ai.kcal / per, p: (+ai.p || 0) / per, c: (+ai.c || 0) / per, f: (+ai.f || 0) / per } : null,
  }
}

export const rowsFromPhoto = items => (Array.isArray(items) ? items : []).map(it => calcRow(it.name, it.servings, it))

/** A row renamed: the model's estimate was for the dish it saw, not this one. */
export const renameRow = (row, name) => ({ ...row, name: String(name || '').slice(0, 40), ai: null })

/**
 * Where a row's numbers come from → { food, how } or null for an empty name. `how` is findFood's
 * ('exact', 'similar', 'guess'), or 'ai' when the table could only guess and the photo model
 * had numbers of its own.
 */
export function rowFood(row) {
  const r = findFood(row?.name)
  if (!r) return null
  if (r.how === 'guess' && row.ai) return { food: { ...r.food, ...row.ai }, how: 'ai' }
  return r
}

export const rowNutrition = row => {
  const r = rowFood(row)
  return r ? scaled(r.food, row.servings) : { kcal: 0, p: 0, c: 0, f: 0 }
}

export const calcTotals = rows => sumNutrition((rows || []).map(rowNutrition))

/** The rows as one meal for the log, named after the first few dishes. */
export function calcMealItem(rows, fallback) {
  const eaten = (rows || []).filter(r => r.name.trim() && r.servings > 0)
  const names = eaten.map(r => r.name.trim())
  const name = names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '')
  return { name: (name || fallback || '').slice(0, 60), ...calcTotals(eaten) }
}
