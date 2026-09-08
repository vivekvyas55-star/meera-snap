import { useEffect, useRef } from 'react'
import { useBackLayer } from '../hooks/useBackLayer'

// The bottom sheets were plain divs with a backdrop click handler: no role, no
// Escape, no focus trap, and no focus restore. That makes them unusable by
// keyboard and invisible to assistive tech, and a stray Tab could land behind
// the backdrop on the screen the sheet is covering.
//
// This does not portal — callers already wrap themselves in <Portal>, which is
// mandatory inside the pager (see Portal.jsx).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Open sheets, innermost last. Escape belongs to the topmost one only.
// stopImmediatePropagation does NOT achieve that: listeners on the same node in
// the same phase run in the order they were ADDED, so the OUTER sheet — mounted
// first, listening first — was the one that stopped the others and closed
// itself, taking the inner sheet (its own child) down with it. Exactly the bug
// it was written to fix. An explicit stack is the only ordering that is
// actually about nesting.
const stack = []

export default function Sheet({ onClose, label, className = 'sheet-body', children }) {
  const bodyRef = useRef(null)
  const restoreRef = useRef(null)
  // Every caller passes an inline arrow, so onClose is a new function on each
  // parent render. Depending on it re-ran the whole effect — pulling focus out
  // of the field you were typing in (and closing the phone keyboard) on every
  // incoming message. Hold it in a ref and run the effect exactly once.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // A sheet is a Back-closable layer for as long as it is mounted. Doing this
  // here rather than at each call site means Android's Back dismisses the sheet
  // instead of the screen underneath it, for every sheet including ones written
  // later — and it cannot be forgotten for a new one.
  useBackLayer(true, onClose)

  // Identity for this sheet's slot in the stack.
  const tokenRef = useRef({})

  useEffect(() => {
    // Remember where focus came from so closing puts it back on the trigger
    // rather than dumping it at the top of the document.
    restoreRef.current = document.activeElement
    const first = bodyRef.current?.querySelector(FOCUSABLE)
    ;(first ?? bodyRef.current)?.focus?.()

    const token = tokenRef.current
    stack.push(token)

    const onKeyDown = (e) => {
      // Only the topmost sheet responds — to Escape and to Tab. Trapping focus
      // from underneath would fight the sheet actually on screen.
      if (stack[stack.length - 1] !== token) return
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        closeRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const items = [...(bodyRef.current?.querySelectorAll(FOCUSABLE) ?? [])]
      // With nothing focusable inside, Tab would escape the dialog entirely.
      if (items.length === 0) { e.preventDefault(); return }
      const edge = e.shiftKey ? items[0] : items[items.length - 1]
      if (document.activeElement === edge) {
        e.preventDefault()
        ;(e.shiftKey ? items[items.length - 1] : items[0]).focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const at = stack.indexOf(token)
      if (at !== -1) stack.splice(at, 1)
      restoreRef.current?.focus?.()
    }
  }, [])

  return (
    <div className="sheet" onClick={onClose} role="presentation">
      <div
        ref={bodyRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
