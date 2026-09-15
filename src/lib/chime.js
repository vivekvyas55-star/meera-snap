// Three bells, synthesized. No audio asset — the same reason ringtone.js has
// none: a downloaded file is egress, egress is the scarcest resource here, and
// a two-minute puzzle is not worth a byte of it. Generated tones also work
// offline and cannot be blocked by the CSP.
//
// Best-effort in every direction, and the puzzle it serves is built so that
// none of these failures matter: mobile browsers keep audio silent until the
// page has been touched once (primeChime unlocks it on the first tap), jsdom
// has no AudioContext at all, and a user may simply have the phone on silent.
// The escape room's second lock therefore FLASHES each bell as it plays —
// sound is a second channel, never the only one — so the whole game is
// solvable muted. Nothing here ever throws into the caller.

const FREQS = [392.0, 523.25, 659.25] // G4, C5, E5 — a chord, so any order sounds

let ctx = null

function ensureCtx() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    return ctx
  } catch {
    return null
  }
}

/** Unlock audio from a user gesture. Call it from the tap that starts a run. */
export function primeChime() {
  ensureCtx()
}

/**
 * Strike one bell. `i` indexes FREQS; anything else is ignored.
 * Returns true if a sound was actually started, so a caller can tell the
 * player that audio is unavailable rather than leaving them waiting for it.
 */
export function strike(i, when = 0) {
  const c = ensureCtx()
  if (!c) return false
  const f = FREQS[i]
  if (!f) return false
  try {
    const t = c.currentTime + Math.max(0, when)
    const gain = c.createGain()
    // A struck bell: instant attack, long exponential tail. A plain
    // setValueAtTime(0) at the end clicks; the ramp does not.
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.75)
    gain.connect(c.destination)

    const osc = c.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = f
    osc.connect(gain)
    osc.start(t)
    osc.stop(t + 0.8)

    // A quiet octave above, which is most of what makes it read as a bell
    // rather than a beep.
    const harm = c.createOscillator()
    const hg = c.createGain()
    hg.gain.setValueAtTime(0.0001, t)
    hg.gain.exponentialRampToValueAtTime(0.06, t + 0.01)
    hg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
    harm.type = 'sine'
    harm.frequency.value = f * 2
    harm.connect(hg)
    hg.connect(c.destination)
    harm.start(t)
    harm.stop(t + 0.45)
    return true
  } catch {
    return false
  }
}

/** True when the door opens: a short rising figure, not a fanfare. */
export function openChime() {
  strike(0, 0)
  strike(1, 0.13)
  strike(2, 0.26)
}

/** Release the audio session; a running context can mute call audio on iOS. */
export function releaseChime() {
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {})
}
