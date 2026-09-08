import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const db = new PGlite({ extensions: { citext, pgcrypto } })
await db.exec(`
 create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create schema storage; create schema realtime;
 create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', encrypted_password text, updated_at timestamptz);
 create table auth.sessions(id uuid primary key, user_id uuid);
 create table auth.refresh_tokens(user_id text);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated,anon;
 create table storage.buckets(id text primary key,name text,public boolean);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
 create table realtime.messages(topic text,extension text);
 alter table realtime.messages enable row level security;
 create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
 create publication supabase_realtime;
 create schema if not exists extensions;
 create schema if not exists vault;
 create schema if not exists net;
 create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
 create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
 create function vault.create_secret(secret text, name text default null, description text default '') returns uuid
   language sql as $$ insert into vault.secrets(name,secret,description) values(name,secret,description) returning id $$;
 create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
`)
try {
 await db.exec(fs.readFileSync('supabase/migrations/202609060000_baseline.sql','utf8'))
 console.log('PASS fresh baseline')
 await db.exec(fs.readFileSync('supabase/migrations/202609060001_audit_fixes.sql','utf8'))
 console.log('PASS audit upgrade')
 await db.exec(fs.readFileSync('supabase/migrations/202609060001_audit_fixes.sql','utf8'))
 console.log('PASS upgrade replay')
 // Enumerated, not listed. A hand-written list silently skipped four
 // migrations, so they had never once been executed against a real Postgres —
 // a broken one would have reached production having passed every check.
 const applied = new Set(['202609060000_baseline.sql','202609060001_audit_fixes.sql'])
 for (const migration of fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(migration)) continue
  const sql = fs.readFileSync(`supabase/migrations/${migration}`,'utf8')
   .replace(/create extension[^;]*;/gi, '')
  await db.exec(sql)
 }
 console.log('PASS follow-up upgrade chain')
} catch (err) { console.error('Migration failure:',err.message,err.where,err.position); await db.close(); process.exit(1) }
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',C='00000000-0000-4000-8000-000000000003'
const query = async (sql,args=[]) => (await db.query(sql,args)).rows
const insertedUsers = await db.query(`insert into auth.users(id,email,raw_user_meta_data) values($1,'alice@meera.local',$2),($3,'bobby@meera.local','{}'),($4,'carol@meera.local','{}') returning raw_user_meta_data`,[A,JSON.stringify({recovery_question:'A question',recovery_answer:'secret answer'}),B,C])
assert.equal(insertedUsers.rows[0].raw_user_meta_data.recovery_answer,undefined)
assert.equal((await query('select raw_user_meta_data from auth.users where id=$1',[A]))[0].raw_user_meta_data.recovery_answer,undefined)
assert.equal((await query('select count(*)::int n from public.security_questions where user_id=$1',[A]))[0].n,1)
console.log('PASS transactional recovery setup and metadata scrubbing')
await db.query(`insert into public.friendships(user_a,user_b,requested_by,status) values($1,$2,$1,'accepted')`,[A,B])
async function asUser(id, fn) {
 await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[id])
 await db.exec('set role authenticated')
 try { return await fn() } finally { await db.exec('reset role') }
}
await asUser(A,async()=>{
 assert.equal((await query("select public.realtime_allowed($1,true) ok",[`signal:${B}:${A}`]))[0].ok,true)
 assert.equal((await query("select public.realtime_allowed($1,true) ok",[`signal:${A}:${B}`]))[0].ok,false)
 assert.equal((await query("select public.realtime_allowed($1,false) ok",[`online:${C}`]))[0].ok,false)
 const privileges=await query("select has_function_privilege('authenticated','public.send_morning_quotes()','execute') ok")
 assert.equal(privileges[0].ok,false)
})
console.log('PASS private writer identity, stranger presence and bot execution restrictions')
// Identical timestamps must page without dropping the boundary row.
await db.query(`insert into public.messages(user_a,user_b,sender_id,kind,body,created_at) select $1,$2,$1,'chat','message '||n,now() from generate_series(1,3) n`,[A,B])
await asUser(B,async()=>{
 const page=await query('select * from message_page($1,null,null,2)',[A])
 assert.equal(page.length,2)
 const older=await query('select * from message_page($1,$2,$3,2)',[A,page[1].created_at,page[1].id])
 assert.equal(older.length,1)
 assert.equal(new Set([...page,...older].map(m=>m.id)).size,3)
 const visit='10000000-0000-4000-8000-000000000001'
 await query('select mark_messages_seen($1,$2,$3)',[A,[page[0].id],visit])
 await query('select leave_seen_messages($1,$2,$3)',[A,[page[0].id,page[1].id],visit])
 await query('select leave_seen_messages($1,$2,$3)',[A,[page[0].id],visit])
 const rows=await query('select id,view_leaves,opened_at from messages')
 assert.equal(rows.find(m=>m.id===page[0].id).view_leaves[B],1)
 assert.equal(rows.find(m=>m.id===page[1].id).opened_at,null)
})
console.log('PASS composite paging and exact seen IDs with idempotent leave')
await asUser(A,async()=>{
 const prompt=(await query('select * from todays_prompt()'))[0]
 await assert.rejects(query('select answer_daily_prompt($1,$2,$3,$4)',[B,prompt.id,'test','2000-01-01']))
 await query('select answer_daily_prompt($1,$2,$3,$4)',[B,prompt.id,'test',prompt.on_date])
 await assert.rejects(query('select answer_daily_prompt($1,$2,$3,$4)',[B,prompt.id,'duplicate',prompt.on_date]))
})
console.log('PASS daily prompt day validation and single answer')
await db.query(`insert into public.messages(user_a,user_b,sender_id,kind,body,created_at,opened_at) values($1,$2,$1,'call','voice|ended',now()-interval '40 days',now()-interval '39 days')`,[A,B])
await db.exec('select public.purge_expired()')
assert.equal((await query("select count(*)::int n from public.messages where kind='call'"))[0].n,1)
console.log('PASS call history survives purge')
// Media ownership and cleanup are enforced by real SQL, including late references.
const ownedPath=`${A}/snaps/test.jpg`
await asUser(A,()=>query('select queue_media_cleanup($1)',[ownedPath]))
await db.query("insert into storage.objects(bucket_id,name) values('media',$1)",[ownedPath])
await asUser(A,()=>query("insert into messages(user_a,user_b,sender_id,kind,media_path,media_type) values($1,$2,$1,'snap',$3,'image')",[A,B,ownedPath]))
await db.query("update media_cleanup set due_at=now()-interval '1 hour' where path=$1",[ownedPath])
assert.equal((await query('select claim_media_cleanup($1) ok',[ownedPath]))[0].ok,false)
const thumbPath=`${A}/snaps/test-thumb.jpg`
const fullWithThumb=`${A}/snaps/test-with-thumb.jpg`
await asUser(A,()=>query('select queue_media_cleanup($1)',[thumbPath]))
await asUser(A,()=>query('select queue_media_cleanup($1)',[fullWithThumb]))
await db.query("insert into storage.objects(bucket_id,name) values('media',$1)",[thumbPath])
await db.query("insert into storage.objects(bucket_id,name) values('media',$1)",[fullWithThumb])
await asUser(A,()=>query("insert into messages(user_a,user_b,sender_id,kind,media_path,thumb_path,media_type) values($1,$2,$1,'snap',$3,$4,'image')",[A,B,fullWithThumb,thumbPath]))
await db.query("update media_cleanup set due_at=now()-interval '1 hour' where path=$1",[thumbPath])
assert.equal((await query('select claim_media_cleanup($1) ok',[thumbPath]))[0].ok,false)
await asUser(B,()=>assert.rejects(query("insert into messages(user_a,user_b,sender_id,kind,media_path,media_type) values($1,$2,$2,'snap',$3,'image')",[A,B,ownedPath])))
const orphan=`${A}/snaps/orphan.jpg`
await asUser(A,()=>query('select queue_media_cleanup($1)',[orphan]))
await db.query("insert into storage.objects(bucket_id,name) values('media',$1)",[orphan])
await db.query("update media_cleanup set due_at=now()-interval '1 hour' where path=$1",[orphan])
assert.equal((await query('select claim_media_cleanup($1) ok',[orphan]))[0].ok,true)
await asUser(A,()=>assert.rejects(query("insert into messages(user_a,user_b,sender_id,kind,media_path,media_type) values($1,$2,$1,'snap',$3,'image')",[A,B,orphan])))
console.log('PASS media ownership, referenced-file preservation and cleanup locking')
// Pair-question badges only represent prompts visible today, and the ask cap
// has a stable lock plus a user-facing length error.
await db.query("insert into public.pair_questions(user_a,user_b,asker,body,on_date) values($1,$2,$1,'old question','2000-01-01')",[A,B])
await asUser(B,async()=>{
 const oldBadge=await query('select * from pending_questions_all()')
 assert.equal(oldBadge.find(r=>r.other===A).pending,0)
})
await asUser(A,async()=>{
 await assert.rejects(query('select ask_question($1,$2)',[B,'x'.repeat(301)]),/300 characters/)
 await query('select ask_question($1,$2)',[B,'One?'])
 await query('select ask_question($1,$2)',[B,'Two?'])
 await query('select ask_question($1,$2)',[B,'Three?'])
 await assert.rejects(query('select ask_question($1,$2)',[B,'Four?']),/three questions/)
})
await asUser(B,async()=>{
 const badge=await query('select * from pending_questions_all()')
 assert.equal(badge.find(r=>r.other===A).pending,3)
})
console.log('PASS question badge freshness and daily cap')
// Credits are prepaid: a scheduled charge must not create debt, and an expired
// paid subscription cannot bypass a zero credit balance.
await db.query('update public.billing_settings set enforced=true where id')
await db.query('delete from public.credit_ledger where user_id=$1',[C])
await db.query("insert into public.subscriptions(user_id,status) values($1,'none') on conflict(user_id) do update set status='none', current_period_end=null",[C])
await asUser(C,async()=>{
 assert.equal((await query('select allowed from entitlement()'))[0].allowed,false)
})
await db.query("update public.subscriptions set status='active', current_period_end=now()-interval '1 day' where user_id=$1",[C])
await asUser(C,async()=>{
 assert.equal((await query('select allowed from entitlement()'))[0].allowed,false)
})
await db.query("update public.subscriptions set current_period_end=now()+interval '1 day' where user_id=$1",[C])
await asUser(C,async()=>{
 assert.equal((await query('select allowed from entitlement()'))[0].allowed,true)
})
await db.query("update public.subscriptions set status='none', current_period_end=null where user_id=$1",[C])
await db.query("insert into public.credit_ledger(user_id,delta,reason) values($1,98,'test_grant')",[C])
await query("select post_monthly_credits('2099-01')")
assert.equal((await query("select count(*)::int n from public.credit_ledger where user_id=$1 and period='2099-01'",[C]))[0].n,0)
console.log('PASS prepaid credits and subscription expiry')
// Recovery lockout is enforced in SQL and a successful reset revokes sessions.
await db.query("insert into auth.sessions(id,user_id) values(gen_random_uuid(),$1)",[A])
await db.query("insert into auth.refresh_tokens(user_id) values($1)",[A])
assert.equal((await query("select reset_password('alice','secret answer','new-password') ok"))[0].ok,true)
assert.equal((await query('select count(*)::int n from auth.sessions where user_id=$1',[A]))[0].n,0)
assert.equal((await query('select count(*)::int n from auth.refresh_tokens where user_id=$1',[A]))[0].n,0)
for(let i=0;i<5;i++) assert.equal((await query("select reset_password('alice','wrong','new-password') ok"))[0].ok,false)
assert.equal((await query("select reset_password('alice','secret answer','new-password') ok"))[0].ok,false)
console.log('PASS recovery session revocation and guess lockout')
// Real SQL verifies authoritative turns, authorization and timeout retries.
let game
await asUser(A, async () => { game=(await query("select * from create_game_invite($1,'ttt','test-room')",[B]))[0] })
await asUser(C, async () => {
  await assert.rejects(query('select game_room($1)',[game.id]),/unavailable/)
  assert.equal((await query('select * from game_invites where id=$1',[game.id])).length,0)
})
await asUser(A, async () => { await assert.rejects(query('select play_game_move($1,0,0)',[game.id]),/not active/) })
await asUser(B, async () => {
  assert.equal((await query("select resolve_game_invite($1,'accepted') ok",[game.id]))[0].ok,true)
  assert.equal((await query("select resolve_game_invite($1,'accepted') ok",[game.id]))[0].ok,true)
  await assert.rejects(query('select play_game_move($1,0,0)',[game.id]),/legal move/)
})
await asUser(A, async () => {
  await assert.rejects(query('select play_game_move($1,9,0)',[game.id]),/Invalid move/)
  const first=(await query('select * from play_game_move($1,0,0)',[game.id]))[0]
  const retry=(await query('select * from play_game_move($1,0,0)',[game.id]))[0]
  assert.equal(first.revision,1); assert.equal(retry.revision,1)
  assert.equal(retry.board[0],'X')
  await assert.rejects(query('select play_game_move($1,1,0)',[game.id]),/Board changed/)
  await assert.rejects(query('select play_game_move($1,1,1)',[game.id]),/legal move/)
})
await asUser(B,()=>query('select play_game_move($1,3,1)',[game.id]))
await asUser(A,()=>query('select play_game_move($1,1,2)',[game.id]))
await asUser(B,()=>query('select play_game_move($1,4,3)',[game.id]))
await asUser(A,async()=>{
  const win=(await query('select * from play_game_move($1,2,4)',[game.id]))[0]
  assert.equal(win.result,'X'); assert.equal(win.revision,5)
  assert.deepEqual((await query('select * from game_room($1)',[game.id]))[0].board,win.board)
})
await asUser(B,async()=>{
  await assert.rejects(query('select play_game_move($1,5,5)',[game.id]),/legal move/)
  await query('select end_game_room($1)',[game.id])
  assert.equal((await query('select * from active_game_rooms()')).length,0)
})
await db.query("update game_invites set expires_at=now()-interval '1 second' where id=$1",[game.id])
await db.exec('select purge_expired()')
assert.equal((await query('select * from game_invites where id=$1',[game.id])).length,0)
console.log('PASS game authorization, acceptance retries, legal turns, stale moves, saved board, win, end and expiry cleanup')

