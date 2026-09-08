> Current implementation: see README.md and AUDIT-FIXES.md. The audit-fixes branch
> introduces ordered migrations, private signaling, exact seen-message receipts,
> transactional recovery setup, and separate provider/hook modules. Historical
> notes below describe earlier versions; do not replay their SQL instructions.
>
> **Live as of 9 Sep 2026.** The audit upgrade is applied to production
> (`mqxfggwncoazgmcswedi`), the `cleanup` worker is deployed and scheduled every
> 15 min, the frontend is deployed, and **Realtime public channel access is
> disabled** — every channel is now private. Migrations are applied through
> `202609080015_game_rooms.sql`; **0016 (egress), 0017 (schema_version), 0019
> (rematch) and 0020 (game score) are written and NOT yet applied** — verified
> by probing PostgREST, where a missing function answers `PGRST202` and an
> existing one answers `42501`. Note that `PGRST202` also fires on an argument
> signature that does not match, so probe with the real parameter NAMES or an
> existing function reads as missing;
> the credit meter's monthly charge is scheduled (pg_cron job 5, 01:00 UTC), and
> `billing_settings.enforced` is still **false** — nothing is gated on credit
> yet. Smoke tested on a real device on 7 Sep 2026 — everything passed except a
> two-device call, password recovery, and Android hardware Back, which still
> need the hardware. See the checklist at the end of AUDIT-FIXES.md.

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
npx vitest run   # component + unit tests (74)
npm run test:db  # runs EVERY migration in supabase/migrations/ against PGlite
```

Requires `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; the app
throws on import without them. Copy `.env.example`.

Deploy with `vercel deploy --prod --yes --scope meeraapplication`, then confirm
the deployment is aliased to `meera.bigadtruck.com` (`vercel inspect <url>`) —
a deploy that is not aliased is not live. **Verify the served bundle, not the
deploy output:** fetch the page and grep the built asset for a string only the
new code contains. The service worker is network-first for navigations but
cache-first for other GETs, so `fetch('/')` from the page can return the OLD
shell while the rendered page is current — read `document.querySelector('script[src]')`
instead of trusting a fetch.

## Architecture

Three swipeable panes — Chat / Camera / Stories — paged by a CSS transform in
`App.jsx`, camera in the middle. `Chat.jsx` replaces the whole shell when a
conversation is open rather than rendering as a fourth pane.

- `src/lib/db.js` — all queries, pair ordering, ephemerality rules
- `src/lib/status.js` — status icon semantics, friend emojis
- `src/hooks/` — auth, camera, presence, screenshot heuristic. **Providers and
  hooks are separate modules** (`AuthProvider.jsx` + `useAuth.js`, likewise for
  call / presence / alias clock), so a file exports either components or hooks,
  never both — mixing them breaks fast refresh and the lint rule.
- `src/lib/privateRealtime.js` — authenticated signaling; every topic has exactly
  one authorised writer
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

**PostgREST caps result rows (~1000) — never load an unbounded ascending list.**
`listMessages` loads a conversation NEWEST-first with a `MESSAGE_PAGE` (200)
limit, reverses for display, and pages older history in on scroll-up
(`loadOlder` in `Chat.jsx`, prepending while holding scroll position). This was a
real production incident: the original query ordered `created_at` **ascending
with no limit**, so once the busiest chat passed 1000 messages the cap returned
the *oldest* 1000 and silently **clipped the newest** — new sends and replies
stopped appearing (looked like "sending is broken" with no error, on that one
chat only). Realtime INSERTs are appended to state (not a full reload) so
scrolled-back history isn't lost when a message arrives.

A page is filtered by `isVisibleTo` *after* it is fetched, so a page can come
back **entirely empty** while visible history still exists further back (every
message in it already cleared for this viewer). Returning that empty page
dead-ends the UI: Chat renders "Nothing here yet" and has nothing to scroll, so
the scroll-up handler that would fetch the next page never fires. `listMessages`
therefore keeps pulling pages until something is visible, bounded by
`MAX_EMPTY_PAGES` so one open can't turn into an unbounded fetch loop.

**Streaks are computed in the database**, by the `bump_streak` trigger — not in
JS. The rule is intentionally friendlier than Snapchat's snaps-only version:
both sides must send **any real message** (chat / snap / voice / sticker — not
call logs) within each **~36h window**, and a one-sided burst does not advance
the count. It advances at most once per ~20h (once a day). Real usage showed the
snaps-only 24h rule left pairs stuck at 1 (one person snaps, the other texts);
`streak_fix.sql` broadened it to any two-way daily messaging with a forgiving
36h break. Client code reads `streaks` and calls `streakState()` (db.js, 36h
display window / 30h hourglass) for display only. `bump_streak` is redefined
across migrations — **last applied wins**; the current version is in
`streak_fix.sql`. The same last-wins rule applies to `clear_viewed_chats`,
`mark_chats_opened`, `record_snap_open`, etc. — grep all `supabase/*.sql` for a
function before assuming `schema.sql` holds the live definition.

**Auth uses synthetic emails.** Usernames map to `username@meera.local` via
`emailForUsername()`. Email confirmation must stay disabled in the Supabase
dashboard or signups break — that domain cannot receive mail. Profile rows are
created by the `on_auth_user_created` trigger and can land a moment after the
session, which is why `useAuth` retries the profile fetch.

**Typing and presence are Realtime broadcast, never database rows.** Persisting
them would be both wasteful and wrong.

**Realtime is private-only — every channel needs `{ config: { private: true } }`.**
"Allow public access to channels" is **disabled** on the project, so a channel
opened without that flag never subscribes and the feature silently goes dead.
This applies to `postgres_changes` subscriptions too, not just broadcast and
presence — that was the last thing caught before the switch was flipped.

Authorisation is one database function, `public.realtime_allowed(topic, writing)`
(`supabase/migrations/202609060003_private_updates.sql`), which the policies on
`realtime.messages` call. The topic name *is* the access-control statement, so
the grammar is fixed:

| Topic | Writer | Reader |
|---|---|---|
| `updates:<me>:<label>` | nobody (read-only) | `<me>` — own `postgres_changes` |
| `online:<id>` | `<id>` | `<id>` + accepted friends |
| `signal:<recipient>:<sender>` | `<sender>` | `<recipient>` (accepted friends only) |
| `typing:<recipient>:<sender>` | `<sender>` | `<recipient>` (accepted friends only) |

Each topic therefore has exactly **one** authorised writer, which is why
`privateRealtime.js` derives a message's sender from the topic it subscribed to
and never from the payload. A peer cannot claim to be someone else. Adding a new
channel means adding a branch to `realtime_allowed` in the same change, or it is
unreachable.

**A denied camera is two different situations and must be told apart.**
`getUserMedia` reports "the user dismissed the prompt this once" and "this
origin is blocked forever" identically as `NotAllowedError`. `useCamera` probes
`navigator.permissions.query({ name: 'camera' })` to separate them and exposes
`errorKind` (`insecure` / `unsupported` / `denied` / `notfound` / `other`) plus
`blocked` (`true` / `false` / `null` when unknown). A **Try again** button is
offered only where trying again can work; a hard block, an insecure context and
an unsupported browser get instructions instead, because a button that will
fail identically forever is worse than no button. `retry()` must stay reachable
**only from a tap** — no effect, timer or automatic re-request — or it
reintroduces the repeated permission prompts that acquire-once was built to fix.

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

