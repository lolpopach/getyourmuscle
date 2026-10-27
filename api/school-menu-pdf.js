/* The school's monthly menu PDF, read into days and dishes (docs/dev/CLAUDE_MEALS.md §4).
 *
 * The school's 식단표 calendar page (school-lunch.js) is filled in as the month goes, often
 * weeks late. The whole month is out ahead of time on another board, 급식소식 (?menu_no=102):
 * one post per month, "2026학년도 10월 학교급식 식단표", with the menu as a one-page PDF calendar
 * — the lunch, and a second PDF for the dinner (석식). Neither server reads PDFs: the scheduled
 * Claude session does, with poppler's `pdftotext -bbox`, checks the result against the PDF itself
 * and sends it (POST /api/claude/lunch). This module is the reading: the board, the post, and
 * the words of a page put back into their calendar cells. Pure; scripts/gplan-claude.mjs fetches.
 *
 * A cell is the area under a day's heading ("26(월)") down to the next row of headings, between
 * the middles of its neighbouring columns. In it every line is a dish, followed by its allergy
 * codes ("순두부찌개 1.5.18", or the codes alone on the next line), which are dropped. A cell ends
 * at the first wide gap — the notice box under the last week ("※ 위 식단은 …") is not a dish. A
 * day with fewer than three dishes left is no school day (한글날, 재량 휴업일). */

export const DEFAULT_MENU_BOARD = 'http://kshcm.net/?menu_no=102';
// The school's firewall turns away a bare "Mozilla/5.0"; it lets a named reader through.
export const USER_AGENT = 'G-PLAN lunch reader';

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITY[e.toLowerCase()] ?? m;
});

/** The board's posts that are a month's menu: [{ bno, months: [10] or [7, 8], posted, href }]. */
export function parseMenuBoard(html, base = DEFAULT_MENU_BOARD) {
  const out = [];
  for (const row of html.split(/<tr\b/i).slice(1)) {
    const a = /<a[^>]+href="([^"]*board_mode=view[^"]*bno=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!a) continue;
    const title = unescape(a[3].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!/식단/.test(title) || /석식/.test(title)) continue;
    const head = title.split(/식단/)[0];
    const months = [...head.matchAll(/(\d{1,2})\s*월/g)].map(m => +m[1]).filter(m => m >= 1 && m <= 12);
    if (!months.length) continue;
    const posted = (/(\d{4}-\d{2}-\d{2})/.exec(row.replace(a[0], '')) || [])[1] || null;
    out.push({ bno: +a[2], title, months, posted, href: new URL(unescape(a[1]), base).href });
  }
  return out;
}

/**
 * The PDFs attached to a post: [{ name, url, dinner }]. `latin1` is the page decoded byte for
 * byte (the file names are EUC-KR, and the link has to carry those bytes, percent-encoded).
 */
export function pdfLinks(latin1, base = DEFAULT_MENU_BOARD) {
  const seen = new Set();
  const out = [];
  for (const m of latin1.matchAll(/href="([^"]*_downLoad\.asp\?dfname=([^"]+?\.pdf))"/gi)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const bytes = Buffer.from(m[2], 'latin1');
    const encoded = [...bytes].map(b => (b < 0x80 && /[A-Za-z0-9._~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
    const name = new TextDecoder('euc-kr').decode(bytes);
    out.push({ name, dinner: /석식/.test(name), url: new URL(m[1].split('dfname=')[0] + 'dfname=' + encoded, base).href });
  }
  return out;
}

/** `pdftotext -bbox` output → pages of words: [[{ x0, y0, x1, y1, text }]]. */
export function parseBbox(html) {
  return html.split(/<page\b/).slice(1).map(page => [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    .map(m => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: unescape(m[5]) })));
}

const DAY = /^(\d{1,2})\((월|화|수|목|금|토|일)\)$/;
const WEEKDAY = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
// A line that is a notice, not a dish.
const NOTICE = /[♥♡★☆※◆◇■□●]|휴업|휴일|휴무|방학|공휴일|기념일|한글날|개천절|현충일|광복절|어린이날|추석|설날|성탄|재량|졸업|입학|시험/;
const ALLERGY = /^[\d.,]+$/;
// Dish lines sit about 12 pt apart (6 with the codes between them); the notice box under the last
// week is 30 pt below its last dish.
const CELL_GAP = 20;

// Values within `gap` of each other are one: the columns' centres, the rows' tops.
function clusters(values, gap) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length && v - out.at(-1).at(-1) <= gap) out.at(-1).push(v);
    else out.push([v]);
  }
  return out.map(c => c.reduce((a, b) => a + b, 0) / c.length);
}
const nearest = (list, v) => list.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(list[best] - v) ? i : best), 0);

