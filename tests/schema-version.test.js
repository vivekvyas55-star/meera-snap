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
