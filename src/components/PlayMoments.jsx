import { useEffect, useRef, useState } from 'react'
import { sendChat, sendSnap } from '../lib/db'
import { MISSIONS, DATE_IDEAS, DRAW_WORDS, nextIdea, normalizePoint } from '../lib/playMoments'
import { useAlias } from '../hooks/useAliasClock'
import { BackIcon } from './Icons'
import { peerAlias } from '../lib/alias'
import '../styles/playMoments.css'

function Drawing({ onSend, busy }) {
  const canvas = useRef(null)
  const paths = useRef([])
  const active = useRef(null)
  const preparing = useRef(false)
  const encoded = useRef(null)
  const [count, setCount] = useState(0)
  const [word, setWord] = useState(() => nextIdea(DRAW_WORDS))
  const [error, setError] = useState('')
  const paint = () => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 480)
    ctx.strokeStyle = '#342b54'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    for (const path of paths.current) {
      ctx.beginPath(); ctx.moveTo(path[0][0] * 640, path[0][1] * 480)
      for (const [x,y] of path) ctx.lineTo(x * 640, y * 480)
      if (path.length === 1) ctx.lineTo(path[0][0] * 640 + .1, path[0][1] * 480 + .1)
      ctx.stroke()
    }
  }
  useEffect(() => { paint() }, [])
  const point = e => normalizePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())
  const stop = () => { active.current = null }
  const send = () => {
    if (preparing.current) return
    setError('')
    if (encoded.current) { onSend(encoded.current); return }
    preparing.current = true
    try { canvas.current.toBlob(blob => {
      preparing.current = false
      if (!blob) { setError('Could not prepare your drawing. Try again.'); return }
      encoded.current = blob
      onSend(blob)
    }, 'image/png') } catch { preparing.current = false; setError('Could not prepare your drawing. Try again.') }
  }
  return <div className="pm-stack">
    <p>Your secret drawing prompt: <strong>{word}</strong></p>
    <p className="pm-muted">Only the drawing is sent. They guess in your chat. The Snap opens for 45 seconds; saving is off.</p>
    <canvas ref={canvas} width={640} height={480} aria-label="Drawing pad. Draw with your finger, mouse or pen." onPointerDown={e => {
      if (busy || preparing.current || active.current !== null || paths.current.length >= 200) return
      e.currentTarget.setPointerCapture(e.pointerId); active.current = e.pointerId
      encoded.current = null; paths.current.push([point(e)]); setCount(paths.current.length); paint()
    }} onPointerMove={e => {
      if (busy || preparing.current || active.current !== e.pointerId) return
      const path = paths.current[paths.current.length - 1]
      if (path.length < 2000) { path.push(point(e)); paint() }
    }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} />
    <div className="pm-actions"><button disabled={busy || !count} onClick={() => { encoded.current = null; paths.current.pop(); stop(); setCount(paths.current.length); paint() }}>Undo</button><button disabled={busy || !count} onClick={() => { encoded.current = null; paths.current = []; stop(); setCount(0); paint() }}>Clear</button><button disabled={busy} onClick={() => setWord(nextIdea(DRAW_WORDS, word))}>Another prompt</button></div>
    {error && <p role="alert">{error}</p>}
    <button className="btn-dark" disabled={busy || !count} onClick={send}>Send drawing challenge</button>
    <p className="pm-muted">Prefer words? Use Secret Missions instead. Screenshot prevention cannot be guaranteed.</p>
  </div>
}

