// Snapchat's status glyphs.
//
// Shape encodes direction: arrows are things you SENT, squares are things you
// RECEIVED. Fill encodes state: solid = unopened, hollow = opened.
//
// The two special states are easy to mix up:
//   screenshot -> DOUBLE arrows (side by side)
//   replayed   -> a single CIRCULAR/spiral arrow, and it exists only for
//                 snaps; there is no replayed state for a chat.
export default function StatusIcon({ shape, filled, color, size = 14 }) {
  const fill = filled ? color : 'none'
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    'aria-hidden': true,
    style: { flex: '0 0 auto' },
  }

  if (shape === 'square') {
    return (
      <svg {...common}>
        <rect
          x="3.5"
          y="3.5"
          width="17"
          height="17"
          rx="3"
          stroke={color}
          strokeWidth="2.2"
          fill={fill}
        />
      </svg>
    )
  }

  if (shape === 'screenshot') {
    // Two arrows side by side.
    return (
      <svg {...common}>
        <path d="M2.5 3.5l8 8.5-8 8.5z" stroke={color} strokeWidth="2.2" fill={fill} strokeLinejoin="round" />
        <path d="M13 3.5l8 8.5-8 8.5z" stroke={color} strokeWidth="2.2" fill={fill} strokeLinejoin="round" />
      </svg>
    )
  }

  if (shape === 'replay') {
    // Circular arrow — a snap that was opened and replayed.
    return (
      <svg {...common}>
        <path
          d="M20 12a8 8 0 1 1-2.6-5.9"
          stroke={color}
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
        />
        <path d="M20.5 2.5v5.2h-5.2z" fill={color} />
      </svg>
    )
  }

  // Arrow — something you sent.
  return (
    <svg {...common}>
      <path
        d="M4 3.5l14 8.5-14 8.5z"
        stroke={color}
        strokeWidth="2.2"
        fill={fill}
        strokeLinejoin="round"
      />
    </svg>
  )
}
