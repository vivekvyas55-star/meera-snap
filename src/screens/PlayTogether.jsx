import { useEffect, useMemo, useRef, useState } from 'react'
import Confirm from '../components/Confirm'
import DinoRun from '../components/DinoRun'
import EmojiDetective from '../components/EmojiDetective'
import MemoryFlip from '../components/MemoryFlip'
import { BackIcon, CheckIcon, CloseIcon, GridIcon, SmileyIcon } from '../components/Icons'
import { useAuth } from '../hooks/useAuth'
import { useAlias } from '../hooks/useAliasClock'
import { peerAlias } from '../lib/alias'
import { rematchGame, listFriendsWithProfiles, resolveGameInvite, syncGameRoom, endGameRoom, listActiveGameRooms, isVisibleTo, clearViewedChats, listMessages, sendChat, pairKey, markChatsOpened } from '../lib/db'
import { useToast } from '../hooks/useToast'
import { sendSignal, signalReceiver } from '../lib/privateRealtime'
import { peerPresence, pieceToMove, scoreboard } from '../lib/gameState'
import { GAMES, GAME_IDS, createInvite, gameOf, playTurn, titleOf } from '../lib/games'
import { CheckersBoard, ConnectFourBoard, TicTacToeBoard } from '../components/GameBoards'
import { notify } from '../lib/push'
import { supabase } from '../lib/supabase'
import { mergeMessages } from '../lib/messageState'
import '../styles/games.css'

// The catalogue's other half: lib/games.js says what a move IS for each game,
// this says what draws it. Keyed by the same game id, so a fourth game is one
// entry in each and no change to the room, the invitation or the score.
const BOARDS = { ttt: TicTacToeBoard, c4: ConnectFourBoard, checkers: CheckersBoard }

const BEST_KEY = 'meera:dino-best'

// EVERY name on these screens is the rotating alias, never display_name.
//
// A game is played with the phone flat on a table, handed round, or sitting in
// somebody's eyeline for a whole round — it is the one surface in the app that
// is routinely looked at by a third person. So the partner is "S5" here, the
// same label the chat list and the send sheets use, rather than her name.
//
// Be honest about what that buys: the alias is derived FROM the name, so it
// raises the cost of a glance and nothing more. Someone who already knows who
// you play with can map it back instantly, and no copy on these screens claims
// otherwise. See peerAlias() in lib/alias.js.
//
// `alias` is the function useAlias() returns, stable until the 30-minute bucket
// turns. Every call below is in render, never in a dependency array — the polls
// in this file (3s room sync, 6s room list) must not be re-armed by a label.
const nameOf = (alias, p) => peerAlias(alias, p, 'Your friend')

function Invite({ invite, onAccept, onDismiss, busy }) {
  const alias = useAlias()
  return <div className="game-invite" role="status"><div><strong>{nameOf(alias, invite.peer)}</strong> wants to play {titleOf(invite.game)}<span>Private to you both · invitation lasts 24 hours</span></div><div className="game-invite-actions"><button type="button" className="pill-btn" disabled={busy} onClick={onDismiss}><CloseIcon width={15} height={15} /> Dismiss</button><button type="button" className="btn-dark" disabled={busy} onClick={onAccept}><CheckIcon width={15} height={15} /> Play</button></div></div>
}

