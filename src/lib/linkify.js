// Turning a pasted URL in a chat body into something tappable.
//
// Message bodies rendered as plain text, so sharing a reel meant the recipient
// read a URL off the screen and retyped it. This splits a body into text and
// link segments; `Chat.jsx` renders the links as anchors and everything else
// unchanged.
//
// WHY THERE IS NO PREVIEW CARD. A card needs the page's Open Graph tags, and
// there is no backend here to fetch them (a static bundle cannot — CORS blocks
// reading another origin's HTML), so it would take an Edge Function plus an
// image proxy. Then every card is a remote image fetched once per viewer per
// render, which is precisely the egress that is the whole hosting bill in this
// app. A tappable link costs nothing and does the thing somebody actually
// wanted, which was to open the reel.
//
// THE SCHEME ALLOWLIST IS THE SECURITY BOUNDARY OF THIS FILE. A message body is
// attacker-supplied text — a friend, or anyone who has a friendship row — and
// it goes straight into an `href`. `javascript:` there is script execution in
// the page's origin, which holds the session; `data:` is a fabricated document
// under Meera's own name. So the rule is an ALLOWLIST of exactly `http` and
// `https`, applied to the matched text, and nothing is inferred: we never
// prepend a scheme to something that already has a colon in front of its host.
// A bare `www.` host is the one convenience, and it is given `https:`.

// Deliberately conservative, and it must only match at a TOKEN BOUNDARY.
//
// `\b` is not enough: `:` is a non-word character, so `\bhttps?:\/\/` happily
// matches the tail of `blob:https://meera.example/x` and `javascript:https://x.com`
// — linking a substring while the text on screen still reads as some other
// scheme. The leading group pins a match to the start of the body or to a real
// separator. It is a capture group rather than a lookbehind so this does not
// depend on lookbehind support in an older mobile Safari.
//
// A false negative here is a link somebody has to copy; a false positive is an
// href that does not match the words around it. The trade only goes one way.
const LINK_RE = /(^|[\s([{<"'])((?:https?:\/\/|www\.)[^\s<>"']+)/gi

// Trailing punctuation almost never belongs to the URL — "look at
// https://x.com/a." ends a sentence. Closing brackets are stripped only when
// unbalanced, so a path that really contains one survives.
const TRAILING = /[.,!?;:'"]+$/

// Long enough for any real share link, short enough that a pathological body
// cannot build a megabyte href.
const MAX_HREF = 2048

function trimTrailing(raw) {
  let text = raw.replace(TRAILING, '')
  // Strip one unbalanced closer at a time, e.g. "(see https://x.com/a)".
  for (;;) {
    const last = text.at(-1)
    if (last !== ')' && last !== ']' && last !== '}') break
    const open = last === ')' ? '(' : last === ']' ? '[' : '{'
    const opens = text.split(open).length - 1
    const closes = text.split(last).length - 1
    if (closes <= opens) break
    text = text.slice(0, -1).replace(TRAILING, '')
  }
  return text
}

/**
 * The href for a matched piece of text, or null if it is not one we will link.
 *
 * Parsed with `URL` rather than pattern-matched, so the decision is made by the
 * same thing the browser would use, and the protocol is then checked against
 * the allowlist explicitly.
 */
export function hrefFor(text) {
  if (!text || text.length > MAX_HREF) return null
  const candidate = /^www\./i.test(text) ? `https://${text}` : text
  let url
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // A host with no dot is either a typo or something like `http://localhost`,
  // which is not a thing anybody shares in a message.
  if (!url.hostname.includes('.')) return null
  return url.href
}

/**
 * Split a body into `{ type: 'text' | 'link', value, href? }` segments.
 *
 * Always returns at least one segment for a non-empty body, and concatenating
 * every `value` reproduces the input exactly — the renderer must never be able
 * to drop or reorder somebody's words.
 */
export function linkSegments(body) {
  const text = typeof body === 'string' ? body : ''
  if (!text) return []
  const out = []
  let at = 0
  for (const match of text.matchAll(LINK_RE)) {
    const raw = match[2]
    const start = match.index + match[1].length
    const kept = trimTrailing(raw)
    const href = hrefFor(kept)
    if (!href || !kept) continue
    if (start > at) out.push({ type: 'text', value: text.slice(at, start) })
    out.push({ type: 'link', value: kept, href })
    at = start + kept.length
  }
  if (at < text.length) out.push({ type: 'text', value: text.slice(at) })
  return out
}

/** Whether a body has anything we would linkify. Cheap guard for the renderer. */
export function hasLink(body) {
  return linkSegments(body).some((s) => s.type === 'link')
}
