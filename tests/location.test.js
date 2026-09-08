// @vitest-environment node
import { expect, test } from 'vitest'
import {
  HEARTBEAT_MS,
  MIN_MOVE_M,
  MIN_WRITE_MS,
  distanceKm,
  distanceMeters,
  fixDecision,
} from '../src/lib/geo'

const NOW = 1_757_000_000_000

// ~111.32 km per degree of latitude at the equator.
test('distance is a real great-circle distance, in both units', () => {
  expect(distanceKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1)
  expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0)
  // Delhi → Mumbai, roughly.
  expect(distanceKm({ lat: 28.61, lng: 77.21 }, { lat: 19.08, lng: 72.88 })).toBeGreaterThan(1100)
  expect(distanceKm({ lat: 28.61, lng: 77.21 }, { lat: 19.08, lng: 72.88 })).toBeLessThan(1200)
})

test('the first fix of a sharing session always publishes', () => {
  expect(fixDecision(null, { lat: 12.9, lng: 77.6 }, NOW)).toEqual({ publish: true, reason: 'first' })
  // Go Ghost deletes the row, so a half-remembered previous position must never
  // throttle the write that puts someone back on the map.
  expect(fixDecision(undefined, { lat: 12.9, lng: 77.6 }, NOW).publish).toBe(true)
})

test('a fix the device could not really produce is never written', () => {
  const last = { lat: 12.9, lng: 77.6, at: NOW - HEARTBEAT_MS }
  expect(fixDecision(last, { lat: NaN, lng: 77.6 }, NOW).reason).toBe('invalid')
  expect(fixDecision(last, { lat: 91, lng: 77.6 }, NOW).reason).toBe('invalid')
  expect(fixDecision(last, { lat: 12.9, lng: 181 }, NOW).reason).toBe('invalid')
  expect(fixDecision(last, null, NOW).reason).toBe('invalid')
})

test('no more than one write a minute, however fast the fixes arrive', () => {
  const last = { lat: 12.9, lng: 77.6, at: NOW - 5_000 }
  // Moved a long way, but only five seconds ago: a watchPosition on a moving
  // phone can fire every second, and every one of those is a database write.
  const far = { lat: 13.1, lng: 77.6 }
  expect(fixDecision(last, far, NOW)).toEqual({ publish: false, reason: 'throttled' })
  expect(fixDecision({ ...last, at: NOW - MIN_WRITE_MS }, far, NOW).publish).toBe(true)
})

test('GPS jitter on a phone lying still is not movement', () => {
  const last = { lat: 12.9, lng: 77.6, at: NOW - 2 * MIN_WRITE_MS }
  // ~22 m north — inside the noise floor of a low-accuracy fix.
  const jitter = { lat: 12.9002, lng: 77.6, accuracy: 30 }
  expect(distanceMeters(last, jitter)).toBeLessThan(MIN_MOVE_M)
  expect(fixDecision(last, jitter, NOW)).toEqual({ publish: false, reason: 'still' })

  // ~111 m north — a real walk down the street.
  const moved = { lat: 12.901, lng: 77.6, accuracy: 30 }
  expect(fixDecision(last, moved, NOW)).toEqual({ publish: true, reason: 'moved' })
})

test('a coarse fix has to move further than its own error bars', () => {
  const last = { lat: 12.9, lng: 77.6, at: NOW - 2 * MIN_WRITE_MS }
  const moved = { lat: 12.901, lng: 77.6 } // ~111 m
  expect(fixDecision(last, { ...moved, accuracy: 25 }, NOW).publish).toBe(true)
  // Same movement, but the device says it only knows where you are to ±400 m.
  expect(fixDecision(last, { ...moved, accuracy: 400 }, NOW)).toEqual({ publish: false, reason: 'still' })
  // An absurd accuracy figure must not be able to freeze updates outright: the
  // threshold is capped, and the heartbeat gets through regardless.
  expect(fixDecision(last, { lat: 20, lng: 77.6, accuracy: 9e9 }, NOW).publish).toBe(true)
})

test('a stationary phone still checks in, so the "updated" line stays honest', () => {
  const still = { lat: 12.9, lng: 77.6 }
  const justBefore = { ...still, at: NOW - (HEARTBEAT_MS - 1000) }
  expect(fixDecision(justBefore, still, NOW)).toEqual({ publish: false, reason: 'still' })
  const due = { ...still, at: NOW - HEARTBEAT_MS }
  expect(fixDecision(due, still, NOW)).toEqual({ publish: true, reason: 'heartbeat' })
})

test('a stored timestamp in the future cannot gag updates until the clocks agree', () => {
  const skewed = { lat: 12.9, lng: 77.6, at: NOW + 86_400_000 }
  expect(fixDecision(skewed, { lat: 12.9, lng: 77.6 }, NOW).publish).toBe(true)
})
