import { describe, expect, it } from 'vitest'
import { EXIDX, isCardio } from './exercises.js'
import { buildStarterPlan, starterPlanDays, starterPlanOptions, starterRoutines } from './starter.js'
import { policyFor } from './progression.js'
import { buildCombinedEntries } from './session-merge.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { isWarmupRow } from './workout-model.js'

// The approved prescription, written out again rather than imported: a test that reads the
// same table as the code would pass no matter what that table said. [weekday, name, sets].
const APPROVED = {
  // [id, sets, reps] here; the rest of G-PLAN's prescription is pinned in its own block below.
  'gplan-solid': [
    [1, '상체 A · 가슴 어깨', [['0314', 4, 10], ['0577', 3, 10], ['0405', 3, 10], ['0334', 4, 15], ['0179', 3, 15], ['0596', 3, 15], ['0194', 3, 12], ['3666', 1, undefined]]],
    [2, '하체 · 스쿼트', [['0043', 3, 8], ['0085', 3, 10], ['0739', 3, 12], ['0599', 3, 12], ['0585', 2, 15], ['0334', 4, 15], ['0594', 3, 15], ['0472', 3, 12], ['3666', 1, undefined]]],
    [3, '상체 B · 등', [['2330', 4, 10], ['3563', 3, 12], ['0327', 3, 10], ['0861', 3, 12], ['0203', 3, 15], ['0178', 4, 15], ['0447', 3, 10], ['3666', 1, undefined]]],
    [5, '팔 · 어깨', [['0251', 3, 12], ['0334', 4, 15], ['0031', 3, 10], ['0060', 3, 12], ['0318', 3, 12], ['0602', 3, 15], ['0200', 3, 12], ['0313', 3, 12], ['3666', 1, undefined]]],
  ],
  ppl: [
    [1, 'Push Day', [['0025', 4, 8], ['0047', 3, 10], ['0426', 3, 10], ['0334', 3, 12], ['0241', 3, 12], ['0251', 3, 10]]],
    [3, 'Pull Day', [['2330', 4, 10], ['0027', 4, 8], ['1323', 3, 10], ['0031', 3, 10], ['0313', 3, 12]]],
    [5, 'Leg Day', [['0043', 4, 8], ['0085', 3, 10], ['0739', 3, 12], ['0585', 3, 12], ['0586', 3, 12], ['0605', 4, 15]]],
  ],
  'upper-lower': [
    [1, 'Upper A', [['0025', 3, 8], ['2330', 3, 10], ['0047', 2, 10], ['1323', 2, 10], ['0334', 2, 12], ['0241', 2, 12], ['0031', 2, 12]]],
    [2, 'Lower A', [['0043', 3, 8], ['0085', 3, 8], ['0739', 2, 10], ['0586', 2, 12], ['0605', 3, 15]]],
    [4, 'Upper B', [['0047', 3, 8], ['0027', 3, 8], ['0426', 2, 10], ['2330', 2, 10], ['0334', 2, 12], ['0241', 2, 12], ['0313', 2, 12]]],
    [5, 'Lower B', [['0739', 3, 10], ['0085', 2, 10], ['0585', 2, 12], ['0586', 3, 12], ['0605', 3, 15]]],
  ],
  'full-body': [
    [1, 'Full Body A', [['0043', 3, 8], ['0025', 3, 8], ['2330', 3, 10], ['0586', 3, 12], ['0334', 2, 12], ['0031', 2, 12]]],
    [3, 'Full Body B', [['0085', 3, 8], ['0047', 3, 10], ['1323', 3, 10], ['0585', 3, 12], ['0334', 2, 12], ['0241', 2, 12]]],
    [5, 'Full Body C', [['0739', 3, 10], ['0025', 2, 10], ['0027', 3, 10], ['0426', 2, 10], ['0586', 3, 12], ['0605', 3, 15]]],
  ],
  '5x5': [
    [1, '5×5 A', [['0043', 5, 5], ['0025', 5, 5], ['0027', 5, 5]]],
    [3, '5×5 B', [['0085', 5, 5], ['0426', 5, 5], ['2330', 5, 5]]],
    [5, '5×5 C', [['0739', 5, 5], ['0047', 5, 5], ['1323', 5, 5]]],
  ],
}

const shape = r => r.ex.map(e => [e.id, e.sets, e.reps])

