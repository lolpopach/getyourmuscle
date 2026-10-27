// Apple Health sync bookkeeping (health.js): the token, and what a Shortcut may send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueHealthToken, revokeHealthToken, findHealthUser, ingestToken, todayIn, parseIngest, mergeIngest, failedIngest, daysFrom, HEALTH_KEEP_DAYS } from '../health.js';

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
  assert.ok(err({ date: '13.10.2026', dist: 5 }));
  assert.ok(err({ date: 'today', dist: 5 }));
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
  assert.deepEqual(doc.last, { at: 2, date: '2026-10-13' });
});

// The five-action Shortcut (Settings → Apple Health sync): the token in the address, no date,
// and whatever "Calculate Statistics" — or its absence — hands over.
test('the token comes from the header or from the address', () => {
  assert.equal(ingestToken('Bearer gymh_a', new URLSearchParams('key=gymh_b')), 'gymh_a');
  assert.equal(ingestToken(undefined, new URLSearchParams('key=gymh_b&tz=Asia%2FSeoul')), 'gymh_b');
  assert.equal(ingestToken('', new URLSearchParams('')), '');
  assert.equal(ingestToken('Basic x', null), '');
});

test('without a date, the day is today in the time zone the address names', () => {
  const late = Date.parse('2026-10-13T18:30:00Z');   // 01:30 the next day in Ho Chi Minh City
  assert.equal(todayIn('Asia/Ho_Chi_Minh', late), '2026-10-14');
  assert.equal(todayIn('', late), '2026-10-13');
  assert.equal(todayIn('Not/AZone', late), '2026-10-13');
  assert.equal(parseIngest({ steps: 9300 }, late, { tz: 'Asia/Ho_Chi_Minh' }).date, '2026-10-14');
  assert.equal(parseIngest({ steps: 9300, date: '' }, NOW).date, '2026-10-13');
  // A date that is sent is still read, in the shapes Shortcuts tends to produce.
  assert.equal(parseIngest({ steps: 1, date: '2026. 10. 12.' }, NOW).date, '2026-10-12');
  assert.equal(parseIngest({ steps: 1, date: '2026-10-12T21:30:00+07:00' }, NOW).date, '2026-10-12');
});

test('values as text: units, digit grouping, decimal commas, and lists are summed', () => {
  const v = b => parseIngest({ date: '2026-10-13', ...b }, NOW).values;
  assert.deepEqual(v({ steps: '9,300', dist: '6.4 km' }), { steps: 9300, distKm: 6.4 });
  assert.deepEqual(v({ steps: '9.300', dist: '6,4' }), { steps: 9300, distKm: 6.4 });   // Vietnamese-style region
  assert.deepEqual(v({ steps: '9 300 걸음', activeKcal: '1,204 kcal' }), { steps: 9300, activeKcal: 1204 });
  assert.deepEqual(v({ dist: '1,234.5 m' }), { distKm: 1.23 });
  assert.deepEqual(v({ dist: '4200 m' }), { distKm: 4.2 });
  assert.deepEqual(v({ dist: '3 mi' }), { distKm: 4.83 });
  assert.deepEqual(v({ dist: '2,5 킬로미터' }), { distKm: 2.5 });
  assert.deepEqual(v({ steps: [1200, '3,400', 500], dist: [1.2, '2,3'] }), { steps: 5100, distKm: 3.5 });
  const err = b => parseIngest({ date: '2026-10-13', ...b }, NOW).error;
  assert.ok(err({ steps: '6.4 km 3' }));
  assert.ok(err({ steps: [] }));
  assert.ok(err({ steps: [1, 'x'] }));
  assert.ok(err({ dist: '4200 m', unit: 'km' }), 'a unit field wins over the text');
});

test('a call that saved nothing keeps the days and says why', () => {
  const doc = mergeIngest({ days: {} }, '2026-10-13', { steps: 4000 }, 1);
  const failed = failedIngest(doc, 'steps out of range', 2);
  assert.deepEqual(failed, { days: doc.days, last: { at: 2, error: 'steps out of range' } });
  assert.deepEqual(failedIngest(null, 'invalid json', 3), { days: {}, last: { at: 3, error: 'invalid json' } });
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
