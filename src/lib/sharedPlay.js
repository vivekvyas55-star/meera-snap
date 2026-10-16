import { supabase } from './supabase'

export const SHARED_GAMES = {
  island: { title: 'Postcard Island', icon: '✉', detail: 'Live co-op. Explore a tiny island, deliver five letters and open the lighthouse together.' },
  pick: { title: 'Guess My Pick', icon: '↔', detail: 'Two choices. One secret pick. How well do they know you?', prompt: 'What would I pick for a surprise evening?' },
  emoji: { title: 'Emoji Decoder', icon: '☺', detail: 'Make an emoji clue for a film, food or place. They get one guess.', prompt: '🍕🌙🎬' },
  word: { title: 'Word Rally', icon: 'Aa', detail: 'Start with the last letter. Reach 12 words together, with no repeats.', prompt: 'spark' },
  story: { title: 'Story Relay', icon: '✎', detail: 'Eight sentences, two imaginations. Take turns making it wonderfully strange.', prompt: 'A tiny dragon arrived at the door holding our takeaway.' },
}
export const titleFor = row => row.kind === 'date' ? 'Date jar' : SHARED_GAMES[row.kind]?.title || 'Shared activity'
export const isPendingFor = (row, me) => row.status === 'pending' ? row.creator !== me : row.status === 'active' && row.turn === me
export function activityLabel(row, me) {
  if (row.status === 'dismissed') return 'Passed · no pressure'
  if (row.status === 'done') return row.kind === 'date' ? 'You both like this · choose a time in chat' : 'Finished together'
  if (row.kind === 'date') return (row.data.likes || []).includes(me) ? 'Waiting for their interest' : 'Would you like to try this?'
  if (row.status === 'pending') return row.creator === me ? 'Invitation sent · they can join later' : 'Invited you · join when you’re free'
  if (row.kind === 'island') return 'Island ready · both can explore together'
  return row.turn === me ? 'Your turn' : 'Their turn · come back whenever'
}
async function rpc(name, args) { const { data, error } = await supabase.rpc(name, args); if (error) throw error; return data }
export const listSharedPlay = other => rpc('shared_play_list', { other })
export const createSharedPlay = (other, game, body, requestId) => rpc('shared_play_create', { other, game, body, request_id: requestId })
export const actSharedPlay = (row, action, value, requestId) => rpc('shared_play_act', { activity: row.id, expected_revision: row.revision, action, value, request_id: requestId })
