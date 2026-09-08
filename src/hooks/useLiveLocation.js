import { useEffect, useRef } from 'react'
import { fixDecision } from '../lib/geo'

// A friend map is measured in kilometres. High accuracy means GPS, which means
// the radio stays hot; `maximumAge` lets the platform hand back a fix it already
// has instead of acquiring a new one. Both are battery decisions, and neither
// costs anything the map can see.
export const WATCH_OPTIONS = { enableHighAccuracy: false, maximumAge: 60_000, timeout: 30_000 }

const PERMISSION_DENIED = 1

/**
 * May we watch the device's position WITHOUT putting a permission prompt in
 * front of someone who did not just tap something?
 *
 * 'granted' — yes, the grant already exists.
 * 'prompt'  — no. Asking here would be a prompt nobody asked for, which is the
 *             exact complaint the camera work went to some trouble to kill.
 * 'denied'  — no, and calling anyway only re-shows the blocked-permission bubble.
 * No Permissions API (Safari has no geolocation descriptor) — we cannot tell, so
 * we go ahead: the user turned sharing on themselves, this is at most ONE prompt
 * on opening the map, and a denial stops the watch for good rather than retrying.
 */
export async function watchAllowed() {
  const state = await locationPermission()
  // Only these two. 'denied' must NOT pass — calling anyway just re-shows the
  // blocked bubble — and 'prompt-blocked' must not either, or we prompt someone
  // who never tapped anything.
  return state === 'granted' || state === 'unknown'
}

/**
 * 'granted'        — the grant exists and PERSISTS. This is the closest thing
 *                    the web has to "permanent access": once given, the browser
 *                    stops asking. It is NOT background access — no browser
 *                    grants a web page location while it is closed.
 * 'prompt-blocked' — never asked. We must not ask here; it has to come from a
 *                    tap, which is what the "Turn on live updates" button is for.
 * 'denied'         — refused. Asking again only re-shows the blocked bubble, so
 *                    the UI has to send them to browser settings instead.
 * 'unknown'        — Safari has no geolocation descriptor, so we cannot tell.
 *                    Treated as allowed: the user turned sharing on themselves,
 *                    it is at most ONE prompt, and a denial stops the watch for
 *                    good rather than retrying at a bubble they dismissed.
 */
export async function locationPermission() {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' })
    if (status) {
      if (status.state === 'granted') return 'granted'
      return status.state === 'denied' ? 'denied' : 'prompt-blocked'
    }
  } catch {
    // Permissions API present but without the geolocation descriptor.
  }
  return 'unknown'
}

/**
 * Ask for the grant, from a user gesture only. Resolves true once it exists —
 * and once it does the browser remembers it, so this is asked once and never
 * again.
 */
export function requestLocationAccess() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false)
    navigator.geolocation.getCurrentPosition(() => resolve(true), () => resolve(false), {
      enableHighAccuracy: false,
      maximumAge: 60000,
      timeout: 15000,
    })
  })
}

/**
 * Keep the signed-in user's own position fresh **while, and only while, they are
 * sharing it**.
 *
 * The watch is started when `active` becomes true and cleared when it becomes
 * false, when the tab is hidden, and on unmount. There is deliberately no path
 * that acquires a position when sharing is off — Ghost Mode means the app does
 * not ask the device where it is, not merely that it keeps the answer quiet.
 *
 * @param active   true only while the `locations` row exists and sharing is on
 * @param seed     {{lat,lng,at}|null} the position already stored server-side,
 *                 so re-opening the map doesn't re-write an unchanged row
 * @param onFix    called with { lat, lng, accuracy } for fixes worth publishing
 * @param onBlocked called once if we may not watch under the existing grant
 * @param onError  called for geolocation errors (denial included)
 */
export default function useLiveLocation({ active, seed = null, onFix, onBlocked, onError, retryToken = 0, options = WATCH_OPTIONS }) {
  const lastRef = useRef(null)
  // Callbacks change identity every render (they close over map state). Holding
  // them in a ref is what keeps the watch itself depending on `active` alone —
  // restarting a geolocation watch per render would be both a battery bug and,
  // on some platforms, a fresh prompt.
  const handlers = useRef({ onFix, onBlocked, onError })
  useEffect(() => {
    handlers.current = { onFix, onBlocked, onError }
  }, [onFix, onBlocked, onError])

  // Adopt the stored row as "what we last wrote", so opening the map on an
  // unmoved phone costs no write at all.
  useEffect(() => {
    if (!seed) return
    const at = Number.isFinite(seed.at) ? seed.at : 0
    const prev = lastRef.current
    if (!prev || at > prev.at) lastRef.current = { lat: seed.lat, lng: seed.lng, at }
  }, [seed])

  useEffect(() => {
    if (!active) {
      // Ghost Mode deletes the row, so the next share must publish immediately
      // rather than being throttled against a position that no longer exists.
      lastRef.current = null
      return
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) return

    let id = null
    let cancelled = false
    let allowed = false

    const stop = () => {
      if (id !== null) {
        navigator.geolocation.clearWatch(id)
        id = null
      }
    }
    const onPosition = (pos) => {
      const c = pos?.coords
      if (!c) return
      const next = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy }
      if (!fixDecision(lastRef.current, next, Date.now()).publish) return
      lastRef.current = { lat: next.lat, lng: next.lng, at: Date.now() }
      handlers.current.onFix?.(next)
    }
    const onFailure = (err) => {
      // A denial mid-session must not turn into a retry loop against a bubble
      // the user has already dismissed. Timeouts are normal and are ignored.
      if (err?.code === PERMISSION_DENIED) {
        allowed = false
        stop()
        handlers.current.onBlocked?.()
      }
      handlers.current.onError?.(err)
    }
    const start = () => {
      if (cancelled || !allowed || id !== null) return
      id = navigator.geolocation.watchPosition(onPosition, onFailure, options)
    }
    // No location work at all while the app is in the background.
    const onVisibility = () => (document.hidden ? stop() : start())
    document.addEventListener('visibilitychange', onVisibility)

    watchAllowed().then((ok) => {
      if (cancelled) return
      allowed = ok
      if (!ok) {
        handlers.current.onBlocked?.()
        return
      }
      if (!document.hidden) start()
    })

    return () => {
      cancelled = true
      allowed = false
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [active, options, retryToken])
}
