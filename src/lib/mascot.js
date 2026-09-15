// ============================================================================
// THE BLOB — mascot geometry, with no DOM and no colour literals in it.
//
// The FORM comes from a reference (a soft squashed body, a two-leaf sprout, a
// face of a few black strokes, a halftone fill, a soft ellipse shadow, a
// pinned polaroid, and a scatter of hand-drawn marks). The COLOUR does not,
// and must not: Meera already has an identity and the mascot belongs to it.
// Every fill named here is one of the four existing vibrant tokens; the ink is
// `--ink`, pinned per tone by the fixed-light/fixed-dark contexts in
// index.css; the halftone is `currentColor` thinned, which is that same ink
// derived rather than a fifth colour. There is deliberately NO hex literal in
// this file or in styles/mascot.css, and tests/mascot.test.jsx greps both for
// one — "we just need one more hue" is a change that should fail the build.
//
// TWO THINGS FROM THE REFERENCE ARE DELIBERATELY LEFT BEHIND:
//
//  • Its heavy black display type. Meera's headings are oversized and
//    LIGHT-WEIGHT (300), which is written into the design language and used on
//    every screen. The mascot is an addition to that language, not a
//    replacement for it, so nothing here styles a heading and no weight or
//    font is introduced.
//  • Its engagement mechanics. The reference is a language app and its
//    illustration sits on streaks, XP and progress rings. Meera refuses those
//    — the screen-time panel turned down a usage streak as "the exact
//    Snapchat mechanic this app copies for messages and must not copy for
//    attention". So there is no progress ring here, no percentage, no "keep it
//    up", and no expression whose job is to look let down by the person
//    holding the phone. `sad` is a reaction to something in a GAME. It is
//    never a comment on somebody's habits, and pointing it at their absence is
//    the change to stop at.
//
// Everything here is a pure function of its arguments, in the same spirit as
// runner.js, gameState.js, geo.js and decoyMarket.js: a drawing is exactly the
// kind of thing that breaks silently, so the drawing is data and the data is
// tested. A new expression is one row in EXPRESSIONS — never a new component,
// never a new file, and never a new colour.
//
// NO IMAGE ASSETS. Not a PNG, not a JPG, not an SVG file, not a sprite sheet,
// not an icon font. Media is this app's entire hosting bill (5 GB/month, and a
// documented incident where 250 MB stored produced 1.11 GB of egress), and a
// mascot set shipped as pictures would be the largest static addition in its
// history. Every shape below is path data inside the JS bundle and costs one
// download that was already happening.
// ============================================================================

/* --------------------------------------------------------------------------
   Tones.

   The four vibrant fills, by name. `toneFill` returns a var() reference, never
   a value, so dark mode and the fixed-light contexts stay the only places a
   colour is decided. An unknown tone falls back rather than producing an
   invalid fill — an SVG with a bad `fill` paints black, which on a black face
   is an invisible blob rather than a visible mistake.
   -------------------------------------------------------------------------- */
export const TONES = ['lavender', 'lime', 'indigo', 'coral']
export const DEFAULT_TONE = 'lavender'

export function toneFill(tone) {
  const id = TONES.includes(tone) ? tone : DEFAULT_TONE
  return `var(--${id})`
}

/**
 * Indigo is the one tone dark enough to need white ink on it — the same rule
 * the rest of the sheet follows. Everything else keeps near-black strokes,
 * which is why a lavender blob needs the fixed-LIGHT context even at night:
 * the four fills do not move between schemes, so the ink on them cannot
 * either. (That is the `.fp-stat` lesson, applied before it can bite.)
 */
export function isDarkTone(tone) {
  return (TONES.includes(tone) ? tone : DEFAULT_TONE) === 'indigo'
}

/**
 * The saturated square behind a polaroid blob. It has to differ from the blob
 * or the blob disappears into it, and it has to be one of the same four —
 * there is no fifth hue to reach for. Deterministic, so a re-render never
 * reshuffles it.
 */
export function contrastGround(tone) {
  const id = TONES.includes(tone) ? tone : DEFAULT_TONE
  return { lavender: 'indigo', lime: 'indigo', indigo: 'lime', coral: 'lavender' }[id]
}

/* --------------------------------------------------------------------------
   The body.

   A circle squashed slightly wider than tall, drawn as four cubics rather than
   an <ellipse> so the silhouette can carry a little asymmetry and so the same
   `d` can be reused as the clip for the halftone. Rounded to 2dp: path strings
   are compared in tests and an 18-digit float is noise.
   -------------------------------------------------------------------------- */
const K = 0.5523 // circular arc → cubic control-point ratio

const r2 = (n) => Math.round(n * 100) / 100

