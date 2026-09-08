import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// One reserved strip for everything that announces itself above the tab bar.
//
// There used to be four surfaces each picking its own offset — install at
// safe+84, the game banner at safe+88, the toast at safe+96 — so any two
// visible together overlapped, and a two-line install banner grew straight down
// into the tab bar. Offsets chosen independently cannot be made to agree; they
// have to share one container.
//
// Ordering is by priority, not by arrival (lib/notifications.js). The strip is
// column-reverse, so priority 1 sits closest to the tab bar where the thumb and
// the eye are, and anything less urgent stacks upward and away.

// The container is mounted once, by App, above every notifier. A slot rendered
// in the same commit would not find the host in the DOM yet, so slots subscribe
// rather than reading it once — one extra render on first paint, and no
// ordering requirement between the container and its contents.
let host = null
const waiting = new Set()

function setHost(node) {
  host = node
  for (const fn of waiting) fn(node)
}

export default function NotificationStack() {
  return <div className="notif-stack" ref={setHost} />
}

export function StackSlot({ priority, children }) {
  const [target, setTarget] = useState(host)
  useEffect(() => {
    if (host) {
      setTarget(host)
      return undefined
    }
    waiting.add(setTarget)
    return () => waiting.delete(setTarget)
  }, [])
  if (!target) return null
  // `order` is what does the sorting. Nothing has to know what else is on
  // screen, which is the property the old hand-picked offsets lacked.
  return createPortal(<div style={{ order: priority }}>{children}</div>, target)
}
