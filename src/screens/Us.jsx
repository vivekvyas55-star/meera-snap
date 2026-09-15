import { useCallback, useEffect, useState } from 'react'
import {
  clearStatusNote,
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
  NoteIcon,
  SparkIcon,
} from '../components/Icons'
import Memories from './Memories'
import PlayTogether from './PlayTogether'
import Together from './Together'
import '../styles/privacy.css'

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
  const [picking, setPicking] = useState(false)

  const [note, setNote] = useState('')
  const [noteSaved, setNoteSaved] = useState('')
  const noteSave = useSaveState()

  // undefined = not asked yet, null = the read failed, array = the answer.
  // `[]` is reserved for the answer "nobody is waiting", which is a claim about
  // other people and must never be what a dropped request renders as.
  const [waiting, setWaiting] = useState(undefined)
  const [friends, setFriends] = useState(undefined)

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
  const closePicker = useCallback(() => setPicking(false), [])

  // Each sub-screen is its own Back layer, pushed after the layer App holds for
  // this overlay, so Android's Back closes Memories before it closes Us — one
  // press, one layer. Sheet registers its own.
  useBackLayer(showMemories, closeMemories)
  useBackLayer(showTogether, closeTogether)
  useBackLayer(showPlay, closePlay)

  if (showMemories) return <Memories me={me} onBack={closeMemories} />
  if (showTogether) return <Together me={me} onBack={closeTogether} />
  if (showPlay) return <PlayTogether onBack={closePlay} />

  const openWaiting = (item) => {
    if (item.to === 'play') setShowPlay(true)
    else onOpenChat?.(item.person)
  }

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header pc-head">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Us</h1>
      </div>

      <div className="list profile-list">
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

          <div className="pc-label">Memories</div>
          <p className="field-hint">
            Snaps you chose to keep. Private to you — nobody else can open this.
          </p>
          <button onClick={() => setShowMemories(true)} className="pc-nav">
            <span className="pc-nav-icon" aria-hidden="true">
              <ImageIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">Open Memories</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>

          <div className="pc-label">Together</div>
          <p className="field-hint">
            A shared timeline and scrapbook for one friendship. Off until you both turn it on.
          </p>
          <button onClick={() => setShowTogether(true)} className="pc-nav">
            <span className="pc-nav-icon" aria-hidden="true">
              <HeartIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">Open Together</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>
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
          <button onClick={() => setShowPlay(true)} className="pc-nav">
            <span className="pc-nav-icon" aria-hidden="true">
              <GamepadIcon width={19} height={19} />
            </span>
            <span className="pc-nav-title">Play</span>
            <span className="pc-nav-go" aria-hidden="true">
              <ArrowIcon width={17} height={17} />
            </span>
          </button>

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
            {friends === undefined && <p className="field-hint">Loading your people…</p>}
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