function blobPath(cx, cy, rx, ry, wob = 0) {
  const ox = rx * K
  const oy = ry * K
  return [
    `M ${r2(cx)} ${r2(cy - ry)}`,
    `C ${r2(cx + ox + wob)} ${r2(cy - ry)} ${r2(cx + rx)} ${r2(cy - oy - wob)} ${r2(cx + rx)} ${r2(cy)}`,
    `C ${r2(cx + rx)} ${r2(cy + oy)} ${r2(cx + ox)} ${r2(cy + ry)} ${r2(cx)} ${r2(cy + ry)}`,
    `C ${r2(cx - ox)} ${r2(cy + ry)} ${r2(cx - rx)} ${r2(cy + oy)} ${r2(cx - rx)} ${r2(cy)}`,
    `C ${r2(cx - rx)} ${r2(cy - oy + wob)} ${r2(cx - ox - wob)} ${r2(cy - ry)} ${r2(cx)} ${r2(cy - ry)}`,
    'Z',
  ].join(' ')
}

/** The drawing space. Square, so `size` is one number at every call site. */
export const BLOB_VIEW = 120
export const POLAROID_VIEW = 148

export const BODY = { cx: 60, cy: 61, rx: 44, ry: 38.5 }
export const SHADOW = { cx: 60, cy: 106, rx: 37, ry: 6.5 }

/** The body outline. Also the clip for the halftone, so they cannot drift. */
export function bodyPath() {
  return blobPath(BODY.cx, BODY.cy, BODY.rx, BODY.ry, 1.5)
}

/**
 * The sprout: a short stem off the top-right shoulder and two leaves. Two, not
 * one — a single leaf reads as a stalk, and the pair is what makes the blob a
 * growing thing rather than a bean.
 */
export function sproutPaths() {
  return {
    stem: 'M 77.5 25.5 C 81.5 18 85 13.5 88.5 10.5',
    leaves: [
      'M 87 13 C 92.5 6.5 100.5 7 101.5 11.5 C 98.5 16.5 90.5 18 87 13 Z',
      'M 85.5 16.5 C 80.5 12.5 77 6 80 3.5 C 85 5 88.5 11.5 85.5 16.5 Z',
    ],
  }
}

/* --------------------------------------------------------------------------
   The halftone.

   An SVG <pattern> of two small circles on an 8-unit tile, clipped to the
   body. It is `currentColor` at low opacity — the body's own ink, thinned —
   so it darkens a light fill and lightens indigo without anybody naming a
   second colour. A bitmap texture here would be an image asset, which is the
   one thing this file exists to avoid.
   -------------------------------------------------------------------------- */
export const HALFTONE = {
  tile: 8,
  dots: [
    { cx: 2, cy: 2, r: 1.15 },
    { cx: 6, cy: 6, r: 1.15 },
  ],
  opacity: 0.16,
}

/* --------------------------------------------------------------------------
   Expressions.

   A table, keyed by mood. `strokes` are the stroked paths — two eyes and a
   mouth, plus the odd extra mark; `fills` are the few closed shapes (an open
   mouth, a teardrop). Adding an expression is adding one row here. Adding a
   COLOUR to one is not available, and that is the point: the face is where the
   range lives, so a fifth feeling costs a fifth expression rather than a fifth
   hue.

   `alt` is a real description rather than a mood id, because an instance that
   carries meaning gets a real label — and because colour alone must never be
   the thing saying which mood this is.
   -------------------------------------------------------------------------- */
const EYE = {
  leftArc: 'M 38 60 Q 44 50.5 50 60',
  rightArc: 'M 70 60 Q 76 50.5 82 60',
  leftLine: 'M 44 52.5 L 44 62',
  rightLine: 'M 76 52.5 L 76 62',
  leftClosed: 'M 38 55.5 Q 44 63.5 50 55.5',
  rightClosed: 'M 70 55.5 Q 76 63.5 82 55.5',
  leftSlash: 'M 38 53.5 L 50 59.5',
  rightSlash: 'M 82 53.5 L 70 59.5',
  leftShort: 'M 44 54 L 44 61',
  rightShort: 'M 76 54 L 76 61',
}

const MOUTH = {
  smile: 'M 50 75.5 Q 60 83.5 70 75.5',
  grin: 'M 47.5 74.5 Q 60 87 72.5 74.5',
  flat: 'M 51 78 L 69 78',
  downturn: 'M 53 80 Q 60 73.5 67 80',
}

// The "cross-pop" spark beside the head. It lives on the LEFT so it can never
// collide with the sprout, which owns the top-right corner.
const CROSS_POP = ['M 13.5 21.5 L 22 30.5', 'M 22.5 21.5 L 13 30.5']

// An open mouth and a teardrop are areas, not lines, so they are fills.
const OPEN_MOUTH = 'M 51.5 74 Q 60 72.5 68.5 74 Q 67 87 60 87 Q 53 87 51.5 74 Z'
const TEAR = 'M 76 65.5 C 79 70 80.5 73.5 78.5 75.5 C 76.5 77.5 73 75.5 73.5 72.5 C 74 70 75 67.5 76 65.5 Z'

