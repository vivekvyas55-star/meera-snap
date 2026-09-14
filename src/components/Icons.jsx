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

// A die, not a media triangle: PlayIcon is the ▶ used on video thumbnails, and
// reusing it for "play a game together" reads as "play this video". Pips are
// dots on the same 24px grid, so it holds up at 20px in the chat header.
export const GameIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <circle cx="8.75" cy="8.75" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15.25" cy="15.25" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15.25" cy="8.75" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="8.75" cy="15.25" r="1.15" fill="currentColor" stroke="none" />
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

export const LockIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </svg>
)

export const BackspaceIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7 6-7z" />
    <path d="M17 9.5l-5 5M12 9.5l5 5" />
  </svg>
)

export const ReplyIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M9 7L4 12l5 5" />
    <path d="M4 12h9a6 6 0 0 1 6 6v1" />
  </svg>
)

export const ForwardIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M15 7l5 5-5 5" />
    <path d="M20 12h-9a6 6 0 0 0-6 6v1" />
  </svg>
)

export const SaveIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 4v10" />
    <path d="M8 10.5l4 4 4-4" />
    <path d="M5 18.5h14" />
  </svg>
)

export const PauseIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M9.5 5.5v13M14.5 5.5v13" />
  </svg>
)

export const ReplayIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
    <path d="M20 4v4h-4" />
  </svg>
)

export const FlameIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3.5s5.5 4 5.5 8.5a5.5 5.5 0 0 1-11 0c0-1.6.8-3 1.7-4.1.3 1 1 1.8 1.8 1.8 1.2 0 1.6-1.2 1.4-2.6-.2-1.5.6-2.9.6-3.6z" />
  </svg>
)

export const HeartIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 19.5S4.5 14.8 4.5 9.8A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7.5 1.8c0 5-7.5 9.7-7.5 9.7z" />
  </svg>
)

export const CalendarIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="5.5" width="17" height="15" rx="3" />
    <path d="M3.5 10h17M8.5 3.5v4M15.5 3.5v4" />
  </svg>
)

export const GridIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </svg>
)

export const BellIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3 .8 4.4 1.5 5.2H5c.7-.8 1.5-2.2 1.5-5.2z" />
    <path d="M10 18.5a2 2 0 0 0 4 0" />
  </svg>
)

export const ChevronIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M9.5 5l7 7-7 7" />
  </svg>
)

export const NoteIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 17 15H9.5L5.5 18.5V15A2.5 2.5 0 0 1 4.5 12.5z" />
  </svg>
)

export const UsersIcon = (p) => (
  <svg {...base} {...p}>
    <circle cx="9.5" cy="8.5" r="3.2" />
    <path d="M3.5 19a6 6 0 0 1 12 0" />
    <path d="M16 5.6a3.2 3.2 0 0 1 0 5.8" />
    <path d="M17.5 14.4a6 6 0 0 1 3 4.6" />
  </svg>
)

// Credit meter. Two concentric rings — a plain token, not a currency glyph.
// Credits are not rupees and the icon should not imply they convert to any.
export const CoinIcon = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
  </svg>
)

// --------------------------------------------------------------------------
// Privacy Centre. Added for Profile's six sections, which had been leaning on
// text alone — same 24px grid and 1.6px stroke as everything above.
// --------------------------------------------------------------------------

export const KeyIcon = (p) => (
  <svg {...base} {...p}>
    <circle cx="8.4" cy="15.6" r="3.6" />
    <path d="M10.9 13.1L19.5 4.5" />
    <path d="M16.4 7.6l2.2 2.2" />
    <path d="M14.1 9.9l2.2 2.2" />
  </svg>
)

export const ShieldIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3.4l7 2.5v5.3c0 4.1-2.8 7.3-7 9.4-4.2-2.1-7-5.3-7-9.4V5.9z" />
  </svg>
)

export const AlertIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 4.4l8.6 14.9H3.4z" />
    <path d="M12 10.2v4" />
    <path d="M12 16.9h.01" />
  </svg>
)

export const DownloadIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 4v10.5" />
    <path d="M7.8 10.6L12 14.8l4.2-4.2" />
    <path d="M4.8 19.2h14.4" />
  </svg>
)

export const TrashIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4.8 7h14.4" />
    <path d="M9.6 7V5.4A1.4 1.4 0 0 1 11 4h2a1.4 1.4 0 0 1 1.4 1.4V7" />
    <path d="M6.8 7l.8 11.1A1.9 1.9 0 0 0 9.5 20h5a1.9 1.9 0 0 0 1.9-1.8L17.2 7" />
  </svg>
)

export const DeviceIcon = (p) => (
  <svg {...base} {...p}>
    <rect x="7.2" y="3.2" width="9.6" height="17.6" rx="2.4" />
    <path d="M10.7 17.9h2.6" />
  </svg>
)

export const LayersIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3.8l8 3.6-8 3.6-8-3.6z" />
    <path d="M4 12l8 3.6 8-3.6" />
    <path d="M4 16.4L12 20l8-3.6" />
  </svg>
)

export const GamepadIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M7.4 7.2h9.2a4.1 4.1 0 0 1 4 3.2l.8 3.9a3.1 3.1 0 0 1-5.5 2.6l-.9-1.1H8.9L8 16.9a3.1 3.1 0 0 1-5.5-2.6l.8-3.9a4.1 4.1 0 0 1 4.1-3.2z" />
    <path d="M6.4 10.6v3.2M4.8 12.2H8" />
    <path d="M15.4 11.4h.01M17.6 13.4h.01" />
  </svg>
)

// Biometric unlock. Two glyphs rather than one, picked by platform in
// lib/biometric.js: a fingerprint next to the words "Face ID" is the kind of
// small wrongness that makes a screen feel like it was not looked at.
export const FingerprintIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4.3 9.3A9 9 0 0 1 12 4.8a9 9 0 0 1 4.8 1.4" />
    <path d="M4.6 15.8a9 9 0 0 1-.3-2.4V13" />
    <path d="M18.8 8.9a9 9 0 0 1 .9 4v1.6a15 15 0 0 1-.4 3.2" />
    <path d="M6.6 13a5.4 5.4 0 0 1 9.8-3.2" />
    <path d="M17.4 12.6V14a17 17 0 0 1-.6 4.4" />
    <path d="M7.4 18.5a11 11 0 0 0 1.1-4.5V13a3.5 3.5 0 0 1 6.5-1.8" />
    <path d="M14.6 14.2a19 19 0 0 1-.7 5.3" />
    <path d="M11.6 19.6a17 17 0 0 0 .4-3.6" />
  </svg>
)

export const FaceIdIcon = (p) => (
  <svg {...base} {...p}>
    <path d="M4.6 8.6V6.9a2.3 2.3 0 0 1 2.3-2.3h1.7" />
    <path d="M15.4 4.6h1.7a2.3 2.3 0 0 1 2.3 2.3v1.7" />
    <path d="M19.4 15.4v1.7a2.3 2.3 0 0 1-2.3 2.3h-1.7" />
    <path d="M8.6 19.4H6.9a2.3 2.3 0 0 1-2.3-2.3v-1.7" />
    <path d="M9.2 9.9v1.6M14.8 9.9v1.6" />
    <path d="M12 9.9v3.4h-1.1" />
    <path d="M9.4 15.4a3.7 3.7 0 0 0 5.2 0" />
  </svg>
)
