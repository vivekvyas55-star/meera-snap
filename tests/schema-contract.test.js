import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// Three times now a feature has shipped in halves — the client calling an RPC
// no applied migration defines, or a migration applied with no client to use it.
// Each time it looked like the feature was simply broken, which is the most
// expensive kind of bug to diagnose. This test makes the client/schema contract
// a build-time failure instead of something you find in production.
//
// It reads the migrations off disk rather than from a list, so a new migration
// is covered the moment it exists and cannot be forgotten.
const MIGRATIONS = 'supabase/migrations'
const SRC = 'src'

const migrationSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  )
}

const clientSource = walk(SRC)
  .filter((f) => /\.(js|jsx)$/.test(f))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n')

const uniq = (xs) => [...new Set(xs)]
const matches = (src, re) => uniq([...src.matchAll(re)].map((m) => m[1]))

test('every RPC the client calls is defined by a migration', () => {
  const called = matches(clientSource, /\.rpc\(\s*['"]([a-z0-9_]+)['"]/g)
  // Sanity: if the scan finds nothing the test is silently useless.
  expect(called.length).toBeGreaterThan(20)

  const defined = new Set(
    matches(migrationSql, /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi)
  )
  const missing = called.filter((fn) => !defined.has(fn))
  expect(missing, `client calls RPCs no migration defines: ${missing.join(', ')}`).toEqual([])
})

test('every table the client reads is created by a migration', () => {
  const used = matches(clientSource, /\.from\(\s*['"]([a-z0-9_]+)['"]/g)
  const created = new Set(
    matches(migrationSql, /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)
  )
  // Storage buckets are addressed through .from() too and are not public tables.
  const STORAGE = new Set(['media'])
  const missing = used.filter((t) => !created.has(t) && !STORAGE.has(t))
  expect(missing, `client reads tables no migration creates: ${missing.join(', ')}`).toEqual([])
})

test('every migration is exercised by the PGlite harness', () => {
  // tests/database.mjs applies migrations from a hand-written list, so a new
  // migration is silently never executed against a real Postgres — which is how
  // a broken migration reaches production having passed every check.
  const harness = readFileSync('tests/database.mjs', 'utf8')
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  // If the harness enumerates the directory it covers everything by
  // construction; otherwise every filename must appear in its list.
  const enumerates = /readdirSync\s*\(/.test(harness)
  const unexercised = enumerates ? [] : files.filter((f) => !harness.includes(f))
  expect(unexercised, `migrations never run by tests/database.mjs: ${unexercised.join(', ')}`).toEqual([])
})
