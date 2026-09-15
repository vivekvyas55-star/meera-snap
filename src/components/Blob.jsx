import { useId } from 'react'
import {
  HALFTONE,
  POLAROID,
  SHADOW,
  accentFor,
  bodyPath,
  contrastGround,
  faceFor,
  isDarkTone,
  sproutPaths,
  toneFill,
  viewBoxFor,
} from '../lib/mascot'
import '../styles/mascot.css'

// ============================================================================
// <Blob> — ONE parametric mascot, not a folder of drawings.
//
//   <Blob mood="happy" tone="lime" size={96} />
//   <Blob mood="content" tone="lime" ground="indigo" frame="polaroid" />
//   <Blob mood="wink" accent="curl" label="You solved it" />
//
// Every expression is a row in EXPRESSIONS (lib/mascot.js) and every mark is a
// row in ACCENTS, so a new one is one entry in a table — there is no second
// component to write and no asset to add. This file is the renderer and holds
// no geometry of its own.
//
// COLOUR. Nothing here names a colour. `tone` selects one of the four existing
// vibrant tokens by name and everything else is `currentColor` or a var():
//   • the body is var(--lavender|--lime|--indigo|--coral)
//   • the face, sprout and accents are currentColor, which resolves to --ink
//   • the halftone is that same currentColor at 16%, so it is the body's own
//     ink thinned rather than a fifth colour
//   • the shadow is var(--wash) — "a tint of the ink onto its own ground",
//     which is exactly what a shadow is, and it is defined in both schemes
//
// DARK MODE. The four fills do NOT move between schemes, so the ink on them
// cannot either — a lavender blob at 2am still needs near-black strokes. The
// inner <g> therefore carries `.blob-ink` (fixed-LIGHT) or `.blob-ink-dark`
// (fixed-DARK, for indigo), both listed in index.css's fixed-context blocks.
// That is the `.fp-stat` lesson applied up front: a fill that never enters
// that context is how a card ends up with near-white text on lavender.
//
// The shadow ellipse sits OUTSIDE that group on purpose. It belongs to the
// card the blob is standing on, not to the blob's ink context, so it reads
// var(--wash) from whatever surface it was dropped onto. Moving it inside
// would give an indigo blob a white shadow.
//
// MOTION. One CSS animation (a slow bob) in styles/mascot.css. It loops, so
// the global prefers-reduced-motion rule — 0.01ms plus
// animation-iteration-count: 1 — has to be able to stop it: the keyframes are
// written with the RESTING state at both 0% and 100%, so collapsing the
// duration lands on the good-looking pose rather than mid-squash. mascot.css
// carries its own reduced-motion block too rather than trusting the global one
// alone, which is the mistake four files in this repo documented and none of
// them actually had. No requestAnimationFrame, no setInterval, no timer.
//
// ACCESSIBILITY. Default is decorative: aria-hidden, no role, invisible to a
// screen reader, because the heading next to it already says what the screen
// is. Pass `label` and it becomes role="img" with that label. Nothing here
// uses colour alone to say which mood it is — `alt` in the expression table is
// a sentence, and every placement has words beside it.
//
// NO IMAGES. There is no <img>, no <image>, no href, no url() and no fetch in
// this component or its stylesheet, and tests/mascot.test.jsx asserts it.
// ============================================================================

