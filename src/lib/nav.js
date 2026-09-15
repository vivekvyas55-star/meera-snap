// The five slots in the tab bar, and the three panes behind them.
//
// Meera grew to thirteen screens behind three tabs, and everything built after
// the pager — Together, Play, the solo games, Memories, Snap Map, Billing —
// hung off Profile until Profile was a catch-all menu six groups deep. The bar
// is now five slots wide. The PAGER is still three.
//
// That distinction is load-bearing, not an implementation detail. The pager
// pages three panes with one CSS transform and the camera sits in the MIDDLE —
// Snapchat's grammar, which the whole capture flow is built around (a sent snap
// returns you left to Chat, the Stories pane's + sends you right to Camera).
// Five panes would put Camera off-centre and make "swipe right from Stories"
// land on a settings screen. So the last two slots are OVERLAYS: they cover the
// shell the way Chat, Profile and Snap Map already do.
//
// The bar order mirrors the physical swipe order, so swiping and tapping agree
// about where things are: pane tabs first, in pane order, then the overlays.

/**
 * @typedef {object} Tab
 * @property {string} key      stable id, used for React keys and tests
 * @property {string} label    the word on the bar — see the 320px note below
 * @property {'pane'|'overlay'} kind
 * @property {number} [pane]   index into the pager, for kind 'pane'
 * @property {string} [overlay] which overlay to open, for kind 'overlay'
 */

// The fourth slot's name is "Us".
//
// It is the pair layer: Together, Play, and "Just us" — everything that is
// about two people rather than about you or about the world. The name is
// defensible on three counts, and it lives HERE so it can be changed in one
// place if the owner prefers another:
//
//   1. Two characters. Five labelled tabs at 320px leave about 51px per slot
//      and "Camera", "Stories" and "Profile" all want most of it; the fourth
//      label is the only place in the bar with slack to give back.
//   2. It is already the app's own word for this. The intimate-games chip in a
//      conversation says "Just us", and nothing had to be invented to match it.
//   3. It does not collide with "Together", which is ONE SCREEN INSIDE this
//      tab. Naming the tab "Together" would have made the tab and its own first
//      row the same word.
//
// Rejected: "Together" (collides, and is seven characters), "Pair" (a database
// word, not a human one), "Ours" (reads as possession, not as a place).
export const TABS = Object.freeze([
  { key: 'chat', label: 'Chats', kind: 'pane', pane: 0 },
  { key: 'camera', label: 'Camera', kind: 'pane', pane: 1 },
  { key: 'stories', label: 'Stories', kind: 'pane', pane: 2 },
  { key: 'us', label: 'Us', kind: 'overlay', overlay: 'us' },
  { key: 'profile', label: 'Profile', kind: 'overlay', overlay: 'profile' },
])

/** The tabs that select a pager pane, in pane order. */
export const PANE_TABS = Object.freeze(
  TABS.filter((t) => t.kind === 'pane').sort((a, b) => a.pane - b.pane)
)

/** The tabs that open a full-screen overlay over the shell. */
export const OVERLAY_TABS = Object.freeze(TABS.filter((t) => t.kind === 'overlay'))

/**
 * Which tab is lit. An overlay wins over the pane underneath it, because the
 * pane is display:none'd while an overlay is open — saying "you are on Chats"
 * while Profile covers the screen would be false.
 */
export function activeTabKey(pane, overlay) {
  if (overlay) return TABS.find((t) => t.overlay === overlay)?.key ?? null
  return PANE_TABS.find((t) => t.pane === pane)?.key ?? null
}
