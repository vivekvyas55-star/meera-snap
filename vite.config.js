import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The newest migration in the repo at build time. The bundle carries it so the
// running app can ask the database which migrations it actually has and say
// something useful when the two disagree — the client shipping ahead of its
// schema is how three features have now half-deployed, each presenting as
// "the feature is broken" with nothing pointing at the cause.
// Deliberately-unapplied migrations do not count towards what the app expects
// production to have. Without this the drift banner is permanently on, which is
// worse than not having it: an always-on warning is invisible on the day it is
// true.
const unappliedList = 'supabase/migrations/.unapplied'
const unapplied = new Set(
  existsSync(unappliedList)
    ? readFileSync(unappliedList, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : []
)
const migrationFiles = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
const expectedMigrations = migrationFiles.filter((f) => !unapplied.has(f.replace(/\.sql$/, '')))
// The newest one we actually expect to be live — not the newest file, or a
// shelved migration would make every correct production look behind.
const newestMigration = expectedMigrations.at(-1).replace(/\.sql$/, '')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __SCHEMA_EXPECTED__: JSON.stringify(newestMigration),
    // The count, because the newest id alone cannot see a gap in the middle:
    // a database missing 0026 but holding 0028 reports the same maximum as one
    // holding both.
    __SCHEMA_COUNT__: expectedMigrations.length,
  },
})
