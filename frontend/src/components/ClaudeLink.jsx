// Claude works out the meals the food table cannot settle (docs/dev/CLAUDE_MEALS.md): a Claude
// session, scheduled on the owner's own Claude account, reads G-PLAN's inbox a few times a day
// with a token of its own. Settings → Account issues and revokes that token and says where it
// goes; the server keeps only its hash, and it can read the inbox and the food dataset and write
// answers — nothing else (api/claude-inbox.js).
import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { fmtAgo } from '../lib/format.js'
import { Row, Button } from './ui.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const mono = { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, wordBreak: 'break-all', userSelect: 'all' }
export const TOKEN_VAR = 'GPLAN_CLAUDE_TOKEN'

// GET /api/account/claude-token → { active, created, used, pending }, or null until it answers —
// and for as long as the server does not know the route, so no row shows.
function useClaudeToken() {
  const [st, setSt] = useState(null)
  const load = () => api('/api/account/claude-token').then(r => setSt(typeof r?.active === 'boolean' ? r : null)).catch(() => setSt(null))
  useEffect(() => { load() }, [])
  return { st, load }
}

const status = st => !st.active ? t('Let Claude work out what the food table does not know.')
  : st.used ? t('Connected · Claude last looked {0} · {1} waiting', fmtAgo(st.used), st.pending)
  : t('Token made — waiting for Claude’s first visit')

export function ClaudeLinkRow() {
  const { st, load } = useClaudeToken()
  if (!st) return null
  return <Row icon="sparkles" iconTint="var(--orange)" title={t('Claude works out meals')} subtitle={status(st)} accessory="chevron"
    onClick={() => ui().openSheet(close => <ClaudeLinkSheet close={close} changed={load} />)} />
}

export function ClaudeLinkSheet({ close, changed }) {
  const { st, load } = useClaudeToken()
  const [token, setToken] = useState(null)   // only right after issuing: the server never shows it again
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // The app sends meals to the inbox once the server says this profile is linked (GET /api/config).
  const refresh = () => { load(); changed?.(); useStore.getState().refreshConfig?.() }
  const run = async fn => {
    if (busy) return
    setBusy(true); setErr(null)
    try { await fn(); refresh() } catch (e) { setErr(e?.message || t('Something went wrong')) } finally { setBusy(false) }
  }
  const issue = () => run(async () => setToken((await api('/api/account/claude-token', { method: 'POST' })).token))
  const revoke = () => run(async () => { await api('/api/account/claude-token', { method: 'DELETE' }); setToken(null); toast(t('Claude token revoked')) })
  const copy = async () => { if (await copyText(token)) toast(t('Copied')) }

  return <>
    <h3>{t('Claude works out meals')}</h3>
    <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.5 }}>
      {t('What you write or photograph is saved at once with the food table’s numbers. What the table does not know goes to Claude, which looks at it a few times a day, works the calories out, replaces the numbers and remembers the food for next time.')}
    </div>
    {!st ? <div className="muted small">…</div> : token ? <>
      <div className="card" dir="ltr" style={{ padding: 12, marginBottom: 10 }}>
        <div className="dim small" style={{ marginBottom: 6 }}>{t('Token')}</div>
        <div style={mono}>{token}</div>
        <div style={{ height: 8 }} />
        <Button size="sm" icon="clipboard" onClick={copy}>{t('Copy token')}</Button>
      </div>
      <div className="small" style={{ color: 'var(--orange)', marginBottom: 12, lineHeight: 1.5 }}>{t('The token is shown only now. Put it where Claude reads it before you close this.')}</div>
      <ol className="small" style={{ paddingInlineStart: 20, lineHeight: 1.55, margin: '4px 0 10px' }}>
        <li style={{ marginBottom: 6 }}>{t('Copy the token.')}</li>
        <li style={{ marginBottom: 6 }}>{t('In Claude Code on claude.ai, open the environment of your G-PLAN session (the environment menu in the session’s title bar → Edit) and add a secret or environment variable named {0} with the token as its value.', TOKEN_VAR)}</li>
        <li>{t('From then on the scheduled Claude session reads your meals on its own. Nothing else to do.')}</li>
      </ol>
    </> : st.active ? <>
      <div className="small" style={{ marginBottom: 12 }}>{status(st)}</div>
      <Button icon="key" disabled={busy} onClick={issue}>{t('Make a new token')}</Button>
      <div className="dim small" style={{ margin: '6px 0 10px' }}>{t('A new token stops the current one; put the new one in the environment afterwards.')}</div>
      <Button variant="danger" disabled={busy} onClick={revoke}>{t('Revoke token')}</Button>
    </> : <Button variant="primary" icon="key" disabled={busy} onClick={issue}>{t('Make a token for Claude')}</Button>}
    {err && <div className="small" style={{ color: 'var(--red)', marginTop: 10 }}>{err}</div>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}
