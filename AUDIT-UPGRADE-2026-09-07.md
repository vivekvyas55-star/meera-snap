# Meera audit upgrade — 7 September 2026

This pass reviewed the production client, private Realtime setup, media lifecycle, database RPCs, scheduled work, billing rules, mobile accessibility, and dependency health.

## Implemented

`supabase/migrations/202609070012_integrity_followup.sql` is an **existing-project upgrade**. It must be applied after `202609070011_credits.sql`; it is not part of the fresh-install baseline.

- Media cleanup now treats `messages.thumb_path` as a live reference. It also queues thumbnails when an expiring message is purged.
- Question asks lock the friendship row while enforcing the three-per-day limit, preventing simultaneous requests from exceeding the cap.
- Chat-list question badges count only unanswered questions from the current IST day, matching the cards people can actually see.
- Monthly credits are prepaid: the scheduled job does not create negative balances. Entitlement rejects expired `active` subscriptions and negative balances.
- Realtime subscriptions in Chat List and Stories now follow the active account correctly; the lint suite is clean.
- The app-open keypad now supports hardware keyboards without announcing entry or error state, which preserves nearby privacy.

## Validation

- `npm test` — 63 tests passed.
- `npm run test:db` — baseline, audit upgrade, full follow-up chain, and new media/question/billing regressions passed.
- `npm run lint` — passed with no warnings.
- `npm run build` — production build passed.
- `npm audit --omit=dev --audit-level=high` — no production vulnerabilities.

## Deployment state

The web UI is live. The follow-up database migration is ready and tested locally, but has not been applied to the linked Supabase project from this workspace because the Supabase CLI is not linked to that project. The linked-project command reports `LegacyProjectNotLinkedError`; applying this migration requires linking with the project database credentials or running the migration in the Supabase SQL editor.

## Next product work

1. Replace the bundled fixed app-open PIN with a user-created local lock backed by WebAuthn/device authentication where supported. The current lock is a convenience barrier, not cryptographic protection.
2. Add sender-visible save consent for disappearing snaps: receiving a snap should not silently permit device export unless the sender allows it or the message is mutually saved in chat.
3. Add an account privacy centre: export/delete account data, active-device/session list, blocked contacts, and a clear explanation of what screenshots can and cannot be detected in a browser.
4. Add a small relationship timeline built from opt-in shared events—first snap, streak milestones, and mutually saved media—kept private to the pair.
5. Add observability that records anonymous operational failures (upload, cleanup, Realtime join, push delivery) without collecting message bodies, media, or location history.
