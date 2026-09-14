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
- [ ] Per-snap controls before sending: audience, expiry, replay limit. **Save
      policy is built but NOT live** — `202609140033_snap_save_consent.sql` is
      written and tested and has not been applied, so the sender's permission
      does not exist in production yet. Until it is applied, the recipient's
      export gate is the one the migration replaces, which the recipient could
      open for themselves by saving the snap in chat.
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

---

# Open audit findings — VERIFIED against the code, 9 Sep 2026

Not recalled. Each was re-checked in the source before being listed here, and
the ones marked fixed were removed rather than left ticked.

## Fixed and live
- Push endpoint SSRF + VAPID-JWT leak (host allowlist in SQL *and* before the
  fetch, fan-out capped) · unbounded `display_name` on the lock screen ·
  direct INSERT into `blocks` bypassing `block_user()` · a blocked user pinning
  the thread open via `toggle_saved` · `media_read` missing `thumb_path` ·
  Snap Map claiming Ghost Mode on a failed read · backgrounding killing a live
  call · the stuck-"Pending" second message · a declined call ringing again ·
  mic-denial leaving a 40s dead ring · "unavailable" on any push failure ·
  founders un-grandfathered · bot quotes repeating · bots being billed.

## Fixed just now, not yet deployed
- **Own sent snaps never cleared.** `leave_seen_messages` has a
  `kind='snap' and sender_id=auth.uid()` branch that was unreachable because
  Chat's observer only reported `chat`/`sticker`. They sat the full 31 days.
- **A status note written from a skewed client clock was invisible forever** —
  to everyone including its author, with no error. `together.sql` already
  defaults `created_at`/`expires_at` server-side and the read policy compares to
  server `now()`; the client was overriding both.
- **Three more failures masquerading as legitimate results** — "Seen by 0" to an
  author whose story people had watched, and an empty map indistinguishable from
  every friend being in Ghost Mode. Same class as the blocked list and Ghost
  Mode: **six instances now**, which is a codebase habit, not three accidents.

## Still open — verified present in the code
| Ref | Finding | Evidence |
|---|---|---|
| L5 | **Any user can read any profile's full `birthday`, year included.** `profiles_read` allows a read whenever ANY `friendships` row exists, and anyone can create a `pending` one naming any victim. CLAUDE.md's "only month/day is ever shown" is a client convention the database does not enforce. | `baseline.sql` `profiles_read` — no `accepted` check |
| L6 | `get_security_question` is an unrate-limited username oracle for anon, and 5 wrong guesses every 15 min can hold a specific user's recovery locked out forever. Denial of *recovery* only. | `baseline.sql:1362` |
| L8 | **Billing webhook has no event idempotency or ordering.** A delayed `subscription.charged` arriving after `subscription.cancelled` re-activates a cancelled subscription. Signature verification itself is correct. | no `provider_event_id` in `billing-webhook` |
| M13 | `entitlement()` denies an `active` subscriber whose `current_period_end` is NULL (`NULL > now()` → NULL → false). A webhook writing `active` without a period end locks out someone who just paid. | `202609070012` |
| M15 | ChatList and Stories `postgres_changes` handlers run **without checking `active`**, so every message anywhere re-runs a 7-round-trip load even while Chat covers the shell. Plus four independent polls. | `ChatList.jsx:91`, `Stories.jsx:60` |
| — | `pair_prompt()` and `todays_prompt()` disagree by 13 mod 30 (different epoch bases), so a client rendering one and submitting to the other always fails. **Latent only because `DailyQuestion.jsx` no longer exists.** | `202609060001:223` vs `202609060006:88` |
| — | A `pair_questions` row asked at 23:50 IST vanishes from both sides at midnight with an ask spent. | `pair_questions_today` |
| — | `credit_ledger_one_grant` is unique on `(user_id, reason)`, so one founding *and* one signup grant both fit — 20,000 credits. The `not exists` guard is the only real protection. | `202609070011:70` |
| — | `signOut` silently destroys undelivered outbox messages, with no confirmation. | `AuthProvider.jsx:93` |
| — | `outbox.read()` `JSON.parse`s unguarded — one corrupt key makes the composer permanently unusable on that device. | `outbox.js:18` |
| — | `stories.thumb_path` drafted, unapplied; without it an unseen story can never have a real preview. | — |

## Needing a decision from the owner, not a fix
- **Scheduled surprise messages** — plaintext for days, in an app that clears
  chats after three visits. Raised three times.
- **Push-delivery logs** — exactly the metadata the push function keeps none of.
- **End-to-end encryption** — the real gap behind "super safe". Message bodies
  are plaintext in Postgres today.
- **Razorpay**, and **moving off Vercel Hobby** (its terms forbid commercial use).
- **`push_subscriptions` is 0** and there is no record to say whether the
  security migration's cleanup removed something real. One test from a phone
  settles it.
- **Rotate the Supabase management token** shared in this session.
