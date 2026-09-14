import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const mocks = vi.hoisted(() => ({ list: vi.fn(), ask: vi.fn(), answer: vi.fn(), toast: vi.fn() }))
vi.mock('../src/lib/db', () => ({ listPairQuestions: mocks.list, askQuestion: mocks.ask, answerQuestion: mocks.answer }))
vi.mock('../src/hooks/useToast', () => ({ useToast: () => mocks.toast }))
import QuestionCards from '../src/components/QuestionCards'
afterEach(() => { cleanup(); vi.clearAllMocks() })

const render1 = () => render(<QuestionCards me="me" friend={{ id: 'friend' }} friendName="Friend" />)

test('collapses to a chip until something is waiting on you', async () => {
  mocks.list.mockResolvedValue([{ id: 'q1', asker: 'me', body: 'Q', answer: null, created_at: new Date().toISOString(), asks_left: 2 }])
  render1()
  // A question you asked is waiting on THEM, so it must not force the panel open.
  await waitFor(() => expect(screen.getByText(/Question of the day/)).toBeTruthy())
  expect(screen.queryByText('Q')).toBe(null)
})

test('a question asked of you opens the panel and warns the answer is final', async () => {
  mocks.list.mockResolvedValue([{ id: 'q1', asker: 'friend', body: 'Why?', answer: null, created_at: new Date().toISOString(), asks_left: 3 }])
  render1()
  await waitFor(() => expect(screen.getByText('Why?')).toBeTruthy())
  expect(screen.getByText('Answers can’t be edited')).toBeTruthy()
})

test('the three-a-day cap disables asking', async () => {
  mocks.list.mockResolvedValue([{ id: 'q1', asker: 'friend', body: 'Why?', answer: 'because', created_at: new Date().toISOString(), asks_left: 0 }])
  render1()
  await waitFor(() => expect(screen.getByText(/Question of the day/)).toBeTruthy())
  fireEvent.click(screen.getByText(/Question of the day/))
  expect(screen.getByRole('button', { name: /None left today/ }).disabled).toBe(true)
})

test('the cap says so, and says when it lifts — a dead button is not feedback', async () => {
  mocks.list.mockResolvedValue([
    { id: 'q1', asker: 'me', body: 'One', answer: 'a', created_at: new Date().toISOString(), asks_left: 0 },
  ])
  render1()
  await waitFor(() => expect(screen.getByText(/Question of the day/)).toBeTruthy())
  fireEvent.click(screen.getByText(/Question of the day/))

  const notice = await screen.findByRole('status')
  expect(notice.textContent).toMatch(/three questions for today/)
  // When it comes back, and in whose day — the cap is counted in IST
  // server-side, so the screen must not leave someone to assume their own.
  expect(notice.textContent).toMatch(/New questions in/)
  expect(notice.textContent).toMatch(/midnight IST/)
  // Answering is not capped, and the notice must not imply it is.
  expect(notice.textContent).toMatch(/still answer/)
  // And the composer is gone rather than sitting there refusing to send.
  expect(screen.queryByRole('textbox')).toBe(null)
})

test('a double submit costs one ask, not two', async () => {
  mocks.list.mockResolvedValue([])
  // Still in flight when the second submit arrives — the state flag has not
  // re-rendered yet, which is exactly the window that spent two of three.
  let release
  mocks.ask.mockImplementation(() => new Promise((resolve) => { release = resolve }))
  render1()
  await waitFor(() => expect(screen.getByText('Question of the day')).toBeTruthy())
  fireEvent.click(screen.getByText('Question of the day'))
  fireEvent.click(screen.getByRole('button', { name: /Ask \(3\)/ }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'are you ok?' } })

  const form = screen.getByRole('textbox').closest('form')
  fireEvent.submit(form)
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(mocks.ask).toHaveBeenCalledTimes(1)

  await act(async () => { release({ id: 'q1' }) })
  // And the guard clears afterwards, so the next question can still be asked.
  expect(mocks.ask).toHaveBeenCalledTimes(1)
})

test('an answer cannot be double-sent — it is final once written', async () => {
  mocks.list.mockResolvedValue([
    { id: 'q1', asker: 'friend', body: 'Why?', answer: null, created_at: new Date().toISOString(), asks_left: 3 },
  ])
  let release
  mocks.answer.mockImplementation(() => new Promise((resolve) => { release = resolve }))
  render1()
  await waitFor(() => expect(screen.getByText('Why?')).toBeTruthy())
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'because' } })
  const send = screen.getByRole('button', { name: 'Answer' })
  fireEvent.click(send)
  fireEvent.click(send)
  expect(mocks.answer).toHaveBeenCalledTimes(1)
  await act(async () => { release({ id: 'q1' }) })
})

test('a refused ask re-reads the quota instead of leaving a stale count on screen', async () => {
  // Three already used elsewhere (another tab, the other phone): the panel
  // still says three left until the server disagrees.
  mocks.list.mockResolvedValueOnce([])
  mocks.ask.mockRejectedValue(new Error('That is your three questions for today'))
  mocks.list.mockResolvedValue([
    { id: 'q1', asker: 'me', body: 'One', answer: null, created_at: new Date().toISOString(), asks_left: 0 },
  ])
  render1()
  await waitFor(() => expect(screen.getByText('Question of the day')).toBeTruthy())
  fireEvent.click(screen.getByText('Question of the day'))
  fireEvent.click(screen.getByRole('button', { name: /Ask \(3\)/ }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'one more?' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form'))

  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('That is your three questions for today'))
  // The whole point: "3 asks left" must not survive the server saying zero.
  await waitFor(() => expect(screen.getByRole('button', { name: /None left today/ })).toBeTruthy())
  expect(screen.queryByText(/3 asks left today/)).toBe(null)
})

test('a failed ask surfaces the reason and keeps the draft', async () => {
  mocks.list.mockResolvedValue([])
  mocks.ask.mockRejectedValue(new Error('That is your three questions for today'))
  render1()
  await waitFor(() => expect(screen.getByText('Question of the day')).toBeTruthy())
  fireEvent.click(screen.getByText('Question of the day'))
  fireEvent.click(screen.getByRole('button', { name: /Ask \(3\)/ }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello?' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form'))
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('That is your three questions for today'))
  expect(screen.getByRole('textbox').value).toBe('hello?')
})
