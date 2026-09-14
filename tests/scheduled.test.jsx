import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// The surfaces of scheduled messages. Three things are load-bearing and none of
// them are cosmetic:
//
//   * the disclosure is on screen at the moment of choice, in plain words, not
//     behind a <details> somebody has to open;
//   * the strip says "we could not check" when it could not check, and says
//     nothing at all when the migration is still on the shelf;
//   * the cap and the horizon stop the tap before the round trip does.

vi.mock('../src/lib/supabase', () => ({
  supabase: { from: () => ({}), rpc: async () => ({ data: [], error: null }) },
  emailForUsername: (u) => `${u}@meera.local`,
}))

const {
  ScheduleButton, ScheduleComposeSheet, ScheduledBar, ScheduledListSheet,
} = await import('../src/components/ScheduledMessages')

afterEach(cleanup)

// A send_at far enough out that "Tomorrow"/"Today" is stable whenever this runs.
const soon = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString()

test('the disclosure is on screen at the moment of choice, unopened', () => {
  render(
    <ScheduleComposeSheet
      friendName="Sneha" body="good morning" pendingCount={0}
      onClose={() => {}} onSchedule={async () => {}}
    />
  )
  // Not hidden behind a disclosure widget — a summary you have to tap is one
  // the person who most needed it never read.
  expect(document.querySelector('details')).toBeNull()
  const text = screen.getByText(/waits on the server/i).textContent.replace(/\s+/g, ' ')
  expect(text).toMatch(/in plain text/i)
  expect(text).toMatch(/clears after three visits/i)
  expect(text).toMatch(/7 days/)
})

test('it says which clock the time is on, because both people are on one', () => {
  render(
    <ScheduleComposeSheet
      friendName="Sneha" body="hi" pendingCount={0}
      onClose={() => {}} onSchedule={async () => {}}
    />
  )
  expect(screen.getByText(/India time/)).toBeTruthy()
})

test('the cap stops the tap before the round trip does', () => {
  render(
    <ScheduleComposeSheet
      friendName="Sneha" body="hi" pendingCount={20}
      onClose={() => {}} onSchedule={async () => {}}
    />
  )
  expect(screen.getByText(/Cancel one first/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Schedule' }).disabled).toBe(true)
})

test('a day past the horizon is refused in the picker', () => {
  render(
    <ScheduleComposeSheet
      friendName="Sneha" body="hi" pendingCount={0}
      onClose={() => {}} onSchedule={async () => {}}
    />
  )
  // The last chip is today + 7 at whatever time it already is, so any later
  // time on that day is outside the window.
  const chips = [...document.querySelectorAll('.sched-day')]
  expect(chips).toHaveLength(8)
  fireEvent.click(chips.at(-1))
  fireEvent.change(document.querySelector('.sched-time'), { target: { value: '23:59' } })
  // Either it is inside the window (before 23:59 local) or it is refused — what
  // must never happen is the button staying live on a value the server rejects.
  const refused = screen.queryByText(/up to 7 days ahead/)
  const button = screen.getByRole('button', { name: 'Schedule' })
  expect(Boolean(refused)).toBe(button.disabled)
})

test('scheduling hands back the wall clock the user picked', async () => {
  const onSchedule = vi.fn(async () => {})
  render(
    <ScheduleComposeSheet
      friendName="Sneha" body="good morning" pendingCount={0}
      onClose={() => {}} onSchedule={onSchedule}
    />
  )
  const chips = [...document.querySelectorAll('.sched-day')]
  fireEvent.click(chips[1])          // Tomorrow — always inside the window
  fireEvent.change(document.querySelector('.sched-time'), { target: { value: '09:00' } })
  fireEvent.click(screen.getByRole('button', { name: 'Schedule' }))
  expect(onSchedule).toHaveBeenCalledTimes(1)
  const [date, time] = onSchedule.mock.calls[0]
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)   // a calendar date, not an instant
  expect(time).toBe('09:00')
})

test('a failed check says so — it never renders as "nothing scheduled"', () => {
  const onRetry = vi.fn()
  render(<ScheduledBar result={{ state: 'failed', rows: null }} onOpen={() => {}} onRetry={onRetry} />)
  expect(screen.getByText(/Couldn’t check/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalled()
})

test('nothing is shown before the first answer, or when the feature is not there', () => {
  const { container, rerender } = render(
    <ScheduledBar result={undefined} onOpen={() => {}} onRetry={() => {}} />
  )
  expect(container.textContent).toBe('')
  rerender(<ScheduledBar result={{ state: 'off', rows: null }} onOpen={() => {}} onRetry={() => {}} />)
  expect(container.textContent).toBe('')
  // An empty answer really is "nothing scheduled", and shows nothing too.
  rerender(<ScheduledBar result={{ state: 'ok', rows: [] }} onOpen={() => {}} onRetry={() => {}} />)
  expect(container.textContent).toBe('')
})

test('the strip counts what is waiting and names the next one', () => {
  render(
    <ScheduledBar
      result={{ state: 'ok', rows: [{ id: 'a', send_at: soon }, { id: 'b', send_at: soon }] }}
      onOpen={() => {}} onRetry={() => {}}
    />
  )
  expect(screen.getByText(/2 scheduled/)).toBeTruthy()
})

test('the clock button is hidden where scheduling cannot work at all', () => {
  const { container, rerender } = render(<ScheduleButton result={{ state: 'off' }} onClick={() => {}} />)
  expect(container.querySelector('button')).toBeNull()
  rerender(<ScheduleButton result={{ state: 'ok', rows: [] }} onClick={() => {}} />)
  expect(container.querySelector('button')).toBeTruthy()
})

test('the clock button is a line icon, never an emoji', () => {
  const { container } = render(<ScheduleButton result={{ state: 'ok', rows: [] }} onClick={() => {}} />)
  expect(container.querySelector('svg')).toBeTruthy()
  expect(container.textContent).toBe('')
})

test('the waiting list can cancel, and repeats the disclosure', async () => {
  const onCancel = vi.fn(async () => {})
  render(
    <ScheduledListSheet
      rows={[{ id: 'a', send_at: soon, body: 'good morning' }]}
      friendName="Sneha" onCancel={onCancel} onClose={() => {}}
    />
  )
  expect(screen.getByText('good morning')).toBeTruthy()
  expect(screen.getByText(/waits on the server/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onCancel).toHaveBeenCalledWith('a')
})