describe('starter plan catalog', () => {
  it('offers exactly the five plans, G-PLAN’s own first, with the day count read off the schedule', () => {
    expect(starterPlanOptions()).toEqual([
      { id: 'gplan-solid', days: 4 }, { id: 'ppl', days: 3 }, { id: 'upper-lower', days: 4 },
      { id: 'full-body', days: 3 }, { id: '5x5', days: 3 },
    ])
    for (const { id, days } of starterPlanOptions()) expect(starterPlanDays(id)).toHaveLength(days)
  })

  it('changes nothing for an unknown plan id', () => {
    expect(buildStarterPlan('nope')).toBeNull()
    expect(buildStarterPlan(undefined)).toBeNull()
    // A click handler wired straight to a loader would hand the event in as the plan.
    expect(buildStarterPlan({ type: 'click' })).toBeNull()
    expect(starterPlanDays('nope')).toBeNull()
  })
})

describe.each(Object.keys(APPROVED))('%s', planId => {
  const approved = APPROVED[planId]

  it('builds the approved exercises, sets and reps in order', () => {
    const { routines } = buildStarterPlan(planId)
    expect(routines.map(r => r.name)).toEqual(approved.map(([, name]) => name))
    routines.forEach((r, i) => expect(shape(r)).toEqual(approved[i][2]))
  })

  it('puts each routine on its approved weekday, by identity not position', () => {
    const { routines, schedule } = buildStarterPlan(planId)
    const nameOf = Object.fromEntries(routines.map(r => [r.id, r.name]))
    expect(schedule.map(({ day, routineId }) => [day, nameOf[routineId]]))
      .toEqual(approved.map(([day, name]) => [day, name]))
  })

  it('references only real exercises and starts every one at weight 0', () => {
    for (const r of buildStarterPlan(planId).routines) {
      for (const e of r.ex) {
        expect(EXIDX[e.id], e.id).toBeTruthy()
        expect(e.sets).toBeGreaterThan(0)
        // a cardio finisher is minutes at a speed, with no reps or load to start
        if (isCardio(e.id)) { expect(e.min).toBeGreaterThan(0); continue }
        expect(e.reps).toBeGreaterThan(0)
        expect(e.weight).toBe(0)
      }
    }
  })

  it('mints fresh ids and independent objects on every build', () => {
    const first = buildStarterPlan(planId)
    const second = buildStarterPlan(planId)
    const ids = first.routines.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(second.routines.some(r => ids.includes(r.id))).toBe(false)
    expect(first.routines[0].ex[0]).not.toBe(second.routines[0].ex[0])
    // and the static definition survives a caller mutating what it got back
    first.routines[0].ex[0].sets = 99
    expect(buildStarterPlan(planId).routines[0].ex[0].sets).toBe(approved[0][2][0][1])
  })
})

// G-PLAN's routine is written out the way docs/dev/GETYOURMUSCLE_PLAN.md §2.4.0 prescribes it,
// so it can be trained from the first tap: [id, bottom, top, rest seconds, warm-ups, note].
const LEFT = '왼팔이 멈추면 그 세트는 끝'
const SMALL = '반동 없이 · 마지막 세트는 실패 직전까지'
const FLY = '아래에서 위로 — 윗가슴'
const GPLAN_FULL = [
  [['0314', 8, 10, 150, 2, LEFT], ['0577', 8, 10, 120, 0, '손잡이가 가슴 가운데 높이에 오게 의자 조절'], ['0405', 8, 10, 120, 0, LEFT],
    ['0334', 12, 15, 75, 0, SMALL], ['0179', 12, 15, 75, 0, FLY], ['0596', 12, 15, 75, 0, '가슴 펴고, 손잡이를 모은 끝에서 1초 쥐어짜기'], ['0194', 10, 12, 75]],
  [['0043', 6, 8, 180, 2], ['0085', 8, 10, 150, 0, '엉덩이를 뒤로 빼며 허벅지 뒤가 당기는 데까지만 내리기'], ['0739', 10, 12, 120], ['0599', 10, 12, 75],
    ['0585', 12, 15, 60], ['0334', 12, 15, 60, 0, SMALL], ['0594', 12, 15, 60], ['0472', 10, 12, 60]],
  [['2330', 8, 10, 120, 2], ['3563', 10, 12, 60, 0, '랫 풀어라운드: 벤치를 가로로 놓고 옆으로 앉아, 위·바깥에서 엉덩이 쪽으로 팔을 대각선으로 당기기 · 왼팔부터, 횟수는 한 팔 기준'],
    ['0327', 8, 10, 120, 0, '가슴을 벤치에 대고 — 허리 · 허벅지 뒤는 쉬게'], ['0861', 10, 12, 90], ['0203', 12, 15, 60], ['0178', 12, 15, 60, 0, SMALL],
    ['0447', 8, 10, 75]],
  [['0251', 8, 12, 120, 0, '몸을 앞으로 기울여 아랫가슴 · 어깨가 팔꿈치 아래로 내려가지 않게 · 첫 세트 전 어시스트 딥스로 가볍게 1세트'],
    ['0334', 12, 15, 60, 0, SMALL], ['0031', 8, 10, 90], ['0060', 10, 12, 75], ['0318', 10, 12, 75, 0, LEFT],
    ['0602', 12, 15, 60, 0, '팔은 살짝 굽힌 채, 날개뼈 말고 어깨 뒤로 벌리기'], ['0200', 10, 12, 60], ['0313', 10, 12, 60, 0, LEFT]],
]