export default function Blob({
  mood = 'neutral',
  tone = 'lavender',
  size = 96,
  frame,
  ground,
  accent,
  label,
  className = '',
  animated = true,
}) {
  // Pattern and clip ids must be unique per instance: two blobs on one screen
  // sharing an id means the second one silently borrows the first one's clip.
  const uid = useId().replace(/:/g, '')
  const face = faceFor(mood)
  const marks = accentFor(accent)
  const polaroid = frame === 'polaroid'

  const body = bodyPath()
  const sprout = sproutPaths()
  const dotsId = `blob-dots-${uid}`
  const clipId = `blob-clip-${uid}`

  // An unrecognised ground falls back to the deterministic partner for this
  // tone rather than to nothing — a transparent well inside a polaroid is a
  // hole, not a design.
  const wellTone = polaroid ? (ground ?? contrastGround(tone)) : null

  const inkClass = isDarkTone(tone) ? 'blob-ink-dark' : 'blob-ink'
  const wellClass = wellTone && isDarkTone(wellTone) ? 'blob-ink-dark' : 'blob-ink'

  const a11y = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': 'true', focusable: 'false' }

  const figure = (
    <>
      <defs>
        <pattern
          id={dotsId}
          width={HALFTONE.tile}
          height={HALFTONE.tile}
          patternUnits="userSpaceOnUse"
        >
          {HALFTONE.dots.map((d, i) => (
            <circle
              key={i}
              cx={d.cx}
              cy={d.cy}
              r={d.r}
              fill="currentColor"
              opacity={HALFTONE.opacity}
            />
          ))}
        </pattern>
        <clipPath id={clipId}>
          <path d={body} />
        </clipPath>
      </defs>

      {/* The sprout sits behind the body so the stem tucks under the shoulder. */}
      <g className="blob-sprout" fill="currentColor">
        <path
          d={sprout.stem}
          fill="none"
          stroke="currentColor"
          strokeWidth="3.4"
          strokeLinecap="round"
        />
        {sprout.leaves.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>

      <path d={body} fill={toneFill(tone)} />
      {/* Halftone: the body's own ink, thinned, clipped to the body. */}
      <g clipPath={`url(#${clipId})`}>
        <rect x="0" y="0" width="120" height="120" fill={`url(#${dotsId})`} />
      </g>

      <g
        className="blob-face"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {face.strokes.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      {face.fills.length > 0 && (
        <g className="blob-face-fill" fill="currentColor">
          {face.fills.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      )}
    </>
  )

  return (
    <svg
      className={`blob${animated ? ' is-animated' : ''}${polaroid ? ' is-polaroid' : ''}${className ? ` ${className}` : ''}`}
      viewBox={viewBoxFor(frame)}
      width={size}
      height={size}
      {...a11y}
    >
      {polaroid ? (
        <g transform={`rotate(${POLAROID.tilt} ${POLAROID.frame.x + POLAROID.frame.w / 2} ${POLAROID.frame.y + POLAROID.frame.h / 2})`}>
          <rect
            className="blob-frame"
            x={POLAROID.frame.x}
            y={POLAROID.frame.y}
            width={POLAROID.frame.w}
            height={POLAROID.frame.h}
            rx={POLAROID.frame.r}
          />
          <g className={wellClass}>
            <rect
              x={POLAROID.well.x}
              y={POLAROID.well.y}
              width={POLAROID.well.w}
              height={POLAROID.well.h}
              rx={POLAROID.well.r}
              fill={toneFill(wellTone)}
            />
            <g
              transform={`translate(${POLAROID.blob.x} ${POLAROID.blob.y}) scale(${POLAROID.blob.scale})`}
            >
              <ellipse
                className="blob-shadow"
                cx={SHADOW.cx}
                cy={SHADOW.cy}
                rx={SHADOW.rx}
                ry={SHADOW.ry}
                fill="var(--wash)"
              />
              <g className={`${inkClass} blob-body`}>{figure}</g>
            </g>
          </g>
          <circle
            className="blob-pin"
            cx={POLAROID.pin.cx}
            cy={POLAROID.pin.cy}
            r={POLAROID.pin.r}
            fill="var(--coral)"
          />
        </g>
      ) : (
        <>
          <ellipse
            className="blob-shadow"
            cx={SHADOW.cx}
            cy={SHADOW.cy}
            rx={SHADOW.rx}
            ry={SHADOW.ry}
            fill="var(--wash)"
          />
          {/* Accents are pen marks on the surface, not on the blob, so they
              take the ambient ink and stay put while the body bobs. */}
          {marks && (
            <g
              className="blob-accent"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {marks.map((m, i) => (
                <path key={i} d={m.d} strokeWidth={m.w} />
              ))}
            </g>
          )}
          <g className={`${inkClass} blob-body`}>{figure}</g>
        </>
      )}
    </svg>
  )
}
