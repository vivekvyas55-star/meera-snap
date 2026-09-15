import { supabase } from './supabase'

// The pair's lifetime game record (202609150060_game_records.sql).
//
// The series score on a room row lasts one evening on purpose — that is what
// makes it playful. This is the other thing: a permanent count of what the two
// of you have played, derived on read from the together_events rows that
// play_game_move and play_game_path write when they decide a result. Nothing
// here stores a total, so there is no second number to drift.
//
// FOUR ANSWERS, NOT TWO. `[]` and `0` are answers and are reserved for answers;
// this layer therefore never hands the screen a bare array:
//
//   { state: 'ok',     record, breakdown }  — a real count, zeros included
//   { state: 'closed', ... }                — the pair are not both opted in
//   { state: 'failed', ... }                — we asked and do not know; say so
//   { state: 'off',    ... }                — this database has no game record
//                                             at all; show none of the section
//
// The last two must not be conflated. Hiding the section on a flaky network is
// itself a failure rendered as an answer, and "you have played nothing" said to
// somebody who has played forty games is the bug this codebase has found seven
// times.

// PostgREST answers PGRST202 for a function it cannot find — and, per
// CLAUDE.md, for a mismatched argument SIGNATURE too, which is why both calls
// below pass the parameter NAME the migration declares (`other`) exactly.
export function featureMissing(error) {
  const code = error?.code ?? ''
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return true
  const message = error?.message ?? ''
  return /together_game_record|together_game_breakdown|together_events/.test(message)
    && /does not exist|not find|schema cache/i.test(message)
}

export async function fetchGameRecord(otherId) {
  const { data, error } = await supabase.rpc('together_game_record', { other: otherId })
  if (error) throw error
  // One row whenever the pair are both opted in, zeros and all. No row is a
  // different sentence — the shared surface is closed — and the caller says so.
  return data?.[0] ?? null
}

export async function fetchGameBreakdown(otherId) {
  const { data, error } = await supabase.rpc('together_game_breakdown', { other: otherId })
  if (error) throw error
  return data ?? []
}

export async function loadGameRecord(otherId) {
  try {
    const [record, breakdown] = await Promise.all([
      fetchGameRecord(otherId),
      fetchGameBreakdown(otherId),
    ])
    if (!record) return { state: 'closed', record: null, breakdown: [] }
    return { state: 'ok', record, breakdown }
  } catch (err) {
    return { state: featureMissing(err) ? 'off' : 'failed', record: null, breakdown: null }
  }
}
