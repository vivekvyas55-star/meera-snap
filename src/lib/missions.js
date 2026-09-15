// Secret Missions — a small daily goal laid OVER the runner, never inside it.
//
// The rule this whole file is built around: missions OBSERVE a run, they do
// not fork the physics. lib/runner.js is untouched except for exporting the
// three numbers that say where the runner stands — `step()` still decides
// everything about how the run behaves, and nothing here writes to a `run`.
// If a mission could change the physics then the runner's own tests would stop
// describing the game people actually play, and the two would drift apart
// silently the first time a mission was tuned.
//
// So everything below is derived from the run's public state:
//   - an obstacle is CLEARED when the object runner.js already created has
//     travelled past the runner (object identity is stable inside one run, so
//     each is counted once);
//   - a jump is counted by the component at the moment runner.js accepts one;
//   - a star is a mission-owned thing that exists only as a pure function of
//     `run.dist`, and is collected by being airborne as it goes past. It is
//     drawn by DinoRun and known to nothing in runner.js.
//
// The rotation is lib/dayCycle.js (epoch 2024-01-01, the one day-number module
// in the client): a cycle on the IST day number plus a per-user phase, so
// every mission comes round before any repeats and adding one below lengthens
// the cycle by itself.
//
// NO PUNISHMENT. There is no penalty for failing a mission, no consecutive-day
// counter, and nothing anywhere records that a day was missed. Yesterday's
// mission is simply gone; today's is new.

import { pickForDay } from './dayCycle'
import { RUNNER_X } from './runner'

// --------------------------------------------------------------------------
// Stars
//
// Spaced by distance rather than time, so they arrive at the same points of
// the track however fast the run has become. The lift needed is well inside a
// jump (the arc peaks around 90px) — a star you can miss by jumping slightly
// late is a punishment, and these are meant to be a reason to jump when you
// otherwise would not.
// --------------------------------------------------------------------------
export const STAR_SPACING = 430
export const STAR_REACH = 16 // how close horizontally counts as "at the star"
export const STAR_LIFT = 14 // how far off the ground counts as airborne
export const STAR_Y = 46 // px above the ground line, for drawing

/** The world position of star `i` (0-based). */
export const starWorldX = (i) => (i + 1) * STAR_SPACING

/** Which star, if any, the runner is level with right now. */
export function starAtRunner(run) {
  const world = run.dist + RUNNER_X
  const i = Math.round(world / STAR_SPACING) - 1
  if (i < 0) return -1
  return Math.abs(world - starWorldX(i)) <= STAR_REACH ? i : -1
}

/**
 * The stars visible on a canvas `width` wide, for drawing. Pure — the screen
 * position of a star is just its world position minus how far the run has
 * come, which is why none of this needs state in the run.
 */
export function starsOnScreen(run, width, watch = null) {
  const out = []
  const first = Math.max(0, Math.floor(run.dist / STAR_SPACING) - 1)
  for (let i = first; i < first + 6; i++) {
    const x = starWorldX(i) - run.dist
    if (x < -30) continue
    if (x > width + 30) break
    out.push({ index: i, x, taken: watch ? watch.stars.has(i) : false })
  }
  return out
}

// --------------------------------------------------------------------------
// Watching one run
// --------------------------------------------------------------------------

/** A fresh observer for a single run. Holds nothing the run needs. */
export function createWatch() {
  return {
    cleared: new Set(), // obstacle objects already counted
    stars: new Set(), // star indices collected this run
    obstacles: 0,
    tall: 0,
    jumps: 0,
    score: 0,
  }
}

/**
 * Called once per frame, AFTER step(). Reads the run; never writes to it.
 * Returns the watch so a caller can chain, but it mutates in place — this is
 * on the 60fps path and allocating a new object per frame is the one thing
 * that would make it show up in a profile.
 */
export function watchFrame(watch, run) {
  if (!watch || !run) return watch
  for (const o of run.obstacles) {
    // Past the runner's back edge: this one is behind us and cannot be hit.
    if (o.x + o.w < RUNNER_X && !watch.cleared.has(o)) {
      watch.cleared.add(o)
      watch.obstacles++
      // runner.js builds the tall variant at h = 34 and the short one at 24.
      if (o.h > 28) watch.tall++
    }
  }
  const star = starAtRunner(run)
  if (star >= 0 && !watch.stars.has(star) && run.y <= -STAR_LIFT) watch.stars.add(star)
  return watch
}

/** Called when runner.js has actually accepted a jump (not every tap). */
export function watchJump(watch) {
  if (watch) watch.jumps++
  return watch
}

/**
 * The run's score as scoreOf() reports it. Kept on the watch so a score
 * mission can count up live; the run itself is still the only thing that knows
 * how a score is earned.
 */
