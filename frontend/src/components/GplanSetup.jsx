// G-PLAN's set-up and progress (docs/dev/GETYOURMUSCLE_PLAN.md §4.3, §4.7, §4.8): the sheet that
// turns a profile into daily targets, the InBody log, and the Home card that shows where the
// plan stands — latest reading, the projected path's next check date, and the weekly check
// with its suggested intake (applied only when accepted).
import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t, dateLocale } from '../lib/i18n.js'
import { todayISO, fmtDate } from '../lib/format.js'
import { planFromProfile, makePlan, projectPath, saveBodycomp, removeBodycomp, bodycompList } from '../lib/gplan.js'
import { weeklyCheck, applyAdjustment } from '../lib/gplan-adapt.js'
import Icon from './Icon.jsx'
import { Row, Button, NumberField, TextField, Segmented } from './ui.jsx'

const ui = () => useUI.getState()
const update = (...a) => useStore.getState().update(...a)
const n0 = v => Math.round(Number(v) || 0).toLocaleString(dateLocale())
const n1 = v => (Math.round((Number(v) || 0) * 10) / 10).toLocaleString(dateLocale())
const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
const lastOf = xs => (xs.length ? xs[xs.length - 1] : null)

/* ------------------------------------------------------------------ set-up sheet -------- */

export const gplanSetupSheet = () => ui().openSheet(close => <SetupSheet close={close} />)

// What the sheet starts from: the plan being edited, else the latest InBody and weigh-in.
function initialAnswers(S) {
  const p = S.gplan
  const bc = lastOf(bodycompList(S))
  const bw = lastOf(S.bodyweight || [])
  const start = todayISO()
  if (p) {
    return {
      w: bc?.w || bw?.w || p.startW, h: p.profile?.h, age: p.profile?.age, sex: p.profile?.sex || 'male', bf: bc?.bf ?? p.startBf,
      activity: p.profile?.activity ?? 1.5, walkKm: p.profile?.walkKm ?? 6, runKm: p.profile?.runKm ?? 0, rateKgWk: p.rateKgWk ?? 0.45,
      targetW: p.targetW, targetBf: p.targetBf, start: p.start || start, end: p.end || addDays(start, 91),
      waterMl: p.goals?.waterMl ?? 3500, steps: p.goals?.steps ?? 9000,
    }
  }
  return {
    w: bc?.w || bw?.w || null, h: null, age: null, sex: 'male', bf: bc?.bf ?? null, activity: 1.5, walkKm: 6, runKm: 0, rateKgWk: 0.45,
    targetW: null, targetBf: null, start, end: addDays(start, 91), waterMl: 3500, steps: 9000,
  }
}

function Field({ label, children }) {
  return <label className="small muted" style={{ display: 'grid', gap: 4 }}>{label}{children}</label>
}

function SetupSheet({ close }) {
  const S = useStore(s => s.S)
  const [a, setA] = useState(() => initialAnswers(S))
  const set = k => v => setA(x => ({ ...x, [k]: v }))
  const ready = a.w > 0 && a.h > 0 && a.age > 0
  const preview = useMemo(() => (ready ? planFromProfile(a) : null), [a, ready])
  const save = () => {
    if (!ready) return
    update(st => { st.gplan = makePlan(a, st.gplan) })
    close()
  }
  const num = (k, props = {}) => <NumberField value={a[k]} onChange={set(k)} nullable className="field" {...props} />

  return <>
    <h3 style={{ marginBottom: 2 }}>{t('G-PLAN goal and nutrition')}</h3>
    <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.45 }}>
      {t('Your numbers set the daily calories and protein. With an InBody reading the estimate uses your fat-free mass.')}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
      <Field label={t('Height (cm)')}>{num('h', { decimal: false })}</Field>
      <Field label={t('Weight (kg)')}>{num('w')}</Field>
      <Field label={t('Age')}>{num('age', { decimal: false })}</Field>
      <Field label={t('Body fat %')}>{num('bf')}</Field>
      <Field label={t('Walking km/day')}>{num('walkKm')}</Field>
      <Field label={t('Running km/day')}>{num('runKm')}</Field>
    </div>

    <div className="small muted" style={{ margin: '12px 0 4px' }}>{t('Sex')}</div>
    <Segmented value={a.sex} onChange={set('sex')} options={[{ value: 'male', label: t('Male') }, { value: 'female', label: t('Female') }]} />
    <div className="small muted" style={{ margin: '12px 0 4px' }}>{t('Activity (daily life + lifting)')}</div>
    <Segmented value={a.activity} onChange={set('activity')} options={[
      { value: 1.35, label: t('Less active') }, { value: 1.5, label: t('4–5×/week') }, { value: 1.65, label: t('Very active') }]} />
    <div className="small muted" style={{ margin: '12px 0 4px' }}>{t('Weekly change')}</div>
    <Segmented value={a.rateKgWk} onChange={set('rateKgWk')} options={[
      { value: 0, label: t('Maintain') }, { value: 0.3, label: '−0.3 kg' }, { value: 0.45, label: '−0.45 kg' }, { value: 0.6, label: '−0.6 kg' }]} />

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
      <Field label={t('Goal weight (kg)')}>{num('targetW')}</Field>
      <Field label={t('Goal body fat %')}>{num('targetBf')}</Field>
      <Field label={t('Start')}><input type="date" className="field" style={{ minWidth: 0, width: '100%' }} value={a.start} onChange={e => set('start')(e.target.value)} /></Field>
      <Field label={t('End')}><input type="date" className="field" style={{ minWidth: 0, width: '100%' }} value={a.end} onChange={e => set('end')(e.target.value)} /></Field>
      <Field label={t('Water goal (ml)')}>{num('waterMl', { decimal: false })}</Field>
      <Field label={t('Step goal')}>{num('steps', { decimal: false })}</Field>
    </div>

    <div className="card" style={{ marginTop: 14, background: 'var(--surface-2)' }}>
      {preview ? <>
        <div className="small muted">{t('Estimated daily use {0} kcal', n0(preview.tdee))}</div>
        <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>{t('{0} kcal a day', n0(preview.targets.kcal))}</div>
        <div className="small">{t('Protein {0} g · carbs {1} g · fat {2} g', preview.targets.p, preview.targets.c, preview.targets.f)}</div>
        <div className="dim small" style={{ marginTop: 4 }}>{t('Never below {0} kcal. From week 3 the weekly check adjusts this from your real weight trend.', n0(preview.minKcal))}</div>
      </> : <div className="muted small">{t('Enter height, weight and age to see your targets.')}</div>}
    </div>
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={!ready} onClick={save}>{S.gplan ? t('Save changes') : t('Start G-PLAN')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Cancel')}</Button>
  </>
}

