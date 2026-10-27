// G-PLAN's food helpers inside the meal sheet (docs/dev/GETYOURMUSCLE_PLAN.md §4.6): the
// calculator — photos read by the server's free vision model, or dishes typed by name, at a
// table of one or a shared one — and the school lunch with how to eat it, the owner's dislikes
// left out. The numbers are lib/foods.js,
// lib/food-calc.js and lib/lunch.js; this file only lays them out.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, dateLocale } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import { fmtDate } from '../lib/format.js'
import { foodNames } from '../lib/foods.js'
import { calcRow, rowsFromPhoto, renameRow, rowFood, rowNutrition, countInPieces, setPieces, calcTotals, calcMealItem, MAX_SERVINGS, MAX_PIECES } from '../lib/food-calc.js'
import { parseMenu, planLunch, lunchTarget, lunchMealItem, setDislike, isDisliked, fmtServings } from '../lib/lunch.js'
import { addMeal, saveTemplate } from '../lib/gplan-day.js'
import Icon from './Icon.jsx'
import { Button, TextField, Switch, Stepper } from './ui.jsx'

const ui = () => useUI.getState()
const update = (...a) => useStore.getState().update(...a)
const n0 = v => Math.round(Number(v) || 0).toLocaleString(dateLocale())

/** What the server offers a signed-in owner (GET /api/config): photos read, the school menu. */
export function useFoodFeatures() {
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  return { photo: !!user && config?.meal_photo === true, lunch: !!user && config?.lunch === true }
}

/* ------------------------------------------------------------------- entry buttons ------ */

/**
 * "Photo" and "By food name" above the meal sheet's templates. The photo button is a <label>
 * around the file input, so the tap that opens the camera is the user's own — a script's
 * input.click() from inside a sheet is refused on iOS.
 */
export function FoodEntryButtons({ iso, slot, photo }) {
  return <div style={{ display: 'grid', gridTemplateColumns: photo ? '1fr 1fr' : '1fr', gap: 8, marginBottom: 14 }}>
    {photo && <PhotoPicker label={t('Photo')} className="btn tinted sm" style={{ width: '100%' }} onFile={f => foodCalcSheet(iso, slot, f)} />}
    <Button size="sm" variant="tinted" icon="list" style={{ width: '100%' }} onClick={() => foodCalcSheet(iso, slot)}>{t('By food name')}</Button>
  </div>
}

/* ------------------------------------------------------------------------ calculator --- */

export const foodCalcSheet = (iso, slot, file = null) => ui().openSheet(close => <FoodCalcSheet iso={iso} slot={slot} file={file} close={close} />)

// A phone photo is several MB; the model reads a 1024 px JPEG just as well, and it travels in a
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

function photoError(e) {
  if (e?.status === 422) return t('No food found in this photo — try another one, or add the dishes by name.')
  if (e?.status === 429) return t('Photo reading is used up for now — add the dishes by name, or try again later.')
  if (e?.status === 404 || e?.status === 503) return t('Photo reading is not set up on this server.')
  return t('The photo could not be read — try again, or add the dishes by name.')
}

// How a countable dish is counted, in the language of the moment.
const PIECE_UNIT = { slice: () => t('slices'), piece: () => t('pieces'), each: () => t('pcs') }

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

let photoSeq = 0

/**
 * The calculator: rows of dishes and amounts, from photos (any number — a plate that came later
 * is one more photo) or typed by name. At a shared table the shared dishes count the owner's
 * share only; a dish counted by the piece is what the owner ate.
 */
