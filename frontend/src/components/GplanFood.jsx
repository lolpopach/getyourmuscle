// G-PLAN's food helpers inside the meal sheet (docs/dev/GETYOURMUSCLE_PLAN.md §4.6): the entry
// that counts what the owner writes and saves it at once — sending what the food table cannot
// settle, and any photo, to Claude (docs/dev/CLAUDE_MEALS.md) — the calculator for a shared table
// or counting by the piece, and the school lunch with how to eat it, the owner's dislikes left
// out. The numbers are lib/foods.js, food-text.js, food-calc.js, inbox.js and lunch.js; this file
// lays them out and does the requests.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, dateLocale } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import { fmtDate, uid } from '../lib/format.js'
import { foodNames, setMyFoods } from '../lib/foods.js'
import { calcRow, renameRow, rowFood, rowNutrition, rowServings, rowKnown, countInPieces, setPieces, calcTotals, calcMealItem, MAX_SERVINGS, MAX_PIECES } from '../lib/food-calc.js'
import { rowsFromText } from '../lib/food-text.js'
import { applyInboxResults, needsClaude } from '../lib/inbox.js'
import { parseMenu, planLunch, lunchTarget, lunchMealItem, setDislike, isDisliked, fmtServings } from '../lib/lunch.js'
import { addMeal, saveTemplate } from '../lib/gplan-day.js'
import Icon from './Icon.jsx'
import { Button, TextField, Switch, Stepper, NumberField } from './ui.jsx'

const ui = () => useUI.getState()
const update = (...a) => useStore.getState().update(...a)
const n0 = v => Math.round(Number(v) || 0).toLocaleString(dateLocale())

/* ------------------------------------------------- the owner's foods, worked out by Claude --- */

// GET /api/foods, kept in this browser too, so a name Claude worked out counts offline as well.
const FOODS_KEY = 'gplan_my_foods'
const foodsListeners = new Set()
let foodsVersion = 0
function loadMyFoods(list) {
  setMyFoods(list)
  foodsVersion++
  for (const l of foodsListeners) l()
}
try { loadMyFoods(JSON.parse(localStorage.getItem(FOODS_KEY) || '[]')) } catch { /* no storage: the server's copy comes with the next sync */ }
const useFoodsVersion = () => useSyncExternalStore(l => { foodsListeners.add(l); return () => foodsListeners.delete(l) }, () => foodsVersion)

/** What the server offers a signed-in owner (GET /api/config): the school menu, and Claude linked. */
export function useFoodFeatures() {
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  return { lunch: !!user && config?.lunch === true, claude: !!user && config?.claude?.linked === true }
}

/**
 * Claude's answers into the log and the owner's foods into the lookup: when the app opens, when
 * it comes back to the front, and every ten minutes while it is open.
 */
export function useClaudeSync() {
  const { claude } = useFoodFeatures()
  useEffect(() => {
    if (!claude) return
    let live = true
    const run = async () => {
      try {
        const [inbox, foods] = await Promise.all([api('/api/inbox'), api('/api/foods')])
        if (!live) return
        const list = Array.isArray(foods?.foods) ? foods.foods : []
        loadMyFoods(list)
        try { localStorage.setItem(FOODS_KEY, JSON.stringify(list)) } catch { /* full or blocked */ }
        const answered = (Array.isArray(inbox?.entries) ? inbox.entries : []).filter(e => e.status === 'done')
        if (!answered.length) return
        let ids = []
        update(st => { ids = applyInboxResults(st, answered) })
        if (ids.length) await api('/api/inbox/ack', { method: 'POST', body: JSON.stringify({ ids }) })
      } catch { /* offline or signed out: the next run catches up */ }
    }
    run()
    const onShow = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onShow)
    const timer = setInterval(run, 10 * 60000)
    return () => { live = false; document.removeEventListener('visibilitychange', onShow); clearInterval(timer) }
  }, [claude])
}

/**
 * Logs a meal now, with the food table's numbers; when `toClaude`, also sends it to Claude's inbox
 * and marks it pending until the answer replaces the numbers (useClaudeSync). Not sent (offline),
 * it stays as counted. Resolves to whether it went to Claude.
 */
