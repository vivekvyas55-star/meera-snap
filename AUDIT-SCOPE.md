# Deep audit scope — 9 Sep 2026

Ordered as instructed: **today's deployments and changes first**, then the rest
of the system. Compiled before the audit so it targets a known surface rather
than sweeping blindly.

## Phase 1 — everything shipped today (highest priority)

**32 commits.** All deployed to production and verified in the served bundle.

### Migrations applied to the live database today (8 of them, 0016–0023)
| Migration | What it changed | Risk to probe |
|---|---|---|
| `0016_egress` | `ops_metrics` + daily cron | Operator-only grants; the story×audience projection |
| `0017_schema_version` | `schema_migrations`, `schema_version()` | Only the newest id is public; the rest operator-only |
| `0018_privacy` | `blocks`, `user_devices`, `locations.expires_at`, export/delete | **Blocking is a security boundary.** `FOR ALL` includes SELECT |
| `0019_rematch` | rounds, alternating starter, `game_turn()` | Turn rule must match the client exactly |
| `0020_game_score` | series score written in the result UPDATE | Exactly-once counting under retries |
| `0021_answer_question_fix` | `"body" is ambiguous` | Was live-broken; parameter/column shadowing elsewhere? |
| `0022_security_followup` | push endpoint allowlist, display-name cap, block grants, `media_read` thumbs | Cleanup DELETE ran against live rows |
| `0023_founders` | all 8 accounts grandfathered | Silent until `enforced` flips |

### Client changes shipped today
Mandatory passcode with a seeded default and a retired-default migration ·
re-lock on background (and the call-alive exemption that followed) ·
Back-as-layers · one notification strip · Play in the chat header with shared
poll state · rematch + scoreboard UI · chat rows reduced to one signal ·
Stories/Camera/Map polish · Privacy Centre + its design pass · market decoy
rebuilt · outbox re-entry · call recovery (declined/mic-denied/push) ·
location grant from a tap.

### Specific things to attack in phase 1
1. **The passcode chain.** Default seeded → changed to 9934 → retired-default
   migration. Any device state that ends up unopenable? Lockout interaction?
2. **Re-lock on background.** It already caused one CRITICAL (killed live
   calls). What else unmounts under it — an upload mid-flight, a recording, a
   snap being sent?
3. **`0022`'s DELETE ran against production rows.** Confirm no legitimate push
   subscription was destroyed, and that the constraint accepts every real push
   host (FCM, Apple, Mozilla with its `updates.` prefix, Windows `wns2-*`).
4. **Blocking**, end to end: messages, requests, stories, calls, push,
   reactions, saves, anniversaries.
5. **Founders.** `entitlement()` and `post_monthly_credits()` under
   `enforced = true`, since that is the moment any mistake becomes visible.
6. **The state-honesty class.** Three instances found today (blocked list,
   location, Snap Map). Is there a fourth?
7. **My own regressions.** Three today: `watchAllowed` treating `denied` as
   allowed, `oldestCursor` on an empty page, and the call-killing lock. Look
   for a fourth in the same commits.

## Phase 2 — the rest of the system
Areas today's work did not touch: the camera and snap pipeline, stories and the
story viewer, memories, voice notes, the composer's six gestures, recovery,
streaks and charms, the bot/quotes cron, the cleanup worker, the service worker
and PWA update path, `billing-webhook`, and everything in `AUDIT-FIXES.md` that
predates today.

## Standing rules for the audit
- **Prove the failure sequence.** A code smell is not a finding.
- Anything CLAUDE.md documents as intentional is a false positive — unless the
  code has since diverged from it, which is the most valuable finding of all.
- List what was checked and found clean, so coverage is legible.
- Read-only. No edits, no git, no deploys, no production writes.
