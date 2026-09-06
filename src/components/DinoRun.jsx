import { useCallback, useEffect, useRef, useState } from 'react'
import { GROUND_Y, createRun, jump as jumpRun, scoreOf, step } from '../lib/runner'

// A one-button runner, in Meera's palette rather than Chrome's grey.
//
// Canvas, not DOM: sixty frames a second of moving obstacles through React
// state would re-render the whole subtree each frame. Everything below the
// score lives in a ref and never triggers a render — `setScore` fires only when
// the whole number changes, and the game-over state once per run.
//
// Deliberately no images: the sprites are drawn from rectangles, so there is
// nothing to download and nothing to cache. Egress is the scarcest resource
// here (see CLAUDE.md), and a game is not worth a single byte of it.

const INK = '#16161a'
const LAV = '#c4a5e8'
const LAV_SOFT = '#e6dcf5'
const CORAL = '#e2664a'

export default function DinoRun({ best = 0, onScore }) {
  const canvasRef = useRef(null)
  const [score, setScore] = useState(0)
  const [state, setState] = useState('ready') // ready | running | over
  const stateRef = useRef('ready')
  const game = useRef(null)
  const scoreRef = useRef(0)
  const onScoreRef = useRef(onScore)
  onScoreRef.current = onScore

  const reset = useCallback(() => {
    game.current = createRun()
    game.current.last = 0
    setScore(0)
    scoreRef.current = 0
  }, [])

  const jump = useCallback(() => {
    const g = game.current
    if (stateRef.current === 'over') {
      reset()
      stateRef.current = 'running'
      setState('running')
      return
    }
    if (stateRef.current === 'ready') {
      stateRef.current = 'running'
      setState('running')
      return
    }
    if (g) jumpRun(g)
  }, [reset])

  useEffect(() => {
    reset()
  }, [reset])

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'ArrowUp') {
        e.preventDefault()
        jump()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jump])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf = 0
    let alive = true

    // Size the backing store to the device pixel ratio, or everything is soft
    // on a phone.
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()
    window.addEventListener('resize', fit)

    const draw = (now) => {
      if (!alive) return
      const g = game.current
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dt = g.last ? Math.min((now - g.last) / 16.67, 3) : 1
      g.last = now

      ctx.clearRect(0, 0, w, h)

      // ground
      ctx.strokeStyle = LAV_SOFT
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, GROUND_Y + 2)
      ctx.lineTo(w, GROUND_Y + 2)
      ctx.stroke()

      if (stateRef.current === 'running') {
        step(g, dt, w)

        const whole = scoreOf(g)
        if (whole !== scoreRef.current) {
          scoreRef.current = whole
          setScore(whole)
        }

        if (g.over) {
          stateRef.current = 'over'
          setState('over')
          onScoreRef.current?.(whole)
        }
      }

      // clouds
      ctx.fillStyle = LAV_SOFT
      for (const c of game.current.clouds) {
        ctx.fillRect(c.x, c.y, 22, 5)
        ctx.fillRect(c.x + 6, c.y - 5, 12, 5)
      }

      // obstacles
      ctx.fillStyle = LAV
      for (const o of game.current.obstacles) {
        ctx.fillRect(o.x, GROUND_Y - o.h, o.w, o.h)
        ctx.fillRect(o.x - 4, GROUND_Y - o.h + 7, 4, 9)
        ctx.fillRect(o.x + o.w, GROUND_Y - o.h + 11, 4, 8)
      }

      // runner
      const g2 = game.current
      const rx = 30
      const ry = GROUND_Y - 22 + g2.y
      ctx.fillStyle = stateRef.current === 'over' ? CORAL : INK
      ctx.fillRect(rx, ry, 20, 16)
      ctx.fillRect(rx + 15, ry - 6, 10, 9)
      ctx.fillStyle = '#fff'
      ctx.fillRect(rx + 21, ry - 3, 2, 2)
      ctx.fillStyle = stateRef.current === 'over' ? CORAL : INK
      const stride = Math.floor(g2.frame / 5) % 2 === 0
      if (g2.y === 0 && stateRef.current === 'running') {
        ctx.fillRect(rx + 3, ry + 16, 4, stride ? 6 : 3)
        ctx.fillRect(rx + 12, ry + 16, 4, stride ? 3 : 6)
      } else {
        ctx.fillRect(rx + 3, ry + 16, 4, 5)
        ctx.fillRect(rx + 12, ry + 16, 4, 5)
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
    }
  }, [])

  // Pause when the tab is hidden, or dt spikes on return and the runner
  // teleports into an obstacle it never had a chance to jump.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'visible' && game.current) game.current.last = 0
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  return (
    <div className="dino">
      <div className="dino-hud">
        <span>Score {score}</span>
        <span className="dino-best">Best {Math.max(best, score)}</span>
      </div>
      <button
        className="dino-stage"
        onPointerDown={(e) => { e.preventDefault(); jump() }}
        aria-label={state === 'running' ? 'Jump' : 'Start the game'}
      >
        <canvas ref={canvasRef} className="dino-canvas" />
        {state !== 'running' && (
          <span className="dino-overlay">
            <strong>{state === 'over' ? `Score ${score}` : 'Tap to start'}</strong>
            <em>{state === 'over' ? 'Tap to run again' : 'Tap or press space to jump'}</em>
          </span>
        )}
      </button>
    </div>
  )
}
