// The starter-plan catalog. Training data only: the chooser's plan names and descriptions are
// written as string literals inside t() calls in sheets.jsx, because check-source-strings.mjs
// only finds them there — copy parked in here would silently ship English in every language.
//
// A routine is [key, name, emoji, [[exerciseId, sets, reps], …]]. The key is what a plan's
// schedule points at, so a weekday never depends on the position of a routine in the array.
// Names stay canonical English — they become ordinary user routines, which are not translated.
import { uid } from './format.js'

const PPL = [
  ['push', 'Push Day', 'barbell', [['0025', 4, 8], ['0047', 3, 10], ['0426', 3, 10], ['0334', 3, 12], ['0241', 3, 12], ['0251', 3, 10]]],
  ['pull', 'Pull Day', 'pullup', [['2330', 4, 10], ['0027', 4, 8], ['1323', 3, 10], ['0031', 3, 10], ['0313', 3, 12]]],
  ['legs', 'Leg Day', 'legs', [['0043', 4, 8], ['0085', 3, 10], ['0739', 3, 12], ['0585', 3, 12], ['0586', 3, 12], ['0605', 4, 15]]]
]

const UPPER_LOWER = [
  ['upper-a', 'Upper A', 'barbell', [['0025', 3, 8], ['2330', 3, 10], ['0047', 2, 10], ['1323', 2, 10], ['0334', 2, 12], ['0241', 2, 12], ['0031', 2, 12]]],
  ['lower-a', 'Lower A', 'legs', [['0043', 3, 8], ['0085', 3, 8], ['0739', 2, 10], ['0586', 2, 12], ['0605', 3, 15]]],
  ['upper-b', 'Upper B', 'barbell', [['0047', 3, 8], ['0027', 3, 8], ['0426', 2, 10], ['2330', 2, 10], ['0334', 2, 12], ['0241', 2, 12], ['0313', 2, 12]]],
  ['lower-b', 'Lower B', 'legs', [['0739', 3, 10], ['0085', 2, 10], ['0585', 2, 12], ['0586', 3, 12], ['0605', 3, 15]]]
]

const FULL_BODY = [
  ['fb-a', 'Full Body A', 'figureStrength', [['0043', 3, 8], ['0025', 3, 8], ['2330', 3, 10], ['0586', 3, 12], ['0334', 2, 12], ['0031', 2, 12]]],
  ['fb-b', 'Full Body B', 'figureStrength', [['0085', 3, 8], ['0047', 3, 10], ['1323', 3, 10], ['0585', 3, 12], ['0334', 2, 12], ['0241', 2, 12]]],
  ['fb-c', 'Full Body C', 'figureStrength', [['0739', 3, 10], ['0025', 2, 10], ['0027', 3, 10], ['0426', 2, 10], ['0586', 3, 12], ['0605', 3, 15]]]
]

const FIVE_BY_FIVE = [
  ['5x5-a', '5×5 A', 'barbell', [['0043', 5, 5], ['0025', 5, 5], ['0027', 5, 5]]],
  ['5x5-b', '5×5 B', 'barbell', [['0085', 5, 5], ['0426', 5, 5], ['2330', 5, 5]]],
  ['5x5-c', '5×5 C', 'barbell', [['0739', 5, 5], ['0047', 5, 5], ['1323', 5, 5]]]
]

