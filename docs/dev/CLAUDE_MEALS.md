# Claude works out the meals

G-PLAN counts a meal the moment it is written, from its own food table
(`frontend/src/lib/foods.js`). What the table cannot settle — a dish it does not have, a photo —
also goes into an **inbox**. A Claude Code session, scheduled on the owner's own Claude account
(no API key, no paid API), reads that inbox a few times a day, works the nutrition out, writes the
answer back and adds each new food to a **dataset**. The app replaces the table's numbers with the
answer, and looks the dataset up before its own table, so a food worked out once is counted
instantly afterwards. The same session reads the school lunch menu and the tray photos the school
posts, and adds the dishes the table does not know.

```
G-PLAN app ── POST /api/inbox ──▶ server inbox ◀── GET /api/claude/inbox ── scheduled Claude
   ▲  meal logged at once,          (pending)       POST /api/claude/result     session
   │  marked "waiting for Claude"                   POST /api/claude/foods        │
   └── GET /api/inbox, /api/foods ◀── answers + dataset ◀─────────────────────────┘
```

Code: `api/claude-inbox.js` (validation, token, dataset merge), the routes in `api/server.js` and
`cloudflare/api.js`, `frontend/src/lib/inbox.js` and `components/GplanFood.jsx` (the app side),
`components/ClaudeLink.jsx` (Settings), `scripts/gplan-claude.mjs` (the session's side).

## Setting it up

1. Deploy a build that has the inbox (this branch merged, then the Worker deployed).
2. In G-PLAN: Settings → **Claude works out meals** → *Make a token for Claude*. The token is
   shown once; the server keeps only its hash. A new token ends the old one.
3. In Claude Code on claude.ai: open the environment the scheduled sessions run in (the
   environment menu in a session's title bar → Edit) and add a secret or environment variable
   `GPLAN_CLAUDE_TOKEN` with the token as its value. Never paste the token into a chat.
4. The scheduled task (a fresh session a few times a day) runs the procedure below. Optional
   variables: `GPLAN_URL` (default `https://getyourmuscle.yangchanhee11.workers.dev`),
   `GPLAN_TZ` (default `Asia/Ho_Chi_Minh`), `LUNCH_URL` (default the school's 식단표 page).

The token reads the inbox and the dataset and writes answers and foods — nothing else: no
workouts, no body data, no account. Revoking it in Settings stops the job at its next run.

## The procedure, for the scheduled session

Run from the repository root. Every command prints JSON; a problem is one line on stderr and a
non-zero exit. If `scripts/gplan-claude.mjs` is missing, fetch the branch that has it
(`git fetch origin claude/nifty-dirac-skka4d && git checkout claude/nifty-dirac-skka4d`).

### 1. Check, and stop early when there is nothing to do

```bash
node scripts/gplan-claude.mjs check
```

- exit 2: the token is missing or was revoked → stop and report that in one line.
- exit 3: the server cannot be reached, or runs a build without the inbox → stop and report.
- `waiting: 0` → skip to step 4 (the lunch).

### 2. Work out the waiting meals

```bash
node scripts/gplan-claude.mjs foods            # the dataset so far
node scripts/gplan-claude.mjs pull /tmp/gplan-inbox
```

Each entry has `text` (what the owner wrote, or what the calculator sent), `photo` (a local JPEG
path — look at it with the Read tool), `appEstimate` (what the app logged meanwhile) and `table`
(how the app's food table read the text: the row it matched, `how` it matched, servings and
numbers).

For each entry, list every dish actually eaten, with its amount and its kcal / protein / carbs /
fat **for that amount**:

- **Stay consistent with the table.** A dish the table matched `exact` (or `mine`, the dataset)
  keeps the table's per-serving numbers; change only the amount, when the text or the photo says
  so. The app shows these same numbers elsewhere, and the weekly weight check calibrates against
  them.
- **Work out the rest** from a typical Korean (or Vietnamese, for the city's dishes) recipe and
  portion: ingredients and their weights, then the sum. Check it against 4 / 4 / 9 kcal per gram
  of protein / carbs / fat (alcohol: 7 kcal/g, outside the macros). `similar` and `guess` rows
  are the table's guesses — correct them freely.
- **Amounts:** what is written wins over the photo. Without a word on it, judge from the photo
  (bowl and plate sizes, a 밥공기 is about 210 g of rice). Without either, one usual serving.
- **Shared tables:** text ending in `— N people at the table, my share P%` came from the
  calculator. Dishes marked `(Shared)` are the table's amount: count P% of them. Dishes without
  the mark were the owner's alone: count all of them. Pieces (`9점`, `3조각`) are what the owner
  ate. A photo of a table for several people with no such text: count one person's share and say
  so in the note.
- **Several photos or plates:** count every plate the text or photo shows.
- **Unclear photo:** still answer with the best estimate, and say what was assumed in the note.

Write the answers to a file and send them:

```json
[
  {
    "id": "mvq7th8yeske4",
    "items": [
      { "name": "훠궈", "amount": "1인분 (고기 150 g·채소·당면)", "kcal": 620, "p": 38, "c": 30, "f": 38 },
      { "name": "흰쌀밥", "amount": "1공기", "kcal": 310, "p": 6, "c": 68, "f": 1 }
    ],
    "note": "고기 양은 사진 기준 1인분으로 봄"
  }
]
```

```bash
node scripts/gplan-claude.mjs answer /tmp/gplan-answers.json
```

Names and amounts in Korean, the way the owner writes them (`1공기`, `1인분`, `9점`, `330 ml 1캔`);
`note` short, in Korean, only for an assumption worth knowing (at most 300 characters). An answer
has 1–30 items; the server adds up the totals. An entry whose meal was deleted meanwhile is
reported as skipped; the others still go.

### 3. Grow the dataset

Every dish worked out in step 2 that the table did not match `exact` goes into the dataset, **per
one usual serving**:

```json
{ "foods": [
  { "name": "훠궈", "cat": "stew", "g": 550, "kcal": 620, "p": 38, "c": 30, "f": 38, "note": "1인분, 고기·채소·당면" }
] }
```

```bash
node scripts/gplan-claude.mjs learn /tmp/gplan-foods.json
```

- `g` is the weight of that one serving, `cat` how the app portions it: `rice`, `noodle`, `soup`,
  `stew`, `main` (a protein dish), `side` (반찬), `kimchi`, `fruit`, `dairy`, `dessert`, `drink`,
  `free` (lettuce, plain vegetables). Left out, it is `main`.
- Never add a name the table already matches `exact`: the dataset is looked up first, so it would
  replace the table's row everywhere.
- The same name again replaces the earlier entry — correct a food by sending it again.

### 4. The school lunch

```bash
node scripts/gplan-claude.mjs lunch 7 /tmp/gplan-lunch
node scripts/gplan-claude.mjs lunch 3 /tmp/gplan-lunch 2026-10-13   # from a given day
```

For each school day: the dishes as the lunch sheet reads them, how the table matched each, the
`unknown` ones (not `exact` and not in the dataset), and `trayPhoto` — the school's own photo of
that day's tray, saved locally once the school has posted it (usually after the meal; look back a
few days for recent ones). For each unknown dish, work out one school serving — the tray photos
show the school's portions — and add it with step 3's format and the right `cat` (the lunch
planner raises protein dishes, keeps rice, trims dessert and starchy sides, so a 반찬 filed as
`main` would be portioned wrongly). Dishes from the self-serve counter (`extraCounter: true`) are
optional extras; work them out the same way. Nothing to send when no dish is unknown.

### 5. Finish

One short summary: meals answered, foods added, lunch days checked, anything that needs the
owner. The job changes nothing in the repository: no commits, no pull requests. Photos leave
the server once answered; the local copies go with the session.

## Limits

30 entries waiting per profile (a meal past that keeps the table's numbers), 20 handed out per
read; photos up
to 1 MB (the app sends a ~1024 px JPEG); 300 foods per `learn`, 2,000 in the dataset (the
oldest drop first); 60 inbox writes an hour from the app.