function GameChat({ me, friend }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [unread, setUnread] = useState(0)
  const scroll = useRef(null)
  const openRef = useRef(open)
  const sendingRef = useRef(false)
  const chatVersion = useRef(0)
  const toast = useToast()
  const alias = useAlias()
  const friendName = nameOf(alias, friend)
  openRef.current = open

  useEffect(() => {
    let alive = true
    const visible = (rows) => rows.filter((m) => m.kind === 'chat' && isVisibleTo(m, me)).slice(-20)
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      const version = chatVersion.current
      try {
        const { messages: rows } = await listMessages(me, friend.id)
        if (alive && version === chatVersion.current) setMessages(visible(rows))
      } catch { /* the next poll can recover */ }
    }
    refresh()
    const timer = setInterval(() => {
      setMessages((rows) => visible(rows))
      refresh()
    }, 6000)
    const { user_a, user_b } = pairKey(me, friend.id)
    const channel = supabase.channel(`updates:${me}:${crypto.randomUUID()}`, { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `user_a=eq.${user_a}` }, ({ eventType, new: row, old }) => {
        if (!alive) return
        chatVersion.current++
        if (eventType === 'DELETE') { setMessages((current) => current.filter((m) => m.id !== old?.id)); return }
        if (!row?.id || row.user_b !== user_b || row.kind !== 'chat') return
        setMessages((current) => visible(mergeMessages(current, [row])))
        if (!openRef.current && eventType === 'INSERT' && row.sender_id !== me && isVisibleTo(row, me)) setUnread((n) => n + 1)
      }).subscribe()
    return () => { alive = false; clearInterval(timer); supabase.removeChannel(channel) }
  }, [me, friend.id])

  // ONE read session per visit to the room, fired from this component's unmount
  // cleanup only — the same rule Chat.jsx follows. Keyed on `open` it minted a
  // fresh visit uuid every time the panel was toggled and ran the leave RPC on
  // every close, so opening the chat three times during a single game took
  // view_leaves 1→2→3 and put the reader into cleared_by[]: the message was gone
  // for good without them ever leaving the game.
  const readSession = useRef(null)
  useEffect(() => {
    const session = { visit: crypto.randomUUID(), seen: new Set(), pending: [] }
    readSession.current = session
    return () => {
      readSession.current = null
      Promise.allSettled(session.pending).then(() => clearViewedChats(me, friend.id, [...session.seen], session.visit)).catch(() => {})
    }
  }, [me, friend.id])
  // Opening the panel is what clears the badge; it is not a new visit.
  useEffect(() => { if (open) setUnread(0) }, [open])

  useEffect(() => {
    if (!open || !scroll.current || !readSession.current || typeof IntersectionObserver === 'undefined') return
    const session = readSession.current
    const observer = new IntersectionObserver((entries) => {
      if (document.visibilityState !== 'visible') return
      const ids = entries.filter((e) => e.isIntersecting && e.intersectionRatio >= 0.8)
        .map((e) => e.target.dataset.messageId).filter((id) => !session.seen.has(id))
      if (!ids.length) return
      ids.forEach((id) => session.seen.add(id))
      const pending = markChatsOpened(friend.id, ids, session.visit).catch(() => ids.forEach((id) => session.seen.delete(id)))
      session.pending.push(pending)
    }, { root: scroll.current, threshold: 0.8 })
    scroll.current.querySelectorAll('[data-message-id]').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [messages, open, friend.id])

  const send = async (value, fromDraft = false) => {
    const text = value.trim()
    if (!text || sendingRef.current) return
    sendingRef.current = true; setSending(true)
    try {
      const row = await sendChat(me, friend.id, text)
      chatVersion.current++
      if (row) setMessages((current) => mergeMessages(current, [row]).filter((m) => isVisibleTo(m, me)).slice(-20))
      if (fromDraft) setDraft((current) => current === value ? '' : current)
    } catch { toast('Message could not be sent. Your draft is still here.') }
    finally { sendingRef.current = false; setSending(false) }
  }
  const submit = (event) => { event.preventDefault(); send(draft, true) }

  return <div className={`game-chat ${open ? 'open' : ''}`}>
    <button type="button" className="game-chat-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span>💬 Chat while playing</span>{unread > 0 && <span className="game-chat-unread">{Math.min(unread, 9)}</span>}
    </button>
    {open && <><div className="game-chat-messages" ref={scroll} aria-live="polite">
      {messages.length === 0 ? <span className="game-chat-empty">Say something before the next move.</span> : messages.map((message) => <div key={message.id} data-message-id={message.sender_id !== me ? message.id : undefined} className={`game-chat-bubble ${message.sender_id === me ? 'mine' : ''}`}>{message.body}</div>)}
    </div><div className="game-chat-quick" aria-label="Quick replies">{['Your turn 👀', 'Nice move 🔥', '😂', 'Good game 🤝'].map((text) => <button type="button" key={text} onClick={() => send(text)} disabled={sending}>{text}</button>)}</div><form className="game-chat-compose" onSubmit={submit}><input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={300} placeholder={`Message ${friendName}`} aria-label={`Message ${friendName}`} /><button type="submit" disabled={!draft.trim() || sending}>Send</button></form></>}
  </div>
}

