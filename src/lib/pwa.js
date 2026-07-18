// Service worker registration + install-prompt plumbing.

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  // Registering during dev would cache Vite's module graph and produce very
  // confusing stale-code bugs.
  if (import.meta.env.DEV) return

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed registration only costs offline support; the app still runs.
    })
  })
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  // iOS predates display-mode and exposes its own flag instead.
  window.navigator.standalone === true

export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS 13+ reports itself as a Mac; the touch check disambiguates.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

// Only Safari can install a PWA on iOS. Chrome, Firefox and Edge on iOS are all
// WebKit wrappers without the Add to Home Screen affordance, so users on those
// need to be told to switch browsers rather than shown an install button.
export const isIOSSafari = () => {
  if (!isIOS()) return false
  const ua = navigator.userAgent
  return /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua)
}
