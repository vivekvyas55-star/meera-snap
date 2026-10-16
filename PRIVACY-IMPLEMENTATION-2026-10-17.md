# Private content implementation — 2026-10-17

## Release state
**Candidate, not a completed privacy rollout.** Branch `codex/private-content`, based on `a86a318`. Encryption defaults OFF unless `VITE_PRIVATE_CONTENT=true`. Migration `202610170160_private_identity` is deliberately listed in `.unapplied`. Do not enable this flag on production until the release blockers below are resolved. Generic notification rendering can ship independently with the encryption flag OFF.

## Implemented candidate
- New direct chats/stickers/captions: authenticated encrypted envelopes before message insertion. New direct photos/video/voice: encrypted binary files before storage upload, decrypted to in-memory blob URLs at viewing time. No plaintext thumbnails for new encrypted messages.
- P-256 ECDH with per-object random 256-bit HKDF salt, AES-256-GCM, random 96-bit IV, authenticated header binding sender/recipient, kind, client ID or media path. Both directions use verified public identities. This is NOT Signal Protocol and has NO forward secrecy or post-compromise security.
- Account encryption identity is immutable through client grants. Private identity is held locally under a 12+-character privacy passphrase (PBKDF2-SHA256, 600,000 iterations, AES-GCM); server recovery backup is wrapped under a random 256-bit recovery secret. The login password alone cannot unwrap it.
- New-device recovery requires that separate secret. Full SHA-256 public-key fingerprints are compared out of band and pinned inside encrypted local storage. Key changes block sends. This is account-identity verification, NOT a complete per-device certificate/approval/revocation system.
- Local outbox entries encrypted with a separate local AES key. Valid legacy entries migrate only after encrypted persistence succeeds. Queue item IDs stay stable. Composer text/voice drafts remain memory-only. Decoded story thumbnails no longer persist in localStorage.
- Privacy gate on reload and after 30 seconds hidden; explicit Lock drops in-memory keys and media URLs. A personal screen PIN is required; shipped defaults cannot be chosen. The four-digit PIN is a convenience screen lock; the longer privacy passphrase protects stored keys.
- Generic notification title/body forced by the service worker, even for legacy/malformed payloads. Push function source no longer reads names.
- Candidate SQL prevents old-client plaintext direct-message inserts after either participant enrolls, rejects plaintext direct-media uploads, and makes enrollment/scheduled sending mutually exclusive while old scheduled rows remain.
- Encrypted messages that cannot be decrypted are non-actionable and do not accrue seen/open counts merely from their placeholder.

## Validation
- Full default-mode suite: 101 files / 1,100 tests passed.
- Candidate crypto tests exercise both parties; text/image/video/voice round trips; tampering; context swapping; wrong recovery secret; new login without local keys; unverified/changed identities; encrypted local outbox migration and relock; lock during password derivation.
- PGlite migration chain and owner/peer/stranger/anonymous access checks passed. Identity update denied; backup hidden from friends; plaintext downgrade denied.
- Source lint, candidate production build with `VITE_PRIVATE_CONTENT=true`, and diff checks passed (large bundle warning remains).
- Chrome synthetic local UI: setup, explicit recovery acknowledgement, personal PIN confirmation, unlock and cold-reload gate verified. 390px layout inspected. No real user credentials or content used.

## Release blockers / honest limits
1. Independent cryptographic review and actual two-device iPhone Safari/home-screen acceptance, recovery and data-loss tests are not completed.
2. Existing server messages, media, backups and signed URL/browser copies are NOT retroactively encrypted. A resumable client-side legacy migration and backup retention decision are still required. Never erase old content before verifying encrypted replacement.
3. Stories, shared spaces, game answers, scheduled messages and other content tables are not covered. Candidate scheduled sending and cloud Memories save are blocked rather than silently downgrade encrypted chats. Server bot/morning quote paths also need compatibility handling before enrollment is released.
4. Per-device signed approval, device-key rotation/revocation and recovery rotation remain unimplemented. Recovered devices currently share an account identity. Revoking an auth session cannot revoke previously copied keys or content.
5. Corrupt legacy drafts remain preserved; their recovery/migration UX is unfinished. Mood logs and other non-message local state still need an at-rest inventory/migration. Forgotten passphrase recovery on a device already holding a vault is intentionally refused to avoid orphaning its local draft key; use a fresh browser/device until a safe replacement flow exists.
6. Browser-delivered JavaScript, XSS or a compromised unlocked device can access plaintext. Server metadata (participants, timings, sizes, kinds) remains visible. This does not promise screenshot prevention or security against a malicious web app update.
7. Full media retry/cancel/download and all data-export paths need enabled-mode integration coverage. Unit tests and a build are not a production security audit.

## Next release work
Resolve the blockers, test migration replay and mixed-version clients against staging, complete the enabled-mode integration suite, then apply the upgrade migration (never the fresh baseline), remove its `.unapplied` entry, and enable the build flag for a controlled opt-in rollout. User must choose their real passphrase and retain their recovery key themselves.

## Design references
- https://signal.org/docs/specifications/sesame/ — multi-device session lifecycle considerations.
- https://signal.org/docs/specifications/doubleratchet/ — the forward-secrecy properties this candidate does not provide.
- https://doc.libsodium.org/secret-key_cryptography/encrypted-messages — authenticated message/context handling.

## Production receipt — notification display only
- Notification-only commit `b229fd2` deployed from isolated clean worktree `/tmp/meera-private-notification-release`.
- Deployment https://meera-7y3qrn53k-meeraapplication.vercel.app successfully aliased to https://meera.bigadtruck.com.
- Live `/sw.js` HTTP 200 verified version `meera-v5`, fixed title `Meera`, fixed body `Open Meera to view your update.`
- Existing installations must open/reload once to activate the updated worker. Previously displayed notifications are not retroactively rewritten.
- Push Edge Function source is changed in Git but that server function has NOT been deployed. The updated worker ignores legacy title/body payloads, so lock-screen display is generic after worker activation.
- No encryption code, encryption flag or identity migration was included in this production deployment. Production E2EE status is unchanged.
