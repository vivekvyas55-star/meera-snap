# Meera

A Snapchat-style ephemeral messaging app that runs in mobile Chrome. Camera-first,
real multi-user messaging, disappearing snaps, streaks, and stories.

Static frontend (React + Vite) on top of Supabase — no server for you to run.

---

## Setup

### 1. Create a Supabase project

<https://supabase.com/dashboard> → **New project**. Any region; the free tier is enough.

### 2. Run the schema

Dashboard → **SQL Editor** → **New query** → paste the whole of
[`supabase/schema.sql`](supabase/schema.sql) → **Run**.

This creates the tables, row-level security policies, the streak trigger, the
realtime publication, and the private `media` storage bucket. It is idempotent,
so re-running it after a schema change is safe.

### 3. Turn off email confirmation

Dashboard → **Authentication → Sign In / Providers → Email** → disable
**Confirm email**.

This is required. Accounts are keyed by username and mapped onto synthetic
`username@meera.local` addresses that no mail server can deliver to, so a
confirmation step would lock every user out.

### 4. Point the app at your project

```bash
cp .env.example .env
```

Fill in both values from **Project Settings → API**:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

The anon key is safe in a frontend bundle — it is the public key, and row-level
security is what actually protects the data.

### 5. Run it

```bash
npm install
npm run dev
```

---

## Installing on a phone

Meera is a PWA, so it installs from a link with no app store, no Apple
Developer account, and no 90-day rebuild.

**iPhone — must be Safari.** Open the URL in Safari → Share → **Add to Home
Screen**. Chrome, Firefox and Edge on iOS are WebKit wrappers with no install
affordance, so the in-app banner tells those users to switch to Safari.

**Android** — Chrome shows an install prompt; the in-app banner offers a
one-tap Install button.

Installed, it launches fullscreen with its own icon and no browser chrome. The
camera works: `getUserMedia` has been available to standalone iOS PWAs since
14.3.

### Why not a native `.ipa`?

iOS will not install an app from a downloaded file. Distributing outside the
App Store means TestFlight ($99/yr, review required, builds expire every 90
days), Ad Hoc (each device's UDID registered, 100/year cap), or the Enterprise
program (needs a D-U-N-S, internal employees only — Apple revokes certificates
for public distribution). Wrapping the app in Capacitor solves packaging, not
distribution. The PWA is the only free, link-shareable route.

## Deploying

```bash
npm run build     # emits dist/
```

Upload `dist/` to Vercel, Netlify, Cloudflare Pages, or GitHub Pages. Set
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as build-time environment
variables in the host's dashboard — Vite inlines them at build time, so they
must be present when the build runs, not at runtime.

> **The camera requires HTTPS.** Mobile Chrome refuses `getUserMedia` on plain
> `http://` for anything but `localhost`. Every host above serves HTTPS by
> default; a bare IP address or a self-hosted `http://` box will render the
> whole camera half of the app non-functional.

### Testing on your phone during development

`npm run dev` binds to localhost only, and `http://192.168.x.x:5173` will not
get camera access. Use a tunnel that terminates TLS:

```bash
npx localtunnel --port 5173      # or: ngrok http 5173, cloudflared tunnel
```

Open the `https://` URL it prints on the phone.

---

## What it does

**Camera-first.** The camera is the middle of three swipeable panes — Chat on
the left, Stories on the right — matching Snapchat's layout. Swipe horizontally
or use the bottom tab bar. Capture, add a caption, pick a display timer
(1/2/3/5/10 seconds or ∞), then send to friends or post to your story.

**Ephemeral messages.** Snaps are consumed when opened; the recipient gets one
replay. Chats clear 24 hours after being opened. Long-press any message to save
it, which exempts it from deletion for both parties — the same contract
Snapchat offers.

**Status icons.** Arrows are what you sent, squares are what you received.
Solid means unopened, hollow means opened. Red is a snap, blue is a chat, and
the icon set covers Delivered / Opened / Received / Pending / Replayed /
Screenshot.

**Snapstreaks.** 🔥 with a day count, computed by a database trigger that
enforces the real rule: both friends must send each other a *snap* (chats do
not count) within each 24-hour window. Sending twice in a row does not advance
it. The ⌛ hourglass appears when the streak is within 4 hours of dying.

**Stories.** 24-hour expiry, coloured ring while unwatched and grey once seen,
tap-right to advance, tap-left to go back, press-and-hold to pause, auto-advance
to the next friend's story at the end.

**Typing indicators and presence.** Both ride on a Supabase Realtime channel
rather than the database, since they are transient by nature and should not be
persisted.

---

## Known limitation: screenshot detection

**The web has no screenshot API.** Native Snapchat receives an operating-system
signal when the screen is captured; a browser receives nothing.

`src/hooks/useScreenshotHeuristic.js` implements a best-effort approximation —
it watches for PrintScreen / Cmd+Shift+3-4-5 on desktop, and for the page being
hidden within seconds of a snap opening, which is what the Android and iOS
capture flows tend to cause. It will miss captures taken with a second phone,
with most Android gesture shortcuts, or by a user who simply knows to avoid it.

Treat the 📸 indicator as a courtesy signal, not a guarantee. **Nothing sent
through this app is actually unrecoverable** — the images live in Supabase
Storage until deleted, and "ephemeral" here is a UI contract, not a security
property. Do not present it to users as one.

## Not implemented

Snapchat's best-friend emojis (💛 gold heart, ❤️ red heart, 😊 smile, 😎, 😬)
depend on a private ranking model over interaction frequency that this app has
no equivalent of. Rather than fake them from unrelated data, `src/lib/status.js`
ships only the ones it can compute honestly: 🔥 streak, 💯 hundred-day streak,
⌛ expiring streak.

Also absent: video snaps (stills only), voice notes, group chats, filters and
lenses, and the map.

---

## Architecture

```
src/
  lib/
    supabase.js   client + the username→synthetic-email mapping
    db.js         every query, plus the pair-ordering and ephemerality rules
    status.js     status icon semantics and friend emojis
  hooks/
    useAuth.jsx              session + profile, username-based signup
    useCamera.js             getUserMedia, flip, frame capture
    usePresence.js           typing + "here" over a Realtime channel
    useScreenshotHeuristic.js  see the caveat above
  screens/        Auth, ChatList, Chat, CameraScreen, Stories
  components/     Avatar, StatusIcon, SnapViewer, Toast
supabase/schema.sql
```

**Pair ordering is the load-bearing convention.** Every pair-keyed table
(`messages`, `friendships`, `streaks`) stores the two user IDs sorted, enforced
by a `user_a < user_b` check constraint, so a conversation has exactly one
representation no matter who is looking at it. Always route through
`pairKey()` in `src/lib/db.js` rather than ordering by hand.

**Security lives in the database, not the client.** Every table has row-level
security on, so the anon key cannot read another user's messages even though it
ships in the bundle. When adding a table, add its policies in the same change.