// G-PLAN's own plan (docs/dev/GETYOURMUSCLE_PLAN.md §2.4.0): a lean, solid build while cutting
// slowly. The goal above all is broad shoulders and a wide frame (the user, 2026-10-30), so the
// side delts and the lats come first: laterals on every training day, early in the session on
// Monday and Friday, and a one-arm cable pulldown beside the pulldown (the user's pick: the
// longest lat stretch, one side at a time, so the smaller left side sets the reps). Four days: chest and shoulders, a leg
// day, back, and a day for arms, with the weekend free for football. Written out in full, the
// way the plan prescribes it, so a loaded routine needs no editing before the first session:
//   - a rep range per exercise under double progression (the routine's `prog`): reps climb to
//     the top of the range at one weight, then the weight goes up and reps go back to the bottom
//   - the rest the plan asks for: 2–3 min on the big lifts, 60–90 s on the small ones
//   - two warm-up sets on each day's first lift (Friday's dips are bodyweight: its note says
//     how to warm up instead)
//   - the plan's cues as notes (the left arm is ~5 % smaller, so it sets the reps)
//   - the incline treadmill walk after weights every session, toward the day's steps
//   - the gym's machines where they do the job as well: a chest press for the flat press, the
//     pec deck for a second fly, a reverse pec deck for the rear delts (Advanced Fitness,
//     2026-10-27)
// Monday is the chest day (the user's call: the presses and both flies together), with
// Friday's dips as the chest's second day. One leg day: two left the user too sore for the
// upper-body days (2026-10-30). It sits on Tuesday, so the legs are recovered for weekend
// football, and the arm day on Friday, so Monday starts after two days off (both their calls).
// The back day follows the leg day, so its row is chest-supported: sore hamstrings and lower back
// stay out of it. Biceps Wednesday and Friday, triceps and chest Monday and Friday, so nothing is
// trained two days running. Weekly sets: side delts 16, lats 7 (back 13 with the rows), rear
// delts 6, chest 16 (Monday 13, upper 7), biceps 12, triceps 12 counting dips, quads 8,
// hamstrings 6.
const LEFT_SETS = '왼팔이 멈추면 그 세트는 끝'
const SMALL_LAST = '반동 없이 · 마지막 세트는 실패 직전까지'
// [id, sets, [bottom, top], rest seconds, extra fields]
const lift = (id, sets, [repsMin, reps], restSec, more) => ({ id, sets, reps, repsMin, weight: 0, restSec, ...more })
const first = { warmupSets: 2 }
const inclineWalk = { id: '3666', sets: 1, min: 20, speed: 5, note: '경사 10~12% · 하루 걸음 수 채우기' }

const GPLAN_SOLID = [
  ['g-upper-a', '상체 A · 가슴 어깨', 'barbell', [
    lift('0314', 4, [8, 10], 150, { ...first, note: LEFT_SETS }),   // dumbbell incline press
    lift('0577', 3, [8, 10], 120, { note: '손잡이가 가슴 가운데 높이에 오게 의자 조절' }),  // machine chest press
    lift('0405', 3, [8, 10], 120, { note: LEFT_SETS }),             // seated dumbbell shoulder press
    lift('0334', 4, [12, 15], 75, { note: SMALL_LAST }),            // dumbbell lateral raise
    lift('0179', 3, [12, 15], 75, { note: '아래에서 위로 — 윗가슴' }),  // low-to-high cable fly
    lift('0596', 3, [12, 15], 75, { note: '가슴 펴고, 손잡이를 모은 끝에서 1초 쥐어짜기' }),  // pec deck (chest fly machine)
    lift('0194', 3, [10, 12], 75),                                  // overhead rope triceps extension
    inclineWalk
  ]],
  // The one leg day: squat, hinge, press, curl and extension, 3 sets for the big lifts — enough to
  // keep and slowly build the legs through the cut without a week of soreness. The seated curl
  // trains the hamstrings at a long length; the laterals ride along for the side delts.
  ['g-lower', '하체 · 스쿼트', 'legs', [
    lift('0043', 3, [6, 8], 180, first),                            // barbell squat
    lift('0085', 3, [8, 10], 150, { note: '엉덩이를 뒤로 빼며 허벅지 뒤가 당기는 데까지만 내리기' }),  // Romanian deadlift
    lift('0739', 3, [10, 12], 120),                                 // leg press
    lift('0599', 3, [10, 12], 75),                                  // seated leg curl
    lift('0585', 2, [12, 15], 60),                                  // leg extension
    lift('0334', 4, [12, 15], 60, { note: SMALL_LAST }),            // dumbbell lateral raise
    lift('0594', 3, [12, 15], 60),                                  // seated calf raise
    lift('0472', 3, [10, 12], 60),                                  // hanging leg raise
    inclineWalk
  ]],
  ['g-upper-b', '상체 B · 등', 'pullup', [
    lift('2330', 4, [8, 10], 120, first),                           // lat pulldown
    lift('3563', 3, [10, 12], 60, { note: '벤치를 가로로 놓고 옆으로 앉아서 · 팔꿈치를 엉덩이 쪽으로 · 왼팔부터, 횟수는 한 팔 기준' }),  // one-arm cable pulldown, seated sideways
    lift('0327', 3, [8, 10], 120, { note: '가슴을 벤치에 대고 — 허리 · 허벅지 뒤는 쉬게' }),  // chest-supported dumbbell row
    lift('0861', 3, [10, 12], 90),                                  // seated cable row
    lift('0203', 3, [12, 15], 60),                                  // face pull (rope rear-delt row)
    lift('0178', 4, [12, 15], 60, { note: SMALL_LAST }),            // cable lateral raise
    lift('0447', 3, [8, 10], 75),                                   // EZ-bar curl
    inclineWalk
  ]],
  // Dips open it: the lower chest and the triceps in one lift, and the chest's second day of the
  // week. Then biceps and triceps take turns, so each rests while the other works.
  ['g-arms', '팔 · 어깨', 'arm', [
    lift('0251', 3, [8, 12], 120, { note: '몸을 앞으로 기울여 아랫가슴 · 어깨가 팔꿈치 아래로 내려가지 않게 · 첫 세트 전 어시스트 딥스로 가볍게 1세트' }),  // chest dip
    lift('0334', 4, [12, 15], 60, { note: SMALL_LAST }),            // dumbbell lateral raise
    lift('0031', 3, [8, 10], 90),                                   // barbell curl
    lift('0060', 3, [10, 12], 75),                                  // skull crusher
    lift('0318', 3, [10, 12], 75, { note: LEFT_SETS }),             // incline dumbbell curl
    lift('0602', 3, [12, 15], 60, { note: '팔은 살짝 굽힌 채, 날개뼈 말고 어깨 뒤로 벌리기' }),  // reverse pec deck
    lift('0200', 3, [10, 12], 60),                                  // rope pushdown
    lift('0313', 3, [10, 12], 60, { note: LEFT_SETS }),             // dumbbell hammer curl
    inclineWalk
  ]]
]

