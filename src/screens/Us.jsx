import { lazy, useCallback, useEffect, useState } from 'react'
import {
  clearStatusNote,
  getStreaks,
  listActiveGameRooms,
  listFriendsWithProfiles,
  listPromptStatus,
  listStatusNotes,
  setStatusNote,
} from '../lib/db'
import { daySnapshot, istDay, pendingForDay } from '../lib/questionDay'
import { playState, roomWith } from '../lib/gameState'
import { useAlias } from '../hooks/useAliasClock'
import { useBackLayer } from '../hooks/useBackLayer'
import { useToast } from '../hooks/useToast'
import { useSaveState } from '../lib/useSaveState'
import Avatar from '../components/Avatar'
import Portal from '../components/Portal'
import SaveState from '../components/SaveState'
import SettingsGroup from '../components/SettingsGroup'
import Sheet from '../components/Sheet'
import {
  ArrowIcon,
  BackIcon,
  ChatIcon,
  GamepadIcon,
  HeartIcon,
  ImageIcon,
  MapIcon,
  NoteIcon,
  SparkIcon,
} from '../components/Icons'
import UsPair from '../components/UsPair'
import Memories from './Memories'
import Together from './Together'
import '../styles/privacy.css'
import '../styles/us.css'

// ONE import strategy for Play. App.jsx already reaches this screen through a
// `lazy()` — the from-a-conversation route — and Us used to reach the same
// module through a STATIC import. Rollup resolved that by hoisting Play into
// its own chunk and giving the Us chunk a static edge to it, so merely opening
// the Us tab downloaded Play's ~88 kB of JS and ~25 kB of CSS (seven games,
// three boards) whether or not anybody tapped Play. Two entrances, yes — two
// import strategies, no. The dynamic import is the same specifier App uses, so
// both routes now share one chunk that arrives when Play is actually opened.
//
// It suspends up to the boundary App wraps the whole overlay in; there is
// deliberately no second Suspense here, since a fallback inside a screen that
// is itself being replaced would flash twice.
const PlayTogether = lazy(() => import('./PlayTogether'))

// Snap Map is a pair surface — where your friends are — and until now it was
// the one such surface left outside this screen, reached from a small circular
// button in the chat-list header. That button is gone; this is its one door.
// See "When a screen may have more than one entrance" in CLAUDE.md: the chip in
// a conversation earns Play a second door because it resumes THAT pair's board,
// which browsing cannot express. A shortcut to the same undifferentiated map
// carries no second intent, so it was a duplicate rather than an entrance.
const SnapMap = lazy(() => import('./SnapMap'))

