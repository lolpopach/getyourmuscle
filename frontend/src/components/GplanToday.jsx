// G-PLAN's "today" card on Home (docs/dev/GETYOURMUSCLE_PLAN.md §4.4): the day's checklist —
// supplements, the four meals, the workout, steps and water — under the budget that is left and
// the one thing to do next. Tapping a meal opens its sheet: templates in one tap, or a quick
// entry. The arithmetic is lib/gplan-day.js; this file only lays it out.
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, dateLocale } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'
import { todayISO, fmtDate } from '../lib/format.js'
import { effectiveRoutines } from '../lib/history.js'
import { SLOTS } from '../lib/gplan.js'
import { dayOf, dayTotals, slotTotals, remaining, addMeal, removeMeal, toggleSupp, setDayValue, saveTemplate, removeTemplate, suppStreak, checklist, nextHint } from '../lib/gplan-day.js'
import Icon from './Icon.jsx'
import { Row, Button, NumberField, TextField, Switch } from './ui.jsx'

const ui = () => useUI.getState()
const update = (...a) => useStore.getState().update(...a)
const n0 = v => Math.round(Number(v) || 0).toLocaleString(dateLocale())
const isoShift = (iso, days) => {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

// Labels and icons of the four slots. Functions, so the label is read in the language of the
// moment (check-source-strings.mjs only sees literals inside t()).
export const SLOT_LABEL = { b: () => t('Breakfast'), l: () => t('Lunch'), s: () => t('Snack'), d: () => t('Dinner') }
const SLOT_ICON = { b: ['sun', 'var(--orange)'], l: ['clock', 'var(--blue)'], s: ['flame', 'var(--red)'], d: ['moon', 'var(--indigo)'] }

// A thin bar of `value` out of `max`, turning orange once over.
function Bar({ value, max, color = 'var(--acc)' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const over = max > 0 && value > max
  return <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
    <div style={{ width: pct + '%', height: '100%', borderRadius: 3, background: over ? 'var(--orange)' : color }} />
  </div>
}

// The day's numbers from Apple Health (components/AppleHealth.jsx, api/health.js), while signed
// in to a server that has them. null otherwise — the card then shows only what was typed.
function useSynced(iso, enabled) {
  const [day, setDay] = useState(null)
  useEffect(() => {
    if (!enabled) { setDay(null); return }
    let live = true
    api('/api/health/daily?from=' + iso)
      .then(r => { if (live) setDay(r?.days?.[iso] || null) })
      .catch(() => { if (live) setDay(null) })
    return () => { live = false }
  }, [iso, enabled])
  return day
}

function hintText(h) {
  switch (h.key) {
    case 'protein-next': return t('{0} g protein to go — make {1} count', h.args[0], SLOT_LABEL[h.args[1]]())
    case 'protein-short': return t('{0} g protein short — a shake or a chicken breast closes it', h.args[0])
    case 'over': return t('{0} kcal over today’s budget', h.args[0])
    default: return t('On track — protein done, within budget')
  }
}

export function GplanTodayCard({ onWorkout }) {
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const today = todayISO()
  const [iso, setIso] = useState(today)
  const plan = S.gplan
  const synced = useSynced(iso, !!user && !DEMO && !MOBILE)
  if (!plan) return null

  const day = dayOf(S, iso)
  const totals = dayTotals(day)
  const left = remaining(plan.targets, totals)
  const routines = effectiveRoutines(S, iso)
  const workoutDone = S.workouts.some(w => w.d === iso)
  const list = checklist(S, iso, { workoutDone, restDay: !routines.length, synced })
  const hint = nextHint(plan.targets, day)
  const steps = Math.max(Number(day.steps) || 0, Number(synced?.steps) || 0)
  const km = Math.max(Number(day.km) || 0, Number(synced?.distKm) || 0)
  const water = Number(day.water) || 0
  const goals = plan.goals || {}

  return <div className="card">
    <div className="row between" style={{ marginBottom: 8 }}>
      <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => setIso(isoShift(iso, -1))} aria-label={t('Previous day')}><Icon name="chevronLeft" /></button>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 600 }}>{iso === today ? t('Today') : fmtDate(iso, true)}</div>
        <div className="small muted">{t('{0} of {1} done', list.done, list.total)}</div>
      </div>
      <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15, opacity: iso >= today ? 0.3 : 1 }} disabled={iso >= today} onClick={() => setIso(isoShift(iso, 1))} aria-label={t('Next day')}><Icon name="chevronRight" /></button>
    </div>

    <div className="row between small" style={{ marginBottom: 4 }}>
      <span><b>{left.kcal >= 0 ? t('{0} kcal left', n0(left.kcal)) : t('{0} kcal over', n0(-left.kcal))}</b></span>
      <span className="muted">{n0(totals.kcal)} / {n0(plan.targets.kcal)}</span>
    </div>
    <Bar value={totals.kcal} max={plan.targets.kcal} />
    <div className="row between small" style={{ margin: '8px 0 4px' }}>
      <span><b>{left.p > 0 ? t('Protein {0} g left', n0(left.p)) : t('Protein done')}</b></span>
      <span className="muted">{n0(totals.p)} / {n0(plan.targets.p)} g</span>
    </div>
    <Bar value={totals.p} max={plan.targets.p} color="var(--blue)" />
    <div className="small" style={{ marginTop: 10, color: hint.key === 'on-track' ? 'var(--green)' : hint.key === 'over' ? 'var(--orange)' : 'var(--label)' }}>
      👉 {hintText(hint)}
    </div>

    <div className="sect-b" style={{ marginTop: 12, background: 'var(--surface-2)' }}>
      {(plan.supps || []).map(s => {
        const took = !!day.supps?.[s.id]
        const streak = suppStreak(S, s.id, iso)
        return <Row key={s.id} icon="star" iconTint="var(--yellow)" title={s.dose ? `${s.name} ${s.dose}` : s.name}
          subtitle={streak ? t('{0}-day streak', streak) : t('Tap when taken')}
          onClick={() => update(st => { toggleSupp(st, iso, s.id) })}>
          <Icon name={took ? 'checkCircle' : 'dot'} style={{ fontSize: 22, color: took ? 'var(--green)' : 'var(--surface-3)' }} />
        </Row>
      })}
      {SLOTS.map(slot => {
        const tot = slotTotals(day, slot)
        const logged = (day.meals?.[slot] || []).length > 0
        const [icon, tint] = SLOT_ICON[slot]
        return <Row key={slot} icon={icon} iconTint={tint} title={SLOT_LABEL[slot]()} accessory="chevron"
          subtitle={logged ? t('{0} kcal · protein {1} g', n0(tot.kcal), n0(tot.p)) : t('Not logged yet')}
          onClick={() => mealSheet(iso, slot)}>
          {logged && <Icon name="checkCircle" style={{ fontSize: 18, color: 'var(--green)' }} />}
        </Row>
      })}
      <Row icon="dumbbell" iconTint="var(--acc)" title={t('Workout')} accessory={onWorkout && iso === today ? 'chevron' : 'none'}
        subtitle={workoutDone ? t('Done') : routines.length ? routines.map(r => r.name).join(' + ') : t('Rest day')}
        onClick={onWorkout && iso === today ? onWorkout : undefined}>
        {(workoutDone || !routines.length) && <Icon name="checkCircle" style={{ fontSize: 18, color: 'var(--green)' }} />}
      </Row>
      <Row icon="figureRun" iconTint="var(--green)" title={t('Steps')} accessory="chevron"
        subtitle={`${n0(steps)} / ${n0(goals.steps || 9000)}${km ? ' · ' + km.toFixed(1) + ' km' : ''}${synced ? ' · 🍎' : ''}`}
        onClick={() => numberSheet({ iso, field: 'steps', title: t('Steps'), unit: t('steps'), value: Number(day.steps) || steps || null, decimal: false })}>
        {steps >= (goals.steps || 9000) && <Icon name="checkCircle" style={{ fontSize: 18, color: 'var(--green)' }} />}
      </Row>
      <Row icon="cloud" iconTint="var(--blue)" title={t('Water')} subtitle={`${(water / 1000).toFixed(1)} / ${((goals.waterMl || 3500) / 1000).toFixed(1)} L`}>
        <Button size="sm" onClick={() => numberSheet({ iso, field: 'water', title: t('Water'), unit: 'ml', value: water || null, decimal: false })} aria-label={t('Edit')}><Icon name="pencil" /></Button>
        <Button size="sm" variant="primary" onClick={() => update(st => { setDayValue(st, iso, 'water', water + 250) })}>+250</Button>
      </Row>
    </div>
  </div>
}

/* ---------------------------------------------------------------- meal sheet ------------ */

export const mealSheet = (iso, slot) => ui().openSheet(close => <MealSheet iso={iso} slot={slot} close={close} />)

function MealSheet({ iso, slot, close }) {
  const S = useStore(s => s.S)
  const day = dayOf(S, iso)
  const items = day.meals?.[slot] || []
  const tot = slotTotals(day, slot)
  const templates = S.gplan?.templates || []
  const mine = templates.filter(x => x.slot === slot)
  const others = templates.filter(x => x.slot !== slot)
  const [editing, setEditing] = useState(false)
  const [showOthers, setShowOthers] = useState(false)
  const [form, setForm] = useState({ name: '', kcal: null, p: null, c: null, f: null })
  const [asTemplate, setAsTemplate] = useState(false)
  const set = k => v => setForm(f => ({ ...f, [k]: v }))
  const canAdd = (form.kcal || 0) > 0 || (form.p || 0) > 0

  const addTpl = tpl => update(st => { addMeal(st, iso, slot, { ...tpl, id: null, tpl: tpl.id }) })
  const addFree = () => {
    if (!canAdd) return
    const item = { ...form, name: form.name.trim() || t('Quick entry') }
    update(st => {
      addMeal(st, iso, slot, item)
      if (asTemplate) saveTemplate(st, slot, item)
    })
    setForm({ name: '', kcal: null, p: null, c: null, f: null })
    setAsTemplate(false)
  }
  // One button per template: adds it, or in edit mode removes the template (the chip's own hit
  // area, .chip::before, would swallow a tap meant for a button nested inside it).
  const chip = tpl => <button key={tpl.id} className="chip nocap" style={editing ? { color: 'var(--red)' } : undefined}
    onClick={() => (editing ? update(st => { removeTemplate(st, tpl.id) }) : addTpl(tpl))}
    aria-label={editing ? t('Delete') + ' ' + tpl.name : tpl.name}>
    {editing && <Icon name="xmark" />} {tpl.name} <span className="dim">· {n0(tpl.kcal)}</span>
  </button>

  return <>
    <h3 style={{ marginBottom: 2 }}>{SLOT_LABEL[slot]()}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>
      {fmtDate(iso, true)} · {t('{0} kcal · protein {1} g', n0(tot.kcal), n0(tot.p))}
    </div>

    {items.length > 0 && <div className="sect-b" style={{ marginBottom: 14 }}>
      {items.map(x => <Row key={x.id} title={x.name || t('Quick entry')} subtitle={t('{0} kcal · protein {1} g', n0(x.kcal), n0(x.p))}>
        <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }}
          onClick={() => update(st => { removeMeal(st, iso, slot, x.id) })} aria-label={t('Delete')}><Icon name="trash" /></button>
      </Row>)}
    </div>}

    <div className="row between" style={{ marginBottom: 6 }}>
      <b className="small">{t('Templates')}</b>
      {templates.length > 0 && <Button size="sm" variant="ghost" onClick={() => setEditing(e => !e)}>{editing ? t('Done') : t('Edit')}</Button>}
    </div>
    {mine.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>{mine.map(chip)}</div>
      : <div className="dim small" style={{ marginBottom: 8 }}>{t('No templates for this meal yet — save one below.')}</div>}
    {others.length > 0 && <>
      <Button size="sm" variant="ghost" onClick={() => setShowOthers(v => !v)} trailingIcon={showOthers ? 'chevronUp' : 'chevronDown'}>{t('From other meals')}</Button>
      {showOthers && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '6px 0 8px' }}>{others.map(chip)}</div>}
    </>}

    <b className="small" style={{ display: 'block', margin: '14px 0 6px' }}>{t('Quick entry')}</b>
    <TextField value={form.name} onChange={e => set('name')(e.target.value)} placeholder={t('What did you eat?')} maxLength={60} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
      {[['kcal', 'kcal'], ['p', t('Protein')], ['c', t('Carbs')], ['f', t('Fat')]].map(([k, label]) => <label key={k} className="small muted" style={{ display: 'grid', gap: 4 }}>
        {label}<NumberField value={form[k]} onChange={set(k)} nullable decimal={false} className="field" />
      </label>)}
    </div>
    <div className="row between" style={{ margin: '10px 0' }}>
      <span className="small">{t('Save as a template')}</span>
      <Switch checked={asTemplate} onChange={setAsTemplate} aria-label={t('Save as a template')} />
    </div>
    <Button variant="primary" icon="plus" disabled={!canAdd} onClick={addFree}>{t('Add')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

/* -------------------------------------------------------------- number sheet ------------ */

function numberSheet(opts) {
  ui().openSheet(close => <NumberSheet {...opts} close={close} />)
}

function NumberSheet({ iso, field, title, unit, value, decimal, close }) {
  const [v, setV] = useState(value)
  const save = () => { update(st => { setDayValue(st, iso, field, v) }); close() }
  return <>
    <h3 style={{ marginBottom: 2 }}>{title}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{fmtDate(iso, true)}</div>
    <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
      <NumberField value={v} onChange={setV} nullable decimal={decimal} className="field" autoFocus />
      <span className="muted">{unit}</span>
    </div>
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}
