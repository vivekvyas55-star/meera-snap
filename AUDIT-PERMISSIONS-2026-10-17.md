# Meera audit and permission recovery — 2026-10-17

Baseline: eb2f515, integrate/live, /Users/vivekvyas/meera/.claude/worktrees/integrate.
User reports iPhone Safari/Chrome and home-screen app. This pass prioritizes permission, location and media lifecycle bugs; it is not an exhaustive certification of every module or old worktree.

## Confirmed findings and fixes

1. P1: automatic location upsert could revive an expired share or recreate a deleted row. Added refresh_live_location RPC: authenticated owner only, UPDATE only, sharing and expiry checked server-side. Explicit Share remains separate. Production migration 202610170140_location_refresh applied successfully.
2. P1: camera-release event during an active camera pane immediately reacquired the camera while a call was starting. CameraScreen now stays inactive for the duration of a call.
3. P2: camera denial was retried by visibility/pageshow/pane lifecycle. Denial now suppresses automatic starts until explicit retry. Retry checks for a still-blocked grant; settings recovery has its own button. Stale failed acquisitions no longer fall through to extra attempts.
4. P2: location permission was only checked once; restoring it did not restart a stopped watch. Permission change, focus and visibility now recheck access. Denials stop the watch; unknown permissions after denial do not loop automatically.
5. P2: location throttle recorded a fix before the database acknowledged it. Failed writes could suppress unchanged fixes for ten minutes. Acknowledgement now gates the throttle; in-flight fixes are serialized.
6. P2: friend locations refreshed every two minutes only when the viewer also shared. Refresh now runs every 15 seconds while the map is visible, even in Ghost Mode, and on reconnect/return. This reads friends' existing authorized pins; it does not acquire the viewer's location in Ghost Mode.
7. P2: overlapping map loads could insert stale/duplicate markers during profile fetches. A generation guard and prefetch before marker replacement prevent stale commits.
8. P2: queued geolocation callbacks could run after watch cleanup. Cancelled/hidden callbacks are now ignored.

## Verification

- 92 frontend test files, 1,066 tests passed.
- Full PGlite migration/database suite passed, including refresh-only ownership, no insert and no expired-share resurrection.
- Build, source lint and diff whitespace checks passed. Existing lazy Three.js size warning remains.
- Added regressions for restored/revoked permissions, failed writes, late callbacks and denied camera automatic retry suppression.
- Source inspection also covered call signaling/relay authorization, shared-play synchronization, island retry behavior, audio recorder and outbox. No user coordinates, camera frames or real calls were acquired for testing.

## Remaining findings and limits

- Live publishing is currently scoped to the open, visible Map screen. Leaving Map stops the watch. Closed/background iPhone web apps cannot be promised continuous tracking. Broader foreground sharing needs an explicit product/privacy decision and a persistent visible indicator.
- Browser/OS permission persistence is outside Meera's control. Safari, Chrome and home-screen contexts need real-device verification. No claim that permission will never be requested again.
- Voice recorder rapid stop/start has a potential old onstop callback/new stream ownership race; identified by source review, not yet reproduced or changed in this pass.
- New shared activities lack push notifications; open their shared space to see updates.
- Actual two-phone audio/video calls and network handover remain an acceptance test.
- Other linked worktrees were inventoried but not merged or certified. This report concerns the integration release only.

## iPhone acceptance checklist

1. Open the updated app, allow camera, leave/return to Camera repeatedly; dismiss once and verify no repeated automatic prompt.
2. Restore blocked Camera access in browser/site settings and use “I’ve updated settings”.
3. Share location while Map is open; deny and restore permission, then use Retry location access without toggling friendship or signing out.
4. Check device Location Services. Test a network interruption followed by recovery and verify the pin's updated timestamp advances after a successful write.
5. Go Ghost: confirm own row disappears, friend pins still refresh, and an expired timed share does not restart itself.

Frontend deployment receipt will be appended after release verification.
