// Synthesized call ring — no audio asset, generated with the Web Audio API so it
// works offline and can't be blocked by the CSP. Plays a classic US-style ring
// (440 + 480 Hz, ~2s on / 4s off) for both the incoming call (ringtone) and the
// caller's wait (ringback). Best-effort: mobile browsers keep audio silent until
// the user has interacted with the page once — primeRing() unlocks it on the
// first tap, and the vibration + visual ring cover the case where it's still
// muted (and iOS, which has no vibration API).

let ctx = null
let timer = null
let stopped = true

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

function ringOnce() {
  const c = ensureCtx()
  if (!c) return
  const now = c.currentTime
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.05)
  gain.gain.setValueAtTime(0.18, now + 1.9)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.0)
  gain.connect(c.destination)
  for (const f of [440, 480]) {
    const osc = c.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = f
    osc.connect(gain)
    osc.start(now)
    osc.stop(now + 2.05)
  }
}

// Unlock audio on the first user gesture so an incoming ring can actually sound.
export function primeRing() {
  const unlock = () => {
    ensureCtx()
    window.removeEventListener('touchend', unlock)
    window.removeEventListener('click', unlock)
  }
  window.addEventListener('touchend', unlock, { once: true })
  window.addEventListener('click', unlock, { once: true })
}

export function startRing() {
  stopRing()
  stopped = false
  if (!ensureCtx()) return
  ringOnce()
  timer = setInterval(() => {
    if (!stopped) ringOnce()
  }, 6000) // 2s tone + 4s silence
}

export function stopRing() {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // Release the audio session so it can't block the WebRTC call audio — a
  // running AudioContext can mute the remote voice on iOS.
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {})
}
