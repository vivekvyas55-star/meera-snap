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
  build: {
    rollupOptions: {
      output: {
        // VENDOR IS SPLIT OUT FOR THE RETURNING VISITOR, not the first one.
        //
        // First load downloads the same bytes either way. What changes is the
        // SECOND load: react, react-dom and supabase-js are ~400 kB that never
        // change between deploys, and while they sat in the entry chunk every
        // deploy gave them a new content hash and every phone re-downloaded the
        // lot. That is the wrong trade for a PWA three people open daily and
        // which shipped fifteen times in one afternoon — and it is felt as
        // "everything takes too long to load", because after a deploy it does.
        //
        // Now a deploy invalidates the app chunk and leaves vendor cached.
        //
        // Leaflet and qrcode are deliberately absent: they are already isolated
        // by the lazy imports of SnapMap and Snapcode, and naming them here
        // would pull them back into an eagerly-loaded chunk — the exact mistake
        // one-door.test.js exists to catch, where Us statically importing Play
        // downloaded seven games to open a tab.
        // A function, not a map: rolldown only accepts the callback form.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (id.includes('@supabase')) return 'supabase'
          return undefined
        },
      },
    },
  },
  define: {
    __SCHEMA_EXPECTED__: JSON.stringify(newestMigration),
    // The count, because the newest id alone cannot see a gap in the middle:
    // a database missing 0026 but holding 0028 reports the same maximum as one
    // holding both.
    __SCHEMA_COUNT__: expectedMigrations.length,
  },
})
