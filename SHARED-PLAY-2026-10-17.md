# Shared Play — implementation and release checklist

## Implemented

- Continue Together in Us, scoped to the selected person. Includes new activity counts and existing unanswered-question/board-game continuations.
- Play & date jar in Chat. Opens an interactive panel without leaving the conversation. The existing board-game continuation remains accessible.
- Shared activities in Play after selecting a friend.
- Guess My Pick: author supplies two choices and a secret choice; recipient accepts, guesses, then both see the reveal.
- Emoji Decoder: author supplies a clue and a hidden answer. One guess, matched case-insensitively after trimming. No semantic/AI answer matching.
- Word Rally: alternate twelve English words using the previous word's final letter. Server enforces turns, letter matching, length and no repeats. Players judge dictionary validity.
- Story Relay: alternate eight sentences, each at most 240 characters, then retain the completed story until expiry.
- Shared date jar: both can add ideas, shake to spotlight an idea, and express interest. Mutual interest is explicitly not a booking.

The activities live in an interactive panel within chat, not as new messages in the chronological transcript. Opening/closing the panel preserves saved server state. The original Little Moments visit-only jar is unchanged.

## Privacy and behavior

The new table has RLS enabled and no direct client grants. Security-definer RPCs validate authenticated pair membership, accepted friendship, blocks, expiry and optimistic revisions. Secret answers are excluded from reads, including the author's read, until the guess is submitted. Removing friendship immediately deletes the pair's shared activities. A scheduled purge removes expired or inaccessible rows.

Game retention is seven days; date ideas last thirty days. Either person can pass/end an activity and remove an ended item for both after confirmation. Up to forty unexpired activities per pair bounds reads and storage. This is server-stored content, not E2EE; the UI explains this in its privacy details. Unsent drafts last only while their form remains open.

Creation has a stable request UUID; retries return the same row. Turns require the current revision and a request UUID; duplicate retries do not advance again. Refresh responses have a generation guard so an older request cannot replace newer or another person's data. Network failures preserve the last confirmed rows and show an error.

No push notifications for these new activities yet. They refresh every six seconds while visible, on reconnect and on returning to the tab. Existing game invitations are unaffected. Real-device push and two-device production testing were not performed.

## Postcard Island and calls

Postcard Island is an original live co-op delivery game with two independently controlled characters, five deliveries, a cooperative gate, saved progress, a lazy-loaded 3D island and optional original synthesized music. Server-authoritative movement validates membership, acceptance, sequence numbers, duplicate retries, movement speed and map boundaries. Private realtime hints accelerate updates; polling recovers missed hints. Mobile layout was inspected in two 390x844 frames. The Three.js chunk is lazy-loaded and produces a build size warning.

Calls now fetch dedicated TURN credentials through an authenticated friend-only RPC. Credentials are not committed or embedded in the public bundle. Incoming ringing acknowledgement, repeated acceptance/offer handshakes, duplicate protection, ICE restart, longer reconnect grace and an audio playback recovery button address observed failure paths. Relay credentials still reach participating browsers as required by WebRTC; they are static, not short-lived credentials.

## Validation

- Full frontend suite: 92 files, 1,062 tests passed.
- Database suite passed, including island movement, independent player sequences, gate unlock, delivery completion, authorization and relay access controls.
- Production build, source lint and git diff checks passed.
- Real browser relay-only test: two RTCPeerConnections exchanged a data-channel message and reply through the new Metered relay. No microphone or camera used.
- Two-phone production audio/video and real-device push acceptance remain to be tested. New shared activities do not yet send push notifications.

## Production backend applied

Only upgrades 202610170110_shared_play, 202610170120_postcard_island and 202610170130_call_relay were applied to mqxfggwncoazgmcswedi. Baseline was not applied. Production verification returned three migration records, five ICE servers, relay RLS enabled and one active meera-shared-play-purge schedule (job 10, every 15 minutes).

Metered workspace meeraconnect: credential “Meera voice and video calls” created with user approval. Dashboard showed Free $0/month, 50 GB and auto-reload disabled; no paid plan or billing setting changed. Credential values are intentionally omitted.

## Frontend release

Release tests are green; GitHub push and Vercel production deployment are the next release steps. Record the resulting SHA and verified asset receipt below after deployment.
