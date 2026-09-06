import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getMyLocation, getProfile, getVisibleLocations, setMyLocation, stopSharingLocation } from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { isSecureContext } from '../hooks/useCamera'
import { useToast } from '../hooks/useToast'
import { BackIcon } from '../components/Icons'

// Great-circle distance in km. Both coordinates are already on the map, so the
// nicest thing to say about them costs nothing extra.
function distanceKm(a, b) {
  const R = 6371
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

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
  const lastFix = useRef(null) // { lat, lng, at } — lets a Ghost→Share toggle reuse a recent fix
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(0)
  const [nearest, setNearest] = useState(null) // { name, km } — closest sharing friend

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

  useEffect(() => {
    getMyLocation(me).then((loc) => setSharingState(!!loc?.sharing)).catch(() => setSharingState(false))
    load().catch(() => {})
  }, [me, load])

  const goGhost = async () => {
    // Only claim success once the delete actually lands — otherwise coords could
    // linger server-side while the UI says you're hidden. Remove the row outright
    // (not just flip the flag) so Ghost Mode leaves nothing to leak.
    try {
      await stopSharingLocation(me)
      setSharingState(false)
      toast('Ghost Mode on — your location was removed')
      load().catch(() => {})
    } catch (err) {
      toast(err.message)
    }
  }

  const publish = async (lat, lng) => {
    try {
      await setMyLocation(me, lat, lng, true)
      lastFix.current = { lat, lng, at: Date.now() }
      setSharingState(true)
      toast('Sharing your location with friends')
      load().catch(() => {})
    } catch (err) {
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
              <div className="map-chips">
                <span className="chip">Sharing</span>
                <span className="chip">
                  {Math.max(0, count - 1)} friend{count - 1 === 1 ? '' : 's'} on the map
                </span>
              </div>
            ) : (
              <>👻 Ghost Mode — nobody can see you. Share to appear on your friends’ maps.</>
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
