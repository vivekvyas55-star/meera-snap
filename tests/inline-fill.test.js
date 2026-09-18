import { expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// tests/theme-context.test.js derives painted selectors from the STYLESHEETS,
// which means an inline `style={{ background: … }}` is invisible to it. That is
// exactly how Play's three game cards shipped painted with var(--lavender),
// var(--lime) and var(--coral) from `GAMES[id].tint`, outside index.css's
// fixed-light context, and therefore wearing dark-mode ink at night: present,
// laid out, unreadable. Reported as "Play has nothing".
//
// So this is an INVENTORY. Every inline background in the codebase is listed
// below with the reason it is allowed. A new one fails this test until somebody
// decides which it is — and "paint it from a class instead" is usually the
// right answer, because a class is something the theme test can see.

const files = []
for (const dir of ['src/components', 'src/screens']) {
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsx')) files.push(path.join(dir, f))
}

// value -> why it is not a dark-mode hazard.
const ALLOWED = new Map([
  ["'transparent'", 'no fill at all'],
  ["'var(--card)'", 'neutral; follows the theme by definition'],
  ["'var(--bg)'", 'neutral; follows the theme by definition'],
  ['PART_FILL[p.id]', 'a wordless dot in the screen-time legend'],
  ['c', 'a colour swatch in the snap editor; carries no text'],
  ['PART_FILL[id]', 'a wordless screen-time column'],
  ["emoji ? '#f1f1f3' : `linear-gradient(140deg",
    'Avatar: a fixed light disc behind an EMOJI (no ink needed), else a hue gradient whose letter colour is pinned in CSS'],
  ["selected.includes(f.profile.id) ? 'var(--ink)' : 'transparent'",
    'send-to tick; its glyph is var(--bg), so it inverts with the theme'],
  // The two vibrant fills that ARE registered in theme-context.test.js.
  ["'var(--lavender)'", 'Chat.jsx .fp-stat — registered in JS_PAINTED'],
  ["'var(--lime)'", 'Chat.jsx .fp-stat — registered in JS_PAINTED'],
  ['spec.tint', 'IntimateSession .ig-game — registered in JS_PAINTED'],
])

test('every inline background is accounted for', () => {
  const found = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/style=\{\{[^}]*background:\s*([^,}]+)/g)) {
      found.push({ file, value: m[1].trim().replace(/\s+/g, ' ') })
    }
  }
  const unknown = found.filter((f) => !ALLOWED.has(f.value))
  expect(
    unknown.map((u) => `${u.file}: background: ${u.value}`),
    'A new inline background appeared. If it is a vibrant fill it will wear the wrong ink in dark mode — paint it from a CLASS and list the selector in index.css, which is what the theme test can actually see. If it is genuinely neutral or wordless, add it to ALLOWED here with a reason.'
  ).toEqual([])
})

test('no JSX paints a vibrant token inline outside the registered two', () => {
  // The sharper half: `item.tint` resolved to a vibrant token and read as an
  // ordinary identifier, so only an inventory catches it. This catches the
  // literal form directly.
  const offenders = []
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/style=\{\{[^}]*background:\s*'var\(--(lavender|lime|indigo|coral)\)'/g)) {
      if (!file.endsWith('Chat.jsx')) offenders.push(`${file}: --${m[1]}`)
    }
  }
  expect(offenders, 'A vibrant fill painted from JS never enters the fixed-light context. Paint it from a class.').toEqual([])
})