describe('G-PLAN Solid Build, as prescribed', () => {
  const { routines } = buildStarterPlan('gplan-solid')

  it('gives every lift its rep range, rest, warm-ups and cue', () => {
    routines.forEach((r, i) => {
      const lifts = r.ex.filter(e => !isCardio(e.id))
      expect(lifts.map(e => [e.id, e.repsMin, e.reps, e.restSec, e.warmupSets || 0, e.note]))
        .toEqual(GPLAN_FULL[i].map(([id, lo, hi, rest, warm = 0, note]) => [id, lo, hi, rest, warm, note]))
    })
  })

  it('runs every routine on double progression, which the cardio finisher opts out of', () => {
    for (const r of routines) {
      expect(r.prog).toBe('double')
      for (const e of r.ex) expect(policyFor(e, r)).toBe(isCardio(e.id) ? 'off' : 'double')
    }
  })

  it('ends every session with the incline walk, and has no other cardio', () => {
    const walk = { id: '3666', sets: 1, min: 20, speed: 5, note: '경사 10~12% · 하루 걸음 수 채우기' }
    routines.forEach(r => expect(r.ex.at(-1)).toEqual(walk))
    expect(routines.flatMap(r => r.ex.slice(0, -1)).filter(e => isCardio(e.id)).length).toBe(0)
  })

  // Broad shoulders and a wide frame are the goal above all (the user, 2026-10-30): the side delts
  // get a lateral raise on every training day, near the start where the session allows, and the
  // lats more than the pulldown alone.
  it('puts width first: laterals every training day, 16 sets, early on Monday and Friday, and 7 lat sets', () => {
    const LATERALS = ['0334', '0178']
    for (const r of routines) expect(r.ex.some(e => LATERALS.includes(e.id)), r.name).toBe(true)
    const all = routines.flatMap(r => r.ex)
    expect(all.filter(e => LATERALS.includes(e.id)).reduce((n, e) => n + e.sets, 0)).toBe(16)
    const position = r => r.ex.findIndex(e => LATERALS.includes(e.id))
    expect(position(routines[0])).toBeLessThan(routines[0].ex.findIndex(e => e.id === '0179'))   // before Monday's flies
    expect(position(routines[3])).toBe(1)                                                       // straight after Friday's dips
    expect(all.filter(e => EXIDX[e.id].tg === 'lats').reduce((n, e) => n + e.sets, 0)).toBe(7)
  })

  // More arms (the user's ask, 2026-10-27), and one leg day: two left them too sore for the
  // upper-body days (2026-10-30), on Tuesday so the legs are fresh for weekend football, and the
  // arm day on Friday so Monday follows two days off.
  // 12 sets each for biceps and triceps, and no muscle group trained two days running, so each
  // one comes to its next session recovered.
  it('has one leg day, 12 sets each for biceps and triceps, chest twice, and never a group two days running', () => {
    const { routines, schedule } = buildStarterPlan('gplan-solid')
    const dayOf = Object.fromEntries(schedule.map(({ day, routineId }) => [routineId, day]))
    expect(schedule.map(({ day }) => day)).toEqual([1, 2, 3, 5])   // Mon, Tue, Wed, Fri: the weekend off
    // The day after the legs loads neither the hamstrings nor a bent-over lower back.
    const wednesday = routines.find(r => dayOf[r.id] === 3)
    expect(wednesday.ex.some(e => EXIDX[e.id].bp === 'upper legs' || ['0027', '0085'].includes(e.id))).toBe(false)
    const legDays = routines.filter(r => r.ex.some(e => EXIDX[e.id].bp === 'upper legs'))
    expect(legDays.map(r => r.name)).toEqual(['하체 · 스쿼트'])
    const daysWith = has => routines.filter(r => r.ex.some(has)).map(r => dayOf[r.id]).sort((a, b) => a - b)
    const apart = (days, what) => days.slice(1).forEach((d, i) => expect(d - days[i], what + ' on back-to-back days').toBeGreaterThan(1))
    apart(daysWith(e => EXIDX[e.id].bp === 'upper legs'), 'legs')
    // Dips are filed under the chest but load the triceps as hard, so they count for both.
    const DIP = '0251'
    const works = muscle => e => EXIDX[e.id].tg === muscle || (muscle === 'triceps' && e.id === DIP)
    for (const muscle of ['biceps', 'triceps', 'pectorals']) {
      const sets = routines.flatMap(r => r.ex).filter(works(muscle)).reduce((n, e) => n + e.sets, 0)
      expect(sets, muscle).toBe(muscle === 'pectorals' ? 16 : 12)
      apart(daysWith(works(muscle)), muscle)
    }
  })

  // Started and finished the way the app does it (beginWorkout → buildCombinedEntries, the finish
  // path → buildCompletedWorkout), so the history read back has the shape the app saves.
  it('trains as prescribed: warm-ups first, then up through the range before the weight moves', () => {
    const st = { unit: 'kg', exWeights: {}, routines: buildStarterPlan('gplan-solid').routines, workouts: [], week: {}, dayPlan: {} }
    const monday = st.routines[0].id
    const press = () => buildCombinedEntries(st, [monday]).entries[0]   // dumbbell incline press, 4 × 8–10
    const train = reps => {
      const entries = buildCombinedEntries(st, [monday]).entries.map(e => ({
        ...e, sets: e.sets.map(row => ({ ...row, ...(isWarmupRow(row) || e.id !== '0314' ? {} : { w: 20, r: reps }), done: true }))
      }))
      const n = st.workouts.length + 1
      st.workouts.push(buildCompletedWorkout({ id: 'w' + n, d: `2026-10-2${n}`, start: n * 1000, routineIds: [monday], name: 'x', entries }, { end: n * 1000 + 1 }))
    }

    const opening = press()
    expect(opening.sets.filter(isWarmupRow)).toHaveLength(2)
    expect(opening.sets.filter(row => !isWarmupRow(row))).toHaveLength(4)
    expect(opening.target.restSec).toBe(150)

    const work = () => press().sets.filter(row => !isWarmupRow(row)).map(row => [row.w, row.r])
    train(9)                                        // inside the range: same weight, one more rep
    expect(work()).toEqual([[20, 10], [20, 10], [20, 10], [20, 10]])
    train(10)                                       // the top in every set: heavier, back to the bottom
    expect(work()).toEqual([[22.5, 8], [22.5, 8], [22.5, 8], [22.5, 8]])
  })

  it('leaves the other plans as plain lists with no rule of their own', () => {
    for (const id of ['ppl', 'upper-lower', 'full-body', '5x5']) {
      for (const r of buildStarterPlan(id).routines) {
        expect(r.prog).toBeUndefined()
        for (const e of r.ex) expect(Object.keys(e).sort()).toEqual(['id', 'reps', 'sets', 'weight'])
      }
    }
  })
})

describe('starterRoutines (the demo build entry point)', () => {
  it('still returns push, pull and legs unchanged', () => {
    const routines = starterRoutines()
    expect(routines.map(r => r.name)).toEqual(['Push Day', 'Pull Day', 'Leg Day'])
    routines.forEach((r, i) => expect(shape(r)).toEqual(APPROVED.ppl[i][2]))
    expect(routines.map(r => r.emoji)).toEqual(['barbell', 'pullup', 'legs'])
  })

  it('mints fresh ids on every invocation', () => {
    const first = starterRoutines().map(r => r.id)
    const second = starterRoutines().map(r => r.id)
    expect(new Set([...first, ...second]).size).toBe(6)
  })
})
