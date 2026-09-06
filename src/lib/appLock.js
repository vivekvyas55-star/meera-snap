export const UNLOCK_KEY = 'meera:unlocked'
const KEY = UNLOCK_KEY
export function isUnlocked() {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

// Re-lock the app from anywhere (e.g. a Lock button in Profile).
export function lockApp() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('meera:lock'))
}

