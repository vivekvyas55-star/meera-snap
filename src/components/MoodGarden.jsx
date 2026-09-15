import { useCallback, useEffect, useMemo, useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'
import {
  MOODS,
  PLOT_H,
  PLOT_W,
  activeExtras,
  buildGarden,
  dayKey,
  gardenLine,
  moodById,
  shortDate,
} from '../lib/moodGarden'
import { clearMoods, forgetMoodCache, logMood, readMoods } from '../lib/moodStore'
import '../styles/garden.css'

// ============================================================================
// MOOD GARDEN — the entry component for the "Your little break" slot.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ IT TAKES NO PROPS, AND THAT IS THE ENFORCEMENT, NOT A STYLE CHOICE.      │
// │                                                                          │
// │ A mood history one partner can see about the other is a coercive-control │
// │ vector, and Meera is a two-person app, so this garden is own-eyes-only:  │
// │ device-local, never pair-scoped, never in the Together layer, never on a │
// │ friend's profile, never pushed, never exported, with no share affordance │
// │ anywhere. The way that is held is structural rather than remembered —    │
// │ `MoodGarden.length === 0`, asserted in tests/mood-garden.test.jsx, so    │
// │ the day someone adds `{ friend }` or `{ userId }` because it would be a  │
// │ sweet touch, the build fails instead of their partner's bad week         │
// │ appearing on a screen they did not choose.                               │
// │                                                                          │
// │ The same test greps this file and lib/moodGarden.js + lib/moodStore.js   │
// │ for the words that would start that feature, and for a supabase import.  │
// │ If you are here to wire this to a table, the answer is no.               │
// └──────────────────────────────────────────────────────────────────────────┘
//
// THREE STATES, NOT TWO. `entries` is undefined until the device has been
// asked, null when the read failed, and an array when it answered. A failed
// read must never render as "your garden is empty" — that is a claim about
// someone's own history that they would feel, and it is the seventh instance
// of the bug class CLAUDE.md lists. It renders as "we could not read it",
// with a retry, and logging is disabled while we cannot see what we would be
// overwriting.
//
// MOTION. Everything that moves is a CSS animation in garden.css, so the
// global prefers-reduced-motion rule (index.css, 0.01ms +
// animation-iteration-count: 1) actually stops it — every keyframe here is
// written with its resting, good-looking state at `to`, and garden.css holds
// its own reduced-motion block as well rather than relying on the global one
// alone. There is no requestAnimationFrame and no JS timer in this file. A
// garden with no motion at all is still the whole feature.
// ============================================================================

const SCENE_LABEL = 'Your garden, drawn from the moods you have logged'

export default function MoodGarden() {
  // undefined = not asked yet · null = the read failed · [] = really empty.
  const [entries, setEntries] = useState(undefined)
  const [persisted, setPersisted] = useState(true)
  const [detail, setDetail] = useState(false)
  const [picking, setPicking] = useState(false)
  const [today, setToday] = useState(() => dayKey())

  const read = useCallback(() => {
    forgetMoodCache()
    setEntries(readMoods())
    setToday(dayKey())
  }, [])

  useEffect(() => {
    setEntries(readMoods())
  }, [])

  // The IST day can roll over while the screen is open. Re-reading on return
  // costs nothing and stops a mood logged at 00:05 landing on yesterday.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setToday(dayKey())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const garden = useMemo(() => buildGarden(entries, today), [entries, today])
  const extras = useMemo(() => activeExtras(garden), [garden])
  const todayMood = garden.today ? moodById(garden.today) : null

  const choose = (id) => {
    const result = logMood(id, today)
    if (!result) {
      // The store could not be read, so nothing was written. Say so rather
      // than showing a plant that does not exist.
      setEntries(null)
      return
    }
    setEntries(result.entries)
    setPersisted(result.persisted)
    setPicking(false)
  }

  const erase = () => {
    clearMoods()
    setEntries([])
    setPersisted(true)
    setDetail(false)
  }

  /* ----------------------------------------------------------------------
     The read failed. This is the one branch that must never be allowed to
     look like an answer.
     ---------------------------------------------------------------------- */
  if (garden.status === 'failed') {
    return (
      <section className="mg mg-fail" aria-label="Mood garden">
        <h2 className="mg-title">Mood garden</h2>
        <p className="mg-fail-line">
          We could not read your garden on this device, so we are not going to
          guess at it. Nothing has been changed.
        </p>
        <button type="button" className="mg-retry" onClick={read}>
          Try again
        </button>
        <button type="button" className="mg-erase" onClick={erase}>
          Start a new garden
        </button>
      </section>
    )
  }

  const loading = garden.status === 'loading'

  return (
    <section className="mg" aria-label="Mood garden">
      <header className="mg-head">
        <p className="mg-eyebrow">Only you</p>
        <h2 className="mg-title">Mood garden</h2>
        <p className="mg-line">
          {loading ? ' ' : (gardenLine(garden) ?? ' ')}
        </p>
      </header>

      <Scene garden={garden} extras={extras} loading={loading} />

      {!loading && (
        <div className="mg-chips">
          <span className="mg-chip">On this phone only</span>
          {garden.since && <span className="mg-chip">since {shortDate(garden.since)}</span>}
          {garden.offPlot > 0 && (
            <span className="mg-chip">and {garden.offPlot} more, from earlier</span>
          )}
        </div>
      )}

      {!persisted && (
        <p className="mg-warn" role="status">
          This phone would not let us save it, so today&rsquo;s plant lasts until
          you close Meera.
        </p>
      )}

      {!loading && (todayMood && !picking ? (
        <div className="mg-today">
          <div className="mg-today-art" aria-hidden="true">
            <svg viewBox="-24 -54 48 60" width="44" height="55">
              <Plant mood={todayMood.id} stage={3} seed={7} />
            </svg>
          </div>
          <div className="mg-today-copy">
            <p className="mg-today-mood">{todayMood.label} today</p>
            <p className="mg-today-note">{todayMood.note}</p>
          </div>
          <button type="button" className="mg-change" onClick={() => setPicking(true)}>
            Change
          </button>
        </div>
      ) : (
        <div className="mg-ask">
          <p className="mg-ask-line">How is today?</p>
          <div className="mg-moods" role="group" aria-label="Choose today's mood">
            {MOODS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mg-mood${garden.today === m.id ? ' is-on' : ''}`}
                onClick={() => choose(m.id)}
                aria-pressed={garden.today === m.id}
              >
                <span className="mg-mood-art" aria-hidden="true">
                  <svg viewBox="-20 -46 40 50" width="34" height="42">
                    <Plant mood={m.id} stage={3} seed={3} />
                  </svg>
                </span>
                <span className="mg-mood-label">{m.label}</span>
              </button>
            ))}
          </div>
          {todayMood && (
            <button type="button" className="mg-cancel" onClick={() => setPicking(false)}>
              Leave it as it is
            </button>
          )}
        </div>
      ))}

      {!loading && (
        <button type="button" className="mg-more" onClick={() => setDetail(true)}>
          What has grown
        </button>
      )}

      {detail && (
        <Portal>
          <Sheet onClose={() => setDetail(false)} label="What has grown in your garden">
            <h2 className="mg-sheet-title">What has grown</h2>
            <p className="mg-sheet-sub">
              Nobody else can see this — not from their phone, not from the
              server. It never leaves this device.
            </p>

            <ul className="mg-legend">
              {MOODS.map((m) => {
                const n = garden.counts[m.id] ?? 0
                return (
                  <li key={m.id} className={`mg-legend-row${n ? '' : ' is-dim'}`}>
                    <span className="mg-legend-art" aria-hidden="true">
                      <svg viewBox="-20 -46 40 50" width="28" height="35">
                        <Plant mood={m.id} stage={n ? 3 : 0} seed={11} />
                      </svg>
                    </span>
                    <span className="mg-legend-copy">
                      <span className="mg-legend-name">{m.plant}</span>
                      <span className="mg-legend-note">
                        {n ? `${n} in the garden` : 'not planted yet'}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>

            <h3 className="mg-sheet-h3">Found so far</h3>
            <ul className="mg-unlocks">
              {garden.unlocks.map((u) => (
                <li key={u.id} className={`mg-unlock${u.unlocked ? ' is-on' : ''}`}>
                  <span className="mg-unlock-name">{u.unlocked ? u.label : 'Something else'}</span>
                  <span className="mg-unlock-line">{u.line}</span>
                </li>
              ))}
            </ul>

            <button type="button" className="mg-erase" onClick={erase}>
              Clear the garden
            </button>
            <p className="mg-erase-note">
              This cannot be undone, and there is no copy of it anywhere else.
            </p>
          </Sheet>
        </Portal>
      )}
    </section>
  )
}

/* ==========================================================================
   The scene.

   One SVG. Nothing here is an image file and nothing is fetched — the whole
   garden is about eighty path commands, which is the same reason DinoRun
   draws rectangles instead of loading sprites.
   ========================================================================== */
function Scene({ garden, extras, loading }) {
  const dawn = extras.has('dawn')
  const night = !dawn && (garden.counts.heavy ?? 0) >= (garden.counts.bright ?? 0) && garden.total > 0

  return (
    <div className={`mg-scene${dawn ? ' is-dawn' : ''}${night ? ' is-night' : ''}`}>
      <svg
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        className="mg-svg"
        role="img"
        aria-label={SCENE_LABEL}
        preserveAspectRatio="xMidYMax meet"
      >
        <defs>
          <linearGradient id="mg-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="mg-sky-a" />
            <stop offset="1" className="mg-sky-b" />
          </linearGradient>
          <linearGradient id="mg-soil" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8fae6a" />
            <stop offset="1" stopColor="#6f8f4e" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width={PLOT_W} height={PLOT_H} fill="url(#mg-sky)" />

        {extras.has('moon') && <circle className="mg-moon" cx="268" cy="34" r="13" />}

        {extras.has('hedge') && (
          <g className="mg-hedge">
            <rect x="-4" y="84" width={PLOT_W + 8} height="16" rx="8" fill="#5c7f43" />
            <rect x="-4" y="88" width={PLOT_W + 8} height="12" rx="6" fill="#6b9150" />
          </g>
        )}

        <ellipse cx={PLOT_W / 2} cy={PLOT_H + 26} rx={PLOT_W} ry="72" fill="url(#mg-soil)" />

        {extras.has('fireflies') && (
          <g className="mg-flies" aria-hidden="true">
            {FLY_SPOTS.map((f, i) => (
              <circle key={i} className={`mg-fly mg-fly-${i % 3}`} cx={f.x} cy={f.y} r="2.1" />
            ))}
          </g>
        )}

        {garden.plants.map((p) => (
          <g key={p.key} transform={`translate(${p.x} ${p.y}) scale(${p.scale})`}>
            <ellipse className="mg-shadow" cx="0" cy="2" rx={7 * p.height + 3} ry="2.4" />
            <Plant mood={p.mood} stage={p.stage} seed={p.seed} height={p.height} />
          </g>
        ))}

        {extras.has('dew') &&
          garden.plants.slice(0, 8).map((p) => (
            <circle
              key={`d${p.key}`}
              className="mg-dew"
              cx={p.x + 5}
              cy={p.y - 22 * p.height}
              r="1.5"
            />
          ))}
      </svg>

      {!loading && garden.total === 0 && (
        <p className="mg-empty">Choose how today feels.</p>
      )}
    </div>
  )
}

const FLY_SPOTS = [
  { x: 54, y: 62 }, { x: 108, y: 48 }, { x: 166, y: 66 },
  { x: 214, y: 44 }, { x: 258, y: 70 }, { x: 292, y: 54 },
]

/* ==========================================================================
   One plant.

   Drawn from the base upward, so a stage is just a shorter stem and a
   different head. `height` scales the stem; the head follows it, which is
   what makes a sprout read as the same species as the bloom next to it.

   The petal colours are literal hex from MOODS and deliberately do not move
   between light and dark — a bluebell is a bluebell at 2am, for the same
   reason the four vibrant fills are fixed. They are content, not chrome.
   ========================================================================== */
function Plant({ mood, stage, seed = 0, height = 1 }) {
  const m = moodById(mood)
  if (!m) return null
  const h = 20 + 26 * height
  const lean = ((seed >>> 3) % 5) - 2
  const top = -h

  return (
    <g className={`mg-plant mg-motion-${m.motion}`}>
      <path
        d={`M0 0 Q ${lean * 0.6} ${top / 2} ${lean} ${top}`}
        stroke={m.stem}
        strokeWidth={1.7}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d={`M0 ${top * 0.42} q -7 -3 -9 -8 q 7 0 9 8`}
        fill={m.stem}
        opacity="0.95"
      />
      {stage >= 1 && (
        <path
          d={`M0 ${top * 0.62} q 7 -3 9 -8 q -7 0 -9 8`}
          fill={m.stem}
          opacity="0.85"
        />
      )}
      <g transform={`translate(${lean} ${top})`}>
        {stage === 0 && <circle cx="0" cy="1" r="2.6" fill={m.stem} />}
        {stage === 1 && <ellipse cx="0" cy="0" rx="2.4" ry="3.6" fill={m.petal2} />}
        {stage === 2 && <Bud mood={m} />}
        {stage === 3 && <Head mood={m} seed={seed} />}
      </g>
    </g>
  )
}

function Bud({ mood }) {
  return (
    <g>
      <ellipse cx="0" cy="-2" rx="3.4" ry="5" fill={mood.petal2} />
      <path d="M-3.4 0 q 3.4 4 6.8 0 q -3.4 2.4 -6.8 0" fill={mood.stem} />
    </g>
  )
}

function Head({ mood, seed }) {
  switch (mood.id) {
    case 'bright': {
      const n = 8
      return (
        <g>
          {Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2
            return (
              <ellipse
                key={i}
                cx={Math.cos(a) * 5.4}
                cy={Math.sin(a) * 5.4}
                rx="4.2"
                ry="2.5"
                fill={i % 2 ? mood.petal2 : mood.petal}
                transform={`rotate(${(a * 180) / Math.PI} ${Math.cos(a) * 5.4} ${Math.sin(a) * 5.4})`}
              />
            )
          })}
          <circle cx="0" cy="0" r="3.4" fill={mood.heart} />
        </g>
      )
    }
    case 'tender': {
      const n = 5
      return (
        <g>
          {Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2 - Math.PI / 2
            return (
              <circle
                key={i}
                cx={Math.cos(a) * 4.6}
                cy={Math.sin(a) * 4.6}
                r="3.5"
                fill={i % 2 ? mood.petal : mood.petal2}
              />
            )
          })}
          <circle cx="0" cy="0" r="2" fill={mood.heart} />
        </g>
      )
    }
    case 'restless': {
      const n = 5
      return (
        <g>
          {Array.from({ length: n }, (_, i) => {
            const spread = (i - (n - 1) / 2) * 7
            return (
              <path
                key={i}
                d={`M0 2 q ${spread * 0.5} -6 ${spread} -11`}
                stroke={i % 2 ? mood.petal : mood.petal2}
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            )
          })}
        </g>
      )
    }
    case 'calm': {
      const n = 6
      return (
        <g>
          {Array.from({ length: n }, (_, i) => (
            <ellipse
              key={i}
              cx={((seed >> (i + 1)) % 3) - 1}
              cy={-i * 3.4}
              rx={3.1 - i * 0.28}
              ry={2.2 - i * 0.16}
              fill={i % 2 ? mood.petal : mood.petal2}
            />
          ))}
        </g>
      )
    }
    case 'low': {
      const n = 3
      return (
        <g>
          {Array.from({ length: n }, (_, i) => {
            const x = (i - 1) * 4.6
            const y = i === 1 ? 1.4 : 0
            return (
              <g key={i} transform={`translate(${x} ${y})`}>
                <path d="M0 -2 v3" stroke={mood.stem} strokeWidth="1" />
                <path
                  d="M-3 1 q 3 7 6 0 q -3 2.6 -6 0"
                  fill={i % 2 ? mood.petal2 : mood.petal}
                />
              </g>
            )
          })}
        </g>
      )
    }
    case 'heavy':
    default: {
      return (
        <g>
          <path d="M0 -1 q -7 -2 -6 -8 q 4 1 6 8" fill={mood.petal} />
          <path d="M0 -1 q 7 -2 6 -8 q -4 1 -6 8" fill={mood.petal} />
          <path d="M0 -1 q -1.5 -8 0 -10 q 1.5 2 0 10" fill={mood.petal2} />
          <path d="M0 0 q -6 3 -7 8 q 5 -1 7 -8" fill={mood.petal2} />
          <path d="M0 0 q 6 3 7 8 q -5 -1 -7 -8" fill={mood.petal2} />
          <circle cx="0" cy="-1" r="1.8" fill={mood.heart} />
        </g>
      )
    }
  }
}
