// Apple Health sync end to end: the signed-in app issues a token, the Shortcut posts with it,
// the app reads the days back, and a revoked token is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'test-secret-health';
const uid = 'u_health_1';
const cookie = () => { const p = `${uid}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };
const today = () => new Date().toISOString().slice(0, 10);

test('issue a token, ingest with it, read the days back, revoke', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-health-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: uid, name: 'H', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;

  const app = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/account/health-token`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/account/health-token`, { headers: app })).json(), { active: false, created: null, lastSync: null, last: null });

  // Issuing from another site is refused like any other cookie-authenticated change.
  const forged = await fetch(`${base}/api/account/health-token`, { method: 'POST', headers: { ...app, origin: 'https://evil.example' } });
  assert.equal(forged.status, 403);

  const issued = await (await fetch(`${base}/api/account/health-token`, { method: 'POST', headers: app })).json();
  assert.match(issued.token, /^gymh_/);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8').includes(issued.token), 'db.json holds no usable token');

  // The Shortcut: no cookie, no Origin, just the token.
  const shortcut = { authorization: 'Bearer ' + issued.token, 'content-type': 'application/json' };
  const ok = await fetch(`${base}/api/health/ingest`, { method: 'POST', headers: shortcut, body: JSON.stringify({ date: today(), dist: '7,84', steps: 10312, activeKcal: 612 }) });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).saved.distKm, 7.84);

  const bad = await fetch(`${base}/api/health/ingest`, { method: 'POST', headers: shortcut, body: JSON.stringify({ date: today(), dist: 'far' }) });
  assert.equal(bad.status, 400);
  assert.equal((await (await fetch(`${base}/api/account/health-token`, { headers: app })).json()).last.error, 'dist must be a number');

  // The five-action Shortcut: the token in the address, no header, no date, a Form body by mistake.
  const at = `${base}/api/health/ingest?key=${issued.token}&tz=UTC`;
  const form = await fetch(at, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'steps=1' });
  assert.equal(form.status, 400);
  assert.equal((await (await fetch(`${base}/api/account/health-token`, { headers: app })).json()).last.error, 'invalid json');
  const keyed = await fetch(at, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: '10,312', dist: '7.84 km' }) });
  assert.equal(keyed.status, 200);
  assert.equal((await keyed.json()).date, today());

  // The token is not a session: it reads nothing.
  assert.equal((await fetch(`${base}/api/data`, { headers: shortcut })).status, 401);
  assert.equal((await fetch(`${base}/api/health/daily`, { headers: shortcut })).status, 401);

  const daily = await (await fetch(`${base}/api/health/daily?from=${today()}`, { headers: app })).json();
  assert.equal(daily.days[today()].steps, 10312);
  assert.equal(daily.days[today()].activeKcal, 612);
  const st = await (await fetch(`${base}/api/account/health-token`, { headers: app })).json();
  assert.equal(st.active, true);
  assert.ok(st.lastSync > 0);

  assert.equal((await fetch(`${base}/api/account/health-token`, { method: 'DELETE', headers: app })).status, 200);
  const after = await fetch(`${base}/api/health/ingest`, { method: 'POST', headers: shortcut, body: JSON.stringify({ date: today(), dist: 9 }) });
  assert.equal(after.status, 401);
  assert.equal((await fetch(`${base}/api/health/ingest`, { method: 'POST', body: '{}' })).status, 401);
});
