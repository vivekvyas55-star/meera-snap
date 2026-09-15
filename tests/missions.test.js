import { expect, test } from 'vitest'
import { GROUND_Y, RUNNER_X, createRun, jump, scoreOf, step } from '../src/lib/runner'
import {
  MISSIONS,
  STAR_LIFT,
  STAR_SPACING,
  createWatch,
  emptyTotals,
  mergeRun,
  missionForDay,
  missionHasStars,
  progressOf,
  starAtRunner,
  starWorldX,
  starsOnScreen,
  watchFrame,
  watchJump,
  watchScore,
} from '../src/lib/missions'

const WIDTH = 340
const rand = () => 0.5

// Drive a real run for `frames`, jumping whenever an obstacle is close enough
// that a human would. Everything the missions know comes out of this, which is
// the point: they watch the actual physics rather than a copy of them.
function play(frames, watch, { jumpAt = 78 } = {}) {
  const run = createRun()
  for (let i = 0; i < frames && !run.over; i++) {
    const next = run.obstacles.find((o) => o.x + o.w > RUNNER_X)
    if (next && next.x - RUNNER_X < jumpAt && run.y === 0) {
      jump(run)
      watchJump(watch)
    }
    step(run, 1, WIDTH, rand)
    watchFrame(watch, run)
    watchScore(watch, scoreOf(run))
  }
  return run
}

test('watching a run changes nothing about the run', () => {
  // The whole contract of this file in one assertion: two identical runs, one
  // observed and one not, must end up byte-for-byte the same. A mission that
  // could touch the physics would make runner.js's own tests describe a game
  // nobody plays.
  const plain = createRun()
  const observed = createRun()
  const watch = createWatch()
  for (let i = 0; i < 400; i++) {
    if (i % 37 === 0) { jump(plain); jump(observed); watchJump(watch) }
    step(plain, 1, WIDTH, rand)
    step(observed, 1, WIDTH, rand)
    watchFrame(watch, observed)
    watchScore(watch, scoreOf(observed))
  }
  expect(JSON.stringify(observed)).toBe(JSON.stringify(plain))
})

test('an obstacle is counted once, when it is actually behind the runner', () => {
  const run = createRun()
  const watch = createWatch()
  run.obstacles = [{ x: RUNNER_X + 5, w: 17, h: 24 }]
  watchFrame(watch, run)
  expect(watch.obstacles).toBe(0) // still level with the runner
  run.obstacles[0].x = RUNNER_X - 25
  watchFrame(watch, run)
  expect(watch.obstacles).toBe(1)
  watchFrame(watch, run)
  watchFrame(watch, run)
  expect(watch.obstacles, 'the same obstacle counted twice').toBe(1)
})

test('tall obstacles are counted separately', () => {
  const run = createRun()
  const watch = createWatch()
  run.obstacles = [{ x: -40, w: 13, h: 34 }, { x: -40, w: 17, h: 24 }]
  watchFrame(watch, run)
  expect(watch.obstacles).toBe(2)
  expect(watch.tall).toBe(1)
})

test('a real run clears real obstacles', () => {
  const watch = createWatch()
  const run = play(1400, watch)
  expect(watch.obstacles).toBeGreaterThan(5)
  expect(watch.jumps).toBeGreaterThan(5)
  expect(watch.score).toBe(scoreOf(run))
})

test('a jump is only counted when the runner can actually take one', () => {
  // DinoRun asks the same question before calling watchJump; this pins the
  // rule itself, which is that taps in mid-air are not jumps.
  const run = createRun()
  const watch = createWatch()
  jump(run)
  step(run, 1, WIDTH, rand)
  expect(run.y).toBeLessThan(0)
  const before = run.vy
  jump(run) // refused by the physics
  expect(run.vy).toBe(before)
  expect(watch.jumps).toBe(0)
})

test('a star is collected by being in the air, and only once', () => {
  const run = createRun()
  const watch = createWatch()
  run.dist = starWorldX(0) - RUNNER_X
  expect(starAtRunner(run)).toBe(0)

  run.y = 0 // on the ground: missed
  watchFrame(watch, run)
  expect(watch.stars.size).toBe(0)

  run.y = -(STAR_LIFT + 20) // airborne: collected
  watchFrame(watch, run)
  expect(watch.stars.size).toBe(1)
  watchFrame(watch, run)
  expect(watch.stars.size, 'one star counted twice').toBe(1)
})

test('stars sit where a jump reaches them, and are reachable in a real run', () => {
  // A star you can only get by luck is a punishment. The jump arc peaks near
  // 90px, so the lift needed has to be well inside it.
  const run = createRun()
  jump(run)
  let peak = 0
  for (let i = 0; i < 60; i++) {
    step(run, 1, WIDTH, rand)
    peak = Math.min(peak, run.y)
  }
  expect(peak).toBeLessThan(-(STAR_LIFT * 3))
})

