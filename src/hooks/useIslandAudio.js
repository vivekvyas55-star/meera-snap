import { useCallback, useEffect, useRef, useState } from 'react'

// Original synthesized soundtrack: nothing downloaded, recorded or transmitted.
export function useIslandAudio(deliveries){
 const audio=useRef(null),[enabled,setEnabled]=useState(false),[unavailable,setUnavailable]=useState(false),previous=useRef(deliveries)
 const stop=useCallback(()=>{const a=audio.current;if(a){clearInterval(a.timer);a.ctx.close().catch(()=>{});audio.current=null}},[])
 const toggle=async()=>{
  if(audio.current){stop();setEnabled(false);return}
  const Audio=window.AudioContext||window.webkitAudioContext
  if(!Audio){setUnavailable(true);return}
  try{
   const ctx=new Audio(),gain=ctx.createGain();gain.gain.value=.12;gain.connect(ctx.destination)
   const tone=(hz,start,duration,volume=.25,type='sine')=>{if(ctx.state!=='running')return;const o=ctx.createOscillator(),g=ctx.createGain();o.type=type;o.frequency.value=hz;g.gain.setValueAtTime(.001,start);g.gain.linearRampToValueAtTime(volume,start+.025);g.gain.exponentialRampToValueAtTime(.001,start+duration);o.connect(g);g.connect(gain);o.start(start);o.stop(start+duration+.02);o.onended=()=>{o.disconnect();g.disconnect()}}
   await ctx.resume();let beat=0
   const chords=[[261.63,329.63,392],[220,261.63,329.63],[174.61,220,261.63],[196,246.94,293.66]]
   const tick=()=>{if(ctx.state!=='running')return;const chord=chords[Math.floor(beat/16)%4],t=ctx.currentTime+.02;if(beat%8===0){chord.forEach(f=>tone(f/2,t,3.8,.12,'triangle'))}const melody=[0,2,1,2,0,1,2,1];tone(chord[melody[beat%8]]*(beat%4===3?2:1),t,1.2,.22);beat++}
   tick();audio.current={ctx,tone,timer:setInterval(tick,430)};setEnabled(true);setUnavailable(false)
  }catch{stop();setUnavailable(true);setEnabled(false)}
 }
 useEffect(()=>{if(deliveries>previous.current&&audio.current){const {ctx,tone}=audio.current;[523.25,659.25,783.99].forEach((f,i)=>tone(f,ctx.currentTime+i*.13,.65,.3))}previous.current=deliveries},[deliveries])
 useEffect(()=>{const visibility=()=>{const ctx=audio.current?.ctx;if(!ctx)return;if(document.hidden)ctx.suspend().catch(()=>{});else ctx.resume().catch(()=>{})};document.addEventListener('visibilitychange',visibility);return()=>{document.removeEventListener('visibilitychange',visibility);stop()}},[stop])
 return {enabled,unavailable,toggle}
}
