import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DinoRun from '../components/DinoRun'
import EmojiDetective from '../components/EmojiDetective'
import MemoryFlip from '../components/MemoryFlip'
import MoodGarden from '../components/MoodGarden'
import MysteryBox from '../components/MysteryBox'
import TinyEscape from '../components/TinyEscape'
import { ArrowIcon, BackIcon, GridIcon, SmileyIcon } from '../components/Icons'
import { useBackLayer } from '../hooks/useBackLayer'
import { calmForDay } from '../lib/calmPrompts'
import { istToday } from '../lib/db'
import { emptyTotals, mergeRun, missionForDay, progressOf } from '../lib/missions'
import { boxForDay } from '../lib/mysteryBox'
import {
  readRunnerBest,
  recordRunnerScore,
  saveBox,
  saveMission,
  soloForDay,
} from '../lib/soloProgress'
import '../styles/solo.css'

// "Your little break" — the ONE solo surface.
//
// Everything a person can do on their own lives here: the runner and its
// secret mission, today's Mystery Box, Emoji Detective, Memory Flip, a tiny
// escape room, the mood garden, personal bests and one calming line. Play
// keeps a single card that opens this screen. Two competing solo shelves is
// what this screen exists to stop — a game reachable from two places is a game
// whose state is kept in two places soon afterwards.
//
// The owner's five sections are in the owner's order — Continue your game ·
// Today's Mystery Box · Your mood garden · Personal bests · One calming prompt
// — with the other three puzzles grouped straight after the box, which is
// where a puzzle belongs.
//
// THREE RULES THIS SCREEN IS BUILT ON.
//
// 1. DEVICE-LOCAL. Nothing here touches the database, and there is no
//    migration behind any of it. What somebody plays alone, how many goes it
//    took them and what hour of the night they were doing it are nobody's
//    business; this app does not collect that about messages and it is not
//    going to start with solitaire. lib/soloProgress.js wraps every read and
//    write so a private-mode throw or a full quota degrades to "we do not
//    know" instead of crashing or claiming a confident zero.
//
// 2. THE DAY IS THE ONLY SCHEDULE. The puzzle, the mission and the calming
//    line are pure functions of the IST day plus a per-user phase
//    (lib/dayCycle.js, epoch 2024-01-01 — the one day-number module in the
//    client) — a cycle, not a draw, so everything is seen once before anything
//    repeats, and adding a puzzle lengthens the cycle by itself. No schedule
//    is stored anywhere, which is also why missing a day costs nothing:
//    tomorrow simply computes tomorrow's.
//
// 3. NO PUNISHMENT, NO COMPARISON. There is no consecutive-day counter, no
//    "you broke" anything, no nudge to come back, and nobody else's numbers
//    appear anywhere. Personal bests only ever go up. A usage streak was
//    considered and rejected outright — it is the exact Snapchat mechanic this
//    app copies for messages and must not copy for attention.

const safeToday = () => {
  try {
    return istToday()
  } catch {
    // An Intl build with no Asia/Kolkata. Better to say we do not know the day
    // than to hand somebody a different day's puzzle from their own phone.
    return null
  }
}

// Every number here is the player's own, and each one only ever goes up. There
// is deliberately nothing to compare them against.
function Bests({ store, runnerBest }) {
  if (store === undefined) {
    return <p className="solo-sub">Looking…</p>
  }
  // A failed read is NOT "you have no personal bests" — that is a claim, and
  // it is the exact bug this codebase has found seven times.
  if (store === null) {
    return (
      <p className="solo-sub">
        This device wouldn’t tell us what it has saved. Nothing is lost; it just can’t be read
        right now.
      </p>
    )
  }
  const bests = store.bests ?? {}
  const tiles = [
    { key: 'runner', label: 'Runner best', value: Math.max(bests.runner ?? 0, runnerBest ?? 0) },
    { key: 'obstacles', label: 'Best clear', value: bests.obstacles ?? 0 },
    { key: 'boxes', label: 'Boxes opened', value: bests.boxes ?? 0 },
    { key: 'missions', label: 'Missions done', value: bests.missions ?? 0 },
    { key: 'stars', label: 'Stars found', value: bests.stars ?? 0 },
    { key: 'cases', label: 'Cases solved', value: store.detective?.total ?? 0 },
    { key: 'boards', label: 'Boards cleared', value: store.flip?.played ?? 0 },
  ]
  return (
    <div className="solo-bests">
      {tiles.map((tile) => (
        <div className="solo-best" key={tile.key}>
          <span className="solo-best-num">{tile.value}</span>
          <span className="solo-best-label">{tile.label}</span>
        </div>
      ))}
    </div>
  )
}

