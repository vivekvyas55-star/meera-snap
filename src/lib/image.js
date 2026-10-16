// Client-side image downscaling. Everything a user uploads is downloaded again
// by whoever views it — often repeatedly — so shipping a 4 MB phone photo when
// a 400 KB one looks identical on a phone screen costs both storage and egress
// on every single view. Downscale before upload, never after.
//
// Always re-encode uploaded images to remove source metadata (including EXIF
// GPS). Fail closed if decoding/encoding fails instead of uploading originals.
import { record } from './telemetry'

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

// Fit inside maxDim on the long edge, re-encode as JPEG. Returns a
// metadata-free JPEG, even when re-encoding makes a small image larger.
export async function downscaleImage(blob, maxDim = 1600, quality = 0.8) {
  if (!blob || !(blob.type || '').startsWith('image')) return blob
  let img
  try {
    img = await decode(blob)
    const { w, h } = dims(img)
    if (!w || !h) throw new Error('Invalid image dimensions')
    const scale = Math.min(1, maxDim / Math.max(w, h))
    const c = document.createElement('canvas')
    c.width = Math.round(w * scale)
    c.height = Math.round(h * scale)
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality))
    // Never return the original: its metadata may contain precise location.
    if (!out) throw new Error('Image encoding failed')
    return out
  } catch {
    // Do not log the image or decoder details; they can identify private media.
    record('upload_fail', 'downscale_failed')
    throw new Error('Could not prepare this photo safely. Try another photo or take a new one.')
  } finally {
    img?.close?.()
  }
}

// A small square-ish thumbnail for grid views, so opening Memories doesn't pull
// every full-size original. Encoding failures stop the upload safely.
export async function makeThumbnail(blob, maxDim = 400, quality = 0.6) {
  const thumb = await downscaleImage(blob, maxDim, quality)
  return thumb === blob ? null : thumb
}