async function logMeal({ iso, slot, item, text, photo, toClaude, asTemplate }) {
  const id = toClaude ? 'm' + uid() : null
  let stored = null
  update(st => {
    stored = addMeal(st, iso, slot, { ...item, ...(id ? { pending: id } : {}) })
    if (asTemplate && !id) saveTemplate(st, slot, item)
  })
  if (!id) return false
  try {
    await api('/api/inbox', { method: 'POST', timeout: 60000, body: JSON.stringify({ id, date: iso, slot, mealId: stored.id, text, photo, estimate: { kcal: item.kcal, p: item.p, c: item.c, f: item.f } }) })
    return true
  } catch {
    update(st => {
      const m = (st.gday?.[iso]?.meals?.[slot] || []).find(x => x.id === stored.id)
      if (m) { delete m.pending; st.gday[iso]._ts = Date.now() }
    })
    ui().toast(t('Could not send it to Claude — saved with the food table’s numbers.'))
    return false
  }
}

// A phone photo is several MB; Claude reads a 1024 px JPEG just as well, and it travels in a
// fraction of the time. Browsers apply the camera's rotation before drawing.
export function shrinkPhoto(file, max = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.naturalWidth * scale))
        c.height = Math.max(1, Math.round(img.naturalHeight * scale))
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/jpeg', quality))
      } catch (e) { reject(e) } finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')) }
    img.src = url
  })
}

// A label whose file input opens the camera or the library: the tap is the user's own (iOS
// refuses a script's input.click() from inside a sheet).
function PhotoPicker({ label, className, style, onFile }) {
  return <label className={className} style={{ position: 'relative', overflow: 'hidden', ...style }}>
    <Icon name="camera" /><span>{label}</span>
    <input type="file" accept="image/*" aria-label={label}
      style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
      onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f) }} />
  </label>
}

// How a countable dish is counted, in the language of the moment.
const PIECE_UNIT = { slice: () => t('slices'), piece: () => t('pieces'), each: () => t('pcs') }

/** A row's amount as written for a person: "1/2공기", "9점", "1 1/2인분". */
function amountLabel(row) {
  const r = rowFood(row)
  if (row.pieces != null && r?.food.piece) return `${row.pieces}${PIECE_UNIT[r.food.piece.kind]()}`
  return `${fmtServings(row.servings)}${r?.food.cat === 'rice' ? t('bowl') : t('serving')}`
}

/* ---------------------------------------------------------------------- write it down --- */

/**
 * The meal sheet's entry: what was eaten, written the way one would say it ("제육덮밥, 계란후라이
 * 2개, 밥 반 공기"), counted from the food table as it is typed and saved with one tap. With Claude
 * linked, a dish the table cannot settle — or a photo — goes to Claude as well, and its answer
 * replaces the table's numbers when it comes back.
 */
