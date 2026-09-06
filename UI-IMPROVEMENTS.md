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
