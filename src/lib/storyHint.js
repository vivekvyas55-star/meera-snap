// "Shown once, ever" for the story viewer's tap/hold hint.
//
// Lives here rather than beside the component because a file exports either
// components or hooks/helpers, never both — mixing them breaks fast refresh
// and trips the lint rule.
//
// localStorage, not sessionStorage: a hint that comes back on every reload or
// in a fresh tab is a hint on every open, which is the thing to avoid.

const KEY = 'meera:story-hint-v1'

export function storyHintPending() {
  try {
    return localStorage.getItem(KEY) !== 'seen'
  } catch {
    // Private mode / storage blocked: we cannot promise "once ever", and a
    // hint on every single open is worse than none at all.
    return false
  }
}

export function markStoryHintSeen() {
  try {
    localStorage.setItem(KEY, 'seen')
  } catch {
    // nothing to do
  }
}
