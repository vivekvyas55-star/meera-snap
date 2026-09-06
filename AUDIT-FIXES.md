# Meera audit fixes — implementation handover

Date: 6 September 2026. Branch: `codex/audit-fixes`.

**Implemented locally, not live.** No production database migrations, function
deployments, account changes, or frontend deployment were performed.

## Findings addressed

| Original finding | Implementation |
|---|---|
| R01 Map HTML injection | DOM textContent for avatar and popup content; profile validation in upgrade |
| R02 Public call/presence channels | Private writer-specific topics; sender identity derived from subscribed topic; friendship-scoped policies; room and sender validation |
| R03 Recovery answer crosses accounts | Removed browser credential stash; recovery setup is part of the signup database transaction; auth metadata scrubbed |
| R04 Recovery lockout race | Row lock covers answer check and counter update; null password rejected |
| R05 Push remains after logout | Device detachment before signout; errors surfaced; enabled state checks current user's server row |
| R06 Duplicate chat retries | Stable client ID and database uniqueness; ambiguous insert result resolves the already committed message |
| R07 Outbox only runs in Chat | App-level delivery, online event and periodic retry; queue updates synchronize screens |
| R08 Blank profile failure | Loading/error/retry UI, reconnection retry, and account-specific profile gating |
| R09 Timestamp-only paging | Server visibility filter and composite timestamp/ID cursor |
| R10 Unreproducible setup | Ordered guarded baseline, upgrade migration, fresh/upgrade/replay database tests and rewritten setup guide |
| D01 Bot setup deletes accounts | Removed account-deletion step from historical setup and generated baseline |
| D02 Repair forces relationships | Removed all-real-users friendship backfill; migrations preserve relationship consent |
| D03 Privileged bot broadcast | Explicit trusted-role-only execution; one delivery per recipient/day; accepted-friendship check |
| D04 Stale loads overwrite messages | Request generation and event-aware reconciliation |
| D05 Updates discard loaded history | Merge rows by ID; updates retain older pages and pagination state |
| D06 Unseen messages counted | IntersectionObserver reports visible message IDs; voice reports playback; server deduplicates each visit |
| D07 Hidden rows conceal preview | Server chooses newest visible message before applying the per-pair result limit |
| D08 Offline draft storage failure | Persistence errors thrown before composer clears; per-item keys prevent cross-tab bulk overwrite; no silent eviction |
| D09 Failed send overwrites new draft | Durable pending items own failed-send text; no late asynchronous draft restoration |
| D10 Partial multi-send duplicates | Stable per-recipient IDs and successful-recipient tracking; frozen retry payload |
| D11 Orphan media | Durable cleanup registered before uploads; owner-only cleanup RPC; scheduled worker with referenced-file checks and deletion claims |
| D12 Incorrect media MIME | Upload metadata and filename extension derive from final blob |
| D13 Media cache crosses accounts | Cache cleared on account transitions; in-flight signing generation check |
| D14 Story index invalidation | Stable author/story selection with safe fallback when current media disappears |
| D15 Story timer precedes image | Readiness gates timer and view receipt; media error state |
| D16 StrictMode voice playback | Setup resets alive flag; isolated VoicePlayer component and lifecycle regression test |
| D17 Incoming call rings forever | Bounded invite expiry; cancel on early outgoing abort; stale room/sender events rejected |
| D18 Call history purged | Call rows excluded from automatic expiry |
| D19 Daily answers do not refresh | Active polling and focus/visibility refresh |
| D20 Midnight question mismatch | Server validates day and prompt atomically; client refreshes and preserves draft for review |

Additional reliability work: per-account shell reset, observable list errors,
late WebRTC operation guards, media ownership validation, clean component/hook
export separation, and lazy-loading for optional screens. Dependency updates
remove the reported development vulnerabilities.

## Local verification

- `npm run lint`: no errors or warnings.
- `npm test`: 21 passing component and unit regression tests for outbox, media, message
  merge, auth, voice lifecycle, stories, call expiry, and daily questions.
- `npm run test:db`: PGlite executes the actual baseline and upgrade SQL,
  including repeated upgrade, auth metadata scrubbing, private topic permissions,
  bot ACLs, equal-timestamp paging, exact receipt IDs, idempotent leave, daily
  answer invariants, call retention, media cleanup locks, and recovery revocation.
- `npm run build`: production build with optional screens split into separate
  chunks; initial JavaScript reduced from roughly 686 kB to under 500 kB.
- Dependency audit: zero reported vulnerabilities after updates.
- Browser check: local production PIN unlock, login, and signup forms render.

The SQL fixture models Supabase auth/storage/realtime schemas but does not run
GoTrue, the Storage server, or Realtime services. It cannot certify live tokens,
mobile hardware, delivery through push vendors, or cron operation.

## Deployment blocker and required rollout

The app is configured for `mqxfggwncoazgmcswedi.supabase.co`. The Supabase account
available to this session lists only the inactive `SRPCE Project`, reference
`yrqkamlilytshoikvqza`, and no linked Meera project. The system CLI shim was also
incomplete; a temporary npm-provided CLI was used for the read-only project check.

Do not point this app at that unrelated project or deploy only the frontend.
Authenticate to the organization owning Meera, then follow the coordinated
upgrade/function/frontend rollout in README. The cleanup worker needs its own
secret and authenticated schedule. Private-channel policies must be deployed
and public Realtime access disabled.

**Smoke test status (7 Sep 2026): passed on a real device except calls,
recovery and Android.** Camera and location permission behaviour, chat
gestures, quoted replies across every send kind, run-collapsing and read
receipts, the question cards, destructive-action confirmations, the kept-media
gallery and Profile on a phone were all exercised and behaved. Still
outstanding, because each needs hardware this session could not reach: a real
two-device call with a dropped connection, the password-recovery round trip,
and Android hardware Back.

Production smoke checklist:

1. Create two disposable accounts; verify recovery setup and password reset.
2. Send text and media in both directions, including offline/retry scenarios.
3. Read an older page while receiving reactions and new messages.
4. Confirm read receipts only cover displayed messages and played voice notes.
5. Delete/expire the current story while its viewer is open.
6. Call between two devices, drop the caller connection, and verify ring expiry.
7. Enable notifications, sign out, and verify that device stops receiving them.
8. Verify cleanup succeeds and preserves files still referenced by messages or memories.
9. Verify a stranger cannot publish to another user's signaling/presence topic.
10. Check daily answers across an IST day boundary.

No production test messages, destructive SQL, or live credential changes were
performed in this implementation session. Original review reports remain as
historical evidence; the old bug-probe script intentionally asserts pre-fix
behavior and is superseded for regression testing by this repository's tests.
