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
- [ ] Biometric unlock — BUILT, not deployed and never tested against a real
      authenticator (there is no way to answer a Face ID prompt headlessly).
      An ADDITIONAL route past the pad: the passcode stays mandatory, the
      15-minute lockout is not bypassable, and the copy is honest that nothing
      verifies the assertion because there is no server to verify it.
- [ ] **Just us** — the five intimate games now have a client (FriendSheet →
      Just us, plus a neutral chip in the conversation). `202609090026` is still
      in `.unapplied`, so the feature hides itself in production until it is
      applied. Applying it means removing that line in the same change.
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
- [ ] Lock screen still exposed to assistive tech.
- [ ] **End-to-end encryption** — see below.

**Together layer**
- [ ] Timeline, milestones, scrapbook, pinned voice notes, anniversary cards,
      "On this day", a consistent "Private to you both" badge.
- [ ] **`202609140034_timeline_events` — written, NOT applied.** Typed milestone
      events (first snap/call/voice, mutually saved media, streak marks) recorded
      by trigger, per-type filters, and a purge on opt-out that deletes what the
      system observed and never what a person wrote. Two of the triggers sit on
      `messages`, the hottest write path, and it starts collecting a durable
      record of a pair — both want a human read first. Apply it, then
      `operations/schedule_together_purge.sql` standalone, then remove it from
      `.unapplied`. It also closes a live hole: a **blocked** pair currently keeps
      a working shared timeline, because `together_active()` counts opt-in rows
      and the block only deletes the friendship.
- [ ] Scheduled messages — **needs a decision**; plaintext for days in an app that
      clears chats after three visits.
- [x] Scheduled messages — **decided 15 Sep 2026** and built. Server-side
      plaintext, 7-day horizon in a CHECK, sender-only RLS, no media, exempt
      from the 3-day backup, cancelled on unfriend and on block, capped at 20
      per sender, disclosed in plain words in the compose sheet. Device-local
      was rejected (it fails silently, and localStorage behind a public default
      passcode is not more private); encryption was rejected (no key
      infrastructure — claiming it would be a claim the code does not back).
      **Migration `202609150040` is shelved**; applying it is a retention
      decision and the cron in `operations/` has to go with it. See CLAUDE.md.

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
| M13 | `entitlement()` denies an `active` subscriber whose `current_period_end` is NULL (`NULL > now()` → NULL → false). A webhook writing `active` without a period end locks out someone who just paid. **Still true in SQL.** The Billing screen now names the state (`subscriptionStanding` → `active-undated`) and explains it, so it can no longer present as an unexplained lockout — but explaining a bug is not fixing it. The fix is a decision about which side owns it: make `entitlement()` treat `active` with a NULL period end as covering (risking a subscription that never expires), or make the webhook refuse to write `active` without a date. The second is the honest one; it belongs with L8, since both are about a webhook that may write states nothing else validates. | `202609070012:146` |
| M15 | ChatList and Stories `postgres_changes` handlers run **without checking `active`**, so every message anywhere re-runs a 7-round-trip load even while Chat covers the shell. Plus four independent polls. | `ChatList.jsx:91`, `Stories.jsx:60` |
| — | `pair_prompt()` and `todays_prompt()` disagree by 13 mod 30 (different epoch bases), so a client rendering one and submitting to the other always fails. **Latent only because `DailyQuestion.jsx` no longer exists.** | `202609060001:223` vs `202609060006:88` |
| — | A `pair_questions` row asked at 23:50 IST vanishes from both sides at midnight with an ask spent. Unchanged — but the chat-list badge now expires on the same boundary (`pendingForDay`), so the row no longer advertises a question the panel cannot show. The two halves agree about the bug instead of contradicting each other. | `pair_questions_today` |
| — | `credit_ledger_one_grant` is unique on `(user_id, reason)`, so one founding *and* one signup grant both fit — 20,000 credits. The `not exists` guard is the only real protection. | `202609070011:70` |
| — | `signOut` silently destroys undelivered outbox messages, with no confirmation. | `AuthProvider.jsx:93` |
| — | `outbox.read()` `JSON.parse`s unguarded — one corrupt key makes the composer permanently unusable on that device. | `outbox.js:18` |
| — | `stories.thumb_path` drafted, unapplied; without it an unseen story can never have a real preview. | — |

## Needing a decision from the owner, not a fix
- **Scheduled surprise messages** — *decided and built, 15 Sep 2026.* What is
  left is one deliberate act: apply `202609150040_scheduled_messages.sql`, then
  `operations/schedule_scheduled_messages.sql` standalone, and take the id out
  of `.unapplied` in the same change. Until then the client hides the feature
  rather than failing at it.
- **Push-delivery logs** — exactly the metadata the push function keeps none of.
- **End-to-end encryption** — the real gap behind "super safe". Message bodies
  are plaintext in Postgres today.
- **Razorpay**, and **moving off Vercel Hobby** (its terms forbid commercial use).
- **`push_subscriptions` is 0** and there is no record to say whether the
  security migration's cleanup removed something real. One test from a phone
  settles it.
- **Rotate the Supabase management token** shared in this session.