// The three games that own their whole card get a door rather than being
// inlined seven cards deep: a scroll where every game is fully unpacked is a
// screen nobody reaches the bottom of.
function Door({ icon, title, sub, onOpen }) {
  return (
    <button type="button" className="play-card solo-door" onClick={onOpen}>
      <span className="fp-row-icon">{icon}</span>
      <span className="fp-row-text">
        <span className="play-title">{title}</span>
        <span className="play-sub">{sub}</span>
      </span>
    </button>
  )
}

export default function SoloPlay({ me = '', onBack }) {
  const [day, setDay] = useState(safeToday)
  const [view, setView] = useState('home') // home | run | detective | flip
  const [store, setStore] = useState(undefined) // undefined | null | object
  const [totals, setTotals] = useState(() => emptyTotals())
  const [runnerBest, setRunnerBest] = useState(0)
  const totalsRef = useRef(totals)
  totalsRef.current = totals

  const home = useCallback(() => setView('home'), [])
  // Back closes the open game first and the screen second, one layer at a
  // time. TinyEscape and MoodGarden register their own overlays themselves.
  useBackLayer(view !== 'home', home)

  // A phone left open across midnight would otherwise still be showing
  // yesterday's box. Cheap to check, and only when the app is looked at again.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      const today = safeToday()
      setDay((current) => (today === current ? current : today))
    }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
    }
  }, [])

  const mission = useMemo(() => missionForDay(day, me), [day, me])
  const puzzle = useMemo(() => boxForDay(day, me), [day, me])
  const calm = useMemo(() => calmForDay(day, me), [day, me])
  const missionId = mission?.id ?? null

  // One read per day, and the day's mission totals come with it. A failed read
  // leaves `store` null (the bests card says so) while the totals fall back to
  // an in-memory count, so the mission still tracks for this session.
  useEffect(() => {
    const saved = soloForDay(day)
    setStore(saved)
    setRunnerBest(readRunnerBest() ?? 0)
    const carried = saved && saved.mission?.id === missionId ? saved.mission.totals : null
    setTotals({ ...emptyTotals(), ...(carried ?? {}) })
  }, [day, missionId])

  const progress = progressOf(mission, totals)
  const missionDone = (store?.mission?.id === missionId && store?.mission?.done) || progress?.done || false

  // One write per finished run: the day's totals (with `done` sticky, so a
  // mission finished at lunch stays finished) and then the best score, which
  // shares the long-standing 'meera:dino-best' key so the two numbers cannot
  // drift apart. Both are best-effort — a refused write changes nothing on
  // screen for this session.
  const handleRunEnd = useCallback((watch, score) => {
    const next = mergeRun(totalsRef.current, watch, score)
    setTotals(next)
    saveMission(day, mission?.id ?? null, next, progressOf(mission, next)?.done ?? false)
    setStore(recordRunnerScore(day, score))
    setRunnerBest((current) => Math.max(current, Math.trunc(score) || 0))
  }, [day, mission])

  // Today's saved box only counts if it is today's PUZZLE. The store is keyed
  // by device rather than by account — it is device-local, there is no server
  // to key it against — so if someone else signs in on this phone their phase
  // gives them a different puzzle on the same day, and the previous person's
  // "solved" must not open it for them.
  const box = store === null ? null : store === undefined ? undefined
    : store.box.id && puzzle && store.box.id !== puzzle.id
      ? { solved: false, revealed: false, attempts: 0, id: null }
      : store.box

  if (view === 'run') {
    return (
      <div className="app solo-screen">
        <div className="header">
          <button type="button" className="circle filled" onClick={home} aria-label="Back">
            <BackIcon />
          </button>
          <h1>Today’s Runner</h1>
        </div>
        <div className="list profile-list">
          <DinoRun best={runnerBest} mission={mission} totals={totals} onRunEnd={handleRunEnd} />
          {mission && (
            <p className="solo-sub solo-run-note">
              {mission.blurb} {missionDone ? 'Done for today — keep running if you like.' : 'No rush; it resets tomorrow either way.'}
            </p>
          )}
          <p className="solo-sub">Your scores stay on this phone.</p>
        </div>
      </div>
    )
  }

  if (view === 'detective' || view === 'flip') {
    return (
      <div className="app solo-screen">
        <div className="header">
          <button type="button" className="circle filled" onClick={home} aria-label="Back">
            <BackIcon />
          </button>
          <h1>{view === 'detective' ? 'Emoji Detective' : 'Memory Flip'}</h1>
        </div>
        <div className="list profile-list">
          {view === 'detective'
            ? <EmojiDetective playerId={me} />
            : <MemoryFlip playerId={me} />}
          <p className="solo-sub">Nothing here is sent anywhere. It changes at midnight IST.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app solo-screen">
      <div className="header">
        <button type="button" className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Your little break</h1>
      </div>
      <div className="list profile-list solo-list">
        {/* 1 — Continue your game */}
        <section className="solo-card solo-continue" aria-labelledby="solo-run-h">
          <span className="eyebrow">Continue your game</span>
          <h2 className="solo-h" id="solo-run-h">Today’s Runner</h2>
          <div className="solo-chips">
            <span className="chip">Best {runnerBest}</span>
            {progress && (
              <span className="chip">
                {missionDone ? 'Mission done' : `${progress.value} of ${progress.goal} ${progress.unit}`}
              </span>
            )}
          </div>
          {mission ? (
            <p className="solo-sub">
              <strong>Secret mission · {mission.title}.</strong> {mission.blurb}
            </p>
          ) : (
            <p className="solo-sub">One tap to start, one tap to jump.</p>
          )}
          <button type="button" className="circle dark solo-go" onClick={() => setView('run')} aria-label="Play the runner">
            <ArrowIcon />
          </button>
        </section>

        {/* 2 — Today's Mystery Box */}
        <MysteryBox
          puzzle={puzzle}
          progress={box}
          onSolved={() => setStore(saveBox(day, { solved: true, id: puzzle?.id ?? null }))}
          onRevealed={() => setStore(saveBox(day, { revealed: true, id: puzzle?.id ?? null }))}
          onAttempt={() => setStore(saveBox(day, { attempts: (box?.attempts ?? 0) + 1, id: puzzle?.id ?? null }))}
        />

        {/* 3 — the other puzzles. Doors rather than inlined cards: each of
            these draws a whole game, and seven unpacked games in one scroll is
            a screen whose bottom half nobody ever sees. */}
        <section className="solo-more" aria-labelledby="solo-more-h">
          <span className="eyebrow" id="solo-more-h">More to play</span>
          <Door
            icon={<SmileyIcon width={20} height={20} />}
            title="Emoji Detective"
            sub="Decode a film, song, feeling or phrase. One case a day."
            onOpen={() => setView('detective')}
          />
          <Door
            icon={<GridIcon width={20} height={20} />}
            title="Memory Flip"
            sub="Faces, places, little things and colours. Match the pairs."
            onOpen={() => setView('flip')}
          />
        </section>

        {/* 4 — the escape room. It draws its own card and owns its own
            overlay, so it lands with one line and nothing else has to know. */}
        <TinyEscape />

        {/* 5 — Your mood garden. It takes NO PROPS on purpose: a mood history
            one partner can see about the other is a coercive-control vector,
            and `MoodGarden.length === 0` is asserted in tests. Passing it
            anything at all is the wrong wiring, not a shortcut. */}
        <MoodGarden />

        {/* 6 — Personal bests */}
        <section className="solo-card solo-bests-card" aria-labelledby="solo-bests-h">
          <span className="eyebrow">Personal bests</span>
          <h2 className="solo-h" id="solo-bests-h">Only yours</h2>
          <Bests store={store} runnerBest={runnerBest} />
          <p className="solo-sub">These live on this phone. No one else’s numbers appear here, and yours go nowhere.</p>
        </section>

        {/* 7 — One calming prompt */}
        <section className="solo-card solo-calm" aria-labelledby="solo-calm-h">
          <span className="eyebrow">One calming prompt</span>
          <h2 className="solo-h" id="solo-calm-h">{calm ? 'For right now' : 'Back tomorrow'}</h2>
          {calm ? (
            <p className="solo-calm-line">{calm.line}</p>
          ) : (
            <p className="solo-sub">We can’t tell which day this device thinks it is, so there’s no line for today.</p>
          )}
          {/* One slow breath, and it genuinely stops for anyone who has asked
              their OS for less motion — the global rule in index.css caps
              iteration count at 1, and this is the only looping thing here. */}
          <span className="solo-breathe" aria-hidden="true" />
        </section>
      </div>
    </div>
  )
}