export function SmartEntry({ iso, slot }) {
  const { claude } = useFoodFeatures()
  const version = useFoodsVersion()
  const [text, setText] = useState('')
  const [photo, setPhoto] = useState(null)
  const [manual, setManual] = useState(null)
  const [asTemplate, setAsTemplate] = useState(false)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => rowsFromText(text), [text, version])
  const totals = calcTotals(rows)
  const manualOn = !!manual && ((manual.kcal || 0) > 0 || (manual.p || 0) > 0)
  const toClaude = claude && !manualOn && (rows.length > 0 || !!photo) && needsClaude(rows, photo)
  const canSave = !busy && (manualOn || rows.length > 0 || !!photo)
  const setNum = k => v => setManual(m => ({ ...m, [k]: v }))

  const save = async () => {
    const name = text.trim().slice(0, 60) || (photo ? t('Meal photo') : t('Quick entry'))
    const item = manualOn ? { name, kcal: manual.kcal || 0, p: manual.p || 0, c: manual.c || 0, f: manual.f || 0 } : { name, ...totals }
    setBusy(true)
    const sent = await logMeal({ iso, slot, item, text: text.trim(), photo, toClaude, asTemplate })
    setBusy(false)
    setText(''); setPhoto(null); setManual(null); setAsTemplate(false)
    if (sent) ui().toast(t('Saved — Claude will work it out'))
  }
  const pickPhoto = f => shrinkPhoto(f).then(setPhoto).catch(() => ui().toast(t('This photo could not be opened.')))

  return <div className="smart-entry">
    <b className="small" style={{ display: 'block', margin: '14px 0 6px' }}>{t('Write what you ate')}</b>
    <TextField value={text} onChange={e => setText(e.target.value)} maxLength={300} placeholder={t('e.g. 제육덮밥, 계란후라이 2개, 밥 반 공기')} aria-label={t('Write what you ate')} />
    {photo && <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 8 }}>
      <img src={photo} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 12, flex: 'none' }} />
      <span className="small muted" style={{ flex: 1 }}>{t('Claude will look at this photo.')}</span>
      <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }} onClick={() => setPhoto(null)} aria-label={t('Delete')}><Icon name="trash" /></button>
    </div>}
    <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
      {claude && <PhotoPicker label={t('Add a photo')} className="btn ghost sm" onFile={pickPhoto} />}
      <Button size="sm" variant="ghost" icon="list" style={{ width: 'auto' }} onClick={() => foodCalcSheet(iso, slot, text)}>{t('Shared table · by the piece')}</Button>
    </div>

    {!manualOn && rows.length > 0 && <div style={{ marginTop: 6 }}>
      {rows.map(r => {
        const known = rowKnown(r)
        const n = rowNutrition(r)
        return <div key={r.id} className="row between small" style={{ gap: 8, padding: '3px 0' }}>
          <span style={{ minWidth: 0 }}>{r.name} · {amountLabel(r)}</span>
          <span style={{ whiteSpace: 'nowrap', color: known ? undefined : 'var(--orange)' }}>
            {n0(n.kcal)} kcal{!known && ' · ' + (toClaude ? t('Claude will check') : t('rough estimate'))}
          </span>
        </div>
      })}
      <div className="row between small" style={{ marginTop: 4 }}>
        <b>{t('Total')}</b><b>{t('{0} kcal · protein {1} g', n0(totals.kcal), n0(totals.p))}</b>
      </div>
    </div>}
    {toClaude && <div className="dim small" style={{ marginTop: 4 }}>{t('Saved now with the food table’s numbers; Claude works it out and replaces them.')}</div>}

    <Button size="sm" variant="ghost" style={{ width: 'auto', marginTop: 4 }} trailingIcon={manual ? 'chevronUp' : 'chevronDown'}
      onClick={() => setManual(m => (m ? null : { kcal: null, p: null, c: null, f: null }))}>{t('Enter numbers yourself')}</Button>
    {manual && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginTop: 4 }}>
      {[['kcal', 'kcal'], ['p', t('Protein')], ['c', t('Carbs')], ['f', t('Fat')]].map(([k, label]) => <label key={k} className="small muted" style={{ display: 'grid', gap: 4 }}>
        {label}<NumberField value={manual[k]} onChange={setNum(k)} nullable decimal={false} className="field" />
      </label>)}
    </div>}
    {!toClaude && <div className="row between" style={{ margin: '10px 0' }}>
      <span className="small">{t('Save as a template')}</span>
      <Switch checked={asTemplate} onChange={setAsTemplate} aria-label={t('Save as a template')} />
    </div>}
    <Button variant="primary" icon="plus" style={{ marginTop: toClaude ? 10 : 0 }} disabled={!canSave} onClick={save}>
      {toClaude ? t('Save and send to Claude') : t('Add')}
    </Button>
  </div>
}

/* ------------------------------------------------------------------------ calculator --- */

export const foodCalcSheet = (iso, slot, text = '') => ui().openSheet(close => <FoodCalcSheet iso={iso} slot={slot} text={text} close={close} />)

/**
 * The calculator: rows of dishes and amounts, typed by name or carried over from what was
 * written. At a shared table the shared dishes count the owner's share only; a dish counted by
 * the piece is what the owner ate. A dish the table cannot settle goes to Claude like any entry.
 */
