import React from 'react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import Blob from '../src/components/Blob'
import MysteryBox from '../src/components/MysteryBox'
import { boxForDay } from '../src/lib/mysteryBox'
import { istToday } from '../src/lib/db'
import {
  ACCENTS,
  ACCENT_IDS,
  DEFAULT_MOOD,
  DEFAULT_TONE,
  EXPRESSIONS,
  MAX_ACCENTS,
  MOODS,
  TONES,
  accentFor,
  bodyPath,
  contrastGround,
  faceFor,
  isDarkTone,
  sproutPaths,
  toneFill,
  viewBoxFor,
} from '../src/lib/mascot'

afterEach(cleanup)

// Several assertions below are about the CODE, not the prose around it —
// these files explain at length what they refuse to do, and naming a thing in
// order to refuse it must not read as doing it.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const LIB = readFileSync('src/lib/mascot.js', 'utf8')
const CMP = readFileSync('src/components/Blob.jsx', 'utf8')
const CSS = readFileSync('src/styles/mascot.css', 'utf8')

/* ==========================================================================
   The geometry module.

   The whole reason a drawing lives in a pure module here — the same reason
   runner.js, geo.js and decoyMarket.js do — is that a broken path renders as
   "nothing visible" and nobody notices for a week.
   ========================================================================== */

// A conservative SVG path grammar: a leading moveto, then only the commands
// and numbers we actually emit. It catches the real failure, which is a
// template literal producing `M NaN undefined` and an element that draws
// nothing at all.
const PATH_RE = /^M\s-?\d/
const PATH_CHARS = /^[MmCcQqLlZz0-9\s.,-]+$/

const validPath = (d) => {
  expect(typeof d).toBe('string')
  expect(d.length).toBeGreaterThan(8)
  expect(d).toMatch(PATH_RE)
  expect(d).toMatch(PATH_CHARS)
  expect(d).not.toMatch(/NaN|undefined|Infinity/)
}

