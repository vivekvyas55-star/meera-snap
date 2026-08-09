import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getMyLocation, getProfile, getVisibleLocations, setMyLocation, stopSharingLocation } from '../lib/db'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { useToast } from '../components/Toast'
import { BackIcon } from '../components/Icons'

function avatarHtml(p) {
  const emoji = p?.avatar_emoji
  const bg = emoji ? '#ffffff' : `hsl(${p?.avatar_hue ?? 45} 70% 55%)`
  const content = emoji || (p?.display_name || p?.username || '?').charAt(0).toUpperCase()
  return `<div class="map-avatar" style="background:${bg}">${content}</div>`
}

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
  const [sharing, setSharingState] = useState(false)
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(0)

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
      marker.bindPopup(loc.user_id === me ? 'You' : (prof ? alias(prof) : 'Friend'))
      markersRef.current[loc.user_id] = marker
      pts.push([loc.lat, loc.lng])
    }
    setCount(locs.length)
    // Frame the map ONCE. Re-framing on every load would fight the user: any
    // reload (sharing toggled, the alias clock ticking over) would snap the view
    // back to fit-all and throw away wherever they had panned/zoomed to.
    if (didFitRef.current || pts.length === 0) return
    didFitRef.current = true
    if (pts.length === 1) map.setView(pts[0], 14)
    else map.fitBounds(pts, { maxZoom: 14, padding: [50, 50] })
  }, [me, profile, alias])

  useEffect(() => {
    getMyLocation(me).then((loc) => setSharingState(!!loc?.sharing)).catch(() => {})
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

  const startSharing = () => {
    if (!navigator.geolocation) {
      toast('Location isn’t available on this device')
      return
    }
    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await setMyLocation(me, pos.coords.latitude, pos.coords.longitude, true)
          setSharingState(true)
          toast('Sharing your location with friends')
          load().catch(() => {})
        } catch (err) {
          toast(err.message)
        } finally {
          setBusy(false)
        }
      },
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
      { enableHighAccuracy: true, timeout: 12000 }
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
          <div className="map-panel-txt">
            {sharing ? (
              <>You’re sharing your location · {Math.max(0, count - 1)} friend{count - 1 === 1 ? '' : 's'} on the map</>
            ) : (
              <>👻 Ghost Mode — nobody can see you. Share to appear on your friends’ maps.</>
            )}
          </div>
          {sharing ? (
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
