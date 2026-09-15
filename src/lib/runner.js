// The runner's rules, separated from its rendering.
//
// Pulled out of the component because a game loop inside a component is
// untestable: the only way to check that the score advances, that obstacles
// stay jumpable as speed rises, and that a collision actually ends the run is
// to step it deterministically. DinoRun.jsx now only draws what these return.
export const GROUND_Y = 104
export const GRAVITY = 0.62
export const JUMP_V = -10.6
export const START_SPEED = 4.2
export const MAX_SPEED = 9.5
// Where the runner stands, and how big it is. These were literals inside
// step()'s collision test; they are exported because lib/missions.js has to
// know where "past the runner" is to count an obstacle as cleared, and a
// second copy of the number in that file is a drift waiting to happen. Reading
// them is all missions does — the physics stay here.
export const RUNNER_X = 30
export const RUNNER_W = 20
export const RUNNER_H = 22
const PX_PER_POINT = 24

export function createRun() {
  return {
    y: 0,
    vy: 0,
    speed: START_SPEED,
    dist: 0,
    frame: 0,
    obstacles: [],
    clouds: [{ x: 200, y: 24 }, { x: 420, y: 40 }],
    over: false,
  }
}

export const scoreOf = (run) => Math.floor(run.dist / PX_PER_POINT)

export function jump(run) {
  if (!run.over && run.y === 0) run.vy = JUMP_V
  return run
}

// One frame. `dt` is in 60fps units (1 = one frame at 60fps) so the run is
// identical on a 120Hz phone. `rand` is injectable so tests are deterministic.
export function step(run, dt, width, rand = Math.random) {
  if (run.over) return run

  run.frame += dt
  run.dist += run.speed * dt
  run.speed = Math.min(MAX_SPEED, START_SPEED + run.dist / 900)

  run.vy += GRAVITY * dt
  run.y = Math.min(0, run.y + run.vy * dt)
  if (run.y === 0) run.vy = 0

  // The gap has to grow with speed, or the run stops being hard and starts
  // being impossible — two obstacles closer than a jump arc cannot be cleared.
  const last = run.obstacles[run.obstacles.length - 1]
  const minGap = 190 + run.speed * 18
  if (!last || width - last.x > minGap + rand() * 130) {
    const tall = rand() > 0.72
    run.obstacles.push({ x: width + 20, w: tall ? 13 : 17, h: tall ? 34 : 24 })
  }
  for (const o of run.obstacles) o.x -= run.speed * dt
  run.obstacles = run.obstacles.filter((o) => o.x + o.w > -10)

  for (const c of run.clouds) {
    c.x -= run.speed * 0.22 * dt
    if (c.x < -50) { c.x = width + rand() * 90; c.y = 16 + rand() * 34 }
  }

  // Inset so a near miss reads as a near miss rather than a phantom hit.
  const x = RUNNER_X
  const w = RUNNER_W
  const h = RUNNER_H
  const top = GROUND_Y - h + run.y
  for (const o of run.obstacles) {
    if (x + w - 4 > o.x && x + 4 < o.x + o.w && top + h - 3 > GROUND_Y - o.h) {
      run.over = true
      break
    }
  }
  return run
}
