# CLAUDE.md

Snapchat-style ephemeral messaging app for mobile Chrome. React + Vite static
frontend on Supabase (Postgres + Realtime + Storage + Auth). No backend server.

See [README.md](README.md) for one-time Supabase setup and deployment.

## Commands

```bash
npm run dev      # dev server on :5173
npm run build    # production build to dist/
npm run preview  # serve the built output
npx oxlint src   # lint
```

Requires `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; the app
throws on import without them. Copy `.env.example`.

## Architecture

Three swipeable panes — Chat / Camera / Stories — paged by a CSS transform in
`App.jsx`, camera in the middle. `Chat.jsx` replaces the whole shell when a
conversation is open rather than rendering as a fourth pane.

- `src/lib/db.js` — all queries, pair ordering, ephemerality rules
- `src/lib/status.js` — status icon semantics, friend emojis
- `src/hooks/` — auth, camera, presence, screenshot heuristic
- `supabase/schema.sql` — tables, RLS, streak trigger, storage bucket

## Conventions and gotchas

**Pair ordering.** `messages`, `friendships`, and `streaks` store the two user
IDs sorted, enforced by `user_a < user_b` check constraints. Always go through
`pairKey()` in `src/lib/db.js`. Ordering by hand will violate the constraint or
silently create a duplicate conversation.

**RLS is the security boundary.** The anon key ships in the client bundle;
row-level security is what actually stops one user reading another's messages.
Any new table needs its policies added in the same change, or it is either
world-readable or completely inaccessible.

**Streaks are computed in the database**, by the `bump_streak` trigger in
`schema.sql` — not in JS. The rule is Snapchat's: both sides must send a *snap*
(not a chat) within each 24-hour window, and a one-sided burst does not advance
the count. Client code reads `streaks` and calls `streakState()` for display
only.

**Auth uses synthetic emails.** Usernames map to `username@meera.local` via
`emailForUsername()`. Email confirmation must stay disabled in the Supabase
dashboard or signups break — that domain cannot receive mail. Profile rows are
created by the `on_auth_user_created` trigger and can land a moment after the
session, which is why `useAuth` retries the profile fetch.

**Typing and presence are Realtime broadcast, never database rows.** Persisting
them would be both wasteful and wrong.

**The camera needs a secure context.** `getUserMedia` fails on plain http off
localhost, which is the most common reason a deploy looks broken. `useCamera`
checks this and surfaces a specific error rather than failing silently.

**Screenshot detection is a heuristic and cannot be made reliable** — the web
has no screenshot API. See the caveat in README.md before changing or relying
on `useScreenshotHeuristic`. Ephemerality here is a UI contract, not a security
property; don't describe it to users as one.

**Mobile CSS.** `100dvh` not `100vh` (collapsing browser chrome crops the
camera), `env(safe-area-inset-*)` for notches, and 16px minimum font size on
inputs to stop iOS zooming on focus.
