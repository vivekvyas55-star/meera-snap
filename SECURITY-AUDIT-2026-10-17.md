# Meera security audit and hardening — 2026-10-17

Scope: integration branch at 0e4f64a plus this hardening release. Production project mqxfggwncoazgmcswedi; frontend meera.bigadtruck.com. Read-only live probes did not retrieve chat bodies, photos, private keys or precise coordinates.

## Conclusion

Meera has server-enforced account/friend access controls and a private media bucket, but it is NOT an end-to-end encrypted messenger. It is not accurate to promise that everything is secure against every threat. An authorized recipient can retain received content; an operator with backend privileges can access server-stored plaintext. No independent penetration test or full infrastructure attestation was performed.

## Live evidence

- Every public-schema table has row-level security enabled (catalog query returned an empty list of exceptions).
- Media bucket is private. Storage read policies require owner or authorized message/story/scrapbook/intimate access; row-level policies still govern referenced rows.
- Anonymous reads of messages, profiles, locations, scrapbook_items, shared_play and call_relay_config returned 401. The public project key was separately validated against auth/settings (200), avoiding a false result from an invalid key.
- The media-cleanup schedule is active. This confirms scheduling, not the success of every object deletion.
- Production migration 202610170150_media_limits applied: private media, 50 MiB per object, JPEG/PNG/WebP/GIF/audio/video MIME allowlist. HTML/SVG are excluded. MIME constraints are not malware scanning.

## Hardening in this release

1. Browser Content Security Policy restricts executable scripts to this origin and network destinations to the application's required services. Frames and objects are blocked, base URI overrides forbidden. Inline styles remain necessary for React/Leaflet; inline scripts and eval are not permitted.
2. X-Frame-Options DENY, nosniff, no-referrer, HSTS and same-origin camera/microphone/location Permissions Policy.
3. Default media bearer URL lifetime reduced from one hour to five minutes. A request for a shorter lifetime no longer returns a longer cached token. Supabase-issued URLs remain valid until their expiry; already minted links are not revoked by this release.
4. New uploads use cacheControl 0 rather than a day-long browser cache. Existing object metadata/cache entries are not retroactively rewritten.
5. Image uploads are always canvas-re-encoded, including small files, so original EXIF/GPS metadata is not passed through. Decode/encode failure aborts rather than sending the original. This changes animated-image handling to a still JPEG. Videos and previously stored media have not been metadata-sanitized.
6. Private bucket file size and MIME restrictions applied server-side. No existing content deleted.

## Verification

- Full frontend suite: 93 files, 1,069 tests passed.
- Full PGlite migration/database suite passed, exercising cross-user, outsider, block, media, secret-field and expired-content access scenarios. PGlite mocks Supabase service schemas; it does not prove all cloud service behavior.
- Added image fail-closed/re-encoding and signed URL lifetime regressions.
- Production npm dependency audit: zero reported vulnerabilities at audit time.
- Build, source lint and diff checks passed.

## Residual risks and next priorities

- P1: E2EE is only unused primitives in e2e.js; uploads/viewers and messages do not use it. A complete rollout needs device identity verification, authenticated key exchange, multi-device key management, recovery and migration design. It must not be represented as complete by simply wiring a cipher into one upload path.
- P1: the app ships a known default convenience passcode; owners should choose their own code in Profile. No user's authentication credential was changed. The local lock is not a cryptographic boundary against someone controlling the browser or device.
- P2: auth sessions and pending plaintext messages exist in browser storage. CSP reduces script-injection exposure but does not encrypt this storage or protect a compromised device.
- P2: an accepted friend can retrieve static TURN credentials. They are not an administrative key, but can consume relay quota. Short-lived per-call credentials and quotas should follow.
- P2: push sender checks accepted friendship and restricts endpoints, but stronger abuse/rate limits and redirect refusal deserve a separately tested Edge Function update. No Edge Function changes were deployed in this pass.
- P2: videos/old media may retain metadata; previously issued signed links and downloaded files cannot be recalled through this frontend release.
- Real two-device iPhone camera, microphone, media and network-handover testing remains necessary.

Sources: https://supabase.com/docs/guides/storage/buckets/fundamentals ; https://supabase.com/docs/guides/storage/serving/downloads ; https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors

## Release

Production backend applied. Code SHA 20797d8 pushed to GitHub and deployed as dpl_FS3dw73jY4m47igoeLEMgosCPohf, READY at https://meera.bigadtruck.com. Served entry /assets/index-DTz6AbHr.js matches the tested build. All six configured security headers verified over HTTP. Signed-in Chrome chat-list smoke check loaded with no captured console errors; no message or media was sent. Storage verification confirmed private=false is NOT set: public is false, with 52428800 byte limit and the expected MIME allowlist.
