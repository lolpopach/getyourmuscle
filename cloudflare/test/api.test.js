// The Cloudflare API (cloudflare/api.js) on node:sqlite in place of the Durable Object's SQLite:
// the same statements, the same rows. Sessions are minted with the secret the API keeps in the
// database, the way the api/ tests mint them with DATA_DIR/secret. The passkey ceremonies
// themselves are exercised end to end in a browser (docs/DEPLOY_CLOUDFLARE.md); here, that the
// options carry this address as the relying party and that sign-up closes after the owner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { SCHEMA, createApi } from '../api.js'

const HOST = 'https://getyourmuscle.example.workers.dev'
function setup(env = {}, deps = {}) {
  const sql = new DatabaseSync(':memory:')
  const db = { exec: (q, ...p) => (/^\s*SELECT/i.test(q) ? sql.prepare(q).all(...p) : (sql.prepare(q).run(...p), [])) }
  for (const s of SCHEMA) db.exec(s)
  const handle = createApi(db, env, deps)
  const secret = db.exec("SELECT v FROM kv WHERE k = 'secret'")[0].v
  const cookieFor = (uid, sv = 0) => {
    const p = `${uid}:${Date.now() + 86400000}:${sv}`
    return `__Host-gymsid=${p}.${crypto.createHmac('sha256', secret).update(p).digest('base64url')}`
  }
  const addUser = (id = 'u1', name = 'Chan') => db.exec('INSERT INTO users (id, name, created) VALUES (?, ?, ?)', id, name, new Date().toISOString())
  const call = async (method, path, { body, cookie, headers = {}, now } = {}) => {
    const h = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }
    if (cookie) h.cookie = cookie
    const res = await handle(new Request(HOST + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), now ? { now } : undefined)
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
  // What this API leaves out is named, so the app hides it rather than offering a 404.
  assert.deepEqual([cfg.push, cfg.pairing, cfg.device_link], [false, false, false])
  assert.equal('signup' in cfg, false)
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
  const closed = (await call('GET', '/api/config')).body
  assert.equal(closed.invite_only, true)
  assert.equal(closed.signup, false)
  assert.equal((await call('POST', '/api/register/options', { body: { name: 'Someone' } })).status, 403)
})

