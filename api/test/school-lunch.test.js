// The school lunch menu (school-lunch.js) and the inbox for Claude (claude-inbox.js): the
// parsing on its own, then the routes on a running server — the lunch against a stand-in for the
// school's site, the inbox from the app's side and from Claude's.
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
import { parseInboxEntry, parseResult, mergeFoods, normName } from '../claude-inbox.js';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The school's real page for October 2026, cut to its first eight days, in its own EUC-KR.
const PAGE = fs.readFileSync(path.join(API, 'test', 'fixtures', 'kshcm-menu-2026-10.html'));

test('the school page: EUC-KR, one entry per school day, weekends left out', () => {
  const doc = parseMenuPage(decodePage(new Uint8Array(PAGE), 'text/html'));
  assert.equal(doc.month, '2026-10');
  assert.deepEqual(Object.keys(doc.days), ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  assert.deepEqual(doc.days['2026-10-06'], [{ label: '중식', dishes: ['흑미밥', '조개시금치국(0.6)', '매운쪽갈비찜', '두부구이*양념장', '배추김치', '바나나1/2'] }]);
  // The tray photo the school posts with each lunch.
  assert.equal(doc.photos['2026-10-01'], 'http://kshcm.net/upload/board/26.10.01_1.jpg');
  assert.equal(doc.photos['2026-10-03'], undefined);
  assert.deepEqual(parseMenuPage('<html>no menu here</html>'), { month: null, days: {}, photos: {} });
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
  assert.deepEqual(kept, { body: { date: '2026-10-02', meals: [], photo: null, fetchedAt: 1000 }, store: null });
  assert.deepEqual(await lunchFor('2026-11-02', month, down, 0), { error: 'down' });
});

test('an inbox entry, a result and the dataset, bounded', () => {
  const PHOTO = 'data:image/jpeg;base64,AAAA';
  const e = parseInboxEntry({ id: 'm0001', date: '2026-10-27', slot: 'd', mealId: 'x1', text: '  꿔바로우   반 접시 ', photo: PHOTO, estimate: { kcal: '400', p: -3 } }, 5).entry;
  assert.deepEqual(e, { id: 'm0001', date: '2026-10-27', slot: 'd', mealId: 'x1', text: '꿔바로우 반 접시', photo: PHOTO, estimate: { kcal: 400, p: 0, c: 0, f: 0 }, status: 'pending', created: 5, result: null, doneAt: null });
  assert.match(parseInboxEntry({ id: 'm1', date: '2026-10-27', slot: 'd', text: 'x' }).error, /id/);
  assert.match(parseInboxEntry({ id: 'm0001', date: '27/10', slot: 'd', text: 'x' }).error, /date/);
  assert.match(parseInboxEntry({ id: 'm0001', date: '2026-10-27', slot: 'd' }).error, /write what you ate/);
  assert.match(parseInboxEntry({ id: 'm0001', date: '2026-10-27', slot: 'd', photo: 'data:image/gif;base64,AAAA' }).error, /JPEG/);
  assert.match(parseInboxEntry({ id: 'm0001', date: '2026-10-27', slot: 'd', photo: 'data:image/jpeg;base64,' + 'A'.repeat(1.5 * 1024 * 1024) }).error, /too large/);

  const r = parseResult({ id: 'm0001', note: ' ok ', items: [{ name: '흰쌀밥', amount: '1공기', kcal: 310.4, p: 6, c: 68, f: 1 }, { name: '김치', kcal: 15 }] });
  assert.deepEqual(r.result, { items: [{ name: '흰쌀밥', amount: '1공기', kcal: 310, p: 6, c: 68, f: 1 }, { name: '김치', amount: '', kcal: 15, p: 0, c: 0, f: 0 }], kcal: 325, p: 6, c: 68, f: 1, note: 'ok', by: 'claude' });
  assert.match(parseResult({ id: 'm0001', items: [] }).error, /1–30/);
  assert.match(parseResult({ id: 'm0001', items: [{ name: 'x' }] }).error, /kcal/);

  const m = mergeFoods({ foods: [{ name: '마라탕', g: 600, kcal: 650 }] }, [{ name: '마 라 탕', cat: 'stew', g: 600, kcal: 700, p: 32 }, { name: '꿔바로우', cat: 'spicy', g: 200, kcal: 520, tray: '2026-10-06' }, { name: '두부조림', cat: 'side', g: 80, kcal: 110, tray: 'yesterday' }], 9);
  assert.deepEqual(m.doc.foods.map(f => [f.name, f.cat, f.kcal, f.tray, f.at]), [['마 라 탕', 'stew', 700, undefined, 9], ['꿔바로우', 'main', 520, '2026-10-06', 9], ['두부조림', 'side', 110, undefined, 9]]);
  assert.match(mergeFoods({}, [{ name: '꿔바로우', kcal: 520 }]).error, /g \(one serving/);
  assert.equal(normName('돈까스 * 브라운소스'), '돈까스브라운소스');
});

const SECRET = 'test-secret-gplan';
const UID = 'u_gplan_1';
const cookie = () => { const p = `${UID}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };

async function server(t, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-gplan-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: UID, name: 'G', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LUNCH_URL: '', PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return { base: `http://127.0.0.1:${await boundPort(child, () => log)}`, dataDir };
}

test('an instance without LUNCH_URL has no lunch, and a profile without a Claude token no claude key', async t => {
  const { base } = await server(t, {});
  const app = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  const cfg = await (await fetch(`${base}/api/config`, { headers: app })).json();
  assert.equal('lunch' in cfg, false);
  assert.equal('claude' in cfg, false);
  assert.equal((await fetch(`${base}/api/lunch?date=2026-10-01`, { headers: app })).status, 404);
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
  const { base } = await server(t, { LUNCH_URL: `http://127.0.0.1:${school.address().port}/?menu_no=34` });
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.lunch, true);

  const app = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/lunch?date=2026-10-01`)).status, 401);
  assert.equal((await fetch(`${base}/api/lunch?date=yesterday`, { headers: app })).status, 400);
  const day = await (await fetch(`${base}/api/lunch?date=2026-10-07`, { headers: app })).json();
  assert.deepEqual(day.meals[0].dishes, ['흰쌀밥', '콩나물국(0.5)', '안동찜닭', '시금치나물', '배추김치', '용과']);
  assert.deepEqual((await (await fetch(`${base}/api/lunch?date=2026-10-04`, { headers: app })).json()).meals, []);
  assert.deepEqual(asked, ['/?menu_no=34&ChangeDate=2026-10-1']);
});

test('the inbox for Claude: queued by the app, answered with the token, applied and acknowledged', async t => {
  const { base, dataDir } = await server(t, {});
  const app = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  const post = (p, body, headers = app) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });

  const { token } = await (await post('/api/account/claude-token', {})).json();
  assert.match(token, /^gplanc_/);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8').includes(token), 'db.json holds no usable token');
  assert.deepEqual((await (await fetch(`${base}/api/config`, { headers: app })).json()).claude, { linked: true });
  const claude = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  assert.equal((await post('/api/inbox', { id: 'm0001', date: '2026-10-27', slot: 'd', text: '꿔바로우' }, { ...app, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/inbox', { id: 'm0001', date: '2026-10-27', slot: 'd', mealId: 'meal-1', text: '꿔바로우 반 접시', photo: 'data:image/jpeg;base64,AAAA' })).status, 200);
  assert.equal((await (await fetch(`${base}/api/account/claude-token`, { headers: app })).json()).pending, 1);

  assert.equal((await fetch(`${base}/api/claude/inbox`, { headers: { authorization: 'Bearer gplanc_wrong' } })).status, 401);
  const pending = (await (await fetch(`${base}/api/claude/inbox`, { headers: claude })).json()).entries;
  assert.deepEqual(pending.map(e => [e.id, e.text, !!e.photo]), [['m0001', '꿔바로우 반 접시', true]]);
  assert.equal((await post('/api/claude/result', { id: 'm0001', items: [{ name: '꿔바로우', amount: '1/2접시', kcal: 260, p: 9, c: 30, f: 11 }] }, claude)).status, 200);
  assert.equal((await post('/api/claude/foods', { foods: [{ name: '꿔바로우', g: 200, kcal: 520, p: 18, c: 60, f: 22 }] }, claude)).status, 200);

  const back = (await (await fetch(`${base}/api/inbox`, { headers: app })).json()).entries;
  assert.deepEqual(back.map(e => [e.status, e.result.kcal, e.hasPhoto]), [['done', 260, false]]);
  assert.deepEqual((await (await fetch(`${base}/api/foods`, { headers: app })).json()).foods.map(f => f.name), ['꿔바로우']);
  assert.equal((await (await post('/api/inbox/ack', { ids: ['m0001'] })).json()).removed, 1);
  assert.deepEqual((await (await fetch(`${base}/api/inbox`, { headers: app })).json()).entries, []);

  assert.equal((await fetch(`${base}/api/account/claude-token`, { method: 'DELETE', headers: app })).status, 200);
  assert.equal((await fetch(`${base}/api/claude/foods`, { headers: claude })).status, 401);
});
