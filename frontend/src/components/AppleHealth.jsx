// Apple Health sync through an iOS Shortcut (api/health.js, docs/dev/GETYOURMUSCLE_PLAN.md §4.11).
// HealthKit has no web API, so a Shortcut on the iPhone reads it and posts the day's totals here
// with a write-only token. Settings → Account issues and revokes that token, shows what came in
// over the last week, and walks through building the Shortcut.
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

// The absolute address the Shortcut posts to: this app's own origin and subpath.
export const ingestUrl = (loc = location) =>
  new URL(appBase(loc).replace(/\/$/, '') + '/api/health/ingest', loc.origin).href

const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return isoOf(d) }

// GET /api/account/health-token → { active, created, lastSync }, or null until it answers — and for
// as long as the server does not know the route (one from before this feature), so no row shows.
function useHealthToken() {
  const [st, setSt] = useState(null)
  const load = () => api('/api/account/health-token').then(r => setSt(typeof r?.active === 'boolean' ? r : null)).catch(() => setSt(null))
  useEffect(() => { load() }, [])
  return { st, load }
}

export function AppleHealthRow() {
  const { st, load } = useHealthToken()
  if (!st) return null
  const subtitle = !st.active ? t('Bring distance, steps and weight in from your iPhone.')
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
    t('Open the Shortcuts app and tap + to make a new shortcut.'),
    t('Add “Find Health Samples”: type Walking + Running Distance, filter Start Date is Today. Then add “Calculate Statistics” → Sum.'),
    t('Do the same for Steps and for Active Energy — each its own Find Health Samples and Sum.'),
    t('Add “Format Date”: Current Date, custom format yyyy-MM-dd.'),
    t('Add “Get Contents of URL”: the server address above, method POST, header Authorization = Bearer followed by a space and the token. Request body JSON: date (the formatted date), dist, steps and activeKcal (the three sums, as Number).'),
    t('In Automation, add Time of Day → 21:30, daily → Run Immediately, and pick this shortcut. Add it to your Home Screen as well, for a one-tap sync.')
  ]
  return <>
    <ol className="small" style={{ paddingInlineStart: 20, lineHeight: 1.55, margin: '4px 0 10px' }}>
      {steps.map((s, i) => <li key={i} style={{ marginBottom: 6 }}>{s}</li>)}
    </ol>
    <div className="dim small" style={{ lineHeight: 1.5, marginBottom: 6 }}>
      {t('Health data cannot be read while the iPhone is locked, so an automation that fires on a locked phone fails. On those days, tap the Home Screen shortcut.')}
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
  useEffect(() => {
    api('/api/health/daily?from=' + daysAgo(6)).then(r => setDays(r?.days || {})).catch(() => setDays({}))
  }, [])
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

  return <>
    <h3>{t('Apple Health sync')}</h3>
    <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.5 }}>
      {t('Apple Health has no web access, so a Shortcut on your iPhone reads it and sends the day’s totals here. Its token can only send numbers — it cannot read anything back.')}
    </div>
    {!st ? <div className="muted small">…</div> : token ? <>
      <Copyable label={t('Server address')} copyLabel={t('Copy address')} value={ingestUrl()} />
      <Copyable label={t('Token')} copyLabel={t('Copy token')} value={token} />
      <div className="small" style={{ color: 'var(--orange)', marginBottom: 12, lineHeight: 1.5 }}>
        {t('The token is shown only now. Put it in the Shortcut before you close this.')}
      </div>
      <ShortcutSteps />
    </> : st.active ? <>
      <div className="small" style={{ marginBottom: 12 }}>
        {st.lastSync ? t('Last sync {0}', fmtAgo(st.lastSync)) : t('Token made — waiting for the first sync')}
      </div>
      {replacing ? <>
        <div className="muted small" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          {t('A new token stops the current one. Your Shortcut needs the new token afterwards.')}
        </div>
        <Button variant="primary" disabled={busy} onClick={issue}>{t('Make a new token')}</Button>
        <div style={{ height: 8 }} />
        <Button variant="ghost" onClick={() => setReplacing(false)}>{t('Cancel')}</Button>
      </> : <Button icon="key" onClick={() => setReplacing(true)}>{t('Make a new token')}</Button>}
      <div style={{ height: 8 }} />
      <Button variant="danger" disabled={busy} onClick={revoke}>{t('Revoke token')}</Button>
    </> : <>
      <Button variant="primary" icon="heart" disabled={busy} onClick={issue}>{t('Create a sync token')}</Button>
    </>}
    {err && <div className="small" style={errStyle}>{err}</div>}
    <h4 style={{ margin: '20px 0 8px' }}>{t('Last 7 days')}</h4>
    {days ? <RecentDays days={days} /> : <div className="muted small">…</div>}
    <div style={{ height: 14 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}
