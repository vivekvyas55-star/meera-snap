import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'
import { CameraIcon, CheckIcon, CloseIcon, HeartIcon, ImageIcon, LockIcon, NoteIcon } from './Icons'
import { useAlias } from '../hooks/useAliasClock'
import { useBackLayer } from '../hooks/useBackLayer'
import { useIntimateSession, ROOM_POLL_MS } from '../hooks/useIntimateSession'
import { useToast } from '../hooks/useToast'
import { sendSignal } from '../lib/privateRealtime'
import {
  endSession, joinSession, openPhoto, passTurn, poseRound, promptIdeas,
  respondRound, startSession, uploadIntimatePhoto,
} from '../lib/intimate'
import {
  ANSWER_KEY_MAX, OPTION_MAX, PHOTO_PROMISE, PHOTO_PROMISE_SHORT, PROMPT_MAX,
  RELATIONSHIP_GAMES, RELATIONSHIP_GAME_IDS, RESPONSE_MAX,
  endedLine, formatCountdown, gameOf, partnerLabel, photoUrlTtl, pickLabel,
  poseProblem, respondProblem, revealLine, sessionView, statusLine, titleOf,
} from '../lib/relationshipGames'
import '../styles/intimate.css'

// "Just us" — the five turn-based games for two partners
// (supabase/migrations/202609090026_intimate_games.sql).
//
// Three rules from the migration header are load-bearing in here and are not
// style choices:
//
//  1. NOTHING can be posed or answered before both_accepted. Every compose
//     affordance below is gated on sessionView(), which mirrors the state
//     machine, so the screen never offers a move the database will refuse.
//  2. PASSING COSTS NOTHING. There is no counter, no streak, no tally, and no
//     copy anywhere in this file implying a pass is the lesser outcome. Do not
//     add one.
//  3. CAMERA-OFF IS A MODE, NOT A REFUSAL. Guess What's two ways to play are
//     two equal chips, in the same weight, in the order the user last left
//     them — never a photo button with a text fallback underneath it.
//
// The partner is ALWAYS the rotating alias, never their display name. This is
// the surface where a glance at the screen costs the most, and a dare sitting
// next to a real name is exactly what the alias system exists to prevent.

// ---------------------------------------------------------------------------
// The photo: one view, and copy that is exactly true about it
// ---------------------------------------------------------------------------
function PhotoViewer({ url, deadline, onClose }) {
  const [left, setLeft] = useState(() => deadline - Date.now())
  useBackLayer(true, onClose)
  useEffect(() => {
    const t = setInterval(() => {
      const ms = deadline - Date.now()
      setLeft(ms)
      // The signed URL's own `exp` lands here, so the image would go blank on
      // its own. Closing is the honest version of the same moment, and it is
      // what drops the url out of memory.
      if (ms <= 0) onClose()
    }, 250)
    return () => clearInterval(t)
  }, [deadline, onClose])
  return (
    <Portal>
      <div className="viewer ig-viewer">
        <img src={url} alt="" />
        <div className="viewer-top">
          <span className="ig-count" role="timer">{formatCountdown(left)}</span>
          <button className="viewer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="ig-viewer-note">{PHOTO_PROMISE_SHORT}</div>
      </div>
    </Portal>
  )
}

// ---------------------------------------------------------------------------
// Composing a round
// ---------------------------------------------------------------------------
function Ideas({ gameId, onUse }) {
  // Starters, not the feature. `null` is "we could not get any" and renders
  // nothing — an empty list here would read as "there are none to offer".
  const [ideas, setIdeas] = useState(undefined)
  useEffect(() => {
    let live = true
    promptIdeas(gameId, 3).then((rows) => live && setIdeas(rows)).catch(() => live && setIdeas(null))
    return () => { live = false }
  }, [gameId])
  if (!Array.isArray(ideas) || ideas.length === 0) return null
  return (
    <div className="ig-ideas">
      <span className="eyebrow">Or start from</span>
      {ideas.map((idea, i) => (
        <button key={i} type="button" className="ig-idea" onClick={() => onUse(idea)}>
          {idea.body}
          {idea.camera_free ? <small>Camera-free version included</small> : null}
        </button>
      ))}
    </div>
  )
}