/* ---------------------------------------------------------------- InBody log ------------ */

export const bodycompSheet = () => ui().openSheet(close => <BodycompSheet close={close} />)

const BC_INPUTS = ['w', 'smm', 'fatKg', 'bf', 'visceral', 'waist']
// Labels through t() one by one, so check-source-strings.mjs sees every literal.
const bcLabel = k => ({
  w: t('Weight (kg)'), smm: t('Skeletal muscle (kg)'), fatKg: t('Body fat (kg)'), bf: t('Body fat %'), visceral: t('Visceral fat level'), waist: t('Waist (cm)'),
}[k])

function BodycompSheet({ close }) {
  const S = useStore(s => s.S)
  const rows = bodycompList(S)
  const [d, setD] = useState(todayISO())
  const [e, setE] = useState({ w: null, smm: null, fatKg: null, bf: null, visceral: null, waist: null })
  const [note, setNote] = useState('')
  const canSave = Object.values(e).some(v => v > 0)
  const save = () => {
    if (!canSave) return
    update(st => { saveBodycomp(st, d, { ...e, note }) })
    setE({ w: null, smm: null, fatKg: null, bf: null, visceral: null, waist: null })
    setNote('')
  }
  const del = iso => update(st => { removeBodycomp(st, iso) })
  return <>
    <h3 style={{ marginBottom: 2 }}>{t('InBody readings')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('Measure at the same time of day each time — the trend matters more than one reading.')}</div>

    {rows.length > 0 && <div className="sect-b" style={{ marginBottom: 14 }}>
      {[...rows].reverse().map((r, i, all) => {
        const prev = all[i + 1]
        const dSmm = prev && r.smm && prev.smm ? r.smm - prev.smm : null
        return <Row key={r.d} title={fmtDate(r.d, true)}
          subtitle={[r.w && `${n1(r.w)} kg`, r.bf && `${n1(r.bf)}%`, r.smm && t('muscle {0} kg', n1(r.smm)) + (dSmm != null ? ` (${dSmm >= 0 ? '+' : ''}${n1(dSmm)})` : ''), r.note].filter(Boolean).join(' · ')}>
          <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }} onClick={() => del(r.d)} aria-label={t('Delete')}><Icon name="trash" /></button>
        </Row>
      })}
    </div>}

    <b className="small">{t('New reading')}</b>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 6 }}>
      {BC_INPUTS.map(k => <Field key={k} label={bcLabel(k)}>
        <NumberField value={e[k]} onChange={v => setE(x => ({ ...x, [k]: v }))} nullable className="field" />
      </Field>)}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginTop: 8 }}>
      <Field label={t('Date')}><input type="date" className="field" style={{ minWidth: 0, width: '100%' }} value={d} onChange={ev => setD(ev.target.value)} /></Field>
      <Field label={t('Note')}><TextField value={note} onChange={ev => setNote(ev.target.value)} placeholder={t('e.g. 20:00, before training')} maxLength={80} /></Field>
    </div>
    <div style={{ height: 12 }} />
    <Button variant="primary" icon="plus" disabled={!canSave} onClick={save}>{t('Save reading')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

/* ----------------------------------------------------------- Home: start / progress ----- */

export function GplanStartCard() {
  return <div className="card">
    <div className="row" style={{ gap: 10, marginBottom: 6 }}>
      <span className="lrow-i" style={{ background: 'var(--acc)' }}><Icon name="target" /></span>
      <div className="big" style={{ fontSize: 20 }}>{t('Set up G-PLAN')}</div>
    </div>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('Daily calories and protein, your meals in one tap, creatine and steps — all in one checklist.')}</div>
    <Button variant="primary" icon="sparkles" onClick={gplanSetupSheet}>{t('Start G-PLAN')}</Button>
    <div style={{ height: 8 }} />
    <Button onClick={bodycompSheet}>{t('Add an InBody reading first')}</Button>
  </div>
}

