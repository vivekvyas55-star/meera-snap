import { supabase } from './supabase'
import { ephemeralSignedUrl, uploadIntimatePhoto } from './db'
import { photoUrlTtl } from './relationshipGames'

// The calls behind the five intimate games. Every mutation goes through a
// SECURITY DEFINER RPC — intimate_sessions has no insert/update/delete grant
// and intimate_rounds has no grants at all, so there is no second way in.
//
// Two rules run through this file:
//
//   * A FAILURE IS NEVER AN ANSWER. Every function here either resolves with
//     something true or rejects. `null` from getSession means "there is no live
//     session", which is an answer the server gave; a network error rejects.
//     Callers must not .catch(() => null) any of it — CLAUDE.md lists seven
//     bugs of exactly that shape, and on this surface a wrong "they ended it"
//     or a wrong "nothing here" is worse than most of them.
//
//   * The migration is SHELVED (supabase/migrations/.unapplied). Until it is
//     applied every RPC answers PGRST202, and the feature has to simply not
//     offer itself rather than error. featureMissing() is how a caller tells
//     that apart from a connection that dropped — which is a distinction with
//     teeth, because hiding the feature on a flaky network is itself a failure
//     rendered as an answer.

// PostgREST answers a call to a function it cannot find with PGRST202. It also
// answers PGRST202 for a mismatched argument SIGNATURE, which is why every call
// below passes the parameter NAMES from 0026 exactly.
export function featureMissing(error) {
  if (!error) return false
  if (error.code === 'PGRST202') return true
  return /schema cache|could not find the function|does not exist/i.test(error.message ?? '')
}

// The live session for this pair, if there is one, plus whose turn it is.
// Resolves null when there is none — that is an answer, not a failure.
export async function getSession(other) {
  const { data, error } = await supabase.rpc('intimate_session_with', { other })
  if (error) throw error
  return (data ?? [])[0] ?? null
}

// The rounds of a session, with the reveal rule already applied server-side:
// answer_key and secret_truth come back only to whoever wrote them or once the
// round is closed, and media_path NEVER comes back at all.
export async function listRounds(sessionId) {
  const { data, error } = await supabase.rpc('intimate_rounds_of', { sess: sessionId })
  if (error) throw error
  return data ?? []
}

// Opening one is idempotent: a live room is handed back rather than a second
// one opened, which is also how the invited person lands on the room to join.
export async function startSession(other, gameCode) {
  const { data, error } = await supabase.rpc('start_intimate_session', { other, game_code: gameCode })
  if (error) throw error
  return data
}

// The second opt-in. Only the person who did NOT open it can give it, which is
// what makes "both of you opted in" a fact rather than a rendering.
export async function joinSession(sessionId) {
  const { data, error } = await supabase.rpc('join_intimate_session', { sess: sessionId })
  if (error) throw error
  return data
}

// Either person, at any point, from any state, idempotent. The REASON is
// derived by the database, never passed in: an invitation closed without being
// joined is 'declined', anything after that is 'left'. Letting the client name
// it would make the distinction a claim.
export async function endSession(sessionId) {
  const { data, error } = await supabase.rpc('end_intimate_session', { sess: sessionId })
  if (error) throw error
  return data
}

// Why this reads the table directly rather than through an RPC:
// intimate_session_with() only returns a LIVE session, so the moment one ends
// it vanishes from it — and "gone" cannot tell 'declined' from 'left' from
// 'expired'. The row itself stays readable to both people (intimate_sessions
// has a select grant and intimate_sessions_read) until it expires, so this is
// the only way to learn which of the three actually happened.
//
// It resolves null when the row is genuinely not readable any more, which the
// caller must treat as "we do not know" rather than as a reason.
export async function getSessionRow(sessionId) {
  const { data, error } = await supabase
    .from('intimate_sessions')
    .select('id,game,opened_by,joined_by,status,ended_by,ended_reason,created_at,expires_at,user_a,user_b')
    .eq('id', sessionId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

// Starter prompts. These are STARTERS, not the feature — the custom path is
// primary on every screen — so a failure here resolves null ("we could not get
// any") and the UI renders nothing rather than an empty list that would read as
// "there are none".
export async function promptIdeas(gameCode, wanted = 3) {
  const { data, error } = await supabase.rpc('intimate_prompt_ideas', { game_code: gameCode, wanted })
  if (error) throw error
  return data ?? []
}

export async function poseRound(sessionId, { prompt, optionB, mediaPath, answerKey, secretTruth } = {}) {
  const { data, error } = await supabase.rpc('pose_intimate_round', {
    sess: sessionId,
    prompt: prompt?.trim() || null,
    option_b: optionB?.trim() || null,
    media_path: mediaPath || null,
    answer_key: answerKey?.trim() || null,
    secret_truth: secretTruth === true || secretTruth === false ? secretTruth : null,
  })
  if (error) throw error
  return data
}

export async function respondRound(roundId, { pick, response } = {}) {
  const { data, error } = await supabase.rpc('respond_intimate_round', {
    round_id: roundId,
    pick: pick || null,
    response: response?.trim() || null,
  })
  if (error) throw error
  return data
}

// Passing takes no reason and writes no counter. There is deliberately nothing
// here to record why, and nothing that accumulates when it happens — a dare
// game whose "no" costs something is a dare game that coerces. Do not add an
// argument to this function.
export async function passTurn(sessionId) {
  const { data, error } = await supabase.rpc('pass_intimate_turn', { sess: sessionId })
  if (error) throw error
  return data
}

// The ONLY route to a game photo's bytes.
//
// open_intimate_photo() stamps the round and pulls the object's cleanup entry
// forward; the path it returns is not a url and cannot be re-derived from
// anything intimate_rounds_of() hands back. The url is then minted for what is
// left of the two-minute window and NOT cached — see ephemeralSignedUrl in
// db.js for why the app's normal per-path cache is wrong here.
//
// The caller must drop the returned url when the viewer closes. It is never
// stored, never re-requested, and never handed to anything that persists.
export async function openPhoto(round) {
  const { data, error } = await supabase.rpc('open_intimate_photo', { round_id: round.id })
  if (error) throw error
  if (!data) throw new Error('There is no photo here')
  return ephemeralSignedUrl(data, photoUrlTtl(round))
}

export { uploadIntimatePhoto }
