/* The API on Cloudflare: what api/server.js does for the app's core, on a SQLite database (a
 * Durable Object's storage in production, node:sqlite in the tests) instead of files.
 *
 * Kept route for route with server.js where the app relies on it — the same paths, bodies,
 * status codes and cookie — so the frontend cannot tell the two apart:
 *   health, config, me; passkey sign-up and sign-in; sign out (here and everywhere);
 *   the state document with its revision and conflict rule; activity; Apple Health sync.
 * Everything else (push, media, the Coach, admin, pairing, passwords, extra passkeys) answers
 * 404, which the app already reads as "this server does not have that" and hides.
 *
 * One owner: the first profile created can sign up; after it the instance is closed unless
 * OPEN_SIGNUP=1. RP_ID and ORIGIN come from the address the app is served on, unless set.
 *
 * `db.exec(sql, ...params)` returns the rows as an array. */
import crypto from 'node:crypto'
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'
import { verifyError } from '../api/verify-error.js'
import { issueHealthToken, hashHealthToken, ingestToken, parseIngest, mergeIngest, failedIngest, daysFrom } from '../api/health.js'

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL,
     sv INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, last_pull INTEGER,
     health_h TEXT, health_created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS creds (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL,
     counter INTEGER NOT NULL DEFAULT 0, transports TEXT, created TEXT, last_used TEXT)`,
  `CREATE TABLE IF NOT EXISTS challenges (cid TEXT PRIMARY KEY, data TEXT NOT NULL, exp INTEGER NOT NULL)`,
  // The state document, in chunks: one row of a Durable Object's SQLite holds at most 2 MB, and a
  // profile's history grows past that in a few years.
  `CREATE TABLE IF NOT EXISTS state_chunks (uid TEXT NOT NULL, i INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (uid, i))`,
  `CREATE TABLE IF NOT EXISTS health (uid TEXT PRIMARY KEY, doc TEXT NOT NULL)`,
]

const CHUNK = 900_000
const MAX_BODY = 5 * 1024 * 1024
const SESSION_DAYS = 90
const CHALLENGE_MS = 5 * 60000
const HEALTH_WRITES_PER_HOUR = 60

class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }

const json = (status, obj, headers = {}) => {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  for (const [k, v] of Object.entries(headers)) {
    for (const one of [].concat(v)) h.append(k, one)
  }
  return new Response(JSON.stringify(obj), { status, headers: h })
}
const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const record = x => !!x && typeof x === 'object' && !Array.isArray(x)
const records = v => (Array.isArray(v) ? v.filter(record) : [])

async function readBody(request) {
  const raw = await request.text()
  if (raw.length > MAX_BODY) throw new HttpError(413, 'body too large')
  if (!raw) return {}
  let body
  try { body = JSON.parse(raw) } catch { throw new HttpError(400, 'invalid json') }
  if (!record(body)) throw new HttpError(400, 'invalid json')
  return body
}

// Routes that carry their own credential (a WebAuthn challenge id, the Shortcut's token) and so
// are not tied to the origin check (server.js CSRF_EXEMPT).
const CSRF_EXEMPT = new Set(['POST /api/register/options', 'POST /api/register/verify', 'POST /api/login/options', 'POST /api/login/verify', 'POST /api/health/ingest'])

export function createApi(db, env = {}) {
  const one = (sql, ...p) => db.exec(sql, ...p)[0] || null
  const kvGet = k => one('SELECT v FROM kv WHERE k = ?', k)?.v ?? null
  const kvSet = (k, v) => db.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v)

  // The session-signing secret, made on first use and kept with the data (server.js DATA/secret).
  let SECRET = kvGet('secret')
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); kvSet('secret', SECRET) }
  const sign = payload => payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  const verifySig = token => {
    const i = token.lastIndexOf('.')
    if (i < 0) return null
    const payload = token.slice(0, i), mac = Buffer.from(token.slice(i + 1))
    const expect = Buffer.from(crypto.createHmac('sha256', SECRET).update(payload).digest('base64url'))
    return mac.length === expect.length && crypto.timingSafeEqual(mac, expect) ? payload : null
  }

  const userById = id => one('SELECT * FROM users WHERE id = ?', id)
  const userCount = () => one('SELECT COUNT(*) AS n FROM users').n
  const openSignup = () => /^(1|true|yes|on)$/i.test(env.OPEN_SIGNUP || '') || userCount() === 0
  const pub = u => ({ id: u.id, name: u.name, admin: false })

  /* ---------- state document ---------- */
  function readState(uid) {
    const rows = db.exec('SELECT data FROM state_chunks WHERE uid = ? ORDER BY i', uid)
    if (!rows.length) return null
    try { return JSON.parse(rows.map(r => r.data).join('')) } catch { return null }
  }
  function writeState(uid, state) {
    const s = JSON.stringify(state)
    db.exec('DELETE FROM state_chunks WHERE uid = ?', uid)
    for (let i = 0; i * CHUNK < s.length; i++) db.exec('INSERT INTO state_chunks (uid, i, data) VALUES (?, ?, ?)', uid, i, s.slice(i * CHUNK, (i + 1) * CHUNK))
  }

  /* ---------- challenges ---------- */
  function putChallenge(data, now) {
    db.exec('DELETE FROM challenges WHERE exp < ?', now)
    const cid = crypto.randomBytes(16).toString('base64url')
    db.exec('INSERT INTO challenges (cid, data, exp) VALUES (?, ?, ?)', cid, JSON.stringify(data), now + CHALLENGE_MS)
    return cid
  }
  function takeChallenge(cid, now) {
    if (typeof cid !== 'string') return null
    const row = one('SELECT data, exp FROM challenges WHERE cid = ?', cid)
    db.exec('DELETE FROM challenges WHERE cid = ?', cid)
    if (!row || row.exp < now) return null
    try { return JSON.parse(row.data) } catch { return null }
  }

  const healthWrites = new Map()   // uid → { start, n }, an hour's window

  return async function handle(request, { now = Date.now() } = {}) {
    const url = new URL(request.url)
    const ORIGIN = env.ORIGIN || url.origin
    const RP_ID = env.RP_ID || url.hostname
    const RP_NAME = env.RP_NAME || 'G-PLAN'
    const SECURE = ORIGIN.startsWith('https:')
    const COOKIE = SECURE ? '__Host-gymsid' : 'gymsid'
    const expire = name => `${name}=; Path=/; Max-Age=0; HttpOnly;${SECURE ? ' Secure;' : ''} SameSite=Lax`
    const clearCookie = SECURE ? [expire(COOKIE), expire('gymsid')] : [expire('gymsid')]
    const sessionCookie = u => {
      const exp = now + SESSION_DAYS * 86400000
      const fresh = `${COOKIE}=${sign(u.id + ':' + exp + ':' + (u.sv || 0))}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE ? ' Secure;' : ''} SameSite=Lax`
      return SECURE ? [fresh, expire('gymsid')] : [fresh]
    }

    const session = () => {
      const cookies = (request.headers.get('cookie') || '').split(';').map(c => c.trim())
      const tok = [COOKIE, 'gymsid'].map(n => cookies.find(c => c.startsWith(n + '='))?.slice(n.length + 1)).find(Boolean)
      if (!tok) return null
      const payload = verifySig(tok)
      if (!payload) return null
      const [uid, exp, ver] = payload.split(':')
      if (!uid || +exp < now) return null
      const u = userById(uid)
      if (!u || u.disabled || Number(ver || 0) !== (u.sv || 0)) return null
      return u
    }

    const key = request.method + ' ' + url.pathname
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } })
    }
    // A state-changing browser request has to come from the app itself (server.js csrfOk).
    const csrfOk = () => {
      if (['GET', 'HEAD'].includes(request.method) || CSRF_EXEMPT.has(key)) return true
      if ((request.headers.get('authorization') || '').startsWith('Bearer ')) return true
      const site = request.headers.get('sec-fetch-site')
      if (site) return site === 'same-origin' || site === 'none'
      const origin = request.headers.get('origin')
      return !origin || origin.replace(/\/+$/, '') === ORIGIN.replace(/\/+$/, '')
    }
    if (!csrfOk()) return json(403, { error: 'cross-origin request refused' })

    const routes = {
      'GET /api/health': () => json(200, { ok: true, users: userCount() }),

      // `false` names what this API leaves out (frontend lib/server-features.js), so the app
      // hides it instead of offering a button that answers 404.
      'GET /api/config': () => json(200, {
        invite_only: !openSignup(), allow_guest: true,
        push: false, pairing: false, device_link: false,
        ...(openSignup() ? {} : { signup: false }),
        ...(env.DEFAULT_LANG !== '' ? { default_lang: env.DEFAULT_LANG || 'ko' } : {}),
        ...(session() ? { coach: null } : {}),
      }),

      'GET /api/me': () => {
        const u = session()
        return u ? json(200, { user: pub(u) }) : json(401, { error: 'not signed in' })
      },

      'POST /api/register/options': async () => {
        const body = await readBody(request)
        const name = text(body.name).trim().slice(0, 40)
        if (!name) return json(400, { error: 'name required' })
        if (!openSignup()) return json(403, { error: 'a valid invite code is required' })
        const uid = crypto.randomBytes(12).toString('base64url')
        const options = await generateRegistrationOptions({
          rpName: RP_NAME, rpID: RP_ID, userID: Buffer.from(uid), userName: name, userDisplayName: name,
          attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, excludeCredentials: [],
        })
        const cid = putChallenge({ kind: 'register', challenge: options.challenge, name, uid }, now)
        return json(200, { cid, options })
      },

      'POST /api/register/verify': async () => {
        const body = await readBody(request)
        const c = takeChallenge(body.cid, now)
        if (!c || c.kind !== 'register' || !c.uid) return json(400, { error: 'challenge expired — try again' })
        let verification
        try {
          verification = await verifyRegistrationResponse({ response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false })
        } catch (e) {
          return json(400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) })
        }
        if (!verification.verified) return json(400, { error: 'not verified' })
        const { credential } = verification.registrationInfo
        if (one('SELECT id FROM creds WHERE id = ?', credential.id)) return json(409, { error: 'credential already registered' })
        // Checked again at the last moment: two sign-ups racing for an empty instance get one owner.
        if (!openSignup()) return json(403, { error: 'invite code is no longer valid — ask for a new one' })
        const created = new Date(now).toISOString()
        db.exec('INSERT INTO users (id, name, created) VALUES (?, ?, ?)', c.uid, c.name, created)
        const transports = Array.isArray(body.credential?.response?.transports) ? body.credential.response.transports : []
        db.exec('INSERT INTO creds (id, user_id, public_key, counter, transports, created, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)',
          credential.id, c.uid, Buffer.from(credential.publicKey).toString('base64url'), credential.counter || 0, JSON.stringify(transports), created, created)
        const u = userById(c.uid)
        return json(200, { user: pub(u) }, { 'Set-Cookie': sessionCookie(u) })
      },

      'POST /api/login/options': async () => {
        const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] })
        const cid = putChallenge({ kind: 'login', challenge: options.challenge }, now)
        return json(200, { cid, options })
      },

      'POST /api/login/verify': async () => {
        const body = await readBody(request)
        const c = takeChallenge(body.cid, now)
        if (c?.kind !== 'login') return json(400, { error: 'challenge expired — try again' })
        const cred = one('SELECT * FROM creds WHERE id = ?', text(body.credential?.id))
        if (!cred) return json(404, { error: 'unknown passkey — create a profile first' })
        let verification
        try {
          verification = await verifyAuthenticationResponse({
            response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false,
            credential: { id: cred.id, publicKey: Buffer.from(cred.public_key, 'base64url'), counter: cred.counter, transports: JSON.parse(cred.transports || '[]') },
          })
        } catch (e) {
          return json(400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) })
        }
        if (!verification.verified) return json(400, { error: 'not verified' })
        db.exec('UPDATE creds SET counter = ?, last_used = ? WHERE id = ?', verification.authenticationInfo.newCounter, new Date(now).toISOString(), cred.id)
        const u = userById(cred.user_id)
        if (!u) return json(500, { error: 'user missing' })
        if (u.disabled) return json(403, { error: 'this account has been disabled' })
        return json(200, { user: pub(u) }, { 'Set-Cookie': sessionCookie(u) })
      },

      'POST /api/logout': () => json(200, { ok: true }, { 'Set-Cookie': clearCookie }),

      'POST /api/logout/all': () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        db.exec('UPDATE users SET sv = sv + 1 WHERE id = ?', u.id)
        return json(200, { ok: true }, { 'Set-Cookie': clearCookie })
      },

      'GET /api/data': () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        const state = readState(u.id)
        db.exec('UPDATE users SET last_pull = ? WHERE id = ?', now, u.id)
        return json(200, { state, rev: state?._rev || 0 })
      },

      'GET /api/data/rev': () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        return json(200, { rev: readState(u.id)?._rev || 0 })
      },

      // The same contract as server.js: a non-empty object; workouts and routines lists; a
      // `baseRev` that is not the current revision is a 409 with the current document; the
      // in-progress workout stays on the device; the reset stamp only moves forward.
      'PUT /api/data': async () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        const body = await readBody(request)
        const st = body.state
        if (!st || typeof st !== 'object') return json(400, { error: 'state required' })
        if (!Array.isArray(st) && !Object.keys(st).some(k => k !== '_rev' && k !== '_ts')) return json(400, { error: 'state required' })
        const list = v => v == null || Array.isArray(v)
        if (Array.isArray(st) || !list(st.workouts) || !list(st.routines)) return json(400, { error: 'invalid state' })
        for (const k of ['workouts', 'routines']) if (Array.isArray(st[k])) st[k] = records(st[k])
        const cur = readState(u.id)
        const curRev = cur?._rev || 0
        if (body.baseRev != null && body.baseRev !== curRev) return json(409, { error: 'conflict', rev: curRev, state: cur })
        delete st.active
        const storedReset = Number(cur?.resetAt) || 0
        if (storedReset > (Number(st.resetAt) || 0)) {
          st.resetAt = cur.resetAt
          if (cur.resetIds && typeof cur.resetIds === 'object') st.resetIds = cur.resetIds
          else delete st.resetIds
        }
        st._rev = curRev + 1
        writeState(u.id, st)
        return json(200, { ok: true, ts: st._ts || null, rev: st._rev })
      },

      'POST /api/activity': async () => {
        if (!session()) return json(401, { error: 'not signed in' })
        await readBody(request)
        return json(200, { ok: true })
      },

      /* ---------- Apple Health (api/health.js) ---------- */
      'GET /api/account/health-token': () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        const doc = readHealth(u.id)
        const lastSync = Object.values(doc.days || {}).reduce((m, d) => Math.max(m, +d?.at || 0), 0) || null
        return json(200, { active: !!u.health_h, created: u.health_created || null, lastSync, last: doc.last || null })
      },
      'POST /api/account/health-token': () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        const holder = {}
        const token = issueHealthToken(holder, now)
        db.exec('UPDATE users SET health_h = ?, health_created = ? WHERE id = ?', holder.healthTok.h, now, u.id)
        return json(200, { token, created: now })
      },
      'DELETE /api/account/health-token': () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        db.exec('UPDATE users SET health_h = NULL, health_created = NULL WHERE id = ?', u.id)
        return json(200, { active: false })
      },
      'POST /api/health/ingest': async () => {
        const tok = ingestToken(request.headers.get('authorization'), url.searchParams)
        const u = tok.startsWith('gymh_') && tok.length <= 100 ? one('SELECT * FROM users WHERE health_h = ? AND disabled = 0', hashHealthToken(tok)) : null
        if (!u) return json(401, { error: 'invalid token' })
        const w = healthWrites.get(u.id)
        if (!w || now - w.start > 3600000) healthWrites.set(u.id, { start: now, n: 1 })
        else if (++w.n > HEALTH_WRITES_PER_HOUR) return json(429, { error: 'too many requests' }, { 'Retry-After': String(Math.ceil((w.start + 3600000 - now) / 1000)) })
        // A bad body or value is recorded, so the app can say what to change in the Shortcut.
        let p
        try { p = parseIngest(await readBody(request), now, { tz: url.searchParams.get('tz') || '' }) }
        catch (e) { if (e instanceof HttpError && e.status === 400) p = { error: e.message }; else throw e }
        if (p.error) { writeHealth(u.id, failedIngest(readHealth(u.id), p.error, now)); return json(400, { error: p.error }) }
        const doc = mergeIngest(readHealth(u.id), p.date, p.values, now)
        writeHealth(u.id, doc)
        return json(200, { ok: true, date: p.date, saved: doc.days[p.date] })
      },
      'GET /api/health/daily': () => {
        const u = session()
        if (!u) return json(401, { error: 'not signed in' })
        const from = url.searchParams.get('from') || ''
        if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return json(400, { error: 'from must be YYYY-MM-DD' })
        return json(200, { days: daysFrom(readHealth(u.id), from) })
      },
    }

    function writeHealth(uid, doc) {
      db.exec('INSERT INTO health (uid, doc) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET doc = excluded.doc', uid, JSON.stringify(doc))
    }
    function readHealth(uid) {
      const row = one('SELECT doc FROM health WHERE uid = ?', uid)
      try { return row ? JSON.parse(row.doc) : { days: {} } } catch { return { days: {} } }
    }

    const handler = routes[key]
    if (!handler) return json(404, { error: 'not found' })
    try { return await handler() }
    catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message })
      console.error(key, e)
      return json(500, { error: 'server error' })
    }
  }
}