export const EXPRESSIONS = {
  neutral: {
    label: 'Neutral',
    alt: 'a small round character with a calm face',
    strokes: [EYE.leftLine, EYE.rightLine, MOUTH.smile],
    fills: [],
  },
  happy: {
    label: 'Happy',
    alt: 'a small round character smiling, eyes curved up',
    strokes: [EYE.leftArc, EYE.rightArc, MOUTH.grin],
    fills: [],
  },
  wink: {
    label: 'Wink',
    alt: 'a small round character winking',
    strokes: [EYE.leftArc, EYE.rightLine, MOUTH.smile],
    fills: [],
  },
  annoyed: {
    label: 'Annoyed',
    alt: 'a small round character looking huffy',
    strokes: [EYE.leftSlash, EYE.rightSlash, MOUTH.flat, ...CROSS_POP],
    fills: [],
  },
  content: {
    label: 'Content',
    alt: 'a small round character with closed eyes and an open, contented mouth',
    strokes: [EYE.leftClosed, EYE.rightClosed],
    fills: [OPEN_MOUTH],
  },
  sad: {
    label: 'Uneasy',
    alt: 'a small round character looking uneasy, with one tear',
    strokes: [EYE.leftShort, EYE.rightShort, MOUTH.downturn],
    fills: [TEAR],
  },
}

export const MOODS = Object.keys(EXPRESSIONS)
export const DEFAULT_MOOD = 'neutral'

/**
 * The face for a mood. An unknown, missing or misspelt mood FALLS BACK to the
 * default rather than returning nothing — a blob with no face is a bug that
 * reads as a design choice, and the whole reason this lives in a module is so
 * a render can never produce one.
 */
export function faceFor(mood) {
  const id = Object.prototype.hasOwnProperty.call(EXPRESSIONS, mood) ? mood : DEFAULT_MOOD
  return { id, ...EXPRESSIONS[id] }
}

/* --------------------------------------------------------------------------
   Hand-drawn accents.

   Five marks, and five is the cap. They are what stops a flat vector screen
   reading as generated: short curls, a spiral, a pair of tapered dashes, the
   cross-pop spark, and a little swoop. They are STROKES, so they scale with
   the blob and take their colour from the ink like everything else, and they
   are drawn slightly uneven and off-axis on purpose — a mark that is
   geometrically perfect is not a pen mark.

   A sixth, seventh and eighth mark is how this becomes clutter, so the test
   caps the table rather than trusting the next person to feel it.

   Unknown accents return null — an accent is optional, so the honest fallback
   for "I don't know that mark" is no mark, not a surprise one. (That is the
   opposite of `faceFor`, and deliberately: a face is mandatory.)
   -------------------------------------------------------------------------- */
export const ACCENTS = {
  curl: [
    { d: 'M 8 46 C 12.5 40.5 18 41 18.5 45.5 C 19 49.5 14 51 13 47.5', w: 2.6 },
    { d: 'M 108 74 C 113 70 116.5 72.5 114.5 76.5', w: 2.2 },
  ],
  spiral: [
    { d: 'M 110 34 C 104.5 33 103 39 107 40.5 C 112 42.5 114.5 35 110 31.5 C 105.5 28 99.5 32 99 37.5', w: 2.4 },
  ],
  dashes: [
    { d: 'M 10 62 L 19 59.5', w: 3 },
    { d: 'M 12 72.5 L 20 71', w: 2.4 },
    { d: 'M 103 54 L 112.5 51', w: 3 },
  ],
  spark: [
    { d: CROSS_POP[0], w: 3 },
    { d: CROSS_POP[1], w: 3 },
  ],
  swoop: [
    // Both clear of the shadow ellipse (x 23..97, y 99..113) and of the
    // sprout (x 77..102, y 3..26) — a pen mark that crosses either reads as a
    // mistake rather than a flourish.
    { d: 'M 9 42 C 14 33 23 28 32 29', w: 2.6 },
    { d: 'M 99 84 C 107 89 113 87 114 80', w: 2.4 },
  ],
}

export const ACCENT_IDS = Object.keys(ACCENTS)
export const MAX_ACCENTS = 5

/** The strokes for an accent, or null when there is no such mark. */
export function accentFor(kind) {
  if (!kind) return null
  return Object.prototype.hasOwnProperty.call(ACCENTS, kind) ? ACCENTS[kind] : null
}

/* --------------------------------------------------------------------------
   The polaroid.

   A white frame, a saturated square, the blob inside it, a round pin at the
   top and a few degrees of rotation. Geometry only — the frame is the sheet's
   fixed white, the pin is coral, and the ground is one of the four tokens.
   -------------------------------------------------------------------------- */
export const POLAROID = {
  tilt: -4,
  frame: { x: 16, y: 14, w: 116, h: 126, r: 5 },
  well: { x: 24, y: 22, w: 100, h: 92, r: 3 },
  pin: { cx: 74, cy: 14, r: 6.5 },
  // Where the 120-unit blob sits inside the well, and how far it shrinks.
  blob: { x: 26, y: 20, scale: 0.79 },
}

/** The viewBox for a variant, as the string an <svg> wants. */
export function viewBoxFor(frame) {
  const n = frame === 'polaroid' ? POLAROID_VIEW : BLOB_VIEW
  return `0 0 ${n} ${n}`
}
