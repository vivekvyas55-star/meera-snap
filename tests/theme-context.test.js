import { expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

// ============================================================================
// THE THEME-CONTEXT INVARIANT, CHECKED BOTH WAYS
//
// index.css keeps a fixed-LIGHT and a fixed-DARK list: selectors that re-declare
// --ink / --muted / --card for their own subtree so a card whose FILL does not
// follow the theme keeps legible contents. The contract is one line:
//
//   A selector belongs in a list if and only if its background is a fixed fill
//   that does not change between schemes.
//
// Both directions have shipped as real bugs in this repo:
//
//   MISSING  — .fp-stat is painted var(--lavender) from an inline style, so it
//              never entered the context and went near-white text on lavender
//              at night.
//   WRONGLY  — .play-card sat in the fixed-light list while both its usages are
//     LISTED   neutral (SoloPlay's .solo-door has no fill; PlayTogether's entry
//              card paints var(--card)), so "More to play" rendered dark ink on
//              a dark card at night. Found by eye, on a phone, after 950 tests
//              had passed.
//
// tests/solo-screen.test.jsx and tests/mood-garden.test.jsx each derived the
// painted selectors from ONE stylesheet and checked only the MISSING direction.
// This generalises that to every stylesheet and adds the wrongly-listed half —
// which is the half that found today's bug. Those two keep their file-local
// checks; this is the sheet-wide one.
// ============================================================================

const INDEX = 'src/index.css'
const FILES = [INDEX, ...readdirSync('src/styles').map((f) => 'src/styles/' + f)]
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

// ---------------------------------------------------------------------------
// Which tokens move with the scheme? Derived from the dark block rather than
// typed out, so adding a token to dark mode cannot leave this test behind.
// ---------------------------------------------------------------------------
const index = readFileSync(INDEX, 'utf8')
const darkBlockStart = index.indexOf('@media (prefers-color-scheme: dark) {')
const darkBlock = index.slice(darkBlockStart, index.indexOf('FIXED-LIGHT CONTEXT'))
const THEMED = new Set([...darkBlock.matchAll(/^\s{4}(--[\w-]+)\s*:/gm)].map((m) => m[1]))

// The four vibrant fills are the identity and are the ONLY tokens absent from
// the dark block on purpose — a lavender card is lavender at 2am.
const FIXED_LIGHT_FILL = new Set(['--lavender', '--lime', '--coral'])
// --indigo never moves either. --chrome DOES move (#16161a -> #26252f) but both
// values are near-black, so white ink is right in both schemes: it is the
// floating-chrome family, and the fixed-DARK list is where it belongs.
const FIXED_DARK_FILL = new Set(['--indigo', '--chrome'])

// ---------------------------------------------------------------------------
// The two lists.
// ---------------------------------------------------------------------------
const listSel = (block) => [...block.matchAll(/^(\.[\w.:()[\]=-]+)\s*(?:,|\{)\s*$/gm)].map((m) => m[1])
const LIGHT = listSel(index.slice(index.indexOf('FIXED-LIGHT CONTEXT'), index.indexOf('FIXED-DARK CONTEXT')))
const DARK = listSel(index.slice(index.indexOf('FIXED-DARK CONTEXT'), index.indexOf('* { box-sizing')))

// ---------------------------------------------------------------------------
// Every rule in every stylesheet, with what it paints and whether it pins its
// own foreground.
// ---------------------------------------------------------------------------
const rules = []
for (const file of FILES) {
  const css = strip(readFileSync(file, 'utf8'))
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2]
    const backgrounds = [...body.matchAll(/(?:^|;)\s*background(?:-color|-image)?\s*:\s*([^;]+)/g)].map((b) => b[1].trim())
    if (!backgrounds.length) continue
    // A rule that pins `color:` to something that does not follow the theme is
    // the OTHER legitimate pattern — a coral badge with `color: var(--on-fill)`
    // needs no subtree context, because nothing inside it reads --ink.
    const colour = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/)
    const pinsInk = Boolean(colour && !/var\(--(ink|muted)\)/.test(colour[1]))
    for (const sel of m[1].split(',').map((s) => s.trim())) {
      if (sel.startsWith('.')) rules.push({ file, sel, backgrounds, pinsInk })
    }
  }
}

const tokensIn = (decl) => [...decl.matchAll(/var\((--[\w-]+)\)/g)].map((t) => t[1])
// `.play-btn.play-your-turn .play-dot` paints `.play-dot`, so that is the name
// a judgement about the element has to be recorded under.
const target = (sel) => sel.trim().split(/\s+|>/).filter(Boolean).pop()

// ---------------------------------------------------------------------------
// Painted from JS, so no stylesheet rule can prove the fill. Each entry names
// the file that paints it, and the test greps that file — an allowlist nothing
// checks is a list of excuses.
// ---------------------------------------------------------------------------
const JS_PAINTED = {
  '.fp-stat': 'src/screens/Chat.jsx',
  '.ig-game': 'src/components/IntimateSession.jsx',
  '.ed-card': 'src/components/EmojiDetective.jsx',
  '.mf-done': 'src/components/MemoryFlip.jsx',
  '.mg-today': 'src/components/MoodGarden.jsx',
  '.mg-unlock.is-on': 'src/components/MoodGarden.jsx',
  '.consent-card': 'src/components/SnapSaveConsent.jsx',
  '.blob-ink': 'src/components/Blob.jsx',
  '.blob-ink-dark': 'src/components/Blob.jsx',
}

