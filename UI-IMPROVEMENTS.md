# Meera UI improvements

6 September 2026 · Implemented locally on `codex/audit-fixes`; not deployed.

## Changes

- Refreshed login, signup, and recovery screens with a compact brand mark, clearer typography, lavender input surfaces, persistent labels for primary fields, and readable error messages.
- Added an accessible show/hide password control that resets when switching forms. Form switching is disabled during submission.
- Chats now open first. Camera still activates only when selected.
- Added chat search using currently displayed names, including rotating aliases; searching does not reveal hidden real names.
- Highlighted unread conversations and improved row spacing, text contrast, and outgoing message distinction.
- Added useful empty states with direct actions to add a friend or capture a story, plus separate loading states so an unfinished request does not look like an empty account.
- Made active navigation more obvious, enlarged common touch targets, added keyboard focus outlines, and excluded off-screen panes from keyboard and accessibility navigation.
- Added reduced-motion styling and corrected swipe thresholds for the centered desktop phone layout.
- Kept story content clear of the bottom navigation and made long authentication forms scrollable on short screens.
- Friend-request failures now display an error toast instead of failing silently.

## Verification

- All 21 existing regression tests pass.
- Lint and production build pass.
- Browser inspection confirms updated login/signup layout and password-visibility toggle/reset.
- Signed-in screens were reviewed in source; authenticated browser verification remains pending access to disposable Meera accounts. No live accounts or messages were created.

These UI changes are part of the same local branch as the audit fixes. Deployment still requires the coordinated database/function/frontend rollout in README.md and access to the correct Supabase project.

## 7 September 2026 — craft pass and three small delights

### Craft

- **Design tokens.** Added a spacing scale (`--sp-1..7`), a type scale
  (`--fs-display` … `--fs-eyebrow`) and two more radii (`--r-tile`, `--r-sheet`)
  to `src/index.css`, with values chosen to match what already shipped so
  adoption is not a visual change. Applied to the rules touched in this pass;
  the rest of the sheet still carries its original literals.
- **Emoji removed from chrome**, per the documented design language: the camera
  tray (💾/📖/➤ → Save / Story / Send to line icons), the Profile stat cards
  (now the same icon-above-number card the friend sheet uses), the push toggle,
  the chat-list status note, the friend-sheet chevron, the Memories play badge,
  and the chat header's 📱 "in the chat" marker.
- **Chat header fits at 320px.** The "in the chat" marker moved onto the corner
  of the friend's avatar; the name was previously truncated to about one
  character when it appeared.
- **Stories** got a header action to post, a persistent "Your story" row for
  when you have not posted (posting was reachable only by swiping to the camera
  and guessing), and the expiry moved to the right-hand column so the row has a
  hierarchy rather than one long sentence.
- **Memories** got skeleton tiles in place of a bare "Loading…" line and an
  illustrated empty state matching the other screens.
- **Chat's empty thread** and the two existing empty states now use line icons
  rather than `＋` and `☀` characters.
- **Snap Map** leads with the distance between you as a vibrant card and a big
  light number, with the sharing state as chips underneath.
- **Touch targets.** `.pill`, `.cam-filter`, `.chat-peer` and the chat list's
  own-avatar button were all between 34 and 43px; all are now at least 44px.
  Verified at 320px: no element under 44px, no horizontal overflow on any screen.

### Delight

- **Messages land.** A message that arrives or sends while the thread is open
  animates in from the side it belongs to. History and the first page do not
  (see `knownRef` in `Chat.jsx`).
- **Double-tap throws hearts.** The ❤️ tapback needed a round trip before
  anything appeared on screen; six hearts now leave the point you tapped,
  immediately, and only when a reaction is being added rather than taken back.
- **The app greets you.** The chat list's static subtitle became a time-of-day
  greeting by name, which also says when a friend has a birthday today (already
  loaded for the row markers). The "days together" chip now also appears on
  every hundredth day, not only on the anniversary.

### Verification

- 37 tests pass; `npx oxlint src` reports only the two pre-existing
  exhaustive-deps warnings; `npm run build` succeeds.
- Every visual change was inspected in Chrome against the compiled stylesheet at
  320px and 390px, with geometry measured via `getBoundingClientRect`.
  Animations were inspected frame by frame by pausing them at fixed offsets.
- Not verified in the running app: this pass had no account to sign in with, so
  the screens were reproduced from the real compiled CSS with representative
  markup rather than driven live.
