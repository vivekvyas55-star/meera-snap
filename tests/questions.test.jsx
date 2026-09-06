import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
