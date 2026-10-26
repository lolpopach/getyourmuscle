// The school lunch menu (school-lunch.js) and meal photos (meal-photo.js): the parsing on their
// own, then both routes on a running server against a stand-in for the school's site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { parseMenuPage, decodePage, splitDishes, monthUrl, lunchFor, LUNCH_CACHE_MS } from '../school-lunch.js';
import { parsePhotoBody, normalizeRecognition, parseAnswer, photoProvider } from '../meal-photo.js';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The school's real page for October 2026, cut to its first eight days, in its own EUC-KR.
const PAGE = fs.readFileSync(path.join(API, 'test', 'fixtures', 'kshcm-menu-2026-10.html'));

test('the school page: EUC-KR, one entry per school day, weekends left out', () => {
  const doc = parseMenuPage(decodePage(new Uint8Array(PAGE), 'text/html'));
  assert.equal(doc.month, '2026-10');
  assert.deepEqual(Object.keys(doc.days), ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  assert.deepEqual(doc.days['2026-10-06'], [{ label: '중식', dishes: ['흑미밥', '조개시금치국(0.6)', '매운쪽갈비찜', '두부구이*양념장', '배추김치', '바나나1/2'] }]);
  assert.deepEqual(parseMenuPage('<html>no menu here</html>'), { month: null, days: {} });
});

test('a dish line: commas inside parentheses, entities and line breaks', () => {
  assert.deepEqual(splitDishes('망고 (추가배식대 : 흰쌀밥, 배추된장국), 요거트'), ['망고 (추가배식대 : 흰쌀밥, 배추된장국)', '요거트']);
  const html = '<table><caption>2026년 6월 날짜별 식단안내</caption><tr><th>3일 (수)</th><td><span class="design_font">중식</span><p>타코야키&nbsp;<span>x</span>, 사과요거트<br></p></td></tr></table>';
  assert.deepEqual(parseMenuPage(html).days['2026-06-03'][0].dishes, ['타코야키 x', '사과요거트']);
  assert.equal(monthUrl('http://kshcm.net/?menu_no=34', '2026-03'), 'http://kshcm.net/?menu_no=34&ChangeDate=2026-3-1');
});

test('the month cache: fresh is used, stale is refreshed, and kept when the school is down', async () => {
  const month = { month: '2026-10', days: { '2026-10-01': [{ label: '중식', dishes: ['흰쌀밥'] }] }, at: 1000 };
  let asked = 0;
  const up = async () => { asked++; return { ...month, at: 5000 }; };
  const down = async () => { asked++; return { error: 'down' }; };
  assert.deepEqual((await lunchFor('2026-10-01', month, up, 2000)).body.meals, month.days['2026-10-01']);
  assert.equal(asked, 0);
  const refreshed = await lunchFor('2026-10-01', month, up, 1000 + LUNCH_CACHE_MS + 1);
  assert.equal(refreshed.store.at, 5000);
  const kept = await lunchFor('2026-10-02', month, down, 1000 + LUNCH_CACHE_MS + 1);
  assert.deepEqual(kept, { body: { date: '2026-10-02', meals: [], fetchedAt: 1000 }, store: null });
  assert.deepEqual(await lunchFor('2026-11-02', month, down, 0), { error: 'down' });
});

test('a photo request and a model answer, bounded', () => {
  assert.deepEqual(parsePhotoBody({ image: 'data:image/png;base64,AAAA', note: '  밥   반만  ' }), { mediaType: 'image/png', data: 'AAAA', note: '밥 반만' });
  assert.match(parsePhotoBody({ image: 'data:image/gif;base64,AAAA' }).error, /JPEG/);
  assert.match(parsePhotoBody({}).error, /data URL/);
  assert.match(parsePhotoBody({ image: 'data:image/jpeg;base64,' + 'A'.repeat(4 * 1024 * 1024 + 4) }).error, /too large/);

  assert.deepEqual(parseAnswer('Sure! ```json\n{"is_food": true, "items": []}\n```'), { is_food: true, items: [] });
  assert.equal(parseAnswer('no json'), null);
  const r = normalizeRecognition({ is_food: true, items: [
    { name: '  흰쌀밥 ', servings: 0.6, grams: 120, kcal: 180, protein_g: 3, carbs_g: 40, fat_g: 0 },
    { name: '', servings: 1 },
    { name: '제육볶음', servings: 'lots', kcal: -5, protein: 22 }
  ] });
  assert.deepEqual(r, { isFood: true, items: [
    { name: '흰쌀밥', servings: 0.5, grams: 120, kcal: 180, p: 3, c: 40, f: 0 },
    { name: '제육볶음', servings: 1, grams: 0, kcal: 0, p: 22, c: 0, f: 0 }
  ] });
  assert.equal(normalizeRecognition({ is_food: false, items: [{ name: '고양이' }] }).isFood, false);
  assert.equal(photoProvider({}), null);
  assert.equal(photoProvider({ GEMINI_API_KEY: ' k ' }).model, 'gemini-3.8-flash');
});

const SECRET = 'test-secret-gplan';
const UID = 'u_gplan_1';
const cookie = () => { const p = `${UID}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };

async function server(t, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-gplan-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: UID, name: 'G', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GEMINI_API_KEY: '', LUNCH_URL: '', PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return `http://127.0.0.1:${await boundPort(child, () => log)}`;
}

test('an instance without LUNCH_URL or GEMINI_API_KEY offers neither', async t => {
  const base = await server(t, {});
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal('lunch' in cfg, false);
  assert.equal('meal_photo' in cfg, false);
  const app = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/lunch?date=2026-10-01`, { headers: app })).status, 404);
  assert.equal((await fetch(`${base}/api/meal/photo`, { method: 'POST', headers: app, body: '{}' })).status, 404);
});

test('GET /api/lunch reads the school page once a month and answers per day', async t => {
  const asked = [];
  const school = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise(r => school.listen(0, '127.0.0.1', r));
  t.after(() => school.close());
  const base = await server(t, { LUNCH_URL: `http://127.0.0.1:${school.address().port}/?menu_no=34`, GEMINI_API_KEY: 'AIza-test' });
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.lunch, true);
  assert.equal(cfg.meal_photo, true);

  const app = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/lunch?date=2026-10-01`)).status, 401);
  assert.equal((await fetch(`${base}/api/lunch?date=yesterday`, { headers: app })).status, 400);
  const day = await (await fetch(`${base}/api/lunch?date=2026-10-07`, { headers: app })).json();
  assert.deepEqual(day.meals[0].dishes, ['흰쌀밥', '콩나물국(0.5)', '안동찜닭', '시금치나물', '배추김치', '용과']);
  assert.deepEqual((await (await fetch(`${base}/api/lunch?date=2026-10-04`, { headers: app })).json()).meals, []);
  assert.deepEqual(asked, ['/?menu_no=34&ChangeDate=2026-10-1']);

  // The photo route is wired: a request it cannot use never reaches the provider.
  const bad = await fetch(`${base}/api/meal/photo`, { method: 'POST', headers: app, body: JSON.stringify({ image: 'https://x/y.jpg' }) });
  assert.equal(bad.status, 400);
});
