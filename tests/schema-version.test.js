import { expect, test } from 'vitest'
import { compareVersions, driftMessage } from '../src/lib/schemaVersion'

test('ids compare lexically, which is the order they are applied in', () => {
  expect(compareVersions('202609080017_schema_version', '202609080017_schema_version')).toBe('match')
  expect(compareVersions('202609080016_egress', '202609080017_schema_version')).toBe('database-behind')
  expect(compareVersions('202609080017_schema_version', '202609080016_egress')).toBe('database-ahead')
})

test('an unknown version is never reported as drift', () => {
  // No RPC, no session, no network. Guessing "behind" here would put a warning
  // in front of every user of an older database that is working perfectly.
  expect(compareVersions(null, '202609080017_schema_version')).toBe('unknown')
  expect(compareVersions('202609080017_schema_version', null)).toBe('unknown')
  expect(driftMessage('unknown')).toBe(null)
})

test('only a database that is behind is worth saying anything about', () => {
  expect(driftMessage('database-behind')).toBeTruthy()
  // A migration applied while the deploy is still in flight is the normal state
  // for a few minutes and needs no announcement.
  expect(driftMessage('database-ahead')).toBe(null)
  expect(driftMessage('match')).toBe(null)
})

test('a migration missing from the MIDDLE is drift, even though the maximum matches', () => {
  // This is the case that got through: 0026 was never applied, 0028 was, and
  // both sides reported "202609090028" — match, no warning, on a database that
  // was genuinely a migration short.
  expect(compareVersions('202609090028_bot_rotation', '202609090028_bot_rotation', 28, 29))
    .toBe('database-behind')
  // Same ids, same count, is a real match.
  expect(compareVersions('202609090028_bot_rotation', '202609090028_bot_rotation', 29, 29))
    .toBe('match')
  // A database AHEAD by count is not behind — that is a deploy in flight.
  expect(compareVersions('202609090029_x', '202609090028_y', 30, 29)).toBe('database-ahead')
  // Counts unknown falls back to comparing ids, never to a false alarm.
  expect(compareVersions('202609090028_a', '202609090028_a', null, null)).toBe('match')
})
