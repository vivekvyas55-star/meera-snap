# Meera — the working list

Everything discussed, so nothing is lost. Status as of **8 Sep 2026**.
`CLAUDE.md` stays the reference for how things work; this is what is left to do.

---

## Done

### Reliability foundation
- [x] **Client/schema contract as a test** — `tests/schema-contract.test.js`. Fails the
      build when an `.rpc()` has no `create function`, a `.from()` has no `create table`,
      or the SQL harness stops enumerating migrations.
- [x] **Every migration runs against real Postgres** — `tests/database.mjs` enumerates
      the directory. Four migrations had never once executed before this.
- [x] **Every client write executed as a real user** — grants gate writes before RLS, so
      the only way to catch a missing grant is to perform the write. Mutation-checked.
- [x] **Migration version checks** — `schema_migrations` + a build-time stamp; the app
      says so when the database is behind the bundle. Fails open in every direction.
- [x] **Game-room migration** — was already applied and live; the client shipped in
      `76b4ccf`. Closed as done, not built.

### Security and platform
- [x] **User-settable passcode** — was `9934` in the bundle for every user. Now chosen in
      Profile, PBKDF2 with a per-device salt, constant-time compare, opt-in lock.
- [x] **Android Back closes one layer at a time** — Memories, Plans, Play and every sheet
      were invisible to Back. Fixed a latent bug on the way: two synchronous
      `history.back()` calls only go back one step.

### Cost
- [x] **Egress measured daily** — `ops_metrics`, with a projection that multiplies each
      story by the audience it actually has. Warns into the Postgres log.

### UI
- [x] **Chat rows carry one signal** — nine competing signals down to name, unread
      state, presence dot and one, chosen by what you lose by ignoring it. The
      precedence is a pure tested function; the rest moved to the friend sheet.
- [x] **Stories / Camera / Map** — story row tiles and worded seen states, a one-shot
      tap/hold hint, camera Retry that distinguishes "dismissed once" from "blocked
      forever", and a map that says what it is sharing and until when.
- [x] **One notification strip** — install, game banner and toast each picked their own
      offset and overlapped. Now one container ordered by priority.
- [x] **Rematch** — a finished game starts the next round in the same room, with the
      starter alternating. Was a dead end.
- [x] **Play reachable from the conversation** — state chip in the relationship strip:
      Waiting for acceptance / Wants to play / Your turn / Friend is away /
      Accepted — Resume.

---

## In flight

- [ ] **Privacy Centre** — Profile regrouped into Identity / Shared moments / Play /
      Notifications / Privacy and lock / Account and data, plus active sessions and
      device logout, blocked contacts, location sharing duration, storage usage,
      export and delete, and saved-state feedback.
(Stories/Camera/Map and chat-list clutter landed — see Done.)

---

## Queued

### 1. Foundation (finish first)
- [ ] Reconnect handling — Realtime resubscribe and state resync after a drop.
- [ ] Offline queues beyond text — today only chats queue; snaps, reactions, question
      answers and profile saves fail with a raw toast.
- [ ] **Two-device smoke tests.** The highest-leverage item on this whole list: calls
      and Realtime have never once been validated with two real devices.
- [ ] Push-delivery logs — **needs a decision first.** A record of who was notified
      when is exactly the metadata the push function deliberately keeps none of. If
      it is for debugging: short retention, aggregates only.

### 2. Privacy Centre (remainder)
- [ ] Block, mute and report controls enforced in the database, not the client.
- [ ] Per-snap controls before sending: audience, expiry, replay limit, save policy.
      Mostly exposing machinery that already exists (`SNAP_MAX_OPENS`, `view_seconds`,
      `saved_by`, `screenshot_at`).
- [ ] WebAuthn / device biometric unlock. Worth having for how it feels — it is a
      nicer front door on the same device-bound lock, not a stronger one.

### 3. Together layer
- [ ] First-class pair surface: timeline, milestones, shared scrapbook, pinned voice
      notes, anniversary cards, "On this day".
- [ ] A consistent **"Private to you both"** badge across all of it.
- [ ] Scheduled surprise messages — **needs a decision first.** A scheduled message is
      a message sitting in plaintext for days, in an app where chats clear after three
      visits. Where it lives has to be answered before it is built.

### 4. Play Together
- [ ] **Connect Four** — drops almost unchanged onto the existing `board text[]` +
      `revision` pattern. Do this one first; it proves the pattern generalises.
- [ ] Checkers — same pattern, larger board.
- [ ] Word Duel — different animal: needs a dictionary in the bundle or an RPC.
- [ ] Would You Rather — not really a game; a content table, closer to the question
      of the day.
- [ ] Shared game presence: waiting / away / returned / your turn. (The chip already
      reads these; the game screen itself does not show them yet.)
- [ ] Game chat, reactions, rematches, scheduled playtime.
- [ ] Push that deep-links straight into the pending game.
- [ ] Ludo — needs a `game:` branch in `realtime_allowed`, added in the same change.

### 5. Chat and Snap controls
- [ ] On narrow phones, group stickers / voice / media / game / prompts into one
      action sheet. Message field and Send stay primary.

### 6. Design system
- [ ] Consolidate `src/index.css` — duplicate token and component overrides, and many
      screens still use inline styles. **This pass also folds in the per-feature
      stylesheets** (`src/styles/*.css`) that the parallel agents are writing now.
- [ ] **Dark / low-light mode.** The app forces light. A private messaging app used at
      night, next to fullscreen-black camera and viewers, should have a quiet dark
      theme. Do this after the consolidation, not before.

### 7. Privacy-preserving intelligence
- [ ] Local-only mood and status suggestions — **as heuristics over metadata** (time of
      day, streak state, who wrote first). There is no on-device model here, and
      shipping weights into a 490 KB PWA fights the egress budget. Call it heuristics.
- [ ] Gentle reminders from timing and activity metadata.
- [ ] On-device memory grouping and prompts.
- [ ] No message-content analysis unless both people explicitly opt in. Stay well
      clear of the in-app AI assistant line already drawn.

### 8. Daily polish
- [ ] **`stories.thumb_path`** — drafted in the capture pass, not applied. Without it
      an unseen story can never have a real preview; with it, `postStory` uploads a
      400px thumb and `deleteStory` must queue BOTH paths or every deletion orphans
      a file.
- [ ] Loading, retry, empty and offline states throughout.
- [ ] Faster chat list via server-filtered previews.
- [ ] Safer thumbnail and media access.
- [ ] Deep links for notifications.
- [ ] Reduced-motion and privacy-friendly lock-screen presentation.

---

## Blocked on you

- [ ] **Razorpay** — account, live key, webhook secret, written UPI Autopay rate card.
      Until then Plans says "Payment not connected yet", which is honest and terminal.
- [ ] **Move off Vercel Hobby** — its terms forbid commercial use. You cannot charge on
      the current host. Cloudflare Pages, where your DNS already is.
- [ ] **Two-device call test, password recovery on a fresh account, Android hardware
      Back on a real phone** — need hardware.
- [ ] **`billing_settings.enforced`** is still `false`. Flipping it is a deliberate act
      and nothing in the repo does it.

---

## Known and deliberate

- The passcode and the decoy are deterrence, not security. Real protection is the
  account login plus RLS.
- Ephemerality is a UI contract, not a security property.
- Reverse-privacy is display-only. Bodies are stored in plaintext.
- Screenshot detection is a heuristic and cannot be made reliable.
- No in-app AI assistant. Explicitly not wanted.