function PoseForm({ gameId, busy, onPose }) {
  const spec = gameOf(gameId)
  const toast = useToast()
  const [prompt, setPrompt] = useState('')
  const [optionB, setOptionB] = useState('')
  const [answerKey, setAnswerKey] = useState('')
  const [secretTruth, setSecretTruth] = useState(null)
  // Guess What's two equal ways to play. Words first is not a demotion of the
  // camera; it is the one that always works.
  const [mode, setMode] = useState('words')
  const [file, setFile] = useState(null)
  const fileRef = useRef(null)

  const draft = { prompt, optionB, answerKey, secretTruth, mediaPath: mode === 'photo' && file ? 'pending' : null }
  const problem = poseProblem(gameId, draft)

  const photoMode = spec.pose === 'photo-or-words' && mode === 'photo'

  const submit = async () => {
    if (problem || busy) return
    const ok = await onPose({
      // In photo mode the written-clue field is not on screen, so anything
      // still in it is a leftover from the other mode rather than something
      // the user meant to send.
      prompt: photoMode ? '' : prompt,
      optionB,
      answerKey,
      secretTruth,
      file: photoMode ? file : null,
    })
    // Only clear a draft that actually got through. Wiping the field on a
    // failed send loses what they wrote, which is the worst possible moment.
    if (!ok) return
    setPrompt(''); setOptionB(''); setAnswerKey(''); setSecretTruth(null); setFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const useIdea = (idea) => {
    setPrompt(idea.camera_free && mode === 'words' ? idea.camera_free : idea.body)
    if (idea.option_b) setOptionB(idea.option_b)
  }

  return (
    <div className="ig-compose">
      {spec.pose === 'photo-or-words' && (
        <>
          <div className="ig-modes" role="group" aria-label="How to play this round">
            <button
              type="button"
              className={`ig-mode ${mode === 'words' ? 'on' : ''}`}
              aria-pressed={mode === 'words'}
              onClick={() => setMode('words')}
            >
              <NoteIcon width={17} height={17} /> In words
            </button>
            <button
              type="button"
              className={`ig-mode ${mode === 'photo' ? 'on' : ''}`}
              aria-pressed={mode === 'photo'}
              onClick={() => setMode('photo')}
            >
              <CameraIcon width={17} height={17} /> A photo
            </button>
          </div>
          <p className="field-hint">Both are the real game. Neither is the fallback.</p>
        </>
      )}

      {photoMode ? (
        <div className="ig-photo-pick">
          <input
            ref={fileRef}
            className="field"
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Choose a photo"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null
              if (picked && !picked.type.startsWith('image/')) {
                toast('Choose an image')
                return
              }
              setFile(picked)
            }}
          />
          <p className="ig-promise">
            <LockIcon width={14} height={14} />
            <span>{PHOTO_PROMISE}</span>
          </p>
        </div>
      ) : (
        <label className="ig-field">
          <span className="eyebrow">{spec.promptLabel}</span>
          <textarea
            className="field"
            rows={2}
            maxLength={PROMPT_MAX}
            value={prompt}
            placeholder={spec.promptHint}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
      )}

      {spec.pose === 'two-options' && (
        <label className="ig-field">
          <span className="eyebrow">{spec.optionLabel}</span>
          <textarea
            className="field"
            rows={2}
            maxLength={OPTION_MAX}
            value={optionB}
            placeholder={spec.optionHint}
            onChange={(e) => setOptionB(e.target.value)}
          />
        </label>
      )}

      {spec.pose === 'statement' && (
        <div className="ig-picks" role="group" aria-label="Is it real?">
          {spec.picks.map((p) => {
            const on = secretTruth === (p.value === 'real')
            return (
              <button
                key={p.value}
                type="button"
                className={`ig-pick ${on ? 'on' : ''}`}
                aria-pressed={on}
                onClick={() => setSecretTruth(p.value === 'real')}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      )}

      {spec.pose === 'photo-or-words' && (
        <label className="ig-field">
          <span className="eyebrow">What it actually is</span>
          <input
            className="field"
            maxLength={ANSWER_KEY_MAX}
            value={answerKey}
            placeholder="They are told this once they have guessed."
            onChange={(e) => setAnswerKey(e.target.value)}
          />
        </label>
      )}

      {photoMode ? null : <Ideas gameId={gameId} onUse={useIdea} />}

      <button className="btn-dark" onClick={submit} disabled={Boolean(problem) || busy}>
        {busy ? 'Sending…' : 'Send it'}
      </button>
      {problem ? <p className="field-hint" role="status">{problem}</p> : null}
    </div>
  )
}

function RespondForm({ gameId, round, busy, partner, onRespond, onOpenPhoto }) {
  const spec = gameOf(gameId)
  const [pick, setPick] = useState('')
  const [response, setResponse] = useState('')
  const problem = respondProblem(gameId, { pick, response })

  return (
    <div className="ig-compose">
      {round.has_photo && (
        <div className="ig-photo-open">
          {round.photo_opened_at ? (
            <p className="field-hint">You have opened it. It does not come back.</p>
          ) : (
            <>
              <button className="btn-dark" onClick={onOpenPhoto} disabled={busy}>
                <ImageIcon width={17} height={17} /> Open it — once
              </button>
              <p className="field-hint">{PHOTO_PROMISE_SHORT}</p>
            </>
          )}
        </div>
      )}

      {spec.picks?.length ? (
        <div className="ig-picks" role="group" aria-label={`Answer ${partner}`}>
          {spec.picks.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`ig-pick ${pick === p.value ? 'on' : ''}`}
              aria-pressed={pick === p.value}
              onClick={() => setPick(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}

      {spec.respond !== 'pick' && (
        <label className="ig-field">
          <span className="eyebrow">{spec.responseLabel ?? 'Your answer'}</span>
          <textarea
            className="field"
            rows={2}
            maxLength={RESPONSE_MAX}
            value={response}
            onChange={(e) => setResponse(e.target.value)}
          />
        </label>
      )}

      <button
        className="btn-dark"
        onClick={() => !problem && !busy && onRespond({ pick, response })}
        disabled={Boolean(problem) || busy}
      >
        {busy ? 'Sending…' : 'Answer'}
      </button>
      {problem ? <p className="field-hint" role="status">{problem}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The list of what has happened
// ---------------------------------------------------------------------------
function RoundRow({ round, gameId, me, partner }) {
  const mine = round.poser === me
  const who = mine ? 'You' : partner
  const reveal = revealLine(gameId, round)
  const chosen = pickLabel(gameId, round.pick)

  // A pass is a complete, ordinary outcome. It is stated and nothing is counted.
  if (round.status === 'passed' && !round.prompt && !round.has_photo) {
    const passer = round.passed_by === me ? 'You' : partner
    return <li className="ig-round ig-round-pass">{passer} passed this turn.</li>
  }

  return (
    <li className={`ig-round ${mine ? 'mine' : ''}`}>
      <span className="ig-round-who">{who} asked</span>
      {round.prompt ? <p className="ig-round-prompt">{round.prompt}</p> : null}
      {round.option_b ? <p className="ig-round-prompt ig-round-alt">{round.option_b}</p> : null}
      {round.has_photo ? (
        <p className="ig-round-photo">
          <ImageIcon width={15} height={15} />
          {round.photo_opened_at ? 'Photo — seen once, and gone from here.' : mine ? 'Photo — waiting to be opened, once.' : 'Photo — opens once.'}
        </p>
      ) : null}
      {round.status === 'passed' ? (
        <p className="ig-round-answer">{round.passed_by === me ? 'You passed.' : `${partner} passed.`}</p>
      ) : null}
      {chosen ? <p className="ig-round-answer"><strong>{chosen}</strong></p> : null}
      {round.response ? <p className="ig-round-answer">{round.response}</p> : null}
      {reveal ? <p className="ig-round-reveal">{reveal}</p> : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------
export default function IntimateSession({ me, friend, onClose }) {
  const toast = useToast()
  const alias = useAlias()
  const partner = partnerLabel(friend, alias)
  const { session, rounds, closed, available, error, sync, applySession, dismissClosed } =
    // `recall: true` — this is the one instance that carries the memory of a
    // session that ended while the sheet was shut, and the one that says so.
    useIntimateSession(me, friend.id, { intervalMs: ROOM_POLL_MS, listen: true, recall: true })
  const [busy, setBusy] = useState(false)
  // { url, deadline } while a photo is on screen, and nothing at all otherwise.
  // The url is never stored anywhere else, never cached and never re-requested.
  const [photo, setPhoto] = useState(null)

  const view = useMemo(() => sessionView(session, rounds, me), [session, rounds, me])
  const gameId = session?.game ?? null
  const status = statusLine(view, partner)

  // The nudge. Carries no state — it only says "re-sync" — and rides the
  // private per-writer topic the call and board-game signaling already use.
  const nudge = useCallback((id) => {
    sendSignal(me, friend.id, 'intimate_changed', { room: String(id ?? '') }).catch(() => {})
  }, [me, friend.id])

  const run = async (fn) => {
    if (busy) return null
    setBusy(true)
    try {
      return await fn()
    } catch (err) {
      toast(err.message || 'That did not go through.')
      sync()
      return null
    } finally {
      setBusy(false)
    }
  }

  const open = (code) => run(async () => {
    const row = await startSession(friend.id, code)
    applySession(row)
    nudge(row?.id)
    sync()
    return true
  })

  const join = () => run(async () => {
    const row = await joinSession(session.id)
    applySession(row)
    nudge(row?.id)
    sync()
    return true
  })

  // Reachable from every state, and deliberately with no confirmation. An exit
  // that argues with you is not an exit, and ending is idempotent server-side
  // so a double tap costs nothing.
  const end = () => run(async () => {
    const row = await endSession(session.id)
    applySession(row)
    nudge(session.id)
    return true
  })

  const pose = ({ prompt, optionB, answerKey, secretTruth, file }) => run(async () => {
    let mediaPath = null
    if (file) mediaPath = await uploadIntimatePhoto(me, file)
    await poseRound(session.id, { prompt, optionB, answerKey, secretTruth, mediaPath })
    nudge(session.id)
    await sync()
    return true
  })

  const respond = ({ pick, response }) => run(async () => {
    await respondRound(view.openRound.id, { pick, response })
    nudge(session.id)
    await sync()
    return true
  })

  const pass = () => run(async () => {
    await passTurn(session.id)
    nudge(session.id)
    await sync()
    return true
  })

  const showPhoto = () => run(async () => {
    const round = view.openRound
    const url = await openPhoto(round)
    // The deadline IS the signed URL's own expiry: photoUrlTtl mints exactly
    // what is left of the two minutes, so the countdown and the link die
    // together rather than the screen claiming one thing and the token another.
    setPhoto({ url, deadline: Date.now() + photoUrlTtl(round) * 1000 })
    sync()
    return true
  })

  // Dropping the url here is the point of holding it in state and nowhere else.
  const closePhoto = useCallback(() => setPhoto(null), [])

  return (
    <Portal>
      <Sheet onClose={onClose} label="Just us" className="sheet-body ig-sheet">
        <div className="ig-head">
          <div>
            <span className="eyebrow">Private to you both</span>
            <h2>{gameId ? titleOf(gameId) : 'Just us'}</h2>
          </div>
          {view.canEnd && (
            <button type="button" className="pill-btn pill-inline" onClick={end} disabled={busy}>
              {view.canJoin ? 'Not now' : 'End'}
            </button>
          )}
        </div>

        {error ? (
          <div className="thread-error" role="alert">
            <span>{error}</span>
            <button className="btn-dark" onClick={sync}>Retry</button>
          </div>
        ) : null}

        {closed ? (
          <div className="ig-card ig-ended">
            <p>{endedLine(closed, me, partner)}</p>
            <button type="button" className="btn-dark" onClick={dismissClosed}>Start another</button>
          </div>
        ) : null}

        {available === undefined && session === undefined && !error ? (
          <p className="field-hint" role="status">Opening…</p>
        ) : null}

        {!closed && view.phase === 'none' && available !== undefined ? (
          <div className="ig-picker">
            <p className="ig-intro">
              Five slow games for the two of you. Both of you have to say yes before
              anything can be asked, either of you can end it at any moment, and
              passing on a turn costs nothing at all.
            </p>
            {RELATIONSHIP_GAME_IDS.map((id) => {
              const spec = RELATIONSHIP_GAMES[id]
              return (
                <button
                  key={id}
                  type="button"
                  className="ig-game"
                  style={{ background: spec.tint }}
                  onClick={() => open(id)}
                  disabled={busy}
                >
                  <span className="ig-game-title">{spec.title}</span>
                  <span className="ig-game-blurb">{spec.blurb}</span>
                </button>
              )
            })}
          </div>
        ) : null}

        {!closed && view.phase === 'invited' ? (
          <div className="ig-card ig-consent">
            <p className="ig-consent-line">{status}</p>
            {view.canJoin ? (
              <>
                <p className="field-hint">
                  Nothing can be asked until you join, and you can end it at any point
                  afterwards. Passing on any turn costs nothing.
                </p>
                <button className="btn-dark" onClick={join} disabled={busy}>
                  <CheckIcon width={17} height={17} /> Join
                </button>
              </>
            ) : (
              <p className="field-hint">They will see it next time they open this conversation.</p>
            )}
          </div>
        ) : null}

        {!closed && view.live ? (
          <>
            <div className="ig-status" role="status">{status}</div>

            {rounds === undefined ? (
              <p className="field-hint" role="status">Catching up…</p>
            ) : (
              <ol className="ig-rounds">
                {rounds.map((r) => (
                  <RoundRow key={r.id} round={r} gameId={gameId} me={me} partner={partner} />
                ))}
              </ol>
            )}

            {view.canRespond ? (
              <RespondForm
                gameId={gameId}
                round={view.openRound}
                busy={busy}
                partner={partner}
                onRespond={respond}
                onOpenPhoto={showPhoto}
              />
            ) : null}

            {view.canPose ? <PoseForm gameId={gameId} busy={busy} onPose={pose} /> : null}

            {view.canPass ? (
              <div className="ig-pass">
                <button type="button" className="pill-btn" onClick={pass} disabled={busy}>
                  Pass
                </button>
                {/* Passing records nothing. Say so once, plainly, and never
                    anywhere keep a count of it. */}
                <span className="field-hint">Nothing is recorded, and nothing is lost.</span>
              </div>
            ) : null}

            {!view.myTurn ? (
              <p className="ig-waiting">
                <HeartIcon width={15} height={15} /> Waiting on {partner}. You can close this — it will keep.
              </p>
            ) : null}
          </>
        ) : null}

        {!closed && view.phase === 'expired' ? (
          <div className="ig-card ig-ended">
            <p>{status}</p>
          </div>
        ) : null}

        <p className="ig-foot">
          <LockIcon width={13} height={13} />
          <span>
            Nothing here goes into the chat, Memories or a story. A session and everything
            in it is deleted 24 hours after it opens.
          </span>
        </p>

        <button className="menu-action" onClick={onClose}>
          <CloseIcon width={17} height={17} /> Close
        </button>
      </Sheet>

      {photo ? <PhotoViewer url={photo.url} deadline={photo.deadline} onClose={closePhoto} /> : null}
    </Portal>
  )
}
