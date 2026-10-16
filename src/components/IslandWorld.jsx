import { useEffect, useRef, useState } from 'react'

// All scenery is procedural and original; no assets are loaded from the reference game.
export default function IslandWorld({data,slot,fallback}){
 const host=useRef(null),latest=useRef({data,slot}),[failed,setFailed]=useState(false)
 useEffect(()=>{latest.current={data,slot}},[data,slot])
 useEffect(()=>{
  let dispose=()=>{},alive=true
  import('three').then(T=>{
   if(!alive)return
   let renderer
   try{renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'})}catch{setFailed(true);return}
   const el=host.current,scene=new T.Scene();scene.background=new T.Color('#abdcd9')
   const camera=new T.OrthographicCamera(-8,8,8,-8,.1,100);camera.position.set(14,17,18);camera.lookAt(0,0,0)
   renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap
   el.appendChild(renderer.domElement)
   scene.add(new T.HemisphereLight('#fff8e3','#88a9a1',2.3))
   const sun=new T.DirectionalLight('#fff1d0',2.8);sun.position.set(-7,14,8);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024)
   Object.assign(sun.shadow.camera,{left:-10,right:10,top:10,bottom:-10});sun.shadow.normalBias=.035;scene.add(sun)
   const materials=new Map(),textures=[]
   const mat=color=>{if(!materials.has(color))materials.set(color,new T.MeshStandardMaterial({color,roughness:1,flatShading:true}));return materials.get(color)}
   const mesh=(geometry,color,parent,x,y,z)=>{const obj=new T.Mesh(geometry,mat(color));obj.position.set(x,y,z);obj.castShadow=true;obj.receiveShadow=true;parent.add(obj);return obj}
   const box=(w,h,d,color,parent,x,y,z)=>mesh(new T.BoxGeometry(w,h,d),color,parent,x,y,z)
   const cone=(r,h,color,parent,x,y,z,n=7)=>mesh(new T.ConeGeometry(r,h,n),color,parent,x,y,z)
   const label=(text,parent,x,y,z)=>{
    const c=document.createElement('canvas');c.width=384;c.height=80;const ctx=c.getContext('2d');ctx.fillStyle='rgba(250,248,237,.93)';ctx.beginPath();ctx.roundRect(4,4,376,72,28);ctx.fill();ctx.font='bold 30px system-ui';ctx.fillStyle='#29493e';ctx.textAlign='center';ctx.fillText(text,192,51)
    const texture=new T.CanvasTexture(c);textures.push(texture);const material=new T.SpriteMaterial({map:texture,depthTest:false});const sprite=new T.Sprite(material);sprite.position.set(x,y,z);sprite.scale.set(1.7,.36,1);sprite.renderOrder=10;parent.add(sprite);return sprite
   }
   const sea=mesh(new T.PlaneGeometry(100,100),'#90cfce',scene,0,-.42,0);sea.rotation.x=-Math.PI/2;sea.receiveShadow=false
   // An island split by a tidal channel, with wooden bridges.
   for(let y=1;y<=9;y++)for(let x=1;x<=9;x++){
    if(y===4){if([3,7].includes(x)){for(let i=0;i<5;i++)box(.8,.1,.16,'#b98f61',scene,x-5,.08,y-5-.4+i*.2);for(const side of [-.44,.44]){box(.055,.48,1.05,'#f0d0a3',scene,x-5+side,.3,y-5)}}continue}
    box(1.01,.6,1.01,'#d5cba9',scene,x-5,-.3,y-5)
    box(1.01,.08,1.01,(x+y)%4===0?'#b9cc99':'#c9d8aa',scene,x-5,.035,y-5)
    // Sandy walking paths.
    box(.84,.018,.84,'#e4debf',scene,x-5,.084,y-5)
   }
   const pads=[3,7].map(x=>{const p=mesh(new T.CylinderGeometry(.33,.36,.045,24),'#f2bc51',scene,x-5,.12,0);return p})
   const arch=new T.Group();arch.position.set(0,0,-2.45);scene.add(arch)
   box(.12,1.2,.12,'#e6c28e',arch,-.6,.6,0);box(.12,1.2,.12,'#e6c28e',arch,.6,.6,0);box(1.3,.15,.12,'#e6c28e',arch,0,1.25,0)
   const gate=box(1.1,.55,.08,'#bd765f',arch,0,.6,0)
   const buildings=[]
   for(const [x,z,name,color] of [[0,3,'POST OFFICE','#bb685b'],[-3,2,'BAKERY','#c67b57'],[3,2,'TEA HOUSE','#4b857d'],[-3,-2,'GARDEN','#78905d'],[3,-2,'BOOKSHOP','#688b9e']]){
    const g=new T.Group();g.position.set(x,0,z);scene.add(g);buildings.push(g)
    box(.7,.7,.65,'#f5e9cc',g,0,.42,0)
    const roof=cone(.63,.45,color,g,0,.99,0,4);roof.rotation.y=Math.PI/4
    box(.18,.34,.03,'#725e4c',g,0,.24,.34)
    for(const side of [-.24,.24])box(.12,.16,.035,'#7fa7a7',g,side,.5,.345)
    box(.83,.1,.12,color,g,0,.69,.38)
    box(.11,.26,.12,'#e3d3b2',g,.23,1.07,-.15)
    label(name,g,0,1.5,0)
   }
   const lighthouse=new T.Group();lighthouse.position.set(0,0,-4);scene.add(lighthouse)
   mesh(new T.CylinderGeometry(.23,.38,1.65,12),'#f7ead2',lighthouse,0,.9,0)
   mesh(new T.CylinderGeometry(.29,.31,.2,12),'#b96755',lighthouse,0,1.1,0)
   mesh(new T.CylinderGeometry(.31,.31,.28,12),'#f8d88c',lighthouse,0,1.85,0)
   cone(.43,.32,'#547b87',lighthouse,0,2.16,0,12);label('LIGHTHOUSE',lighthouse,0,2.6,0)
   // Trees, flowers, rocks and seaside props sit off the walkable cells.
   const decorations=[[-4.65,-3],[-4.7,-1.8],[-4.65,1],[-4.65,3],[4.65,-3],[4.7,0],[4.65,2.8],[2,-4.65],[-2,-4.6],[1,4.65],[-2.5,4.6]]
   decorations.forEach(([x,z],i)=>{box(.6,.2,.6,'#c4d3a0',scene,x,-.06,z);box(.1,.7,.1,'#977557',scene,x,.35,z);cone(.42,.9,i%2?'#739673':'#8daa75',scene,x,.95,z);cone(.3,.7,'#91ac7e',scene,x,1.4,z)})
   for(let i=0;i<22;i++){const angle=i*2.399,x=Math.cos(angle)*5.5,z=Math.sin(angle)*5.5;mesh(new T.DodecahedronGeometry(.12+(i%3)*.07,0),'#bdc9bb',scene,x,-.25,z)}
   for(const x of [-1.6,-1.3,1.3,1.6]){box(.06,.22,.06,'#739067',scene,x,.15,3.6);mesh(new T.IcosahedronGeometry(.09,0),'#edb09b',scene,x,.3,3.6)}
   for(let i=0;i<5;i++)box(.8,.12,.25,'#a5825b',scene,0,.03,4.7+i*.25)
   const boat=new T.Group();boat.position.set(.9,-.04,6);scene.add(boat)
   box(.65,.2,1.1,'#d99b73',boat,0,0,0);box(.04,1.25,.04,'#e4d6b9',boat,0,.6,0)
   const sail=mesh(new T.ConeGeometry(.5,.9,3),'#fff4dc',boat,0,.8,0);sail.scale.z=.06
   const ripples=[];for(let i=0;i<20;i++){const x=Math.sin(i*7)*8,z=Math.cos(i*11)*8;if(Math.abs(x)<5&&Math.abs(z)<5)continue;const r=box(.55,.012,.035,'#d9eeea',scene,x,-.39,z);r.castShadow=false;ripples.push(r)}
   const players={}
   for(const s of ['a','b']){
    const g=new T.Group(),body=new T.Group();g.add(body);scene.add(g)
    box(.27,.34,.19,s==='a'?'#32678b':'#bc687a',body,0,.4,0)
    mesh(new T.SphereGeometry(.13,10,8),'#efc4a1',body,0,.72,0)
    const hair=mesh(new T.SphereGeometry(.14,8,6),'#55443a',body,0,.77,-.015);hair.scale.y=.65
    const legs=[-.08,.08].map(x=>box(.09,.23,.1,'#344b4b',body,x,.12,0))
    const bag=box(.21,.21,.1,'#e6bb75',body,0,.42,-.15)
    label(s===latest.current.slot?'YOU':'PARTNER',g,0,1.1,0).scale.set(.95,.2,1)
    const p=latest.current.data[s];g.position.set(p.x-5,.13,p.y-5);players[s]={g,body,legs,bag}
   }
   const ring=mesh(new T.TorusGeometry(.48,.035,6,32),'#f6b94e',scene,0,.12,3);ring.rotation.x=-Math.PI/2;ring.castShadow=false
   const stops=[[-3,2],[3,2],[-3,-2],[3,-2],[0,-4]]
   const resize=()=>{const w=el.clientWidth,h=el.clientHeight,aspect=w/h;const span=7.5;camera.left=-span*aspect;camera.right=span*aspect;camera.top=span;camera.bottom=-span;camera.updateProjectionMatrix();renderer.setSize(w,h,false)}
   const observer=new ResizeObserver(resize);observer.observe(el);resize()
   const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches
   let frame,last=0
   const render=time=>{frame=requestAnimationFrame(render);if(document.hidden||time-last<32)return;last=time
    const {data,slot}=latest.current
    for(const s of ['a','b']){const p=data[s],{g,body,legs,bag}=players[s];const dx=p.x-5-g.position.x,dz=p.y-5-g.position.z,moving=Math.abs(dx)+Math.abs(dz)>.025
     if(moving){body.rotation.y=Math.atan2(dx,dz);g.position.x+=dx*.32;g.position.z+=dz*.32}
     body.position.y=moving&&!reduced?Math.sin(time*.016)*.035:0;legs.forEach((leg,i)=>leg.rotation.x=moving&&!reduced?Math.sin(time*.018+i*Math.PI)*.55:0);bag.visible=p.bag>=0
    }
    const target=data[slot].bag>=0?stops[data[slot].bag]:[0,3];ring.position.set(target[0],.13,target[1]);ring.scale.setScalar(reduced?1:1+Math.sin(time*.003)*.12)
    gate.visible=!data.bridge;pads.forEach(p=>p.material=mat(data.bridge?'#80ad87':'#f2bc51'))
    boat.rotation.z=reduced?0:Math.sin(time*.001)*.035
    if(!reduced)ripples.forEach((r,i)=>r.scale.x=1+Math.sin(time*.001+i)*.2)
    renderer.render(scene,camera)
   };frame=requestAnimationFrame(render)
   const lost=e=>{e.preventDefault();dispose();setFailed(true)};renderer.domElement.addEventListener('webglcontextlost',lost)
   dispose=()=>{cancelAnimationFrame(frame);observer.disconnect();renderer.domElement.removeEventListener('webglcontextlost',lost);scene.traverse(obj=>{obj.geometry?.dispose();if(obj.material&&!materials.has(obj.material.color?.getStyle())){if(obj.isSprite)obj.material.dispose()}});materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());renderer.dispose();renderer.domElement.remove()}
  }).catch(()=>{if(alive)setFailed(true)})
  return()=>{alive=false;dispose()}
 },[])
 return failed?<>{fallback}<p className="island-hint">Lightweight map mode · 3D is unavailable on this device.</p></>:<div className="island-world" ref={host} role="img" aria-label="A three-dimensional seaside island with cottages, trees, bridges and two couriers."/>
}