function FoodCalcSheet({ iso, slot, file, close }) {
  const features = useFoodFeatures()
  const [rows, setRows] = useState(() => (file ? [] : [calcRow('', 1)]))
  const [photos, setPhotos] = useState([])   // [{ id, preview, data, phase: 'reading'|'done'|'error', error }]
  const [note, setNote] = useState('')
  const [share, setShare] = useState({ on: false, people: 2, pct: 50 })
  const [asTemplate, setAsTemplate] = useState(false)
  const live = useRef(true)
  const started = useRef(false)
  const sharing = useRef(share.on)
  sharing.current = share.on
  const names = useMemo(() => foodNames(), [])
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])

  const patchPhoto = (id, patch) => setPhotos(ps => ps.map(p => (p.id === id ? { ...p, ...patch } : p)))
  // One photo read (again): its dishes replace the ones it gave before; every other row stays.
  const readPhoto = async (id, data, noteNow) => {
    patchPhoto(id, { phase: 'reading', error: null })
    const shared = sharing.current
    try {
      const r = await api('/api/meal/photo', { method: 'POST', body: JSON.stringify({ image: data, note: noteNow, shared }), timeout: 70000 })
      if (!live.current) return
      setRows(rs => [...rs.filter(x => x.src !== id && (x.src || x.name.trim())), ...rowsFromPhoto(r.items, { src: id, shared })])
      patchPhoto(id, { phase: 'done' })
    } catch (e) {
      if (live.current) patchPhoto(id, { phase: 'error', error: photoError(e) })
    }
  }
  const addPhoto = f => {
    const id = 'p' + ++photoSeq
    setPhotos(ps => [...ps, { id, preview: null, data: null, phase: 'reading', error: null }])
    shrinkPhoto(f).then(data => {
      if (!live.current) return
      patchPhoto(id, { preview: data, data })
      readPhoto(id, data, note)
    }).catch(() => { if (live.current) patchPhoto(id, { phase: 'error', error: t('This photo could not be opened.') }) })
  }
  useEffect(() => {
    if (!file || started.current) return
    started.current = true
    addPhoto(file)
  }, [file])

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
  const reading = photos.some(p => p.phase === 'reading')
  const add = () => {
    const item = calcMealItem(rows, t('Meal'), { share: frac, sharedName: (n, p) => t('{0} (shared, {1}%)', n, p) })
    update(st => {
      addMeal(st, iso, slot, item)
      if (asTemplate) saveTemplate(st, slot, item)
    })
    close()
  }

  return <>
    <h3 style={{ marginBottom: 2 }}>{file || photos.length ? t('Meal photo') : t('Food calculator')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{fmtDate(iso, true)}</div>

    {photos.map(p => <div key={p.id} className="row" style={{ gap: 12, alignItems: 'center', marginBottom: 10 }}>
      {p.preview ? <img src={p.preview} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 12, flex: 'none' }} />
        : <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--surface-2)', flex: 'none' }} />}
      <div className="small" style={{ flex: 1, minWidth: 0, color: p.phase === 'error' ? 'var(--orange)' : undefined }}>
        {p.phase === 'reading' ? t('Reading the photo… about 10 seconds.') : p.phase === 'error' ? p.error : t('Check the dishes and amounts — the calories follow.')}
      </div>
      {p.phase !== 'reading' && p.data && <Button size="sm" variant="tinted" onClick={() => readPhoto(p.id, p.data, note)}>{t('Read again')}</Button>}
    </div>)}
    {photos.length > 0 && <TextField value={note} onChange={e => setNote(e.target.value)} maxLength={200} style={{ marginBottom: 12 }}
      placeholder={t('What the photo does not show, e.g. ate half the rice')} />}

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
          {t('Shared dishes count as {0}% of what was served. Tap “Shared” on a dish that was only yours. Another plate came? Raise its amount, or add a photo of it.', pct)}
        </div>
      </>}
    </div>

    <datalist id="gplan-foods">{names.map(n => <option key={n} value={n} />)}</datalist>
    {rows.map(r => <FoodRow key={r.id} row={r} share={{ on: share.on, frac, pct }} onChange={f => setRow(r.id, f)}
      onRemove={() => setRows(rs => rs.filter(x => x.id !== r.id))} />)}
    <div className="row" style={{ gap: 8, marginTop: 6 }}>
      <Button size="sm" variant="ghost" icon="plus" style={{ width: 'auto' }} onClick={() => setRows(rs => [...rs, calcRow('', 1, null, { shared: share.on })])}>{t('Add a dish')}</Button>
      {features.photo && <PhotoPicker label={t('Add a photo')} className="btn ghost sm" onFile={addPhoto} />}
    </div>

    <div className="row between" style={{ margin: '12px 0 4px' }}>
      <b>{t('Total')}</b>
      <b>{t('{0} kcal · protein {1} g', n0(totals.kcal), n0(totals.p))}</b>
    </div>
    <div className="dim small" style={{ marginBottom: 10 }}>{t('Calories come from G-PLAN’s food table. A dish it does not have is marked as an estimate — correct its name if you can.')}</div>
    <div className="row between" style={{ margin: '6px 0 10px' }}>
      <span className="small">{t('Save as a template')}</span>
      <Switch checked={asTemplate} onChange={setAsTemplate} aria-label={t('Save as a template')} />
    </div>
    <Button variant="primary" icon="plus" disabled={reading || totals.kcal <= 0} onClick={add}>{t('Add')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}

function FoodRow({ row, share, onChange, onRemove }) {
  const r = rowFood(row)
  const piece = r?.food.piece || null
  const byPiece = row.pieces != null && !!piece
  const shared = share.on && row.shared && !byPiece
  const n = rowNutrition(row, share.frac)
  const servingUnit = r?.food.cat === 'rice' ? t('bowl') : t('serving')
  const badge = !r || r.how === 'exact' ? '' : r.how === 'similar' ? t('counted as {0}', r.food.name) : r.how === 'ai' ? t('AI estimate') : t('rough estimate')
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
        {badge && <div className="dim" style={{ color: r.how === 'similar' ? undefined : 'var(--orange)' }}>{badge}</div>}
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
