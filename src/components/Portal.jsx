import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// Renders children into <body>, escaping the swipe pager. This is essential:
// the pager has a CSS `transform`, and a position:fixed element inside a
// transformed ancestor is positioned relative to that ancestor, not the
// viewport — which pushes fullscreen sheets/viewers off to the side. Portaling
// to body restores true viewport-fixed positioning.
export default function Portal({ children }) {
  const [el] = useState(() => document.createElement('div'))
  useEffect(() => {
    document.body.appendChild(el)
    return () => {
      document.body.removeChild(el)
    }
  }, [el])
  return createPortal(children, el)
}