export default function PlayMoments({ me, friends, initialFriend = '', onBack }) {
  const alias = useAlias()
  const [friend, setFriend] = useState(initialFriend)
  const [mode, setMode] = useState('mission')
  const [mission, setMission] = useState(() => nextIdea(MISSIONS))
  const [idea, setIdea] = useState(() => nextIdea(DATE_IDEAS))
  const [custom, setCustom] = useState('')
  const [ideas, setIdeas] = useState(DATE_IDEAS)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [round, setRound] = useState(0)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const attempt = useRef(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const recipient = friends.find(p => p.id === friend)
  const share = async (body, blob) => {
    if (!recipient || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    // Keep the message identity for a retry after a lost acknowledgement.
    const key = friend + ':' + body
    if (blob && attempt.current?.blob !== blob) attempt.current = null
    if (attempt.current?.key !== key) attempt.current = { key, blob, id: crypto.randomUUID() }
    try {
      if (blob) await sendSnap(me, friend, { blob, viewSeconds: 45, caption: body, allowSave: false, clientId: attempt.current.id, uploadId: crypto.randomUUID() })
      else await sendChat(me, friend, body, null, attempt.current.id)
      if (alive.current) setNotice('Sent to your private chat. They can reply whenever they are free.')
    } catch {
      if (alive.current) setError('Could not confirm delivery. Your activity is still here. Check your chat before retrying a drawing.')
    } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="app screen">
    <div className="header"><button type="button" className="circle filled" disabled={busy} onClick={onBack} aria-label="Back"><BackIcon /></button><h1>Little moments</h1></div>
    <div className="list pm-page">
      <p className="pm-muted">A little fun, on your own timing. No score to protect. Always okay to skip.</p>
      <label className="pm-stack">Private with<select value={friend} disabled={busy} onChange={e => { setFriend(e.target.value); setNotice(''); setError(''); attempt.current = null }}><option value="">Choose a friend</option>{friends.map(p => <option key={p.id} value={p.id}>{peerAlias(alias, p, 'Your friend')}{p.username ? ` · @${p.username}` : ''}</option>)}</select></label>
      {!friends.length && <p>Add a friend to share an activity. You can still explore below.</p>}
      <h2>What’s our mood?</h2>
      <div className="pm-moods">{[['mission','Make me laugh'],['draw','Create together'],['date','Just relax']].map(([id,label]) => <button key={id} disabled={busy} aria-pressed={mode === id} onClick={() => { setMode(id); setNotice(''); setError('') }}>{label}</button>)}</div>
      <section className="pm-card">
        <span className="eyebrow">{mode === 'draw' ? '2–5 minutes · reply later' : 'No timer · at your pace'}</span>
        <h2>{mode === 'mission' ? 'Secret Missions' : mode === 'draw' ? 'Draw & Guess' : 'Mystery Date Jar'}</h2>
        {mode === 'mission' && <div className="pm-stack"><p className="pm-prompt">{mission}</p><p className="pm-muted">Your mission stays on this screen until you choose to reveal it. Nothing is saved when you leave.</p><div className="pm-actions"><button disabled={busy} onClick={() => { setMission(nextIdea(MISSIONS, mission)); setNotice('') }}>Skip / another mission</button><button className="btn-dark" disabled={busy || !recipient || !!notice} onClick={() => share(`Secret mission revealed ✨\n${mission}\nNo task for you — just a little moment I wanted to share.`)}>Reveal in chat</button></div></div>}
        {mode === 'date' && <div className="pm-stack"><p className="pm-prompt">{idea}</p><div className="pm-actions"><button disabled={busy} onClick={() => { setIdea(nextIdea(ideas, idea)); setNotice('') }}>Shake the jar</button><button className="btn-dark" disabled={busy || !recipient || !!notice} onClick={() => share(`From our date jar ✨\n${idea}\nWould you like to try this? Later or another idea is completely okay.`)}>Suggest in chat</button></div><label className="pm-stack">Add your own idea<input maxLength={160} value={custom} disabled={busy} onChange={e => setCustom(e.target.value)} placeholder="Something you would both enjoy" /></label><button disabled={busy || !custom.trim() || ideas.length >= 30} onClick={() => { const value = custom.trim(); setIdeas(list => [...new Set([...list, value])]); setIdea(value); setCustom(''); setNotice('') }}>Put in this jar</button><p className="pm-muted">This visit’s jar holds up to 30 ideas. Only an idea you send is shared. Discuss a time in chat; sending does not book a date.</p></div>}
        {mode === 'draw' && <Drawing key={round} busy={busy || !recipient || !!notice} onSend={blob => share('Draw & Guess 🎨 What do you think this is? Reply with your guess in our chat.', blob)} />}
      </section>
      {busy && <p role="status">Sending…</p>}{notice && <div className="pm-stack"><p role="status" className="pm-feedback">{notice}</p><button onClick={() => { setNotice(''); attempt.current = null; setRound(n => n + 1) }}>Another moment</button></div>}{error && <p role="alert" className="pm-feedback">{error}</p>}
      <p className="pm-muted">Shared activities follow ordinary chat and Snap retention. Private to your chosen friend; not end-to-end encrypted. Unsent ideas and drawings disappear when you leave.</p>
    </div>
  </div>
}
