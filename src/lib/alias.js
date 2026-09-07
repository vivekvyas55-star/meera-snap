// Rotating display aliases.
//
// Each user gets 3-5 aliases derived deterministically from their name, and the
// one currently shown rotates every 30 minutes. Because the choice is a pure
// function of a global 30-minute time bucket, every viewer sees the same alias
// for a given person at the same moment, and it advances for all of them at
// once — no server, no cron, no stored state. It also applies to every user
// automatically, including ones created later.
//
// The transforms are taken from the requested example — VIVEK -> V, 5, V5,
// KEVIV, KE — i.e. first letter, letter count, letter+count, full reversal, and
// the reversal's first two characters.

export const ALIAS_PERIOD_MS = 30 * 60 * 1000

export function aliasesFor(rawName) {
  const name = String(rawName || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!name) return ['?']

  const rev = [...name].reverse().join('')
  const noVowels = name.replace(/[AEIOU]/g, '')

  const candidates = [
    name[0], // V
    String(name.length), // 5
    name[0] + name.length, // V5
    rev, // KEVIV
    rev.slice(0, 2), // KE
    // Fallbacks, only used when the primary five collapse (very short names):
    name.slice(0, 2), // VI
    noVowels || name[0], // VVK
    name[0] + name[name.length - 1], // VK
  ]

  const seen = new Set()
  const out = []
  for (const c of candidates) {
    if (c && !seen.has(c)) {
      seen.add(c)
      out.push(c)
    }
    if (out.length >= 5) break
  }
  // Guarantee at least three distinct aliases even for a 1-2 char name.
  let n = 1
  while (out.length < 3) {
    const extra = name.slice(0, n) + (n > name.length ? n : '')
    if (extra && !seen.has(extra)) {
      seen.add(extra)
      out.push(extra)
    }
    n += 1
    if (n > 6) break
  }
  return out.slice(0, 5)
}

// Stable per-user phase so everyone's rotation isn't in lockstep (which would
// make unrelated people share the same alias at the same time more often).
export function aliasPhase(id) {
  let h = 0
  const s = String(id || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export function aliasBucket(now = Date.now()) {
  return Math.floor(now / ALIAS_PERIOD_MS)
}

// The alias to show for `profile` in the given 30-minute bucket.
export function currentAlias(profile, bucket = aliasBucket()) {
  const base = (profile?.display_name || '').trim() || profile?.username || '?'
  const list = aliasesFor(base)
  const idx = (bucket + aliasPhase(profile?.id)) % list.length
  return list[idx]
}

// Whether a profile answers to a typed search. The chat list used to match the
// CURRENT ALIAS only, so searching a friend by the name or handle you actually
// know them by ("sneha") found nothing whenever their alias happened to be "S5"
// — and which one that is changes every thirty minutes, so the same search
// worked or failed depending on the time of day. Match the stable identifiers
// (username, display name) as well as whatever alias is showing.
export function matchesSearch(profile, query, alias) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  const haystacks = [alias, profile?.username, profile?.display_name]
  return haystacks.some((h) => h && String(h).toLowerCase().includes(q))
}
