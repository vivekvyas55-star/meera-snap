import { beforeEach, describe, expect, it, vi } from 'vitest'

// Scheduled messages, client half. Two things are worth pinning here and both
// have bitten this codebase before:
//
//   1. THE WALL CLOCK. The picker deals in an IST calendar date and an HH:MM,
//      and never in an instant derived from the device. A status note written
//      from a skewed client clock was invisible forever for want of that rule.
//   2. THE THREE STATES. A failed "what do I have scheduled?" must never read
//      as "nothing" — that is the seventh instance of the same bug this
//      codebase keeps finding, and here someone acts on it by scheduling the
//      message twice.

const { builder, rpc } = vi.hoisted(() => {
  const state = { result: { data: [], error: null } }
  const chain = {
    select: () => chain,
    order: () => chain,
    eq: () => chain,
    delete: () => chain,
    then: (resolve) => Promise.resolve(state.result).then(resolve),
  }
  return {
    builder: { chain, state, from: vi.fn(() => chain) },
    rpc: vi.fn(async () => ({ data: [{ id: 's-1' }], error: null })),
  }
})

vi.mock('../src/lib/supabase', () => ({
  supabase: { from: builder.from, rpc },
  emailForUsername: (u) => `${u}@meera.local`,
}))

const {
  HORIZON_DAYS, MAX_PENDING,
  addDays, clockLabel, dayLabel, featureMissing, horizonDates,
  istNow, loadScheduled, scheduleMessage, sendAtLabel, validateSchedule,
} = await import('../src/lib/scheduled')

beforeEach(() => {
  builder.state.result = { data: [], error: null }
})

