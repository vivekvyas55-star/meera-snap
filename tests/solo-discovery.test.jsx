import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
vi.mock('../src/components/DinoRun', () => ({ default: () => <div>Runner is open</div> }))
import SoloPlay from '../src/screens/SoloPlay'
import { istToday } from '../src/lib/db'
import { recordRunnerScore } from '../src/lib/soloProgress'
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
test('surprise me starts an existing quick game and Back returns to the solo catalogue', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const leave = vi.fn()
  render(<SoloPlay me="me" onBack={leave} />)
  fireEvent.click(screen.getByRole('button', { name: /Surprise me/ }))
  expect(screen.getByText('Runner is open')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByRole('button', { name: /Surprise me/ })).toBeTruthy()
  expect(leave).not.toHaveBeenCalled()
})
test('returning from a game refreshes the personal bests saved on the device', () => {
  render(<SoloPlay me="me" onBack={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /Emoji Detective/ }))
  recordRunnerScore(istToday(), 321)
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByText('Best 321')).toBeTruthy()
})
