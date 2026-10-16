import assert from 'node:assert/strict'
export async function checkIsland(db,asUser,A,B,C){
 const q=async(sql,args=[])=>(await db.query(sql,args)).rows
 const id=crypto.randomUUID()
 await asUser(A,()=>q('select shared_play_create($1,$2,$3,$4)',[B,'island',{},id]))
 const call=(user,sequence,command)=>asUser(user,async()=>(await q('select island_act($1,$2,$3) row',[id,sequence,command]))[0].row)
 await assert.rejects(call(B,1,'up'))
 await asUser(B,()=>q("select shared_play_act($1,0,'accept','',$2)",[id,crypto.randomUUID()]))
 await assert.rejects(call(C,1,'up'))
 await assert.rejects(call(A,50,'up'))
 await assert.rejects(call(A,1,'teleport'))
 let row=await call(A,1,'up')
 const revision=row.revision
 row=await call(A,1,'up');assert.equal(row.revision,revision,'retry must not move twice')
 await assert.rejects(call(A,2,'up'),'server rate limit')
 row=await call(B,1,'up');assert.equal(row.data.a.y,7);assert.equal(row.data.b.y,7,'independent players retain both moves')
 const move=async(user,cmd)=>{
   const slot=user===A?'a':'b'
   await db.query("update shared_play set data=jsonb_set(data,$2::text[],'null') where id=$1",[id,[slot,'at']])
   row=await call(user,row.data[slot].seq+1,cmd)
 }
 const go=async(user,x,y)=>{
   const slot=user===A?'a':'b', p=row.data[slot], queue=[[p.x,p.y,[]]],seen=new Set()
   while(queue.length){const [cx,cy,path]=queue.shift();if(cx===x&&cy===y){for(const step of path)await move(user,step);return}
     for(const [cmd,dx,dy] of [['up',0,-1],['down',0,1],['left',-1,0],['right',1,0]]){
       const nx=cx+dx,ny=cy+dy,key=`${nx},${ny}`
       if(nx<1||nx>9||ny<1||ny>9||(ny===4&&![3,7].includes(nx))||(ny<=2&&!row.data.bridge)||seen.has(key))continue
       seen.add(key);queue.push([nx,ny,[...path,cmd]])
     }
   }throw Error('No route')
 }
 await go(A,3,5);await go(B,7,5);assert.equal(row.data.bridge,true,'two players unlock route')
 await go(A,5,8);await move(A,'interact');assert.equal(row.data.a.bag,0)
 await go(B,5,8);await move(B,'interact');assert.equal(row.data.b.bag,1,'cannot claim the same letter')
 await go(A,2,7);await move(A,'interact');assert.deepEqual(row.data.delivered,[0])
 await go(B,8,7);await move(B,'interact');assert.equal(row.data.delivered.length,2)
 for(const [x,y] of [[2,3],[8,3],[5,1]]){await go(A,5,8);await move(A,'interact');await go(A,x,y);await move(A,'interact')}
 assert.equal(row.status,'done');assert.equal(row.data.delivered.length,5)
 await assert.rejects(call(A,row.data.a.seq+1,'up'))
 console.log('PASS island: independent movement, retry, server speed limit, access, shared unlock and all deliveries')
}
