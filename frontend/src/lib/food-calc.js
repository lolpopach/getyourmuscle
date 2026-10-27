// The meal sheet's calculator: dishes and how much of each — read off one or more photos, or typed
// by name — with every number from the food table (foods.js). Pure; components/GplanFood.jsx lays
// it out.
//
// A photo row also carries the model's own estimate for what it saw (`ai`). It is used for one
// case only: a dish the table can only guess at. The moment the owner renames a row, the estimate
// belonged to another dish and is dropped.
//
// A shared table (§ 나눠 먹기): a row marked `shared` holds what was served for everyone, and only
// the owner's share of it counts — the share a fraction given once for the meal. A row counted in
// pieces (삼겹살 9점) is what the owner ate, never shared again.
import { findFood, scaled, sumNutrition } from './foods.js'

let seq = 0
const newId = () => 'r' + Date.now().toString(36) + (seq++).toString(36)

export const MAX_SERVINGS = 12
export const MAX_PIECES = 60
/** Servings in quarter steps, 0 to 12 (a shared table serves several). */
export const clampServings = v => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(MAX_SERVINGS, Math.max(0, Math.round(n * 4) / 4)) : 1
}
const clampPieces = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(MAX_PIECES, Math.max(0, n)) : 1 }

/**
 * A row: a dish name, its servings, and (from a photo) the model's numbers for that amount.
 * `extra` sets `shared` (part of a shared table) and `src` (the photo it came from).
 */
export function calcRow(name = '', servings = 1, ai = null, extra = {}) {
  const per = clampServings(ai?.servings ?? servings) || 1
  return {
    id: newId(),
    name: String(name || '').slice(0, 40),
    servings: clampServings(servings),
    pieces: null,
    shared: !!extra.shared,
    src: extra.src ?? null,
    ai: ai && Number(ai.kcal) > 0 ? { kcal: +ai.kcal / per, p: (+ai.p || 0) / per, c: (+ai.c || 0) / per, f: (+ai.f || 0) / per } : null,
  }
}

export const rowsFromPhoto = (items, extra = {}) => (Array.isArray(items) ? items : []).map(it => calcRow(it.name, it.servings, it, extra))

/** A row renamed: the model's estimate was for the dish it saw, and pieces were of the old dish. */
export const renameRow = (row, name) => {
  const next = { ...row, name: String(name || '').slice(0, 40), ai: null, pieces: null }
  if (row.pieces != null) next.servings = clampServings(rowServings(row))
  return next
}

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

/** How the dish is counted by the piece ({ kind, g }), or null for one that is not. */
export const rowPiece = row => rowFood(row)?.food.piece || null

/** The row's amount in servings, whichever way it was entered. */
export function rowServings(row) {
  const r = rowFood(row)
  if (row.pieces != null && r?.food.piece) return (row.pieces * r.food.piece.g) / r.food.g
  return Number(row.servings) || 0
}

/** Count the row by the piece (as many as its servings come to), or back in servings. */
export function countInPieces(row, on) {
  const piece = rowPiece(row)
  if (on && piece) {
    // Counting pieces is counting what the owner ate: not a share of the table any more.
    return { ...row, pieces: Math.max(1, Math.round((rowServings(row) * rowFood(row).food.g) / piece.g)), shared: false }
  }
  if (!on && row.pieces != null) return { ...row, servings: clampServings(rowServings(row)), pieces: null }
  return row
}

export const setPieces = (row, v) => ({ ...row, pieces: clampPieces(v) })

/** What the owner ate of a row: all of it, or `share` (0–1) of a shared one. */
export const rowFraction = (row, share = 1) => (row.shared && row.pieces == null ? Math.min(1, Math.max(0, share)) : 1)

export const rowNutrition = (row, share = 1) => {
  const r = rowFood(row)
  return r ? scaled(r.food, rowServings(row) * rowFraction(row, share)) : { kcal: 0, p: 0, c: 0, f: 0 }
}

export const calcTotals = (rows, share = 1) => sumNutrition((rows || []).map(r => rowNutrition(r, share)))

/**
 * The rows as one meal for the log, named after the first few dishes; `sharedName` (names, pct)
 * words the name of a meal that had shared dishes in it.
 */
export function calcMealItem(rows, fallback, { share = 1, sharedName = null } = {}) {
  const eaten = (rows || []).filter(r => r.name.trim() && rowServings(r) > 0)
  const names = eaten.map(r => r.name.trim())
  let name = names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '') || fallback || ''
  if (sharedName && share < 1 && eaten.some(r => r.shared && r.pieces == null)) name = sharedName(name, Math.round(share * 100))
  return { name: name.slice(0, 60), ...calcTotals(eaten, share) }
}
