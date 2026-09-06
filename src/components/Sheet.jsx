import { useEffect, useRef } from 'react'

// The bottom sheets were plain divs with a backdrop click handler: no role, no
// Escape, no focus trap, and no focus restore. That makes them unusable by
// keyboard and invisible to assistive tech, and a stray Tab could land behind
// the backdrop on the screen the sheet is covering.
//
// This does not portal — callers already wrap themselves in <Portal>, which is
// mandatory inside the pager (see Portal.jsx).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Sheet({ onClose, label, className = 'sheet-body', children }) {
  const bodyRef = useRef(null)
  const restoreRef = useRef(null)
  // Every caller passes an inline arrow, so onClose is a new function on each
  // parent render. Depending on it re-ran the whole effect — pulling focus out
  // of the field you were typing in (and closing the phone keyboard) on every
  // incoming message. Hold it in a ref and run the effect exactly once.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    // Remember where focus came from so closing puts it back on the trigger
    // rather than dumping it at the top of the document.
    restoreRef.current = document.activeElement
    const first = bodyRef.current?.querySelector(FOCUSABLE)
    ;(first ?? bodyRef.current)?.focus?.()

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        // stopPropagation does NOT stop other listeners on the same node, so a
        // stacked sheet (Kept Together inside the friend sheet) closed both.
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
