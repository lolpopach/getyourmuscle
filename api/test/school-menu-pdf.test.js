// The school's monthly menu PDF (school-menu-pdf.js): the board's posts, a post's attachments, and
// the calendar read back out of the PDF's words — against the school's real October 2026 pages
// and the words `pdftotext -bbox` gives for its real lunch PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMenuBoard, pdfLinks, parseBbox, parseMenuPdfPage, cleanDish } from '../school-menu-pdf.js';
import { decodePage } from '../school-lunch.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = f => fs.readFileSync(path.join(FIX, f));

test('the board: one post per month, 7월, 8월 as two months, dated', () => {
  const posts = parseMenuBoard(decodePage(read('kshcm-menu-board.html')));
  assert.deepEqual(posts.slice(0, 3).map(p => [p.bno, p.months, p.posted]), [[89, [10], '2026-09-29'], [88, [9], '2026-08-26'], [87, [7, 8], '2026-06-25']]);
  assert.equal(posts[0].href, 'http://kshcm.net/default.asp?board_mode=view&menu_no=102&bno=89&issearch=&keyword=&keyfield=&page=1');
  assert.ok(posts.every(p => p.months.length));
});

test('a post: the lunch PDF and the dinner one, their EUC-KR names percent-encoded', () => {
  const links = pdfLinks(read('kshcm-menu-post.html').toString('latin1'));
  assert.deepEqual(links.map(l => [l.name, l.dinner]), [['2026학년도10월식단표(최종-알레르기표기).pdf', false], ['2026학년도10월석식식단표(최종-알레르기표기).pdf', true]]);
  assert.equal(links[0].url, 'http://kshcm.net/_downLoad.asp?dfname=2026%C7%D0%B3%E2%B5%B510%BF%F9%BD%C4%B4%DC%C7%A5%28%C3%D6%C1%BE-%BE%CB%B7%B9%B8%A3%B1%E2%C7%A5%B1%E2%29.pdf');
});

test('the PDF: every school day, no allergy codes, no legend, notices or holidays', () => {
  const [page] = parseBbox(read('kshcm-lunch-2026-10.bbox.html').toString('utf8'));
  const { month, days } = parseMenuPdfPage(page, '2026-09-29');
  assert.equal(month, '2026-10');
  // 1–2, 5–8, 12–16 and 26–30: 9 Oct is 한글날, 19–23 a school break.
  assert.deepEqual(Object.keys(days).sort(), ['01', '02', '05', '06', '07', '08', '12', '13', '14', '15', '16', '26', '27', '28', '29', '30'].map(d => '2026-10-' + d));
  assert.deepEqual(days['2026-10-01'], ['흰쌀밥', '순두부찌개', '소불고기', '치즈계란말이*케찹', '열무김치', '파인애플']);
  // A day's "분식데이" banner is not a dish.
  assert.deepEqual(days['2026-10-08'], ['햄계란볶음밥', '미니어묵우동', '돈까스*브라운소스', '매콤떡볶이', '깍두기', '순대찜*소금']);
  assert.ok(days['2026-10-13'].includes('상추쌈(추가배식대)'));
  // The last week — on the PDF only, not yet on the calendar page — without the notice box below it.
  assert.deepEqual(days['2026-10-26'], ['흰쌀밥', '돈육콩비지찌개', '치즈함박카츠*브라운S', '불어묵조림', '깍두기', '버터떡']);
  assert.deepEqual(days['2026-10-30'], ['흰쌀밥', '돼지국밥*소면', '순대야채볶음', '감자채볶음', '깍두기', '타코야끼']);
});

test('the year is the one whose calendar fits the page, and a page that fits none gives nothing', () => {
  const [page] = parseBbox(read('kshcm-lunch-2026-10.bbox.html').toString('utf8'));
  // Posted at the turn of the year, the menu is still October 2026's: 1 Oct is a Thursday only then.
  assert.equal(parseMenuPdfPage(page, '2027-01-02').month, '2026-10');
  assert.equal(parseMenuPdfPage(page, '2031-05-01').month, null);
  assert.deepEqual(parseMenuPdfPage([], '2026-09-29'), { month: null, days: {} });
});

test('a dish line', () => {
  assert.equal(cleanDish('순두부찌개 1.5.18'), '순두부찌개');
  assert.equal(cleanDish('상추쌈-추가배식대'), '상추쌈(추가배식대)');
  assert.equal(cleanDish('바나나1/2'), '바나나1/2');
  assert.equal(cleanDish('1.2.12'), '');
});