export function watchScore(watch, score) {
  if (watch) watch.score = Math.max(watch.score, Math.trunc(score) || 0)
  return watch
}

// --------------------------------------------------------------------------
// The day's totals
//
// Serialisable on purpose: this is what lib/soloProgress.js writes to
// localStorage, and a Set or a Map there comes back from JSON as {}.
// --------------------------------------------------------------------------

export const emptyTotals = () => ({
  runs: 0,
  jumps: 0,
  stars: 0,
  tall: 0,
  bestObstacles: 0, // most cleared in a single run
  bestScore: 0,
  obstacles: 0, // cleared across every run today
})

/** Fold a finished run into the day. Pure — returns a new totals object. */
export function mergeRun(totals, watch, score = 0) {
  const base = { ...emptyTotals(), ...(totals ?? {}) }
  if (!watch) return base
  return {
    runs: base.runs + 1,
    jumps: base.jumps + watch.jumps,
    stars: base.stars + watch.stars.size,
    tall: base.tall + watch.tall,
    obstacles: base.obstacles + watch.obstacles,
    bestObstacles: Math.max(base.bestObstacles, watch.obstacles),
    bestScore: Math.max(base.bestScore, Math.trunc(score) || 0),
  }
}

// --------------------------------------------------------------------------
// The missions themselves
//
// `of` reads the day's totals plus the run in progress, so the HUD counts up
// while you are playing rather than only when you die. Goals are deliberately
// gentle: every one of these is reachable in a couple of minutes, because the
// point is a reason to play once, not a target to grind.
// --------------------------------------------------------------------------
export const MISSIONS = [
  {
    id: 'clear-12',
    title: 'Clear twelve',
    blurb: 'Get past twelve obstacles in one run.',
    unit: 'obstacles',
    goal: 12,
    of: (t, w) => Math.max(t.bestObstacles, w ? w.obstacles : 0),
  },
  {
    id: 'stars-3',
    title: 'Collect three stars',
    blurb: 'Jump through three stars. They only turn up on a mission day.',
    unit: 'stars',
    goal: 3,
    stars: true,
    of: (t, w) => t.stars + (w ? w.stars.size : 0),
  },
  {
    id: 'score-150',
    title: 'Reach one fifty',
    blurb: 'Get a run to a score of 150.',
    unit: 'points',
    goal: 150,
    of: (t, w) => Math.max(t.bestScore, w ? w.score : 0),
  },
  {
    id: 'jumps-30',
    title: 'Thirty jumps',
    blurb: 'Thirty jumps today, across as many runs as you like.',
    unit: 'jumps',
    goal: 30,
    of: (t, w) => t.jumps + (w ? w.jumps : 0),
  },
  {
    id: 'tall-6',
    title: 'Six tall ones',
    blurb: 'Clear six of the tall obstacles.',
    unit: 'tall obstacles',
    goal: 6,
    of: (t, w) => t.tall + (w ? w.tall : 0),
  },
  {
    id: 'stars-5',
    title: 'Five stars',
    blurb: 'Five stars, whenever you feel like it.',
    unit: 'stars',
    goal: 5,
    stars: true,
    of: (t, w) => t.stars + (w ? w.stars.size : 0),
  },
  {
    id: 'runs-3',
    title: 'Three little runs',
    blurb: 'Take three runs. Any length, any score.',
    unit: 'runs',
    goal: 3,
    of: (t, w) => t.runs + (w && (w.jumps > 0 || w.obstacles > 0) ? 1 : 0),
  },
  {
    id: 'obstacles-30',
    title: 'Thirty in a day',
    blurb: 'Thirty obstacles cleared in total today.',
    unit: 'obstacles',
    goal: 30,
    of: (t, w) => t.obstacles + (w ? w.obstacles : 0),
  },
]

/** Today's mission, or null when the day is unknown. `isoDate` is 'YYYY-MM-DD'. */
export function missionForDay(isoDate, seed = '') {
  return pickForDay(MISSIONS, isoDate, seed)
}

/** Does today's mission put stars on the track? */
export const missionHasStars = (mission) => !!mission?.stars

/**
 * How far along a mission is. `watch` is the run in progress, or null between
 * runs. `done` is a fact about today and never expires mid-day.
 */
export function progressOf(mission, totals, watch = null) {
  if (!mission) return null
  const t = { ...emptyTotals(), ...(totals ?? {}) }
  const value = Math.max(0, Math.trunc(mission.of(t, watch)))
  return {
    value: Math.min(value, mission.goal),
    goal: mission.goal,
    unit: mission.unit,
    done: value >= mission.goal,
  }
}
