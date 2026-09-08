// The one signal a chat-list row is allowed to show. The decision is in
// lib/rowSignal.js; this only paints it.
export default function RowSignal({ signal }) {
  if (!signal) return null
  return (
    <span className={`row-signal ${signal.tone} sig-${signal.kind}`} title={signal.label}>
      {/* The visible text is abbreviated to fit a 320px row, so the readable
          version rides alongside it rather than replacing it. */}
      <span aria-hidden="true">{signal.text}</span>
      <span className="sr-only">{signal.label}</span>
    </span>
  )
}
