import React, { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resetBackStack } from '../src/lib/backStack'
import { useBackLayer } from '../src/hooks/useBackLayer'

// jsdom has a real history stack but no back gesture, so this drives it the way
// Android does: history.back() and the popstate it produces. jsdom's back() is
// asynchronous like a browser's, which is the whole reason the module counts
// acknowledgements rather than holding a boolean.
const back = async () => {
  await act(async () => {
    window.history.back()
    await new Promise((r) => setTimeout(r, 20))
  })
}

function Layer({ name, children }) {
  const [open, setOpen] = useState(false)
  useBackLayer(open, () => setOpen(false))
  return (
    <div>
      <button onClick={() => setOpen(true)}>open {name}</button>
      {open && (
        <div>
          <span>{name} open</span>
          <button onClick={() => setOpen(false)}>close {name}</button>
          {children}
        </div>
      )}
    </div>
  )
}

beforeEach(() => {
  resetBackStack()
  window.history.replaceState(null, '', '/')
})
afterEach(cleanup)

test('Back closes the innermost layer, one press at a time', async () => {
  render(<Layer name="profile"><Layer name="play" /></Layer>)
  fireEvent.click(screen.getByText('open profile'))
  fireEvent.click(await screen.findByText('open play'))
  expect(screen.getByText('play open')).toBeTruthy()

  // The whole point: this used to close Profile too, so one press skipped two
  // screens and dropped the user back on the camera.
  await back()
  expect(screen.queryByText('play open')).toBeNull()
  expect(screen.getByText('profile open')).toBeTruthy()

  await back()
  expect(screen.queryByText('profile open')).toBeNull()
})

// history.length is the wrong instrument: it does not shrink when you go back,
// in jsdom or in a real browser. What matters is whether we are still sitting
// on an entry we pushed — that is the dead step.
const onPushedEntry = () => window.history.state?.meeraLayer === true

test('closing from inside the app spends the entry it pushed', async () => {
  render(<Layer name="profile" />)
  fireEvent.click(screen.getByText('open profile'))
  expect(onPushedEntry()).toBe(true)
  fireEvent.click(screen.getByText('close profile'))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  // If the in-app close left its entry behind, the next Back would appear to do
  // nothing — it would spend the dead step instead of leaving the app.
  expect(onPushedEntry()).toBe(false)
  expect(screen.queryByText('profile open')).toBeNull()
})

test('a parent closing with a child open drops both entries', async () => {
  render(<Layer name="profile"><Layer name="play" /></Layer>)
  fireEvent.click(screen.getByText('open profile'))
  fireEvent.click(await screen.findByText('open play'))
  fireEvent.click(screen.getByText('close profile'))
  await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
  // Two layers close at once here. A boolean guard loses count of the second
  // acknowledgement and the next real Back gets swallowed.
  expect(onPushedEntry()).toBe(false)
  expect(screen.queryByText('profile open')).toBeNull()
  expect(screen.queryByText('play open')).toBeNull()
})

test('a layer unmounted while open does not leave a dead step', async () => {
  function Host() {
    const [mounted, setMounted] = useState(true)
    return (
      <div>
        <button onClick={() => setMounted(false)}>sign out</button>
        {mounted && <Layer name="profile" />}
      </div>
    )
  }
  render(<Host />)
  fireEvent.click(screen.getByText('open profile'))
  fireEvent.click(screen.getByText('sign out'))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  expect(onPushedEntry()).toBe(false)
})

test('a Back the user pressed is never mistaken for one we asked for', async () => {
  const closed = vi.fn()
  function One() {
    const [open, setOpen] = useState(true)
    useBackLayer(open, () => { closed(); setOpen(false) })
    return open ? <span>open</span> : <span>shut</span>
  }
  render(<One />)
  await back()
  expect(closed).toHaveBeenCalledTimes(1)
})
