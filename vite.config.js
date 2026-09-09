import { readdirSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The newest migration in the repo at build time. The bundle carries it so the
// running app can ask the database which migrations it actually has and say
// something useful when the two disagree — the client shipping ahead of its
// schema is how three features have now half-deployed, each presenting as
// "the feature is broken" with nothing pointing at the cause.
const migrationFiles = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
const newestMigration = migrationFiles.at(-1).replace(/\.sql$/, '')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __SCHEMA_EXPECTED__: JSON.stringify(newestMigration),
    // The count, because the newest id alone cannot see a gap in the middle:
    // a database missing 0026 but holding 0028 reports the same maximum as one
    // holding both.
    __SCHEMA_COUNT__: migrationFiles.length,
  },
})
