import { lazy, Suspense, useRef, useState } from 'react'
import Portal from './Portal'
import Sheet from './Sheet'
import Confirm from './Confirm'
import { useSharedPlay } from '../hooks/useSharedPlay'
import { SHARED_GAMES, activityLabel, actSharedPlay, createSharedPlay, isPendingFor, titleFor } from '../lib/sharedPlay'
import '../styles/sharedPlay.css'
const PostcardIsland = lazy(() => import('./PostcardIsland'))

function Activity({ row, me, busy, act }) {
  const [value, setValue] = useState('')
  const [remove, setRemove] = useState(false)
  const [island, setIsland] = useState(false)
  const active = row.status === 'active' && row.turn === me
  const ended = ['done', 'dismissed'].includes(row.status)
  const submit = async text => { if (await act(row, 'move', text)) setValue('') }
  return <article className="shared-card">
    <div className="shared-card-head"><h3>{titleFor(row)}</h3><span>{new Date(row.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} expiry</span></div>
    <p className="shared-state">{activityLabel(row, me)}</p>
    {row.kind === 'island' && row.status !== 'pending' && row.status !== 'dismissed' && <button className="btn-dark" onClick={() => setIsland(true)}>Open island · {row.data.delivered.length}/5 delivered</button>}
    {island && <Suspense fallback={<p>Opening island…</p>}><PostcardIsland initial={row} me={me} onClose={() => setIsland(false)} /></Suspense>}
    {row.data.prompt && <p className="shared-prompt">{row.data.prompt}</p>}
    {row.kind === 'date' && <p className="shared-prompt">{row.data.text}</p>}
    {row.data.entries && <ol className="shared-entries">{row.data.entries.map((entry, i) => <li key={i}><span>{entry.by === me ? 'You' : 'Partner'}</span>{entry.text}</li>)}</ol>}
    {row.kind === 'word' && <p className="shared-help">{row.data.entries.length}/12 words · start with “{row.data.entries.at(-1).text.slice(-1).toUpperCase()}”. You judge whether a word is real; spelling is not dictionary-checked.</p>}
    {row.kind === 'story' && <p className="shared-help">{row.data.entries.length}/8 sentences · add a twist, a talking animal or an unexpected visitor.</p>}
    {row.status === 'done' && ['pick', 'emoji'].includes(row.kind) && <div className="shared-reveal"><strong>{row.data.correct ? 'You got it!' : 'A surprise reveal!'}</strong><p>Answer: {row.kind === 'pick' ? row.data[row.data.answer] : row.data.answer}</p><p>Guess: {row.kind === 'pick' ? row.data[row.data.guess] : row.data.guess}</p></div>}
    {row.kind === 'pick' && !ended && <div className="shared-actions">{['a','b'].map(key => <button key={key} disabled={busy || !active} onClick={() => submit(key)}>{row.data[key]}</button>)}</div>}
    {active && ['emoji','word','story'].includes(row.kind) && <form className="shared-compose" onSubmit={e => { e.preventDefault(); submit(value) }}><label>{row.kind === 'emoji' ? 'Your guess' : row.kind === 'word' ? 'Next word' : 'Your next sentence'}<input value={value} onChange={e => setValue(e.target.value)} maxLength={row.kind === 'story' ? 240 : row.kind === 'word' ? 24 : 80} disabled={busy} /></label><button className="btn-dark" disabled={busy || !value.trim()}>Send turn</button></form>}
    <div className="shared-actions">
      {row.status === 'pending' && row.creator !== me && row.kind !== 'date' && <button className="btn-dark" disabled={busy} onClick={() => act(row,'accept','')}>Join game</button>}
      {row.kind === 'date' && !ended && !(row.data.likes || []).includes(me) && <button className="btn-dark" disabled={busy} onClick={() => act(row,'interest','')}>I’d like this too</button>}
      {!ended && <button disabled={busy} onClick={() => act(row,'dismiss','')}>{row.creator === me ? 'End activity' : 'Pass for now'}</button>}
      {ended && <button disabled={busy} onClick={() => setRemove(true)}>Remove for both</button>}
    </div>
    {remove && <Confirm title="Remove this activity?" body="Its turns or date idea will be removed for both of you." confirmLabel="Remove" onCancel={() => setRemove(false)} onConfirm={async () => { if (await act(row,'remove','')) setRemove(false) }} />}
  </article>
}

function NewActivity({ kind, busy, create }) {
  const spec = SHARED_GAMES[kind]
  const [prompt, setPrompt] = useState(spec?.prompt || '')
  const [a, setA] = useState('A cozy movie night')
  const [b, setB] = useState('An unplanned adventure')
  const [answer, setAnswer] = useState(kind === 'pick' ? 'a' : '')
  const [text, setText] = useState(['word','story'].includes(kind) ? spec.prompt : '')
  return <form className="shared-create" onSubmit={async e => { e.preventDefault(); await create(kind, { prompt, a, b, answer, text }) }}>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <h3>{spec?.title || 'Add to your date jar'}</h3>
    <p className="shared-help">{spec?.detail || 'An idea you can both return to. Each idea stays for 30 days; either person can remove it.'}</p>
    {kind === 'island' ? <p className="shared-help">Both of you can move at the same time. Collect letters at the post office, explore the island and stand on two gold pads together to open the north. The island stays saved if either of you leaves. Invite first, then both open the island.</p> : ['pick','emoji'].includes(kind) ? <><label>{kind === 'pick' ? 'Your question' : 'Emoji clue'}<input required value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={160} /></label>
      {kind === 'pick' ? <><label>First choice<input required maxLength={60} value={a} onChange={e => setA(e.target.value)} /></label><label>Second choice<input required maxLength={60} value={b} onChange={e => setB(e.target.value)} /></label><label>Your secret pick<select value={answer} onChange={e => setAnswer(e.target.value)}><option value="a">First choice</option><option value="b">Second choice</option></select></label></> : <label>Secret answer<input required maxLength={80} value={answer} onChange={e => setAnswer(e.target.value)} autoComplete="off" /></label>}
      <p className="shared-help">The answer stays hidden until your partner guesses. Emoji answers match ignoring case and surrounding spaces.</p></> : <label>{kind === 'date' ? 'Your idea' : kind === 'word' ? 'Starting word' : 'Opening sentence'}<input required value={text} maxLength={kind === 'word' ? 24 : kind === 'story' ? 240 : 160} onChange={e => setText(e.target.value)} /></label>}
    <button className="btn-dark" disabled={busy}>{busy ? 'Saving…' : kind === 'date' ? 'Add shared idea' : 'Invite to play'}</button>
    </fieldset>
  </form>
}

export default function SharedPlay({ me, other, compact = false, continuations = [] }) {
  const state = useSharedPlay(other)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('continue')
  const [kind, setKind] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [spotlight, setSpotlight] = useState(null)
  const lock = useRef(false)
  const retry = useRef(null)
  const pending = state.rows.filter(row => isPendingFor(row, me))
  const rows = state.rows.filter(row => tab === 'jar' ? row.kind === 'date' : row.kind !== 'date')
  const run = async (key, operation) => {
    if (lock.current) return false
    lock.current = true; setBusy(true); setError('')
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() }
    try { await operation(retry.current.id); retry.current = null; await state.refresh(); return true }
    catch (err) { setError(err.message || 'Could not save. Your draft is still here.'); await state.refresh(); return false }
    finally { lock.current = false; setBusy(false) }
  }
  const act = (row, action, value) => run(JSON.stringify([row.id,row.revision,action,value]), id => actSharedPlay(row,action,value,id))
  const create = async (game, body) => {
    const ok = await run(JSON.stringify([other,game,body]), id => createSharedPlay(other,game,body,id))
    if (ok) { setKind(null); setTab(game === 'date' ? 'jar' : 'continue') }
  }
  if (!other || state.unavailable) return null
  return <>
    <button type="button" className={`shared-entry ${compact ? 'shared-entry-compact' : ''}`} onClick={() => setOpen(true)}>
      <span><strong>{compact ? 'Play & date jar' : 'Continue together'}</strong><small>{state.loading ? 'Loading shared activities…' : state.error ? 'Activities need a refresh' : pending.length + continuations.length ? `${pending.length + continuations.length} waiting for you` : 'Five playful games · your shared date jar'}</small></span><span aria-hidden="true">↗</span>
    </button>
    {open && <Portal><Sheet label="Continue together" onClose={() => { if (!lock.current) { setOpen(false); setKind(null); setError('') } }}><div className="shared-space">
      <div className="shared-card-head"><h2>Continue together</h2><button onClick={() => setOpen(false)} disabled={busy} aria-label="Close shared activities">×</button></div>
      <p className="shared-help">Explore an island live, or take turns whenever you’re free. Your games wait here for you.</p>
      <div className="shared-tabs">{[['continue','Games'],['new','Start something'],['jar','Date jar']].map(([id,label]) => <button key={id} aria-pressed={tab === id} disabled={busy} onClick={() => { setTab(id); setKind(null); setError('') }}>{label}</button>)}</div>
      {(error || state.error) && <p role="alert">{error || state.error} <button disabled={busy} onClick={state.refresh}>Refresh</button></p>}
      {state.loading && <p role="status">Loading your space…</p>}
      {tab === 'new' && !kind && <div className="shared-catalogue">{Object.entries(SHARED_GAMES).map(([id,spec]) => <button key={id} onClick={() => setKind(id)}><span aria-hidden="true">{spec.icon}</span><strong>{spec.title}</strong><small>{spec.detail}</small></button>)}</div>}
      {tab === 'jar' && !kind && <div className="shared-actions"><button onClick={() => setKind('date')}>Add an idea</button><button disabled={!rows.some(row => row.status !== 'dismissed')} onClick={() => {
        const candidates = rows.filter(row => row.status !== 'dismissed' && row.id !== spotlight)
        const chosen = candidates[Math.floor(Math.random()*candidates.length)] || rows.find(row => row.status !== 'dismissed')
        setSpotlight(chosen?.id)
      }}>Shake the jar</button></div>}
      {kind && <><button disabled={busy} onClick={() => setKind(null)}>Back to activities</button><NewActivity key={kind} kind={kind} busy={busy} create={create} /></>}
      {!kind && tab !== 'new' && <>
        {tab === 'continue' && continuations.map(item => <button key={item.key} onClick={() => { setOpen(false); item.open() }}><strong>{item.text}</strong> · Continue →</button>)}
        {!state.loading && !state.error && !rows.length && <p className="shared-help">{tab === 'jar' ? 'Add a tiny adventure, a meal or something you’ve always wanted to try together.' : 'Start a game. It will be waiting here when either of you returns.'}</p>}
        {[...rows].sort((a,b) => Number(b.id === spotlight)-Number(a.id === spotlight) || Number(isPendingFor(b,me))-Number(isPendingFor(a,me))).map(row => <div key={row.id} className={row.id === spotlight ? 'shared-spotlight' : ''}>{row.id === spotlight && <p className="shared-help">The jar picked this one ✨</p>}<Activity row={row} me={me} busy={busy} act={act} /></div>)}
      </>}
      <details className="shared-help"><summary>Privacy, expiry &amp; reminders</summary><p>Private to this pair. Games expire after 7 days; date ideas after 30. Unsent drafts are not saved. Open this space to check for replies; push reminders are not available yet. Both interested means you like the idea, not that a date is booked. Content is stored on Meera’s server and is not end-to-end encrypted.</p></details>
    </div></Sheet></Portal>}
  </>
}