// ---------------------------------------------------------------------------
// Vibrant fills with no words on them. A disc, a pip, a bead, a bar or a dot
// carries no text, so nothing inside it reads --ink and it needs no context.
// CLAUDE.md already names the Connect Four and checkers pieces as "discs today
// [that] would need adding the moment they carry a glyph" — this is where that
// judgement is recorded rather than remembered.
// ---------------------------------------------------------------------------
const NO_WORDS = new Set([
  '.ring.unseen',          // gradient ring around an avatar
  '.rec-dot',              // recording indicator
  '.play-dot',             // unread dot on the chat header's Play button
  '.play-chip-dot',
  '.st-bar.is-today',      // screen-time column
  '.er-pip.is-now', '.er-pip.is-done', '.er-bead.is-on',
  '.c4-board', '.c4-cell.mark-x', '.c4-cell.mark-o',
  '.ck-dot-x', '.ck-dot-o', '.ck-x', '.ck-o',
  '.pc-save-dot',
  '.mk-dot',
  '.c4-next',              // the column-hover ghost piece
])

// ===========================================================================

test('every selector in the fixed-light / fixed-dark lists really sits on a fixed fill', () => {
  // The .play-card direction. A neutral surface pinned against the theme is
  // dark ink on a dark card at night, and no amount of reading the list finds
  // it — the fill is in another file.
  for (const [list, family, label] of [[LIGHT, FIXED_LIGHT_FILL, 'fixed-light'], [DARK, FIXED_DARK_FILL, 'fixed-dark']]) {
    for (const sel of list) {
      if (JS_PAINTED[sel]) continue
      const painted = rules.filter((r) => r.sel === sel)
      expect(painted.length, `${sel} is in the ${label} list but no stylesheet paints it a background (and it is not in JS_PAINTED)`).toBeGreaterThan(0)

      const ok = painted.some((r) => r.backgrounds.some((bg) => {
        const tokens = tokensIn(bg)
        // A literal hex / rgb with no token in it is a fixed fill by definition.
        if (!tokens.length) return true
        return tokens.some((t) => family.has(t))
      }))
      const themed = painted.flatMap((r) => r.backgrounds.flatMap(tokensIn)).filter((t) => THEMED.has(t) && !family.has(t))
      expect(ok, `${sel} is in the ${label} list but is painted ${JSON.stringify(painted.flatMap((r) => r.backgrounds))} — ${themed.length ? `var(${themed[0]}) follows the theme` : 'that is not a fixed fill'}. A surface that follows the theme must NOT be pinned against it (the .play-card bug).`).toBe(true)
    }
  }
})

test('every vibrant fill in the stylesheets is accounted for', () => {
  // The .fp-stat direction, widened from one file to all of them.
  const listed = new Set([...LIGHT, ...DARK])
  for (const rule of rules) {
    for (const bg of rule.backgrounds) {
      const vibrant = tokensIn(bg).filter((t) => FIXED_LIGHT_FILL.has(t) || t === '--indigo')
      if (!vibrant.length) continue
      const excused = listed.has(rule.sel) || rule.pinsInk ||
        NO_WORDS.has(rule.sel) || NO_WORDS.has(target(rule.sel)) || listed.has(target(rule.sel))
      expect(excused, `${rule.file} paints ${rule.sel} with var(${vibrant[0]}) but it is not in a theme-context list, does not pin its own color:, and is not recorded in NO_WORDS. Decide which it is — a fill that carries words needs the context; one that carries none belongs in NO_WORDS with a reason.`).toBe(true)
    }
  }
})

test('the JS_PAINTED allowlist is not a list of excuses', () => {
  // Each entry claims a file paints that class. Check the claim, so an entry
  // cannot outlive the code it describes.
  for (const [sel, file] of Object.entries(JS_PAINTED)) {
    const cls = sel.split('.').filter(Boolean)[0]
    const source = readFileSync(file, 'utf8')
    expect(source.includes(cls), `JS_PAINTED says ${file} paints ${sel}, but "${cls}" does not appear in it`).toBe(true)
  }
})

test('nothing paints a screen-wide ground from JS', () => {
  // Five whole screens used to render as
  //   <div className="app" style={{ …, background: '#fff' }}>
  // and an inline declaration outranks every selector in index.css, so at night
  // those screens stayed white while --ink went near-white: white text on a
  // white ground. The stopgap was the only `!important` in the sheet; `.screen`
  // is the fix. This is the same lesson as the lists above, one scale up.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir + '/' + e.name) : /\.jsx?$/.test(e.name) ? [dir + '/' + e.name] : []
  )
  for (const file of walk('src')) {
    const source = readFileSync(file, 'utf8')
    const hits = [...source.matchAll(/background(?:Color)?\s*:\s*'#[0-9a-fA-F]{3,8}'/g)]
    expect(hits.length, `${file} paints a background from a hard-coded hex in JS: ${hits.map((h) => h[0]).join(', ')}. Paint it from a class so it can follow the theme.`).toBe(0)
  }
  expect(readFileSync(INDEX, 'utf8')).toContain('.screen { display: flex; flex-direction: column; background: var(--bg); }')
})
