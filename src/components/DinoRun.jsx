import { useCallback, useEffect, useRef, useState } from 'react'
import { GROUND_Y, createRun, jump as jumpRun, scoreOf, step } from '../lib/runner'
import {
  STAR_Y,
  createWatch,
  missionHasStars,
  progressOf,
  starsOnScreen,
  watchFrame,
  watchJump,
  watchScore,
} from '../lib/missions'

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
//
// TODAY'S SECRET MISSION rides along on top, and the word to hold on to is ON
// TOP. lib/runner.js decides everything about the run; lib/missions.js only
// watches one (`watchFrame` reads the run and never writes to it) and owns the
// stars, which exist as a pure function of how far the run has come. A mission
// that could reach into the physics would make runner.js's own tests stop
// describing the game people actually play.

const INK = '#16161a'
const LAV = '#c4a5e8'
const LAV_SOFT = '#e6dcf5'
const CORAL = '#e2664a'
const LIME = '#d6e85a'

// A five-pointed star, drawn rather than downloaded — same reason as the
// sprites above.
function drawStar(ctx, cx, cy, r, filled) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.44
    const angle = (Math.PI / 5) * i - Math.PI / 2
    const x = cx + Math.cos(angle) * radius
    const y = cy + Math.sin(angle) * radius
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  if (filled) {
    ctx.fillStyle = LIME
    ctx.fill()
    ctx.lineWidth = 1.4
    ctx.strokeStyle = INK
    ctx.stroke()
  } else {
    ctx.lineWidth = 1.4
    ctx.strokeStyle = LAV_SOFT
    ctx.stroke()
  }
}

export default function DinoRun({ best = 0, onScore, mission = null, totals = null, onRunEnd }) {
  const canvasRef = useRef(null)
  const [score, setScore] = useState(0)
  const [state, setState] = useState('ready') // ready | running | over
  const [missionValue, setMissionValue] = useState(0)
  const stateRef = useRef('ready')
  const game = useRef(null)
  const watch = useRef(null)
  const scoreRef = useRef(0)
  const missionValueRef = useRef(0)
  const onScoreRef = useRef(onScore)
  const onRunEndRef = useRef(onRunEnd)
  const missionRef = useRef(mission)
  const totalsRef = useRef(totals)
  onScoreRef.current = onScore
  onRunEndRef.current = onRunEnd
  missionRef.current = mission
  totalsRef.current = totals
  const live = progressOf(mission, totals)
  // The mission line counts up live off the watch, and falls back to what the
  // day already knows between runs.
  const shown = live ? Math.max(live.value, Math.min(missionValue, live.goal)) : 0
  const done = live ? shown >= live.goal : false

  const reset = useCallback(() => {
    game.current = createRun()
    game.current.last = 0
    watch.current = createWatch()
    setScore(0)
    scoreRef.current = 0
    setMissionValue(0)
    missionValueRef.current = 0
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
    if (!g) return
    // Count the jump only if runner.js actually takes it — the same condition
    // `jump()` applies. Counting taps instead would let a mission be finished
    // by hammering the screen in mid-air.
    const taken = !g.over && g.y === 0
    jumpRun(g)
    if (taken) watchJump(watch.current)
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

        // Observe, after the physics have decided the frame.
        watchFrame(watch.current, g)
        watchScore(watch.current, whole)
        const p = progressOf(missionRef.current, totalsRef.current, watch.current)
        if (p && p.value !== missionValueRef.current) {
          missionValueRef.current = p.value
          setMissionValue(p.value)
        }

        if (g.over) {
          stateRef.current = 'over'
          setState('over')
          onScoreRef.current?.(whole)
          onRunEndRef.current?.(watch.current, whole)
        }
      }

      // stars (mission-owned, and only on the days a mission asks for them)
      if (missionHasStars(missionRef.current)) {
        for (const s of starsOnScreen(game.current, w, watch.current)) {
          drawStar(ctx, s.x, GROUND_Y - STAR_Y, 9, s.taken)
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
      {/* No mission on a day we could not identify (see lib/dayCycle.js) — the
          line is simply absent rather than showing a goal of nothing. */}
      {live && (
        <div className={`dino-mission ${done ? 'is-done' : ''}`} role="status">
          <span className="chip">{done ? 'Mission complete' : 'Secret mission'}</span>
          <span className="dino-mission-text">
            {mission.title} · {shown} of {live.goal} {live.unit}
          </span>
        </div>
      )}
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