// ONE room, for every game in the catalogue.
//
// Nothing below asks which game it is except the two places where games really
// do differ: which board component draws it, and what a move is. Both come out
// of the catalogue (lib/games.js + BOARDS), so the invitation, acceptance,
// presence, rematch, scoreboard and the chat panel are written once. A branch
// on the game id anywhere else in here is a bug waiting for the fourth game.
//
// The ROW is the authority on which game this is. A resume handed across in
// sessionStorage (App.jsx builds one from an open chat) carries no game at all,
// so `game` is only the guess used until the first sync answers.
export function GameRoom({ me, friend, incoming, inviteId, room, mark, game, onClose }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [now, setNow] = useState(Date.now())
  const alive = useRef(false)
  const moving = useRef(false)
  const syncRef = useRef(() => {})
  const alias = useAlias()
  // Render-only. The room's effects key on `friend.id`, never on this label, so
  // a 30-minute alias turnover cannot restart the 3s sync or re-broadcast the
  // acceptance signal.
  const friendName = nameOf(alias, friend)
  const apply = (row) => {
    if (!row || !alive.current) return
    setState((current) => !current || row.revision >= current.revision ? row : current)
    setError('')
  }
  useEffect(() => {
    alive.current = true
    let syncing = false
    const sync = async () => {
      if (syncing || document.visibilityState === 'hidden') return
      syncing = true
      try { const row = await syncGameRoom(inviteId); apply(row) }
      catch { if (alive.current) setError('Connection interrupted. Your board is saved. Reconnect to continue.') }
      finally { syncing = false }
    }
    syncRef.current = sync
    sync()
    const timer = setInterval(() => { setNow(Date.now()); sync() }, 3000)
    window.addEventListener('online', sync)
    document.addEventListener('visibilitychange', sync)
    const receiver = signalReceiver(me)
      .on('broadcast', { event: 'game_changed' }, ({ payload }) => {
        if (payload?.room === room && payload.from === friend.id) sync()
      })
      .on('broadcast', { event: 'game_accept' }, ({ payload }) => {
        if (payload?.room === room && payload.from === friend.id) sync()
      }).subscribe()
    if (incoming) sendSignal(me, friend.id, 'game_accept', { room, invite_id: inviteId }).catch(() => {})
    return () => {
      alive.current = false
      clearInterval(timer)
      window.removeEventListener('online', sync)
      document.removeEventListener('visibilitychange', sync)
      receiver.close()
    }
  }, [inviteId, room, me, friend.id, incoming])
  const spec = gameOf(state?.game || game)
  const Board = BOARDS[spec.id] ?? BOARDS.ttt
  const board = state?.board || spec.initialBoard()
  const result = state?.result
  const expired = state && Date.parse(state.expires_at) <= now
  const terminal = state?.ended_at || state?.status === 'dismissed' || expired
  // Mirrors public.game_turn() via lib/gameState. Deriving it here by hand is
  // how the board ends up refusing a tap it just invited.
  const turn = state ? pieceToMove(state) : 'X'
  const ready = state?.status === 'accepted' && !terminal && !result
  // One definition of "away", shared with the chip in the conversation. These
  // were 15s here and 45s there, so the same moment could read "Friend is away"
  // in the chat and "they are in the room" on the board.
  const here = state ? peerPresence(state, me, now) === 'here' : false
  const status = !state ? 'Connecting to your room…' : expired ? 'This game has expired' :
    state.ended_at ? 'This game has ended' : state.status === 'dismissed' ? 'Invitation dismissed' :
    result ? (result === 'draw' ? 'Nobody could split you — a draw' : result === mark ? 'You won! Nicely played.' : friendName + ' wins this round') :
    state.status === 'pending' ? 'Waiting for them to accept…' : turn === mark ? 'Your turn' : friendName + "'s turn"
  // Coming back is a transition, not a level, so it has to be watched for. The
  // other three states are readable from the row at any moment; "returned" only
  // exists in the change, and without it a friend rejoining a quiet board is
  // completely silent.
  const wasHere = useRef(here)
  const [returned, setReturned] = useState(false)
  useEffect(() => {
    if (here && !wasHere.current) {
      setReturned(true)
      const t = setTimeout(() => setReturned(false), 4000)
      wasHere.current = here
      return () => clearTimeout(t)
    }
    wasHere.current = here
    return undefined
  }, [here])

  // `move` is whatever a move is for this game — a square, a column, or the
  // whole path of a multi-jump. Which of those it is, and which RPC validates
  // it, is the catalogue's business, not the room's.
  const play = async (move) => {
    if (moving.current || !ready || turn !== mark || error) return
    moving.current = true; setBusy(true)
    try {
      const row = await playTurn(spec.id, inviteId, move, state.revision)
      apply(row)
      sendSignal(me, friend.id, 'game_changed', { room }).catch(() => {})
    } catch {
      if (alive.current) setError('Move not confirmed. Sync the board before trying again.')
      syncRef.current()
    } finally { moving.current = false; if (alive.current) setBusy(false) }
  }
  // A finished board used to offer only "Save & leave" and "End game for both",
  // and the room dropped out of both players' lists the moment it was won — so
  // a second round meant a fresh invitation and another acceptance for a room
  // that was still open. Either player can start the next round; the previous
  // game is over, so there is nothing left to lose by clearing the board.
  const again = async () => {
    if (moving.current) return
    moving.current = true; setBusy(true)
    try {
      apply(await rematchGame(inviteId))
      setError('')
      sendSignal(me, friend.id, 'game_changed', { room }).catch(() => {})
    } catch {
      if (alive.current) setError('Could not start a new game. Sync and try again.')
      syncRef.current()
    } finally { moving.current = false; if (alive.current) setBusy(false) }
  }
  const end = async () => {
    try {
      await endGameRoom(inviteId)
      sendSignal(me, friend.id, 'game_changed', { room }).catch(() => {})
      onClose()
    } catch { setError('Could not end the game. Reconnect and try again.'); setConfirmEnd(false) }
  }
  return <div className="game-room">
    <div className="game-room-head"><div><span className="eyebrow">Private to you both</span><h2>{spec.title}</h2>{(state?.round || 0) > 0 && <span className="play-sub">Round {(state.round || 0) + 1}</span>}</div><button type="button" className="pill-btn pill-inline" onClick={onClose}>Save &amp; leave</button></div>
    <div className={`game-status ${ready && turn === mark ? 'your-turn' : ''}`} role="status">
      <strong>{busy ? 'Saving your move…' : status}</strong>
      <span>{state?.status === 'pending' ? 'They can accept later. You can leave and resume from Play.' : ready ? returned ? friendName + ' is back' : here ? friendName + ' is in the room' : friendName + ' is away. Your moves will wait here.' : 'Rooms are available for 24 hours from the invitation.'}</span>
    </div>
    {result && !terminal && (
      <div className="game-again">
        <button type="button" className="btn-dark" onClick={again} disabled={busy}>
          {busy ? 'Setting up…' : 'Play again'}
        </button>
        {/* Who starts alternates, and saying so stops the next round looking
            like a bug to whoever went second last time. */}
        <span className="play-sub">{pieceToMove({ revision: 0, round_start_revision: 0, round: (state?.round || 0) + 1 }) === mark ? 'You start this time' : friendName + ' starts this time'}</span>
      </div>
    )}
    {error && <div className="game-connection" role="alert">{error}<button type="button" className="pill-btn" onClick={() => syncRef.current()}>Sync board</button></div>}
    {(() => {
      const score = scoreboard(state, me)
      if (!score) return null
      return (
        <div className="game-score" role="status" aria-label={`Series score: you ${score.mine}, ${friendName} ${score.theirs}${score.drawn ? `, ${score.drawn} drawn` : ''}`}>
          <span><strong>{score.mine}</strong> You</span>
          <span className="game-score-sep">·</span>
          <span><strong>{score.theirs}</strong> {friendName}</span>
          {score.drawn > 0 && <><span className="game-score-sep">·</span><span><strong>{score.drawn}</strong> drawn</span></>}
        </div>
      )
    })()}
    <div className="game-legend"><span className={mark === 'X' ? 'mark-x' : 'mark-o'}>You · {mark}</span><span>{friendName} · {mark === 'X' ? 'O' : 'X'}</span></div>
    {/* Held back until the row has arrived: the row is what says which game
        this is, and a resume from a conversation carries no game with it, so
        drawing early would flash a Tic-Tac-Toe grid over a checkers room. */}
    {state && <Board board={board} mark={mark} revision={state.revision} disabled={!ready || busy || !!error || turn !== mark} onMove={play} />}
    <GameChat me={me} friend={friend} />
    <div className="game-room-actions"><span className="play-sub">Board saved privately · expires after 24 hours</span><button type="button" className="pill-btn" onClick={() => setConfirmEnd(true)} disabled={!!terminal}>End game for both</button></div>
    {confirmEnd && <Confirm title="End this game?" body="Both players will leave this round. You can send a new invitation whenever you like." confirmLabel="End game" onConfirm={end} onCancel={() => setConfirmEnd(false)} />}
  </div>
}