`schema.sql` is the base. Additional migrations applied on top (roughly in
order — functions get redefined, so **last applied wins**; grep before trusting
any one file):
`hardening.sql` (security), `chat_vanish.sql` → `chat_views.sql` (ephemeral
chats), `composer.sql` (voice/sticker kinds), `features.sql` (message reactions +
makes the ad-hoc `avatar_emoji` column reproducible), `mark_read.sql` (atomic
mark-incoming-read on open), `repair.sql` (rebuild drifted columns/RPCs),
`stories_fix.sql` (stories INSERT grant + 48h expiry), `ephemeral_media.sql`
(voice/stickers clear like chats — the current 3-visit `view_leaves` model),
`chat_backup.sql` (3-day backend backup), `memories.sql` (private saved-snaps
gallery), `bots.sql` + `cron.sql` (motivation bots — 5 seed bot accounts DM a
daily quote to real users via pg_cron, 01:30 UTC; run `cron.sql` standalone, not
batched), `call_log.sql` (adds `'call'` to the messages kind check),
`snap_map.sql` (opt-in `locations` table, Ghost Mode default), `security_qa.sql`
(security-question password recovery), `call_fix.sql` (call-log constraint +
mark-opened fix), `security_qa_hardening.sql` (recovery: reject empty answers,
guess lockout, cost-10 bcrypt), `core_fixes.sql` (call-log clear, streak
cadence, snap-score RPC), `streak_fix.sql` (streaks count any two-way daily
messaging, forgiving 36h — supersedes the streak logic in `core_fixes.sql`),
`reply.sql` (adds `messages.reply_to` for quoted replies), `anniversaries.sql`
(`anniversaries` pair table for "days together"; seeds vivek+sneha **2018-05-28**
— `started_on` is the START date: together since 28 May 2018, so the 4-year mark
landed on 28 May 2022. It is NOT the milestone date; the counter derives years),
`charms.sql` (`friendship_charms(other)` RPC — fun per-pair stats; night/day in
IST), `bot_quotes_lock.sql` (security-audit fix: RLS **on** + grants revoked on
`bot_quotes`, so no signed-in user can inject a quote that `send_morning_quotes`
would DM to everyone as a trusted "bot"; that RPC is SECURITY DEFINER and keeps
working), `recovery_hardening_2.sql` (**revokes sessions on password reset**,
rolling guess-lockout window, snap score scoped to self+friends — supersedes
`reset_password` in `security_qa_hardening.sql` and `get_snap_score` in
`core_fixes.sql`), `chatlist_perf.sql` (`latest_messages(per_pair)` RPC + a
`(user_a, user_b, created_at desc)` index, so the chat list is one query rather
than one 200-row page per friend), `memories_thumbs.sql` (`memories.thumb_path`
— the grid loaded full-size originals into ~120px tiles), `push.sql`
(`push_subscriptions` for Web Push), `together.sql` (birthdays, status notes,
question of the day). **Superseded
(historical, do not trust as
current):** `snap_reopen.sql` (said 3 reopens/4 views; live `SNAP_MAX_OPENS`=6 =
1+5) and `chat_recall.sql` (two-stage delete, replaced by the `view_leaves`
counter).
Apply new migrations via the Supabase SQL editor; they're written idempotently.

**The frontend and the database cannot silently drift**
(`202609080017_schema_version.sql`, `lib/schemaVersion.js`). `schema_migrations`
records every applied migration; `schema_version()` returns the newest id and is
the one thing there granted to authenticated. `vite.config.js` stamps the
newest migration in the repo into the bundle as `__SCHEMA_EXPECTED__`, and
`SchemaDriftBar` compares them once after sign-in.

- Ids sort **lexically**, which works because every migration is
  datestamped-then-named — the same order the SQL editor applies them in and the
  same one `tests/database.mjs` enumerates.
- Only **`database-behind`** is announced. A migration applied while the deploy
  is still in flight is the normal state for a few minutes.
- It **fails open in every direction** — no RPC, no session, no network, all
  report `unknown` and say nothing. A drift check that can stop the app from
  starting is a worse trade than the drift it watches for.
- **Every migration after 0017 must end by registering itself**
  (`insert into public.schema_migrations(id) values ('<its own id>') on conflict
  do nothing;`). `tests/schema-contract.test.js` fails the build if one does
  not. Earlier files cannot: the table does not exist when they run, so 0017
  backfills them.

This is the half `tests/schema-contract.test.js` structurally cannot cover — it
checks the repo against itself and never talks to production.

**The client/schema contract is a test** (`tests/schema-contract.test.js`).
Three features shipped in halves — a client calling an RPC no applied migration
defined, or a migration applied with no client to use it — and each time it
looked like the feature was simply broken. The test now fails the build if any
`.rpc('name')` in `src/` has no `create function name(` in
`supabase/migrations/`, if any `.from('table')` has no `create table`, or if
`tests/database.mjs` stops enumerating the migrations directory.

`tests/database.mjs` **enumerates `supabase/migrations/` rather than listing
files**. It used to apply a hand-written list, which silently skipped four
migrations — they had never once been executed against a real Postgres, so a
broken one would have reached production having passed every check. Two things
make enumeration work under PGlite: a preamble that stubs the managed-platform
pieces (`vault.secrets` / `decrypted_secrets` / `create_secret`, and a
`net.http_post` that returns a fake request id), and a `create extension …;`
strip on the follow-up chain — `pg_net` does not exist in PGlite and the rest of
that migration still has to run. Don't stub `extensions.crypt`/`gen_random_bytes`
there: the baseline installs real pgcrypto **into the `extensions` schema**, and
a preamble wrapper referencing it fails at creation time (the preamble runs
first).

**`recovery_hardening_2.sql`** — (1) `reset_password` changed the password but
left `auth.sessions`/`auth.refresh_tokens` alone. GoTrue only checks the password
at *sign-in*, never on refresh, so a session opened with the OLD password kept
refreshing forever after a "recovery" — exactly the session you run recovery to
kill. It now deletes the user's sessions in the same transaction. (2) The
`attempts` counter never decayed, so after 5 lifetime wrong guesses every later
miss re-armed a 15-min lock — and since `get_security_question` is anon-callable
(by design: the reset screen must show the question), anyone could keep a
stranger's recovery locked out forever. `last_attempt_at` makes it a rolling
window. (3) `get_snap_score(target)` took any uuid from any signed-in caller;
it's now self-or-accepted-friend, returning 0 otherwise.

**`chatlist_perf.sql`** — `latest_messages()` returns the newest few rows per
conversation (SECURITY INVOKER, so RLS still scopes it) in one round trip.
ChatList used to call `listMessages` **per friend**, each a 200-row page, and it
re-runs on every unfiltered `postgres_changes` event on messages / friendships /
streaks / profiles — i.e. a full N×200 refetch per message received. It returns
several rows per pair, not one, because visibility is decided client-side by
`isVisibleTo`; the row needs depth to fall through already-cleared messages.
`listLatestPerFriend` (db.js) degrades to a preview-less list if the RPC is
missing, so an unapplied migration doesn't blank the screen.

**`security_qa.sql`** is password recovery without email (synthetic emails can't
receive mail). `security_questions` holds a bcrypt-hashed answer; the client can
NEVER read the hash (`revoke select` + SECURITY DEFINER RPCs). `reset_password`
(anon-callable) verifies the answer and updates `auth.users.encrypted_password`
directly via pgcrypto `crypt(..., gen_salt('bf'))` — GoTrue and pgcrypto both use
bcrypt, so the new password works at next login (verified end-to-end in a
rolled-back txn). Set at signup, in Profile (existing users), or via reset.
`security_qa_hardening.sql` closes a takeover hole (empty/whitespace answers
matched a blank guess — rejected in BOTH RPCs since the anon key can call them
directly), rate-limits guessing (5 wrong tries → 15-min lock, via
`attempts`/`locked_until` on the un-SELECTable row), and raises the answer
bcrypt cost to 10.

