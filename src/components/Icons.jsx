// Thin-stroke geometric line icons, matching the reference's icon set.
// All are drawn on a 24px grid with a 1.6px stroke and no fills.
const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export const ChatIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5z" />
  </svg>
)

export const CameraIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.1-1.8h6.4L15.8 6h2.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
    <circle cx="12" cy="12.2" r="3.4" />
  </svg>
)

export const StoriesIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" />
  </svg>
)

export const PlusIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const BackIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
)

export const ArrowIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)

export const CloseIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const FlipIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M20 11a8 8 0 0 0-13.7-5.3L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 13.7 5.3L20 16" />
    <path d="M20 20v-4h-4" />
  </svg>
)

export const CheckIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)

export const PowerIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 4v8" />
    <path d="M7.5 7a7 7 0 1 0 9 0" />
  </svg>
)

export const SmileyIcon = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </svg>
)

export const MicIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </svg>
)

export const PlayIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M8 5l11 7-11 7z" />
  </svg>
)

export const ImageIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9" r="1.6" />
    <path d="M4 17l4.5-4.5 3 3L15 11l5 5" />
  </svg>
)

export const PhoneIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M6.5 4h3l1.4 3.6-1.8 1.3a10.5 10.5 0 0 0 4.9 4.9l1.3-1.8L19 13.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />
  </svg>
)

export const VideoIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="3" y="6.5" width="12" height="11" rx="2.4" />
    <path d="M15 10.2l5.5-2.7v9l-5.5-2.7z" />
  </svg>
)

export const VideoOffIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="3" y="6.5" width="12" height="11" rx="2.4" />
    <path d="M15 10.2l5.5-2.7v9l-5.5-2.7z" />
    <path d="M4 4l16 16" />
  </svg>
)

export const MicOffIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
    <path d="M4 4l16 16" />
  </svg>
)

// Phone handset rotated to the universal "hang up" pose.
export const HangupIcon = (p) => (
  <svg {...base} {...p}>
    <g transform="rotate(133 12 12)">
      <path d="M6.5 4h3l1.4 3.6-1.8 1.3a10.5 10.5 0 0 0 4.9 4.9l1.3-1.8L19 13.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />
    </g>
  </svg>
)

export const SpeakerIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4 9v6h3.5L13 19V5L7.5 9z" />
    <path d="M16.5 9.2a4 4 0 0 1 0 5.6" />
    <path d="M19 6.7a7.5 7.5 0 0 1 0 10.6" />
  </svg>
)

export const MapIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z" />
    <circle cx="12" cy="11" r="2.2" />
  </svg>
)
