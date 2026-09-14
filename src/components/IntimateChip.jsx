// The one place this feature is visible without a tap.
//
// It says "Just us" and a state, and NOTHING else — not which game, not what
// was asked, not who asked it. The conversation screen is the one surface here
// that is not behind a second tap, and a game's name sitting under the chat
// header is precisely the over-the-shoulder tell the rotating aliases exist to
// prevent. It renders only when there is something to act on, so the ordinary
// case is that this feature leaves no trace on the conversation at all.
export default function IntimateChip({ label, onOpen }) {
  if (!label) return null
  return (
    <button type="button" className="ig-chip" onClick={onOpen}>
      <span className="ig-chip-dot" aria-hidden="true" />
      {label}
    </button>
  )
}