**`core_fixes.sql`** — (1) `clear_viewed_chats`'s `sender_id = auth.uid()` clause
is scoped to `kind='snap'` so a caller's own **call log** is never swept into the
3-visit clear (it was vanishing for the caller once `call_fix.sql` let call logs
get `opened_at`); `isVisibleTo` also short-circuits `kind==='call'` before the
`cleared_by` check. (2) `bump_streak`'s once-per-window guard relaxed 24h→20h so a
pair snapping at a steady daily time isn't blocked (~23.5h<24h) and the streak
stops under-counting. (3) `get_snap_score(target)` RPC counts the target's snaps
across THEIR conversations — a friend's score can't be computed client-side under
RLS (it counted the caller's own activity).

**`call_fix.sql`** — `logCall` stores call duration in `messages.view_seconds`,
which the `view_seconds_sane` check (1..60) rejected for missed (0s) and >60s
calls; the failure was swallowed by useCall's `.catch`, so those call logs
silently never wrote. The constraint now exempts `kind='call'`, and
`mark_chats_opened` includes `'call'` so a call as the last message doesn't leave
a permanent unread badge.

**`chat_backup.sql`** copies every message into `private.message_backup` (a
schema PostgREST does not expose) via an AFTER INSERT trigger, kept 3 days,
purged hourly by pg_cron. The trigger's insert is wrapped in
`begin…exception when others then null` — a backup failure must NEVER roll back
a real message send (it's on the hottest path).

## Billing and the credit meter

Two migrations, both **inert until `billing_settings.enforced` is flipped to
true**. Turning that flag on is a deliberate act and nothing else in the repo
does it.

`202609070010_billing.sql` — `billing_settings` (one row), `billing_plans`
(monthly ₹99, annual ₹999), `subscriptions` (select-own RLS, no write policy —
the Razorpay webhook writes as service_role), `entitlement()` and
`start_trial()`. Every existing user is `status='grandfathered'`.

`202609070011_credits.sql` — the credit meter. **Written but NOT applied**;
money semantics get a human read before they touch production. Apply it in the
SQL editor, then `supabase/operations/schedule_credits.sql` separately (cron
statements have aborted batched transactions on some projects).

- **`credit_ledger` is append-only and the balance is `sum(delta)`.** There is
  deliberately no `credits` column anywhere. A mutable balance drifts the first
  time two writers race, and once it has drifted nothing can answer "why is
  this number what it is". If you need the number fast, use
  `credit_balance(uuid)` — do not cache it into a column.
- **`(user_id, period)` is unique** (partial index, `where period is not null`),
  where period is 'YYYY-MM'. That single index is what makes a double-fired
  cron, a retried transaction and a hand re-run of `post_monthly_credits()` all
  cost exactly one charge. Grants and adjustments carry period NULL and are
  exempt. A second partial index, `credit_ledger_one_grant`, makes a duplicate
  opening balance physically impossible — the migration's `not exists` guard is
  a convention, that index is the constraint.
- **Nobody signed in can write credits.** `credit_ledger` grants SELECT only,
  RLS scopes it to own rows, and the absence of UPDATE/DELETE grants is what
  makes the ledger append-only. `credit_balance(uuid)` is SECURITY DEFINER and
  therefore **not granted to authenticated** — granted, it would read anyone's
  balance from any caller. Clients get their number through `entitlement()`,
  which pins it to `auth.uid()`.
- `entitlement()` was **extended, not replaced**: same five columns plus
  `credits` and `credits_until`. Widening a `returns table` needs a `drop
  function` first, so the migration drops `start_trial()` and `entitlement()`
  and recreates both. Nothing in the database gates on `entitlement()` yet; if
  something ever does, that drop will fail loudly rather than leave a stale
  definition behind.
- `allowed` is true whenever billing is off, for grandfathered accounts
  regardless of balance, and for anyone whose balance still covers a month **or
  whose current month is already charged**. That last clause matters: taking
  the 99 credits and then cutting access the same day the balance dips below
  the next month's price is charging someone for a month they don't get. It
  also keeps `allowed` and `credits_until` telling the same story.
- **Periods are IST**, like `ist_date()` and the question of the day. A UTC
  month rolls over at 05:30 IST, which would charge a user for a new month in
  the small hours of the last night of the old one.
- Balances are allowed to go **negative**: `post_monthly_credits()` charges
  every non-grandfathered user whether or not they can afford it, so the ledger
  stays a complete record of the months an account was open. Access is decided
  separately. `creditsToMonths` treats negative as zero runway.
- New signups get 10,000 from a trigger on `profiles` insert — **its own
  trigger, not an edit to `handle_new_user()`**, which is redefined across
  migrations under last-applied-wins. Its insert is wrapped in
  `begin…exception when others then null` for the same reason
  `chat_backup.sql`'s is: a credits problem must never fail a signup.
- Client: `src/lib/billing.js` (`creditsToMonths`, `formatRunway`,
  `getBillingSettings`, `listCreditHistory`) still **fails open** — a missing
  RPC leaves `credits: null`, and the UI renders nothing rather than a
  confident zero. Plans shows the balance as the hero card and the rupee prices
  as context; Profile carries a lime credit tile that is also the only route
  into Plans. Credit maths is tested in `tests/credits.test.js`.
- **Never put `formatRunway()` in front of a user directly** — it only knows
  months, and a zero or negative balance is zero months, which it renders as
  "Less than a month". Both screens said that to someone with nothing, and on
  Plans the chip sat directly above "Out of credit. Top up to keep going."
  `runwayLabel(credits, perMonth)` is the one to call: 'No credit left' at or
  below zero, `null` (render nothing) when the balance is unknown. Likewise the
  price of a month falls back to `DEFAULT_CREDITS_PER_MONTH`, never to a `99`
  typed inline — two places quoting money from two constants is how they end up
  disagreeing.

## Blocking, device list, location expiry (`202609080018_privacy.sql`)

**A block is a database boundary, not a filter.** `blocked_between()` is added
to `messages_insert` and `friendships_insert`, so a blocked sender's write is
refused by RLS. It is SECURITY DEFINER on purpose: `blocks_read` shows a caller
only their OWN rows, so an inline `exists()` would be blind in exactly the
direction that matters — it answers only for pairs the caller is part of, so it
is not a general "is A blocking B?" oracle.

`block_user()` also **deletes the friendship**, and it has to: stories,
presence, call signaling and the push relay all gate on an accepted friendship.
A block that left that row would stop the texts and let the phone keep ringing.
`list_my_blocks()` exists because `profiles_read` needs a friendships row — once
blocked, the list would otherwise be a column of uuids.

Blocking does **not** retroactively hide delivered messages or scrub history.

**`FOR ALL` includes SELECT.** `locations_write` was `FOR ALL`, which made it a
second, expiry-free path to your own row — the new `expires_at is null or
expires_at > now()` in the read policy would have been bypassed by it. It is
split now. If you write a policy for writes, write `for insert` / `for update` /
`for delete`, never `for all`.

A `clear_spent_location_expiry` trigger resets a stale `expires_at` on any
sharing write: Snap Map's Share upserts lat/lng/sharing and never touches
`expires_at`, so an old timestamp would have left someone invisible with the
switch apparently on. `operations/schedule_location_expiry.sql` deletes expired
rows every 15 min — data minimisation, not enforcement, since the policy already
hides them.

**Per-device revocation does not exist and is not faked.** Supabase gives a
browser client no session list and no per-session revoke. `user_devices` records
browsers that have signed in (keyed by a stable `device_key`, or one phone
becomes forty rows in a week); "Forget" removes the row and says plainly that it
does not end that session. The only real action is
`signOut({ scope: 'global' })`, and the copy says it includes this phone.
`trackDeviceSessions()` is installed at module scope in `App.jsx` — Profile is
lazy-imported, so recording from the screen that lists devices would only ever
notice one after somebody opened Settings.

**The data export excludes messages other people sent you.** They are the
sender's, and ephemerality is a promise made on their behalf; turning them into
a permanent file would quietly undo it. Deletion takes the conversation from the
other person too — messages are pair-keyed with ON DELETE CASCADE on both halves
— and the UI says so first, not last.

`export_my_data()` / `delete_my_account()` use `to_regclass` guards and dynamic
SQL deliberately, so they can be CREATED on a database that is behind on later
migrations.

## Question of the day, status notes, birthdays (`together.sql`)

**Day boundaries are IST** (`public.ist_date()`), like `friendship_charms`.
"Today's question" has to turn over at the users' midnight, not UTC's. The
client mirrors it with `istToday()` in db.js (`Intl` with `Asia/Kolkata`,
`en-CA` so the format is the `YYYY-MM-DD` a Postgres `date` wants) — filtering
on the browser's own date would put someone past their local midnight on a
different "today" than the row they just wrote.

**The reveal rule is RLS, not UI.** You see their answer only once you've
written yours. `prompt_read` allows your own row always, theirs only when
`has_answered(...)` is true. That helper is **SECURITY DEFINER on purpose**: a
policy on `prompt_answers` that queries `prompt_answers` directly recurses
infinitely, and going through a definer function breaks the cycle. Don't
"simplify" it back into an inline EXISTS.

**A plpgsql parameter named like a column is ambiguous in UPDATE, but not in
INSERT.** `answer_question(question uuid, body text)` sat broken in production —
`update pair_questions q set answer = btrim(body)` raised *column reference
"body" is ambiguous*, so a pair question could be asked and never answered.
`ask_question` has the identical parameter name and works, because an INSERT's
VALUES list has no table columns in scope. Aliasing the table does not help: the
alias adds a qualified name, it does not remove the bare one. Read the argument
into a local before the table comes into scope (or qualify it as
`answer_question.body`) — do NOT rename the parameter, since PostgREST
dispatches on argument names and a rename breaks every client in the same
breath.

The reason it survived: the half of the feature the tests exercised was the half
that could not break. `tests/database.mjs` now answers one.

**There is deliberately no UPDATE grant on `prompt_answers`.** An answer is
final once written; being able to edit yours after seeing theirs would hollow
out the simultaneous reveal. The `unique (user_a, user_b, responder, on_date)`
constraint is what stops a double submit racing itself.

`prompts` is locked exactly like `bot_quotes` (RLS on, no policy, grants
revoked) — otherwise any signed-in user could inject a "question of the day"
shown to every pair. Clients read it only via `todays_prompt()`, which picks
deterministically from the day number so both people get the same one with no
schedule stored. **The prompt ids must stay contiguous from 1**; the modulo
indexes them directly, so deleting one leaves a day with no question.

`status_notes` puts `expires_at > now()` in the **read policy**, so a stale note
is invisible immediately rather than waiting on the purge.

`profiles.birthday` needed its own `grant update (birthday)` — hardening.sql
revoked table-wide UPDATE, so any new writable column fails with 42501 before
RLS is consulted. Only month/day is ever shown; the year is never rendered.

Snap Map's distance readout needs no schema — both coordinates are already on
the map, so `distanceKm` is pure client maths.

## PIN lockout and the decoy screen

`components/PinLock.jsx` — **3 wrong passcodes locks the app for 15 minutes**, and
during the lockout it renders `components/MarketDecoy.jsx` instead of the pad: a
generic markets/portfolio screen. A "locked out" message would confirm to whoever
is holding the phone that there is something here worth getting into; a dull
stocks app tells them they opened the wrong thing.

**The lock is MANDATORY and the passcode is changeable.** Meera does not open
without one. A device that has never had a passcode is seeded by `ensurePin()`
with `DEFAULT_PIN` (`9934`), so there is no state in which the pad can be
skipped and nothing to "set up" before first use. `lib/pinStore.js` keeps a
PBKDF2 hash (210k iterations, 16-byte random salt per device) in localStorage —
**the default is stored as a hash too**, never as plaintext. It can be changed
from Profile; it cannot be removed.

**A default that ships in the source is public knowledge.** Until the owner
changes it, the lock stops someone picking up the phone, not anyone who has read
the repo. That is said plainly in Profile — and **only** in Profile:

- The "you are still using the default" warning appears **behind** the lock,
  never on it. On the pad it would tell whoever is holding the phone exactly
  what to type.
- **"Forgot passcode?" is hidden while the default is in force.** There is
  nothing to have forgotten, and the link is a route past the pad (to a
  signed-out app, but a route). It appears the moment somebody sets their own
  code, which is the moment it can be needed.
- `usingDefaultPin()` reads a stored FLAG, not a comparison against
  `DEFAULT_PIN`, so nothing has to hold the plaintext to answer the question.
  Any call to `setPin()` clears it — including deliberately retyping the
  default, which is a decision rather than an oversight.

- **Device-local is deliberate.** PinLock renders before `AuthProvider`, so
  there is no session to check a server-side hash against, and a lock screen
  that needs the network is a lock screen that fails on a train.
- PBKDF2 is not what makes this hard to break — four digits is 10,000 wide and
  the three-try lockout is the real defence. It is there so that lifting
  localStorage off the device still costs compute. The comparison is constant
  time; a timing leak is the one attack a 4-digit code cannot survive.
- **Verification is now async** (~200ms), where it used to be a string compare.
  An attempt can still be in flight when the entry changes under it, so `live`
  discards an abandoned attempt rather than counting it as a wrong try. Do NOT
  add a guard ref for this: backspacing and retyping inside the derivation
  window finds it still set and the pad never checks again.
- **"Forgot passcode?" signs out locally** (`scope: 'local'`, so it works
  offline) and clears the hash. The hash exists only on that device, so without
  it a forgotten code strands the owner on their own phone. It gives nothing
  away — whoever taps it lands on the login screen, which is the boundary that
  actually protects the data.
- Where Web Crypto is missing (an insecure context) the pad says so and stays
  shut. Letting someone through because verification is unavailable would make
  the lock a suggestion.
- `PinPad.jsx` is shared by the lock screen and the set/change sheet, so the two
  cannot drift about how many digits a code has.
- **The app re-locks when it is backgrounded** (`RELOCK_GRACE_MS`, 30s). Without
  this the lock only ever applied to a cold start, which is no lock at all
  against the threat it exists for: a phone handed over with Meera already open,
  or merely sitting in the app switcher, walked straight into the conversations.
  Locking fires on `hidden` rather than on `visible` **on purpose** — that is
  before the platform snapshots the app for its switcher, so the thumbnail shows
  the pad and not an open chat. Returning inside the grace window lifts it
  silently, because the app loses visibility constantly (media picker, camera
  roll, an incoming call) and charging a passcode every time trains people to
  type it without looking. `hiddenTooLong()` treats a missing or unreadable
  timestamp as "too long": the failure mode must be asking for a code that was
  not needed, never skipping one that was.
- Counters live in **localStorage, not sessionStorage** — a lockout a reload or a
  fresh tab clears is not a lockout.
- The decoy shows **no countdown and no hint that a passcode exists**; the pad
  returns by itself when the timer expires, so the owner isn't stranded. There is
  deliberately **no secret bypass gesture** — one would make the 15 minutes
  fictional.
- `MarketDecoy` sets `document.title` and restores it on unmount, or the tab and
  app-switcher label would still read "Meera".
- Its CSS shares nothing with the ABC language (no lavender/lime, no light
  display headings, no vibrant rounded cards) and it re-implements the 420px
  phone-column media query — full-bleed on desktop while everything else is a
  phone column would itself be a tell. **Do not "bring the decoy on brand".**
- Every ticker is **invented** and the numbers are pseudo-random noise. It must
  not imitate a real broker's app, and it must never ask for a login, password
  or any other detail — it is a blank wall, not a trap. Nothing leaves the device.
- **Check invented names against real listings before shipping them.** The first
  version carried `SOLARA` and `MERIDA`, and SOLARA is a live NSE ticker.
  Fabricated prices attached to a real listed company is misrepresenting data
  about a real entity — it is the one thing that turns this from a dull wall into
  something harmful. `tests/decoy.test.jsx` holds a blocklist of real index,
  company, ticker and broker names and fails if any appears in the rendered text.
  No index is named at all; the only real-world facts are the two exchanges'
  trading HOURS, referred to generically, with no fabricated data attached.
- Quotes are a pure function of `(symbol, tick)` (`lib/decoyMarket.js`), so a
  re-render never reshuffles the screen — numbers that jump on every paint read
  as fake immediately.
- Digit grouping is hand-rolled for both Indian (`2,75,684.29`) and Western
  (`275,684.29`) conventions rather than `toLocaleString`, so it cannot depend on
  whatever ICU data the runtime happens to ship.

**What it does NOT hide** (don't oversell this): the home-screen icon and its
label, the manifest name, the URL, and browser history all still say Meera. The
decoy covers the *screen* on a lockout, nothing more. Like the passcode itself it
is deterrence against a casual snoop, **not security** — four digits with a
"forgot" escape hatch is not a boundary anyone determined would respect. Real
protection is the account login plus RLS.

## Web Push — the only way to reach a CLOSED app

Realtime needs an open page, so before push a call rang only if the friend
already had Meera open and a message produced nothing at all.

- `supabase/push.sql` — `push_subscriptions` (one row per browser, unique by
  endpoint). RLS is own-rows-only and that matters: endpoint + keys is enough to
  push to a device, so this is a **capability store, not metadata**.
- `supabase/functions/push/index.ts` — the sender. Implements VAPID (RFC 8292)
  and aes128gcm payload encryption (RFC 8291) with **Web Crypto only**, no npm
  deps to break under Deno. Verified by round-tripping a payload against a
  simulated browser subscription and checking the ES256 signature is 64-byte raw
  r||s (a DER signature is the classic silent failure — every push 401s).
- `src/lib/push.js` — subscribe/unsubscribe + `notify(to, kind)`.
- `public/sw.js` — `push` / `notificationclick` / `pushsubscriptionchange`.
  **Bump `VERSION` on every sw.js change** or browsers keep the old worker and
  new handlers never activate.

**Notification wording is composed SERVER-SIDE from a fixed vocabulary** (`KINDS`
in the function). The client sends only `{ to, kind }`. If the client could
supply the text, any friend could put arbitrary words on your lock screen under
Meera's name and icon. The sender's *name* is included (the payload is encrypted
end-to-end, so the push service never sees it) but message **content never is** —
a notification is a nudge, the app is where content lives. That keeps bodies off
the lock screen of a phone someone else is holding, consistent with
reverse-privacy and ephemerality elsewhere.

The function authorises on the caller's JWT and requires an **accepted
friendship** before pushing. Without that check it is an open notification relay
to any user id an attacker can name. It also prunes subscriptions on 404/410 —
the browser has discarded those, and dead endpoints otherwise accumulate and get
retried forever.

**Calls re-broadcast the invite every 3s while ringing** (`ringRepeat` in
useCall). The Realtime invite is transient with no retention, so a phone woken by
the push would otherwise open to silence — the single invite it missed is gone.
The `invite` handler ignores re-arrivals for the room it is already showing, or
they fall through to the glare branch and answer the caller with "busy".
`startCall` no longer refuses when a friend is offline; it rings, and only gives
up early if push reported zero deliveries AND they aren't in the app.

**Platform reality.** Android/desktop Chrome work from a normal tab. **iOS 16.4+
works only for a Home-Screen-installed PWA** — in a Safari tab `PushManager`
doesn't exist, so `blockedReason()` tells the user to install rather than showing
a toggle that cannot work. Permission must be requested **from a user gesture**
or Safari rejects it, which is why `enablePush()` is called straight off the tap
in Profile. Push is disabled in dev (no service worker), so test it against a
production build.

**Setup** (`VITE_VAPID_PUBLIC_KEY` in `.env`, private key in function secrets):
```bash
supabase functions deploy push
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
```
The public key ships in the bundle by design; the private key must never be in
`.env` or the repo.

## Egress is the scarcest resource — media is the whole bill

Free tier gives 5 GB/month. With ~250 MB stored and 17 users, egress was 1.11 GB
— i.e. the same media downloaded over and over. Three rules keep it down:

**Signed URLs are cached per path (`db.js signedUrl`).** `createSignedUrl` mints
a fresh token every call, so asking twice for the same object returns two
different URLs — and the browser's HTTP cache, keyed on URL, re-downloads the
bytes every time. Every re-opened snap, re-watched story and every Memories
thumbnail was a full re-download. `signedUrl` now returns the SAME string from
a module-level Map until it nears expiry (1h TTL, re-minted 5 min early). Call
`forgetSignedUrl(path)` when deleting an object. Do NOT "fix" this by shortening
the expiry for privacy: a short signed-URL life is not enforcement here (the
viewer has a Save button), and it costs real money.

**Downscale before upload, never after** (`lib/image.js`). Uploads run through
`downscaleImage` (1600px/q0.85 for snaps and memories, 1440px/q0.8 for stories —
a story is watched by every friend, so it's the most re-downloaded object in the
app). It is best-effort: any decode/encode failure returns the ORIGINAL blob, so
an optimisation can never turn into a failed send. Video can't be transcoded in
the browser and goes up as-is; the 50 MB picker cap in `Chat.jsx` is the only
guard there.

**Story row previews are derived from bytes already downloaded**
(`lib/storyThumbs.js`). `stories` has **no `thumb_path` column**, so the only
object in storage is the 1440px original. Pointing a 46px row tile at it would
re-download every friend's story on every visit to the pane. Instead the viewer
hands its decoded `<img>` to `rememberStoryThumb()` at `onLoad` — the egress is
already spent at that moment — and the ~96px frame is cached in localStorage.
The deliberate consequence: **an unseen story shows a flat tile, not a preview**,
because a preview of something you have never opened cannot be free. Fixing that
properly needs a `stories.thumb_path` migration (drafted, not applied — it must
also restate the column-scoped INSERT grant and teach `claim_media_cleanup`
about the new path, or thumbs get swept out from under live stories).

The viewer's `<img>` carries `crossOrigin="anonymous"` for this: a plain `<img>`
taints the canvas and `toDataURL()` throws. If a signed URL ever came back
without the CORS header the image would fail to load, so `onError` re-keys the
element and retries **once** without it, remembering that for the session.
Watching the story always beats having a thumbnail of it.

**Never render an original into a thumbnail.** `saveToMemory` writes a ~400px
JPEG to `thumb_path` next to the original, and the grid uses it (falling back to
`media_path` for pre-`memories_thumbs.sql` rows). Grid `<video>` needs
`preload="none"` or it fetches video data just to sit in a cell. Storage-side
image transforms would do this server-side but are Pro-only.

Uploads set `cacheControl: '86400'` (supabase-js defaults to 3600). Safe because
every upload gets a fresh uuid path — objects are immutable once written.

**Egress is now measured, in `ops_metrics`** (`202609080016_egress.sql`, daily
via `operations/schedule_ops_metrics.sql`). Be clear about what it is: Storage
downloads never touch Postgres, so Supabase's own transfer counter is NOT
readable from SQL and this does not pretend to read it. It measures everything
that *drives* the bill — bytes stored, bytes added per IST day, and a projection
that multiplies each story by the number of accepted friends its author has,
because a story is fetched once per friend while a snap is fetched once. That
multiplier is why egress looked inexplicable next to storage size. The table is
locked like `bot_quotes` (RLS on, no policy, grants revoked) and
`record_ops_metrics()` is operator-only; read it from the SQL editor with the
queries in the operations file. It is idempotent per day, so a retried cron and
a hand backfill both cost one row. A rolling week above a third of the 5 GB
allowance raises a WARNING into the Postgres log. If the projection and the
dashboard diverge badly, the gap is re-downloads — check the signed-URL cache
in `db.js` first.

**Grants gate writes before RLS.** Table-wide privileges were revoked in
hardening and re-granted per column/table, so any column the client writes needs
an explicit grant or the write fails with 42501 *before* RLS is even evaluated.
This silently emptied `stories` — its INSERT grant never took (see truncation
below) — so posting a story failed for every real user while the policy looked
correct. Verify writes with an **RLS-simulated insert** (`set local role
authenticated` + a `request.jwt.claims` sub, in a rolled-back txn), not by
reading the policy.

Also beware `.upsert(...)` **without `ignoreDuplicates: true`**: supabase-js
sends `ON CONFLICT DO UPDATE SET <all payload cols>`, which needs UPDATE on those
columns *even on the first, non-conflicting insert*. On a table whose UPDATE
grant is column-scoped (`story_views` grants UPDATE only on `screenshot_at`)
every call 42501s. Use `ignoreDuplicates: true` (→ `DO NOTHING`) for pure
presence rows — this is what `markStoryViewed`/`sendFriendRequest` do.

**Every client write is executed in `tests/database.mjs`** as a real
authenticated user, in a rolled-back transaction, under
`PASS every client write succeeds for a legitimate user`. Reading a policy
cannot catch a missing grant — the write has to actually run. Add a case there
whenever `db.js` or `push.js` gains an insert/update/upsert/delete, and
replicate what supabase-js sends: `ignoreDuplicates: true` is
`ON CONFLICT DO NOTHING`, its absence is `DO UPDATE SET` over **every** payload
column. Verified by mutation — revoking `update (birthday) on profiles`
reproduces the original production failure ("permission denied for table
profiles") and the test catches it.

**Watch for paste truncation.** Large migrations pasted into the Monaco SQL
editor have been silently truncated mid-statement, leaving columns/functions/
grants missing — the root cause behind several "bug" reports (including the
missing stories INSERT grant). After a big migration, verify the specific
objects it was meant to create.

## Gestures in the thread — which one wins

Six gestures share one bubble: tap, double-tap (❤️ tapback), long-press (action
menu, 420ms), swipe-left (reply), hold-to-reveal (scrambled own messages), and
the thread's own scroll. Three rules keep them apart, and all three have been
broken at least once:

- **Pointer events fire BEFORE their compatibility touch/mouse events**
  (`pointerdown` → `touchstart` → later `mousedown`). So a `pointerdown` handler
  cannot cancel a long-press by calling the press's clear function: the
  `touchstart` that follows re-arms the very timer it just cleared. That is
  exactly how the hold-to-reveal fix silently failed and the action menu kept
  opening over the text. `MessageRow` now *claims* the press in `pointerdown`
  (`suppressPress` ref) and `startPress` declines to arm — the only ordering that
  works. The claim is scoped to `.msg-body`, so long-pressing the name, the
  timestamp or the padding around the bubble still opens the menu; Unsend stays
  reachable on your own older messages.
- **Any movement over ~8px cancels the long-press**, horizontal or vertical —
  cancelling only on the swipe gate let a slow scroll pop the menu mid-drag.
- **A swipe that fires a reply sets `longPressed`** so the trailing click can't
  also open (consume) a snap; `startPress` clears it again on the next press.

## The thread's two "already seen this" sets

`Chat.jsx` keeps two id sets, and BOTH have to be seeded from the same three
places — the first completed `load()`, every `loadOlder()` page, and reaching
the bottom. Seeding one and not the other is the bug class here.

- `knownRef` — what must NOT play the `.msg-in` entrance animation. Seeded in
  `load()`, not during render: a render-time snapshot (`if (ref.current === null
  && messages.length) …`) absorbed the very first message in an empty
  conversation into "history", so it never animated, and React is free to throw
  away a render it has already run.
- `seenAtBottom` — what must NOT be counted by the "N new messages ↓" pill. The
  initial jump-to-bottom used to `return` without recording that it had caught
  you up, and paged-in history was never recorded at all, so one arriving message
  reported the whole loaded window: "38 new messages" on a chat you had just
  read, and "200 new messages" merely for scrolling back.

Regression tests for both, and for the gesture rules above, are in
`tests/chat.test.jsx` (jsdom has no layout, so the test gives `.thread` a real
`scrollHeight`/`clientHeight` via prototype getters — without that, "am I at the
bottom?" answers yes forever and none of it is testable).

## Android Back closes one layer at a time

`lib/backStack.js` + `hooks/useBackLayer.js`. Every screen or overlay that can
be dismissed registers itself as a layer — one history entry each — and Back
closes the innermost one. This was hand-rolled in App.jsx for exactly one level,
so Back from Memories, Plans or Play closed the whole Profile behind them, and
Back inside a chat sheet left the conversation.

`useBackLayer(open, onClose)` is the whole API. `Sheet.jsx` and the two viewers
call it themselves, so every sheet (Confirm included) and every snap or story
gets Back-to-dismiss without the call site doing anything — and a sheet written
later cannot forget to.

**Two synchronous `history.back()` calls do not go back two steps.** The second
is applied against a stack the first has not moved yet and is simply lost —
measured in jsdom, and specified the same way in browsers. Closing a parent
while a child is open drops two layers in one tick, so `dropLayer` batches the
steps into a single `history.go(-n)` on a microtask. That traversal fires
exactly **one** popstate however many entries it spends, so exactly one
acknowledgement is owed back — counting `n` there would swallow the user's next
real Back.

The `owed` counter is why a traversal we caused is never mistaken for a press:
`history.back()` is asynchronous, so its popstate can land after the user has
already opened the next screen, and "close the top layer" would then close the
wrong one. A boolean cannot do this job — two layers closing at once owe two
acknowledgements. `layers`, not `history.state`, is the accounting: a layer
already taken by a popstate is gone from the array and its entry went with it.

## Stacked sheets: Escape belongs to the top one

`components/Sheet.jsx` keeps a module-level stack and only the topmost sheet
answers Escape and traps Tab. `stopImmediatePropagation` does NOT achieve this:
listeners on the same node in the same phase run in the order they were **added**,
so the OUTER sheet — mounted first — answered first and closed itself, taking its
own child sheet down with it. Sheets really do stack (Kept Together inside the
friend sheet, `Confirm` inside both).

## One notification strip, ordered by priority

`components/NotificationStack.jsx` + `lib/notifications.js`. Install, the game
banner and the toast each used to pick their own bottom offset (safe+84,
safe+88, safe+96), so **any two on screen at once overlapped** and a two-line
install banner grew straight down into the tab bar. Offsets chosen
independently cannot be made to agree.

Everything now portals into one fixed strip and is sorted by CSS `order`, so no
notifier has to know what else is on screen. The strip is `column-reverse`:
priority 1 sits nearest the tab bar where the thumb and the eye are, and the
rest grow **upward, away from the bar**, which is what keeps the strip out of it
however much is in it. Priorities live in `lib/notifications.js` (offline 1,
game 2, toast 3, drift 4, install 5) — a value module, because a file that
exports both components and constants breaks fast refresh.

Add a notifier by wrapping it in `<StackSlot priority={PRIORITY.x}>` and giving
it **no positioning of its own**. The offline bar moved off the top of the
screen into the strip in the same change.

## Play is reachable from the conversation it is about

`components/PlayChip.jsx` + `lib/gameState.js`. Play used to exist only at
Profile → Play — three taps from the conversation, with nothing anywhere saying
a game was waiting. The chip sits in the relationship strip under the chat
header, **not in the header**, which at 320px has no width to give.

`playState(room, me, now)` is pure and tested because the states combine three
things that are easy to get backwards: who sent the invitation, whose turn the
revision implies, and whether the other person is still in the room.

- Turn order is derived **the same way `play_game_move` derives it** — the
  inviter is X and moves on even revisions. Any other rule eventually
  contradicts the server.
- **"Your turn" outranks "Friend is away."** You can play your move whether or
  not they are sitting there, so burying the actionable state behind news about
  them is the wrong trade.
- "Away" means *not in the game room* (presence stamped by `game_room()` on each
  3s sync, stale after `AWAY_MS`), which is a different question from the
  presence channel's online/offline.
- A finished, abandoned or expired room falls back to "Play" rather than
  offering to resume a board somebody already won.

Opening Play from a chat hands the room across in `sessionStorage`
(`meera:resume-game:<me>` with the peer AND the mark, or `meera:play-with:<me>`
when there is no room yet). **The mark must be carried:** the resume path used
to hardcode `X`, which would have let the recipient try to move on the inviter's
turn and be rejected by the server.

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

Ephemeral chats (`chat_vanish.sql` → `chat_views.sql` → `ephemeral_media.sql`):
unlike Snapchat's single view, a chat — and now also received **voice notes and
stickers** — is viewable across **3 visits**, then clears for that viewer only.
`clear_viewed_chats` covers `kind in ('chat','voice','sticker')` plus your own
sent **snaps** (scoped in `core_fixes.sql` — it must NOT catch `kind='call'`, or
a caller's call log vanishes after 3 visits); `mark_chats_opened` covers those
plus `'call'`. Call logs always persist — `isVisibleTo` short-circuits
`kind==='call'` before the `cleared_by` check.
`clear_viewed_chats` increments a per-user `view_leaves` counter and adds the
viewer to `cleared_by[]` once it hits 3, so it never vanishes for the other
party. The RPC must fire **exactly once per visit** — from Chat's unmount
cleanup ONLY. (It used to also fire in the Back handler; harmless under the old
idempotent RPC, but with the counter that double-counted and burned two of the
three views per Back.) Image snaps reopen up to `SNAP_MAX_OPENS` (1 view + 5
reopens); `isVisibleTo` hides consumed/cleared. Photo/video snaps render as a
consistent `.msg-photo` tile (same box across unopened/opened/saved).

Stories (`schema.sql` stories table): **48h / 2-day** expiry (was 24h). A
purge in `features.sql`/`hardening.sql` deletes expired rows + their media.
Posting requires the table INSERT grant (see Migrations) — missing it left the
table empty. Own stories show under "My Story"; friends' via the friends RLS.
**`StoryViewer` is keyed by author id.** It holds a within-author `idx`, and
advancing past the last story swaps the `group` prop while leaving `idx` where
it was — going from a 3-story author to a 1-story one indexed past the end and
threw on `story.id` before anything rendered. The key remounts it, resetting
`idx`. Auto-advance also lives in its own effect keyed on `elapsed`, never
inside the `setElapsed` updater: updaters must be pure, and StrictMode
double-invokes them in dev, which skipped every other story.

Emoji avatars: `avatar_emoji` on profiles; `Avatar.jsx` renders it over the
letter+hue fallback. Edited in the Profile screen (tap your avatar in the chat
list). Profile also shows a snap-score aggregate and friend count.

Rotating aliases (`lib/alias.js`, `hooks/AliasClockProvider.jsx` +
`useAliasClock.js`): each user shows a name that rotates through 3-5 aliases
derived from their name (VIVEK → V, 5, V5, KEVIV, KE), advancing every 30 min.
Deterministic on a global time bucket + per-user phase, so every viewer sees the
same alias at the same time with no backend. `@username` stays visible in the
send/add sheets as the stable handle. **Anything that SEARCHES people must go
through `matchesSearch(profile, query, alias)`, never the alias alone** — the
chat list's search box filtered on the current alias only, so looking for a
friend by the name or handle you actually know them by found nothing whenever
their alias happened to be "S5", and the same search worked or failed depending
on the time of day.

Live presence (`hooks/OnlinePresenceProvider.jsx` + `useOnlinePresence.js`): a
per-user private presence topic `online:<id>`, readable by accepted friends; the
chat list and chat header show a green dot for online friends, muted grey
otherwise. Transient, never persisted.

**`useAlias()` and `useOnline()` must stay `useCallback`-stable.** Both return a
*function*, and both are read inside `useCallback`/`useEffect` dependency
arrays. When they returned a fresh closure per render, every dependent callback
was invalidated every render: SnapMap's `load` re-ran on each render, refetching
all locations plus a `getProfile` per friend and calling `fitBounds` again —
which snapped the map back to fit-all and threw away wherever the user had
panned. They're now memoised on the alias bucket / presence set. If you add
another context hook that returns a function, memoise it the same way.
SnapMap additionally frames the map exactly once (`didFitRef`) and caches
author profiles, so a later reload can never move the viewport.

Chat media (`db.js sendSnapMedia`, `Chat.jsx onPickMedia`): the composer's +
button attaches a photo or video (file input, `capture` hint) and sends it as a
snap to that friend. Videos play once in `SnapViewer` (`onEnded` closes, no
countdown); images count down from `view_seconds` — media-picker snaps default to
**45s** (`sendSnapMedia`), camera snaps use the user-selected timer
(`CameraScreen` `TIMERS`, with an ∞/no-limit option). Own sent snaps have no
countdown. Messages show timestamps.

**Fun features built** (Snapchat-parity):
- **Friendship emojis** (`ChatList.jsx`): 🔥 streak count + ⌛ expiring (existing),
  plus 💛 on your best friend (highest streak) and 💯 at 100 days.
- **Snapcode** (`components/Snapcode.jsx`, `qrcode` dep): each user's code is a QR
  of `…/?add=<username>`. Scanned with a phone's native camera, it opens the app;
  `App.jsx` reads `?add=` once signed in and sends the friend request. No in-app
  scanner. In ＋ Add friend → "My Snapcode" tab.
- **Draw & text on snaps** (`components/SnapEditor.jsx`): doodle + movable text
  stickers over the captured photo, flattened into the outgoing blob by
  `compose()` (only when there are edits, else the original blob is sent). Works
  in the preview box's coordinate space, replicating `object-fit:cover`.
- **Colour filters** (`screens/CameraScreen.jsx` `FILTERS`): 6 CSS-filter looks
  (None / B&W / Warm / Cool / Vivid / Fade) as a chip row over the snap preview.
  The choice is applied to the preview (on the media only, not the tool chrome)
  AND **baked into the outgoing blob** via canvas `ctx.filter`, so the sent snap
  matches what you saw. **The bake is per LAYER, and the layers must match the
  preview exactly**: the preview filters the `<img>` and `.snap-edit-canvas`
  (doodle) but NOT `.snap-text` (plain DOM above them), so `SnapEditor.compose
  (filterCss)` filters photo + doodle then resets `ctx.filter = 'none'` before
  drawing text. Filtering the *flattened* result instead — which is what
  `applyFilter` did over compose's output — tinted text stickers that were never
  tinted on screen. `applyFilter` now only runs on the no-edits path, where
  there are no layers to distinguish. Canvas `ctx.filter` only exists in
  Safari 17+; `CTX_FILTER_SUPPORTED` feature-detects it and **hides the whole
  filter row where the bake is a no-op**, so an old browser can never ship an
  unfiltered photo that looked filtered.
- **Memories** (`screens/Memories.jsx`, `memories` table): a private, owner-only
  gallery of your saved snaps. 💾 Save in the camera; open from Profile to
  re-share to Story, save to device, or delete.
- **Voice / video calls** (`hooks/CallProvider.jsx` + `useCall.js`,
  `components/CallOverlay.jsx`, `lib/rtc.js`): 1:1 WebRTC. Signaling rides
  Supabase Realtime on **private per-writer topics** `signal:<recipient>:<sender>`
  (`lib/privateRealtime.js`) carrying the ring and then the SDP offer/answer +
  ICE. The sender identity is derived from the topic you subscribed to, never
  from the payload, so a peer cannot claim to be someone else. Media is P2P
  (STUN) or relayed (free OpenRelay TURN — swap for a dedicated TURN in
  production). Call buttons live in the Chat header;
  `CallProvider` wraps `Shell`, `CallOverlay` renders the ring + in-call UI.
  Caveats: needs real two-device testing (WebRTC can't be validated headlessly),
  and ringing only reaches a friend whose app is OPEN (closed-app ring needs Web
  Push — good on Android, unreliable on iOS PWAs). A missed/ended call writes ONE
  call-log message (caller-side, `loggedRef`-guarded); a transient WebRTC
  `disconnected` gets a `DISCONNECT_GRACE_MS` window before the call is ended, so
  mobile ICE blips don't kill live calls. See `call_fix.sql` for the constraint.
  There's a speaker/earpiece toggle (`setSinkId`), but **iOS Safari ignores it** —
  no earpiece routing on iOS is a web-platform limit, not a bug. A **ring sound**
  (`lib/ringtone.js`, Web Audio — no asset) plays on incoming (ringtone) and
  outgoing (ringback) calls; `primeRing()` (App.jsx) unlocks audio on the first
  tap since mobile autoplay blocks sound until a gesture. Incoming still also
  vibrates on Android; iOS has neither vibration nor closed-app ring.
- **Offline outbox** (`lib/outbox.js`): a chat that can't send (offline / network
  error, via `looksOffline`) is queued in localStorage and shown as "⏳ Pending";
  `Chat.jsx` flushes on mount and on the `online` event. `flushOutbox` is guarded
  against concurrent runs so a flapping connection can't double-send. It takes
  the signed-in `me` and returns `{ sent, dropped }`. **Only a `looksOffline`
  failure stops the flush** (order is preserved for the retry); any other error
  is permanent for that item — friendship removed, a *different account* now
  signed in so RLS rejects the row, constraint violation — and the item is
  dropped, with Chat toasting the count. It used to `break` on *every* error and
  never drop, so one undeliverable message at the head blocked the whole queue
  forever, across restarts, silently. Items for another account are dropped
  outright (unsendable here, and not ours to keep); items age out after 7 days;
  the queue is capped at 200.
- **Quoted replies** (`messages.reply_to`, `reply.sql`): **swipe a message left**
  or long-press → Reply; the composer shows a "Replying to…" bar, and the sent
  reply renders a quoted preview of the original (`repliedTo` looked up in the
  loaded window; falls back to "Message" if older). Carried through the outbox.
- **Forward** (`Chat.jsx` `MessageMenu` → `ForwardSheet`): long-press a message →
  Forward → tick one or more friends → Forward. Each recipient gets a fresh send
  (its own ephemeral message), not a shared reference, so the copies live and
  clear independently. **Text only** — the menu only offers Forward on
  `kind === 'chat'`; forwarding media would mean copying the storage object under
  the new sender's prefix, which isn't built.
- **Days together** (`anniversaries` table, `Chat.jsx` `togetherStats`): a
  per-pair "together since" date drives a "💛 N days together" chip above the
  thread (a special gradient chip on the anniversary date) and a Snap-Score-style
  card + date picker in the FriendSheet. This app is personal — built around the
  owner's real relationship — so this is a first-class feature, not a gimmick.
- **Friend options** (`Chat.jsx` FriendSheet): tap the chat header to view a
  friend's profile (avatar, alias, snap score via the `get_snap_score` RPC) and
  **remove friend** (`removeFriend` deletes the pair-keyed `friendships` row —
  old messages remain readable by both parties; unfriend is not an erase).
- **Reverse-privacy** (`Chat.jsx` `privacyBody`): your OWN sent chat text renders
  reversed after 60s ("how are you" → "uoy era woh") as an over-the-shoulder
  deterrent — display-only, sender-side only; the recipient always sees plaintext.
  NOT encryption (body is stored plaintext); never describe it as secure.
- **Open your own snaps** (`SnapViewer` / `isVisibleTo`): you can re-view snaps
  you sent (no countdown, no reopen limit); viewing your own never burns the
  recipient's open count (`record_snap_open` is guarded `sender_id <> auth.uid()`).
- **Snap Map** (`screens/SnapMap.jsx`, `locations` table, Leaflet +
  OpenStreetMap, no API key): opt-in location sharing. **Ghost Mode is the
  default** (`sharing=false`); a user has NO `locations` row until they tap Share.
  RLS `locations_read` returns your own row plus accepted friends who are
  `sharing=true` — both predicates required. Go Ghost DELETES the row (not just
  flips the flag) so no coordinates linger server-side (data-minimisation). This
  is the "ethical Snapchat" stance — honest defaults, no dark patterns.

  **The position refreshes while sharing is on** (`hooks/useLiveLocation.js`,
  `lib/geo.js`). It did not, once: `getCurrentPosition` was called in exactly
  one place — inside the Share handler — so the row froze at whatever coordinate
  you were standing on when you tapped it, and Go Ghost → Share was the only way
  to move your own dot. Friends' pins had the same shape of bug (`load()` ran on
  mount and on a toggle, nothing else).

  The rules the watch obeys, none of them optional:
  - **No watch when sharing is off.** The hook returns before it even checks
    permission. The app must never be asking the device where it is while the
    user is Ghost.
  - **No prompt without a gesture.** It starts only on `permissions.state ===
    'granted'`; `'prompt'`/`'denied'` render a line telling the user what to do.
    A `PERMISSION_DENIED` mid-session clears the watch permanently instead of
    retrying at a bubble the user already dismissed — repeated permission
    prompts were a real complaint, and a timer is how they come back.
  - **The watch stops on `visibilitychange` and on unmount.** A leaked
    geolocation watch is a battery bug and a privacy bug at the same time. The
    accepted cost is that a position can be one map-visit stale.
  - **`fixDecision()` in `lib/geo.js` is the whole "should these coordinates
    leave the phone?" rule**, pure and tested: 75 m minimum movement (scaled up
    by the fix's own accuracy, because a move smaller than the error bars is
    indistinguishable from noise), at most one write a minute, and a 10-minute
    heartbeat so "updated 4 min ago" stays an honest sentence. `enableHighAccuracy`
    is FALSE — the map reads out "4.2 km apart" and GPS precision would only keep
    the radio hot for a number nobody looks at.
  - `goGhost` clears the publish guard synchronously and `publishFix` re-checks
    it **after** its await, so a fix landing mid-delete re-deletes rather than
    silently resurrecting coordinates the user asked to remove.

**Recovery**: security-question password reset (see `security_qa.sql` above) —
signup collects a Q+A, existing users set it in Profile, "Forgot password?" on
the login screen runs username → question → answer + new password → auto login.

**Not yet built**: video draw/text. Infeasible in a web PWA and deliberately
skipped: AR lenses, native Bitmoji, reliable screenshot detection, My AI (the
user explicitly does NOT want an in-app AI assistant).

## Play Together — the board is in the database

`screens/PlayTogether.jsx`, reached from Profile. Two things: a solo dino runner
and a real-time 1:1 Tic-Tac-Toe. Migrations `202609070013_game_invites.sql`,
`202609080014_game_invite_responses.sql`, `202609080015_game_rooms.sql`.

**The series score is written by the statement that decides the result**
(`202609080020_game_score.sql`). `sender_wins` / `recipient_wins` / `draws` live
on the room next to the board, and `play_game_move` increments them in the same
`UPDATE` that sets `result`. Reaching that line means `result` was null on
entry, so a retried move cannot double-count, and a result cannot exist without
being counted. A separate history table would mean a second write that can fail
on its own. `rematch_game` deliberately does not touch the counters — carrying
the score across rounds is the entire point of keeping one.

**A finished game is not the end of the room** (`202609080019_rematch.sql`).
`rematch_game(invite)` starts the next ROUND in the same room, which keeps the
whole acceptance and authorisation story untouched. Before this a won board
dropped out of `active_game_rooms()` and offered only "Save & leave" — a second
game meant a fresh invitation and another acceptance for a room still open.

- **`revision` stays monotonic for the life of the room.** It is the optimistic
  concurrency token; resetting it to zero would make a stale client's
  `expected_revision` from the previous round look valid again in this one.
  Where the round began is recorded in `round_start_revision` instead, and moves
  this round are `revision - round_start_revision`.
- **The starter alternates by round.** X first every round hands the inviter a
  standing advantage — in this game the first player is the only one who can
  force a win. `public.game_turn(moves, round)` is the single definition, and
  `pieceToMove()` in `lib/gameState.js` mirrors it exactly. Drift shows up as a
  board that refuses the tap it just invited.
- The draw test is **nine moves this round**, not `revision = 9`. The old test
  would have declared a draw partway through round two and never in round three.
- `rematch_game` is **idempotent** — both players tap "Play again" on a game they
  watched finish together, and the second call must not skip a round past the
  first. It returns the row unchanged when there is no result yet, so it can
  never wipe a board still in play.
- `active_game_rooms()` now keeps finished rooms (they leave on end or expiry),
  so `accepted_game_invite_responses()` states `result is null` itself — it used
  to lean on that exclusion, and would otherwise put the "they accepted your
  invitation" banner back on screen every time somebody won.

**Realtime is a nudge, never the state.** The board lives in
`game_invites.board` (a `text[9]`) and every change goes through
`play_game_move(invite, square, expected_revision)` — SECURITY DEFINER,
re-checks the accepted friendship, derives whose turn it is from `revision % 2`
rather than trusting the caller, and detects the win itself. The `game_changed`
broadcast that follows carries no board; it only tells the peer to re-`sync`.
Broadcast is lossy and unauthenticated as to content, so a game played over it
would desync the first time a packet dropped and would let either side write the
other's move.

`revision` is optimistic concurrency: a move at a stale revision raises "Board
changed. Sync and try again", and a **replayed** move (same square, same piece,
revision already advanced by one) returns the row instead of raising — a retried
send after a flaky network must not read as an error.

**Signaling rides `signal:<recipient>:<sender>`, not a topic of its own.**
There is no `game:` branch in `realtime_allowed`, which is why Ludo is not built:
it would need one, added in the same change (see the Realtime table above).

**The invite poll must MERGE, never overwrite.** `active_game_rooms()` is polled
every six seconds, and the invitation broadcast arrives *before* that RPC can
see the row. Clearing `invite` from the poll made the invite card appear and then
vanish on its own — the entire "Play doesn't work" report. The poll now only
drops an invitation it can prove has expired.

An invitation is also mirrored into `sessionStorage` (`meera:pending-game:<me>`)
so a reload during the ring doesn't lose it, and a failed `resolveGameInvite`
leaves the card in place rather than entering a room that does not exist —
`tests/play-invitation.test.jsx` covers both.

**The runner physics live in `src/lib/runner.js`**, not in the component:
`createRun` / `step(run, dt, width, rand)` / `jump` / `scoreOf`, pure, with an
injectable `rand` so obstacle spawning is deterministic under test. A canvas
game is otherwise untestable, and the jump arc and collision box are exactly the
kind of thing that breaks silently.

## Design language — ABC (Behance) is the identity; follow it for ALL new UI

Meera's visual identity is the ABC language-app UI (Behance gallery 196137615).
This is the standard for every new screen/component — match it, don't invent.

**Palette** (defined as CSS vars in `src/index.css`):
- Ground: white `#ffffff`; neutral card `#f1f1f3`; ink `#16161a`; muted `#8a8a8e`.
- Vibrant fills — use BOLDLY as full card backgrounds, not just thin accents:
  lavender `--lavender #c4a5e8`, lime `--lime #d6e85a`, indigo `--indigo #4a52c4`,
  coral `--coral #e2664a`. (On a coloured card, text is ink; on indigo it's white.)

**Form**:
- Big rounded cards (radius ~20–24px), one vibrant colour per card, generous padding.
- Oversized LIGHT-WEIGHT (300) display headings; sentence/title case, tight tracking.
- Pill chips for metadata ("45s", "Snap Score", "Pre-intermediate").
- Dark near-black **circular** buttons for the primary action, white glyph (→, +).
- Dark floating **tab bar** (`.tabbar`) with thin-line icons (`components/Icons.jsx`).
- Circular quiet icon buttons (speaker/eye/heart/settings) on surfaces.

Icons live in `src/components/Icons.jsx` (thin 1.6px line, 24px grid) and already
match the reference set. Prefer these over emoji for chrome; emoji are OK for
content (reactions, avatars). When adding a surface, reach for a vibrant card +
light display heading + pill chips + a dark circular action, per the reference.

**Emoji are never chrome.** This has been enforced through the camera tray
(Save / Story / Send to), the Profile stat cards, the chat-list status note and
the chat header's "they're in this chat" marker — all now line icons. Reactions,
stickers, avatars, the 🔥 streak count and the 👻/💛 in body copy stay emoji,
because they are content.

**Spacing and type come from tokens** (`--sp-1..7`, `--fs-display` … `--fs-eyebrow`
in `src/index.css`). The sheet had accumulated 10/11/12/14/16/18/22px used
interchangeably and eight font sizes between 12 and 15.5px. The token values
were chosen to match what already shipped, so adopting one is never a visual
change — but new work must pick a step rather than invent a size. Radii are
`--r-card` / `--r-row` / `--r-tile` (grid thumbnails) / `--r-sheet` / `--r-pill`.

**Motion** lives in one block near the end of `index.css`. Sheets rise from the
edge they are anchored to (`sheet-up` + `scrim-in`), toasts and the offline bar
arrive from theirs, a message that lands while you are looking animates in
(`msg-in`), and a double-tap tapback throws hearts (`burst`). Every one is a
one-shot on mount, so the global `prefers-reduced-motion` rule — which collapses
all durations to 0.01ms — degrades each to the finished state; `HeartBurst` also
checks the media query itself and renders nothing rather than flashing.

**`msg-in` must only fire on arrivals.** `Chat.jsx` snapshots the ids present on
the first non-empty render into `knownRef`, and `loadOlder` adds every
scrolled-back page to it. Anything that introduces messages without going
through those two paths has to add its ids too, or opening a busy chat will run
two hundred entrance animations at once.

**The chat header has no spare width.** At 320px the back circle and the two
call buttons leave the friend's name about five characters, which is why the
"in the chat" marker rides the corner of their avatar (`.chat-peer-av` /
`.in-chat`) instead of taking a slot of its own. Anything new in that header has
to go on the avatar or into the friend sheet.

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