function checkText(c) {
  switch (c.status) {
    case 'wait': return t('Starts in {0} days — the first two weeks move water, not fat.', c.daysLeft)
    case 'need-weighins': return t('Weigh in at least 3 times a week for the weekly check.')
    case 'need-logs': return t('Log at least 3 meals a day on 10 of 14 days for the weekly check ({0} so far).', c.have)
    case 'ok': return t('Losing {0} kg a week — right on plan. Keep {1} kcal.', n1(c.rate), n0(c.suggested))
    case 'lower': return c.rate <= 0
      ? t('Not losing yet ({0} kg a week). Suggested: {1} kcal.', n1(c.rate), n0(c.suggested))
      : t('Losing {0} kg a week — slower than planned. Suggested: {1} kcal.', n1(c.rate), n0(c.suggested))
    case 'raise': return t('Losing {0} kg a week — faster than planned, muscle at risk. Suggested: {1} kcal.', n1(c.rate), n0(c.suggested))
    case 'floor': return t('Losing {0} kg a week, and already at the minimum — add steps instead of cutting food.', n1(c.rate))
    default: return ''
  }
}

export function GplanProgressCard() {
  const S = useStore(s => s.S)
  const plan = S.gplan
  if (!plan) return null
  const today = todayISO()
  const rows = bodycompList(S)
  const last = lastOf(rows)
  const first = rows[0]
  const check = weeklyCheck(S, today)
  const startFat = first?.fatKg ?? (plan.startBf != null ? (plan.startW * plan.startBf) / 100 : null)
  const nextCheck = [28, 56, 91].map(n => addDays(plan.start || today, n)).find(d => d >= today)
  const [proj] = nextCheck ? projectPath({ startIso: plan.start || today, startW: plan.startW, startFatKg: startFat, rateKgWk: plan.rateKgWk || 0, dates: [nextCheck] }) : []
  const latestW = lastOf(S.bodyweight || [])?.w || plan.startW
  const accept = () => update(st => { applyAdjustment(st, check.suggested, latestW, 'weekly') })

  return <div className="card">
    <div className="row between" style={{ marginBottom: 6 }}>
      <h2 style={{ margin: 0 }}>{t('Progress')}</h2>
      <div className="row" style={{ gap: 8 }}>
        <Button size="sm" icon="scale" onClick={bodycompSheet}>{t('InBody')}</Button>
        <Button size="sm" icon="target" onClick={gplanSetupSheet}>{t('Goal')}</Button>
      </div>
    </div>
    {last ? <div className="small" style={{ marginBottom: 6 }}>
      {t('Latest InBody {0}', fmtDate(last.d, true))}: <b>{[last.w && `${n1(last.w)} kg`, last.bf && `${n1(last.bf)}%`, last.smm && t('muscle {0} kg', n1(last.smm))].filter(Boolean).join(' · ')}</b>
    </div> : <div className="muted small" style={{ marginBottom: 6 }}>{t('No InBody reading yet.')}</div>}
    {proj && <div className="small muted" style={{ marginBottom: 6 }}>
      {t('Plan for {0}: {1} kg', fmtDate(proj.d, true), n1(proj.w))}{proj.bf != null ? ` · ${n1(proj.bf)}%` : ''}
      {plan.targetW ? ' · ' + t('goal {0} kg', n1(plan.targetW)) : ''}{plan.targetBf ? ` / ${n1(plan.targetBf)}%` : ''}
    </div>}
    <div className="small" style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)', lineHeight: 1.45 }}>
      <b>{t('Weekly check')}</b> · {checkText(check)}
      {(check.status === 'lower' || check.status === 'raise') && <div style={{ marginTop: 8 }}>
        <Button size="sm" variant="primary" onClick={accept}>{t('Switch to {0} kcal', n0(check.suggested))}</Button>
      </div>}
    </div>
    <div className="dim small" style={{ marginTop: 6 }}>{t('Today: {0} kcal · protein {1} g · carbs {2} g · fat {3} g', n0(plan.targets.kcal), plan.targets.p, plan.targets.c, plan.targets.f)}</div>
  </div>
}