function FoodCalcSheet({ iso, slot, text, close }) {
  const { claude } = useFoodFeatures()
  useFoodsVersion()
  const [rows, setRows] = useState(() => { const r = rowsFromText(text); return r.length ? r : [calcRow('', 1)] })
  const [share, setShare] = useState({ on: false, people: 2, pct: 50 })
  const [asTemplate, setAsTemplate] = useState(false)
  const names = useMemo(() => foodNames(), [])

  const pct = Math.min(100, Math.max(1, Math.round(Number(share.pct) || 1)))
  const frac = share.on ? pct / 100 : 1
  const setSharing = on => {
    setShare(s => ({ ...s, on }))
    // Switched on, every dish so far is the table's; the owner marks what was only theirs.
    if (on) setRows(rs => rs.map(r => (r.pieces == null ? { ...r, shared: true } : r)))
  }
  const setPeople = v => setShare(s => ({ ...s, people: v, pct: Math.round(100 / Math.max(1, Math.round(Number(v) || 1))) }))

  const setRow = (id, f) => setRows(rs => rs.map(r => (r.id === id ? f(r) : r)))
  const totals = calcTotals(rows, frac)
  const named = rows.filter(r => r.name.trim() && rowServings(r) > 0)
  const toClaude = claude && named.some(r => !rowKnown(r))
  const add = async () => {
    const item = calcMealItem(rows, t('Meal'), { share: frac, sharedName: (n, p) => t('{0} (shared, {1}%)', n, p) })
    // What Claude reads: each dish with its amount, and the table it was shared at.
    const said = named.map(r => `${r.name} ${amountLabel(r)}${share.on && r.shared && r.pieces == null ? ' (' + t('Shared') + ')' : ''}`).join(', ') +
      (share.on ? ' — ' + t('{0} people at the table, my share {1}%', share.people, pct) : '')
    close()
    const sent = await logMeal({ iso, slot, item, text: said, photo: null, toClaude, asTemplate })
    if (sent) ui().toast(t('Saved — Claude will work it out'))
  }

  return <>
    <h3 style={{ marginBottom: 2 }}>{t('Food calculator')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{fmtDate(iso, true)}</div>

    <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: '10px 12px', marginBottom: 6 }}>
      <div className="row between">
        <b className="small">{t('Shared with others')}</b>
        <Switch checked={share.on} onChange={setSharing} aria-label={t('Shared with others')} />
      </div>
      {share.on && <>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <Stepper label={t('People at the table')} value={share.people} step={1} min={2} max={20} decimal={false} unit={t('people')} onChange={setPeople} />
          <Stepper label={t('My share')} value={share.pct} step={5} min={5} max={100} decimal={false} unit="%" onChange={v => setShare(s => ({ ...s, pct: v }))} />
        </div>
        <div className="dim small" style={{ marginTop: 8 }}>
          {t('Shared dishes count as {0}% of what was served. Tap “Shared” on a dish that was only yours. Another plate came? Raise its amount.', pct)}
        </div>
      </>}
    </div>

    <datalist id="gplan-foods">{names.map(n => <option key={n} value={n} />)}</datalist>
    {rows.map(r => <FoodRow key={r.id} row={r} claude={claude} share={{ on: share.on, frac, pct }} onChange={f => setRow(r.id, f)}
      onRemove={() => setRows(rs => rs.filter(x => x.id !== r.id))} />)}
    <Button size="sm" variant="ghost" icon="plus" style={{ width: 'auto', marginTop: 6 }} onClick={() => setRows(rs => [...rs, calcRow('', 1, { shared: share.on })])}>{t('Add a dish')}</Button>

    <div className="row between" style={{ margin: '12px 0 4px' }}>
      <b>{t('Total')}</b>
      <b>{t('{0} kcal · protein {1} g', n0(totals.kcal), n0(totals.p))}</b>
    </div>
    <div className="dim small" style={{ marginBottom: 10 }}>
      {toClaude ? t('Saved now with the food table’s numbers; Claude works it out and replaces them.') : t('Calories come from G-PLAN’s food table. A dish it does not have is marked as an estimate — correct its name if you can.')}
    </div>
    {!toClaude && <div className="row between" style={{ margin: '6px 0 10px' }}>
      <span className="small">{t('Save as a template')}</span>
      <Switch checked={asTemplate} onChange={setAsTemplate} aria-label={t('Save as a template')} />
    </div>}
    <Button variant="primary" icon="plus" disabled={totals.kcal <= 0 && !toClaude} onClick={add}>{toClaude ? t('Save and send to Claude') : t('Add')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}