// The room under its original name. Tic-Tac-Toe was the only game for a while
// and is still the one the room's regression tests drive directly; keeping the
// export honest costs one line and means widening the catalogue did not quietly
// move what those tests are testing.
export function TicTacToe(props) {
  return <GameRoom {...props} game="ttt" />
}

export default function PlayTogether({ onBack }) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('meera:play-visibility', { detail: true }))
    return () => window.dispatchEvent(new CustomEvent('meera:play-visibility', { detail: false }))
  }, [])
  const toast = useToast()
  const actionBusy = useRef(false)
  const alias = useAlias()
  const { profile } = useAuth(); const me = profile.id
  const [best, setBest] = useState(0); const [open, setOpen] = useState(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [rooms, setRooms] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [friends, setFriends] = useState([]); const [selected, setSelected] = useState(''); const [invite, setInvite] = useState(null); const [room, setRoom] = useState(null); const [mark, setMark] = useState(null); const [accepted, setAccepted] = useState(false); const [inviteId, setInviteId] = useState(null)
  // `pick` is the game being invited; `roomGame` is the game of the room that
  // is open. They are separate because the room's game is decided by the row,
  // and browsing the catalogue behind an open board must not change it.
  const [pick, setPick] = useState('ttt'); const [roomGame, setRoomGame] = useState('ttt')
  useEffect(() => { try { setBest(Number(localStorage.getItem(BEST_KEY) || 0)) } catch {} }, [])
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const [people, games] = await Promise.all([listFriendsWithProfiles(me), listActiveGameRooms()])
        if (!alive) return
        setFriends(people.filter((f) => f.status === 'accepted' && f.profile).map((f) => f.profile))
        setRooms(games); setLoadError('')
        const pending = games.find((game) => game.recipient_id === me && game.status === 'pending')
        const peer = pending && people.find((f) => f.profile?.id === pending.sender_id)?.profile
        // Merge, never overwrite. An invitation arrives by realtime broadcast
        // before active_game_rooms() can see it, and this poll runs every six
        // seconds — clearing here made the invite card appear and then vanish
        // on its own. Only the server having a pending row, the invite
        // expiring, or the user answering it may remove the card.
        setInvite((current) => {
          if (pending && peer) return { ...pending, peer }
          if (!current) return null
          const expired = current.expires_at && new Date(current.expires_at) <= new Date()
          return expired ? null : current
        })
      } catch { if (alive) setLoadError('Could not load your games. Check your connection; we’ll retry shortly.') }
      finally { if (alive) setLoading(false) }
    }
    refresh()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 6000)
    return () => { alive = false; clearInterval(timer) }
  }, [me])
  useEffect(() => { const receiver = signalReceiver(me).on('broadcast', { event: 'game_invite' }, ({ payload, peer }) => { if (payload?.room && GAMES[payload.game]) { const next = { ...payload, id: payload.invite_id, peer }; setInvite(next); try { sessionStorage.setItem(`meera:pending-game:${me}`, JSON.stringify(next)) } catch {} } }).subscribe(); return () => receiver.close() }, [me])
  useEffect(() => { try { const raw = sessionStorage.getItem(`meera:pending-game:${me}`); if (raw) setInvite(JSON.parse(raw)) } catch {} }, [me])
  useEffect(() => { try { const raw = sessionStorage.getItem(`meera:resume-game:${me}`); if (!raw) return; const saved = JSON.parse(raw); if (!saved?.room || !saved?.peer?.id) return; setSelected(saved.peer.id); setRoom(saved.room); setInviteId(saved.id || null); setMark(saved.mark === 'O' ? 'O' : 'X'); setAccepted(true); setRoomGame(saved.game || 'ttt'); setOpen('room'); sessionStorage.removeItem(`meera:resume-game:${me}`) } catch {} }, [me])
  // Opened from a conversation with no game running yet: preselect that friend
  // so the screen is one tap from an invitation rather than a dropdown.
  useEffect(() => { try { const withId = sessionStorage.getItem(`meera:play-with:${me}`); if (!withId) return; setSelected(withId); sessionStorage.removeItem(`meera:play-with:${me}`) } catch {} }, [me])
  const record = (score) => { if (score <= best) return; setBest(score); try { localStorage.setItem(BEST_KEY, String(score)) } catch {} }
  const chosen = useMemo(() => friends.find((f) => f.id === selected), [friends, selected])
  const inviteGame = async () => {
    if (!chosen || actionBusy.current) return
    actionBusy.current = true; setActionLoading(true)
    try {
      const nextRoom = crypto.randomUUID()
      const saved = await createInvite(chosen.id, nextRoom, pick)
      setRoom(nextRoom); setMark('X'); setAccepted(false); setInviteId(saved.id); setRoomGame(pick); setOpen('room')
      notify(chosen.id, 'game')
      sendSignal(me, chosen.id, 'game_invite', { game: pick, room: nextRoom, invite_id: saved.id }).catch(() => {})
    } catch (error) { toast(error.message || 'Could not create invitation. Try again.') }
    finally { actionBusy.current = false; setActionLoading(false) }
  }
  const accept = async () => {
    if (actionBusy.current || !invite?.peer?.id) return
    actionBusy.current = true; setActionLoading(true)
    try {
      const next = invite
      if (!next.id) throw new Error('Please ask for a new invitation.')
      await resolveGameInvite(next.id, 'accepted')
      setRoom(next.room); setInviteId(next.id); setMark('O'); setAccepted(true); setRoomGame(next.game || 'ttt'); setOpen('room'); setSelected(next.peer.id); setInvite(null)
      notify(next.peer.id, 'game_accept')
      try { sessionStorage.removeItem(`meera:pending-game:${me}`) } catch {}
    } catch (error) { toast(error.message || 'Could not accept. Try again.') }
    finally { actionBusy.current = false; setActionLoading(false) }
  }
  const closeGame = () => { setOpen(null); setRoom(null); setMark(null); setAccepted(false); setInviteId(null) }
  const dismissInvite = async () => {
    if (actionBusy.current) return
    actionBusy.current = true; setActionLoading(true)
    try {
      if (invite?.id) await resolveGameInvite(invite.id, 'dismissed')
      setInvite(null); sessionStorage.removeItem(`meera:pending-game:${me}`)
    } catch { toast('Could not dismiss the invitation. Try again.') }
    finally { actionBusy.current = false; setActionLoading(false) }
  }
  const resume = (game) => {
    const peer = friends.find((f) => f.id === (game.sender_id === me ? game.recipient_id : game.sender_id))
    if (!peer) return
    if (game.status === 'pending' && game.recipient_id === me) { setInvite({ ...game, peer }); return }
    setSelected(peer.id); setRoom(game.room); setInviteId(game.id); setMark(game.sender_id === me ? 'X' : 'O'); setAccepted(game.status === 'accepted'); setRoomGame(game.game || 'ttt'); setOpen('room')
  }
  return <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
    <div className="header"><button type="button" className="circle filled" onClick={onBack} aria-label="Back"><BackIcon /></button><h1>Play</h1></div>
    <div className="list profile-list">
      {invite && <Invite busy={actionLoading} invite={invite} onAccept={accept} onDismiss={dismissInvite} />}
      {open === 'room' && chosen ? (
        <GameRoom key={inviteId} me={me} friend={chosen} incoming={mark === 'O'} accepted={accepted} inviteId={inviteId} room={room} mark={mark} game={roomGame} onClose={closeGame} />
      ) : open === 'run' ? (
        <>
          <p className="play-intro">Tap anywhere in the runner to start and jump. Your best stays only on this device.</p>
          <button type="button" className="pill-btn" onClick={() => setOpen(null)}>All games</button>
          <div style={{ marginTop: 12 }}><DinoRun best={best} onScore={record} /></div>
        </>
      ) : open === 'detective' ? (
        <>
          <p className="play-intro">A new case every day, at midnight IST. Nothing is sent anywhere.</p>
          <button type="button" className="pill-btn" onClick={() => setOpen(null)}>All games</button>
          <div style={{ marginTop: 12 }}><EmojiDetective playerId={me} /></div>
        </>
      ) : open === 'flip' ? (
        <>
          <p className="play-intro">Turn two, keep the pairs. Today&apos;s set changes at midnight IST.</p>
          <button type="button" className="pill-btn" onClick={() => setOpen(null)}>All games</button>
          <div style={{ marginTop: 12 }}><MemoryFlip playerId={me} /></div>
        </>
      ) : (
        <div className="play-grid">
          {rooms.length > 0 && (
            <section className="game-resume-list" aria-label="Your game rooms">
              <h2>Pick up &amp; play</h2>
              {rooms.map((game) => {
                const peer = friends.find((f) => f.id === (game.sender_id === me ? game.recipient_id : game.sender_id))
                return <button type="button" className="game-resume-card" key={game.id} onClick={() => resume(game)}>
                  <span><strong>{titleOf(game.game)} with {nameOf(alias, peer)}</strong><small>{game.status === 'pending' ? game.sender_id === me ? 'Invitation pending' : 'Invited you to play' : game.result ? 'Round finished' : 'Your board is saved'}</small></span>
                  <span>{game.status === 'pending' && game.recipient_id === me ? 'Review' : 'Resume'} →</span>
                </button>
              })}
            </section>
          )}
          <p className="play-intro">Small shared moments, kept between you and your people.</p>
          {/* The catalogue. Three cards, one invitation form. A friend picker
              and an Invite button per game would be three of each on screen at
              once for a choice that is made once — and there is only one room
              per friend anyway, so the pair really is "who, and which game". */}
          <div className="pg-games" role="radiogroup" aria-label="Choose a game">
            {GAME_IDS.map((id) => {
              const item = GAMES[id]
              return <button
                type="button"
                key={id}
                role="radio"
                aria-checked={pick === id}
                className={`pg-game ${pick === id ? 'is-picked' : ''}`}
                style={{ background: item.tint }}
                onClick={() => setPick(id)}
              >
                <span className="pg-game-glyph" aria-hidden="true">{item.glyph}</span>
                <span className="pg-game-copy">
                  <span className="play-title">{item.title}</span>
                  <span className="play-sub">{item.blurb}</span>
                </span>
                <span className="pg-game-tick" aria-hidden="true"><CheckIcon width={14} height={14} /></span>
              </button>
            })}
          </div>
          <div className="pg-setup">
            <span className="eyebrow">Play {gameOf(pick).title} with</span>
            {loading ? <span className="play-sub">Loading your people…</span>
              : loadError ? <span className="play-sub" role="alert">{loadError}</span>
              : friends.length === 0 ? <span className="play-sub play-empty">Add a friend to start a private game.</span>
              : <div className="pg-setup-row">
                  <select aria-label="Choose a friend to play" value={selected} onChange={(e) => setSelected(e.target.value)}>
                    <option value="">Choose friend</option>
                    {/* The one place on this screen that carries the @handle as
                        well as the alias, and for the same reason the send and
                        add sheets do: this is where you COMMIT to opening a
                        private room with a particular person. Aliases are three
                        characters derived from a name, so two friends can wear
                        the same one for half an hour — inviting the wrong person
                        into a private game is a worse privacy failure than the
                        handle sitting in a collapsed dropdown. Still never
                        display_name. */}
                    {friends.map((f) => <option key={f.id} value={f.id}>{nameOf(alias, f)}{f.username ? ` · @${f.username}` : ''}</option>)}
                  </select>
                  <button type="button" className="btn-dark" disabled={!chosen || actionLoading} onClick={inviteGame}>{actionLoading ? 'Sending…' : 'Invite'}</button>
                </div>}
          </div>
          {/* On your own. Three cards, no invitation, no friend needed — and
              nothing on this side of the screen touches the network. */}
          <span className="eyebrow pg-solo-head">On your own</span>
          <button type="button" className="play-card" style={{ background: 'var(--card)' }} onClick={() => setOpen('run')}>
            <span className="fp-row-icon">🦕</span>
            <span className="fp-row-text"><span className="play-title">Runner</span><span className="play-sub">Beat your own best. {best > 0 ? `Your best is ${best}.` : ''}</span></span>
          </button>
          <button type="button" className="play-card" style={{ background: 'var(--card)' }} onClick={() => setOpen('detective')}>
            <span className="fp-row-icon"><SmileyIcon width={20} height={20} /></span>
            <span className="fp-row-text"><span className="play-title">Emoji Detective</span><span className="play-sub">Decode a film, song, feeling or phrase. One case a day.</span></span>
          </button>
          <button type="button" className="play-card" style={{ background: 'var(--card)' }} onClick={() => setOpen('flip')}>
            <span className="fp-row-icon"><GridIcon width={20} height={20} /></span>
            <span className="fp-row-text"><span className="play-title">Memory Flip</span><span className="play-sub">Faces, places, little things and colours. Match the pairs.</span></span>
          </button>
        </div>
      )}
    </div>
  </div>
}
