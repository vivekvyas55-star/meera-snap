import { expect, test } from 'vitest'
import fs from 'node:fs'

// A sent video played only on desktop. On a phone it sat on "Loading…" forever.
//
// The chain: a <video> with audio is refused autoplay by mobile browsers, so
// `onPlaying` never fires and `ready` stays false; the "Loading…" overlay is
// `position:absolute; inset:0`, covers the whole viewer and is painted AFTER
// the video; and the gesture that would start playback is a tap on the <video>
// underneath it. The overlay swallowed every tap, so the escape hatch the code
// already had could never be reached.
//
// Asserted against the source rather than a mount: jsdom implements no media
// pipeline at all — `play()` is not even defined — so a rendering test here
// would be asserting against stubs and would have passed with the bug in place.

const css = fs.readFileSync('src/index.css', 'utf8')
const viewer = fs.readFileSync('src/components/SnapViewer.jsx', 'utf8')

test('the loading overlay cannot take a tap meant for the video', () => {
  const block = css.slice(css.indexOf('.viewer-loading {'))
  const rule = block.slice(0, block.indexOf('}'))
  expect(rule).toMatch(/pointer-events:\s*none/)
  // It really does cover everything, which is why the line above is load-bearing.
  expect(rule).toMatch(/inset:\s*0/)
})

test('the video keeps a tap-to-play handler', () => {
  expect(viewer).toMatch(/onClick=\{\(e\) => e\.currentTarget\.play\(\)/)
  expect(viewer).toMatch(/playsInline/)
})

test('a video waiting for a gesture does not claim to be loading', () => {
  // "Loading…" at somebody whose video is ready and waiting is this codebase's
  // oldest bug class: a state reported as something it is not.
  expect(viewer).toMatch(/onCanPlay=\{\(\) => setCanPlay\(true\)\}/)
  expect(viewer).toMatch(/isVideo && canPlay \? 'Tap to play' : 'Loading…'/)
})

test('playback, not download, is what counts the open', () => {
  // countOpen burns one of the recipient's views, so it must fire on onPlaying
  // and never on onCanPlay — otherwise a video that never played would still
  // be consumed.
  expect(viewer).toMatch(/onPlaying=\{countOpen\}/)
  expect(viewer).not.toMatch(/onCanPlay=\{countOpen\}/)
})
