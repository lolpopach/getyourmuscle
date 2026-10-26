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

const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64')

test('meal photo: Workers AI names the dishes, and nothing is set up without a model', async () => {
  const none = setup()
  none.addUser()
  assert.equal((await none.call('GET', '/api/config')).body.meal_photo, false)
  assert.equal((await none.call('POST', '/api/meal/photo', { cookie: none.cookieFor('u1'), body: { image: PHOTO } })).status, 404)

  const runs = []
  const AI = { run: async (model, input) => {
    runs.push({ model, input })
    return { choices: [{ message: { content: JSON.stringify({ is_food: true, items: [
      { name: '흰쌀밥', servings: 0.5, grams: 105, kcal: 155, protein_g: 3, carbs_g: 34, fat_g: 0 },
      { name: '제육볶음', servings: 1.1, grams: 160, kcal: 350, protein_g: 21, carbs_g: 12, fat_g: 23 },
    ] }) } }] }
  } }
  const { call, cookieFor, addUser } = setup({ AI })
  addUser()
  const cookie = cookieFor('u1')
  assert.equal((await call('GET', '/api/config')).body.meal_photo, true)
  assert.equal((await call('POST', '/api/meal/photo', { body: { image: PHOTO } })).status, 401)
  assert.equal((await call('POST', '/api/meal/photo', { cookie, body: { image: 'https://example.com/a.jpg' } })).status, 400)

  const r = await call('POST', '/api/meal/photo', { cookie, body: { image: PHOTO, note: '밥 반만 먹음' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.provider, 'workers-ai')
  assert.deepEqual(r.body.items.map(i => [i.name, i.servings]), [['흰쌀밥', 0.5], ['제육볶음', 1]])
  assert.equal(runs[0].model, '@cf/google/gemma-4-26b-a4b-it')
  const user = runs[0].input.messages[1].content
  assert.equal(user[0].text, "User's note: 밥 반만 먹음")
  assert.equal(user[1].image_url.url, PHOTO)
  assert.deepEqual(runs[0].input.chat_template_kwargs, { enable_thinking: false })
})

test('meal photo: a Gemini key wins over Workers AI, keeps the key out of the URL, and errors map', async () => {
  const sent = []
  let answer = { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '```json\n{"is_food": true, "items": [{"name": "닭가슴살", "servings": 2, "grams": 200, "kcal": 220, "protein_g": 46, "carbs_g": 2, "fat_g": 4}]}\n```' }] }, finishReason: 'STOP' }] }
  let status = 200
  const fetch = async (url, init) => { sent.push({ url: String(url), init }); return new Response(JSON.stringify(answer), { status }) }
  const AI = { run: async () => { throw new Error('should not be used') } }
  const { call, cookieFor, addUser } = setup({ GEMINI_API_KEY: 'AIza-test', AI }, { fetch })
  addUser()
  const cookie = cookieFor('u1')
  const r = await call('POST', '/api/meal/photo', { cookie, body: { image: PHOTO } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { items: [{ name: '닭가슴살', servings: 2, grams: 200, kcal: 220, p: 46, c: 2, f: 4 }], provider: 'gemini', model: 'gemini-3.8-flash' })
  assert.equal(sent[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
  assert.equal(sent[0].init.headers['x-goog-api-key'], 'AIza-test')
  assert.equal(JSON.parse(sent[0].init.body).contents[0].parts[0].inlineData.mimeType, 'image/jpeg')

  answer = { candidates: [{ content: { parts: [{ text: '{"is_food": false, "items": []}' }] } }] }
  assert.equal((await call('POST', '/api/meal/photo', { cookie, body: { image: PHOTO } })).status, 422)
  status = 429
  answer = { error: { message: 'Resource has been exhausted' } }
  assert.equal((await call('POST', '/api/meal/photo', { cookie, body: { image: PHOTO } })).status, 429)
  status = 400
  const bad = await call('POST', '/api/meal/photo', { cookie, body: { image: PHOTO } })
  assert.equal(bad.status, 502)
  assert.match(bad.body.error, /Gemini answered 400/)
})

test('meal photo: thirty an hour per profile', async () => {
  const AI = { run: async () => ({ response: { is_food: true, items: [{ name: '사과', servings: 1 }] } }) }
  const { call, cookieFor, addUser } = setup({ AI })
  addUser()
  const cookie = cookieFor('u1')
  for (let i = 0; i < 30; i++) assert.equal((await call('POST', '/api/meal/photo', { cookie, body: { image: PHOTO } })).status, 200)
  const r = await call('POST', '/api/meal/photo', { cookie, body: { image: PHOTO } })
  assert.equal(r.status, 429)
  assert.ok(+r.headers.get('retry-after') > 0)
})
