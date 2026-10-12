// Apple Health sync bookkeeping (health.js): the token, and what a Shortcut may send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueHealthToken, revokeHealthToken, findHealthUser, parseIngest, mergeIngest, daysFrom, HEALTH_KEEP_DAYS } from '../health.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');

test('a token is returned once, stored as a hash, and finds its profile', () => {
  const a = { id: 'a' }, b = { id: 'b' };
  const tok = issueHealthToken(a, NOW);
  assert.match(tok, /^gymh_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(a).includes(tok.slice(5)), 'the token itself is not stored');
  assert.equal(findHealthUser([a, b], tok), a);
  assert.equal(findHealthUser([a, b], tok + 'x'), null);
  assert.equal(findHealthUser([a, b], 'gymh_wrong'), null);
  assert.equal(findHealthUser([a, b], null), null);
});

test('a new token replaces the old one, and a revoked or disabled one finds nobody', () => {
  const u = { id: 'u' };
  const first = issueHealthToken(u, NOW);
  const second = issueHealthToken(u, NOW);
  assert.equal(findHealthUser([u], first), null);
  assert.equal(findHealthUser([u], second), u);
  u.disabled = true;
  assert.equal(findHealthUser([u], second), null);
  delete u.disabled;
  assert.equal(revokeHealthToken(u), true);
  assert.equal(findHealthUser([u], second), null);
  assert.equal(revokeHealthToken(u), false);
});

test('ingest: numbers, numeric strings, decimal commas, units and fractions', () => {
  assert.deepEqual(parseIngest({ date: '2026-10-13', dist: 7.844, steps: 10312.4, activeKcal: '612' }, NOW),
    { date: '2026-10-13', values: { distKm: 7.84, steps: 10312, activeKcal: 612 } });
  assert.deepEqual(parseIngest({ date: '2026-10-13', dist: '5,25' }, NOW).values, { distKm: 5.25 });
  assert.deepEqual(parseIngest({ date: '2026-10-13', dist: 4200, unit: 'm' }, NOW).values, { distKm: 4.2 });
  assert.deepEqual(parseIngest({ date: '2026-10-13', dist: 3, unit: 'mi' }, NOW).values, { distKm: 4.83 });
  assert.deepEqual(parseIngest({ date: '2026-10-13', weight: 78.64, bodyFat: 0.219 }, NOW).values, { weight: 78.6, bodyFat: 21.9 });
  assert.deepEqual(parseIngest({ date: '2026-10-13', bodyFat: 21.9 }, NOW).values, { bodyFat: 21.9 });
  // An empty field from a Shortcut whose Health had nothing is skipped, not refused.
  assert.deepEqual(parseIngest({ date: '2026-10-13', dist: 6, weight: '' }, NOW).values, { distKm: 6 });
});

test('ingest refuses bad dates, garbage and empty bodies', () => {
  const err = b => parseIngest(b, NOW).error;
  assert.ok(err({ dist: 5 }));
  assert.ok(err({ date: '13.10.2026', dist: 5 }));
  assert.ok(err({ date: '2026-02-30', dist: 5 }));
  assert.ok(err({ date: '2026-08-01', dist: 5 }), 'more than 31 days old');
  assert.ok(err({ date: '2026-10-16', dist: 5 }), 'in the future');
  assert.ok(err({ date: '2026-10-13' }), 'nothing to save');
  assert.ok(err({ date: '2026-10-13', dist: 'lots' }));
  assert.ok(err({ date: '2026-10-13', dist: -1 }));
  assert.ok(err({ date: '2026-10-13', dist: 500 }));
  assert.ok(err({ date: '2026-10-13', dist: 5, unit: 'furlong' }));
  assert.ok(err({ date: '2026-10-13', steps: 1e7 }));
  assert.ok(err({ date: '2026-10-13', weight: 5 }));
  assert.ok(err({ date: '2026-10-13', bodyFat: 95 }));
  assert.ok(err({ date: '2026-10-13', dist: { toString: 1 } }));
});

test('a later sync replaces the fields it sends and keeps the rest', () => {
  let doc = mergeIngest({ days: {} }, '2026-10-13', { distKm: 3, steps: 4000, weight: 79 }, 1);
  doc = mergeIngest(doc, '2026-10-13', { distKm: 8.1, steps: 10500 }, 2);
  assert.deepEqual(doc.days['2026-10-13'], { distKm: 8.1, steps: 10500, weight: 79, at: 2 });
});

test('only the newest days are kept, and daysFrom reads from a date on', () => {
  let doc = { days: {} };
  const start = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < HEALTH_KEEP_DAYS + 5; i++) doc = mergeIngest(doc, new Date(start + i * 86400000).toISOString().slice(0, 10), { steps: i }, i);
  const keys = Object.keys(doc.days).sort();
  assert.equal(keys.length, HEALTH_KEEP_DAYS);
  assert.equal(doc.days[keys[0]].steps, 5);
  const last3 = daysFrom(doc, keys[keys.length - 3]);
  assert.deepEqual(Object.keys(last3).sort(), keys.slice(-3));
  assert.equal(Object.keys(daysFrom(null, '')).length, 0);
});