// [weekday, routineKey] — weekday is a DAYN index, so 1 is Monday. Fixed weeks only: every
// plan repeats the same seven days, which is all the weekly plan model can represent.
const PLANS = {
  'gplan-solid': { routines: GPLAN_SOLID, routine: { prog: 'double' }, schedule: [[1, 'g-upper-a'], [2, 'g-lower'], [3, 'g-upper-b'], [5, 'g-arms']] },
  ppl: { routines: PPL, schedule: [[1, 'push'], [3, 'pull'], [5, 'legs']] },
  'upper-lower': { routines: UPPER_LOWER, schedule: [[1, 'upper-a'], [2, 'lower-a'], [4, 'upper-b'], [5, 'lower-b']] },
  'full-body': { routines: FULL_BODY, schedule: [[1, 'fb-a'], [3, 'fb-b'], [5, 'fb-c']] },
  '5x5': { routines: FIVE_BY_FIVE, schedule: [[1, '5x5-a'], [3, '5x5-b'], [5, '5x5-c']] }
}

// An exercise is either the short [id, sets, reps] or a full config object (G-PLAN's). Both come
// back as fresh objects, so a caller editing what it got can never reach the catalog.
const exConfig = e => (Array.isArray(e) ? { id: e[0], sets: e[1], reps: e[2], weight: 0 } : { ...e })

// `routine` is what every routine of the plan carries besides its exercises (G-PLAN: its rule).
const build = (routines, routine = {}) =>
  routines.map(([, name, emoji, list]) => ({ id: uid(), name, emoji, ...routine, ex: list.map(exConfig) }))

// Fresh routine objects (new ids) — [push, pull, legs]. The demo build seeds a history on
// top of exactly these three, so this entry point keeps its shape.
export const starterRoutines = () => build(PPL)

// [{ id, days }] for the chooser. The day count is read off the schedule rather than stored
// beside it, so the two can never disagree.
export const starterPlanOptions = () =>
  Object.entries(PLANS).map(([id, { schedule }]) => ({ id, days: schedule.length }))

// The weekdays a plan would claim, or null for an unknown id.
export const starterPlanDays = id => PLANS[id]?.schedule.map(([day]) => day) ?? null

// Fresh routines plus the weekdays to put them on, or null for an unknown id — a caller that
// treats null as "change nothing" can never half-apply a plan.
export const buildStarterPlan = id => {
  const plan = PLANS[id]
  if (!plan) return null
  const routines = build(plan.routines, plan.routine)
  // key → the id just minted for it, so the schedule below names its routine
  const byKey = Object.fromEntries(plan.routines.map(([key], i) => [key, routines[i].id]))
  return { routines, schedule: plan.schedule.map(([day, key]) => ({ day, routineId: byKey[key] })) }
}