// The pair layer — everything in Meera that is about two people.
//
// All of it already existed; none of it was findable. Together, Play and the
// solo games hung off Profile, which had become a six-group catch-all menu, and
// "Just us" existed only as a chip inside one conversation. Profile is settings
// again and this is where the two-person surfaces live: Shared moments and Play
// moved here WHOLE rather than being copied, so there is still exactly one door
// to each.
//
// The solo games are deliberately NOT given a second door here. They live on
// "Your little break" inside Play — see the note in PlayTogether.jsx: "ONE door,
// not a shelf … a game reachable from two places is a game whose progress is
// kept in two places soon afterwards."
export default function Us({ me, onBack, openPlay, onPlayOpened, onOpenChat }) {
  const toast = useToast()
  const alias = useAlias()

  const [showMemories, setShowMemories] = useState(false)
  const [showTogether, setShowTogether] = useState(false)
  const [showPlay, setShowPlay] = useState(Boolean(openPlay))
  const [showMap, setShowMap] = useState(false)
  const [picking, setPicking] = useState(false)

  const [note, setNote] = useState('')
  const [noteSaved, setNoteSaved] = useState('')
  const noteSave = useSaveState()

  // undefined = not asked yet, null = the read failed, array = the answer.
  // `[]` is reserved for the answer "nobody is waiting", which is a claim about
  // other people and must never be what a dropped request renders as.
  const [waiting, setWaiting] = useState(undefined)
  const [friends, setFriends] = useState(undefined)
  // Who Us is about. Defaults to your closest pair — the highest streak, the
  // same person ChatList already marks with 💛 — because this is a two-person
  // app and making you pick somebody every single time is what made the screen
  // feel like a directory. Null until the friend list arrives.
  const [who, setWho] = useState(null)

  useEffect(() => {
    if (openPlay) {
      setShowPlay(true)
      onPlayOpened?.()
    }
  }, [openPlay, onPlayOpened])

  useEffect(() => {
    listStatusNotes()
      .then((byUser) => {
        setNoteSaved(byUser[me] ?? '')
        setNote(byUser[me] ?? '')
      })
      .catch(() => {})
  }, [me])

  // One pass for the whole screen: who your friends are, which boards are
  // waiting, and which questions are unanswered today. Fetched when this screen
  // opens rather than polled — the tab bar's badge is what has to be live, and
  // App already keeps that current without this screen being mounted.
  const load = useCallback(async () => {
    const before = istDay()
    const [people, rooms, byUser] = await Promise.all([
      listFriendsWithProfiles(me).catch(() => null),
      listActiveGameRooms().catch(() => null),
      listPromptStatus().catch(() => null),
    ])
    if (!people) {
      // Without the friend list there are no names to put on the rows, and a
      // row that says "someone is waiting" without saying who is worse than no
      // row. null, not [] — this screen renders nothing rather than "nothing
      // is waiting".
      setWaiting(null)
      setFriends(null)
      return
    }
    const accepted = people.filter((f) => f.status === 'accepted' && f.profile).map((f) => f.profile)
    setFriends(accepted)

    if (!rooms && !byUser) {
      setWaiting(null)
      return
    }
    const snapshot = daySnapshot(byUser, before, istDay())
    const items = []
    for (const person of accepted) {
      // roomWith ranks a pair's rooms by what most wants attention, so a person
      // with a checkers game and a Connect Four game gets one row, not two.
      const room = rooms ? roomWith(rooms, person.id, me) : null
      const state = room ? playState(room, me) : null
      if (state?.key === 'your-turn') items.push({ key: `t-${person.id}`, person, text: 'Your turn', to: 'play' })
      else if (state?.key === 'invited') items.push({ key: `i-${person.id}`, person, text: 'Wants to play', to: 'play' })
      // Day-scoped at the point of use: a snapshot that was true when it was
      // fetched stops being true at the end of the IST day it counted.
      const pending = pendingForDay(snapshot, person.id)
      if (pending > 0) {
        items.push({
          key: `q-${person.id}`,
          person,
          text: pending === 1 ? 'Asked you something' : `Asked you ${pending} things`,
          to: 'chat',
        })
      }
    }
    setWaiting(items)
  }, [me])

  useEffect(() => { load() }, [load])

  // Who the screen opens on, in its OWN effect.
  //
  // This started life inside the loader that also builds the waiting signals,
  // and that was wrong for a reason worth keeping: one throw in a shared async
  // function takes everything after it down with it, so a failed streak read
  // would have silently emptied "someone's turn to hear from you". Separate
  // effects fail separately.
  useEffect(() => {
    if (!friends?.length) return undefined
    let alive = true
    const fallback = () => { if (alive) setWho((c) => (c && friends.some((p) => p.id === c) ? c : friends[0]?.id ?? null)) }
    getStreaks(me).then((rows) => {
      if (!alive) return
      setWho((current) => {
        if (current && friends.some((p) => p.id === current)) return current
        const score = (id) => (rows ?? []).find((r) => r.user_a === id || r.user_b === id)?.count ?? 0
        return [...friends].sort((a, b) => score(b.id) - score(a.id))[0]?.id ?? null
      })
    }).catch(fallback)
    return () => { alive = false }
  }, [me, friends])


  const saveNote = async () => {
    const text = note.trim()
    await noteSave.run(async () => {
      if (text) {
        await setStatusNote(me, text)
        toast('Note set — visible to friends for 24h')
      } else {
        await clearStatusNote(me)
        toast('Note cleared')
      }
      setNoteSaved(text)
    })
  }

  const closeMemories = useCallback(() => setShowMemories(false), [])
  const closeTogether = useCallback(() => setShowTogether(false), [])
  const closePlay = useCallback(() => setShowPlay(false), [])
  const closeMap = useCallback(() => setShowMap(false), [])
  const closePicker = useCallback(() => setPicking(false), [])

  // Each sub-screen is its own Back layer, pushed after the layer App holds for
  // this overlay, so Android's Back closes Memories before it closes Us — one
  // press, one layer. Sheet registers its own.
  useBackLayer(showMemories, closeMemories)
  useBackLayer(showTogether, closeTogether)
  useBackLayer(showPlay, closePlay)
  useBackLayer(showMap, closeMap)

  if (showMemories) return <Memories me={me} onBack={closeMemories} />
  if (showTogether) return <Together me={me} onBack={closeTogether} />
  if (showPlay) return <PlayTogether onBack={closePlay} />
  if (showMap) return <SnapMap onBack={closeMap} />

  const openWaiting = (item) => {
    if (item.to === 'play') setShowPlay(true)
    else onOpenChat?.(item.person)
  }

  return (
    <div className="app screen">
      <div className="header pc-head">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Us</h1>
      </div>

      <div className="list profile-list">
        {/* WHO this screen is about. Shown only when there is a choice to make;
            one friend needs no switcher, and a row of one avatar is furniture. */}
        {(friends?.length ?? 0) > 1 && (
          <div className="us-who" role="group" aria-label="Who this is about">
            {friends.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={p.id === who}
                aria-label={alias(p)}
                onClick={() => setWho(p.id)}
              >
                <Avatar profile={p} size="sm" />
              </button>
            ))}
          </div>
        )}

        {/* The pair itself, rather than four rows offering to show it to you. */}
        {who && (
          <UsPair
            me={me}
            friend={friends?.find((p) => p.id === who) ?? null}
            onOpenChat={onOpenChat}
          />
        )}

        {/* The doors that remain, as chips. They were four grey `pc-nav` rows
            reading "Open Memories" / "Open Snap Map" / "Open Together" /
            "Play" — the same component Profile uses for settings, which is
            what made the pair layer read as a directory. */}
        <div className="us-doors" role="group" aria-label="Shared with this person">
          <button type="button" className="us-door" onClick={() => setShowMemories(true)}>
            <ImageIcon width={20} height={20} aria-hidden="true" />
            <span>Memories</span>
          </button>
          <button type="button" className="us-door" onClick={() => setShowMap(true)}>
            <MapIcon width={20} height={20} aria-hidden="true" />
            <span>Snap Map</span>
          </button>
          <button type="button" className="us-door" onClick={() => setShowTogether(true)}>
            <HeartIcon width={20} height={20} aria-hidden="true" />
            <span>Together</span>
          </button>
          <button type="button" className="us-door" onClick={() => setShowPlay(true)}>
            <GamepadIcon width={20} height={20} aria-hidden="true" />
            <span>Play</span>
          </button>
        </div>

        {/* Only when there is genuinely something, and only ever about another
            person. There is deliberately no "you haven't played today" row and
            no place to put one — see the rule at the top of lib/navBadges.js.
            A failed read leaves `waiting` null and renders NOTHING: an absent
            section claims nothing, while "nothing is waiting" is a claim. */}
        {Array.isArray(waiting) && waiting.length > 0 && (
          <SettingsGroup
            eyebrow="Waiting on you"
            title="Someone’s turn to hear from you"
            icon={<SparkIcon width={19} height={19} />}
          >
            {waiting.map((item) => (
              <button key={item.key} className="pc-nav" onClick={() => openWaiting(item)}>
                <span className="pc-nav-icon" aria-hidden="true">
                  {item.to === 'play' ? <GamepadIcon width={19} height={19} /> : <ChatIcon width={19} height={19} />}
                </span>
                <span className="pc-nav-title">{alias(item.person)} · {item.text}</span>
                <span className="pc-nav-go" aria-hidden="true">
                  <ArrowIcon width={17} height={17} />
                </span>
              </button>
            ))}
          </SettingsGroup>
        )}

        {/* ================================================================
            1 — SHARED MOMENTS  (moved here from Profile, whole)
            ================================================================ */}
        <SettingsGroup
          eyebrow="Shared moments"
          title="What friends see"
          hint="Everything here is visible to accepted friends and nobody else."
          icon={<NoteIcon width={19} height={19} />}
        >
          <div className="pc-label-row">
            {/* Not a <label>: the field's accessible name is "Status note",
                which is what it is, while the visible line is the question it
                answers. */}
            <div className="pc-label">What’s up?</div>
            {noteSaved ? <span className="pc-chip on">Live for friends</span> : null}
          </div>
          <p className="field-hint" id="pc-note-hint">
            A line your friends see under your name. Disappears after 24 hours.
          </p>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={80}
            placeholder="Studying · At home · Out for chai"
            className="field"
            aria-label="Status note"
            aria-describedby="pc-note-hint"
          />
          <button
            className="btn-dark"
            onClick={saveNote}
            disabled={noteSave.busy || note.trim() === noteSaved.trim()}
          >
            {noteSave.busy ? 'Saving…' : note.trim() ? 'Set note' : 'Clear note'}
          </button>
          <SaveState
            state={noteSave.state}
            error={noteSave.error}
            savedLabel={noteSaved ? 'Note set for 24 hours' : 'Note cleared'}
          />

        </SettingsGroup>

        {/* ================================================================
            2 — PLAY  (moved here from Profile, whole)
            ================================================================ */}
        <SettingsGroup
          eyebrow="Play"
          title="Games together"
          icon={<GamepadIcon width={19} height={19} />}
        >
          {/* The description stays outside the button so the button's
              accessible name is the word on it. The solo games are behind this
              same door ("Your little break"), deliberately — one door each. */}
          <p className="field-hint">
            A game with a friend, played turn by turn inside Meera. Your own puzzles and the
            runner are in here too, under “Your little break”.
          </p>
          {/* Just us is per-conversation by design — it opens from the chip in
              a thread and from the friend sheet, and nothing about it lives
              outside one pair. So this is a LINK to it, not a second copy: pick
              a person and you land in that conversation, where the feature
              already is. */}
          <div className="pc-label">Just us</div>
          <p className="field-hint">
            Lives inside a conversation. Pick who, and Meera opens that chat.
          </p>
          <button onClick={() => setPicking(true)} className="pc-nav">
            <span className="pc-nav-icon" aria-hidden="true">
              <HeartIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">Just us</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>
        </SettingsGroup>
      </div>

      {picking && (
        <Portal>
          <Sheet onClose={closePicker} label="Open a conversation">
            <h2>Just us</h2>
            {/* Three states again. undefined = still loading, null = the friend
                list could not be read, [] = you have no accepted friends yet. */}
            {friends === undefined && <p className="field-hint" role="status">Loading your people…</p>}
            {friends === null && <p className="field-hint">Couldn’t load your friends. Try again in a moment.</p>}
            {Array.isArray(friends) && friends.length === 0 && (
              <p className="field-hint">Add a friend first — this one needs two.</p>
            )}
            {Array.isArray(friends) &&
              friends.map((f) => (
                <button
                  key={f.id}
                  className="row"
                  onClick={() => {
                    closePicker()
                    onOpenChat?.(f)
                  }}
                >
                  <Avatar profile={f} />
                  <div className="row-main">
                    <div className="row-name">{alias(f)}</div>
                    <div className="row-sub">@{f.username}</div>
                  </div>
                </button>
              ))}
          </Sheet>
        </Portal>
      )}
    </div>
  )
}
