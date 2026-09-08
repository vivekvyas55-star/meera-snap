# Meera — the working list

Status as of **9 Sep 2026**. `CLAUDE.md` says how things work; this says what is done.
**LIVE** = applied to production AND present in the served bundle — verified, not assumed.

---

## Live

### Reliability
- [x] Client/schema contract as a test — an `.rpc()` with no `create function`, a
      `.from()` with no `create table`, or a harness that stops enumerating, fails the build.
- [x] Every migration runs against real Postgres (four had never once executed).
- [x] Every client write executed as a real authenticated user — grants gate writes
      before RLS, so only performing the write catches a missing grant. Mutation-checked.
- [x] Migration version checks — the app says so when the database is behind the bundle.
- [x] Play RPCs verified live by probing PostgREST.
- [x] Realtime listener isolation — one throwing listener could silence an incoming call.
- [x] Dead-end pagination guard — a fully-hidden page left Chat with nothing to scroll.
- [x] Stable realtime deps — depending on the profile object tore listeners down constantly.

### Security and privacy
- [x] Passcode mandatory. Default `9943`, stored as a hash, changeable, not removable.
- [x] Re-lock on background — was cold-start only, so a handed-over phone with the app
      open walked straight in. Locks on `hidden`, before the app-switcher snapshot.
- [x] Default-passcode warning in Profile only; "Forgot passcode?" hidden until the
      code is the user's own.
- [x] Blocking enforced in RLS, and it deletes the friendship (stories, presence, calls
      and push all gate on one).
- [x] Device list + sign out everywhere, honest about what it cannot revoke.
- [x] Location sharing expiry, and the `FOR ALL` policy hole that bypassed it.
- [x] Export / delete account data. Storage usage.
- [x] Android Back closes one layer at a time.

### Cost
- [x] Egress measured daily, projecting each story against its actual audience.

### Features and fixes
- [x] Question of the Day could be asked but never answered (`"body" is ambiguous`).
- [x] Snap Map froze at wherever you stood when you tapped Share.
- [x] Play discoverable — Waiting for acceptance / Wants to play / Your turn /
      Friend is away / Accepted — Resume.
- [x] Rematch, with the starter alternating. Series scoreboard.
- [x] One notification stack (install/game/toast overlapped and covered the tab bar).
- [x] Chat rows carry one signal, not nine.
- [x] Stories / Camera / Map polish.
- [x] Privacy Centre — Profile grouped into six sections.

---

## In flight
- [ ] Profile UI/UX design pass — structure is right, visual pass is not done.
- [ ] Market decoy depth — India/US, Watchlist/Orders/Funds/Research, market-hours clock.

---

## Pending — never built

**Foundation**
- [ ] Realtime reconnect handling (failed channels wait for the poll).
- [ ] Offline queues beyond text — snaps, reactions, answers, profile saves still toast.
- [ ] Two-device smoke tests. Calls and Realtime have never been validated on two
      real devices. Needs hardware.
- [ ] Game chat unread badge counts only realtime inserts.
- [ ] Game resume from sessionStorage is not validated.
- [ ] Push that deep-links into the pending game.
- [ ] Push-delivery logs — **needs a decision**; it is exactly the metadata push keeps none of.

**Privacy**
- [ ] Mute and report (blocking is done).
- [ ] Per-snap controls before sending: audience, expiry, replay limit, save policy.
- [ ] WebAuthn / biometric unlock.
- [ ] Lock screen still exposed to assistive tech.
- [ ] **End-to-end encryption** — see below.

**Together layer**
- [ ] Timeline, milestones, scrapbook, pinned voice notes, anniversary cards,
      "On this day", a consistent "Private to you both" badge.
- [ ] Scheduled messages — **needs a decision**; plaintext for days in an app that
      clears chats after three visits.

**Play**
- [ ] Connect Four (first — proves the pattern generalises), Checkers, Word Duel,
      Would You Rather. Game chat/reactions/scheduled playtime. Ludo (needs a `game:`
      branch in `realtime_allowed`). Emoji chrome still mixed with line icons.

**Chat and Snap**
- [ ] One action sheet at 320px. Show audience/expiry/replay/save policy before sending.

**Design system**
- [ ] Consolidate `index.css`, fold in `src/styles/*.css`. Then dark mode.
- [ ] Skeletons instead of "Loading…". Sheet titles/handle/close. Captions sit at 50%
      and can cover the subject.

**Intelligence** (heuristics over metadata only — there is no on-device model here)
- [ ] Mood/status suggestions, gentle reminders, memory grouping. No content analysis
      unless both people opt in.

**Other**
- [ ] `stories.thumb_path` — drafted, not applied; without it an unseen story can
      never have a real preview.
- [ ] Deep links for notifications.

---

## Blocked on you
- [ ] Razorpay — account, live key, webhook secret, UPI Autopay rate card.
- [ ] Move off Vercel Hobby — its terms forbid commercial use.
- [ ] Two-device call test, password recovery on a fresh account, Android hardware Back.
- [ ] `billing_settings.enforced` is still `false`.
- [ ] **Rotate the Supabase management token** shared in this session.

---

## What "super safe" actually means today

The goal is that nobody but the two users can reach the content. The honest gap:

**Solid.** RLS is the real boundary and it holds — every table has policies, every
write is exercised as a real user in the harness, blocking is enforced there too.
Realtime is private-only with exactly one authorised writer per topic. The lock now
survives backgrounding, which was the biggest hole for a phone in someone else's hands.

**Not what it sounds like.**
- **Message bodies are stored in plaintext in Postgres.** Meera is not end-to-end
  encrypted. Anyone with database access — the host, anyone holding the service key,
  anyone who compromises the project — can read every message. This is the largest
  gap between "super safe" and what is true.
- The passcode and decoy are deterrence, not security. The default is public and four
  digits with a sign-out escape is not a boundary a determined person respects.
- Ephemerality is a UI contract. Bodies exist server-side until purged, and a backup
  copy lives three days.
- Reverse-privacy is display-only; screenshot detection is a heuristic.

**What would close it:** end-to-end encryption — keys on device, ciphertext on the
server. The costs are real and belong in the decision: no server-side search, no
content in push (already true), and messages unrecoverable if a device is lost
without a backed-up key. Substantial work, not a setting.