test('OPEN_SIGNUP keeps sign-up open after the first profile', async () => {
  const { call, addUser } = setup({ OPEN_SIGNUP: '1' })
  addUser()
  assert.equal('signup' in (await call('GET', '/api/config')).body, false)
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

/* ---------- G-PLAN: school lunch and meal photos ---------- */

// A month of the school's real menu page (EUC-KR), cut to its first eight days.
const MENU_PAGE = readFileSync(new URL('../../api/test/fixtures/kshcm-menu-2026-10.html', import.meta.url))
const school = () => {
  const asked = []
  const fetch = async url => {
    asked.push(String(url))
    if (fetch.down) throw new Error('ECONNREFUSED')
    return new Response(MENU_PAGE, { headers: { 'content-type': 'text/html' } })
  }
  return { fetch, asked }
}

test('lunch: one day of the school menu, cached by month, an old copy while the school is down', async () => {
  const { fetch, asked } = school()
  const { call, cookieFor, addUser } = setup({}, { fetch })
  addUser()
  const cookie = cookieFor('u1')
  assert.equal((await call('GET', '/api/config')).body.lunch, true)
  assert.equal((await call('GET', '/api/lunch?date=2026-10-01')).status, 401)
  assert.equal((await call('GET', '/api/lunch?date=10/01', { cookie })).status, 400)

  const day = await call('GET', '/api/lunch?date=2026-10-01', { cookie })
  assert.equal(day.status, 200)
  assert.deepEqual(day.body.meals, [{ label: '중식', dishes: ['흰쌀밥', '순두부찌개(0.6)', '소불고기', '치즈계란말이*케찹', '열무김치', '파인애플'] }])
  assert.equal(asked.length, 1)
  assert.match(asked[0], /^http:\/\/kshcm\.net\/\?menu_no=34&ChangeDate=2026-10-1$/)

  // The weekend: no meal, from the same cached month.
  assert.deepEqual((await call('GET', '/api/lunch?date=2026-10-03', { cookie })).body.meals, [])
  assert.equal(asked.length, 1)

  // Past the cache's lifetime the school is asked again; while its site is down, the old copy
  // answers. A month never fetched has nothing to fall back on.
  fetch.down = true
  const later = Date.now() + 7 * 3600000
  const stale = await call('GET', '/api/lunch?date=2026-10-02', { cookie, now: later })
  assert.equal(stale.status, 200)
  assert.equal(stale.body.meals[0].dishes[0], '크림스파게티')
  assert.equal(asked.length, 2)
  const never = await call('GET', '/api/lunch?date=2026-11-02', { cookie, now: later })
  assert.equal(never.status, 502)
  assert.match(never.body.error, /could not be reached/)
})

test('lunch: LUNCH_URL points at another school, and empty turns it off', async () => {
  const { fetch, asked } = school()
  const other = setup({ LUNCH_URL: 'https://school.example/?menu_no=7' }, { fetch })
  other.addUser()
  await other.call('GET', '/api/lunch?date=2026-10-02', { cookie: other.cookieFor('u1') })
  assert.equal(asked[0], 'https://school.example/?menu_no=7&ChangeDate=2026-10-1')

  const off = setup({ LUNCH_URL: '' }, { fetch })
  off.addUser()
  assert.equal((await off.call('GET', '/api/config')).body.lunch, false)
  assert.equal((await off.call('GET', '/api/lunch?date=2026-10-02', { cookie: off.cookieFor('u1') })).status, 404)
})

test('lunch: the month Claude read off the school\'s PDF answers for the days the calendar page lacks', async () => {
  const { fetch } = school()
  const { call, cookieFor, addUser } = setup({}, { fetch })
  addUser('u1'); addUser('u2')
  const cookie = cookieFor('u1')
  const token = (await call('POST', '/api/account/claude-token', { cookie })).body.token
  const claude = { authorization: 'Bearer ' + token, 'sec-fetch-site': '' }
  const menu = { month: '2026-10', days: { '2026-10-01': ['PDF 흰쌀밥', '순두부찌개'], '2026-10-26': ['흰쌀밥', '돈육콩비지찌개', '치즈함박카츠*브라운S'] } }
  assert.equal((await call('POST', '/api/claude/lunch', { cookie, body: menu })).status, 401)
  assert.equal((await call('POST', '/api/claude/lunch', { headers: claude, body: { month: '2026-10', days: { '2026-11-02': ['x'] } } })).status, 400)
  assert.equal((await call('POST', '/api/claude/lunch', { headers: claude, body: { month: '2026-10', days: { '2026-10-26': [] } } })).status, 400)
  assert.deepEqual((await call('POST', '/api/claude/lunch', { headers: claude, body: menu })).body, { ok: true, month: '2026-10', days: 2 })
  assert.deepEqual(Object.keys((await call('GET', '/api/claude/lunch', { headers: claude })).body.months), ['2026-10'])

  // The calendar page has the 1st: it wins. It does not have the 26th yet: the PDF answers.
  assert.equal((await call('GET', '/api/lunch?date=2026-10-01', { cookie })).body.meals[0].dishes[0], '흰쌀밥')
  assert.deepEqual((await call('GET', '/api/lunch?date=2026-10-26', { cookie })).body.meals, [{ label: '중식', dishes: ['흰쌀밥', '돈육콩비지찌개', '치즈함박카츠*브라운S'] }])
  // With the school's site down and nothing cached, the PDF still answers.
  fetch.down = true
  const fresh = setup({}, { fetch })
  fresh.addUser('u1')
  const tok2 = (await fresh.call('POST', '/api/account/claude-token', { cookie: fresh.cookieFor('u1') })).body.token
  await fresh.call('POST', '/api/claude/lunch', { headers: { authorization: 'Bearer ' + tok2, 'sec-fetch-site': '' }, body: menu })
  assert.equal((await fresh.call('GET', '/api/lunch?date=2026-10-26', { cookie: fresh.cookieFor('u1') })).body.meals[0].dishes[1], '돈육콩비지찌개')
  // Another profile on the same instance does not see it.
  fetch.down = false
  assert.deepEqual((await call('GET', '/api/lunch?date=2026-10-26', { cookie: cookieFor('u2') })).body.meals, [])
  // Not even one whose id differs only where the other has a `_` (a wildcard to SQL's LIKE).
  addUser('a_b'); addUser('aXb')
  const tokFor = async id => ({ authorization: 'Bearer ' + (await call('POST', '/api/account/claude-token', { cookie: cookieFor(id) })).body.token, 'sec-fetch-site': '' })
  const ab = await tokFor('a_b'), axb = await tokFor('aXb')
  await call('POST', '/api/claude/lunch', { headers: axb, body: { month: '2026-09', days: { '2026-09-01': ['흰쌀밥'] } } })
  await call('POST', '/api/claude/lunch', { headers: ab, body: menu })
  assert.deepEqual(Object.keys((await call('GET', '/api/claude/lunch', { headers: ab })).body.months), ['2026-10'])
})

const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64')

test('Claude inbox: the app queues a meal, Claude reads it with its token and answers, the app applies it', async () => {
  const { call, cookieFor, addUser } = setup()
  addUser()
  const cookie = cookieFor('u1')
  assert.deepEqual((await call('GET', '/api/config', { cookie })).body.claude, { linked: false })
  assert.equal('claude' in (await call('GET', '/api/config')).body, false)

  // The owner issues a token for the scheduled Claude session.
  const { token } = (await call('POST', '/api/account/claude-token', { cookie })).body
  assert.match(token, /^gplanc_/)
  assert.deepEqual((await call('GET', '/api/config', { cookie })).body.claude, { linked: true })
  const claude = { authorization: 'Bearer ' + token, 'sec-fetch-site': '' }

  // A meal written and photographed: saved at once, the photo kept for Claude only.
  assert.equal((await call('POST', '/api/inbox', { body: { id: 'm0001', date: '2026-10-27', slot: 'd', text: 'x' } })).status, 401)
  assert.equal((await call('POST', '/api/inbox', { cookie, body: { id: 'm0001', date: '2026-10-27', slot: 'x', text: '꿔바로우' } })).status, 400)
  assert.equal((await call('POST', '/api/inbox', { cookie, body: { id: 'm0001', date: '2026-10-27', slot: 'd' } })).status, 400)
  const sent = await call('POST', '/api/inbox', { cookie, body: { id: 'm0001', date: '2026-10-27', slot: 'd', mealId: 'meal-1', text: '꿔바로우 반 접시, 3명이서', photo: PHOTO, estimate: { kcal: 400, p: 20 } } })
  assert.equal(sent.status, 200)
  assert.deepEqual(sent.body.entry, { id: 'm0001', date: '2026-10-27', slot: 'd', mealId: 'meal-1', text: '꿔바로우 반 접시, 3명이서', hasPhoto: true, status: 'pending', created: sent.body.entry.created, result: null, doneAt: null })
  assert.equal((await call('GET', '/api/account/claude-token', { cookie })).body.pending, 1)

  // Claude: no token, a session cookie, or a made-up token are all refused.
  assert.equal((await call('GET', '/api/claude/inbox')).status, 401)
  assert.equal((await call('GET', '/api/claude/inbox', { cookie })).status, 401)
  assert.equal((await call('GET', '/api/claude/inbox', { headers: { authorization: 'Bearer gplanc_nope' } })).status, 401)
  const inbox = (await call('GET', '/api/claude/inbox', { headers: claude })).body.entries
  assert.deepEqual(inbox.map(e => [e.id, e.text, e.photo === PHOTO, e.estimate.kcal]), [['m0001', '꿔바로우 반 접시, 3명이서', true, 400]])
  assert.ok((await call('GET', '/api/account/claude-token', { cookie })).body.used)

  // The answer: totals added up from the items; the photo is dropped.
  assert.equal((await call('POST', '/api/claude/result', { headers: claude, body: { id: 'm0001', items: [{ name: '꿔바로우' }] } })).status, 400)
  assert.equal((await call('POST', '/api/claude/result', { headers: claude, body: { id: 'nope', items: [{ name: '꿔바로우', kcal: 1 }] } })).status, 404)
  const done = await call('POST', '/api/claude/result', { headers: claude, body: { id: 'm0001', note: 'a third of a plate for three', items: [
    { name: '꿔바로우', amount: '1/6접시', kcal: 260, p: 9, c: 30, f: 11 },
    { name: '흰쌀밥', amount: '1공기', kcal: 310, p: 6, c: 68, f: 1 },
  ] } })
  assert.equal(done.status, 200)
  const back = (await call('GET', '/api/inbox', { cookie })).body.entries
  assert.equal(back[0].status, 'done')
  assert.deepEqual(back[0].result, { items: [
    { name: '꿔바로우', amount: '1/6접시', kcal: 260, p: 9, c: 30, f: 11 },
    { name: '흰쌀밥', amount: '1공기', kcal: 310, p: 6, c: 68, f: 1 },
  ], kcal: 570, p: 15, c: 98, f: 12, note: 'a third of a plate for three', by: 'claude' })
  assert.equal(back[0].hasPhoto, false)
  assert.deepEqual((await call('GET', '/api/claude/inbox', { headers: claude })).body.entries, [])

  // Applied by the app, then acknowledged and gone.
  assert.equal((await call('POST', '/api/inbox/ack', { cookie, body: { ids: ['m0001'] } })).body.removed, 1)
  assert.deepEqual((await call('GET', '/api/inbox', { cookie })).body.entries, [])
})

test('Claude inbox: the dataset of foods Claude worked out, and a new token ends the old one', async () => {
  const { call, cookieFor, addUser } = setup()
  addUser()
  const cookie = cookieFor('u1')
  const first = (await call('POST', '/api/account/claude-token', { cookie })).body.token
  const claude = tok => ({ authorization: 'Bearer ' + tok, 'sec-fetch-site': '' })
  assert.equal((await call('POST', '/api/claude/foods', { headers: claude(first), body: { foods: [{ name: '꿔바로우', kcal: 520 }] } })).status, 400)
  const put = await call('POST', '/api/claude/foods', { headers: claude(first), body: { foods: [
    { name: '꿔바로우', g: 200, kcal: 520, p: 18, c: 60, f: 22, note: '1 plate for one' },
    { name: '마라탕', g: 600, kcal: 650, p: 30, c: 55, f: 33 },
  ] } })
  assert.deepEqual(put.body, { ok: true, added: 2, count: 2 })
  // A better answer for the same name replaces it.
  await call('POST', '/api/claude/foods', { headers: claude(first), body: { foods: [{ name: '마 라 탕', g: 600, kcal: 700, p: 32, c: 60, f: 35 }] } })
  const foods = (await call('GET', '/api/foods', { cookie })).body.foods
  assert.deepEqual(foods.map(f => [f.name, f.kcal]), [['꿔바로우', 520], ['마 라 탕', 700]])
  assert.equal((await call('GET', '/api/foods')).status, 401)

  const second = (await call('POST', '/api/account/claude-token', { cookie })).body.token
  assert.equal((await call('GET', '/api/claude/foods', { headers: claude(first) })).status, 401)
  assert.equal((await call('GET', '/api/claude/foods', { headers: claude(second) })).body.foods.length, 2)
  assert.deepEqual((await call('DELETE', '/api/account/claude-token', { cookie })).body, { active: false })
  assert.equal((await call('GET', '/api/claude/foods', { headers: claude(second) })).status, 401)
})

test('Claude inbox: a full inbox says so, and one profile never sees another\'s', async () => {
  const { call, cookieFor, addUser } = setup({ OPEN_SIGNUP: '1' })
  addUser('u1', 'Chan')
  addUser('u2', 'Friend')
  const a = cookieFor('u1'), b = cookieFor('u2')
  for (let i = 0; i < 30; i++) assert.equal((await call('POST', '/api/inbox', { cookie: a, body: { id: 'meal' + i, date: '2026-10-27', slot: 's', text: '간식 ' + i } })).status, 200)
  assert.equal((await call('POST', '/api/inbox', { cookie: a, body: { id: 'meal99', date: '2026-10-27', slot: 's', text: 'one more' } })).status, 429)
  assert.deepEqual((await call('GET', '/api/inbox', { cookie: b })).body.entries, [])
  // The same id from another profile is another entry.
  assert.equal((await call('POST', '/api/inbox', { cookie: b, body: { id: 'meal0', date: '2026-10-27', slot: 's', text: '사과' } })).status, 200)
  assert.equal((await call('GET', '/api/inbox', { cookie: a })).body.entries[0].text, '간식 0')
  const tokB = (await call('POST', '/api/account/claude-token', { cookie: b })).body.token
  const seen = (await call('GET', '/api/claude/inbox', { headers: { authorization: 'Bearer ' + tokB } })).body.entries
  assert.deepEqual(seen.map(e => e.text), ['사과'])
})
