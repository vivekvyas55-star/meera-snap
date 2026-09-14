import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Avatar from '../components/Avatar'
import Confirm from '../components/Confirm'
import Portal from '../components/Portal'
import PrivateBadge from '../components/PrivateBadge'
import VoicePlayer from '../components/VoicePlayer'
import {
  ArrowIcon, BackIcon, CalendarIcon, CameraIcon, FlameIcon, HeartIcon,
  ImageIcon, MicIcon, NoteIcon, PhoneIcon, SaveIcon, TrashIcon, UsersIcon,
} from '../components/Icons'
import { useAudioRecorder } from '../hooks/useAudioRecorder'
import { useBackLayer } from '../hooks/useBackLayer'
import { useToast } from '../hooks/useToast'
import { istToday, listFriendsWithProfiles, signedUrl } from '../lib/db'
import {
  addNote, addPhoto, addVoice, getTogetherStatus, listOnThisDay,
  listScrapbook, listTimeline, purgeMyScrapbook, removeScrapbookItem,
  setTogetherOptIn,
} from '../lib/together'
import {
  NOTE_MAX, canDelete, filterTimeline, fullPath, gridPath, groupTimelineByYear,
  isFutureDate, optInCopy, optInState, optOutCopy, scrapbookCounts,
  scrapbookDateLabel, scrapbookPurgeCopy, timelineFilters, yearsAgoLabel,
} from '../lib/togetherState'
import '../styles/together.css'

const nameOf = (p) => p?.display_name || p?.username || 'them'

// Line icons, never emoji — these are chrome. The recorded kinds
// (202609140034) sit alongside the derived ones because a reader does not care
// which half of the timeline a card came from; an unknown kind still falls
// through to NoteIcon rather than rendering a hole, because a phone one deploy
// behind the database is the normal state for a few minutes.
const TIMELINE_ICON = {
  friends: <UsersIcon width={17} height={17} />,
  anniversary: <HeartIcon width={17} height={17} />,
  anniversary_start: <HeartIcon width={17} height={17} />,
  streak: <FlameIcon width={17} height={17} />,
  streak_milestone: <FlameIcon width={17} height={17} />,
  first_kept: <ImageIcon width={17} height={17} />,
  kept: <ImageIcon width={17} height={17} />,
  mutual_save: <SaveIcon width={17} height={17} />,
  first_snap: <CameraIcon width={17} height={17} />,
  first_call: <PhoneIcon width={17} height={17} />,
  first_voice: <MicIcon width={17} height={17} />,
  scrapbook_photo: <ImageIcon width={17} height={17} />,
  scrapbook_voice: <MicIcon width={17} height={17} />,
  scrapbook_note: <NoteIcon width={17} height={17} />,
}

// A thumbnail that never asks for the original. `gridPath` prefers thumb_path
// and only falls back to the full object when the ~400px encode failed at
// upload — see the egress note in lib/togetherState.js.
//
// `onOpen` is optional, and that is the point: a tile is only a button when
// there is a full-size object to open. Drawing one that cannot open anything is
// how the capsules ended up with a tap that silently did nothing.
function Thumb({ item, onOpen, label }) {
  const [url, setUrl] = useState(null)
  const path = gridPath(item)
  useEffect(() => {
    if (!path) return undefined
    let alive = true
    signedUrl(path).then((u) => alive && setUrl(u)).catch(() => {})
    return () => { alive = false }
  }, [path])
  const inner = url
    ? <img src={url} alt={onOpen ? '' : (item?.body || '')} loading="lazy" decoding="async" />
    : <span className="tg-thumb-ph" aria-hidden="true" />
  if (!onOpen) return <span className="tg-thumb tg-thumb-still">{inner}</span>
  return (
    <button type="button" className="tg-thumb" onClick={onOpen} aria-label={label}>
      {inner}
    </button>
  )
}

