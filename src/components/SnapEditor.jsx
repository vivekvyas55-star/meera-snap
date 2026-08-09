import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

// Draw & text layer over a captured snap. Freehand doodle on a canvas that
// overlays the object-fit:cover preview, plus movable text stickers. compose()
// flattens the photo + doodle + text into one JPEG blob, matching exactly what
// the user sees (everything works in the preview box's coordinate space).
const COLORS = ['#ffffff', '#16161a', '#e2664a', '#d6e85a', '#4a52c4', '#c4a5e8', '#ff2d55', '#ffd60a']

function drawCover(ctx, img, w, h) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const iw = img.naturalWidth * s
  const ih = img.naturalHeight * s
  ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih)
}

const SnapEditor = forwardRef(function SnapEditor({ shot, filter = 'none' }, ref) {
  const boxRef = useRef(null)
  const imgRef = useRef(null)
  const canvasRef = useRef(null)
  const strokesRef = useRef([]) // [{color,width,points:[{x,y}]}]  x/y in CSS px
  const drawingRef = useRef(false)
  const dragRef = useRef(null) // {id, dx, dy} while moving a text sticker

  const [color, setColor] = useState('#ffffff')
  const [texts, setTexts] = useState([]) // [{id,text,x,y,color}]  x/y are % of box
  const [editingId, setEditingId] = useState(null)
  const [, forceTick] = useState(0)

  // Size the drawing canvas to the preview box (×DPR for crisp lines).
  useEffect(() => {
    const fit = () => {
      const c = canvasRef.current
      const b = boxRef.current
      if (!c || !b) return
      const r = b.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      c.width = Math.round(r.width * dpr)
      c.height = Math.round(r.height * dpr)
      c.style.width = `${r.width}px`
      c.style.height = `${r.height}px`
      const ctx = c.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      redraw()
    }
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('orientationchange', fit)
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('orientationchange', fit)
    }
  }, [])

  const redraw = () => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    ctx.clearRect(0, 0, c.width / dpr, c.height / dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of strokesRef.current) {
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.beginPath()
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      ctx.stroke()
    }
  }

  const boxPoint = (e) => {
    const r = boxRef.current.getBoundingClientRect()
    const t = e.touches?.[0] ?? e
    return { x: t.clientX - r.left, y: t.clientY - r.top }
  }

  const onDown = (e) => {
    if (editingId) return
    drawingRef.current = true
    strokesRef.current.push({ color, width: 5, points: [boxPoint(e)] })
  }
  const onMove = (e) => {
    if (!drawingRef.current) return
    e.preventDefault()
    strokesRef.current[strokesRef.current.length - 1].points.push(boxPoint(e))
    redraw()
  }
  const onUp = () => {
    drawingRef.current = false
  }

  const undo = () => {
    strokesRef.current.pop()
    redraw()
  }
  const clearAll = () => {
    strokesRef.current = []
    setTexts([])
    redraw()
  }

  const addText = () => {
    const id = `t${strokesRef.current.length}_${texts.length}_${Math.floor(performance.now())}`
    setTexts((t) => [...t, { id, text: '', x: 50, y: 45, color }])
    setEditingId(id)
  }

  // Drag a text sticker.
  const startDrag = (e, t) => {
    if (editingId === t.id) return
    const p = boxPoint(e)
    const r = boxRef.current.getBoundingClientRect()
    dragRef.current = { id: t.id, dx: p.x - (t.x / 100) * r.width, dy: p.y - (t.y / 100) * r.height }
  }
  const onBoxMove = (e) => {
    if (dragRef.current) {
      const p = boxPoint(e)
      const r = boxRef.current.getBoundingClientRect()
      const nx = ((p.x - dragRef.current.dx) / r.width) * 100
      const ny = ((p.y - dragRef.current.dy) / r.height) * 100
      setTexts((ts) =>
        ts.map((t) =>
          t.id === dragRef.current.id
            ? { ...t, x: Math.max(4, Math.min(96, nx)), y: Math.max(6, Math.min(94, ny)) }
            : t
        )
      )
      return
    }
    onMove(e)
  }
  const onBoxUp = () => {
    dragRef.current = null
    onUp()
  }

  useImperativeHandle(
    ref,
    () => ({
      hasEdits: () => strokesRef.current.length > 0 || texts.some((t) => t.text.trim()),
      // `filterCss` must match what the preview applies, layer for layer: the
      // photo and the doodle canvas both carry the CSS filter, the text stickers
      // do NOT (they're plain DOM above the filtered layers). Baking the filter
      // over the whole flattened image instead — as the caller used to — tinted
      // text that was never tinted on screen.
      async compose(filterCss = 'none') {
        const img = imgRef.current
        const b = boxRef.current
        if (!img || !b) return shot.blob
        if (!img.naturalWidth) {
          try {
            await img.decode()
          } catch {
            return shot.blob
          }
        }
        const r = b.getBoundingClientRect()
        const dpr = Math.min(window.devicePixelRatio || 1, 3)
        const w = r.width
        const h = r.height
        const out = document.createElement('canvas')
        out.width = Math.round(w * dpr)
        out.height = Math.round(h * dpr)
        const ctx = out.getContext('2d')
        ctx.scale(dpr, dpr)
        // 1) the photo, matching the object-fit:cover preview — filtered
        ctx.filter = filterCss
        drawCover(ctx, img, w, h)
        // 2) the doodle — filtered too, as .snap-edit-canvas is in the preview
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (const s of strokesRef.current) {
          ctx.strokeStyle = s.color
          ctx.lineWidth = s.width
          ctx.beginPath()
          s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
          ctx.stroke()
        }
        // 3) the text stickers — UNfiltered, matching .snap-text
        ctx.filter = 'none'
        const fontPx = Math.round(w * 0.075)
        ctx.font = `700 ${fontPx}px -apple-system, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.lineWidth = Math.max(2, fontPx * 0.09)
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'
        for (const t of texts) {
          if (!t.text.trim()) continue
          const x = (t.x / 100) * w
          const y = (t.y / 100) * h
          ctx.strokeText(t.text, x, y)
          ctx.fillStyle = t.color
          ctx.fillText(t.text, x, y)
        }
        return await new Promise((res) => out.toBlob((bl) => res(bl || shot.blob), 'image/jpeg', 0.9))
      },
    }),
    [texts, shot.blob]
  )

  return (
    <div
      className="snap-edit"
      ref={boxRef}
      onPointerDown={onDown}
      onPointerMove={onBoxMove}
      onPointerUp={onBoxUp}
      onPointerLeave={onBoxUp}
    >
      <img ref={imgRef} src={shot.url} alt="Your snap" style={{ filter }} />
      <canvas ref={canvasRef} className="snap-edit-canvas" style={{ filter }} />

      {texts.map((t) => (
        <div
          key={t.id}
          className="snap-text"
          style={{ left: `${t.x}%`, top: `${t.y}%`, color: t.color }}
          onPointerDown={(e) => {
            e.stopPropagation()
            startDrag(e, t)
          }}
          onClick={(e) => {
            e.stopPropagation()
            setEditingId(t.id)
          }}
        >
          {editingId === t.id ? (
            <input
              autoFocus
              value={t.text}
              onChange={(e) =>
                setTexts((ts) => ts.map((x) => (x.id === t.id ? { ...x, text: e.target.value } : x)))
              }
              onBlur={() => {
                setEditingId(null)
                setTexts((ts) => ts.filter((x) => x.text.trim() || x.id !== t.id))
                forceTick((n) => n + 1)
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onPointerDown={(e) => e.stopPropagation()}
              placeholder="Type…"
            />
          ) : (
            t.text || ' '
          )}
        </div>
      ))}

      {/* Tools — stop pointer events so tapping a control never draws a dot. */}
      <div className="snap-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={addText} aria-label="Add text">T</button>
        <button type="button" onClick={undo} aria-label="Undo">↶</button>
        <button type="button" onClick={clearAll} aria-label="Clear">✕</button>
      </div>
      <div className="snap-colors" onPointerDown={(e) => e.stopPropagation()}>
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`swatch${color === c ? ' on' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
            aria-label={`Colour ${c}`}
          />
        ))}
      </div>
    </div>
  )
})

export default SnapEditor
