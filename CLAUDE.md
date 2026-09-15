> Current implementation: see README.md and AUDIT-FIXES.md. The audit-fixes branch
> introduces ordered migrations, private signaling, exact seen-message receipts,
> transactional recovery setup, and separate provider/hook modules. Historical
> notes below describe earlier versions; do not replay their SQL instructions.
>
> **Live as of 9 Sep 2026.** Production is `mqxfggwncoazgmcswedi`. The `cleanup`
> worker runs every 15 min and **Realtime public channel access is disabled** —
> every channel is private. Six cron jobs. **3 real users** (plus 5 seed bots —
> any count of `profiles` without `where not is_bot` is wrong by five).
>
> Everything through `202609090032_audit_criticals` is applied except the ids in
> `supabase/migrations/.unapplied`. `billing_settings.enforced` is **false**, and
> all 3 real users are `grandfathered` regardless.
>
> **Before flipping `enforced`, read this:** nothing gates on `entitlement()` —
> not one policy, not one function besides `start_trial()`, and no client code
> reads `allowed`. So flipping it changes the copy on two screens **and will
> look like a success.** The real cutover is the day something reads `allowed`,
> at which point several known billing bugs fire at once. See ROADMAP.md.
>
> **To check what production actually has**, probe rather than assume. For the
> database: a missing function answers `PGRST202`, an existing one `42501` — but
> `PGRST202` also fires on a mismatched argument signature, so probe with the
> real parameter NAMES. For the frontend: compare the served `index-*.js` hash
> against a fresh local build, and scan EVERY chunk — Chat, Profile and SnapMap
> are lazy, so a live feature reads as absent from the entry bundle alone, and
> minified identifiers are renamed (grep string literals and class names).
>
> Smoke tested on a real device on 7 Sep 2026 — everything passed except a
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
npx vitest run   # component + unit tests (250+, and growing)
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

- **Compare the COUNT, not just the newest id.** The first version compared
  maxima only, and a migration missing from the MIDDLE is invisible that way:
  production had 0028 but never 0026, both sides reported `202609090028`, and
  the check said "match" on a database that was genuinely a migration short.
  That is exactly the half-deployed state it exists to catch. `schema_state()`
  returns `(newest, applied)` and the bundle carries the file count; a gap
  changes the count even when it cannot change the maximum.
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

**Bot quotes ROTATE, they are not drawn** (`202609090028_bot_rotation.sql`).
The original picked with `order by md5(quote_id || user_id || date) limit 1` — a
fresh uniform draw from the pool every morning. Uniform draws collide fast: with
20 quotes the expected first repeat is about six days, and production agreed —
34 bot messages had used only 17 distinct quotes, so half of everything the bots
had ever said was a repeat. It now indexes the pool by (day number + a per-user
phase), which is a cycle rather than a draw, so each person sees every quote
before any of them comes round again. Same no-schedule-stored property the
question of the day uses. **Adding quotes lengthens the cycle automatically; the
pool size is read at run time.**

**Bots are not users.** There are 5 seed bot accounts and (as of 9 Sep 2026)
**3 real users** — so any query counting `profiles` without `where not is_bot`
is wrong by 5. The signup-grant trigger and the founding grandfathering had both
swept the bots in: 10 credit-ledger rows and 5 subscriptions for accounts that
cannot log in, pay, or read a plan. Removed. A wrong denominator is how billing
numbers start lying.

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
**one** row per pair — it is a bare `distinct on (user_a, user_b)` and ignores
its `per_pair` argument entirely. That is correct NOW because `message_visible`
filters server-side, so a returned row is already visible; it was written when
visibility was decided client-side and the row needed depth to fall through
cleared messages. The argument is vestigial. Do not "fix" the caller to ask for
more rows without changing the function.
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

