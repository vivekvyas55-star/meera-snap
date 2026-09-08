// The spelled-out game state, under the chat header.
//
// It renders only when a game actually exists; the small die in the header is
// the entry point the rest of the time. State comes from usePlayState so the
// button and this chip cannot drift a poll apart and disagree on screen about
// whose turn it is.
export default function PlayChip({ state, room, onOpenPlay }) {
  return (
    <button
      type="button"
      className={`play-chip play-${state.key}`}
      onClick={() => onOpenPlay(room)}
    >
      <span className="play-chip-dot" aria-hidden="true" />
      {state.label}
    </button>
  )
}
