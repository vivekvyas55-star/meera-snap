// Defense in depth: old auth responses must never persist recovery input in a session.
export function sanitizeAuthValue(value) {
  try {
    return JSON.stringify(JSON.parse(value), (key, item) =>
      key === 'recovery_answer' || key === 'recovery_question' ? undefined : item)
  } catch { return value }
}
export const authStorage = {
  getItem(key) {
    const value = localStorage.getItem(key)
    if (value === null) return null
    const clean = sanitizeAuthValue(value)
    if (clean !== value) localStorage.setItem(key, clean)
    return clean
  },
  setItem(key, value) { localStorage.setItem(key, sanitizeAuthValue(value)) },
  removeItem(key) { localStorage.removeItem(key) },
}
