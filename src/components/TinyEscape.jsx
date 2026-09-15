import { useCallback, useEffect, useRef, useState } from 'react'
import Portal from './Portal'
import { useBackLayer } from '../hooks/useBackLayer'
import { CloseIcon, PlayIcon, ReplayIcon } from './Icons'
import {
  NUMBER_LABEL,
  OBJECTS,
  OBJECT_LABEL,
  answerCode,
  clearFeedback,
  createRoom,
  hintFor,
  isSolved,
  nudgeDial,
  submitCode,
  tapBell,
  tapObject,
  timeLabel,
} from '../lib/escapeRoom'
import { openChime, primeChime, releaseChime, strike } from '../lib/chime'
import '../styles/escape.css'

// ============================================================================
// TINY ESCAPE ROOM — the entry component for the "Your little break" slot.
//
// Takes no props and owns its own overlay, so it drops into a slot with one
// line and nothing else has to know it exists. The rules are all in
// lib/escapeRoom.js — pure, seeded, and walked end to end in
// tests/escape-room.test.js — because a puzzle whose only definition is the
// component that draws it is a puzzle nobody can prove is solvable.
//
// NO ASSETS. The room is SVG and CSS; the bells are generated with the Web
// Audio API (lib/chime.js). Egress is the scarcest resource in this app and a
// three-minute game is not worth a byte of it.
//
// SOUND IS A SECOND CHANNEL, NEVER THE ONLY ONE. Every note of the phrase
// also lights its bell, so the whole room is solvable with the phone on
// silent, in a browser with no AudioContext, or by someone who cannot hear
// it. `strike()` reports whether anything actually sounded, and the room says
// so rather than leaving a player waiting for audio that will not arrive.
//
// NOTHING PUNISHES. No timer running down, no attempt limit, no score, no
// best time kept, nowhere to compare a run against anybody. A wrong code
// leaves the dials where they were. After a few misses on a lock, a nudge
// appears — the failure state of a three-minute game is being stuck, not
// being insufficiently challenged.
//
// MOTION: three one-shot CSS animations, each landing on its finished state,
// plus a local prefers-reduced-motion block in escape.css. The bell flash is
// information rather than decoration, so it stays: it is the muted player's
// only copy of the phrase.
// ============================================================================

const STEP_MS = 420

export default function TinyEscape() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <section className="er-card" aria-label="Tiny escape room">
        <div className="er-card-copy">
          <p className="er-eyebrow">A small room</p>
          <h2 className="er-card-title">Tiny escape room</h2>
          <p className="er-card-line">Three locks, a few minutes, a different room each time.</p>
          <span className="er-chip">2–5 min</span>
        </div>
        <button
          type="button"
          className="er-go"
          onClick={() => {
            primeChime() // must ride the tap: mobile keeps audio silent otherwise
            setOpen(true)
          }}
          aria-label="Start the escape room"
        >
          <PlayIcon />
        </button>
      </section>
      {open && <RoomOverlay onClose={() => setOpen(false)} />}
    </>
  )
}

function RoomOverlay({ onClose }) {
  const [room, setRoom] = useState(() => createRoom())
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [elapsed, setElapsed] = useState(null)
  const [lit, setLit] = useState(null)
  const [audioOk, setAudioOk] = useState(true)
  const timers = useRef([])

  useBackLayer(true, onClose)

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }, [])

  useEffect(() => () => {
    timers.current.forEach(clearTimeout)
    releaseChime()
  }, [])

  // Feedback is a value on the room, so it has to be taken back off again.
  useEffect(() => {
    if (!room.feedback) return undefined
    const t = setTimeout(() => setRoom((r) => clearFeedback(r)), 900)
    return () => clearTimeout(t)
  }, [room.feedback, room.tapped.length, room.heard.length])

  const playPhrase = useCallback(() => {
    clearTimers()
    let heard = false
    room.phrase.forEach((note, i) => {
      if (strike(note, (i * STEP_MS) / 1000)) heard = true
      timers.current.push(setTimeout(() => setLit(note), i * STEP_MS))
      timers.current.push(setTimeout(() => setLit(null), i * STEP_MS + STEP_MS - 90))
    })
    setAudioOk(heard)
  }, [room.phrase, clearTimers])

  const press = (i) => {
    strike(i)
    setLit(i)
    timers.current.push(setTimeout(() => setLit(null), 220))
    setRoom((r) => tapBell(r, i))
  }

  const tryLock = () => {
    setRoom((r) => {
      const next = submitCode(r)
      if (isSolved(next) && !isSolved(r)) {
        openChime()
        setElapsed(Date.now() - startedAt)
      }
      return next
    })
  }

  const again = () => {
    clearTimers()
    setRoom(createRoom())
    setStartedAt(Date.now())
    setElapsed(null)
    setLit(null)
  }

  const hint = hintFor(room)
  const wrong = room.feedback === 'wrong'

  return (
    <Portal>
      <div className="er" role="dialog" aria-modal="true" aria-label="Tiny escape room">
        <header className="er-top">
          <div className="er-progress" aria-label={`Lock ${Math.min(room.stage + 1, 3)} of 3`}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={`er-pip${room.stage > i ? ' is-done' : ''}${room.stage === i ? ' is-now' : ''}`} />
            ))}
          </div>
          <button type="button" className="er-close" onClick={onClose} aria-label="Leave the room">
            <CloseIcon />
          </button>
        </header>

        <div className="er-body">
          {room.stage === 0 && <Picture room={room} onTap={(id) => setRoom((r) => tapObject(r, id))} />}
          {room.stage === 1 && (
            <Chime
              room={room}
              lit={lit}
              audioOk={audioOk}
              onPlay={playPhrase}
              onPress={press}
            />
          )}
          {room.stage === 2 && (
            <Lock
              room={room}
              onNudge={(slot, by) => setRoom((r) => nudgeDial(r, slot, by))}
              onSubmit={tryLock}
            />
          )}
          {room.stage === 3 && <Out elapsed={elapsed} onAgain={again} onClose={onClose} />}

          <p className={`er-say${wrong ? ' is-wrong' : ''}`} role="status">
            {wrong ? 'Not that. Start the sequence again.' : ' '}
          </p>
          {hint && <p className="er-hint">{hint}</p>}
        </div>
      </div>
    </Portal>
  )
}

/* ==========================================================================
   Lock 1 — the picture on the wall is the order; the shapes are on the things.
   ========================================================================== */
function Picture({ room, onTap }) {
  return (
    <section className="er-stage">
      <h2 className="er-h">The drawer is stuck</h2>
      <p className="er-sub">The picture on the wall wants the things in its order.</p>

      <div className="er-frame">
        {room.order.map((s, i) => (
          <span key={s} className="er-frame-shape">
            <Shape kind={s} size={22} />
            <span className="er-frame-n">{i + 1}</span>
          </span>
        ))}
      </div>

      <div className="er-objects">
        {OBJECTS.map((id) => {
          const done = room.tapped.includes(id)
          return (
            <button
              key={id}
              type="button"
              className={`er-obj${done ? ' is-done' : ''}`}
              onClick={() => onTap(id)}
              aria-label={`Touch ${OBJECT_LABEL[id]}`}
              aria-pressed={done}
            >
              <span className="er-obj-art" aria-hidden="true">
                <ObjectArt id={id} n={room.numbers[id]} />
              </span>
              <span className="er-obj-mark" aria-hidden="true">
                <Shape kind={room.shapes[id]} size={15} />
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/* ==========================================================================
   Lock 2 — play it back. The bells light as they sound, so silence costs
   nothing but the atmosphere.
   ========================================================================== */
function Chime({ room, lit, audioOk, onPlay, onPress }) {
  return (
    <section className="er-stage">
      <h2 className="er-h">A chime, in the drawer</h2>
      <p className="er-sub">
        {audioOk
          ? 'Hear it once, then play it back. The bells light up too.'
          : 'This device is not making a sound, so watch which bell lights.'}
      </p>

      <button type="button" className="er-play" onClick={onPlay}>
        <ReplayIcon />
        <span>Play it</span>
      </button>

      <div className="er-bells" role="group" aria-label="The three bells">
        {[0, 1, 2].map((i) => (
          <button
            key={i}
            type="button"
            className={`er-bell er-bell-${i}${lit === i ? ' is-lit' : ''}`}
            onClick={() => onPress(i)}
            aria-label={`Bell ${i + 1}`}
          >
            <svg viewBox="0 0 48 52" width="100%" height="100%" aria-hidden="true">
              <path
                d="M24 6 C33 6 38 14 38 26 v9 h4 v5 H6 v-5 h4 v-9 C10 14 15 6 24 6 z"
                fill="currentColor"
              />
              <circle cx="24" cy="45" r="4" fill="currentColor" opacity="0.75" />
            </svg>
          </button>
        ))}
      </div>

      <div className="er-beads" aria-label={`${room.heard.length} of ${room.phrase.length} played back`}>
        {room.phrase.map((_, i) => (
          <span key={i} className={`er-bead${i < room.heard.length ? ' is-on' : ''}`} />
        ))}
      </div>
    </section>
  )
}

/* ==========================================================================
   Lock 3 — the numbers have been in the room since the first second; the slip
   only says what order they go in.
   ========================================================================== */
function Lock({ room, onNudge, onSubmit }) {
  return (
    <section className="er-stage">
      <h2 className="er-h">Three dials on the door</h2>

      <div className="er-slip">
        <p className="er-slip-line">
          {room.codeOrder.map((id) => OBJECT_LABEL[id]).join(', then ')}
        </p>
      </div>

      <ul className="er-recall">
        {room.codeOrder.map((id) => (
          <li key={id}>
            <span className="er-recall-obj">{OBJECT_LABEL[id]}</span>
            <span className="er-recall-what">{NUMBER_LABEL[id]}</span>
          </li>
        ))}
      </ul>

      <div className="er-dials">
        {room.dials.map((d, i) => (
          <div className="er-dial" key={i}>
            <button type="button" onClick={() => onNudge(i, 1)} aria-label={`Dial ${i + 1} up`}>+</button>
            <span className="er-dial-n" aria-label={`Dial ${i + 1} reads ${d}`}>{d}</span>
            <button type="button" onClick={() => onNudge(i, -1)} aria-label={`Dial ${i + 1} down`}>−</button>
          </div>
        ))}
      </div>

      <button type="button" className="er-try" onClick={onSubmit}>Try the lock</button>

      <div className="er-objects er-objects-small">
        {OBJECTS.map((id) => (
          <div key={id} className="er-obj is-still">
            <span className="er-obj-art" aria-hidden="true">
              <ObjectArt id={id} n={room.numbers[id]} />
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ==========================================================================
   Out. A fact and two buttons — no best time, nothing kept, nobody to beat.
   ========================================================================== */
function Out({ elapsed, onAgain, onClose }) {
  return (
    <section className="er-stage er-out">
      <div className="er-door" aria-hidden="true">
        <svg viewBox="0 0 120 150" width="150" height="180">
          <rect x="6" y="6" width="108" height="140" rx="8" fill="#3b3a46" />
          <rect className="er-door-leaf" x="14" y="14" width="92" height="124" rx="6" fill="#c4a5e8" />
          <circle cx="94" cy="78" r="4" fill="#3b3a46" />
        </svg>
      </div>
      <h2 className="er-h">Out.</h2>
      {elapsed != null && <p className="er-sub">{timeLabel(elapsed)}, from the first lock.</p>}
      <div className="er-out-actions">
        <button type="button" className="er-try" onClick={onAgain}>Another room</button>
        <button type="button" className="er-quiet" onClick={onClose}>Done</button>
      </div>
    </section>
  )
}

/* ========================================================================== */

function Shape({ kind, size = 18 }) {
  const c = size / 2
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' }
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
      {kind === 'circle' && <circle cx={c} cy={c} r={c - 2} {...common} />}
      {kind === 'square' && <rect x="2" y="2" width={size - 4} height={size - 4} rx="2" {...common} />}
      {kind === 'triangle' && <path d={`M${c} 2 L${size - 2} ${size - 3} L2 ${size - 3} Z`} {...common} />}
      {kind === 'diamond' && <path d={`M${c} 2 L${size - 2} ${c} L${c} ${size - 2} L2 ${c} Z`} {...common} />}
    </svg>
  )
}

// The objects, drawn. The number each one carries is visible from the first
// second of the run — the third lock is not a memory test, it is a question
// about which order they go in.
function ObjectArt({ id, n }) {
  if (id === 'lamp') {
    return (
      <svg viewBox="0 0 60 60" width="100%" height="100%">
        <path d="M30 16 L46 40 H14 Z" fill="#f2c14e" />
        <rect x="28" y="40" width="4" height="14" rx="2" fill="#6c6b78" />
        <rect x="20" y="52" width="20" height="4" rx="2" fill="#6c6b78" />
      </svg>
    )
  }
  if (id === 'clock') {
    const a = ((n % 12) / 12) * Math.PI * 2 - Math.PI / 2
    return (
      <svg viewBox="0 0 60 60" width="100%" height="100%">
        <circle cx="30" cy="30" r="20" fill="#e6e3ef" stroke="#6c6b78" strokeWidth="2.5" />
        <line x1="30" y1="30" x2={30 + Math.cos(a) * 12} y2={30 + Math.sin(a) * 12} stroke="#16161a" strokeWidth="2.6" strokeLinecap="round" />
        <line x1="30" y1="30" x2="30" y2="17" stroke="#16161a" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="30" cy="30" r="2" fill="#16161a" />
      </svg>
    )
  }
  if (id === 'plant') {
    return (
      <svg viewBox="0 0 60 60" width="100%" height="100%">
        <path d="M22 54 h16 l-2 -12 H24 Z" fill="#c07a55" />
        <line x1="30" y1="42" x2="30" y2="22" stroke="#5f8a3a" strokeWidth="2" />
        {Array.from({ length: n }, (_, i) => {
          const side = i % 2 ? 1 : -1
          const y = 40 - i * (18 / Math.max(1, n))
          return (
            <path
              key={i}
              d={`M30 ${y} q ${side * 9} -3 ${side * 12} -8 q ${-side * 9} 1 ${-side * 12} 8`}
              fill="#6d9445"
            />
          )
        })}
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 60 60" width="100%" height="100%">
      <path d="M8 18 q 22 -6 22 4 v28 q 0 -8 -22 -2 Z" fill="#dcd8e6" />
      <path d="M52 18 q -22 -6 -22 4 v28 q 0 -8 22 -2 Z" fill="#efecf5" />
      <text x="41" y="42" textAnchor="middle" fontSize="13" fontWeight="700" fill="#4a52c4">{n}</text>
    </svg>
  )
}

export { answerCode }
