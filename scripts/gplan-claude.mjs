#!/usr/bin/env node
// The scheduled Claude session's side of G-PLAN's meal inbox (docs/dev/CLAUDE_MEALS.md).
//
//   node scripts/gplan-claude.mjs check              is the token set, and does the server know it?
//   node scripts/gplan-claude.mjs pull [dir]         the meals waiting, photos saved into dir
//   node scripts/gplan-claude.mjs answer file.json   send the worked-out meals back
//   node scripts/gplan-claude.mjs foods              the dataset of foods worked out so far
//   node scripts/gplan-claude.mjs learn file.json    add or replace foods in the dataset
//   node scripts/gplan-claude.mjs lunch [dir] [from] [to]
//                                                    the school lunches from the 1st of last month
//                                                    to a week ahead (or from/to YYYY-MM-DD), only
//                                                    the days with work left: dishes the table does
//                                                    not know, and dataset dishes not yet checked
//                                                    against a tray photo posted since
//
// GPLAN_CLAUDE_TOKEN is the token from G-PLAN's Settings → "Claude works out meals"; GPLAN_URL
// the server (the owner's Worker by default). Every answer is JSON on stdout; a problem is one
// line on stderr and a non-zero exit, so the session can stop early instead of guessing.
//
// The food table's reading of each meal comes along with it ("table"), from the app's own code,
// so an answer can stay consistent with the numbers the app shows for the same dish.
import fs from 'node:fs'
import path from 'node:path'
import { findFood, normName, setMyFoods } from '../frontend/src/lib/foods.js'
import { rowsFromText } from '../frontend/src/lib/food-text.js'
import { rowFood, rowNutrition, rowServings } from '../frontend/src/lib/food-calc.js'
import { parseMenu } from '../frontend/src/lib/lunch.js'
import { fetchMonth, lunchUrl } from '../api/school-lunch.js'

const BASE = (process.env.GPLAN_URL || 'https://getyourmuscle.yangchanhee11.workers.dev').replace(/\/+$/, '')
const TOKEN = (process.env.GPLAN_CLAUDE_TOKEN || '').trim()
const TZ = process.env.GPLAN_TZ || 'Asia/Ho_Chi_Minh'

const out = v => process.stdout.write(JSON.stringify(v, null, 2) + '\n')
// Exit codes: 1 a request the server refused, 2 the token (missing, revoked), 3 the server or the
// school site out of reach, or a server without the inbox.
const fail = (msg, code = 1, status = 0) => { throw Object.assign(new Error(msg), { code, status }) }

