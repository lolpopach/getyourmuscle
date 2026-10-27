// Apple Health sync through an iOS Shortcut (api/health.js, docs/dev/GETYOURMUSCLE_PLAN.md §4.11).
// HealthKit has no web API, so a Shortcut on the iPhone reads it and posts the day's totals here
// with a write-only token. Settings → Account issues and revokes that token, walks through building
// the Shortcut, says what the last call from it came to, and shows what came in over the last week.
// The Shortcut is five actions: the token rides in the address and the server fills in the date.
import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import { appBase } from '../lib/app-base.js'
import { copyText } from '../lib/clipboard.js'
import { isoOf, fmtDate, fmtAgo } from '../lib/format.js'
import { Row, Button } from './ui.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const errStyle = { color: 'var(--red)', marginTop: 10 }
const mono = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, wordBreak: 'break-all', userSelect: 'all' }

// The name the steps give the Shortcut, which "Sync now" runs by.
export const SHORTCUT_NAME = 'G-PLAN'

const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' } }

// The address the Shortcut posts to: this app's own origin and subpath, then the token (`key`) and
// the time zone that decides which day "today" is (`tz`) — one string to paste, no header to set.
export function ingestUrl(loc = location, { token, tz = localZone() } = {}) {
  const u = new URL(appBase(loc).replace(/\/$/, '') + '/api/health/ingest', loc.origin)
  if (token) u.searchParams.set('key', token)
  if (token && tz) u.searchParams.set('tz', tz)
  return u.href
}

// Opens Shortcuts and runs the G-PLAN shortcut. The phone is unlocked then, so Health can be read.
export const runShortcutUrl = (name = SHORTCUT_NAME) => 'shortcuts://run-shortcut?name=' + encodeURIComponent(name)
export const runShortcut = () => { location.href = runShortcutUrl() }

const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return isoOf(d) }

