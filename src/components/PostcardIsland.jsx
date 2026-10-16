import { useCallback, useEffect, useRef, useState } from 'react'
import Portal from './Portal'
import { supabase } from '../lib/supabase'
import { listSharedPlay } from '../lib/sharedPlay'
import { sendSignal, signalReceiver } from '../lib/privateRealtime'
import '../styles/postcardIsland.css'
import IslandWorld from './IslandWorld'
import { useIslandAudio } from '../hooks/useIslandAudio'
import { useBackLayer } from '../hooks/useBackLayer'

const ISLAND_STOPS = [[2,7,'Bakery'],[8,7,'Tea house'],[2,3,'Garden'],[8,3,'Bookshop'],[5,1,'Lighthouse']]
const point = (x,y) => [220+(x-y)*20,48+(x+y)*12]
const keys = { ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',w:'up',s:'down',a:'left',d:'right',' ':'interact',Enter:'interact' }

export function IslandMap({ data, slot }) {
  return <svg viewBox="0 0 440 340" role="img" aria-label="Postcard Island map: post office in the south, two bridges across the river, lighthouse in the north.">
    <defs><linearGradient id="islandSea" x2="0" y2="1"><stop stopColor="#bfe4df"/><stop offset="1" stopColor="#83c7c9"/></linearGradient></defs>
    <rect width="440" height="340" rx="24" fill="url(#islandSea)"/>
    <path d="M25 100h30m300-35h35M30 265h35m270 35h40" stroke="#edfafa" strokeWidth="3" strokeLinecap="round" opacity=".6"/>
    {Array.from({length:9},(_,y)=>y+1).flatMap(y=>Array.from({length:9},(_,x)=>x+1).map(x=>{
      const [px,py]=point(x,y), river=y===4&&! [3,7].includes(x), pad=y===5&&[3,7].includes(x)
      if(river) return null
      return <g key={`${x}:${y}`}><path d={`M${px-20} ${py}l20 12 20-12v8l-20 12-20-12z`} fill="#8ca47d"/><path d={`M${px} ${py-12}l20 12-20 12-20-12z`} stroke="#d7d6b2" strokeWidth=".6" fill={pad?'#f8c962':y===4?'#ba916d':y<=2&&!data.bridge?'#b7c7ba':(x+y)%3===0?'#d9dfbb':'#e9e4c5'}/>{pad&&<circle cx={px} cy={py} r="5" fill={data.bridge?'#426d54':'#fff0c3'}/>}</g>
    }))}
    {[[5,8,'Post office'],...ISLAND_STOPS].map(([x,y,name],i)=>{const [px,py]=point(x,y);const done=i>0&&data.delivered.includes(i-1);return <g key={name} transform={`translate(${px} ${py-3})`}><path d="M-10 0v-18l10-6 10 6V0L0 6z" fill={done?'#6f9f83':i===0?'#e7a176':'#eee9da'} stroke="#536b62" strokeWidth="1"/><path d="M-14-18L0-30l14 12-14 8z" fill={i===5?'#6687a5':'#c37864'}/><path d="M-3 3v-9h6v9" fill="#536b62"/><text y="20" textAnchor="middle" fill="#253d39" fontSize="8" fontWeight="700">{done?'✓ ':''}{name}</text></g>})}
    {['a','b'].sort(s=>s===slot?1:-1).map(s=>{const p=data[s];const [x,y]=point(p.x,p.y);return <g key={s} className="island-person" style={{transform:`translate(${x}px,${y}px)`}}><ellipse rx="8" ry="4" fill="#213c3c" opacity=".2"/><path d="M-6-5v-10q6-6 12 0v10z" fill={s==='a'?'#284e70':'#a54565'} stroke="white" strokeWidth="1.5"/><circle cy="-21" r="5" fill="#f3cfaa"/><path d="M-5-23q5-7 10 0" fill="#463e3a"/><text y="-32" textAnchor="middle" fontSize="9" fontWeight="700" fill="#253d39">{s===slot?'YOU':'PARTNER'}{p.bag>=0?' ✉':''}</text></g>})}
    {!data.bridge&&<text x="220" y="24" textAnchor="middle" fontSize="11" fill="#254640">Stand on both gold pads to open the north</text>}
  </svg>
}

export default function PostcardIsland({ initial, me, onClose }) {
  useBackLayer(true, onClose)
  const [row,setRow]=useState(initial), [error,setError]=useState(''),[peerAt,setPeerAt]=useState(0),[now,setNow]=useState(Date.now()),[connected,setConnected]=useState(true)
  const current=useRef(row),busy=useRef(false),mounted=useRef(true),held=useRef(null),pending=useRef(null),lastMove=useRef(0)
  const slot=me===row.user_a?'a':'b', other=me===row.user_a?row.user_b:row.user_a
  const audio=useIslandAudio(row.data.delivered.length)
  const merge=useCallback(next=>{if(mounted.current&&next&&next.revision>=current.current.revision){current.current=next;setRow(next)}},[])
  const refresh=useCallback(async()=>{try{const rows=await listSharedPlay(other);if(!mounted.current)return;const next=rows.find(r=>r.id===initial.id);if(!next){setConnected(false);setError('This island expired or is no longer available.');return}merge(next);setConnected(true)}catch{if(mounted.current){setConnected(false);setError('Connection interrupted. Your island is saved. Reconnecting…')}}},[other,initial.id,merge])
  useEffect(()=>{
    mounted.current=true
    const ping=()=>sendSignal(me,other,'island-update',{room:initial.id}).catch(()=>{})
    const receiver=signalReceiver(me).on('broadcast',{event:'island-update'},({payload})=>{if(payload.from===other&&payload.room===initial.id){setPeerAt(Date.now());refresh()}}).subscribe()
    refresh();ping()
    const poll=setInterval(()=>{setNow(Date.now());if(document.visibilityState==='visible')refresh()},2000)
    const heartbeat=setInterval(()=>{if(document.visibilityState==='visible')ping()},4000)
    const wake=()=>{held.current=null;refresh();ping()}
    window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake)
    return()=>{mounted.current=false;held.current=null;clearInterval(poll);clearInterval(heartbeat);receiver.close();window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake)}
  },[me,other,initial.id,refresh])
  const move=useCallback(async(command)=>{
    if(busy.current||current.current.status!=='active'||Date.now()-lastMove.current<180)return
    lastMove.current=Date.now()
    busy.current=true
    // A failed network reply retries the same command/sequence before another move.
    const op=pending.current||{sequence:current.current.data[slot].seq+1,command}
    pending.current=op
    try{
      const {data,error:failure}=await supabase.rpc('island_act',{activity:initial.id,...op})
      if(failure)throw failure
      pending.current=null;merge(data)
      if(mounted.current){setError('');setConnected(true)}
      sendSignal(me,other,'island-update',{room:initial.id}).catch(()=>{})
    }catch(failure){
      // Explicit server rejection is safe to discard; transport failure retains identity.
      if(failure.code)pending.current=null
      held.current=null
      if(mounted.current)setError(failure.message||'Could not send that move. Tap again to retry.')
      await refresh()
    }finally{busy.current=false}
  },[initial.id,slot,merge,me,other,refresh])
  useEffect(()=>{
    const down=e=>{if(keys[e.key]){e.preventDefault();if(!e.repeat){held.current=keys[e.key];move(keys[e.key])}}}
    const up=()=>{held.current=null}
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',up)
    const tick=setInterval(()=>{if(held.current&&held.current!=='interact')move(held.current)},260)
    return()=>{clearInterval(tick);window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',up)}
  },[move])
  const p=row.data[slot], finished=row.status==='done', stopped=row.status==='dismissed'
  return <Portal><section className="island-screen" role="dialog" aria-modal="true" aria-label="Postcard Island">
    <header><div><span className="island-eyebrow">MEERA · LIVE CO-OP</span><h2>Postcard Island</h2></div><div className="island-toolbar"><button className="island-sound" onClick={audio.toggle} aria-pressed={audio.enabled}>{audio.enabled?'♫ Sound on':'♫ Sound off'}</button><button onClick={onClose} aria-label="Leave island">×</button></div></header>
    <div className="island-body">
      <div className="island-meta"><span>{connected?'Island saved':'Reconnecting…'}</span><span>{peerAt&&now-peerAt<12000?'Partner is here':'Waiting for partner to open island'}</span></div>
      <IslandWorld data={row.data} slot={slot} fallback={<IslandMap data={row.data} slot={slot}/>}/>
      {audio.unavailable&&<p className="island-hint">Audio is unavailable on this browser. You can still play.</p>}
      <div className="island-mission"><span className="island-eyebrow">{row.data.delivered.length}/5 LETTERS DELIVERED</span><h3>{finished?'A little island. A lovely team.':stopped?'This adventure has ended':p.bag>=0?`Deliver to the ${ISLAND_STOPS[p.bag][2]}`:'Collect a letter at the post office'}</h3><p>{finished?'All five neighbours got their post. Start another island from the game menu.':stopped?'You can start a new island together.':row.data.bridge?'The north is open. The lighthouse is waiting.':'Meet on the two gold pads to unlock the lighthouse route.'}</p></div>
      {error&&<p role="alert" className="island-error">{error}</p>}
      {!finished&&!stopped&&<div className="island-controls"><div className="island-dpad">{[['up','↑'],['left','←'],['down','↓'],['right','→']].map(([command,label])=><button key={command} className={`island-${command}`} aria-label={`Move ${command}`} onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);held.current=command;move(command)}} onPointerUp={()=>{held.current=null}} onPointerCancel={()=>{held.current=null}} onLostPointerCapture={()=>{held.current=null}} onClick={e=>{if(e.detail===0)move(command)}}>{label}</button>)}</div><button className="island-interact" onClick={()=>move('interact')}>✉<span>{p.bag>=0?'Deliver letter':'Collect letter'}</span></button></div>}
      <p className="island-hint">Walk beside a building, then collect or deliver. Hold arrows to walk · keyboard WASD or arrow keys · space to interact.</p>
      <button className="island-exit" onClick={onClose}>Back to activities · keep island saved</button>
    </div>
  </section></Portal>
}