// --------------------------------------------------------------------------
// Every write the client actually performs, executed as a real authenticated
// user and rolled back.
//
// Grants gate writes BEFORE RLS, so a column the client writes without an
// explicit grant fails 42501 while the policy still reads correctly — which is
// how posting a story failed for every user, how `profiles.birthday` was
// unwritable, and how deleting your own story would have failed. Reading the
// policy cannot catch any of those. Executing the write can.
//
// The upserts replicate what supabase-js actually sends: `ignoreDuplicates`
// becomes ON CONFLICT DO NOTHING, and its absence becomes DO UPDATE SET over
// EVERY payload column — which needs UPDATE on all of them even on a first,
// non-conflicting insert. That distinction is the `story_views` bug.
async function clientWrite(label, steps) {
 await db.exec('begin')
 let failure = null
 try {
  for (const step of steps) {
   if (step.as) {
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claim.sub',$1,true)`,[step.as])
    await db.exec('set local role authenticated')
    continue
   }
   const res = await db.query(step.sql, step.args ?? [])
   if (step.rows !== undefined && res.affectedRows !== step.rows) {
    throw new Error(`affected ${res.affectedRows} rows, expected ${step.rows} — the policy filtered it out`)
   }
  }
 } catch (err) { failure = err }
 await db.exec('rollback')
 if (failure) throw new Error(`client write "${label}" fails for a legitimate user: ${failure.message}`)
}
const storyPath=`${A}/stories/s.jpg`, memoryPath=`${A}/memories/m.jpg`
await clientWrite('updateProfile / setBirthday',[{as:A},
 {sql:`update profiles set display_name='Alice',avatar_emoji='🦊',avatar_hue=200 where id=$1`,args:[A],rows:1},
 {sql:`update profiles set birthday='1996-05-28' where id=$1`,args:[A],rows:1}])
