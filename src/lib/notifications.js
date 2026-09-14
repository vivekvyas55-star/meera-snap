// Ordering for the one notification strip. Priority 1 sits closest to the tab
// bar, where the thumb and the eye are; anything less urgent stacks upward and
// away from it.
//
// This is a value, not a component, so it lives outside NotificationStack.jsx —
// a module that exports both breaks fast refresh and the lint rule.
export const PRIORITY = {
  // You cannot do anything until this changes.
  offline: 1,
  // Something is actually waiting for a decision.
  game: 2,
  // The result of what you just did. Transient, so it must never be buried.
  toast: 3,
  // A feature is missing because the database is behind the bundle.
  drift: 4,
  // Live updates moved to another account, or could not be joined at all.
  // Below drift because drift explains a feature that is already broken,
  // while this is usually a confirmation that something worked.
  account: 5,
  // A suggestion. Always the first thing to give up its place.
  install: 6,
}