/** A dish line as the lunch sheet reads it: allergy codes off, "-추가배식대" as the board writes it. */
export function cleanDish(line) {
  const s = line.split(/\s+/).filter(w => w && !ALLERGY.test(w)).join(' ')
    .replace(/\s*[-–]\s*(추가\s*배식대.*)$/, '($1)')
    .trim();
  return s.slice(0, 80);
}

/**
 * One page's words → { month: 'YYYY-MM' | null, days: { 'YYYY-MM-DD': [dish, …] } }. The month is
 * the page's "10월"; the year the one, around `near` (a 'YYYY-MM-DD', the post's date), whose
 * calendar puts every heading on its weekday — a page that fits no year gives no month.
 */
export function parseMenuPdfPage(words, near) {
  const heads = words.map(w => ({ w, m: DAY.exec(w.text) })).filter(x => x.m).map(({ w, m }) => ({ ...w, day: +m[1], wd: WEEKDAY[m[2]] }));
  const monthWord = words.find(w => /^\d{1,2}월$/.test(w.text) && w.y0 < Math.min(...heads.map(h => h.y0), Infinity));
  if (!heads.length || !monthWord) return { month: null, days: {} };
  const mon = parseInt(monthWord.text, 10);
  const ref = +String(near || '').slice(0, 4) || new Date().getUTCFullYear();
  const year = [ref, ref + 1, ref - 1].find(y => heads.every(h => new Date(Date.UTC(y, mon - 1, h.day)).getUTCDay() === h.wd && new Date(Date.UTC(y, mon - 1, h.day)).getUTCMonth() === mon - 1));
  if (!year) return { month: null, days: {} };
  const month = `${year}-${String(mon).padStart(2, '0')}`;

  const cols = clusters(heads.map(h => (h.x0 + h.x1) / 2), 20);
  const rows = clusters(heads.map(h => h.y0), 5);
  const cells = new Map();   // 'row:col' → heading
  for (const h of heads) cells.set(`${nearest(rows, h.y0)}:${nearest(cols, (h.x0 + h.x1) / 2)}`, { ...h, words: [] });
  const isHead = new Set(heads.map(h => `${h.x0}:${h.y0}`));
  for (const w of words) {
    if (isHead.has(`${w.x0}:${w.y0}`)) continue;
    const cy = (w.y0 + w.y1) / 2;
    const r = rows.findLastIndex(top => top < cy);
    if (r < 0) continue;
    const cell = cells.get(`${r}:${nearest(cols, (w.x0 + w.x1) / 2)}`);
    // Below its heading, and not out past the last column's reach (the legend, the margins).
    if (!cell || w.y0 < cell.y1) continue;
    const c = nearest(cols, (w.x0 + w.x1) / 2);
    const half = cols.length > 1 ? Math.min(...cols.slice(1).map((x, i) => x - cols[i])) / 2 : Infinity;
    if (Math.abs((w.x0 + w.x1) / 2 - cols[c]) > half) continue;
    cell.words.push(w);
  }
  const days = {};
  for (const cell of cells.values()) {
    const lines = [];
    for (const w of cell.words.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      const line = lines.find(l => Math.abs(l.y - w.y0) < 3);
      if (line) { line.words.push(w); continue; }
      if (lines.length && w.y0 - lines.at(-1).y > CELL_GAP) break;
      lines.push({ y: w.y0, words: [w] });
    }
    const dishes = lines.map(l => l.words.sort((a, b) => a.x0 - b.x0).map(w => w.text).join(' '))
      .filter(l => !NOTICE.test(l)).map(cleanDish).filter(Boolean);
    if (dishes.length >= 3) days[`${month}-${String(cell.day).padStart(2, '0')}`] = dishes.slice(0, 30);
  }
  return { month, days };
}
