// The four glyphs Snapchat uses in the chat list, drawn as SVG so they stay
// crisp and can be tinted per message type.
export default function StatusIcon({ shape, filled, color, size = 14 }) {
  const stroke = { stroke: color, strokeWidth: 2, fill: filled ? color : 'none' }
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true }

  if (shape === 'square') {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2.5" {...stroke} />
      </svg>
    )
  }

  if (shape === 'replay') {
    // Two nested arrows: the snap was opened and then replayed.
    return (
      <svg {...common}>
        <path d="M3 4l8 8-8 8z" {...stroke} />
        <path d="M12 4l8 8-8 8z" {...stroke} />
      </svg>
    )
  }

  if (shape === 'screenshot') {
    // Overlapping offset arrows — Snapchat's screenshot marker.
    return (
      <svg {...common}>
        <path d="M4 3l8 9-8 9z" {...stroke} />
        <path d="M12 3l8 9-8 9z" stroke={color} strokeWidth="2" fill="none" />
      </svg>
    )
  }

  // Default: arrow (something you sent)
  return (
    <svg {...common}>
      <path d="M5 3l14 9-14 9z" {...stroke} />
    </svg>
  )
}
