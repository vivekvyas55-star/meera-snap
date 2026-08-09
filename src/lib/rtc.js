// WebRTC ICE servers. STUN discovers your public address (works for calls on
// the same network or permissive NATs). TURN relays media when a direct peer
// connection can't be made (common on mobile/carrier networks). OpenRelay is a
// free, no-signup public TURN — fine for an MVP; swap in a dedicated TURN
// provider (Metered, Cloudflare, self-hosted coturn) for production reliability.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

export const rtcSupported =
  typeof RTCPeerConnection !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia
