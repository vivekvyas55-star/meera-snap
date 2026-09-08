// What to tell a user whose camera did not start, and whether a Retry button
// would be honest.
//
// Kept out of the component file so that file exports only a component (fast
// refresh / lint), and so the decision itself is testable without rendering.

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/**
 * A retry may only be offered where the next getUserMedia could plausibly
 * answer differently. An insecure origin and a browser without getUserMedia
 * will fail identically forever, and a hard "denied" in the Permissions API
 * can only be undone in the browser's own settings — offering a button there
 * is offering a button that does nothing.
 */
export function canRetry(kind, blocked) {
  if (kind === 'insecure' || kind === 'unsupported') return false
  if (kind === 'denied' && blocked === true) return false
  return true
}

/**
 * How to un-block the camera. Deliberately generic: every browser words this
 * differently, and naming a version-specific menu path ages worse than
 * describing the control.
 */
export function unblockSteps() {
  if (isIOS()) {
    return 'Tap “aA” in Safari’s address bar → Website Settings → Camera → Allow, then reload this page.'
  }
  return 'Tap the lock or ⓘ icon beside the address → Permissions → Camera → Allow, then reload this page.'
}