function FoodRow({ row, claude, share, onChange, onRemove }) {
  const r = rowFood(row)
  const piece = r?.food.piece || null
  const byPiece = row.pieces != null && !!piece
  const shared = share.on && row.shared && !byPiece
  const n = rowNutrition(row, share.frac)
  const servingUnit = r?.food.cat === 'rice' ? t('bowl') : t('serving')
  const badge = !r || r.how === 'exact' ? '' : r.how === 'mine' ? t('worked out by Claude') : r.how === 'similar' ? t('counted as {0}', r.food.name)
    : claude ? t('Claude will check') : t('rough estimate')
  const chip = on => 'chip nocap' + (on ? ' on' : '')
  return <div className="food-row" style={{ padding: '10px 0', borderBottom: '0.5px solid var(--sep)' }}>
    <div className="row" style={{ gap: 8 }}>
      <TextField value={row.name} list="gplan-foods" maxLength={40} style={{ flex: 1, minWidth: 0 }} placeholder={t('Dish name')}
        onChange={e => onChange(x => renameRow(x, e.target.value))} aria-label={t('Dish')} />
      <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)', flex: 'none', alignSelf: 'center' }}
        onClick={onRemove} aria-label={t('Delete')}><Icon name="trash" /></button>
    </div>
    <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
      <div style={{ width: 156, flex: 'none' }}>
        {byPiece
          ? <Stepper value={row.pieces} step={1} min={0} max={MAX_PIECES} decimal={false} unit={PIECE_UNIT[piece.kind]()} onChange={v => onChange(x => setPieces(x, v))} />
          : <Stepper value={row.servings} step={0.25} min={0} max={MAX_SERVINGS} unit={servingUnit} onChange={v => onChange(x => ({ ...x, servings: v }))} />}
      </div>
      <div className="small" style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
        <b>{n0(n.kcal)} kcal</b> · {t('protein {0} g', n0(n.p))}
        {shared && <div className="dim">{t('your {0}%', share.pct)}</div>}
        {badge && <div className="dim" style={{ color: r.how === 'similar' || r.how === 'mine' ? undefined : 'var(--orange)' }}>{badge}</div>}
      </div>
    </div>
    {(piece || share.on) && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {piece && <>
        <button className={chip(!byPiece)} onClick={() => onChange(x => countInPieces(x, false))} aria-pressed={!byPiece}>{servingUnit}</button>
        <button className={chip(byPiece)} onClick={() => onChange(x => countInPieces(x, true))} aria-pressed={byPiece}>{PIECE_UNIT[piece.kind]()}</button>
      </>}
      {share.on && !byPiece && <button className={chip(row.shared)} aria-pressed={row.shared}
        onClick={() => onChange(x => ({ ...x, shared: !x.shared }))}>{row.shared ? t('Shared') : t('Mine only')}</button>}
    </div>}
  </div>
}

/* ---------------------------------------------------------------------- school lunch --- */

// Each day's menu once per page load: the sheet opens and closes, the menu does not change.
const lunchCache = new Map()
export const forgetLunchCache = () => lunchCache.clear()

function amountText(r) {
  if (r.disliked) return t('You don’t eat this — left out')
  if (r.amount === 0) return r.tips.includes('extra') ? t('Extra counter — only if you want') : t('Leave it today')
  if (r.tips.includes('soup')) return t('The solids, half the broth')
  const s = fmtServings(r.amount)
  if (r.food.cat === 'rice') return t('{0} bowl', s)
  if (r.amount > 1) return t('{0} servings — ask for seconds', s)
  return t('{0} serving', s)
}
const TIPS = {
  fried: () => t('peel off half the batter'),
  stew: () => t('mostly the solids'),
  'less-rice': () => t('a heavy menu today'),
  'more-rice': () => t('there is room today'),
}
const tipText = r => (r.amount > 0 ? r.tips.filter(k => TIPS[k]).map(k => ' · ' + TIPS[k]()).join('') : '')

/**
 * The day's school lunch in the lunch sheet: every dish with how much to take, the protein
 * dishes stretched to lunch's share of the day, the owner's dislikes left out (a tap marks or
 * unmarks one), and one button that logs it all as the meal.
 */