describe('the IST wall clock', () => {
  it('reads the date and time in Asia/Kolkata whatever the device is set to', () => {
    // 2026-09-15T20:00:00Z is 2026-09-16 01:30 IST — a different DAY.
    const at = new Date('2026-09-15T20:00:00Z')
    expect(istNow(at)).toEqual({ date: '2026-09-16', time: '01:30' })
  })

  it('renders midnight as 00:00, not 24:00', () => {
    // 18:30Z is exactly midnight IST, which some engines format as hour 24.
    expect(istNow(new Date('2026-09-15T18:30:00Z'))).toEqual({ date: '2026-09-16', time: '00:00' })
  })

  it('does calendar arithmetic in UTC so the browser zone cannot shift a day', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('offers today plus exactly the horizon, and no more', () => {
    const days = horizonDates('2026-09-15')
    expect(days).toHaveLength(HORIZON_DAYS + 1)
    expect(days[0]).toBe('2026-09-15')
    expect(days.at(-1)).toBe('2026-09-22')
  })
})

describe('labels', () => {
  it('names the first two days rather than dating them', () => {
    expect(dayLabel('2026-09-15', '2026-09-15')).toBe('Today')
    expect(dayLabel('2026-09-16', '2026-09-15')).toBe('Tomorrow')
  })

  it('spells the month itself rather than asking Intl', () => {
    // Intl.DateTimeFormat(_, { month: 'short' }) is 'Sept' on ICU 72+ and 'Sep'
    // before it. The same message must not read differently on two phones.
    expect(dayLabel('2026-09-18', '2026-09-15')).toBe('18 Sep')
    expect(dayLabel('2026-12-01', '2026-11-27')).toBe('1 Dec')
  })

  it('renders a 24h time as a clock a person reads', () => {
    expect(clockLabel('09:00')).toBe('9:00 am')
    expect(clockLabel('00:05')).toBe('12:05 am')
    expect(clockLabel('12:00')).toBe('12:00 pm')
    expect(clockLabel('21:30')).toBe('9:30 pm')
    expect(clockLabel(undefined)).toBe('')
  })

  it('reads a stored send_at back in IST, not in the browser zone', () => {
    // 2026-09-16T03:30:00Z is 09:00 IST on the 16th.
    expect(sendAtLabel('2026-09-16T03:30:00Z', '2026-09-15')).toBe('Tomorrow at 9:00 am')
  })
})

describe('validateSchedule', () => {
  const now = { date: '2026-09-15', time: '10:00' }

  it('accepts a time inside the window', () => {
    expect(validateSchedule({ body: 'hi', date: '2026-09-16', time: '09:00', now })).toBeNull()
  })

  it('refuses a time that has already passed', () => {
    expect(validateSchedule({ body: 'hi', date: '2026-09-15', time: '09:00', now }))
      .toMatch(/at least a minute/)
  })

  it('refuses a time inside the next minute, because the round trip eats it', () => {
    // By the time the request lands, the server's now() has moved on; a value
    // chosen for thirty seconds out arrives in the past and bounces off a
    // constraint instead of being refused where the user can see why.
    expect(validateSchedule({ body: 'hi', date: '2026-09-15', time: '10:00', now }))
      .toMatch(/at least a minute/)
    expect(validateSchedule({ body: 'hi', date: '2026-09-15', time: '10:01', now })).toBeNull()
  })

  it('enforces the horizon as 7 x 24h, not "the end of the seventh day"', () => {
    expect(validateSchedule({ body: 'hi', date: '2026-09-22', time: '10:00', now })).toBeNull()
    expect(validateSchedule({ body: 'hi', date: '2026-09-22', time: '10:01', now }))
      .toMatch(/7 days/)
  })

  it('refuses an empty message and an over-long one', () => {
    expect(validateSchedule({ body: '   ', date: '2026-09-16', time: '09:00', now }))
      .toMatch(/Write something/)
    expect(validateSchedule({ body: 'x'.repeat(2001), date: '2026-09-16', time: '09:00', now }))
      .toMatch(/longer than/)
  })

  it('refuses a half-filled picker rather than guessing', () => {
    expect(validateSchedule({ body: 'hi', date: '', time: '09:00', now })).toMatch(/Pick a day/)
  })
})

describe('loadScheduled keeps a failure and an empty list apart', () => {
  it('reports an answer as an answer', async () => {
    builder.state.result = { data: [{ id: 's-1', send_at: '2026-09-16T03:30:00Z' }], error: null }
    expect(await loadScheduled('me', 'them')).toEqual({
      state: 'ok', rows: [{ id: 's-1', send_at: '2026-09-16T03:30:00Z' }],
    })
  })

  it('reports an empty list as an answer too — that much is honest', async () => {
    builder.state.result = { data: [], error: null }
    expect(await loadScheduled('me', 'them')).toEqual({ state: 'ok', rows: [] })
  })

  it('NEVER turns a failed request into "you have none scheduled"', async () => {
    builder.state.result = { data: null, error: { code: '08006', message: 'network' } }
    const res = await loadScheduled('me', 'them')
    expect(res.state).toBe('failed')
    expect(res.rows).toBeNull()
  })

  it('tells a shelved migration apart from a failure, so the UI can hide itself', async () => {
    for (const code of ['PGRST202', 'PGRST205', '42883', '42P01']) {
      builder.state.result = { data: null, error: { code, message: 'nope' } }
      expect((await loadScheduled('me', 'them')).state).toBe('off')
    }
  })

  it('recognises the PostgREST schema-cache wording as well as the code', () => {
    expect(featureMissing({ message: "Could not find the function public.schedule_message in the schema cache" })).toBe(true)
    expect(featureMissing({ message: 'relation "public.scheduled_messages" does not exist' })).toBe(true)
    expect(featureMissing({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(featureMissing(undefined)).toBe(false)
  })
})

describe('scheduleMessage', () => {
  it('sends the wall clock, never an instant', async () => {
    await scheduleMessage('them', 'good morning', '2026-09-16', '09:00')
    expect(rpc).toHaveBeenCalledWith('schedule_message', {
      other: 'them', body: 'good morning', local_date: '2026-09-16', local_time: '09:00',
    })
  })

  it('throws rather than resolving to something that looks like success', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'that time has already passed' } })
    await expect(scheduleMessage('them', 'hi', '2026-09-16', '09:00')).rejects.toThrow(/already passed/)
  })
})

it('the cap the UI quotes is the cap the database enforces', () => {
  // Both numbers are written down in exactly one place each; this is the line
  // that fails if one of them moves without the other.
  expect(MAX_PENDING).toBe(20)
  expect(HORIZON_DAYS).toBe(7)
})