await clientWrite('friend request, accept, decline',[{as:A},
 {sql:`insert into friendships(user_a,user_b,requested_by,status) values($1,$2,$1,'pending') on conflict (user_a,user_b) do nothing`,args:[A,C],rows:1},
 {as:C},{sql:`update friendships set status='accepted' where user_a=$1 and user_b=$2`,args:[A,C],rows:1},
 {as:A},{sql:`delete from friendships where user_a=$1 and user_b=$2`,args:[A,C],rows:1}])
await clientWrite('sendChat and logCall',[{as:A},
 {sql:`insert into messages(user_a,user_b,sender_id,kind,body,client_id) values($1,$2,$1,'chat','hello',gen_random_uuid())`,args:[A,B],rows:1},
 {sql:`insert into messages(user_a,user_b,sender_id,kind,body,view_seconds,delivered_at) values($1,$2,$1,'call','voice|ended',95,now())`,args:[A,B],rows:1}])
await clientWrite('markOpened / markReplayed / markScreenshot',[{as:B},
 {sql:`update messages set opened_at=now() where user_a=$1 and user_b=$2 and sender_id=$1 and opened_at is null`,args:[A,B]},
 {sql:`update messages set replayed_at=now() where user_a=$1 and user_b=$2 and sender_id=$1`,args:[A,B]},
 {sql:`update messages set screenshot_at=now() where user_a=$1 and user_b=$2 and sender_id=$1`,args:[A,B]}])