export function LunchCard({ iso }) {
  const S = useStore(s => s.S)
  const [state, setState] = useState(() => (lunchCache.has(iso) ? { phase: 'ok', meals: lunchCache.get(iso) } : { phase: 'loading' }))
  const [word, setWord] = useState('')
  useEffect(() => {
    if (lunchCache.has(iso)) { setState({ phase: 'ok', meals: lunchCache.get(iso) }); return }
    let live = true
    setState({ phase: 'loading' })
    api('/api/lunch?date=' + iso)
      .then(r => { const meals = Array.isArray(r?.meals) ? r.meals : []; lunchCache.set(iso, meals); if (live) setState({ phase: 'ok', meals }) })
      .catch(() => { if (live) setState({ phase: 'error' }) })
    return () => { live = false }
  }, [iso])

  const dislikes = S.gplan?.dislikes || []
  const meal = state.meals && (state.meals.find(m => /중식|점심|lunch/i.test(m.label)) || state.meals[0])
  const plan = useMemo(() => (meal ? planLunch(parseMenu(meal.dishes), { target: lunchTarget(S.gplan?.targets), dislikes }) : null), [meal, S.gplan?.targets, dislikes])

  const toggle = r => update(st => {
    if (r.disliked) for (const w of (st.gplan?.dislikes || []).filter(w => isDisliked(r.name, [w]))) setDislike(st, w, false)
    else setDislike(st, r.name, true)
  })
  const addWord = () => { const w = word.trim(); if (!w) return; update(st => { setDislike(st, w, true) }); setWord('') }
  const over = plan ? plan.totals.kcal - plan.target.kcal : 0

  return <div style={{ background: 'var(--surface-2)', borderRadius: 14, padding: 12, marginBottom: 14 }}>
    <div className="row between" style={{ marginBottom: 6, gap: 8 }}>
      <b className="small">{t('School lunch')}</b>
      {plan && <span className="small muted">{t('Goal {0} kcal · protein {1} g', n0(plan.target.kcal), n0(plan.target.p))}</span>}
    </div>
    {state.phase === 'loading' && <div className="small muted">{t('Loading…')}</div>}
    {state.phase === 'error' && <div className="small muted">{t('The school menu could not be loaded.')}</div>}
    {state.phase === 'ok' && !plan && <div className="small muted">{t('No school lunch on this day.')}</div>}

    {plan && <>
      <div className="dim small" style={{ marginBottom: 4 }}>{t('Tap a dish you don’t eat — it is left out and the rest re-balanced.')}</div>
      {plan.rows.map((r, i) => <button key={i + r.name} className="lunch-row" onClick={() => toggle(r)}
        aria-pressed={r.disliked} aria-label={r.name}
        style={{ display: 'flex', width: '100%', gap: 10, alignItems: 'center', padding: '8px 0', textAlign: 'start', background: 'none', borderTop: i ? '0.5px solid var(--sep)' : 'none', color: 'var(--label)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, textDecoration: r.disliked ? 'line-through' : 'none', opacity: r.amount > 0 ? 1 : 0.55 }}>
            {r.name}
          </div>
          <div className="small" style={{ color: r.amount === 0 ? 'var(--label-3)' : r.tips.includes('seconds') ? 'var(--green)' : 'var(--label-2)' }}>
            {amountText(r)}{tipText(r)}
          </div>
        </div>
        {r.amount > 0 && <div className="small" style={{ textAlign: 'right', whiteSpace: 'nowrap', flex: 'none' }}>
          {n0(r.n.kcal)} kcal<div className="dim">P {n0(r.n.p)} g</div>
        </div>}
      </button>)}
      <div className="row between small" style={{ marginTop: 8, gap: 8 }}>
        <b>{t('Eaten this way')}</b>
        <b>{t('{0} kcal · protein {1} g', n0(plan.totals.kcal), n0(plan.totals.p))}</b>
      </div>
      {plan.short > 0 && <div className="small" style={{ color: 'var(--orange)', marginTop: 4 }}>{t('{0} g protein short — the snack closes it', plan.short)}</div>}
      {over > 100 && <div className="small muted" style={{ marginTop: 4 }}>{t('{0} kcal over lunch’s share — eat that much less at dinner', n0(over))}</div>}
      <Button variant="primary" icon="plus" style={{ marginTop: 12 }} onClick={() => update(st => { addMeal(st, iso, 'l', { ...lunchMealItem(plan, t('School lunch')), tpl: 'school-lunch' }) })}>
        {t('Log it as suggested')}
      </Button>
    </>}

    {state.phase === 'ok' && <>
      {dislikes.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {dislikes.map(w => <button key={w} className="chip nocap" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => update(st => { setDislike(st, w, false) })} aria-label={t('Delete') + ' ' + w}>
          <Icon name="xmark" /> {w}
        </button>)}
      </div>}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <TextField value={word} onChange={e => setWord(e.target.value)} maxLength={30} style={{ flex: 1, minWidth: 0 }}
          placeholder={t('A food you don’t eat, e.g. eggplant')} onKeyDown={e => { if (e.key === 'Enter') addWord() }} />
        <Button size="sm" variant="tinted" disabled={!word.trim()} onClick={addWord}>{t('Add')}</Button>
      </div>
    </>}
  </div>
}
