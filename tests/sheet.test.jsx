import React, { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Sheet from '../src/components/Sheet'

afterEach(cleanup)

const esc = () => fireEvent.keyDown(document, { key: 'Escape' })

// Sheets stack for real in this app: Kept Together opens inside the friend
// sheet, and Confirm opens inside both. Escape has to belong to the one on top.
function Stacked({ onOuter, onInner }) {
  const [inner, setInner] = useState(false)
  return (
    <Sheet onClose={onOuter} label="Friend options">
      <button onClick={() => setInner(true)}>Kept together</button>
      {inner && (
        <Sheet onClose={onInner} label="Kept together">
          <button>Close</button>
        </Sheet>
      )}
    </Sheet>
  )
}

test('Escape closes the innermost sheet, not the one it is stacked on', () => {
  const onOuter = vi.fn()
  const onInner = vi.fn()
  render(<Stacked onOuter={onOuter} onInner={onInner} />)
  fireEvent.click(screen.getByText('Kept together'))

  esc()
  // Listeners on document in the same phase run in the order they were ADDED,
  // so the OUTER sheet — mounted first — used to answer first, close itself and
  // stopImmediatePropagation the inner one out of existence with it.
  expect(onInner).toHaveBeenCalledTimes(1)
  expect(onOuter).not.toHaveBeenCalled()
})

test('Escape returns to the sheet underneath once the top one is gone', () => {
  const onOuter = vi.fn()
  render(
    <Sheet onClose={onOuter} label="Friend options">
      <button>Only</button>
    </Sheet>
  )
  esc()
  expect(onOuter).toHaveBeenCalledTimes(1)
})

test('an unmounted sheet stops answering Escape at all', () => {
  const onClose = vi.fn()
  const view = render(
    <Sheet onClose={onClose} label="Gone">
      <button>Only</button>
    </Sheet>
  )
  view.unmount()
  esc()
  expect(onClose).not.toHaveBeenCalled()
})
