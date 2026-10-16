import { supabase } from './supabase'

// Credentials are absent from the public JS bundle. Only accepted, unblocked
// friends can request them. TURN credentials do reach participating browsers,
// as WebRTC requires; they are not an administrative Metered API key.
export async function getIceServers(peer) {
  const { data, error } = await supabase.rpc('get_call_ice', { peer }).abortSignal(AbortSignal.timeout(8000))
  if (error || !Array.isArray(data) || !data.some(s => [s.urls].flat().some(url => /^turns?:/.test(url)))) {
    throw new Error('Call connection service is unavailable. Please try again.')
  }
  return data
}

export const rtcSupported =
  typeof RTCPeerConnection !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia
