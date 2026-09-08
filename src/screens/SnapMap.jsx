import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getMyLocation, getProfile, getVisibleLocations, setMyLocation, stopSharingLocation } from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { isSecureContext } from '../hooks/useCamera'
import { useToast } from '../hooks/useToast'
import useLiveLocation from '../hooks/useLiveLocation'
// Great-circle distance in km. Both coordinates are already on the map, so the
// nicest thing to say about them costs nothing extra. It lives in lib/geo with
// the publish throttle, which measures in the same units.
import { distanceKm } from '../lib/geo'
import { BackIcon } from '../components/Icons'
import { sharingUntilLabel, timeAgo } from '../lib/timeAgo'

const prettyDistance = (km) =>
  km < 1 ? `${Math.round(km * 1000)} m` : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`

function avatarHtml(p) {
  const emoji = p?.avatar_emoji
  const bg = emoji ? '#ffffff' : `hsl(${p?.avatar_hue ?? 45} 70% 55%)`
  const content = emoji || (p?.display_name || p?.username || '?').charAt(0).toUpperCase()
  const el = document.createElement('div')
  el.className = 'map-avatar'
  el.style.background = bg
  el.textContent = content
  return el
}

// A friend map is measured in kilometres — a fix from the last few minutes is
// as good as a fresh one, and costs no new GPS acquisition (or prompt).
const FIX_TTL_MS = 5 * 60 * 1000

export default function SnapMap({ onBack }) {
  const { profile } = useAuth()
  const me = profile.id
  const alias = useAlias()
  const toast = useToast()

  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({})
  const profileCache = useRef({}) // user_id -> profile, so a reload isn't N+1 again
  const didFitRef = useRef(false) // the map is framed once, never re-framed under the user
  // null = not known yet. Defaulting to false rendered the Ghost panel and its
  // Share button while getMyLocation was still in flight, so a tap during that
  // window re-prompted someone who was already sharing.
  const [sharing, setSharingState] = useState(null)
  // The whole row, not just the flag: "since when" and "until when" are the
  // two questions a location-sharing switch has to be able to answer.
  const [myLoc, setMyLoc] = useState(null)
  // "4 min ago" goes stale while the screen is open, so it is recomputed on a
  // slow tick rather than only when something else happens to re-render.
  const [now, setNow] = useState(() => Date.now())
  const lastFix = useRef(null) // { lat, lng, at } — lets a Ghost→Share toggle reuse a recent fix
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(0)
  const [nearest, setNearest] = useState(null) // { name, km } — closest sharing friend
  // True only while we intend the row to exist. Checked on BOTH sides of every
  // write, so a fix that was already in flight when the user tapped Go Ghost can
  // never resurrect the row they just deleted.
  const publishOk = useRef(false)
  const [liveBlocked, setLiveBlocked] = useState(false)

  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: false, attributionControl: false }).setView([20, 0], 2)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  const load = useCallback(async () => {
    const map = mapRef.current
    if (!map) return
    const locs = await getVisibleLocations().catch(() => [])
    if (mapRef.current !== map) return // unmounted/re-inited during the await
    Object.values(markersRef.current).forEach((m) => m.remove())
    markersRef.current = {}
    const pts = []
    for (const loc of locs) {
      let prof = loc.user_id === me ? profile : profileCache.current[loc.user_id]
      if (!prof) {
        prof = await getProfile(loc.user_id).catch(() => null)
        if (mapRef.current !== map) return // bailed mid-loop
        if (prof) profileCache.current[loc.user_id] = prof
      }
      const marker = L.marker([loc.lat, loc.lng], {
        icon: L.divIcon({ className: 'map-pin', html: avatarHtml(prof), iconSize: [42, 42], iconAnchor: [21, 21] }),
      }).addTo(map)
      const label = document.createElement('span')
      label.textContent = loc.user_id === me ? 'You' : (prof ? alias(prof) : 'Friend')
      marker.bindPopup(label)
      markersRef.current[loc.user_id] = marker
      pts.push([loc.lat, loc.lng])
    }
    setCount(locs.length)

    // Distance is only meaningful when we're on the map too.
    const mine = locs.find((l) => l.user_id === me)
    const others = locs.filter((l) => l.user_id !== me)
    if (mine && others.length) {
      const closest = others
        .map((l) => ({ loc: l, km: distanceKm(mine, l) }))
        .sort((x, y) => x.km - y.km)[0]
      const prof = profileCache.current[closest.loc.user_id]
      setNearest({ name: prof ? alias(prof) : 'them', km: closest.km })
    } else {
      setNearest(null)
    }
    // Frame the map ONCE. Re-framing on every load would fight the user: any
    // reload (sharing toggled, the alias clock ticking over) would snap the view
    // back to fit-all and throw away wherever they had panned/zoomed to.
    if (didFitRef.current || pts.length === 0) return
    didFitRef.current = true
    if (pts.length === 1) map.setView(pts[0], 14)
    else map.fitBounds(pts, { maxZoom: 14, padding: [50, 50] })
  }, [me, profile, alias])

  const refreshMine = useCallback(
    () =>
      getMyLocation(me)
        .then((loc) => {
          setMyLoc(loc)
          setSharingState(!!loc?.sharing)
        })
        .catch(() => {
          setMyLoc(null)
          setSharingState(false)
        }),
    [me]
  )

  useEffect(() => {
    refreshMine()
    load().catch(() => {})
  }, [refreshMine, load])

  useEffect(() => {
    if (!sharing) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [sharing])

  // Friends move too, and their pins used to be fetched exactly once per visit.
  // The table is a handful of tiny rows and profiles are cached, so a slow
  // refetch is cheap — and it runs only while you are sharing and looking at it.
  useEffect(() => {
    if (!sharing) return
    const t = setInterval(() => {
      if (!document.hidden) load().catch(() => {})
    }, 120_000)
    return () => clearInterval(t)
  }, [sharing, load])

  // Keep the write guard in step with the stored state. goGhost also clears it
  // synchronously, before its own await — that is the half that matters.
  useEffect(() => {
    publishOk.current = sharing === true
  }, [sharing])

  // A fresh fix from the live watch. Same write the Share button makes, minus
  // the toast: an automatic refresh shouldn't announce itself every minute.
  const publishFix = useCallback(
    async ({ lat, lng }) => {
      if (!publishOk.current) return
      try {
        await setMyLocation(me, lat, lng, true)
      } catch {
        return // transient — the watch will hand us another fix soon enough
      }
      if (!publishOk.current) {
        // Go Ghost landed while this write was in flight. Undo it, or the row
        // the user asked to have deleted quietly comes back.
        stopSharingLocation(me).catch(() => {})
        return
      }
      lastFix.current = { lat, lng, at: Date.now() }
      setMyLoc((prev) => ({
        ...prev,
        user_id: me,
        lat,
        lng,
        sharing: true,
        updated_at: new Date().toISOString(),
      }))
      setNow(Date.now())
      load().catch(() => {})
    },
    [me, load]
  )

  // What is already stored counts as "the last thing we wrote", so re-opening
  // the map on a phone that hasn't moved costs no write at all.
  const seed = useMemo(() => {
    if (!myLoc?.sharing || !Number.isFinite(myLoc.lat) || !Number.isFinite(myLoc.lng)) return null
    return { lat: myLoc.lat, lng: myLoc.lng, at: Date.parse(myLoc.updated_at) || 0 }
  }, [myLoc])

  const onBlocked = useCallback(() => setLiveBlocked(true), [])

  // The fix for the reported bug: while — and only while — sharing is on, the
  // position refreshes itself. Ghost Mode is still the default and still deletes
  // the row, and nothing here asks the device for a position when sharing is off.
  useLiveLocation({ active: sharing === true, seed, onFix: publishFix, onBlocked })

  const goGhost = async () => {
    publishOk.current = false
    // Only claim success once the delete actually lands — otherwise coords could
    // linger server-side while the UI says you're hidden. Remove the row outright
    // (not just flip the flag) so Ghost Mode leaves nothing to leak.
    try {
      await stopSharingLocation(me)
      setSharingState(false)
      setMyLoc(null)
      toast('Ghost Mode on — your location was removed')
      load().catch(() => {})
    } catch (err) {
      // The row is still there, so the guard has to go back to matching reality.
      publishOk.current = sharing === true
      toast(err.message)
    }
  }

  const publish = async (lat, lng) => {
    publishOk.current = true
    try {
      await setMyLocation(me, lat, lng, true)
      lastFix.current = { lat, lng, at: Date.now() }
      setLiveBlocked(false)
      setSharingState(true)
      // Show the readout straight away, then reconcile with the stored row —
      // any expiry is decided server-side (column default), not here.
      setMyLoc((prev) => ({ ...prev, user_id: me, lat, lng, sharing: true, updated_at: new Date().toISOString() }))
      setNow(Date.now())
      toast('Sharing your location with friends')
      refreshMine()
      load().catch(() => {})
    } catch (err) {
      publishOk.current = sharing === true
      toast(err.message)
    } finally {
      setBusy(false)
    }
  }

  const startSharing = async () => {
    // Geolocation exists on insecure origins too — the object is there, the
    // call just fails. Say why rather than letting the browser prompt-loop.
    if (!isSecureContext) {
      toast('Location needs HTTPS. Open this page over https://')
      return
    }
    if (!navigator.geolocation) {
      toast('Location isn’t available on this device')
      return
    }
    setBusy(true)

    // Ghost Mode deletes the server row by design, so a Ghost→Share toggle used
    // to mean a whole new GPS acquisition — and another prompt — every time.
    // Reuse a fix from the last few minutes instead.
    const fix = lastFix.current
    if (fix && Date.now() - fix.at < FIX_TTL_MS) {
      await publish(fix.lat, fix.lng)
      return
    }

    // If the grant was already refused, calling again just re-shows the browser's
    // blocked-permission bubble. Tell the user where to fix it instead.
    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' })
      if (status?.state === 'denied') {
        toast('Location is blocked — allow it in your browser’s site settings')
        setBusy(false)
        return
      }
    } catch {
      // Permissions API is optional (Safari lacks the geolocation descriptor);
      // fall through and just ask.
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => publish(pos.coords.latitude, pos.coords.longitude),
      (err) => {
        toast(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied'
            : err.code === err.TIMEOUT
              ? 'Couldn’t get a location fix — try again'
              : 'Location is unavailable right now'
        )
        setBusy(false)
      },
      // maximumAge defaults to 0, which forces a brand-new high-accuracy GPS
      // acquisition on every tap — the most prompt-visible thing you can ask
      // for. A recent cached fix is plenty for a friend map measured in km.
      { enableHighAccuracy: false, timeout: 12000, maximumAge: FIX_TTL_MS }
    )
  }

  const updatedAgo = sharing ? timeAgo(myLoc?.updated_at, now) : null

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="header">
        <button className="circle dark" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Map</h1>
      </div>

      <div className="map-wrap">
        <div ref={mapEl} className="map-canvas" />

        <div className="map-panel">
          {/* How far apart you are is the reason this screen exists, so on the
              days it can be answered it gets the vibrant card and the big light
              number rather than being a clause in a sentence. */}
          {sharing && nearest && (
            <div className="map-near">
              <div className="stat-num">{prettyDistance(nearest.km)}</div>
              <div className="stat-label">between you and {nearest.name}</div>
            </div>
          )}
          <div className="map-panel-txt">
            {sharing === null ? (
              <>Checking your map settings…</>
            ) : sharing ? (
              <>
                <div className="map-chips">
                  <span className="chip map-chip-live">Sharing</span>
                  <span className="chip">
                    {Math.max(0, count - 1)} friend{count - 1 === 1 ? '' : 's'} on the map
                  </span>
                </div>
                {/* Sharing a location without saying for how long is the dark
                    pattern this screen exists to avoid, so the deadline gets a
                    line of its own. `locations.expires_at` arrives with a
                    separate change; until it does — and whenever it is null —
                    this states the truth rather than inventing an end time. */}
                <div className="map-until">{sharingUntilLabel(myLoc?.expires_at, now)}</div>
                {updatedAgo && <div className="map-updated">Your location updated {updatedAgo}</div>}
                {/* We will not raise a permission prompt nobody asked for, so
                    when the grant isn't already there the honest thing is to say
                    the dot is frozen rather than to let it quietly go stale. */}
                {liveBlocked && (
                  <div className="map-updated">
                    Live updates need location permission — Go Ghost, then Share again.
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="map-ghost-title">👻 Ghost Mode is on</div>
                <div className="map-ghost-sub">
                  Nobody can see you, and nothing of yours is stored. Share to appear on your
                  friends’ maps.
                </div>
              </>
            )}
          </div>
          {sharing === null ? (
            <button className="btn-dark" disabled>Checking…</button>
          ) : sharing ? (
            <button className="btn-dark" onClick={goGhost}>Go Ghost</button>
          ) : (
            <button className="btn-dark" onClick={startSharing} disabled={busy}>
              {busy ? 'Locating…' : 'Share my location'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
