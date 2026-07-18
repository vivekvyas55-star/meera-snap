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

## Live deployment

- **Production:** https://meera.bigadtruck.com (and https://meera-five.vercel.app)
- **Vercel:** account `vivekvyas55-6385`, scope `meeraapplication` (isolated — no
  link to the user's other accounts/NIT). Hobby plan.
- **Supabase:** project ref `mqxfggwncoazgmcswedi`, org `vivekvyas55-star`.
- Custom domain via Cloudflare: `meera` CNAME → vercel-dns (grey cloud) + a
  second `_vercel` TXT alongside the pre-existing one. Do not touch the other 13
  records (apex A, nit/srpce/www CNAMEs, Google MX/SPF).
- Deploy: `vercel deploy --prod --yes` (CLI is logged into the isolated account).

## Migrations

`schema.sql` is the base. Additional migrations applied on top, in order:
`hardening.sql` (security), then `chat_vanish.sql` (delete-after-viewing).
The `avatar_emoji` column was added ad-hoc. Apply new migrations via the
Supabase SQL editor; they're written idempotently. When adding a column that
the client writes, grant it explicitly (`grant update (col) ... to
authenticated`) — table-wide grants were revoked in hardening, so an
un-granted column silently fails to write.

## Overlays MUST be portaled

Any fullscreen overlay (`.sheet`, `.viewer`) rendered from a screen inside the
pager (CameraScreen, Stories, ChatList) **must** be wrapped in
`components/Portal.jsx`. The pager has a CSS `transform`, and a `position:fixed`
element inside a transformed ancestor positions relative to that ancestor, not
the viewport — which pushed sheets off-screen and made them render blank (the
"Send To shows nothing" bug). Portal re-parents them to `document.body`. On wide
screens the `min-width:560px` media query re-constrains portaled overlays to the
420px phone column. Chat.jsx is top-level (replaces the shell), so its own
SnapViewer would be fine either way, but is portaled for consistency.

## Snapchat parity notes

Delete-after-viewing (`chat_vanish.sql`): a chat clears for a viewer once they
open it and leave, via a per-user `cleared_by[]` (not the shared `cleared_at`),
so it never vanishes for the other party first. `clear_viewed_chats` RPC fires
on Back and on Chat unmount. `isVisibleTo` hides cleared/saved accordingly.

Emoji avatars: `avatar_emoji` on profiles; `Avatar.jsx` renders it over the
letter+hue fallback. Edited in the Profile screen (tap your avatar in the chat
list). Profile also shows a snap-score aggregate and friend count.

Rotating aliases (`lib/alias.js`, `hooks/useAliasClock.jsx`): each user shows a
name that rotates through 3-5 aliases derived from their name (VIVEK → V, 5, V5,
KEVIV, KE), advancing every 30 min. Deterministic on a global time bucket +
per-user phase, so every viewer sees the same alias at the same time with no
backend. `@username` stays visible in the send/add sheets as the stable handle.

Live presence (`hooks/useOnlinePresence.jsx`): a single global Realtime
presence channel every client joins; the chat list and chat header show a green
dot for online friends, muted grey otherwise. Transient, never persisted.

Chat media (`db.js sendSnapMedia`, `Chat.jsx onPickMedia`): the composer's +
button attaches a photo or video (file input, `capture` hint) and sends it as a
snap to that friend. Videos play once in `SnapViewer` (`onEnded` closes, no
countdown); images use the 3s timer. Messages show timestamps.

**Not yet built** (prioritized from the feature research): chat reactions +
replies, voice notes, snap text/draw/sticker overlays, Snapcode QR, Memories
gallery, opt-in Snap Map. Infeasible in a web PWA and deliberately skipped: AR
lenses, native Bitmoji, reliable screenshot detection.

## Design language

The UI follows an external reference (ABC app, Behance): white ground,
light-grey rounded cards instead of divider lines, oversized light-weight
(300) display type, a dark floating tab bar, and circular dark buttons for the
primary action on a surface. Accents — coral, lime, indigo, lavender — come
from that reference.

Snapchat's *interaction* grammar is kept even though its palette is not: status
icons still encode direction by shape (arrow = sent, square = received) and
state by fill (solid = unopened, hollow = opened), with screenshot as double
arrows and replay as a circular arrow. Those semantics live in
`src/lib/status.js`; only the tint was remapped onto the reference palette.

The camera and the snap/story viewers stay fullscreen black — immersive
surfaces, consistent with the reference's own dark elements.

## PWA

Installable to the home screen; this is the distribution route, since iOS will
not install a shared `.ipa` without TestFlight or per-device UDID registration.

- `public/manifest.webmanifest`, `public/sw.js`, icons in `public/icons/`
- `src/lib/pwa.js` — registration + platform detection
- `src/components/InstallPrompt.jsx` — Chrome install button vs iOS instructions

**iOS only installs from Safari.** Chrome/Firefox/Edge on iOS are WebKit
wrappers with no Add to Home Screen, so the prompt tells those users to switch
browsers rather than showing an install button.

**iOS ignores manifest icons** and uses `apple-touch-icon`, which must be PNG —
an SVG there yields a blank home-screen tile.

**The service worker never caches Supabase traffic** — only the app shell.
Caching messages or snaps would show already-deleted content and leave expired
snaps on the device. It is also disabled in dev (`import.meta.env.DEV`) to
avoid caching Vite's module graph.