// Calls `fn` whenever the app comes back to the front — after the Shortcut ran, say.
export function useOnReturn(fn, on = true) {
  useEffect(() => {
    if (!on) return
    const back = () => { if (document.visibilityState === 'visible') fn() }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [on])
}

// GET /api/account/health-token → { active, created, lastSync, last }, or null until it answers —
// and for as long as the server does not know the route (one from before this feature), so no row
// shows. Read again when the app comes back from the Shortcut.
export function useHealthToken(on = true) {
  const [st, setSt] = useState(null)
  const load = () => api('/api/account/health-token').then(r => setSt(typeof r?.active === 'boolean' ? r : null)).catch(() => setSt(null))
  useEffect(() => { if (on) load(); else setSt(null) }, [on])
  useOnReturn(load, on)
  return { st, load }
}

// What to change in the Shortcut, from the error the last call came back with (api/health.js).
export function ingestProblem(error) {
  const e = String(error || '')
  if (e === 'invalid json') return t('Set the request body to JSON, not Form.')
  if (e === 'nothing to save') return t('No steps or dist came with it — add the two fields (type Number) to the request body.')
  if (e.startsWith('date')) return t('Leave the date out — the server fills it in.')
  if (e.startsWith('unit')) return t('unit can only be km, m or mi.')
  const field = e.match(/^(steps|dist|activeKcal|weight|bodyFat)\b/)?.[1]
  if (field) return t('{0} could not be read — put Calculate Statistics → Sum before it, and make the field a Number.', field)
  return e
}

// Whether the newest call with this token saved nothing. One made with an earlier token is not news.
const lastFailed = st => !!st?.last?.error && !(st.created > st.last.at)

// One line on how the sync stands: the last call's problem when it saved nothing, else the last sync.
export function syncStatus(st) {
  if (!st?.active) return null
  if (lastFailed(st)) return { bad: true, text: t('The last try {0} saved nothing. {1}', fmtAgo(st.last.at), ingestProblem(st.last.error)) }
  if (st.lastSync) return { bad: false, text: t('Last sync {0}', fmtAgo(st.lastSync)) }
  return { bad: false, text: t('Token made — waiting for the first sync') }
}

export function AppleHealthRow() {
  const { st, load } = useHealthToken()
  if (!st) return null
  const subtitle = !st.active ? t('Bring steps and walking + running distance in from your iPhone.')
    : lastFailed(st) ? t('The last try saved nothing — tap to see why')
    : st.lastSync ? t('Connected · last sync {0}', fmtAgo(st.lastSync))
    : t('Token made — waiting for the first sync')
  return <Row icon="heart" iconTint="var(--red)" title={t('Apple Health sync')} subtitle={subtitle} accessory="chevron"
    onClick={() => ui().openSheet(close => <AppleHealthSheet close={close} changed={load} />)} />
}

function Copyable({ label, copyLabel, value }) {
  const copy = async () => { if (await copyText(value)) toast(t('Copied')) }
  return <div className="card" dir="ltr" style={{ padding: 12, marginBottom: 10 }}>
    <div className="dim small" style={{ marginBottom: 6 }}>{label}</div>
    <div style={mono}>{value}</div>
    <div style={{ height: 8 }} />
    <Button size="sm" icon="clipboard" onClick={copy}>{copyLabel}</Button>
  </div>
}

function ShortcutSteps() {
  const steps = [
    t('Open the Shortcuts app, tap + and name the new shortcut {0}.', SHORTCUT_NAME),
    t('Tap Add Action and search “Health” — the Fitness app has no actions; its steps and distance live in Health. Add Find Health Samples: Type Steps, Start Date Today.'),
    t('Add Calculate Statistics and pick Sum.'),
    t('Do steps 2 and 3 again, this time with Type Walking + Running Distance.'),
    t('Add Get Contents of URL and paste the address above. Under Show More: Method POST, Request Body JSON. Add two fields of type Number: steps = the first Statistics, dist = the second.'),
    t('Tap ▶ to run it and allow Health access when asked. Back here, the result shows below.'),
    t('For every evening: Automation → + → Time of Day 21:30, Daily, Run Immediately → {0}.', SHORTCUT_NAME),
  ]
  return <>
    <ol className="small" style={{ paddingInlineStart: 20, lineHeight: 1.55, margin: '4px 0 10px' }}>
      {steps.map((s, i) => <li key={i} style={{ marginBottom: 6 }}>{s}</li>)}
    </ol>
    <div className="dim small" style={{ lineHeight: 1.5, marginBottom: 6 }}>
      {t('Health data cannot be read while the iPhone is locked, so an automation that fires on a locked phone fails. On those days, tap Sync now.')}
    </div>
    <div className="dim small" style={{ lineHeight: 1.5 }}>
      {t('If your iPhone shows distances in miles, add unit = mi to the request body.')}
    </div>
  </>
}

function RecentDays({ days }) {
  const keys = Object.keys(days || {}).sort().reverse()
  if (!keys.length) return <div className="dim small">{t('Nothing synced in the last 7 days.')}</div>
  return <div className="sect-b">
    {keys.map(k => {
      const d = days[k]
      const parts = [d.distKm != null && `${d.distKm} km`, d.steps != null && t('{0} steps', d.steps.toLocaleString()), d.activeKcal != null && `${d.activeKcal} kcal`].filter(Boolean)
      return <Row key={k} title={fmtDate(k)} subtitle={parts.join(' · ') || null}
        value={d.weight != null ? `${d.weight} kg${d.bodyFat != null ? ` · ${d.bodyFat}%` : ''}` : null} />
    })}
  </div>
}

export function AppleHealthSheet({ close, changed }) {
  const { st, load } = useHealthToken()
  const [token, setToken] = useState(null)   // only right after issuing: the server never shows it again
  const [days, setDays] = useState(null)
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const loadDays = () => api('/api/health/daily?from=' + daysAgo(6)).then(r => setDays(r?.days || {})).catch(() => setDays({}))
  useEffect(() => { loadDays() }, [])
  useOnReturn(() => { loadDays(); changed?.() })
  const refresh = () => { load(); changed?.() }
  const issue = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try { setToken((await api('/api/account/health-token', { method: 'POST' })).token); setReplacing(false); refresh() }
    catch (e) { setErr(e?.message || t('Something went wrong')) }
    finally { setBusy(false) }
  }
  const revoke = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try { await api('/api/account/health-token', { method: 'DELETE' }); setToken(null); refresh(); toast(t('Sync token revoked')) }
    catch (e) { setErr(e?.message || t('Something went wrong')) }
    finally { setBusy(false) }
  }
  const status = syncStatus(st)

  return <>
    <h3>{t('Apple Health sync')}</h3>
    <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.5 }}>
      {t('Apple Health has no web access, so a Shortcut on your iPhone reads it and sends the day’s totals here. Its address can only send numbers — it cannot read anything back.')}
    </div>
    {status && <div className="small" style={{ marginBottom: 12, lineHeight: 1.5, color: status.bad ? 'var(--red)' : undefined }}>{status.text}</div>}
    {!st ? <div className="muted small">…</div> : token ? <>
      <Copyable label={t('Address for the Shortcut')} copyLabel={t('Copy address')} value={ingestUrl(location, { token })} />
      <div className="small" style={{ color: 'var(--orange)', marginBottom: 12, lineHeight: 1.5 }}>
        {t('The address is shown only now. Put it in the Shortcut before you close this.')}
      </div>
      <ShortcutSteps />
    </> : st.active ? <>
      <Button variant="primary" icon="reset" onClick={runShortcut}>{t('Sync now')}</Button>
      <div className="dim small" style={{ margin: '6px 0 12px', lineHeight: 1.5 }}>{t('Runs the {0} shortcut, then come back here.', SHORTCUT_NAME)}</div>
      {replacing ? <>
        <div className="muted small" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          {t('A new address stops the current one. Paste the new one into the Shortcut afterwards.')}
        </div>
        <Button variant="primary" disabled={busy} onClick={issue}>{t('Make a new address')}</Button>
        <div style={{ height: 8 }} />
        <Button variant="ghost" onClick={() => setReplacing(false)}>{t('Cancel')}</Button>
      </> : <Button icon="key" onClick={() => setReplacing(true)}>{t('Make a new address')}</Button>}
      <div style={{ height: 8 }} />
      <Button variant="danger" disabled={busy} onClick={revoke}>{t('Revoke token')}</Button>
    </> : <>
      <Button variant="primary" icon="heart" disabled={busy} onClick={issue}>{t('Make the Shortcut address')}</Button>
    </>}
    {err && <div className="small" style={errStyle}>{err}</div>}
    <h4 style={{ margin: '20px 0 8px' }}>{t('Last 7 days')}</h4>
    {days ? <RecentDays days={days} /> : <div className="muted small">…</div>}
    <div style={{ height: 14 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}
