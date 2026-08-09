// Client-side image downscaling. Everything a user uploads is downloaded again
// by whoever views it — often repeatedly — so shipping a 4 MB phone photo when
// a 400 KB one looks identical on a phone screen costs both storage and egress
// on every single view. Downscale before upload, never after.
//
// Best-effort by design: if decoding or encoding fails on some browser, the
// caller gets the ORIGINAL blob back and the upload still succeeds. A failed
// optimisation must never become a failed send.

async function decode(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob)
  // Safari fallback: decode through an <img> + object URL.
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

const dims = (img) => ({
  w: img.width || img.naturalWidth,
  h: img.height || img.naturalHeight,
})

// Fit inside maxDim on the long edge, re-encode as JPEG. Returns the original
// blob when it's already small enough, when the result would be no smaller, or
// on any failure.
export async function downscaleImage(blob, maxDim = 1600, quality = 0.8) {
  if (!blob || !(blob.type || '').startsWith('image')) return blob
  let img
  try {
    img = await decode(blob)
    const { w, h } = dims(img)
    if (!w || !h) return blob
    const scale = Math.min(1, maxDim / Math.max(w, h))
    if (scale === 1 && blob.size < 600 * 1024) return blob // already lean
    const c = document.createElement('canvas')
    c.width = Math.round(w * scale)
    c.height = Math.round(h * scale)
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality))
    // Re-encoding can inflate an already-optimised file; keep the smaller one.
    return out && out.size < blob.size ? out : blob
  } catch {
    return blob
  } finally {
    img?.close?.()
  }
}

// A small square-ish thumbnail for grid views, so opening Memories doesn't pull
// every full-size original. Falls back to the original blob, which the caller
// must treat as "no separate thumbnail" rather than uploading it twice.
export async function makeThumbnail(blob, maxDim = 400, quality = 0.6) {
  const thumb = await downscaleImage(blob, maxDim, quality)
  return thumb === blob ? null : thumb
}