await clientWrite('unsend',[{as:A},
 {sql:`update messages set unsent_at=now() where sender_id=$1 and kind='chat'`,args:[A]}])
await clientWrite('setMyLocation / stopSharingLocation',[{as:A},
 {sql:`insert into locations(user_id,lat,lng,sharing,updated_at) values($1,12.9,77.6,true,now()) on conflict (user_id) do update set user_id=excluded.user_id,lat=excluded.lat,lng=excluded.lng,sharing=excluded.sharing,updated_at=excluded.updated_at`,args:[A],rows:1},
 {sql:`delete from locations where user_id=$1`,args:[A],rows:1}])
await clientWrite('setAnniversaryDate',[{as:A},
 {sql:`insert into anniversaries(user_a,user_b,started_on,updated_at) values($1,$2,'2018-05-28',now()) on conflict (user_a,user_b) do update set user_a=excluded.user_a,user_b=excluded.user_b,started_on=excluded.started_on,updated_at=excluded.updated_at`,args:[A,B],rows:1}])
await clientWrite('setStatusNote / clearStatusNote',[{as:A},
 {sql:`insert into status_notes(user_id,body,created_at,expires_at) values($1,'brb',now(),now()+interval '24 hours') on conflict (user_id) do update set user_id=excluded.user_id,body=excluded.body,created_at=excluded.created_at,expires_at=excluded.expires_at`,args:[A],rows:1},
 {sql:`delete from status_notes where user_id=$1`,args:[A],rows:1}])