**Founding users are `grandfathered` and keep permanent access**
(`202609090023_founders.sql`, owner's decision, 9 Sep 2026). `entitlement()`
allows them unconditionally and `post_monthly_credits()` skips them, so this is
a data fact, not a behaviour. It had to be restored: `202609070011_credits.sql`
deliberately set every `grandfathered` row back to `none`, which meant Plans
offered all of them a one-shot 3-day trial they had no use for — one account had
already spent it, and `start_trial()` can never re-arm a spent trial. Worse, the
day `enforced` was flipped, **nobody would have been grandfathered.** The trial
CTA is now gated on `enforced` as well as status. `tests/database.mjs` pins both
halves, because this stays silent until enforcement is turned on, which is the
worst moment to discover it.

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
  exempt. **`credit_ledger_one_grant` does NOT do what this file used to claim.**
  It indexes `(user_id, reason)`, so `founding_grant` and `signup_grant` are
  distinct keys and one user can legitimately hold both — 20,000 credits, which
  a probe found in practice. The `not exists` query guard in the migration is
  the real protection; the index is the convention. That is the reverse of what
  was written here, so do not lean on the index.
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
- **Balances CANNOT go negative, and the ledger is NOT a complete record.**
  CLAUDE.md said the opposite for a while and it was wrong:
  `202609070012_integrity_followup.sql` — the live definition — added
  `and (sum of ledger) >= rate` to `post_monthly_credits()`, with the comment
  *"Credits are prepaid. Do not create debt."* A user who cannot afford the
  month is simply **not charged**, so a month an account was open but broke
  leaves no row at all. `entitlement()` was narrowed consistently, so the
  behaviour is coherent — only the documentation had drifted, and it had
  drifted about money. `creditsToMonths` still treats negative as zero runway.
  This guard is also the only reason removing the bots' ledger rows
  (`202609090028`) is safe: under 0011's version the daily job would simply
  re-charge them.
- New signups get 10,000 from a trigger on `profiles` insert — **its own
  trigger, not an edit to `handle_new_user()`**, which is redefined across
  migrations under last-applied-wins. Its insert is wrapped in
  `begin…exception when others then null` for the same reason
  `chat_backup.sql`'s is: a credits problem must never fail a signup.
- Client: `src/lib/billing.js` (`creditsToMonths`, `formatRunway`,
  `getBillingSettings`, `listCreditHistory`) still **fails open** — a missing
  RPC leaves `credits: null`, and the UI renders nothing rather than a
  confident zero. Plans shows the balance as the hero card and the rupee prices
  as context; Profile carries a lime credit tile into Plans and a
  **Billing & credits** row into the explainer. Credit maths is tested in
  `tests/credits.test.js`.
- **`getEntitlement()` marks its fail-open fallback `unknown: true`.** Access is
  unchanged — a billing outage must never lock anyone out — but the fallback is
  byte-for-byte what a real `status: 'none'` row looks like, and a screen that
  *reports* your billing cannot read that back to you as fact. Anything that
  only gates on `allowed` ignores the flag. Likewise `listCreditHistory()`
  answers `null` on a failed read: `[]` is "you have no ledger rows", which is
  not a thing to say about somebody's money by accident.
- **`src/screens/Billing.jsx` is the explainer; Plans is the shop.** It opens on
  the state of the switch — "Plans are off. Nothing is being charged" — because
  every number under it is inert while `enforced` is false, and a screen of
  balances that did not say so would read as a bill. Then the balance (only if
  the server gave one), the subscription standing, the renewal date, what
  "active but expired" means, how prepaid credits work, and the ledger. The two
  screens are **siblings**, not nested: the link between them swaps one for the
  other so Back from either lands on Profile.
- **`subscriptionStanding(ent)` explains; it never decides.** `ent.allowed` is
  the server's answer and the only one that counts. The state worth naming is
  `active-undated` — the M13 finding: `entitlement()` reads
  `status = 'active' and current_period_end > now()`, and `NULL > now()` is NULL,
  so an `active` row with no period end covers nobody. It is not expired; there
  was never a date to expire. Only the Razorpay webhook may write that column,
  so the state is reachable the moment a subscription is marked active without
  one. `active-expired` is the ordinary version. **Both are explained on screen
  and neither is silently "fixed" in SQL** — see ROADMAP.md.
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
notice one after somebody opened Settings. It records on `SIGNED_IN` /
`TOKEN_REFRESHED`, so the list is **every browser that has signed in**, not
every browser that has opened Settings; the copy said the latter long after it
stopped being true, which on a security screen makes an unrecognised row look
like an artefact of visiting a settings page rather than a real sign-in.

**The data export excludes messages other people sent you.** They are the
sender's, and ephemerality is a promise made on their behalf; turning them into
a permanent file would quietly undo it. Deletion takes the conversation from the
other person too — messages are pair-keyed with ON DELETE CASCADE on both halves
— and the UI says so first, not last.

`export_my_data()` / `delete_my_account()` use `to_regclass` guards and dynamic
SQL deliberately, so they can be CREATED on a database that is behind on later
migrations.

**There is NO multi-account, and no switcher pretending there is.** supabase-js
holds one session per browser profile (`lib/authStorage.js`), and Meera has no
notion of a second signed-in identity to keep beside it. A "switcher" would be a
menu that signs you out and shows a login form — the sign-out button with extra
steps — while implying sessions are being kept for accounts that are not. The
Privacy Centre says so in as many words, next to the device list, for the same
reason that list refuses to fake per-device revocation.

**What IS confirmed is which account the realtime channels are bound to**
(`lib/realtimeAccount.js`, `hooks/useRealtimeAccount.js`,
`components/RealtimeAccount.jsx` for the standing readout,
`components/RealtimeAccountBar.jsx` for the strip). Signing in as somebody else
does not reload the page: the session changes under a running app and every
private channel keyed on the old user id has to be torn down and rebuilt. When
that works there is nothing to see — which is also what a channel stuck on the
previous account looks like.

- The evidence is a **private topic only its own account may read**,
  `updates:<me>:account`. `realtime_allowed` allows `updates:<uuid>:<label>` for
  reading only when the uuid is `auth.uid()`, so a successful join is proof the
  socket is authenticated as that account — it is the same shape ChatList opens
  for its own `postgres_changes`, which is what makes it representative.
- **One probe, refcounted** for however many surfaces display it.
- `accountNotice(previous, next, state)` is pure and holds the whole rule.
  Nothing is said while the join is in flight; a **first** connection is not a
  switch (announcing every sign-in makes the banner meaningless on the day it
  matters); a switch is announced only once the NEW account's channel has
  actually joined, never when the session merely changed; and a **failed** join
  is announced whether or not anything switched, because the app looks entirely
  normal and silently receives nothing.
- The last live account is remembered in `localStorage` and the comparison is
  held in a **ref**, not in state captured at mount — otherwise A → B → A is
  silent.
**The export names its exclusions on screen, not only inside the file.**
`EXPORT_INCLUDES` / `EXPORT_EXCLUDES` in `lib/privacy.js` are the same claim the
SQL makes, kept beside the RPC wrapper so the screen and the function cannot
drift. `202609140037` added `scrapbook_items` (`author = me`) and
`together_optin` — rows that are unambiguously the caller's own writing and were
simply missing — and deliberately did **not** add `pair_questions`: one row
holds your question and their answer together, and splitting that is a decision
about somebody else's words. It is named in the file's own `notes` so the
omission is stated rather than silent.

## Account deletion has a grace period (`202609140037_deletion_grace.sql`)

**SHELVED** — the id is in `supabase/migrations/.unapplied`, and the client works
either way (see the fallback below). Apply it by hand, then schedule
`supabase/operations/schedule_account_purge.sql` **separately**, then remove the
`.unapplied` line.

`deletion_requests` is one row per account and only while a deletion is
scheduled: the row existing *is* the pending state, and cancelling deletes it
rather than flipping a flag, like Go Ghost. It has a select-own policy and
**no write policy and no write grant at all** — `request_account_deletion()` /
`cancel_account_deletion()` are the only way in, because a client that could
pick its own `purge_after` could write a timestamp in the past (an instant
delete with no confirmation) or one a century out (a row that never fires).

**What a pending deletion means, decided rather than left to the UI:**

- **The account keeps working for the whole grace period.** Locking it makes the
  cancel harder to reach at the moment it matters, and going silent for a week
  is itself a disclosure to the other person by another route.
- **The other person is not told.** A scheduled deletion can be withdrawn, so
  announcing it is a false alarm about somebody else's conversation and a leak
  of a private decision that may never happen. They find out when it happens,
  exactly as before.
- Because of those two, anything sent during the grace period goes with the
  rest. The pending banner says so.
- **The clock never moves on a repeat.** `request_account_deletion()` is
  `on conflict do nothing` and returns the row untouched — a `do update` would
  let a second tap silently extend a deadline somebody is relying on, or shorten
  one they think they have.

`purge_account(uuid)` is the old `delete_my_account()` body lifted out so the
cron job can run it for somebody who is not the caller; it is **operator-only**,
because a signed-in caller reaching it with another uuid is a deletion oracle
for the whole project. `delete_my_account()` still exists, still immediate, and
is deliberately still reachable: it is the fallback where this migration is not
applied, and the "Delete now instead" beside a pending banner.

**A stalled cron is the failure that matters here.** Without
`schedule_account_purge.sql` the row sits there forever while the screen shows a
date in the past and the account is still live. Two things keep that from being
silent: the banner reads the real `purge_after` off the server rather than
counting down locally, and `describeDeletion()` renders a past date as
**overdue** — never as a future date and never as "it's gone" — with the
immediate delete still beside it.

`describeDeletion()` counts **calendar days, not elapsed milliseconds.** Flooring
the elapsed time turns a grace period just described as seven days into "in 6
days" one millisecond after it starts; rounding it says "tomorrow" beside a date
that reads as today. Whole days between the two dates is the only version where
the words and the date printed next to them always agree.

**`AccountData` has three states plus a failure, and the failure is the point.**
`pending` / `supported but idle` / `not supported` (PGRST202 — the migration is
shelved, so fall back to the immediate delete rather than drawing a button that
would 404). A **failed** read is none of them and renders as the error it is,
with **no delete control at all**: "we could not ask" drawn as "nothing is
scheduled" would invite a second deletion request from someone who already made
one. That is the eighth instance of the bug class in the table above, caught
before it shipped.

## What Meera says about screenshots

The app **shows** a screenshot mark (`lib/status.js`, and the 📸 in `Chat.jsx`
and `Stories.jsx`), which is a claim — and for a long time nothing anywhere said
how weak a claim it is. The copy lives in Profile section 5 and its job is
calibration, not alarm:

- A mark means one **probably** happened. **No mark does not mean nobody did** —
  that inverse is the half people act on when deciding what to send, and it has
  to be said in as many words, visibly, not folded inside the disclosure.
- The mechanics go in the `<details>`: the web gives a page no capture signal,
  so `useScreenshotHeuristic` is reading hints (a screenshot key, the app being
  hidden the instant a snap opens), and a second phone pointed at this one
  leaves no trace at all.
- Never phrase it as a guarantee. Ephemerality is a promise about how Meera
  behaves, not about what someone else's device does with what you sent.
  `tests/privacy.test.jsx` asserts both the presence of the honest half and the
  absence of "screenshots are blocked".

## The Together layer (`202609090025_together.sql`)
## The Together layer (`202609090025_together.sql`, `202609140034_timeline_events.sql`)

A pair surface: an opt-in timeline, a shared scrapbook, and "On this day".
**0034 is written and deliberately NOT applied** — see `.unapplied` for why, and
for the fact that the client works without it.

**The narrative is opt-in and needs BOTH sides.** `together_status()` returns
`mine` / `theirs` / `active` separately, and one person cannot switch on a
shared timeline for the pair. Opting out hides the narrative but leaves the
scrapbook readable — read is always shared, write is what the opt-in gates.

**The timeline is half derived and half materialised, and the line between them
is a rule: materialise a fact whose evidence is deleted; derive a fact whose
source outlives it.** CLAUDE.md's own argument about the game series score — a
second write is a second thing that can fail alone — is why most of this stays
derived, and it holds only where the evidence survives. Here most of it does
not: `messages` are purged at 31 days and cleared after three visits, and
`streaks` keeps a **count, not a history**, so `bump_streak` destroys "we once
reached 100" with the same statement that resets it. A derived "first snap" is
true for a month and then silently disappears. So `together_events` records
`first_snap` / `first_call` / `first_voice` / `mutual_save` /
`streak_milestone` by trigger at the moment each happens, and
`together_timeline()` still derives the friendship date, the anniversary and its
rollovers, and the scrapbook. Deriving the durable half is correctness, not
laziness — the anniversary date is editable, and a materialised "4 years
together" would keep saying four after the date behind it moved.

- Every recording trigger wraps its work in `begin … exception when others then
  null`, exactly like `chat_backup.sql`, because it is the same hot path. A
  milestone that fails to record costs a card; one that fails a send costs the
  message.
- **The streak hook is its OWN trigger on `streaks`, not a line inside
  `bump_streak`** — that function is redefined across four files under
  last-applied-wins, so a hook in it is one migration from being dropped in
  silence. Same reasoning as the signup credit grant not being an edit to
  `handle_new_user()`.
- `(user_a, user_b, kind, dedupe)` is unique, and that index is the whole
  idempotency story: a retried trigger, a replayed statement and a re-seed after
  a purge each cost one row. A milestone fires **once per pair, ever** — a streak
  that breaks at 40 and climbs back past 30 does not re-announce 30.
- **`together_events` grants SELECT and nothing else.** An observation a user can
  write is a fabrication; every write goes through definer functions that are not
  granted to `authenticated` either.

**Opt-in is a COLLECTION gate, not a display gate.** The triggers ask
`together_pair_active()` and return without writing, so nothing accrues for a
pair that has not both opted in. That is what makes the purge mean anything — if
events accrued regardless and opt-in merely hid them, an opt-out would delete a
pile that started refilling on the next message. The honest cost is that turning
it on does not invent a past: `together_seed_events()` backfills only from
evidence still on disk, and seeds **no streak milestone**, because the day a
streak crossed 30 is recorded nowhere and guessing a date on a surface two
people share is how a memory becomes a small lie.

**The purge deletes what the system OBSERVED, never what a person MADE.** That
sentence is the whole semantics. `together_events` are observations: nobody
wrote them, nobody owns half of one, and "you reached a 30 day streak" cannot be
split down the middle — they exist only because both people consented to their
being collected, so **either** side withdrawing ends them immediately, in the
same transaction as the opt-out. Waiting for the second person would turn an
opt-out into a request and hand the other party a veto over it.
`scrapbook_items` are contributions — authored, attributed, and half of them the
other person's — so the purge does not touch that table, and
`purge_my_scrapbook(other)` is the separate, **author-scoped** act for somebody
who wants their own entries gone too (item by item through
`delete_scrapbook_item()`, so every object is still queued for the cleanup
worker). The derived half of the timeline is not purged because it is not
stored. **That the derived/materialised split lands exactly on the purge
boundary is not a coincidence: a fact you can recompute was never yours to
delete.**

- The copy moved with the behaviour. `optInCopy('on')` used to promise "nothing
  is deleted" and 0034 made that false; both halves are now named on the card
  **and** in a `Confirm` that lists what goes and what stays, because the house
  rule is that a destructive action states its loss first (`DELETION_LOSES` in
  `privacy.js`). Two tests that asserted the old promise were rewritten, not
  relaxed.
- `together_status()` gained `event_count` and `my_item_count` so the
  confirmation can quote a number instead of asking someone to agree to an
  unnamed quantity. A database still on 0025 answers without them, so the client
  reads them as `null` = **unknown** and says "every milestone recorded" rather
  than a confident zero — `knownCount()` in `togetherState.js`.
- `operations/schedule_together_purge.sql` sweeps every 15 min. It exists
  because the synchronous purge only fires on a tap: `block_user()` and
  `removeFriend()` delete the friendship while the `together_optin` rows (which
  reference profiles) survive. Data minimisation, not enforcement — the rows are
  already invisible.
- **0034 also closes a live hole:** the old `together_active()` counted opt-in
  rows only, so an unfriended or **blocked** pair kept a working shared
  timeline. `together_pair_active(a, b)` now requires an accepted friendship and
  no block, and `together_active(other)` is a wrapper over it so the two cannot
  disagree.

**Recorded events carry no media at all — not even a thumbnail**, which is
stricter than the capsule rule below and deliberately so. A `mutual_save` names
a message that will be purged at 31 days and its object collected with it, so
carrying `thumb_path` would force one of two bad options: teach
`claim_media_cleanup()` that an event is a reference, pinning a file in storage
forever for a card nobody asked to keep (the `toggle_saved` pinning bug with
better manners), or ship a tile whose signed URL 404s. An event is text and a
date; the photo lives in the scrapbook, which is the surface built to be
durable. No image means no tile, which means no tap target that does nothing.

**Filters group by meaning, not provenance** (`TIMELINE_GROUPS` /
`filterTimeline` in `togetherState.js`): Firsts / Years / Streaks / Kept /
Scrapbook, so `mutual_save` (recorded) and `kept` (derived) sit under one chip —
a reader does not care which half of the timeline made a card. A kind this
bundle has never heard of falls into **Other** rather than vanishing, because a
phone one deploy behind the database is normal for a few minutes after every
deploy. Below two groups no chip row is drawn at all, and a filter that empties
the view says it was the filter — otherwise it reads exactly like the empty
state and hides the way out of it.

**The panes distinguish "failed" from "empty".** `undefined` is not asked,
`null` is the read failed, an array is an answer; the three reads go through
`Promise.allSettled`, because one rejected RPC turning the other two into
"nothing here" is the seven-times bug wearing a Promise. CLAUDE.md already lists
"Together panes: 'The scrapbook is empty'" as one of those seven.

**Capsule thumbnails are the egress rule made concrete.**
`together_on_this_day()` deliberately returns `thumb_path` and **never**
`media_path` — a dozen capsules naming a dozen originals is exactly the screen
that spends the month. The first version wired every capsule to the photo
viewer anyway, so `fullPath` was null and the viewer closed on mount: a tap
target that silently did nothing. The fix is NOT to add `media_path` to the RPC
(that reintroduces the cost) nor to blow up a 400px thumbnail. A capsule is
tappable only when its full-size row is **already in the scrapbook page loaded
for the same pair** — zero extra requests — and anything else renders as a
still `.tg-thumb-still` image with no button around it.

**`add_scrapbook_item` CAPS the body at 1000 rather than rejecting**, so a long
paste is not lost, with the column CHECK behind it as the real guard. The
`scrapbook/` storage prefix had to be added in three places — the
`queue_media_cleanup` prefix whitelist, `claim_media_cleanup`'s reference check,
and `media_read`'s other-half-of-the-pair clause. Miss any one and either the
photos are unreadable or the cleanup worker deletes them out from under a live
row.

**Never format a date with `Intl` on a surface two people share.**
`Intl.DateTimeFormat('en-GB', { month: 'short' })` returns `Sept` on ICU 72+ and
`Sep` before it, so the same scrapbook entry read differently on the two phones
looking at it depending on browser age. The month table is spelled out in
`togetherState.js`. This is a shared-surface bug, not a cosmetic one.

No playlists (there is no music integration and faking one is worse than
omitting it). Scheduled messages were the other omission here and are now
built, under the bounds in the next section.

## Scheduled messages — the one plaintext exception, bounded and disclosed

`202609150040_scheduled_messages.sql` (**shelved**, see `.unapplied`),
`operations/schedule_scheduled_messages.sql`, `lib/scheduled.js`,
`components/ScheduledMessages.jsx`, wired into `Chat.jsx`'s composer.

**The decision, 15 Sep 2026.** Deferred three times on one objection, and the
objection was right: a scheduled message sits in plaintext for days in an app
that clears chats after three visits. Three options, two rejected:

- **Device-local scheduling was rejected twice over.** It fails **silently** —
  a phone that does not open Meera at 9am means the message never sends, and
  the sender finds out afterwards, if ever. That is the worst failure this app
  can have, because the entire point of scheduling is that you are not there.
  And it is not even the more private half: localStorage sits behind a 4-digit
  passcode whose default ships in the source and is documented here as public
  knowledge, while Postgres sits behind RLS, which is the one boundary in this
  app that actually holds.
- **Real encryption was rejected** because there is no key infrastructure here
  and building one is not a migration. Claiming encryption we do not have is
  exactly the "claim the code does not back" failure this codebase keeps
  catching in itself — see reverse-privacy, and screenshot detection.

So: **server-side plaintext, with the window bounded and the user told.** Seven
constraints, each of which IS the feature rather than trim around it:

1. **7-day horizon in a CHECK constraint**, not only in the picker and the RPC.
   Past a week this stops being scheduling and becomes storage. The CHECK
   compares `send_at` to `created_at`, not to `now()` — a CHECK is evaluated on
   write, so comparing to `now()` would make every row fail revalidation the
   moment its time arrived. A side effect worth knowing: the constraint is
   re-evaluated on UPDATE too, so even the table owner cannot backdate a row to
   fire early without also rewriting the day it was written.
2. **The pending row is deleted in the SAME transaction that inserts the real
   message.** No "sent" tombstone — the moment it exists as a message it is an
   ordinary message and inherits ordinary ephemerality (3-visit clear, the
   31-day purge, unsend, all of it).
3. **Exempt from `private.message_backup`.** A scheduled message has already
   spent up to a week in plaintext; letting `chat_backup.sql`'s AFTER INSERT
   trigger buy it three more days would undo the bound that made the feature
   acceptable. **`private.backup_message()` is NOT modified.** Its insert is
   wrapped in `begin…exception when others then null` precisely so a backup
   problem can never roll back a real send, and it sits on the hottest path in
   the app; teaching it about scheduling would put a new failure mode on every
   message anyone ever sends for the sake of the rarest one. Instead the AFTER
   INSERT trigger has already run by the time control returns to
   `deliver_scheduled_messages()` **in the same transaction**, so it deletes the
   copy the trigger just made, by `message_id`, behind a `to_regclass` guard and
   dynamic SQL (the `export_my_data` pattern — the function must be creatable on
   a database that never ran `chat_backup.sql`). Nothing ever observes the row:
   `private` is not exposed by PostgREST and the delete commits atomically with
   the insert.
4. **Sender-only RLS — this INVERTS the convention.** `messages`, `friendships`,
   `streaks` and `anniversaries` are all pair-readable; this one is not, because
   a surprise the recipient can read early is not one. Do not "fix" it by adding
   the recipient to `scheduled_read`.
5. **Text only.** No media columns at all. A scheduled photo is a storage object
   that is alive-but-unreferenced for a week, which fights
   `claim_media_cleanup`'s reference check, and it multiplies the retention
   problem by the size of the object.
6. **Cancelled on unfriend AND on block — deleted, never delivered.** Two
   triggers, not one. `block_user()` deletes the friendship, so the friendship
   trigger alone would cover today's code — and that is exactly the reasoning
   that produced this bug class twice in one audit session (Together consent
   surviving an unfriend; a cleanup that only ran inside `block_user()`). A
   direct `DELETE` on `friendships` (what `removeFriend` does), a status change,
   and a row landing in `blocks` are three different doors. There is a third
   check inside `deliver_scheduled_messages()` as a backstop, and it is
   load-bearing: that function is the table owner and therefore runs **past**
   `messages_insert`, which is the policy that would otherwise have refused the
   send.
7. **The disclosure is at the moment of choice**, in `ScheduledMessages.jsx`, in
   plain words, on a lime card, and deliberately **not** inside a `<details>` —
   a disclosure you have to open is one the person who most needed it never
   read. It names the actual thing (plaintext, on a server, up to seven days)
   rather than a softened version, because this is the one message in Meera that
   does not behave like the rest and a user who does not know that cannot decide
   whether they mind.

**The cap is 20 pending per sender**, across every conversation. The real use is
a handful — a birthday note, a good-morning for each day of a week you are away
(seven), the odd reminder. 20 leaves room for all of that at once and bounds the
worst case to 20 × 2000 characters, about 40 kB of plaintext per account for at
most a week. It is deliberately a number a person will never reach and an
automated client hits immediately. Past it this is not scheduling, it is an
outbox with a retention policy, which is the thing nobody wanted.

**The grant is the wall and the RPC is the door.** `scheduled_messages` grants
`select, delete` to authenticated and **no insert, no update**. Every row is
written by `schedule_message()`, which is what makes the horizon, the cap, the
friendship-and-block gate and the IST resolution unforgeable rather than merely
enforced in one place — the `202609090032` lesson, where a hardened RPC left its
column grant open and only closed the client path. There is no update path at
all: "edit" is cancel and reschedule, which cannot leave a half-moved row.

**Times are an IST wall clock resolved server-side.** The client sends
`local_date` + `local_time` — the date and time the user actually picked — and
**never** an absolute instant computed from the device. This is the `status_notes`
lesson: a note written from a skewed client clock was invisible forever, to
everyone including its author, because the client overrode a timestamp the
server could compute. The same trap here sends a message at the wrong hour, days
later, with nobody watching. `at time zone 'Asia/Kolkata'` is exact (India has no
DST) and independent of both the device's clock and its timezone; the clock only
decides which day the picker opens on, and a skewed one produces an honest "that
time has already passed" rather than a silent wrong send. `validateSchedule()`
also refuses anything inside the next minute, because the server's `now()` moves
on during the round trip.

**Delivery is idempotent three ways over.** `deliver_scheduled_messages()` takes
its batch `for update skip locked` (pg_cron will start a second run over a slow
first one), deletes the pending row in the same transaction as the insert, and
sets `messages.client_id` to the pending row's id so even a pathological double
insert collides with `messages_sender_client_unique`. The cron runs **every
minute**, not every fifteen: the sheet says "sends at 09:00" to somebody's face,
and fifteen minutes of slop makes that sentence false for fourteen of them.

**A delivered scheduled message does not push.** The push Edge Function
authorises on the caller's JWT and cron has none, so the message appears in an
open app via Realtime and otherwise waits to be seen. Stated here rather than
worked around, because a half-working notification is worse than a known gap.

**Failure states.** `loadScheduled()` returns `{ state, rows }` — `'ok'` with
rows, `'failed'` with `rows: null`, or `'off'` with `rows: null` when the
migration is not applied on this database. Three states, not two: a failed "what
do I have scheduled?" rendered as "nothing" is the eighth instance of this
codebase's oldest bug, and here somebody acts on it by scheduling the message a
second time. `'off'` hides the clock button and the strip entirely, which is why
the client half can ship while the migration is on the shelf.

**Shelved deliberately** (`supabase/migrations/.unapplied`). Applying it is a
decision about retention, not a deployment step: this is the one table in the
app that holds a message body in plaintext on purpose. Apply the migration in
the SQL editor, then `operations/schedule_scheduled_messages.sql` **standalone**,
and remove the `.unapplied` line in the same change. **Without the cron job the
rows accumulate and nothing ever sends** — and the sender's list goes on saying
"sends at 09:00" about a message that never will.

`tests/database.mjs` now also applies `chat_backup.sql`, which lives outside
`supabase/migrations/` and had therefore never once executed against a real
Postgres. The backup exemption is untestable without it, and an exemption that
"works" because the trigger is broken is not an exemption — so both halves are
asserted: an ordinary send IS in `private.message_backup`, a delivered scheduled
one is not.

## Question of the day, status notes, birthdays (`together.sql`)

**Day boundaries are IST** (`public.ist_date()`), like `friendship_charms`.
"Today's question" has to turn over at the users' midnight, not UTC's. The
client mirrors it with `istToday()` in db.js (`Intl` with `Asia/Kolkata`,
`en-CA` so the format is the `YYYY-MM-DD` a Postgres `date` wants) — filtering
on the browser's own date would put someone past their local midnight on a
different "today" than the row they just wrote.

**There is now ONE client definition of that day: `lib/questionDay.js`.**
`istToday()` delegates to its `istDay()`. The module also holds `istDayEnd` /
`resetLabel` (when the three asks come back — IST has no DST, so the offset is
a constant rather than a lookup) and the two functions that keep the chat-list
badge honest:

- **`daySnapshot(byUser, dayBefore, dayAfter)`** dates a fetched badge map. The
  IST day is read either side of the request; if it rolled over *during* the
  request the rows describe a day that is already over, and the snapshot is
  refused rather than dated to the day it does not describe.
- **`pendingForDay(snapshot, friendId)`** is what the row actually renders
  through. A count fetched yesterday cannot support a claim about today, so a
  stale snapshot reports 0 — which draws no chip at all. Zero is safe *here*
  precisely because `rowSignal` makes a chip only above zero: an absent badge
  claims nothing, while a badge claims someone is waiting on you.

**The badge and the server count the same rows, and that is not a coincidence
to be maintained by hand.** `pending_questions_all()`
(`202609070012_integrity_followup.sql`) counts
`asker = them and answer is null and on_date = public.ist_date()`. Its
day-scoping is pinned in `tests/database.mjs` (a question dated 2000-01-01
reports 0); the client half is pinned in `tests/question-day.test.js`. The
badge is also fetched on its **own** 30s/focus/visibility schedule in
ChatList, not inside `load()` — a question is not a message, so nothing in the
`postgres_changes` subscription fires when one is asked, and the count expires
by the clock whether or not anything refetches.

**`listPromptStatus()` answers `null` when it could not read, never `{}`.** An
empty map is the answer "nobody is waiting on you"; giving it for a dropped
request wipes a badge that was true. The caller keeps what it already had.

**The three-a-day cap is stated, and the in-flight guard is a REF.** A disabled
Ask button with no sentence beside it reads as a bug, so `QuestionCards` says
"that's your three for today", when they come back, and that the day turns over
at midnight IST — and that answering is not capped. A refused ask re-reads the
quota instead of leaving "3 asks left" on screen against a server that said
zero (that exact wrong number is in the failures-as-answers table below).
`askingRef` / `replyingRef` are refs because two submits in the same tick both
read the pre-render value of a state flag: `if (asking) return` stops nothing,
and for an answer the loser is refused by `unique (user_a, user_b, responder,
on_date)` on a write that is final the moment it lands. The composer is
rendered from `open && !spent`, so a quota that runs out under an open form
closes it rather than leaving a composer above a header offering to cancel it.

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

## Screen time — device-local, own-eyes-only

`src/lib/screenTime.js` (boundary + bucketing + store), `src/lib/screenTimeTracker.js`
(the lifecycle hook), `src/components/ScreenTime.jsx` (Profile → Your account).

**It is own-eyes-only and must never become a shared surface.** This is a
two-person app built around one couple, and a usage dashboard one partner can
see about the other is a coercive-control vector. So: no pair-scoped table, no
Together tile, nothing in a friend's sheet, no share affordance, no comparison
between two people. `ScreenTime` deliberately takes **no props** — there is no
id it could be pointed at — and `tests/screen-time-panel.test.jsx` asserts
`ScreenTime.length === 0` so a `friend` prop added later fails the build. The
honest version of "let her see mine" is a screenshot the owner chooses to send.

**It is stored device-local in `localStorage`, with no table and no migration.**
Same reasoning as "typing and presence are Realtime broadcast, never database
rows", with more force: a row per person per day is a permanent record of when
somebody was awake, costs an RLS policy, and is readable by anyone holding the
service key. The honest cost — it does not follow you to another device and
clearing site data clears it — is stated in one line on the panel, not buried.
About 2 KB, 21 days (`KEEP_DAYS`), pruned on every write so this can never be
the thing that fills the quota and breaks the **outbox**, which holds real
messages somebody is waiting on.

**The day resets at 07:00 IST, which is NOT `istToday()`.** `ist_date()` /
`istToday()` are midnight IST and the question of the day, `pair_questions` and
`friendship_charms` all depend on them — do not reuse them here and do not move
them. `dayKeyAt()` / `dayStart()` compute 07:00 **Asia/Kolkata** through `Intl`,
never from the browser's offset, so a phone carried abroad still rolls over on
the owner's day. The key names the date the window OPENED, so 02:00 belongs to
the previous calendar date. 07:00 also makes "night" (22:00→07:00) one
contiguous block inside a day instead of being cut in half by midnight.

**A phone that went to sleep is not screen time.** A suspend, a discarded tab
or a closed laptop lid fires no `visibilitychange` — the process just resumes
hours later, and `now - sessionStart` would report the night as usage. A 60s
heartbeat runs **only while visible and unlocked**, and `creditableEnd()`
credits at most one interval past the last beat: the gap is **discarded, not
capped**, because a cap still invents time that never happened. A freeze
therefore costs about a minute, not eight hours.

**It counts nothing behind the passcode pad.** The pad is an overlay over a
mounted app, so "visible" is not "the owner is here". App.jsx drives
`setScreenTimeLocked(!unlocked)` from its existing `unlocked` state — one line,
rather than a second copy of the lock's listeners that could drift out of step
with the first. `installScreenTime()` is at **module scope in App.jsx**, next to
`trackDeviceSessions()` and for the same reason: Profile is lazy-imported, so a
tracker installed by the screen that displays the number would only ever measure
people who opened Settings.

**Three states, three screens.** `null` = storage could not be read (say so;
never render `0m`), `undefined` = not measured yet, `0` = a measured zero.
`summarize()` carries all three to the panel. A day the phone was off is
**absent** from the store, not a zero — counting it would drag the baseline down
and make every ordinary day read as "more than usual".

**Tone is neutral, in both directions.** No goals, no limits, no red states, and
in particular **no usage streak** — that is the Snapchat mechanic this app
copies for messages and deliberately does not copy for attention. A panel that
nudges usage up is a dark pattern; one that guilt-trips it down is a politer
dark pattern. Shipped insights: today's total, longest stretch, times opened,
today against your own 7-day baseline (silent until `MIN_BASELINE_DAYS`), a
seven-day column strip, and a four-part distribution of when you are here.

The distribution bar is lime → lavender → indigo → near-black and **never
coral**: privacy.css pins one job per hue on that screen and coral's is danger.
The hero is lavender (that screen's "you") and is painted from CSS and listed in
the fixed-light context in `index.css` — an inline vibrant fill never enters
that context, which is how `.fp-stat` ended up near-white on lavender at night.

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

- **The pad is an OVERLAY over a mounted app, never an early return.** It used
  to be `if (!unlocked) return <PinLock/>` above every provider, and that one
  line was the worst bug of the day: losing visibility for a second unmounted
  and remounted everything. Per app-switch it closed the open conversation and
  its draft, fired Chat's unmount cleanup so `leave_seen_messages` burned one of
  the three ephemeral views (three switches and the messages you had just read
  were gone for good), cancelled an in-progress voice recording, threw away an
  edited snap, detached the `<input type=file>` while the OS picker was open so
  attaching a photo silently failed, and cleared the signed-URL cache so every
  visible photo re-downloaded — which is the entire egress bill. Two independent
  audits found it. **Do not restore the early return to "keep it simple".**
- **`unlocked` must be derived from the flag AND the grace**, at mount and on
  `visible`. The flag alone let a reload walk past the pad and past an active
  15-minute lockout: `sessionStorage` survives a tab restore, and a backgrounded
  phone restores tabs routinely, so "locked two hours ago" and "reloaded just
  now" looked identical. `wasHiddenPastGrace()` differs from `hiddenTooLong()`
  on exactly one case — no timestamp — because an in-app reload must not
  re-ask while a phone that was put down must.
- **Returning past the grace must LOCK, not merely decline to unlock.** A call
  that ended while the app was still hidden was exempted on the way out and had
  nothing to re-lock it on the way back; the next person to open Meera walked
  straight into the conversations. That hole was opened by the fix for calls
  dying on background — every exemption needs its own way back.
- **Device-local is deliberate.** PinLock renders inside `AuthProvider` now but
  does not use it, so
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
  actually protects the data. `clearPin()` also calls `clearBiometric()`, and it
  does so **inside `clearPin` rather than at the call site** so a later caller
  cannot forget: the path reseeds the shipped default, so a credential left
  behind would be a live route past a pad whose code is public knowledge.
- Where Web Crypto is missing (an insecure context) the pad says so and stays
  shut. Letting someone through because verification is unavailable would make
  the lock a suggestion.
- `PinPad.jsx` is shared by the lock screen and the set/change sheet, so the two
  cannot drift about how many digits a code has.

### Biometric unlock is a SECOND door, never a different lock

`lib/biometric.js` + the button on `PinLock` + `components/BiometricUnlock.jsx`
in Profile → Privacy and lock. A WebAuthn platform credential (Face ID / Touch
ID / fingerprint), remembered by its credential id in `localStorage`.

- **There is no server, so nothing verifies the assertion.** Meera is a static
  bundle; there is no relying party to check a signature against a registered
  public key. We deliberately do **not** store the public key and "verify"
  locally — that is checking our own maths against a key sitting in the same
  `localStorage` as the thing it guards, and anyone who can run script in the
  page (which is what defeating this takes at all) skips it entirely. The
  challenge is random so the ceremony is well-formed, not because anything
  checks it came back, and `attestation` is `'none'` because evidence nobody
  can check is data collected for the look of rigour. What it actually buys is
  that **the platform refused to answer until it had seen a face or a finger** —
  deterrence of exactly the class the passcode already is. The Profile copy says
  this in words; do not let it drift into sounding like security.
- **The passcode is never removed and never optional.** Every failure path here
  lands back on the pad, and there is no control anywhere that turns the pad
  off. The credential lives in the platform keystore and the owner cannot
  rebuild it from anything they know, so a state where the only way in is a
  biometric would be a way to be locked out of your own phone.
- **It cannot touch the lockout.** `PinLock` returns `MarketDecoy` before
  anything biometric renders, and both the attempt effect and the silent
  capability probe bail on `locked` — the platform is not so much as *asked* a
  question while the decoy is up. An unlock the fifteen minutes cannot stop
  would make them fictional, the same reason there is no bypass gesture.
- **A cancelled or failed biometric is NOT a wrong passcode.** Nothing in that
  path writes `FAIL_KEY`. The three tries belong to the pad; a Face ID the owner
  dismissed twice must not leave them one typo from the decoy.
- **The probe has FOUR answers** (`probeBiometric()` → `available` / `none` /
  `unsupported` / `unknown`) and never rejects. `unknown` is the probe having
  *thrown*, and rendering it as `unsupported` is precisely the "failures must
  not render as answers" bug. The two surfaces treat it differently on purpose:
  **Profile keeps offering the button** (the cost of being wrong is one
  dismissed prompt; the confident version tells someone their phone lacks a
  feature it has), while the **lock screen shows it only on `available`**,
  because there a button that may not work is a dead end under the thumb with
  the pad right above it.
- **`doneRef` in PinLock is a one-way latch, and is not the guard ref CLAUDE.md
  warns about.** That one was set *before* a check and cleared after, so an
  abandoned attempt left it stuck and the pad went dead. This one is set only on
  success and never cleared, and after success the screen is gone. It exists
  because a ~200ms key derivation and a platform prompt can be in flight
  simultaneously — without it both call `onUnlock()`, and a wrong code landing
  after a biometric unlock would bank a failure against the next session.
- **The prompt only ever fires from a tap.** No effect on mount, no timer, no
  `visibilitychange`. A Face ID sheet that raises itself on every return is the
  repeated-permission-prompt problem `useCamera`'s `retry()` rule exists to
  stop, and on iOS that sheet covers the pad — hiding the fallback at the moment
  it is needed. Enrollment likewise runs straight off the tap (Safari rejects a
  ceremony with no user activation), the same rule `enablePush()` follows.
- **The pad is first in the DOM**, so a keyboard, switch or screen reader
  reaches the route that always works first. Nothing autofocuses.
- `userVerification: 'required'` and `authenticatorAttachment: 'platform'` are
  both load-bearing: without the first the platform may answer on presence alone
  (a tap) and the "biometric" is just a button; without the second a USB key
  left in the phone would unlock it. `rp.id` is deliberately **omitted** so the
  browser fills in the effective domain — hard-coding it breaks localhost and
  every preview deployment.
- **A deleted credential and a user who tapped Cancel are indistinguishable**
  (both surface as `NotAllowedError` after the same timeout), so `verifyBiometric`
  reports `'cancelled'` for both and **never auto-clears the enrollment** — the
  owner's own cancel would silently un-enroll them. Not knowing is survivable
  only because the pad is on screen regardless.
- Naming is detected, not guessed: "Face ID or Touch ID" on Apple, "Fingerprint
  unlock" on Android, "Biometric unlock" elsewhere, with a matching line icon
  (`FaceIdIcon` / `FingerprintIcon`). Telling an Android user about Face ID is
  worse than saying nothing specific.
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
- **A live call blocks the re-lock** (`lib/callState.js`). PinLock is an early
  return ABOVE the whole provider tree, so locking on `hidden` unmounts
  `CallProvider` — and WebRTC takes no wake lock, so on a voice call where
  nobody touches the screen the display timing out is **guaranteed**. The call
  died mid-sentence, the peer was told nothing and no call log was written. The
  flag is module-level rather than context precisely because the reader sits
  above the writer. `markHidden()` still runs, so a long absence still costs the
  passcode once the call ends. **Anything else that must survive backgrounding —
  an upload in flight, a recording — needs the same treatment.**
- The default passcode is `9934`. **`RETIRED_DEFAULTS` in `pinStore.js` is not
  optional**: `ensurePin()` never overwrites an existing hash, so changing
  `DEFAULT_PIN` without listing the old one leaves every already-seeded device
  asking for a code that is no longer written down anywhere. That happened —
  `9943` shipped for a few hours and locked someone out of their own phone. The
  migration runs only while the default flag is set, so a chosen passcode is
  never touched, and it deliberately does NOT clear an active lockout.
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

**`push_subscriptions.endpoint` is a URL the Edge Function will FETCH.** It is
user-writable and the anon key is in the bundle, so without a host allowlist a
signed-in user could point the function at any host on the internet — and worse,
`vapidHeader(origin)` mints a JWT signed with `VAPID_PRIVATE_KEY` whose audience
is that host, handing an attacker a real token on every send. There is now a
CHECK constraint (`202609090022`) **and** the same check again before the fetch,
plus a cap on the fan-out. Both halves are needed: a constraint added today does
not clean rows written yesterday. If you add a push service, widen both.

**`display_name` is the SUBJECT of every notification** and had no length or
content limit in SQL — the 40 characters were a React prop. A friend could put
`"Meera Security — verify at evil.tld"` on your lock screen under Meera's own
name and icon. Capped in the column and truncated (whitespace collapsed, since
newlines split a notification into fake lines) in the function.

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

**A declined call must be remembered, or it rings again.** The invite repeat
runs for up to 40s, and the old suppression check (`c.room === payload.room`)
only held while the call was still on screen — after `decline()` the ref is
null, so the next repeat rang the phone for the call just refused.
`endedRooms` (a `Map<room, expiry>` ref written in `teardown()`) drops those
invites **silently** rather than answering `busy`, which would tell the caller
something untrue. Entries expire after `CONNECT_TIMEOUT_MS` so the map cannot
grow. Denying the mic on Accept must also send `decline` — returning quietly
left the caller ringing the full 40s and, with the repeat, re-ringing the phone
of someone who had just refused permission.

**`notify()` resolves `{ data, error }`, and the difference matters.** `data`
present means the push function ran and its `sent` count is real; `data: null`
means the invoke itself failed. Giving up on both told a friend sitting in the
app that they were unavailable, cancelled the call after one invite and wrote a
missed-call log — on nothing worse than a cold start.

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

## Operational telemetry — and the limits of calling it anonymous

`202609140035_ops_telemetry.sql` (**SHELVED** — see
`supabase/migrations/.unapplied`), `src/lib/telemetry.js`,
`supabase/operations/schedule_ops_telemetry.sql`.

Four things failed in total silence: an upload that never landed, a Realtime
channel that died, a push nobody received, and a cleanup pass that stopped
collecting. Each looks to the user like "the app is broken" and to the operator
like nothing at all. ROADMAP.md listed push-delivery logs as needing the
owner's decision because it is *exactly the metadata push keeps none of*; the
decision was made, with the constraints below.

Built on the `ops_metrics` pattern (RLS on, no policy, grants revoked, a
SECURITY DEFINER writer, operator reads from the SQL editor). **The sink is
Postgres.** No third party, no SDK, no npm dependency — an analytics vendor
spends both of the things that are scarce here.

**It is a COUNTER table, not a log.** A row is `(hour, source, kind, code,
device class, retry bucket)` and two integers. There is no per-event row to
correlate and no column an identifier could live in.

**What is collected:** upload failures by surface (`snaps`/`stories`/`voice`/
`memories`) and HTTP status bucket; downscale failures; Realtime joins and
drops by topic KIND; push attempts and outcomes (delivered / endpoint gone /
rejected / no subscription); cleanup pass results and objects removed.

**What is NOT collected, anywhere:** message bodies, media paths or bytes,
coordinates, user agents, IP addresses, push endpoints, Realtime topics,
usernames, display names, recipient ids, error message *text*.

**Where the anonymisation is real:**
- No identifier column exists. Nothing to join a person to.
- **Timestamps are truncated to the hour.** Precision is itself an identifier —
  `messages.created_at` is right there, and a millisecond-stamped telemetry row
  next to a send is that send with extra steps.
- `code` is regex-validated server-side (`^[a-z][a-z0-9_]{0,31}$`), so it can
  never become a free-text field somebody later pipes an error message into.
  An error's **message** is never read on the client: supabase-js puts the
  object path in an upload error, and a path's first segment is the user's id.
- **Topics are bucketed to a kind.** The grammar is `signal:<recipient>:<sender>`,
  so a raw topic name IS an edge of the social graph. `topicKind()` is where
  that is enforced rather than remembered.
- The client buffers and flushes on a jittered timer, so the *write* is not
  stamped with the time of the user's action either.

**Where it is only a convention, and this must not be glossed:**
- A row written by an authenticated client over PostgREST is **attributable at
  write time** no matter which columns are omitted. The request carries a JWT
  and the platform's own request logs saw it. Omitting `user_id` stops the
  database remembering who; it does not stop the infrastructure having known.
- `ops_event_budget` is **deliberately identifying** — keyed by user, because
  rate-limiting an open write path is impossible without knowing whom to limit.
  It holds a count and an hour, no event content, and is purged after 2 days.
  It is the one place an operator could narrow "who was emitting in hour H".
- **There are three real users.** k-anonymity is arithmetically unavailable at
  that size: an hour bucket holding one event is a one-in-three guess. This is
  data with the identifiers left out, which is a weaker thing than anonymous
  data. **Do not describe it to anyone as anonymous.**
- There is a local opt-out (`setTelemetryEnabled`, `meera:telemetry-off`) and
  **no UI for it yet**. Recorded as a gap rather than glossed; wiring it to a
  Profile row is a component, not a redesign.

**Sampling must not lie.** Realtime joins are sampled 1-in-20 (they are the
routine case); failures are **never** sampled. Each event carries its
denominator `n`, the server stores `observed` (events reported) beside
`estimated` (scaled back up), and **every dashboard query and every alert
threshold reads `estimated`**. A rate built from a sampled numerator and an
unsampled denominator is wrong by exactly 20x in a fixed direction — worse than
no alert. `tests/database.mjs` pins this with a case where the raw sample says
"40 drops to 5 joins" and the scaled figure says "healthy".

**Upload successes are deliberately not counted.** A failure *rate* needs a
denominator, and logging every successful upload would record a beat of each
user's activity all day to get one. `ops_metrics.object_count` is already
collected server-side and serves as an approximate one — objects landed, not
attempts, so a trend line and not a percentage. Said plainly in the operations
file rather than quietly relied on.

**Nothing here may break a real user action.** `record()` never touches the
network — it increments a number in a Map — and swallows everything; `flush()`
drops its batch rather than retrying (telemetry that queues indefinitely is a
second outbox with none of the value); both Edge Functions report *after* the
real work inside a `try`; and both SQL writers end in `exception when others
then return 0`, the same reasoning as `chat_backup.sql`'s trigger.

**CLOSED is not a drop.** Every `removeChannel()` reports it, so counting it
would make the drop rate a measure of normal use and the alert on it fiction.
Only `CHANNEL_ERROR` and `TIMED_OUT` count.

**Clients cannot name their own source.** `record_ops_events(jsonb)` is
authenticated-only, forces `source='client'`, and has no source parameter to
forge; `record_ops_server_events(text, jsonb)` is service_role-only.
`purge_ops_events()` (30-day events, 2-day budget) and `ops_event_alerts()` are
operator-only. Cron for both is in `operations/`, standalone, per the usual rule.

**The dashboard is the queries in `supabase/operations/schedule_ops_telemetry.sql`,
run in the SQL editor.** There is no hosted dashboard and the file does not
pretend there is one.

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

**A later migration can silently re-widen a grant the baseline narrowed.**
Two live cases, both found by probing rather than reading:
- `stories_fix.sql` re-issued a table-wide `grant insert on public.stories`,
  which **subsumes** the baseline's four-column grant. Any signed-in user could
  post a story with a hand-picked `expires_at` a century out — never purged,
  and its object never collected, because `claim_media_cleanup` sees a live
  reference forever. `created_at` and `id` were forgeable the same way.
- `202609090022` hardened `toggle_saved()` against a blocked user pinning the
  conversation against the purge, and **left the `saved_by` column grant in
  place** — so it closed only the client path. A `PATCH` straight to PostgREST
  still worked, and the victim could not undo it.

Both are re-narrowed in `202609090032`, with negative assertions in
`tests/database.mjs`. **When you harden an RPC, check whether the grant it was
protecting is still open.** The RPC is a door; the grant is the wall.

**And the third case is the one that proves the rule** — `202609150050`.
`202609090032` looked at that six-column grant and revoked exactly one of them.
`opened_at` was still writable, and three innocuous pieces composed into a way
for **either party to destroy a whole conversation for both people with one
request**:

1. `messages_update` is `using (auth.uid() in (user_a, user_b))` — either party.
2. `guard_message_update` only blocks *changing a non-null* value, so
   `null -> any timestamp` was permitted, **including one in the past**, and no
   CHECK constrained the column anywhere.
3. `message_visible` hides a row once `opened_at + 24h < now()`, and
   `purge_expired` **hard deletes** it on the same condition.

```
PATCH /rest/v1/messages?user_a=eq.X&user_b=eq.Y&opened_at=is.null
{"opened_at": "2020-01-01T00:00:00Z"}
```

The thread vanished from both phones immediately and was deleted with its media
by the next cleanup pass, within fifteen minutes. Unread messages the recipient
had never seen went too, read receipts were forged as a side effect, and unlike
`unsent_at` — sender-only, and rendered as "unsent" — it left no trace.

**The fix is a revoke, not another guard, because the client never used these
columns.** `markOpened` and `markReplayed` in `db.js` had **zero callers**
outside the test harness, and `cleared_at` is referenced by nothing in the
schema. Every real writer is SECURITY DEFINER and therefore indifferent to a
grant: `mark_messages_seen`, `record_snap_open`, `leave_seen_messages`. So the
dangerous door existed solely to serve dead code — which is the shape this class
of bug keeps taking, and the reason to check the wall every time you fix a door.

- `screenshot_at` keeps a door because `SnapViewer` needs one, but as
  `mark_screenshot(msg)` — recipient-only and **set once**, neither of which a
  column grant can express, and the second matters because `status.js` renders
  it to the *other* person as a claim.
- `guard_message_open_at` refuses a backdated open independently, so a future
  migration silently re-widening the grant (now twice in this repo) does not
  reopen it. Mutation-checked: removing the revoke fails the assertion, and the
  trigger still refuses the write.
- Same migration closes **M1**: `202609090022`'s own comment named
  `react_to_message` as a hole beside `toggle_saved`, then hardened only
  `toggle_saved`. `block_user()` deletes the friendship; that RPC never looked
  at one, so a blocked person could keep dropping emoji into the thread.

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
game 2, toast 3, drift 4, **account 5**, install 6) — a value module, because a
file that exports both components and constants breaks fast refresh. The
numbers are relative, so inserting one only means renumbering what sits below
it.

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

## Failures must not render as answers

Ten instances of one bug have been found and fixed in this codebase, which
makes it a habit rather than a coincidence. In each, a `.catch` mapped a
*failure* onto a value that means something specific and false:

| Surface | A failed fetch claimed |
|---|---|
| Blocked contacts | "You haven't blocked anyone" |
| Location sharing | Ghost Mode — you are hidden |
| Snap Map | every friend is in Ghost Mode |
| Story viewers | "Seen by 0 · No views yet" |
| Question of the day | her question gone, and 3 asks left when there were 0 |
| Together panes | "The scrapbook is empty" |
| Snap Map's own row | Ghost Mode, while still broadcasting |
| Chat-list question badge | nobody is waiting on you — `listPromptStatus` returned `{}` |
| Billing status | "No subscription", which is exactly what failing open looks like |
| Credit history | an empty ledger, on a screen about money |

**The rule: a fallback value must mean "we do not know".** In practice that is
three states, not two — and JS gives you two empties, so use them deliberately:

```js
const rows = await fetchThing().catch(() => null)   // null  = it failed
const [rows, setRows] = useState(undefined)          // undefined = not asked yet
```

`[]` and `false` are *answers*. Reserve them for answers.

Two traps this has already sprung:
- **A sentinel that means two things makes the honest branch unreachable.** The
  "Seen by" fix used `null` for both "sheet closed" and "fetch failed", so the
  error branch sat behind the guard that decides whether to open the sheet — and
  nothing cleared `paused`, so a failed tap froze the story silently. Worse than
  the bug it replaced.
- **On a privacy control this is not cosmetic.** Telling someone they are hidden,
  or that they have blocked nobody, is a claim they will act on.

## Shelved migrations: `supabase/migrations/.unapplied`

A migration that is deliberately not applied to production goes in that list,
one id per line. `vite.config.js` subtracts them from the count it stamps into
the bundle. Without it the drift banner is permanently on — and **an always-on
warning is invisible on the day it is finally true**, which is the exact failure
the check exists to prevent.

They stay in the migrations directory on purpose: `tests/database.mjs`
enumerates the folder, and that is the only thing exercising a shelved
migration before it goes live. Remove the line in the same change that applies
it. `tests/schema-contract.test.js` fails if the list names a migration that
does not exist.

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

**KNOWN GAP — your own sent snaps never actually clear.** The text above
describes `clear_viewed_chats` covering your own sent snaps, and the SQL still
implements it — but `Chat.jsx`'s IntersectionObserver only reports
`['chat','sticker']`, so no snap id ever reaches `mark_messages_seen` and the
`(kind='snap' and sender_id=auth.uid())` branch is unreachable. Your own snap
status rows persist the full 31 days. Recorded here rather than quietly fixed
because the fix is one word in a filter and the behaviour change is real.

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
  outright (unsendable here, and not ours to keep). **The 7-day age-out and the
  200-item cap described here are NOT in the code** — the current design instead
  flags a permanently-failed item with `error` and offers Retry, and `dropped`
  is returned hard-coded empty with no consumer. Documented so the gap is
  visible rather than trusted.

  **The flush tracks re-entry.** `removeQueued` dispatches `OUTBOX_EVENT` from
  inside the loop, and that re-entrant flush is rejected because the concurrent
  guard is still set — so the second message you sent while the first was in
  flight sat on "⏳ Pending" until a 15s interval noticed. An `again` flag and a
  `do { … } while (again)` fix it. On a slow mobile round trip this was the
  common case, not an edge case.
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

## Just us — the intimate games (`202609090026_intimate_games.sql`)

Five turn-based games for two partners: `truth_or_dare`, `would_you_rather`,
`true_or_made_up`, `guess_what`, `fantasy_builder`. One pair of tables, because
every one of them is "somebody poses, the other responds, then it swaps" and
modelling them separately would be five copies of the same turn bug.

**The migration stays in `.unapplied`.** The client degrades on `PGRST202`: the
"Just us" row and the chip are hidden, and no further polling happens for the
life of the page. `available` is `false` ONLY once PostgREST has actually said
the function is absent — a dropped connection leaves the entry point where it
is, because hiding a feature because a request timed out is a failure rendered
as an answer.

- `src/lib/relationshipGames.js` — pure: catalogue, the turn rule, the consent
  state machine, the pose/respond validation mirrors, and every sentence the
  surface says about the photo. No supabase import.
- `src/lib/intimate.js` — the calls. `src/hooks/useIntimateSession.js` — poll +
  nudge. `src/components/IntimateSession.jsx` + `IntimateChip.jsx` +
  `src/styles/intimate.css`.

**Entry point: the FriendSheet in `Chat.jsx`**, next to Kept Together. It is
reachable only from inside a conversation that already exists, so it cannot
appear for anyone who is not an accepted friend — the RPCs re-check that, but
the entry point should not depend on them. **Profile → Play is the wrong home:**
it is a friend picker, and a list of people next to five games called things
like Truth or Dare is the one place this must never be.
The only thing on the conversation itself is `IntimateChip` in the relationship
strip, and it appears only when a turn or an invitation is waiting. It says
`Just us · Your turn` and **never** a game name, a prompt or a person — the
conversation screen is the one surface here that is not behind a second tap.

**The partner is ALWAYS the rotating alias, never `display_name`.** This is the
surface where a glance at the screen costs the most. `partnerLabel(profile,
alias)` is the only name renderer; it falls back to `@username` and then to
"them", never to the real name — a fallback that reveals the thing the feature
hides is the failure mode. `tests/intimate.test.jsx` asserts structurally that
the string never reaches `document.body`, in markup or text.

**The turn rule is ONE expression**, mirrored by `turnHolder()` exactly as
`pieceToMove()` mirrors `game_turn()`:

> turn = the person who did NOT pose the most recent round

Correct in both phases with no special case: while a round is open "not the
poser" is the responder; once closed it is whoever goes next. A pass closes a
round the same way an answer does, so passing can never strand a turn.
`tests/intimate-db.mjs` checks the two agree at six points of a real game,
including both kinds of pass — a differential check, not inspection.

**Passing costs NOTHING.** `pass_intimate_turn()` takes no reason and writes no
counter, and there is nothing in the schema or the client that accumulates when
someone passes. **Do not add a streak, a score, a tally, or copy implying a
pass is the lesser outcome.** A dare game whose "no" costs something is a dare
game that coerces. Both test files assert this structurally.

**Camera-off is a MODE, not a refusal.** `guess_what` takes a written clue in
place of a photo and the database accepts either; the two are equal-weight
chips in one row with "Neither is the fallback" under them. Every shipped
starter that implies a camera carries a `camera_free` equivalent, and
`tests/intimate.test.js` parses the migration's insert block and fails if one
does not.

**`ended_reason` is three different things** — `declined` / `left` / `expired` —
and only one of them is about how the evening went. `intimate_session_with()`
drops an ended session, so the screen reads the ROW (`getSessionRow`) to learn
which; a row that is no longer readable falls back to "This session is no
longer open", never to a guess.

**The photo is the honest half of the feature.** `intimate_rounds_of()` never
returns `media_path`; `open_intimate_photo()` is the only route, and it stamps
the round and pulls the object's `media_cleanup` entry to two minutes out.

- The database stops **minting** URLs at two minutes — it cannot expire one
  already minted. So the client mints for **exactly the remainder of the
  window** (`photoUrlTtl`) through `ephemeralSignedUrl()` in db.js, which
  **never reads or writes `urlCache`**. The app's one-hour per-path signed-URL
  cache is the right trade for a snap and actively wrong here.
- The url lives in one piece of component state and is dropped when the viewer
  closes. Never cache it, never re-request it, never persist it.
- **Residual gap, stated in the copy rather than glossed:** the object itself
  survives until the cleanup worker's next run — up to ~15 minutes after the
  two-minute mark — and a client that mints its own URL inside the window can
  give it a longer life. So the copy says the LINK stops working in two minutes
  and the FILE is deleted within about fifteen. It must never say "this photo
  is gone in two minutes", which is not what the system does.

`202609090031_intimate_cleanup.sql` (applied) is what makes any of the cleanup
work: it adds `intimate` to `queue_media_cleanup`'s prefix allowlist and
teaches `claim_media_cleanup` about live rounds. **Uploading under `snaps/`
instead — the obvious workaround if that prefix were missing — gets the photo
deleted out from under a live session.** Use `uploadIntimatePhoto()`.

The nudge rides `signal:<recipient>:<sender>` with event `intimate_changed`,
carrying only `{ room }`. There is no `game:` branch in `realtime_allowed` and
inventing a topic would make the channel silently unreachable.

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

**Three games, one room grammar** (`202609090024_more_games.sql`). Tic-Tac-Toe,
Connect Four and Checkers share the invite, presence, rematch, scoreboard and
chat flow untouched — the client branches in exactly two places, a `BOARDS`
id→component map and `playTurn()` picking the right RPC. **The row is the
authority on which game it is**, not the caller: a resume from a conversation
carries no game, so the board is held back until the first sync rather than
flashing a 3×3 grid over a checkers room.

- **`game_initial_board` is the single source of a starting position.** Never
  build one client-side.
- Connect Four moves are a **column**; the server applies gravity, so a client
  cannot name the square it lands on.
- Checkers uses `play_game_path(invite, integer[], expected_revision)` and
  **re-walks the whole sequence server-side**. A client that submits an invented
  jump chain gets nothing; its staging is only "may I send this yet". **Capture
  is forced**, and every PREFIX of a multi-jump is refused with `Finish the
  jump` — that is the assertion a client-side chain walks straight past.
- `idle_plies` drives the fifty-move draw.
- **A pair can now hold SEVERAL rooms at once**, so anything that used to assume
  one room per pair is wrong. `roomWith()` ranks by what most wants attention
  (your turn, then an invitation, then anything live) instead of taking the
  first it finds, and the SQL harness asserts *this* room ended rather than that
  none remain.
- The JS rules and the SQL are cross-checked by differential fuzz, not by
  inspection: 8350 complete turns replayed through both, plus hand-built
  positions random play never reaches — a king loop that lands back on its own
  square exposed a real bug in the retry detection (`board[path[1]] = ''` is
  false when the path ends where it began, so the move retried as "Board
  changed").

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

**No Play surface prints the partner's real name.** A game is the one screen
that is routinely in a third person's eyeline — phone flat on a table, handed
across, watched for a whole round — so every partner name here is the rotating
alias, exactly as in the chat list and the send sheets. PlayTogether was the
single screen in the app that had missed the convention: it never imported
`useAlias` at all and its `nameOf` reached straight for `display_name`, so the
invitation card, the in-room header, the turn and result lines, the scoreboard,
the away line, the resume list and the game chat's placeholder all named her
outright. `peerAlias(aliasFn, profile, fallback)` in `lib/alias.js` is the one
entry point, and its fallback chain deliberately stops SHORT of `display_name`
— a fallback that prints the real name defeats the only thing this does.

- **The friend picker is the deliberate exception**, and carries the `@handle`
  alongside the alias like the send/add sheets: an alias is three characters
  derived from a name, so two friends can wear the same one for half an hour,
  and inviting the wrong person into a private room is the worse failure.
- **Every call is in render, never in a dependency array.** The polls here (3s
  room sync, 6s room list, 6s `usePlayState`) key on `friend.id`; putting a
  label in one would re-arm it on every 30-minute bucket turnover. No dep array
  changed in this work.
- `components/PeerName.jsx` exists so `Shell` can alias the game-invite banner
  **without subscribing itself** to the alias clock — a bucket turnover would
  otherwise re-render the whole pager and hand CameraScreen and Stories fresh
  inline callbacks.
- **Say what is true about it.** The alias is DERIVED from the name (SNEHA →
  S5), so it raises the cost of a glance and is not anonymity: anyone who
  already knows which two people are playing maps it back instantly. No comment
  or user-facing copy claims otherwise.
- **The push notification still carries the sender's real name**
  (`KINDS` in `supabase/functions/push/index.ts`, shared by all seven kinds).
  Aliasing the game kinds alone would be defeated the moment a chat
  notification sits next to it under the real name, so this is left as an
  owner decision about push as a whole, not patched for games only.
- `tests/play-privacy.test.jsx` asserts structurally — "is the real name
  anywhere in what this rendered?" — across the invitation card, the in-room
  header, the turn and result lines, the scoreboard, the picker and GameChat,
  and checks the alias IS shown so deleting the name cannot pass. Verified by
  mutation: making `peerAlias` return `display_name` fails five of its six.

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

## Solo games: Emoji Detective and Memory Flip

Two device-local games, reached from Play. `components/EmojiDetective.jsx` and
`components/MemoryFlip.jsx` are **self-contained cards, not screens** — no
header, no back button, no overlay of their own — so they can be slotted into
Play or any other surface without two shells fighting. Rules live in
`lib/emojiDetective.js` and `lib/memoryFlip.js`, pure and with injectable
randomness, the way `runner.js` and `gameState.js` are. Styles: `styles/solo.css`.

**No database, no migration, no round trip, and no media file of any kind.**
Clues are emoji from the system font, Memory Flip's tiles are emoji or flat
colour, the card back is a CSS pattern. Progress is localStorage
(`lib/soloProgress.js`, key `meera:solo-play-v1`), read through the three-state
rule — `undefined` not asked, `null` the read FAILED, an object otherwise. A
failed read never renders as "no personal best", and a round played on top of a
failed read is **not written**, because writing would overwrite a tally we could
not see.

**`istDayNumber()` in `lib/dayCycle.js` is the client's single day-number
helper, and its epoch is `2024-01-01`.** The database holds two conventions that
disagree — `todays_prompt()` counts from the Unix epoch, `pair_prompt()` and
`send_morning_quotes()` from 2024-01-01, 13 apart mod 30 — and this picks the
one the newest rotation uses. Anything else in `src/` that needs "which day is
it" imports it rather than writing a third. `rotationIndex(day, phase, size)`
is the same cycle `202609090028_bot_rotation.sql` uses: **rotate, do not draw**,
pool size read at call time, so adding a puzzle lengthens the cycle. The IST
*date string* still comes from `istToday()` in db.js.

- **A puzzle id is permanent.** Rotation indexes by POSITION in `PUZZLES`, but
  `puzzleCode()` / `puzzleFromCode()` encode the `id` — `ED1-9L` — which is the
  seam a future "send this one to her" uses: one chat message, no table, no RPC,
  no media. Renumbering breaks codes already sent. A code the reader's pool does
  not have resolves to null (check character), never to the wrong puzzle.
- **No photo tiles.** Memory Flip's `createGame({ tiles })` is where an opt-in
  photo board would attach, and the egress cost is written out at the top of
  `lib/memoryFlip.js`: N pairs is N distinct storage objects, and it would have
  to go through `memories.thumb_path` and the per-path `signedUrl()` cache, or
  every shuffle re-downloads originals into 66px tiles. Not wired, deliberately.
- **No rankings, no punishment.** Personal bests only, device-local, and a
  missed day is never mentioned. Hints are free; "Show me" is remembered but is
  not counted as a solve, so the one number the player sees stays true.
- The board is **four columns at every pair count** — following the pair count
  would give 31px cells at 320px, under the touch minimum.
- **The card flip is a CSS transition between two end states**, not a keyframe
  sequence. That is what makes the global `prefers-reduced-motion` rule safe:
  it collapses the duration and the tile lands instantly face-up or face-down,
  never stuck mid-rotation. The look-at-it pause between two tiles is
  comprehension, not motion, and is NOT shortened.
- `.ed-card` and `.mf-done` are vibrant fills and are listed in index.css's
  fixed-light context. They are painted from CSS, not from an inline style, so
  the fill and the pinned ink cannot come apart.

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

**`prefers-reduced-motion` must actually exist.** For a long time it did not,
while comments in `index.css`, `capture.css`, `games.css` AND `HeartBurst.jsx`
all claimed "the global rule collapses every duration to 0.01ms, so this
degrades to its finished state". Four files documented a rule that was never in
the stylesheet, and every entrance animation, the tapback burst, the skeleton
pulse and both infinite status dots ran at full speed for someone who had asked
their OS for none of it. It is 0.01ms rather than `none` so `animationend`
still fires, and `animation-iteration-count: 1` is what actually stops the
infinite pulses.

**Dark mode redefines TOKENS ONLY** — no rule set is duplicated. The clever part
is the **fixed-light / fixed-dark context**: a list of selectors for vibrant-fill
and near-black-chrome cards that re-declare `--ink`/`--muted`/`--card` for their
own subtree, so a lavender card's contents stay legible without a second copy of
every rule. **A vibrant fill applied from an INLINE style never enters that
context** — that is how `.fp-stat` ended up near-white text on lavender at
night. If you paint a card from JS, add its selector to the list.

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
