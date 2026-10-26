// The Cloudflare API (cloudflare/api.js) on node:sqlite in place of the Durable Object's SQLite:
// the same statements, the same rows. Sessions are minted with the secret the API keeps in the
// database, the way the api/ tests mint them with DATA_DIR/secret. The passkey ceremonies
// themselves are exercised end to end in a browser (docs/DEPLOY_CLOUDFLARE.md); here, that the
// options carry this address as the relying party and that sign-up closes after the owner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA, createApi } from '../api.js'

const HOST = 'https://getyourmuscle.example.workers.dev'
function setup(env = {}) {
  const sql = new DatabaseSync(':memory:')
  const db = { exec: (q, ...p) => (/^\s*SELECT/i.test(q) ? sql.prepare(q).all(...p) : (sql.prepare(q).run(...p), [])) }
  for (const s of SCHEMA) db.exec(s)
  const handle = createApi(db, env)
  const secret = db.exec("SELECT v FROM kv WHERE k = 'secret'")[0].v
  const cookieFor = (uid, sv = 0) => {
    const p = `${uid}:${Date.now() + 86400000}:${sv}`
    return `__Host-gymsid=${p}.${crypto.createHmac('sha256', secret).update(p).digest('base64url')}`
  }
  const addUser = (id = 'u1', name = 'Chan') => db.exec('INSERT INTO users (id, name, created) VALUES (?, ?, ?)', id, name, new Date().toISOString())
  const call = async (method, path, { body, cookie, headers = {} } = {}) => {
    const h = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }
    if (cookie) h.cookie = cookie
    const res = await handle(new Request(HOST + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }))
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
  }
  return { db, call, cookieFor, addUser }
}

test('health and config on an empty instance', async () => {
  const { call } = setup()
  assert.deepEqual((await call('GET', '/api/health')).body, { ok: true, users: 0 })
  const cfg = (await call('GET', '/api/config')).body
  assert.equal(cfg.invite_only, false)
  assert.equal(cfg.allow_guest, true)
  assert.equal(cfg.default_lang, 'ko')
  assert.equal('coach' in cfg, false)
  assert.equal((await call('GET', '/api/push/public-key')).status, 404)
})