// The story and memory rows reference a real storage object — `integrity_followup`
// rejects a row whose file is not there, so the fixture has to upload first.
await clientWrite('postStory, markStoryViewed, deleteStory',[
 {sql:`insert into storage.objects(bucket_id,name) values('media',$1)`,args:[storyPath]},{as:A},
 {sql:`insert into stories(user_id,media_path,media_type,caption) values($1,$2,'image',null)`,args:[A,storyPath],rows:1},
 {as:B},{sql:`insert into story_views(story_id,viewer_id) select id,$1 from stories where user_id=$2 on conflict (story_id,viewer_id) do nothing`,args:[B,A],rows:1},
 {sql:`update story_views set screenshot_at=now() where viewer_id=$1`,args:[B],rows:1},
 {as:A},{sql:`delete from stories where user_id=$1`,args:[A],rows:1}])
await clientWrite('saveToMemory / deleteMemory',[
 {sql:`insert into storage.objects(bucket_id,name) values('media',$1)`,args:[memoryPath]},{as:A},
 {sql:`insert into memories(user_id,media_path,thumb_path,media_type,caption) values($1,$2,null,'image',null)`,args:[A,memoryPath],rows:1},
 {sql:`delete from memories where user_id=$1`,args:[A],rows:1}])
await clientWrite('saveSubscription / disablePush',[{as:A},
 {sql:`insert into push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) values($1,'https://push.example/x','p','a','ua') on conflict (endpoint) do update set user_id=excluded.user_id,endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent`,args:[A],rows:1},
 {sql:`delete from push_subscriptions where endpoint='https://push.example/x'`,args:[],rows:1}])
console.log('PASS every client write succeeds for a legitimate user')
await db.close()