describe('every mood is a complete, drawable face', () => {
  test.each(MOODS)('%s', (mood) => {
    const face = faceFor(mood)
    expect(face.id).toBe(mood)

    // Two eyes and a mouth at minimum — whether the mouth is stroked or
    // filled. A face missing one of the three is the silent failure.
    expect(face.strokes.length + face.fills.length).toBeGreaterThanOrEqual(3)
    expect(face.strokes.length).toBeGreaterThanOrEqual(2) // the eyes, always
    for (const d of face.strokes) validPath(d)
    for (const d of face.fills) validPath(d)

    // Never colour alone. Every mood carries a real sentence, so an instance
    // that carries meaning has something true to be labelled with.
    expect(typeof face.alt).toBe('string')
    expect(face.alt.split(' ').length).toBeGreaterThan(3)
    expect(face.label.length).toBeGreaterThan(0)
  })

  test('the reference set is all here', () => {
    expect(MOODS).toEqual(
      expect.arrayContaining(['neutral', 'happy', 'wink', 'annoyed', 'content', 'sad']),
    )
  })

  test('two moods never share an identical face', () => {
    const seen = new Set()
    for (const mood of MOODS) {
      const face = faceFor(mood)
      const key = JSON.stringify([face.strokes, face.fills])
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  test('the cross-pop spark rides with annoyed, as in the reference', () => {
    // Four strokes plus the two-stroke spark: the mark is part of the
    // expression, not something a call site has to remember to add.
    expect(faceFor('annoyed').strokes.length).toBeGreaterThan(faceFor('neutral').strokes.length)
  })
})

describe('an unknown mood falls back rather than rendering nothing', () => {
  // A blob with no face is a bug that reads as a design choice. This is the
  // opposite of the accent rule below, and deliberately so: a face is
  // mandatory, a pen mark is optional.
  test.each([
    ['a typo', 'happpy'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['an object', {}],
    ['a prototype key', 'toString'],
    ['constructor', 'constructor'],
  ])('%s', (_label, value) => {
    const face = faceFor(value)
    expect(face.id).toBe(DEFAULT_MOOD)
    expect(face.strokes.length).toBeGreaterThanOrEqual(2)
    for (const d of face.strokes) validPath(d)
  })
})

describe('the body, the sprout and the drawing space', () => {
  test('the body path is stable and drawable', () => {
    validPath(bodyPath())
    expect(bodyPath()).toBe(bodyPath()) // pure — no Math.random anywhere
    expect(bodyPath().endsWith('Z')).toBe(true)
  })

  test('the sprout is a stem and exactly two leaves', () => {
    const sprout = sproutPaths()
    validPath(sprout.stem)
    expect(sprout.leaves).toHaveLength(2)
    for (const d of sprout.leaves) validPath(d)
  })

  test('viewBoxFor answers four numbers for both variants', () => {
    for (const frame of [undefined, 'polaroid', 'nonsense']) {
      expect(viewBoxFor(frame).split(' ')).toHaveLength(4)
      expect(viewBoxFor(frame)).not.toMatch(/NaN|undefined/)
    }
    expect(viewBoxFor('polaroid')).not.toBe(viewBoxFor(undefined))
  })
})

describe('tones are the four that already exist, and nothing else', () => {
  test('the palette is exactly Meera’s four', () => {
    expect(TONES).toEqual(['lavender', 'lime', 'indigo', 'coral'])
  })

  test('toneFill always names a token, never a value', () => {
    for (const tone of TONES) expect(toneFill(tone)).toBe(`var(--${tone})`)
  })

  test('an unknown tone falls back to a real token', () => {
    for (const bad of ['mint', 'red', '#ff0000', undefined, null, 42]) {
      expect(toneFill(bad)).toBe(`var(--${DEFAULT_TONE})`)
    }
  })

  test('indigo is the one tone that takes white ink', () => {
    expect(isDarkTone('indigo')).toBe(true)
    for (const tone of ['lavender', 'lime', 'coral', 'nonsense']) {
      expect(isDarkTone(tone)).toBe(false)
    }
  })

  test('a polaroid ground is one of the four, and never the blob’s own', () => {
    for (const tone of [...TONES, 'nonsense', undefined]) {
      const ground = contrastGround(tone)
      expect(TONES).toContain(ground)
      expect(ground).not.toBe(TONES.includes(tone) ? tone : DEFAULT_TONE)
    }
  })
})

describe('the hand-drawn accents', () => {
  test('there are at most five, and five is the cap', () => {
    // A sixth, seventh and eighth mark is how a few pen strokes become
    // clutter. Capped mechanically rather than left to the next person's eye.
    expect(ACCENT_IDS.length).toBeLessThanOrEqual(MAX_ACCENTS)
    expect(ACCENT_IDS.length).toBeGreaterThanOrEqual(4)
  })

  test.each(ACCENT_IDS)('%s is drawable strokes with a width', (kind) => {
    const marks = accentFor(kind)
    expect(marks.length).toBeGreaterThan(0)
    for (const m of marks) {
      validPath(m.d)
      expect(typeof m.w).toBe('number')
      expect(m.w).toBeGreaterThan(0)
    }
    expect(ACCENTS[kind]).toBe(marks)
  })

  test('an unknown or absent accent is NO mark, not a surprise one', () => {
    for (const bad of ['sparkles', undefined, null, '', 0, 'toString']) {
      expect(accentFor(bad)).toBeNull()
    }
  })
})

/* ==========================================================================
   The component.
   ========================================================================== */

const svgOf = (container) => container.querySelector('svg.blob')

describe('nothing is an image and nothing is fetched', () => {
  // The constraint most likely to be violated later by somebody adding a nice
  // PNG. Media is this app's entire hosting bill, so it is asserted from three
  // directions: the rendered output, the source, and the repository itself.
  test('the rendered mascot has no <img>, no <image> and no external url', () => {
    for (const mood of MOODS) {
      const { container, unmount } = render(
        <Blob mood={mood} tone="lavender" accent="curl" />,
      )
      expect(container.querySelectorAll('img')).toHaveLength(0)
      expect(container.querySelectorAll('image')).toHaveLength(0)
      expect(container.querySelectorAll('[src]')).toHaveLength(0)
      expect(container.querySelectorAll('[href], [xlink\\:href]')).toHaveLength(0)

      // The only url() a blob may contain points at its own <defs>.
      const html = container.innerHTML
      for (const ref of html.match(/url\([^)]*\)/g) ?? []) {
        expect(ref).toMatch(/^url\("?#/)
      }
      expect(html).not.toMatch(/https?:|data:|\.png|\.jpe?g|\.webp|\.gif|\.svg/i)
      unmount()
    }
  })

  test('the polaroid variant is drawn too, not framed around a picture', () => {
    const { container } = render(<Blob frame="polaroid" mood="content" tone="lime" />)
    expect(container.querySelectorAll('img, image, [src]')).toHaveLength(0)
    expect(svgOf(container).classList.contains('is-polaroid')).toBe(true)
    // Frame, well and pin, all drawn.
    expect(container.querySelector('.blob-frame')).toBeTruthy()
    expect(container.querySelector('.blob-pin')).toBeTruthy()
  })

  test('neither source file loads or fetches anything', () => {
    for (const src of [LIB, CMP]) {
      expect(src).not.toMatch(/\bfetch\s*\(/)
      expect(src).not.toMatch(/\bnew Image\b|XMLHttpRequest|import\(/)
      expect(src).not.toMatch(/https?:\/\//)
      expect(src).not.toMatch(/\.(png|jpe?g|webp|gif|avif|woff2?|ttf|otf)\b/i)
    }
    expect(CSS).not.toMatch(/url\s*\(/)
    expect(CSS).not.toMatch(/@import/)
  })

  test('src/ still contains no image, icon or font asset of any kind', () => {
    // A mascot set shipped as pictures would be the largest static addition in
    // this app's history. `src/` has always been code only; this keeps it that
    // way, and it is the assertion a future "just one small PNG" trips over.
    const bad = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|ttf|otf|woff2?|mp3|wav|mp4)$/i
    const found = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (bad.test(name)) found.push(path)
      }
    }
    walk('src')
    expect(found).toEqual([])
  })
})

describe('the palette does not change', () => {
  // The owner's instruction, asserted rather than remembered: the reference
  // supplies the form and none of its colour. No hex, no rgb(), no hsl() in
  // either the module, the component or the stylesheet.
  const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/

  test.each([
    ['src/lib/mascot.js', LIB],
    ['src/components/Blob.jsx', CMP],
    ['src/styles/mascot.css', CSS],
  ])('%s names no colour literal', (_name, src) => {
    const hit = stripComments(src).match(COLOUR_LITERAL)
    expect(hit, hit ? `found ${hit[0]}` : '').toBeNull()
  })

  test('every paint is a token var() or currentColor', () => {
    const { container } = render(<Blob mood="happy" tone="coral" accent="dashes" />)
    for (const el of container.querySelectorAll('[fill], [stroke]')) {
      for (const attr of ['fill', 'stroke']) {
        const v = el.getAttribute(attr)
        if (v == null || v === 'none') continue
        expect(v).toMatch(/^(currentColor|var\(--[a-z-]+\)|url\(#)/)
      }
    }
  })

  test('the four tones each name their own token and nothing more', () => {
    for (const tone of TONES) {
      const { container, unmount } = render(<Blob tone={tone} />)
      expect(container.innerHTML).toContain(`var(--${tone})`)
      unmount()
    }
  })
})

describe('dark mode goes through the fixed-context list, not a second rule', () => {
  const INDEX = readFileSync('src/index.css', 'utf8')

  test('.blob-ink is in the fixed-LIGHT list and .blob-ink-dark in the fixed-DARK one', () => {
    // The `.fp-stat` lesson: a vibrant fill that never enters that context is
    // how a card ends up with near-white text on lavender at night. The four
    // fills do not move between schemes, so their ink cannot either.
    const light = INDEX.indexOf('.blob-ink,')
    const dark = INDEX.indexOf('.blob-ink-dark,')
    expect(light).toBeGreaterThan(-1)
    expect(dark).toBeGreaterThan(-1)
    expect(dark).toBeGreaterThan(light) // fixed-dark block comes second
    // And the mascot's own sheet must NOT carry a second copy of the values.
    expect(CSS).not.toContain('--ink:')
    expect(CSS).not.toContain('--muted:')
  })

  test('a light tone takes the light context and indigo the dark one', () => {
    const light = render(<Blob tone="lavender" />)
    expect(light.container.querySelector('.blob-ink')).toBeTruthy()
    expect(light.container.querySelector('.blob-ink-dark')).toBeNull()
    cleanup()

    const dark = render(<Blob tone="indigo" />)
    expect(dark.container.querySelector('.blob-ink-dark')).toBeTruthy()
  })

  test('the shadow sits OUTSIDE the ink context, so it belongs to the card', () => {
    // Inside it, an indigo blob would cast a white shadow.
    const { container } = render(<Blob tone="indigo" />)
    const shadow = container.querySelector('.blob-shadow')
    expect(shadow).toBeTruthy()
    expect(shadow.closest('.blob-ink-dark')).toBeNull()
    expect(shadow.getAttribute('fill')).toBe('var(--wash)')
  })
})

describe('motion can actually be stopped', () => {
  test('the looping keyframes rest at 100%, and the sheet stops them itself', () => {
    // prefers-reduced-motion collapses the duration to 0.01ms and sets
    // iteration-count: 1, so a loop lands on its 100% frame. That frame has to
    // be the good-looking pose, or a reduced-motion user gets a blob frozen
    // mid-squash. index.css records four files that documented this protection
    // while the rule did not exist at all.
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(CSS).toMatch(/animation-iteration-count:\s*1/)
    for (const frame of CSS.match(/@keyframes [\s\S]*?\n}/g) ?? []) {
      expect(frame).toMatch(/0%,\s*100%\s*\{/)
    }
  })

  test('nothing here out-shouts the global rule with !important', () => {
    expect(CSS).not.toContain('!important')
  })

  test('no timer, no rAF — the motion is CSS', () => {
    for (const src of [LIB, CMP]) {
      expect(stripComments(src)).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/)
    }
  })

  test('animation can be turned off per instance', () => {
    const on = render(<Blob />)
    expect(svgOf(on.container).classList.contains('is-animated')).toBe(true)
    cleanup()
    const off = render(<Blob animated={false} />)
    expect(svgOf(off.container).classList.contains('is-animated')).toBe(false)
  })
})

describe('accessibility', () => {
  test('a decorative blob is hidden from a screen reader', () => {
    const { container } = render(<Blob mood="happy" />)
    const svg = svgOf(container)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBeNull()
  })

  test('a blob that carries meaning gets a real label', () => {
    const { container } = render(<Blob mood="happy" label="You solved today's box" />)
    const svg = svgOf(container)
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe("You solved today's box")
    expect(svg.getAttribute('aria-hidden')).toBeNull()
  })
})

describe('two blobs on one screen do not share their <defs>', () => {
  test('pattern and clip ids are unique per instance', () => {
    const { container } = render(
      <>
        <Blob tone="lime" />
        <Blob tone="coral" />
      </>,
    )
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/* ==========================================================================
   One placement, end to end.

   The Mystery Box is the placement where the blob carries meaning rather than
   decoration, so it is the one worth asserting: it must appear on a solve,
   must be labelled, and must NOT appear on a miss — a puzzle meant to take two
   minutes on a bus does not pull a face at somebody for missing it.
   ========================================================================== */
describe('placement: the solved Mystery Box', () => {
  const puzzle = () => boxForDay(istToday(), 'me')

  test('a solved box shows a labelled reaction', () => {
    const { container } = render(
      <MysteryBox puzzle={puzzle()} progress={{ solved: true, revealed: false }} />,
    )
    const svg = svgOf(container)
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toMatch(/solved/i)
    // The words are still there beside it — the face is never the only signal.
    expect(container.textContent).toMatch(/You got it/)
  })

  test('an unsolved box has no face at all', () => {
    const { container } = render(
      <MysteryBox puzzle={puzzle()} progress={{ solved: false, revealed: false }} />,
    )
    expect(svgOf(container)).toBeNull()
  })

  test('a revealed-but-unsolved box has no face either', () => {
    // Reveal is always free here, and it is not a failure — but it is also not
    // a win, so nothing congratulates anyone for it.
    const { container } = render(
      <MysteryBox puzzle={puzzle()} progress={{ solved: false, revealed: true }} />,
    )
    expect(svgOf(container)).toBeNull()
    expect(container.textContent).toMatch(/The answer was/)
  })
})

/* ==========================================================================
   What was deliberately NOT taken from the reference.
   ========================================================================== */
describe('the reference supplied the form and nothing else', () => {
  test('no heading, weight or font is restyled', () => {
    // Meera's identity is oversized LIGHT-WEIGHT (300) display headings. The
    // reference's heavy black type is not brought across, and the mascot is an
    // addition to the language rather than a replacement for it.
    expect(CSS).not.toMatch(/font-weight/)
    expect(CSS).not.toMatch(/font-family/)
    expect(CSS).not.toMatch(/^\s*h[1-6]\b/m)
  })

  test('no engagement mechanic rides in with it', () => {
    // The reference is a language app and its illustration sits on streaks, XP
    // and progress rings. The screen-time panel already refused a usage streak
    // as "the exact Snapchat mechanic this app copies for messages and must
    // not copy for attention"; a mascot is not the way to smuggle one back.
    const banned = [
      'streak', 'level up', 'keep it up', 'progress ring',
      'daily goal', 'don’t break', 'you missed', 'come back', 'well done',
    ]
    const code = stripComments(`${LIB}\n${CMP}\n${CSS}`).toLowerCase()
    for (const word of banned) expect(code).not.toContain(word)
    // `xp` as a word — 'expression' is not an engagement mechanic.
    expect(code).not.toMatch(/\bxp\b/)
  })

  test('every expression is one row in a table, not a component', () => {
    // A new mood must cost one entry. If this starts failing it is because
    // somebody wrote Blob2.jsx.
    expect(Object.keys(EXPRESSIONS)).toEqual(MOODS)
    expect(CMP).not.toMatch(/function Blob[A-Z]/)
    expect(CMP.match(/export default/g)).toHaveLength(1)
  })
})
