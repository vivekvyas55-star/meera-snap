import { describe, expect, it, vi } from 'vitest'

// The pair's lifetime game record, client half.
//
// The durable rows live in together_events and the totals are DERIVED from them
// on read — there is no stored aggregate anywhere, deliberately, so there is no
// second number that can drift from the rows under it. What is pinned here is
// the other half of that: how the derived numbers are read, and the four states
// this layer answers in. `[]` and `0` are answers. "We could not read your
// record" and "you have played nothing" are different sentences, and this
// codebase has now found ten bugs that conflated a pair of them.

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc },
  emailForUsername: (u) => `${u}@meera.local`,
}))

const { featureMissing, loadGameRecord } = await import('../src/lib/gameRecord')
const {
  gameBreakdownRows, gameRecordTotals, gameTitle, longestRun,
} = await import('../src/lib/togetherState')

const RECORD = {
  games: 12, my_wins: 5, their_wins: 4, draws: 3,
  run_best: 3, run_mine: true,
  first_at: '2026-01-01T00:00:00Z', last_at: '2026-09-01T00:00:00Z',
}

describe('the totals', () => {
  it('reads the counts the server pinned to the caller', () => {
    expect(gameRecordTotals(RECORD)).toEqual({ games: 12, mine: 5, theirs: 4, drawn: 3 })
  })

  it('answers null for a record that is not there, never a row of zeros', () => {
    // A zero is an answer — "the two of you have finished nothing" — and giving
    // it for a record we never received is the bug class this app keeps finding.
    expect(gameRecordTotals(null)).toBe(null)
    expect(gameRecordTotals(undefined)).toBe(null)
  })

  it('treats a missing, negative or unreadable count as zero rather than NaN', () => {
    expect(gameRecordTotals({ games: '7', my_wins: null, their_wins: -3, draws: 'x' }))
      .toEqual({ games: 7, mine: 0, theirs: 0, drawn: 0 })
  })
})

describe('the per-game breakdown', () => {
  it('names the three games from the one place they are named', () => {
    expect(gameTitle('ttt')).toBe('Tic-Tac-Toe')
    expect(gameTitle('c4')).toBe('Connect Four')
    expect(gameTitle('checkers')).toBe('Checkers')
  })

  it('degrades a game this bundle has never heard of rather than printing a code', () => {
    // A database one migration ahead of the phone is the normal state for a few
    // minutes after every deploy, exactly as a thread event handles it.
    expect(gameTitle('ludo')).toBe('A game')
    expect(gameTitle(undefined)).toBe('A game')
  })

  it('drops a game with nothing recorded instead of drawing a row of zeros', () => {
    const rows = gameBreakdownRows([
      { game: 'ttt', games: 4, my_wins: 2, their_wins: 1, draws: 1 },
      { game: 'c4', games: 0, my_wins: 0, their_wins: 0, draws: 0 },
    ])
    expect(rows.map((r) => r.game)).toEqual(['ttt'])
    expect(rows[0]).toMatchObject({ title: 'Tic-Tac-Toe', games: 4, mine: 2, theirs: 1, drawn: 1 })
  })

  it('returns an empty list for anything that is not a list, and never throws', () => {
    expect(gameBreakdownRows(null)).toEqual([])
    expect(gameBreakdownRows(undefined)).toEqual([])
    expect(gameBreakdownRows([null, undefined])).toEqual([])
  })
})

describe('the longest run', () => {
  it('reads the run and whose it is', () => {
    expect(longestRun(RECORD)).toEqual({ count: 3, mine: true })
    expect(longestRun({ ...RECORD, run_mine: false })).toEqual({ count: 3, mine: false })
  })

  it('is not drawn for a run of one, which is a game rather than a run', () => {
    expect(longestRun({ ...RECORD, run_best: 1 })).toBe(null)
    expect(longestRun({ ...RECORD, run_best: 0 })).toBe(null)
  })

  it('is not drawn when the database could not say whose it was', () => {
    // Guessing is worse than saying nothing: the line names a person.
    expect(longestRun({ ...RECORD, run_mine: null })).toBe(null)
    expect(longestRun({ run_best: 4 })).toBe(null)
    expect(longestRun(null)).toBe(null)
  })
})

describe('the four states', () => {
  it('answers ok with the record and the breakdown', async () => {
    rpc.mockImplementation(async (name) => ({
      data: name === 'together_game_record' ? [RECORD] : [{ game: 'ttt', games: 12 }],
      error: null,
    }))
    const answer = await loadGameRecord('friend')
    expect(answer.state).toBe('ok')
    expect(answer.record.games).toBe(12)
    expect(answer.breakdown).toHaveLength(1)
  })

  it('calls both RPCs by the parameter NAME the migration declares', async () => {
    // PostgREST answers PGRST202 for a mismatched argument signature as readily
    // as for a missing function, so a renamed parameter reads as "this database
    // does not have the feature" and the section silently disappears.
    rpc.mockResolvedValue({ data: [], error: null })
    await loadGameRecord('friend-1')
    expect(rpc).toHaveBeenCalledWith('together_game_record', { other: 'friend-1' })
    expect(rpc).toHaveBeenCalledWith('together_game_breakdown', { other: 'friend-1' })
  })

  it('answers closed — not ok with zeros — when the pair are not both opted in', async () => {
    // The RPC returns NO ROW in that case, which is a different sentence from a
    // row of zeros, and the aggregate always produces a row when it is open.
    rpc.mockResolvedValue({ data: [], error: null })
    expect((await loadGameRecord('friend')).state).toBe('closed')
  })

  it('answers off for a database that does not have the migration', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const answer = await loadGameRecord('friend')
    expect(answer.state).toBe('off')
    expect(answer.record).toBe(null)
  })

  it('answers failed — never off — when the read simply did not come back', async () => {
    // Hiding a section because the network flapped is itself a failure rendered
    // as an answer, and the one it renders is "you have played nothing".
    rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } })
    expect((await loadGameRecord('friend')).state).toBe('failed')
    rpc.mockRejectedValue(new Error('network down'))
    expect((await loadGameRecord('friend')).state).toBe('failed')
  })

  it('knows the shapes a missing function arrives in, and nothing else', () => {
    expect(featureMissing({ code: 'PGRST202' })).toBe(true)
    expect(featureMissing({ code: '42883' })).toBe(true)
    expect(featureMissing({ message: 'relation "together_events" does not exist' })).toBe(true)
    expect(featureMissing({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(featureMissing({ message: 'Failed to fetch' })).toBe(false)
    expect(featureMissing(null)).toBe(false)
  })
})