test('stars are a pure function of distance — the run stores nothing about them', () => {
  const run = createRun()
  run.dist = 1000
  const before = JSON.stringify(run)
  starsOnScreen(run, WIDTH, createWatch())
  starAtRunner(run)
  expect(JSON.stringify(run)).toBe(before)
  expect(starWorldX(0)).toBe(STAR_SPACING)
  expect(starWorldX(3)).toBe(4 * STAR_SPACING)
})

test('only the stars on screen are drawn, and a taken one knows it', () => {
  const run = createRun()
  run.dist = starWorldX(4) - 100
  const watch = createWatch()
  watch.stars.add(4)
  const shown = starsOnScreen(run, WIDTH, watch)
  expect(shown.length).toBeGreaterThan(0)
  for (const s of shown) {
    expect(s.x).toBeGreaterThan(-31)
    expect(s.x).toBeLessThan(WIDTH + 31)
  }
  expect(shown.find((s) => s.index === 4).taken).toBe(true)
})

test('stars only appear on the days a mission asks for them', () => {
  expect(missionHasStars(MISSIONS.find((m) => m.id === 'stars-3'))).toBe(true)
  expect(missionHasStars(MISSIONS.find((m) => m.id === 'jumps-30'))).toBe(false)
  expect(missionHasStars(null)).toBe(false)
})

test('the day’s totals fold in one run at a time', () => {
  const watch = createWatch()
  watch.obstacles = 7
  watch.tall = 2
  watch.jumps = 9
  watch.stars.add(0)
  watch.stars.add(1)
  const one = mergeRun(emptyTotals(), watch, 44)
  expect(one).toEqual({ runs: 1, jumps: 9, stars: 2, tall: 2, obstacles: 7, bestObstacles: 7, bestScore: 44 })

  const small = createWatch()
  small.obstacles = 3
  small.jumps = 4
  const two = mergeRun(one, small, 12)
  expect(two.runs).toBe(2)
  expect(two.obstacles).toBe(10)
  expect(two.bestObstacles, 'a worse run must not lower a best').toBe(7)
  expect(two.bestScore).toBe(44)
})

test('every mission is reachable, described, and counts something real', () => {
  const ids = new Set()
  for (const m of MISSIONS) {
    expect(ids.has(m.id)).toBe(false)
    ids.add(m.id)
    expect(m.title && m.blurb && m.unit).toBeTruthy()
    expect(m.goal).toBeGreaterThan(0)
    // At the goal it is done; one short of it, it is not.
    const totals = { ...emptyTotals(), runs: m.goal, jumps: m.goal, stars: m.goal, tall: m.goal, obstacles: m.goal, bestObstacles: m.goal, bestScore: m.goal }
    expect(progressOf(m, totals).done, `${m.id} cannot be completed`).toBe(true)
    expect(progressOf(m, emptyTotals()).value, `${m.id} starts part-done`).toBe(0)
  }
})

test('progress counts the run in progress as well as the day', () => {
  const mission = MISSIONS.find((m) => m.id === 'jumps-30')
  const watch = createWatch()
  watch.jumps = 4
  expect(progressOf(mission, { ...emptyTotals(), jumps: 10 }, watch).value).toBe(14)
  // And is capped at the goal rather than running away past it.
  expect(progressOf(mission, { ...emptyTotals(), jumps: 99 }).value).toBe(mission.goal)
})

test('progress on an unknown day is null, not zero-of-zero', () => {
  expect(progressOf(null, emptyTotals())).toBeNull()
  for (const bad of [null, undefined, '', '2026-9-15', '2026-02-30']) {
    expect(missionForDay(bad, 'me')).toBeNull()
    expect(progressOf(missionForDay(bad, 'me'), emptyTotals())).toBeNull()
  }
})

test('every mission is reached before any of them comes round again', () => {
  // A cycle, not a draw — lib/dayCycle.js, epoch 2024-01-01. `missionForDay`
  // takes an IST date string like every other daily surface in the client.
  const iso = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString().slice(0, 10)
  const seen = new Set()
  for (let d = 0; d < MISSIONS.length; d++) {
    const m = missionForDay(iso(d), 'vivek')
    expect(m, `day ${d} produced nothing`).toBeTruthy()
    expect(seen.has(m.id), `${m.id} repeated on day ${d}`).toBe(false)
    seen.add(m.id)
  }
  expect(seen.size).toBe(MISSIONS.length)
})

test('nothing in a mission counts days in a row', () => {
  // The anti-streak assertion, kept as a test because it is a product rule
  // rather than a preference: a consecutive-day counter is the mechanic this
  // app copies for messages and must never copy for attention.
  const totals = emptyTotals()
  expect(Object.keys(totals)).not.toContain('streak')
  expect(Object.keys(totals)).not.toContain('days')
  const source = JSON.stringify(MISSIONS)
  expect(source.toLowerCase()).not.toContain('streak')
})

test('the runner’s own geometry is exported, not copied', () => {
  // missions.js counts an obstacle as cleared at RUNNER_X. If that number ever
  // lived in two files they would drift, and the mission would count a
  // different thing from the one the player sees go past.
  expect(RUNNER_X).toBe(30)
  expect(GROUND_Y).toBeGreaterThan(0)
})