async function call(route, { method = 'GET', body } = {}) {
  if (!TOKEN) fail('GPLAN_CLAUDE_TOKEN is not set: issue one in G-PLAN (Settings → Claude works out meals) and add it to this environment.', 2)
  let res
  try {
    res = await fetch(BASE + route, {
      method,
      headers: { authorization: 'Bearer ' + TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    fail(`${BASE} could not be reached (${e.cause?.code || e.cause?.errors?.[0]?.code || e.message}).`, 3)
  }
  const data = await res.json().catch(() => null)
  if (res.status === 401) fail('The server refused the token: it was revoked or replaced. Issue a new one in G-PLAN and update GPLAN_CLAUDE_TOKEN.', 2)
  if (res.status === 404 && !String(data?.error || '').startsWith('no such entry')) fail(`${BASE} has no Claude inbox yet: the server runs an older build. Deploy the G-PLAN branch first.`, 3)
  if (!res.ok) fail(`${method} ${route} → ${res.status}: ${data?.error || 'no detail'}`, 1, res.status)
  return data
}

// The table's reading of what was written: each dish, the row it matched and how, its numbers.
const tableReading = text => rowsFromText(text || '').map(r => {
  const m = rowFood(r)
  const n = rowNutrition(r)
  return {
    written: r.name,
    food: m?.food.name ?? null,
    how: m?.how ?? null,   // exact, mine (the dataset), similar (a near dish), guess (made up from the name)
    servings: Math.round(rowServings(r) * 100) / 100,
    pieces: r.pieces,
    gramsPerServing: m?.food.g ?? null,
    kcal: n.kcal, p: n.p, c: n.c, f: n.f,
  }
})

async function loadDataset() {
  const r = await call('/api/claude/foods')
  const foods = Array.isArray(r?.foods) ? r.foods : []
  setMyFoods(foods)
  return foods
}

const readJson = file => {
  if (!file) fail('Name the JSON file to send.')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { fail(`${file}: ${e.message}`) }
}

function savePhoto(dir, name, dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || '')
  if (!m) return null
  fs.mkdirSync(dir, { recursive: true })
  const file = path.resolve(dir, `${name}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'))
  return file
}

// A day in the owner's time zone, `offset` days from today.
function localDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
const isDayStr = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d + 'T00:00:00Z'))
const nextDay = d => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
const firstOfLastMonth = d => {
  const [y, m] = d.split('-').map(Number)
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`
}

const commands = {
  async check() {
    const r = await call('/api/claude/inbox')
    out({ ok: true, server: BASE, waiting: (r?.entries || []).length })
  },

  async pull(dir = 'gplan-inbox') {
    await loadDataset()
    const r = await call('/api/claude/inbox')
    const entries = (r?.entries || []).map(e => ({
      id: e.id,
      date: e.date,
      slot: { b: 'breakfast', l: 'lunch', s: 'snack', d: 'dinner' }[e.slot] || e.slot,
      text: e.text,
      photo: e.photo ? savePhoto(dir, e.id, e.photo) : null,
      appEstimate: e.estimate,
      table: tableReading(e.text),
    }))
    out({ server: BASE, entries })
  },

  async answer(file) {
    const list = readJson(file)
    const answers = Array.isArray(list) ? list : [list]
    const done = [], skipped = []
    for (const a of answers) {
      try {
        await call('/api/claude/result', { method: 'POST', body: a })
        const items = Array.isArray(a?.items) ? a.items : []
        done.push({ id: a.id, kcal: Math.round(items.reduce((t, i) => t + (+i.kcal || 0), 0)) })
      } catch (e) {
        // The owner deleted the meal, or one answer is malformed: the others still go.
        if (e.status !== 404 && e.status !== 400) throw e
        skipped.push({ id: a?.id, why: e.message })
      }
    }
    out({ answered: done, skipped })
    if (skipped.length && !done.length) process.exitCode = 1
  },

  async foods() {
    const foods = await loadDataset()
    out({ count: foods.length, foods })
  },

  async learn(file) {
    const v = readJson(file)
    const foods = Array.isArray(v) ? v : v?.foods
    const r = await call('/api/claude/foods', { method: 'POST', body: { foods } })
    out(r)
  },

  // The school posts its tray photos when it gets round to it — often several weeks at once — so
  // every run looks back to the 1st of last month. What was already done is not handed out again:
  // a dish in the dataset carries `tray`, the day whose photo it was checked against.
  async lunch(dir = 'gplan-lunch', from = null, to = null) {
    for (const d of [from, to]) if (d && !isDayStr(d)) fail('from and to must be YYYY-MM-DD')
    const mine = new Map()
    if (TOKEN) for (const f of await loadDataset()) mine.set(normName(f.name), f)
    const base = lunchUrl(process.env)
    if (!base) fail('LUNCH_URL is empty: no school menu to read.')
    const start = from || firstOfLastMonth(localDay())
    const end = to || localDay(7)
    if (end < start) fail('to is before from')
    const dates = []
    for (let d = start; d <= end && dates.length < 120; d = nextDay(d)) dates.push(d)
    const months = {}
    for (const m of new Set(dates.map(d => d.slice(0, 7)))) {
      months[m] = await fetchMonth(base, m)
      if (months[m].error) fail(`School menu for ${m}: ${months[m].error}`, 3)
    }
    const days = []
    let schoolDays = 0, trayPhotos = 0
    for (const date of dates) {
      const doc = months[date.slice(0, 7)]
      const meal = (doc.days[date] || []).find(x => /중식|점심|lunch/i.test(x.label)) || (doc.days[date] || [])[0]
      if (!meal) continue
      schoolDays++
      const photoUrl = doc.photos?.[date] || null
      if (photoUrl) trayPhotos++
      const dishes = parseMenu(meal.dishes).map(d => {
        const m = findFood(d.name)
        const own = m?.how === 'mine' ? mine.get(normName(m.food.name)) || null : null
        return { name: d.name, written: d.raw, extraCounter: d.extra, how: m?.how ?? null, food: m?.food ?? null, own }
      })
      const work = []
      for (const d of dishes) {
        const table = d.food && { food: d.food.name, cat: d.food.cat, g: d.food.g, kcal: d.food.kcal, p: d.food.p, c: d.food.c, f: d.food.f }
        // Not known yet: work it out (with the photo when there is one).
        if (d.how !== 'exact' && d.how !== 'mine') work.push({ name: d.name, written: d.written, extraCounter: d.extraCounter, todo: 'work-out', tableGuess: { how: d.how, ...table } })
        // Worked out from the menu alone, and now there is a photo: check the serving against it.
        else if (d.how === 'mine' && photoUrl && !d.own?.tray) work.push({ name: d.name, written: d.written, extraCounter: d.extraCounter, todo: 'check-photo', dataset: d.own || table })
      }
      if (!work.length) continue
      let trayPhoto = null
      if (photoUrl) {
        try {
          const res = await fetch(photoUrl, { signal: AbortSignal.timeout(20000) })
          if (res.ok) {
            fs.mkdirSync(dir, { recursive: true })
            const ext = (/\.(jpe?g|png|webp)$/i.exec(new URL(photoUrl).pathname)?.[1] || 'jpg').toLowerCase()
            trayPhoto = path.resolve(dir, `lunch-${date}.${ext}`)
            fs.writeFileSync(trayPhoto, Buffer.from(await res.arrayBuffer()))
          }
        } catch { /* the photo is a help, not a need: the dishes are still listed */ }
      }
      days.push({ date, label: meal.label, trayPhoto, trayPhotoUrl: photoUrl, menu: dishes.map(d => d.name), work })
    }
    out({ from: start, to: end, schoolDays, trayPhotos, daysWithWork: days.length, days })
  },
}

const [cmd, ...args] = process.argv.slice(2)
try {
  if (!commands[cmd]) fail(`Usage: node scripts/gplan-claude.mjs ${Object.keys(commands).join('|')} …`)
  await commands[cmd](...args)
} catch (e) {
  process.stderr.write(e.message + '\n')
  process.exitCode = e.code || 1
}