// A destructive confirmation is two lists, never a paragraph: what goes, and
// what does not. The Privacy Centre's account deletion reads the same way
// (DELETION_LOSES in lib/privacy.js), and for the same reason — somebody must
// be able to decide from this sheet alone, without remembering what the button
// they tapped was called. The "stays" half matters more here than it does
// there: the scrapbook is a shared artifact, and the fear that turning a switch
// off will take the other person's photos with it is exactly what would stop
// someone from using a control they are entitled to.
function LossList({ loses, keeps }) {
  return (
    <>
      <ul className="tg-loses">
        {loses.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {keeps?.length ? (
        <ul className="tg-keeps">
          {keeps.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
    </>
  )
}

function PhotoViewer({ item, onClose }) {
  const [url, setUrl] = useState(null)
  const path = fullPath(item)
  useEffect(() => {
    let alive = true
    if (!path) { onClose(); return undefined }
    signedUrl(path).then((u) => alive && setUrl(u)).catch(() => alive && onClose())
    return () => { alive = false }
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Portal>
      <div className="viewer">
        {url ? <img src={url} alt={item.body || 'Scrapbook photo'} /> : <div className="viewer-loading">Loading…</div>}
        <div className="viewer-top">
          <button className="viewer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {item.body ? <div className="viewer-caption">{item.body}</div> : null}
        <div className="viewer-privacy-note">Private to you both · {scrapbookDateLabel(item.on_date)}</div>
      </div>
    </Portal>
  )
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------
// A failed read and an empty history are the same shape — `[]` — unless the
// caller keeps them apart, and this project has found that bug seven times.
// `undefined` is "not asked yet", `null` is "the fetch failed", and only a real
// array is allowed to produce the words "nothing yet".
function TimelinePane({ rows, loading, filter, onFilter, onRetry }) {
  const filters = useMemo(() => timelineFilters(rows), [rows])
  const shown = useMemo(() => filterTimeline(rows, filter), [rows, filter])
  const groups = useMemo(() => groupTimelineByYear(shown), [shown])
  return (
    <section className="tg-pane" aria-label="Timeline">
      <PrivateBadge />
      {rows === null ? (
        <div className="error" role="alert">
          <span>The timeline didn’t load. This is not “nothing happened” — we could not read it.</span>
          <button onClick={onRetry}>Retry</button>
        </div>
      ) : null}
      {loading && rows == null ? <p className="field-hint">Reading your history…</p> : null}
      {filters?.length ? (
        <div className="tg-filters" role="group" aria-label="Filter the timeline">
          {filters.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`pill-btn pill-inline ${filter === group.id ? 'on' : ''}`}
              aria-pressed={filter === group.id}
              onClick={() => onFilter(group.id)}
            >
              {group.label} <em>{group.count}</em>
            </button>
          ))}
        </div>
      ) : null}
      {!loading && Array.isArray(rows) && !rows.length ? (
        <div className="empty">
          <div className="empty-symbol" aria-hidden="true"><CalendarIcon /></div>
          <h2>Nothing on the timeline yet.</h2>
          <p>Set a “together since” date in the chat, keep a snap, or add something to the scrapbook.</p>
        </div>
      ) : null}
      {Array.isArray(rows) && rows.length && !groups.length ? (
        // A filter that hides everything must say it was the filter. Otherwise
        // it reads exactly like the empty state above, and the way out of it is
        // invisible.
        <p className="field-hint tg-locked">Nothing of that sort yet. Tap <strong>All</strong> to see the rest.</p>
      ) : null}
      {groups.map((group) => (
        <div key={group.year} className="tg-year">
          <h3 className="tg-year-head">{group.year}</h3>
          <ol className="tg-line">
            {group.entries.map((entry, i) => (
              <li key={`${entry.kind}-${entry.ref || entry.on_date || i}`} className="tg-line-row">
                <span className="tg-line-icon" aria-hidden="true">{TIMELINE_ICON[entry.kind] ?? <NoteIcon width={17} height={17} />}</span>
                <span className="tg-line-text">
                  <strong>{entry.title}</strong>
                  <small>{scrapbookDateLabel(entry.on_date)}{entry.detail ? ` · ${entry.detail}` : ''}</small>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  )
}

function OnThisDayPane({ capsules, loading, resolve, onOpen, onRetry }) {
  const rows = Array.isArray(capsules) ? capsules : []
  return (
    <section className="tg-pane" aria-label="On this day">
      <PrivateBadge note="turns over at your midnight" />
      {capsules === null ? (
        <div className="error" role="alert">
          <span>Couldn’t look back just now. That isn’t the same as there being nothing.</span>
          <button onClick={onRetry}>Retry</button>
        </div>
      ) : null}
      {loading && capsules == null ? <p className="field-hint">Looking back…</p> : null}
      {!loading && Array.isArray(capsules) && !capsules.length ? (
        <div className="empty">
          <div className="empty-symbol" aria-hidden="true"><CalendarIcon /></div>
          <h2>Nothing from this day yet.</h2>
          <p>Add a scrapbook entry with the date it actually happened and it will come back on this day next year.</p>
        </div>
      ) : null}
      {rows.map((capsule) => {
        // together_on_this_day() returns thumbnails and never a media_path — a
        // dozen capsules naming a dozen originals is the screen that spends the
        // month. So a capsule opens only when its full-size row is already in
        // the scrapbook list we loaded for this pair anyway, which costs no
        // extra request. Anything else (a snap you both kept, an entry older
        // than the scrapbook page) stays a still image.
        const target = resolve(capsule)
        return (
        <article key={`${capsule.source}-${capsule.id}`} className="tg-capsule">
          <span className="tg-chip">{yearsAgoLabel(capsule.years_ago)}</span>
          <div className="tg-capsule-body">
            {capsule.thumb_path ? (
              <Thumb
                item={capsule}
                onOpen={target ? () => onOpen(target) : null}
                label={target ? `Open photo from ${scrapbookDateLabel(capsule.on_date)}` : null}
              />
            ) : null}
            <div>
              <strong>{capsule.source === 'kept' ? 'A snap you both kept' : 'From your scrapbook'}</strong>
              {capsule.body ? <p>{capsule.body}</p> : null}
              <small>{scrapbookDateLabel(capsule.on_date)}</small>
            </div>
          </div>
        </article>
        )
      })}
    </section>
  )
}

function Composer({ friendName, busy, onNote, onPhoto, onVoice }) {
  const [mode, setMode] = useState('note')
  const [text, setText] = useState('')
  const [day, setDay] = useState(istToday())
  const [file, setFile] = useState(null)
  const [clip, setClip] = useState(null)
  const recorder = useAudioRecorder()
  const toast = useToast()
  const today = istToday()

  // The mic must never be left hot because the screen went away mid-recording.
  useEffect(() => () => { recorder.stop(true) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const dated = isFutureDate(day, today) ? today : day

  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    if (isFutureDate(day, today)) { toast('A memory cannot be dated in the future.'); return }
    if (mode === 'note') { await onNote(text, dated); setText(''); return }
    if (mode === 'photo') {
      if (!file) { toast('Choose a photo first.'); return }
      await onPhoto(file, text, dated); setFile(null); setText('')
      return
    }
    if (!clip) { toast('Record something first.'); return }
    await onVoice(clip, text, dated); setClip(null); setText('')
  }

  const toggleRecording = async () => {
    if (recorder.recording) {
      const blob = await recorder.stop()
      if (blob) setClip(blob)
      else toast('Nothing was recorded.')
      return
    }
    setClip(null)
    const started = await recorder.start()
    if (!started && recorder.error) toast(recorder.error)
  }

  return (
    <form className="tg-composer" onSubmit={submit}>
      <PrivateBadge />
      <div className="tg-modes" role="group" aria-label="What to add">
        {[['note', 'Note', <NoteIcon key="n" width={16} height={16} />],
          ['photo', 'Photo', <ImageIcon key="p" width={16} height={16} />],
          ['voice', 'Voice', <MicIcon key="v" width={16} height={16} />]].map(([value, label, icon]) => (
          <button
            key={value}
            type="button"
            className={`pill-btn pill-inline ${mode === value ? 'on' : ''}`}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      {mode === 'photo' ? (
        <label className="tg-file">
          <ImageIcon width={17} height={17} aria-hidden="true" />
          <span>{file ? file.name : 'Choose a photo'}</span>
          <input
            type="file"
            accept="image/*"
            aria-label="Photo for the scrapbook"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      ) : null}

      {mode === 'voice' ? (
        <button type="button" className={`tg-record ${recorder.recording ? 'on' : ''}`} onClick={toggleRecording}>
          <MicIcon width={17} height={17} aria-hidden="true" />
          {recorder.recording ? 'Stop recording' : clip ? 'Recorded — tap to redo' : 'Record a voice note'}
        </button>
      ) : null}

      <label className="field-label" htmlFor="tg-text">
        {mode === 'note' ? 'Your note' : 'Caption (optional)'}
      </label>
      <textarea
        id="tg-text"
        className="field tg-text"
        rows={mode === 'note' ? 3 : 2}
        maxLength={NOTE_MAX}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={mode === 'note' ? `Something you want to keep with ${friendName}` : 'A line about this'}
      />

      <label className="field-label" htmlFor="tg-date">The day this happened</label>
      <p className="field-hint">Backdate it and it comes back on this day, every year.</p>
      <input
        id="tg-date"
        type="date"
        className="field"
        max={today}
        value={day}
        onChange={(e) => setDay(e.target.value)}
      />

      <button className="btn-dark" type="submit" disabled={busy || (mode === 'note' && !text.trim())}>
        {busy ? 'Saving…' : 'Add to scrapbook'}
      </button>
    </form>
  )
}

function ScrapbookPane({
  items, loading, me, friendName, busy, canAdd, onOpen, onDelete, onNote,
  onPhoto, onVoice, onPurgeMine, onRetry,
}) {
  const rows = Array.isArray(items) ? items : []
  const counts = scrapbookCounts(rows)
  const photos = rows.filter((i) => i.kind === 'photo')
  const rest = rows.filter((i) => i.kind !== 'photo')
  const mine = rows.filter((i) => canDelete(i, me)).length
  return (
    <section className="tg-pane" aria-label="Scrapbook">
      <PrivateBadge note={counts.total ? `${counts.total} kept` : null} />
      {items === null ? (
        <div className="error" role="alert">
          <span>The scrapbook didn’t open. It is not empty — we could not read it.</span>
          <button onClick={onRetry}>Retry</button>
        </div>
      ) : null}
      {loading && items == null ? <p className="field-hint">Opening the scrapbook…</p> : null}
      {!loading && Array.isArray(items) && !items.length ? (
        <div className="empty">
          <div className="empty-symbol" aria-hidden="true"><ImageIcon /></div>
          <h2>The scrapbook is empty.</h2>
          <p>Photos, voice notes and notes you both keep. Nothing here disappears.</p>
        </div>
      ) : null}

      {photos.length ? (
        <div className="tg-grid">
          {photos.map((item) => (
            <Thumb key={item.id} item={item} onOpen={() => onOpen(item)} label={`Open photo from ${scrapbookDateLabel(item.on_date)}`} />
          ))}
        </div>
      ) : null}

      {rest.map((item) => (
        <article key={item.id} className={`tg-entry ${item.kind}`}>
          <div className="tg-entry-head">
            <span className="tg-chip">{scrapbookDateLabel(item.on_date)}</span>
            {canDelete(item, me) ? (
              <button type="button" className="tg-remove" onClick={() => onDelete(item)} aria-label="Remove this entry">
                <TrashIcon width={16} height={16} />
              </button>
            ) : null}
          </div>
          {item.kind === 'voice'
            ? <VoicePlayer message={item} bar="var(--indigo)" />
            : null}
          {item.body ? <p className="tg-entry-body">{item.body}</p> : null}
        </article>
      ))}

      {canAdd ? (
        <Composer friendName={friendName} busy={busy} onNote={onNote} onPhoto={onPhoto} onVoice={onVoice} />
      ) : (
        <p className="field-hint tg-locked">
          Adding needs both of you to have Together on. What is already here stays readable.
        </p>
      )}

      {/* Turning Together off deletes the milestones the app recorded and
          deliberately leaves the scrapbook alone — half of it is the other
          person's. This is the separate act for somebody who wants their own
          contributions gone too, and it is scoped to exactly those. */}
      {mine ? (
        <button type="button" className="tg-purge" onClick={onPurgeMine} disabled={busy}>
          <TrashIcon width={16} height={16} aria-hidden="true" />
          Remove the {mine} {mine === 1 ? 'entry' : 'entries'} you added
        </button>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function Together({ me, onBack }) {
  const toast = useToast()
  const [friends, setFriends] = useState(null)
  const [friend, setFriend] = useState(null)
  const [status, setStatus] = useState(null)
  const [tab, setTab] = useState('timeline')
  // undefined = not asked yet, null = the read failed, an array = an answer.
  // `[]` is an answer and is reserved for one, which is the whole rule the
  // seven "failures rendering as answers" bugs broke.
  const [timeline, setTimeline] = useState(undefined)
  const [capsules, setCapsules] = useState(undefined)
  const [items, setItems] = useState(undefined)
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState(null)
  const [removing, setRemoving] = useState(null)
  // 'optout' | 'purge-mine' — the two destructive steps that state what they
  // will do before they do it.
  const [confirming, setConfirming] = useState(null)
  const [error, setError] = useState(null)
  const actionRef = useRef(false)

  const clearFriend = useCallback(() => setFriend(null), [])
  // Android Back walks out of the conversation before it walks out of the
  // screen, so one press never skips two levels.
  useBackLayer(Boolean(friend), clearFriend)
  useBackLayer(Boolean(viewing), () => setViewing(null))

  useEffect(() => {
    let alive = true
    listFriendsWithProfiles(me)
      .then((rows) => {
        if (!alive) return
        setFriends(rows.filter((f) => f.status === 'accepted' && f.profile).map((f) => f.profile))
      })
      .catch((err) => alive && setError(err.message))
    return () => { alive = false }
  }, [me])

  const load = useCallback(async (otherId) => {
    setLoading(true)
    try {
      const next = await getTogetherStatus(otherId)
      setStatus(next)
      setError(null)
      // The scrapbook is readable to the pair whatever the opt-in says, so it
      // loads either way; the timeline and the capsules are opt-in gated
      // server-side and would come back empty, so they are not even asked for.
      //
      // Each read settles on its own. One RPC failing must not turn the other
      // two into "nothing here" — allSettled rather than all, and a rejection
      // becomes null, which every pane renders as "we could not read this".
      const [book, line, caps] = await Promise.allSettled([
        listScrapbook(me, otherId),
        next.active ? listTimeline(otherId) : Promise.resolve([]),
        next.active ? listOnThisDay(otherId) : Promise.resolve([]),
      ])
      setItems(book.status === 'fulfilled' ? book.value : null)
      setTimeline(line.status === 'fulfilled' ? line.value : null)
      setCapsules(caps.status === 'fulfilled' ? caps.value : null)
    } catch (err) {
      // The status itself failed, so nothing below it was asked. Saying so
      // beats three panes each claiming to be empty.
      setError(err.message)
      setItems(null); setTimeline(null); setCapsules(null)
    } finally {
      setLoading(false)
    }
  }, [me])

  useEffect(() => {
    if (!friend) return
    setTimeline(undefined); setCapsules(undefined); setItems(undefined)
    setStatus(null); setFilter('all')
    load(friend.id)
  }, [friend, load])

  const state = optInState(status)
  const friendName = nameOf(friend)
  const copy = optInCopy(state, friendName)

  const applyOptIn = async (joined) => {
    if (actionRef.current || !friend) return
    actionRef.current = true; setBusy(true)
    try {
      const next = await setTogetherOptIn(friend.id, joined)
      setStatus(next)
      await load(friend.id)
    } catch (err) {
      toast(err.message || 'Could not change that. Try again.')
    } finally {
      actionRef.current = false; setBusy(false)
    }
  }

  // Turning it ON adds a row. Turning it OFF deletes the pair's recorded
  // milestones, so it goes through a sheet that says which rows go and which
  // do not — the house rule for anything destructive is that it states the
  // loss first, not after.
  const onToggleOptIn = () => {
    if (status?.mine) setConfirming('optout')
    else applyOptIn(true)
  }

  const guardedAdd = async (fn, done) => {
    if (actionRef.current || !friend) return
    actionRef.current = true; setBusy(true)
    try {
      await fn()
      await load(friend.id)
      toast(done)
    } catch (err) {
      toast(err.message || 'Could not save that. Try again.')
    } finally {
      actionRef.current = false; setBusy(false)
    }
  }

  // A capsule only names a thumbnail (see together_on_this_day), so opening one
  // means finding the full-size row in the scrapbook list already in hand. No
  // extra request, and no button where there is nothing to open.
  const resolveCapsule = useCallback(
    (capsule) => (capsule?.source === 'scrapbook'
      ? items.find((i) => i.id === capsule.id && i.media_path) ?? null
      : null),
    [items],
  )

  const onNote = (text, day) => guardedAdd(() => addNote(friend.id, text, day), 'Added to your scrapbook')
  const onPhoto = (file, caption, day) => guardedAdd(() => addPhoto(me, friend.id, file, caption, day), 'Photo added')
  const onVoice = (blob, caption, day) => guardedAdd(() => addVoice(me, friend.id, blob, caption, day), 'Voice note added')

  const confirmRemove = async () => {
    const item = removing
    setRemoving(null)
    await guardedAdd(() => removeScrapbookItem(item), 'Removed')
  }

  const confirmOptOut = async () => {
    setConfirming(null)
    await applyOptIn(false)
  }

  const confirmPurgeMine = async () => {
    setConfirming(null)
    const mine = (Array.isArray(items) ? items : []).filter((i) => canDelete(i, me))
    await guardedAdd(
      () => purgeMyScrapbook(friend.id, mine),
      mine.length === 1 ? 'Your entry is gone' : 'Your entries are gone',
    )
  }

  const purgeCopy = confirming === 'optout'
    ? optOutCopy(status, friendName)
    : confirming === 'purge-mine'
      ? scrapbookPurgeCopy(status, friendName)
      : null

  if (!friend) {
    return (
      <div className="app tg-app">
        <div className="header">
          <button className="circle filled" onClick={onBack} aria-label="Back"><BackIcon /></button>
          <h1>Together</h1>
        </div>
        <div className="list profile-list">
          <PrivateBadge />
          <p className="field-hint">
            A shared timeline and scrapbook for one friendship. It stays off until you both turn it on.
          </p>
          {error ? <div className="error" role="alert"><span>{error}</span></div> : null}
          {friends === null ? <p className="field-hint">Loading your people…</p> : null}
          {friends?.length === 0 ? (
            <div className="empty">
              <div className="empty-symbol" aria-hidden="true"><UsersIcon /></div>
              <h2>No friends yet.</h2>
              <p>Together needs two people. Add someone first.</p>
            </div>
          ) : null}
          {friends?.map((p) => (
            <button key={p.id} type="button" className="tg-friend" onClick={() => setFriend(p)}>
              <Avatar profile={p} size="sm" />
              <span className="tg-friend-text">
                <strong>{nameOf(p)}</strong>
                <small>@{p.username}</small>
              </span>
              <span className="tg-go" aria-hidden="true"><ArrowIcon width={17} height={17} /></span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="app tg-app">
      <div className="header">
        <button className="circle filled" onClick={clearFriend} aria-label="Back"><BackIcon /></button>
        <h1>Together</h1>
      </div>
      <div className="list profile-list">
        <div className="tg-hero">
          <PrivateBadge />
          <h2 className="tg-hero-title">{copy.title}</h2>
          <p className="tg-hero-body">{copy.body}</p>
          {status?.started_on ? (
            <span className="tg-chip">Together since {scrapbookDateLabel(status.started_on)}</span>
          ) : null}
          {copy.action ? (
            <button type="button" className="btn-dark" onClick={onToggleOptIn} disabled={busy}>
              {busy ? 'Saving…' : copy.action}
            </button>
          ) : null}
        </div>

        {error ? <div className="error" role="alert"><span>{error}</span><button onClick={() => load(friend.id)}>Retry</button></div> : null}

        <div className="tg-tabs" role="tablist" aria-label="Together">
          {[['timeline', 'Timeline'], ['scrapbook', 'Scrapbook'], ['onthisday', 'On this day']].map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`tg-tab ${tab === value ? 'on' : ''}`}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {state === 'on' && tab === 'timeline' ? (
          <TimelinePane
            rows={timeline} loading={loading} filter={filter} onFilter={setFilter}
            onRetry={() => load(friend.id)}
          />
        ) : null}
        {state === 'on' && tab === 'onthisday'
          ? (
            <OnThisDayPane
              capsules={capsules} loading={loading} resolve={resolveCapsule}
              onOpen={setViewing} onRetry={() => load(friend.id)}
            />
          )
          : null}
        {/* Reading the scrapbook stays open whatever the toggle says: if
            opting out hid the rows, either person could hold the other's
            memories behind a switch. Only WRITING is gated, which is what
            opt-in is actually for — and the server enforces the same line. */}
        {tab === 'scrapbook' ? (
          <ScrapbookPane
            items={items} loading={loading} me={me} friendName={friendName} busy={busy}
            canAdd={state === 'on'}
            onOpen={setViewing} onDelete={setRemoving}
            onNote={onNote} onPhoto={onPhoto} onVoice={onVoice}
            onPurgeMine={() => setConfirming('purge-mine')}
            onRetry={() => load(friend.id)}
          />
        ) : null}
        {state !== 'on' && tab !== 'scrapbook' ? (
          <section className="tg-pane" aria-label="Together is off">
            <PrivateBadge />
            <p className="field-hint">
              The timeline and “on this day” open once you have both turned Together on.
            </p>
          </section>
        ) : null}
      </div>

      {viewing ? <PhotoViewer item={viewing} onClose={() => setViewing(null)} /> : null}
      {purgeCopy ? (
        <Confirm
          title={purgeCopy.title}
          body={<LossList loses={purgeCopy.loses} keeps={purgeCopy.keeps} />}
          confirmLabel={purgeCopy.confirmLabel}
          onCancel={() => setConfirming(null)}
          onConfirm={confirming === 'optout' ? confirmOptOut : confirmPurgeMine}
        />
      ) : null}
      {removing ? (
        <Confirm
          title="Remove this from the scrapbook?"
          body="It goes for both of you and the file is deleted. This can't be undone."
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={confirmRemove}
        />
      ) : null}
    </div>
  )
}
