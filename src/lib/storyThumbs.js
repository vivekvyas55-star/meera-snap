// Story row previews, paid for exactly once.
//
// `stories` has no `thumb_path` column — the only object in storage is the
// full-size original (postStory downscales to 1440px, but that is still a
// couple of hundred KB). Pointing a 46px row tile at that object is precisely
// the mistake `memories_thumbs.sql` was written to undo: every visit to the
// Stories pane would re-download every friend's story in full, and egress is
// the scarcest resource in this app (5 GB/month, and media is the whole bill).
// Supabase's server-side image transforms would solve it properly, but they
// are Pro-only.
//
// So a thumbnail here is only ever derived from bytes that have ALREADY been
// downloaded. When the story viewer finishes decoding an image — the moment
// the egress has been spent anyway — it hands the <img> element to
// rememberStoryThumb(), which shrinks it to a ~96px square on a canvas and
// keeps the data URL in localStorage. Rendering that costs zero network for
// the rest of the story's 48h life.
//
// The deliberate consequence: a story you have never opened has no cached
// frame, and shows a tile rather than a preview. Giving UNSEEN stories a real
// preview cannot be done from the client — it needs a small object uploaded
// alongside the original, i.e. a `stories.thumb_path` migration.
//
// Everything here is best-effort. localStorage throws in private mode and on
// quota, canvas is absent under jsdom, and a cross-origin image taints the
// canvas — every one of those paths just means "no preview", never an error.

const KEY = 'meera:story-thumbs-v1'
const SIZE = 96 // 2x a 46px row tile
const QUALITY = 0.5
const MAX_ENTRIES = 60 // ~3 KB each; a hard ceiling so we never fill the quota

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    cache = {}
  }
  return cache
}

function persist(map) {
  cache = map
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // Quota or private mode. The in-memory cache still serves this session.
  }
}

// Keep the newest MAX_ENTRIES. Stories expire after 48h, so the store is
// naturally small; this is the backstop, not the mechanism.
function trim(map) {
  const ids = Object.keys(map)
  if (ids.length <= MAX_ENTRIES) return map
  ids
    .sort((a, b) => (map[a].t ?? 0) - (map[b].t ?? 0))
    .slice(0, ids.length - MAX_ENTRIES)
    .forEach((id) => delete map[id])
  return map
}

/** The cached preview for one story, or null if it has never been opened. */
export function getStoryThumb(storyId) {
  if (!storyId) return null
  return load()[storyId]?.d ?? null
}

/** The newest story in a group that has a cached preview, or null. */
export function groupThumb(items = []) {
  for (let i = items.length - 1; i >= 0; i--) {
    const d = getStoryThumb(items[i]?.id)
    if (d) return d
  }
  return null
}

/**
 * Derive and store a preview from an image the viewer has already loaded.
 * Returns the data URL, or null when no preview could be made (no canvas,
 * a tainted canvas, an image with no intrinsic size).
 */
export function rememberStoryThumb(storyId, img) {
  if (!storyId || !img) return null
  const map = load()
  if (map[storyId]) return map[storyId].d

  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (!w || !h) return null

  let data
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // Cover-crop to a square, matching how the tile renders it.
    const scale = SIZE / Math.min(w, h)
    const dw = Math.round(w * scale)
    const dh = Math.round(h * scale)
    ctx.drawImage(img, Math.round((SIZE - dw) / 2), Math.round((SIZE - dh) / 2), dw, dh)
    data = canvas.toDataURL('image/jpeg', QUALITY)
  } catch {
    // SecurityError: the image was loaded without CORS, so the canvas is
    // tainted. No preview, and nothing else changes.
    return null
  }
  if (typeof data !== 'string' || !data.startsWith('data:image')) return null

  map[storyId] = { d: data, t: Date.now() }
  persist(trim(map))
  return data
}

/**
 * Drop previews for stories that no longer exist (expired, or deleted by their
 * author). Called with the ids the Stories screen can currently see, so the
 * store never outlives the content it describes.
 */
export function pruneStoryThumbs(liveIds) {
  const map = load()
  const live = new Set(liveIds ?? [])
  let changed = false
  for (const id of Object.keys(map)) {
    if (!live.has(id)) {
      delete map[id]
      changed = true
    }
  }
  if (changed) persist(map)
}

/** Test seam — forget everything, in memory and on disk. */
export function clearStoryThumbs() {
  cache = {}
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing to do
  }
}