test('sign-up options name this address as the relying party, and close once the owner exists', async () => {
  const { call, addUser } = setup()
  assert.equal((await call('POST', '/api/register/options', { body: {} })).status, 400)
  const r = await call('POST', '/api/register/options', { body: { name: 'Chan' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.options.rp.id, 'getyourmuscle.example.workers.dev')
  assert.equal(r.body.options.rp.name, 'G-PLAN')
  assert.ok(r.body.cid)
  // a made-up credential fails verification without creating anybody
  const v = await call('POST', '/api/register/verify', { body: { cid: r.body.cid, credential: { id: 'x', rawId: 'x', type: 'public-key', response: {} } } })
  assert.equal(v.status, 400)
  assert.equal((await call('GET', '/api/health')).body.users, 0)
  // the challenge is spent
  assert.equal((await call('POST', '/api/register/verify', { body: { cid: r.body.cid } })).status, 400)

  addUser()
  assert.equal((await call('GET', '/api/config')).body.invite_only, true)
  assert.equal((await call('POST', '/api/register/options', { body: { name: 'Someone' } })).status, 403)
})

test('OPEN_SIGNUP keeps sign-up open after the first profile', async () => {
  const { call, addUser } = setup({ OPEN_SIGNUP: '1' })
  addUser()
  assert.equal((await call('POST', '/api/register/options', { body: { name: 'Friend' } })).status, 200)
})

test('login options and an unknown passkey', async () => {
  const { call } = setup()
  const o = await call('POST', '/api/login/options', { body: {} })
  assert.equal(o.status, 200)
  assert.equal(o.body.options.rpId, 'getyourmuscle.example.workers.dev')
  const v = await call('POST', '/api/login/verify', { body: { cid: o.body.cid, credential: { id: 'nope' } } })
  assert.equal(v.status, 404)
})

test('me, and sign out everywhere ends every session', async () => {
  const { call, cookieFor, addUser } = setup()
  addUser()
  const cookie = cookieFor('u1')
  assert.equal((await call('GET', '/api/me')).status, 401)
  assert.deepEqual((await call('GET', '/api/me', { cookie })).body, { user: { id: 'u1', name: 'Chan', admin: false } })
  const out = await call('POST', '/api/logout/all', { cookie })
  assert.equal(out.status, 200)
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401)
  assert.equal((await call('GET', '/api/me', { cookie: cookieFor('u1', 1) })).status, 200)
})

test('the state document: revisions, conflicts, the device-local workout and the reset stamp', async () => {
  const { call, cookieFor, addUser } = setup()
  addUser()
  const cookie = cookieFor('u1')
  assert.equal((await call('GET', '/api/data')).status, 401)
  assert.deepEqual((await call('GET', '/api/data', { cookie })).body, { state: null, rev: 0 })
  assert.equal((await call('PUT', '/api/data', { cookie, body: { state: { _rev: 3 } } })).status, 400)
  assert.equal((await call('PUT', '/api/data', { cookie, body: { state: { workouts: 'x' } } })).status, 400)

  const put = await call('PUT', '/api/data', { cookie, body: { state: { workouts: [{ id: 'w1' }, null, 3], routines: [], active: { id: 'live' }, resetAt: 50, _ts: 9 }, baseRev: 0 } })
  assert.deepEqual(put.body, { ok: true, ts: 9, rev: 1 })
  const got = (await call('GET', '/api/data', { cookie })).body
  assert.equal(got.rev, 1)
  assert.deepEqual(got.state.workouts, [{ id: 'w1' }])
  assert.equal(got.state.active, undefined)
  assert.deepEqual((await call('GET', '/api/data/rev', { cookie })).body, { rev: 1 })

  const stale = await call('PUT', '/api/data', { cookie, body: { state: { workouts: [] }, baseRev: 0 } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.rev, 1)
  assert.deepEqual(stale.body.state.workouts, [{ id: 'w1' }])

  // an older reset stamp never replaces the stored one
  await call('PUT', '/api/data', { cookie, body: { state: { workouts: [], resetAt: 10 }, baseRev: 1 } })
  assert.equal((await call('GET', '/api/data', { cookie })).body.state.resetAt, 50)
})

test('a document larger than one row survives the round trip', async () => {
  const { call, cookieFor, addUser } = setup()
  addUser()
  const cookie = cookieFor('u1')
  const big = { workouts: Array.from({ length: 3000 }, (_, i) => ({ id: 'w' + i, note: 'x'.repeat(800) })) }
  assert.ok(JSON.stringify(big).length > 2_000_000)
  assert.equal((await call('PUT', '/api/data', { cookie, body: { state: big } })).status, 200)
  const back = (await call('GET', '/api/data', { cookie })).body.state
  assert.equal(back.workouts.length, 3000)
  assert.equal(back.workouts[2999].note.length, 800)
})

test('changes from another site are refused', async () => {
  const { call, cookieFor, addUser } = setup()
  addUser()
  const cookie = cookieFor('u1')
  const body = { state: { workouts: [] } }
  assert.equal((await call('PUT', '/api/data', { cookie, body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call('PUT', '/api/data', { cookie, body, headers: { 'sec-fetch-site': '', origin: 'https://evil.example' } })).status, 403)
})

test('Apple Health: issue a token, ingest with it, read back, revoke', async () => {
  const { call, cookieFor, addUser } = setup()
  addUser()
  const cookie = cookieFor('u1')
  const today = new Date().toISOString().slice(0, 10)
  assert.deepEqual((await call('GET', '/api/account/health-token', { cookie })).body, { active: false, created: null, lastSync: null })
  const { token } = (await call('POST', '/api/account/health-token', { cookie })).body
  assert.match(token, /^gymh_/)
  const shortcut = { authorization: 'Bearer ' + token, 'sec-fetch-site': '' }
  const ok = await call('POST', '/api/health/ingest', { headers: shortcut, body: { date: today, dist: '7,84', steps: 10312 } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.saved.distKm, 7.84)
  assert.equal((await call('POST', '/api/health/ingest', { headers: shortcut, body: { date: today, dist: 'far' } })).status, 400)
  assert.equal((await call('GET', '/api/data', { headers: shortcut })).status, 401)
  assert.equal((await call('GET', '/api/health/daily?from=' + today, { cookie })).body.days[today].steps, 10312)
  assert.equal((await call('GET', '/api/account/health-token', { cookie })).body.active, true)
  await call('DELETE', '/api/account/health-token', { cookie })
  assert.equal((await call('POST', '/api/health/ingest', { headers: shortcut, body: { date: today, dist: 9 } })).status, 401)
})
