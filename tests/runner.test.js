import { expect, test } from 'vitest'
import { createRun, jump, scoreOf, step, GROUND_Y, MAX_SPEED, START_SPEED } from '../src/lib/runner'

const seeded = () => { let n = 0; return () => ((n = (n * 9301 + 49297) % 233280) / 233280) }

// Clear the track each frame so these two measure distance and speed rather
// than how long the runner survives without anyone pressing jump.
const runClear = (run, frames) => {
  for (let i = 0; i < frames; i++) {
    step(run, 1, 340, () => 0.9)
    run.obstacles = []
  }
  return run
}

test('the score advances while running', () => {
  const run = runClear(createRun(), 120)
  // ~4.2px a frame at 24px a point — two seconds of running is not zero.
  expect(scoreOf(run)).toBeGreaterThan(15)
})

test('the score stays put when nothing is happening', () => {
  const run = createRun()
  expect(scoreOf(run)).toBe(0)
})

test('a jump leaves the ground and lands again', () => {
  const run = createRun()
  jump(run)
  step(run, 1, 340, () => 0.9)
  expect(run.y).toBeLessThan(0)
  for (let i = 0; i < 80; i++) step(run, 1, 340, () => 0.9)
  expect(run.y).toBe(0)
})

test('you cannot double jump in mid-air', () => {
  const run = createRun()
  jump(run)
  step(run, 1, 340, () => 0.9)
  const rising = run.vy
  jump(run)
  expect(run.vy).toBe(rising)
})

test('running into an obstacle ends the run', () => {
  const run = createRun()
  run.obstacles = [{ x: 34, w: 17, h: 24 }]
  step(run, 1, 340, () => 0.9)
  expect(run.over).toBe(true)
})

test('jumping clears an obstacle', () => {
  const run = createRun()
  run.obstacles = [{ x: 60, w: 17, h: 24 }]
  jump(run)
  // Ten frames of rising carries the runner over a short obstacle as it passes.
  for (let i = 0; i < 10; i++) step(run, 1, 340, () => 0.9)
  expect(run.over).toBe(false)
})

test('a stopped run does not keep scoring', () => {
  const run = createRun()
  run.over = true
  const before = run.dist
  step(run, 1, 340, () => 0.9)
  expect(run.dist).toBe(before)
})

test('obstacles stay far enough apart to be jumpable at top speed', () => {
  const run = createRun()
  run.dist = 900 * (MAX_SPEED + 5)
  run.speed = MAX_SPEED
  const width = 340
  for (let i = 0; i < 600; i++) step(run, 1, width, () => 0)
  for (let i = 1; i < run.obstacles.length; i++) {
    const gap = run.obstacles[i].x - (run.obstacles[i - 1].x + run.obstacles[i - 1].w)
    expect(gap).toBeGreaterThan(120)
  }
})

test('speed rises but is capped', () => {
  const run = runClear(createRun(), 60)
  expect(run.speed).toBeGreaterThan(START_SPEED)
  expect(runClear(run, 5000).speed).toBe(MAX_SPEED)
})

test('the ground is where the runner lands', () => {
  const run = createRun()
  expect(GROUND_Y).toBeGreaterThan(0)
  expect(run.y).toBe(0)
})
