import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { checkIntimateGames } from './intimate-db.mjs'
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
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
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
// Answering was never exercised, which is the only reason a parameter/column
// collision could reach production: ask_question has the same `body` parameter
// but INSERTs, and an INSERT's VALUES list has no table columns in scope.
await asUser(B,async()=>{
 const q=(await query('select id from pair_questions where asker=$1 and answer is null order by created_at limit 1',[A]))[0]
 const answered=(await query('select * from answer_question($1,$2)',[q.id,'  because it matters  ']))[0]
 assert.equal(answered.answer,'because it matters')
 assert.notEqual(answered.answered_at,null)
 // Final once written — the same rule prompt_answers enforces with a missing
 // UPDATE grant.
 await assert.rejects(query('select answer_question($1,$2)',[q.id,'second thoughts']),/already answered/)
 await assert.rejects(query('select answer_question($1,$2)',[q.id,'   ']),/Write an answer/)
})
await asUser(A,async()=>{
 const q=(await query('select id from pair_questions where asker=$1 and answer is null order by created_at limit 1',[A]))[0]
 // The asker cannot answer their own question.
 await assert.rejects(query('select answer_question($1,$2)',[q.id,'me again']),/not yours to answer/)
})
console.log('PASS a pair question can actually be answered')
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
// Founders keep permanent access. This is silent until billing_settings.enforced
// is flipped — which is the worst possible moment to discover it — so it is
// pinned here rather than trusted.
// The harness creates its users after the migrations run, so the founding
// backfill never saw them and there is no row to update.
await db.query("insert into public.subscriptions(user_id,status) values($1,'grandfathered') on conflict (user_id) do update set status='grandfathered'",[A])
await db.query("update public.billing_settings set enforced=true")
await asUser(A,async()=>{
 const e=(await query('select * from entitlement()'))[0]
 assert.equal(e.allowed,true)
 assert.equal(e.status,'grandfathered')
})
// ...and the monthly charge must skip them, or "permanent access" quietly
// becomes "access until the balance runs out".
const before=(await query('select count(*)::int n from credit_ledger where user_id=$1 and period is not null',[A]))[0].n
await db.exec('select public.post_monthly_credits()')
const after=(await query('select count(*)::int n from credit_ledger where user_id=$1 and period is not null',[A]))[0].n
assert.equal(after,before)
await db.query("update public.billing_settings set enforced=false")
await db.query("delete from public.subscriptions where user_id=$1",[A])
// Together: the agent that built this could only exercise it from a scratchpad
// harness, so the RPCs land here permanently. plpgsql bodies are only
// name-resolved at execution, which means a migration can apply cleanly and
// still be broken until something actually calls it.
await asUser(A,async()=>{
 // The narrative is opt-in and needs BOTH sides — one person cannot switch on
 // a shared timeline for the pair.
 await query('select set_together_optin($1,true)',[B])
 const half=(await query('select * from together_status($1)',[B]))[0]
 // mine / theirs / active — one side alone must not switch on a shared timeline.
 assert.equal(half.mine,true)
 assert.equal(half.active,false)
})
await asUser(B,async()=>{
 await query('select set_together_optin($1,true)',[A])
 assert.equal((await query('select * from together_status($1)',[A]))[0].active,true)
})
await asUser(C,async()=>{
 // A stranger gets nothing, and cannot opt themselves into someone's pair.
 await assert.rejects(query('select set_together_optin($1,true)',[A]),/./)
 assert.equal((await query('select * from together_timeline($1)',[A])).length,0)
})
await asUser(A,async()=>{
 const note=(await query("select * from add_scrapbook_item(other=>$1,item_kind=>'note',item_body=>'a real note')",[B]))[0]
 assert.ok(note.id)
 // Pair-ordered like every other pair table.
 assert.equal(note.user_a < note.user_b, true)
 // The RPC CAPS rather than rejecting, so a long paste is not lost — but it
 // must never be able to write past the column's CHECK.
 const long=(await query("select * from add_scrapbook_item(other=>$1,item_kind=>'note',item_body=>$2)",[B,'x'.repeat(5000)]))[0]
 assert.equal(long.body.length,1000)
})
await asUser(B,async()=>{
 // Both parties READ the scrapbook...
 // Both parties read the scrapbook; only the author may delete.
 const items=await query('select * from together_timeline($1)',[A])
 assert.equal(items.length >= 1, true)
})
console.log('PASS together opt-in needs both sides, and a stranger gets nothing')
// --- Typed timeline events (202609140034) ----------------------------------
// These are MATERIALISED rather than derived, and only because the rows they
// are about do not survive: messages are purged at 31 days and cleared after
// three visits, and `streaks` keeps a COUNT, not a history — bump_streak
// destroys "we once reached 100" with the same statement that resets it. The
// trigger is the only chance to write any of it down, which makes this block
// the only thing that can catch a broken one.
await asUser(A,async()=>{
 const kinds=(await query('select kind from public.together_events')).map(e=>e.kind)
 // Turning it on cannot invent a past, but it does seed from evidence still on
 // disk — the call log and the snaps inserted further up, both from before
 // either of them had opted in.
 assert.equal(kinds.includes('first_call'),true)
 assert.equal(kinds.includes('first_snap'),true)
 // ...and deliberately seeds NO streak milestone. The day a streak crossed 30
 // is recorded nowhere, and guessing a date on a surface two people share is
 // how a memory becomes a small lie.
 assert.equal(kinds.includes('streak_milestone'),false)
 // A recorded row reaches the timeline beside the derived ones, carrying no
 // media: a milestone is text and a date, because the message it names is
 // going to be purged and its object collected with it.
 const line=await query('select kind,title,thumb_path from together_timeline($1)',[B])
 assert.equal(line.some(r=>r.kind==='first_call' && r.title==='Your first call'),true)
 assert.equal(line.filter(r=>['first_snap','first_call','mutual_save','streak_milestone'].includes(r.kind))
   .every(r=>r.thumb_path===null),true)
})
// An observation a user can write is a fabrication. SELECT and nothing else.
await asUser(A,async()=>{
 await assert.rejects(query("insert into together_events(user_a,user_b,kind,on_date) values($1,$2,'streak_milestone',current_date)",[A,B]),/permission denied/)
 await assert.rejects(query('update together_events set magnitude=365'),/permission denied/)
 await assert.rejects(query('delete from together_events'),/permission denied/)
})
// Not discoverable, by RLS rather than by the screen.
await asUser(C,async()=>assert.equal((await query('select count(*)::int n from together_events'))[0].n,0))
// Opt-out purges the OBSERVATIONS in the same transaction, and never the
// scrapbook — which is authored, attributed, and half of it the other person's.
await db.exec('begin')
assert.equal((await query('select count(*)::int n from together_events'))[0].n > 0,true)
await asUser(A,()=>query('select set_together_optin($1,false)',[B]))
assert.equal((await query('select count(*)::int n from together_events'))[0].n,0)
assert.equal((await query('select count(*)::int n from scrapbook_items'))[0].n > 0,true)
// ...and nothing accrues again while it is off. Opt-in is a COLLECTION gate:
// the trigger refuses to write rather than the read filtering it out. If it
// were the other way round, an opt-out would delete a pile that started
// refilling on the next message.
await db.query("insert into storage.objects(bucket_id,name) values('media',$1)",[`${A}/voice/gate.webm`])
await db.query(`insert into public.messages(user_a,user_b,sender_id,kind,media_path) values($1,$2,$1,'voice',$3)`,[A,B,`${A}/voice/gate.webm`])
assert.equal((await query('select count(*)::int n from together_events'))[0].n,0)
await db.exec('rollback')
// Milestones come from their OWN trigger on `streaks`, not from a line inside
// bump_streak — which is redefined across four files under last-applied-wins,
// so a hook in it is one future migration away from being dropped in silence.
await db.exec('begin')
await db.query('insert into public.streaks(user_a,user_b,count) values($1,$2,0) on conflict (user_a,user_b) do nothing',[A,B])
await db.query('update public.streaks set count=8,last_increment=now() where user_a=$1 and user_b=$2',[A,B])
assert.deepEqual((await query("select magnitude from together_events where kind='streak_milestone' order by magnitude")).map(r=>r.magnitude),[7])
// A streak that breaks and climbs back past 7 does not re-announce 7: a
// timeline is a list of firsts and highs, and a card you have already read is
// what made the bot quotes feel cheap.
await db.query('update public.streaks set count=0 where user_a=$1 and user_b=$2',[A,B])
await db.query('update public.streaks set count=31 where user_a=$1 and user_b=$2',[A,B])
assert.deepEqual((await query("select magnitude from together_events where kind='streak_milestone' order by magnitude")).map(r=>r.magnitude),[7,30])
await db.exec('rollback')
// "Mutually saved" means BOTH ids in saved_by, not the one-sided
// cardinality > 0 the derived row calls "kept together".
await db.exec('begin')
await db.query("insert into storage.objects(bucket_id,name) values('media',$1)",[`${A}/snaps/kept-forever.jpg`])
const keptMsg=(await db.query(`insert into public.messages(user_a,user_b,sender_id,kind,media_path,media_type) values($1,$2,$1,'snap',$3,'image') returning id`,[A,B,`${A}/snaps/kept-forever.jpg`])).rows[0]
await asUser(A,()=>query('select toggle_saved($1)',[keptMsg.id]))
assert.equal((await query("select count(*)::int n from together_events where kind='mutual_save'"))[0].n,0)
await asUser(B,()=>query('select toggle_saved($1)',[keptMsg.id]))
const mutual=await query("select dedupe,subject from together_events where kind='mutual_save'")
assert.equal(mutual.length,1)
assert.equal(mutual[0].subject,'photo')
assert.equal(mutual[0].dedupe,keptMsg.id)
// Unsaving and saving again is a retry, not a second memory.
await asUser(B,()=>query('select toggle_saved($1)',[keptMsg.id]))
await asUser(B,()=>query('select toggle_saved($1)',[keptMsg.id]))
assert.equal((await query("select count(*)::int n from together_events where kind='mutual_save'"))[0].n,1)
await db.exec('rollback')
// A block deletes the friendship on purpose, so that stories, presence, calls
// and push all stop. The old together_active() counted opt-in rows only, and
// those reference profiles — so an unfriended or blocked pair kept a working
// shared timeline. The sweep is what collects the rows a tap never reached.
await db.exec('begin')
await db.query('delete from public.friendships where user_a=$1 and user_b=$2',[A,B])
assert.equal((await query('select public.together_pair_active($1,$2) ok',[A,B]))[0].ok,false)
await asUser(A,async()=>{
 assert.equal((await query('select count(*)::int n from together_events'))[0].n,0)
 assert.equal((await query('select * from together_timeline($1)',[B])).length,0)
})
assert.equal((await query('select public.purge_together_events() n'))[0].n > 0,true)
assert.equal((await query('select count(*)::int n from together_events'))[0].n,0)
await db.exec('rollback')
// The other purge, and the only bulk delete one person may run on a shared
// artifact: their OWN entries. Executed as a real authenticated user, because
// reading the function body cannot catch the author scoping being wrong.
await db.exec('begin')
await asUser(B,()=>query("select * from add_scrapbook_item(other=>$1,item_kind=>'note',item_body=>'hers to keep')",[A]))
const mineCount=(await query('select count(*)::int n from scrapbook_items where author=$1',[A]))[0].n
assert.equal(mineCount > 0,true)
await asUser(A,async()=>assert.equal((await query('select public.purge_my_scrapbook($1) n',[B]))[0].n,mineCount))
assert.equal((await query('select count(*)::int n from scrapbook_items where author=$1',[A]))[0].n,0)
assert.equal((await query('select count(*)::int n from scrapbook_items where author=$1',[B]))[0].n,1)
await db.exec('rollback')
console.log('PASS milestones are recorded only while both have opted in, cannot be forged, and an opt-out purges them without touching the scrapbook')
console.log('PASS a grandfathered founder is allowed and never charged')
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
// --- Rematch: the next round in the same room ------------------------------
// A finished board dropped out of both players' lists, so a second game meant a
// fresh invitation and another acceptance for a room that was still open.
await asUser(A,async()=>{
  // A won room stays reachable — that is the whole point — but it must not put
  // the "they accepted your invitation" banner back on screen every time
  // somebody wins.
  assert.equal((await query('select * from active_game_rooms()')).length,1)
  assert.equal((await query('select * from accepted_game_invite_responses()')).length,0)

  // Still no moving on a board somebody already won (this assertion used to
  // live after end_game_room, which the rematch now sits in front of).
  await assert.rejects(query('select play_game_move($1,5,5)',[game.id]),/legal move/)

  const next=(await query('select * from rematch_game($1)',[game.id]))[0]
  assert.equal(next.result,null)
  assert.deepEqual(next.board,['','','','','','','','',''])
  assert.equal(next.round,1)
  // revision stays MONOTONIC: resetting it would make a stale client's
  // expected_revision from the last round look valid again in this one.
  assert.equal(next.revision,5)
  assert.equal(next.round_start_revision,5)

  // Idempotent — both players tap "Play again" on a game they watched finish
  // together, and the second call must not skip a round past the first.
  const twice=(await query('select * from rematch_game($1)',[game.id]))[0]
  assert.equal(twice.round,1)

  // The starter ALTERNATES. X moving first every round hands the inviter a
  // standing advantage, and in this game the first player is the only one who
  // can force a win.
  await assert.rejects(query('select play_game_move($1,0,5)',[game.id]),/legal move/)
})
await asUser(B,()=>query('select play_game_move($1,0,5)',[game.id]))
await asUser(A,async()=>{
  const mine=(await query('select * from play_game_move($1,1,6)',[game.id]))[0]
  assert.equal(mine.board[0],'O'); assert.equal(mine.board[1],'X')
  // Nine moves THIS ROUND, not nine revisions ever. The old draw test was
  // `revision = 9`, which in round two declares a draw partway through the
  // board — here revision is already past 9 with four squares still empty.
  assert.equal(mine.result,null)
  assert.equal(mine.revision,7)
})
// Rematching a game still in progress is a no-op rather than a board wipe.
await asUser(B,async()=>{
  const untouched=(await query('select * from rematch_game($1)',[game.id]))[0]
  assert.equal(untouched.round,1)
  assert.equal(untouched.board[0],'O')
})
// The score has to survive the rematch — carrying it across rounds is the only
// reason to keep one — and must move exactly once per round however many times
// a move is retried.
await asUser(A,async()=>{
 const row=(await query('select * from game_invites where id=$1',[game.id]))[0]
 assert.equal(row.sender_wins,1); assert.equal(row.recipient_wins,0); assert.equal(row.draws,0)
})
console.log('PASS rematch resets the board, alternates who starts, and is idempotent')
// --------------------------------------------------------------------------
// Connect Four and Checkers live in the SAME room as Tic-Tac-Toe, so the
// invitation, acceptance, presence, rematch and score are already covered
// above. What is asserted here is only what a new game adds — and, for
// Checkers, the one thing a client must never be trusted with: a whole
// multi-jump sequence, re-walked hop by hop on the server.
// --------------------------------------------------------------------------
assert.equal((await query("select array_length(game_initial_board('c4'),1) n"))[0].n, 42)
assert.equal((await query("select array_length(game_initial_board('checkers'),1) n"))[0].n, 64)
assert.equal((await query("select array_length(game_initial_board('ttt'),1) n"))[0].n, 9)
// Twelve a side, on dark squares only, and the two middle rows empty.
assert.deepEqual((await query(`select
  (select count(*) from unnest(game_initial_board('checkers')) with ordinality t(c,i) where c='x')::int x,
  (select count(*) from unnest(game_initial_board('checkers')) with ordinality t(c,i) where c='o')::int o,
  (select count(*) from unnest(game_initial_board('checkers')) with ordinality t(c,i)
     where c<>'' and ((i-1)/8 + (i-1)%8) % 2 = 0)::int on_light,
  (select count(*) from unnest(game_initial_board('checkers')) with ordinality t(c,i)
     where c<>'' and (i-1) between 24 and 39)::int in_the_middle`))[0],
  { x:12, o:12, on_light:0, in_the_middle:0 })

let c4
await asUser(A, async () => { c4=(await query("select * from create_game_invite($1,'c4','c4-room')",[B]))[0] })
await asUser(B, () => query("select resolve_game_invite($1,'accepted')",[c4.id]))
await asUser(A, async () => {
  // GRAVITY IS THE SERVER'S. The move is a column; the client cannot name the
  // cell, and a column is not a square — 0 is the BOTTOM of the first column.
  const first=(await query('select * from play_game_move($1,0,0)',[c4.id]))[0]
  assert.equal(first.board[35], 'X')   // row 5, col 0
  assert.equal(first.board[0], '')     // NOT the top-left cell
  assert.equal(first.revision, 1)
  // A retried drop after a timeout is the disc on top of that column, not a
  // second one.
  const retry=(await query('select * from play_game_move($1,0,0)',[c4.id]))[0]
  assert.equal(retry.revision, 1)
  assert.equal(retry.board.filter((c)=>c==='X').length, 1)
  await assert.rejects(query('select play_game_move($1,7,1)',[c4.id]),/Invalid move/)
  await assert.rejects(query('select play_game_move($1,1,1)',[c4.id]),/legal move/) // not my turn
  // Checkers' entry point is refused on a Connect Four room, and vice versa.
  await assert.rejects(query('select play_game_path($1,array[0,1],1)',[c4.id]),/Wrong move/)
})
// Four along the bottom wins, and the win is the server's to notice.
await asUser(B,()=>query('select play_game_move($1,6,1)',[c4.id]))
await asUser(A,()=>query('select play_game_move($1,1,2)',[c4.id]))
await asUser(B,()=>query('select play_game_move($1,6,3)',[c4.id]))
await asUser(A,()=>query('select play_game_move($1,2,4)',[c4.id]))
await asUser(B,()=>query('select play_game_move($1,6,5)',[c4.id]))
await asUser(A, async () => {
  const win=(await query('select * from play_game_move($1,3,6)',[c4.id]))[0]
  assert.equal(win.result,'X')
  assert.equal(win.sender_wins,1)
  await assert.rejects(query('select play_game_move($1,4,7)',[c4.id]),/legal move/)
})
// A full column is refused rather than silently dropped on the floor.
await asUser(A,()=>query('select rematch_game($1)',[c4.id]))
for (const [who,rev] of [[B,7],[A,8],[B,9],[A,10],[B,11],[A,12]]) {
  await asUser(who,()=>query('select play_game_move($1,3,$2)',[c4.id,rev]))
}
await asUser(B, async () => {
  await assert.rejects(query('select play_game_move($1,3,13)',[c4.id]),/legal move/)
  const elsewhere=(await query('select * from play_game_move($1,4,13)',[c4.id]))[0]
  assert.equal(elsewhere.board[39],'O')  // row 5, col 4
})
console.log('PASS connect four: gravity is server-side, a retried drop is one disc, a full column is refused, four in a row is scored')

// --------------------------------------------------------------------------
// Checkers. A multi-jump is ONE turn, so the whole sequence arrives as a path
// and every hop of it is re-walked here. A client that submits its own jump
// chain could otherwise claim any board it liked.
// --------------------------------------------------------------------------
let ck
await asUser(A, async () => { ck=(await query("select * from create_game_invite($1,'checkers','ck-room')",[B]))[0] })
await asUser(B, () => query("select resolve_game_invite($1,'accepted')",[ck.id]))
await asUser(A, async () => {
  await assert.rejects(query('select play_game_move($1,0,0)',[ck.id]),/Wrong move/)
  // 40 = row 5 col 0, one of the four men with anywhere to go on move one.
  const opening=(await query('select * from play_game_path($1,array[40,33],0)',[ck.id]))[0]
  assert.equal(opening.board[40],'')
  assert.equal(opening.board[33],'x')
  assert.equal(opening.revision,1)
  assert.equal(opening.idle_plies,1)  // nothing taken, nobody crowned
  await assert.rejects(query('select play_game_path($1,array[42,35],1)',[ck.id]),/legal move/) // not my turn
})
// A crafted position, installed the way the harness installs an expiry. X at
// (7,0) with a three-jump chain on offer, and one o parked out of the way.
const chain = Array(64).fill('')
chain[56]='x'; chain[58]='x'; chain[49]='o'; chain[35]='o'; chain[19]='o'; chain[33]='o'
await db.query('update game_invites set board=$2, revision=2, round_start_revision=0, idle_plies=7 where id=$1',[ck.id,chain])
await asUser(A, async () => {
  // CAPTURE IS FORCED: the quiet move the second man could otherwise make is
  // refused while a jump exists anywhere for this side.
  await assert.rejects(query('select play_game_path($1,array[58,51],2)',[ck.id]),/capture is available/)
  // A SEQUENCE MUST BE FINISHED. Stopping on the first landing square is not a
  // turn, and this is the assertion a client-side chain would walk straight
  // past: it is the server that knows another jump is still owed.
  await assert.rejects(query('select play_game_path($1,array[56,42],2)',[ck.id]),/Finish the jump/)
  await assert.rejects(query('select play_game_path($1,array[56,42,28],2)',[ck.id]),/Finish the jump/)
  // A hop past the end of the chain, and a hop onto an occupied square.
  await assert.rejects(query('select play_game_path($1,array[56,42,28,10,0],2)',[ck.id]),/capture is available|legal move/)
  await assert.rejects(query('select play_game_path($1,array[56,33],2)',[ck.id]),/legal move/)
  const whole=(await query('select * from play_game_path($1,array[56,42,28,10],2)',[ck.id]))[0]
  assert.equal(whole.board[10],'x')
  assert.equal(whole.board[56],'')
  // Every jumped piece is lifted — three of them, in one revision.
  assert.deepEqual([whole.board[49],whole.board[35],whole.board[19]],['','',''])
  assert.equal(whole.board[33],'o')
  assert.equal(whole.revision,3)
  assert.equal(whole.idle_plies,0)  // a capture resets the no-progress counter
  // A retried path after a timeout is the same turn, not a second one.
  const retry=(await query('select * from play_game_path($1,array[56,42,28,10],2)',[ck.id]))[0]
  assert.equal(retry.revision,3)
})
// CROWNING ENDS THE TURN, even with another jump on the board.
const crown = Array(64).fill('')
crown[21]='x'; crown[12]='o'; crown[10]='o'   // (2,5) x, (1,4) o, (1,2) o
await db.query('update game_invites set board=$2, revision=4, round_start_revision=0 where id=$1',[ck.id,crown])
await asUser(A, async () => {
  await assert.rejects(query('select play_game_path($1,array[21,3,17],4)',[ck.id]),/legal move/)
  const crowned=(await query('select * from play_game_path($1,array[21,3],4)',[ck.id]))[0]
  assert.equal(crowned.board[3],'X')          // kinged on the far row
  assert.equal(crowned.idle_plies,0)          // crowning is progress too
  assert.equal(crowned.result,null)           // o at (1,2) can still move
})
// A side with nothing left to move has lost, and the score is written by the
// statement that decides it.
const last = Array(64).fill('')
last[40]='x'; last[33]='o'
await db.query('update game_invites set board=$2, revision=6, round_start_revision=0 where id=$1',[ck.id,last])
await asUser(A, async () => {
  const sweep=(await query('select * from play_game_path($1,array[40,26],6)',[ck.id]))[0]
  assert.equal(sweep.result,'X')
  assert.equal(sweep.sender_wins,1)
})
// Fifty plies with nothing taken and nobody crowned is a draw. Two kings can
// otherwise shuffle between the same squares for as long as both are willing,
// and only the database sees every ply of both players.
await asUser(A,()=>query('select rematch_game($1)',[ck.id]))
const shuffle = Array(64).fill('')
shuffle[26]='X'; shuffle[37]='O'
await db.query(`update game_invites set board=$2, idle_plies=49, revision=8, round_start_revision=8, round=1 where id=$1`,[ck.id,shuffle])
await asUser(B, async () => {
  const drawn=(await query('select * from play_game_path($1,array[37,44],8)',[ck.id]))[0]
  assert.equal(drawn.idle_plies,50)
  assert.equal(drawn.result,'draw')
  assert.equal(drawn.draws,1)
})
console.log('PASS checkers: forced capture, a whole multi-jump re-walked server-side, half a chain refused, crowning ends the turn, and fifty idle plies is a draw')

await asUser(B,async()=>{
  await query('select end_game_room($1)',[game.id])
  // THIS room is gone — not "no rooms remain". A pair can hold several at once
  // now (a Connect Four room and a checkers room are different rooms with the
  // same two people), which is why roomWith() had to stop taking the first one
  // it found.
  assert.equal((await query('select * from active_game_rooms()')).filter((r)=>r.id===game.id).length,0)
})
await db.query("update game_invites set expires_at=now()-interval '1 second' where id=$1",[game.id])
await db.exec('select purge_expired()')
assert.equal((await query('select * from game_invites where id=$1',[game.id])).length,0)
console.log('PASS game authorization, acceptance retries, legal turns, stale moves, saved board, win, end and expiry cleanup')

// ---------------------------------------------------------------------------
// A pair's game record survives the room (202609150060).
//
// The series score lives on the room row and dies with it — game_invites
// expires, purge_expired takes it, and an expired room even has its board
// reset. So the RESULT is materialised into together_events by the same code
// path that increments the counters, and everything above it is derived. This
// block runs immediately after the room above was ended, expired and purged,
// which is the only moment that can prove the record outlived it.
// ---------------------------------------------------------------------------
assert.equal((await query('select * from game_invites where id=$1',[game.id])).length,0)
const records=await query("select * from together_events where kind='game_result' order by happened_at")
// Three wins for A and one draw: ttt round 0, connect four round 0, checkers
// round 0, then the fifty-ply draw in checkers round 1.
assert.equal(records.length,4)
// The dedupe key is the invitation id and the ROUND — which is what survives
// rematch_game, since the next round is the same room with `round` advanced.
assert.equal(records[0].dedupe,`${game.id}:0`)
assert.deepEqual(records.map(r=>r.subject),['ttt','c4','checkers','checkers'])
// No board. The questions this answers are how many, who, which game and when.
assert.equal(records.every(r=>r.magnitude>0 && r.on_date!==null),true)
assert.deepEqual(records.map(r=>r.actor),[A,A,A,null])
// Games are recorded but deliberately kept OFF the timeline: a pair who play
// most evenings would push every milestone out of its 120-row window, and the
// timeline is a list of firsts and highs.
await asUser(A,async()=>{
 assert.equal((await query('select kind from together_timeline($1)',[B])).some(r=>r.kind==='game_result'),false)
})
// The lifetime record, derived on read. Nothing stores a total: a second
// number for the same fact is one that can drift from the rows under it.
await asUser(A,async()=>{
 const rec=(await query('select * from together_game_record($1)',[B]))[0]
 assert.deepEqual(
   {g:rec.games,m:rec.my_wins,t:rec.their_wins,d:rec.draws,run:rec.run_best,mine:rec.run_mine},
   {g:4,m:3,t:0,d:1,run:3,mine:true})
 // Per game, and only games actually played — a row of zeros is a sentence
 // about a game the two of them have never opened.
 const split=await query('select * from together_game_breakdown($1)',[B])
 assert.deepEqual(split.map(r=>[r.game,r.games,r.my_wins,r.draws]),
   [['checkers',2,1,1],['c4',1,1,0],['ttt',1,1,0]])
})
// The same rows from the other side: the split is relative to the caller, and
// the run is still theirs rather than mine.
await asUser(B,async()=>{
 const rec=(await query('select * from together_game_record($1)',[A]))[0]
 assert.deepEqual({m:rec.my_wins,t:rec.their_wins,mine:rec.run_mine},{m:0,t:3,mine:false})
})
// Not discoverable: a third person gets no rows at all, which is a different
// answer from a row of zeros.
await asUser(C,async()=>assert.equal((await query('select * from together_game_record($1)',[A])).length,0))

// IDEMPOTENCE. A retried final move must not count a round twice — the same
// guarantee the counters have, and for the same reason: reaching the recording
// means `result` was null on entry.
let rematchable
await asUser(A,async()=>{rematchable=(await query("select * from create_game_invite($1,'ttt','record-room')",[B]))[0]})
await asUser(B,()=>query("select resolve_game_invite($1,'accepted')",[rematchable.id]))
await db.query("update game_invites set board=array['X','X','','O','O','','','','']::text[], revision=4, round_start_revision=0 where id=$1",[rematchable.id])
await asUser(A,async()=>{
 const won=(await query('select * from play_game_move($1,2,4)',[rematchable.id]))[0]
 assert.equal(won.result,'X'); assert.equal(won.sender_wins,1)
 // The retry path: same square, revision already advanced by one. It returns
 // the row without re-running the update, so neither the counter nor the record
 // can move a second time.
 const again=(await query('select * from play_game_move($1,2,4)',[rematchable.id]))[0]
 assert.equal(again.sender_wins,1)
 await assert.rejects(query('select play_game_move($1,2,5)',[rematchable.id]),/legal move/)
})
assert.equal((await query("select count(*)::int n from together_events where kind='game_result' and dedupe=$1",[`${rematchable.id}:0`]))[0].n,1)
// ...and the unique index is the second lock on it, so even a hand-run of the
// recorder against the finished room writes nothing new.
await db.query('select public.together_record_game_result(g) from game_invites g where g.id=$1',[rematchable.id])
assert.equal((await query("select count(*)::int n from together_events where kind='game_result' and dedupe=$1",[`${rematchable.id}:0`]))[0].n,1)
// A rematch is the NEXT ROUND in the same room with `round` advanced, so it is
// a different key rather than a collision — which is the whole reason the key
// is (invite, round) and not the invite alone.
await asUser(B,()=>query('select rematch_game($1)',[rematchable.id]))
await db.query("update game_invites set board=array['O','O','','X','X','','','','']::text[], revision=9, round_start_revision=5 where id=$1",[rematchable.id])
await asUser(B,async()=>{
 const hers=(await query('select * from play_game_move($1,2,9)',[rematchable.id]))[0]
 assert.equal(hers.result,'O'); assert.equal(hers.recipient_wins,1)
})
const bothRounds=await query("select dedupe,actor,magnitude from together_events where kind='game_result' and dedupe like $1 order by magnitude",[`${rematchable.id}:%`])
assert.deepEqual(bothRounds.map(r=>[r.dedupe,r.actor,r.magnitude]),
  [[`${rematchable.id}:0`,A,1],[`${rematchable.id}:1`,B,2]])
// The derived split agrees with the counters the same statement wrote.
const counters=(await query('select sender_wins,recipient_wins,draws from game_invites where id=$1',[rematchable.id]))[0]
assert.deepEqual([counters.sender_wins,counters.recipient_wins,counters.draws],[1,1,0])

// A PLAYER CANNOT FORGE A RESULT. together_events grants SELECT only, the
// recorder is granted to nobody, and the counters are on a table the client can
// only read — so there is no route to a record of a game that was not played.
await asUser(A,async()=>{
 await assert.rejects(query("insert into together_events(user_a,user_b,kind,dedupe,on_date) values($1,$2,'game_result','forged',current_date)",[A,B]),/permission denied/)
 await assert.rejects(query('select public.together_record_game_result(g) from game_invites g where g.id=$1',[rematchable.id]),/permission denied/)
 await assert.rejects(query('update game_invites set sender_wins=99 where id=$1',[rematchable.id]),/permission denied/)
})

// COLLECTION IS GATED, NOT DISPLAY. A pair who have not both opted in record
// nothing — if the events accrued regardless and the opt-in merely hid them, an
// opt-out would delete a pile that started refilling on the next move.
await db.exec('begin')
const gatedBefore=(await query("select count(*)::int n from together_events where kind='game_result'"))[0].n
await asUser(A,()=>query('select set_together_optin($1,false)',[B]))
await db.query("update game_invites set board=array['X','X','','O','O','','','','']::text[], revision=10, round_start_revision=10, round=2, result=null where id=$1",[rematchable.id])
await asUser(A,async()=>{
 const won=(await query('select * from play_game_move($1,2,10)',[rematchable.id]))[0]
 // The game still works. It is the record that is refused, never the move.
 assert.equal(won.result,'X'); assert.equal(won.sender_wins,2)
})
assert.equal((await query("select count(*)::int n from together_events where kind='game_result'"))[0].n,0)
// ...and turning it back on does not invent the past. together_seed_events()
// seeds only from evidence still on disk, and the rooms those games were played
// in are gone — a count guessed from what is left is a number two people would
// believe.
await asUser(A,()=>query('select set_together_optin($1,true)',[B]))
assert.equal((await query("select count(*)::int n from together_events where kind='game_result'"))[0].n,0)
assert.equal(gatedBefore > 0,true)
await db.exec('rollback')
assert.equal((await query("select count(*)::int n from together_events where kind='game_result'"))[0].n,gatedBefore)
console.log('PASS a finished round is recorded once by the statement that decides it, survives the room, is derived rather than stored, and is never collected for a pair who have not both opted in')

// ---------------------------------------------------------------------------
// A play invitation leaves a timestamped record in the conversation
// (202609150041). Six things have to be true at once, and the 'call' rollout
// got three of them wrong the first time.
// ---------------------------------------------------------------------------
const streakBefore=(await query('select * from streaks where user_a=$1 and user_b=$2',[A,B]))[0]
let ev
await asUser(A, async () => {
  ev=(await query("select * from create_game_invite($1,'checkers','event-room')",[B]))[0]
})
const eventRows=await query("select * from messages where kind='game' and client_id=$1",[ev.id])
// ONE row, written in the same transaction as the invitation, carrying the
// game in body the way a call log carries "video|missed".
assert.equal(eventRows.length,1)
assert.equal(eventRows[0].body,'checkers|invited')
assert.equal(eventRows[0].sender_id,A)
assert.deepEqual([eventRows[0].user_a,eventRows[0].user_b],[A,B].sort())
assert.equal(eventRows[0].view_seconds,null)

// EXACTLY one, and not by convention: client_id is the invitation's own id and
// messages_sender_client_unique(sender_id, client_id) refuses a second row for
// it however it is attempted. A repeat broadcast and the six-second poll never
// reach create_game_invite at all, so this is the only path that could.
await assert.rejects(
  db.query(`insert into public.messages(user_a,user_b,sender_id,kind,body,client_id) values($1,$2,$1,'game','checkers|invited',$3)`,[A,B,ev.id]),
  /unique|duplicate/i)

// A rematch is the next ROUND in the same room, not a new invitation, so it
// adds no second line.
await asUser(B,()=>query("select resolve_game_invite($1,'accepted')",[ev.id]))
await db.query("update game_invites set result='draw' where id=$1",[ev.id])
const eventsBeforeRematch=(await query("select count(*)::int n from messages where kind='game'"))[0].n
await asUser(A,()=>query('select rematch_game($1)',[ev.id]))
assert.equal((await query("select count(*)::int n from messages where kind='game'"))[0].n,eventsBeforeRematch)

// A shared streak must not be advanceable by one person tapping Invite. The
// same exclusion call logs have.
const streakAfter=(await query('select * from streaks where user_a=$1 and user_b=$2',[A,B]))[0]
assert.deepEqual(
  {c:streakAfter?.count,a:streakAfter?.last_snap_a,b:streakAfter?.last_snap_b,i:streakAfter?.last_increment},
  {c:streakBefore?.count,a:streakBefore?.last_snap_a,b:streakBefore?.last_snap_b,i:streakBefore?.last_increment})

// The 3-visit clear cannot touch it. mark_messages_seen / leave_seen_messages
// are allow-lists, so a 'game' id handed to either is simply ignored — no
// opened_at (which is what the unread badge keys off), no view_leaves, and it
// can never reach cleared_by. This is the bug core_fixes.sql had to fix for a
// caller's own call log.
const eventId=eventRows[0].id
await asUser(B, async () => {
  const visit='10000000-0000-4000-8000-000000000041'
  await query('select mark_messages_seen($1,$2,$3)',[A,[eventId],visit])
  for (let i=0;i<4;i++) await query('select leave_seen_messages($1,$2,$3)',[A,[eventId],visit])
})
const afterVisits=(await query('select opened_at,view_leaves,cleared_by from messages where id=$1',[eventId]))[0]
assert.equal(afterVisits.opened_at,null)
assert.deepEqual(afterVisits.view_leaves,{})
assert.deepEqual(afterVisits.cleared_by,[])

// It persists. "She asked me to play at 9:40" has to still be answerable next
// week, so message_visible ignores cleared_by for it and purge_expired exempts
// it — the two must agree, or a row stays visible right up to the moment it is
// deleted out from under the thread.
await db.query("update messages set cleared_by=array[$2::uuid], created_at=now()-interval '90 days' where id=$1",[eventId,B])
assert.equal((await query('select public.message_visible(m,$2) v from messages m where m.id=$1',[eventId,B]))[0].v,true)
await db.exec('select public.purge_expired()')
assert.equal((await query("select count(*)::int n from messages where id=$1",[eventId]))[0].n,1)

// A game event has no duration and must never be handed one — the constraint
// says so rather than leaving 'game' riding call's blanket exemption.
await assert.rejects(
  db.query(`insert into public.messages(user_a,user_b,sender_id,kind,body,view_seconds) values($1,$2,$1,'game','ttt|invited',30)`,[A,B]),
  /view_seconds_sane/)

// THE GRANT. `kind` is in the column INSERT grant, so widening the CHECK would
// otherwise have let any signed-in user PATCH a convincing "invited you to
// play" line into a friend's thread with no game behind it. The RPC is a door;
// the grant is the wall. RLS refuses the client; the definer function does not
// go through RLS, which is why the one legitimate writer still works.
await asUser(A, async () => {
  await assert.rejects(
    query(`insert into messages(user_a,user_b,sender_id,kind,body) values($1,$2,$1,'game','ttt|invited')`,[A,B]),
    /row-level security/)
})
console.log('PASS one invitation is one thread event: no streak, no clear, no unread stamp, no forgery')

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
// markScreenshot is an RPC now, not a column write (202609150050). The three
// raw column writes this used to exercise are asserted REFUSED below.
await clientWrite('markScreenshot via mark_screenshot()',[{as:B},
 {sql:`select public.mark_screenshot(id) from messages where user_a=$1 and user_b=$2 and sender_id=$1 limit 1`,args:[A,B]}])
// createInvite (games.js / db.js) reaches the database through an RPC, but the
// event it writes is a real INSERT into a column-granted table — executed here
// rather than reasoned about, because reading a policy cannot catch a missing
// grant.
await clientWrite('createGameInvite writes its thread event',[{as:A},
 {sql:`select create_game_invite($1,'ttt','client-write-room')`,args:[B]},
 // The RPC is SECURITY DEFINER, so its insert does not go through the
 // messages_insert policy that now refuses kind='game' from a client. If it
 // ever stopped being definer, invitations would still be created and the
 // record would silently stop being written — which is the whole failure mode
 // this feature exists to end. Raise rather than pass quietly.
 {sql:`do $$ begin if not exists (select 1 from public.messages where kind='game' and body='ttt|invited') then raise exception 'invitation wrote no thread event'; end if; end $$;`}])
// sendSnap / sendSnapMedia now put the sender's answer on the row at INSERT.
// A missing column grant fails 42501 before RLS is consulted, and reading the
// policy cannot catch that — only running the write can.
await clientWrite('sendSnap carrying the save permission',[
 {sql:`insert into storage.objects(bucket_id,name) values('media',$1)`,args:[`${A}/snaps/grant.jpg`]},{as:A},
 {sql:`insert into messages(user_a,user_b,sender_id,kind,media_path,media_type,view_seconds,allow_save,client_id) values($1,$2,$1,'snap',$3,'image',10,true,gen_random_uuid())`,args:[A,B,`${A}/snaps/grant.jpg`],rows:1}])
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
// The endpoint host is constrained now (a user-writable URL that the push
// function fetches is an SSRF), so the fixture has to be a real push service.
await clientWrite('saveSubscription / disablePush',[{as:A},
 {sql:`insert into push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) values($1,'https://fcm.googleapis.com/fcm/send/abc123','p','a','ua') on conflict (endpoint) do update set user_id=excluded.user_id,endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent`,args:[A],rows:1},
 {sql:`delete from push_subscriptions where endpoint='https://fcm.googleapis.com/fcm/send/abc123'`,args:[],rows:1}])
// Scheduling writes through an RPC (the table has no INSERT grant on purpose),
// but CANCELLING is a plain client DELETE and therefore needs its own case: the
// policy can be right and the grant still missing, and only running the write
// can tell them apart.
await clientWrite('scheduleMessage / cancelScheduled',[{as:A},
 {sql:`select public.schedule_message($1,'later',(public.ist_date()+1)::date,'09:00')`,args:[B]},
 {sql:`delete from scheduled_messages where sender_id=$1`,args:[A],rows:1}])
// Telemetry is a client write like any other: a missing EXECUTE grant fails at
// call time, before the function's own exception handler can swallow anything,
// and would leave the sink silently dead on a legitimate phone.
await clientWrite('record_ops_events',[{as:A},
 {sql:`select public.record_ops_events($1::jsonb)`,args:[JSON.stringify([{kind:'upload_fail',code:'snaps_http_500',device:'android-chrome',retries:1,n:1}])]}])

// --- Audit follow-up: the edges the boundary did not cover ----------------
await asUser(A,async()=>{
 // H1: the push endpoint is a URL this project's Edge Function will FETCH, and
 // the column is user-writable with the anon key in the bundle.
 await assert.rejects(query("insert into push_subscriptions(user_id,endpoint,p256dh,auth) values($1,'http://169.254.169.254/latest/meta-data','p','a')",[A]),/push_endpoint_host/)
 await assert.rejects(query("insert into push_subscriptions(user_id,endpoint,p256dh,auth) values($1,'https://evil.example/hook','p','a')",[A]),/push_endpoint_host/)
 // M3: the display name lands on a lock screen under Meera's own name.
 await assert.rejects(query('update profiles set display_name=$2 where id=$1',[A,'x'.repeat(41)]),/display_name_len/)
 // M2: block_user() also deletes the friendship, and that half is what stops
 // calls and push. Writing the row directly skipped it.
 await assert.rejects(query('insert into blocks(blocker,blocked) values($1,$2)',[A,C]),/permission denied/)
})
// A forged story expiry is a permanent story and a permanently uncollectable
// object. The baseline scoped this grant to four columns; a later migration
// re-issued a table-wide INSERT that silently subsumed them.
await asUser(A,async()=>{
 await assert.rejects(query(
   "insert into stories(user_id,media_path,media_type,expires_at) values($1,$2,'image',now()+interval '100 years')",
   [A,`${A}/stories/forged.jpg`]),/permission denied/)
 // And the pin-the-conversation attack: saving is toggle_saved's job alone.
 await assert.rejects(query('update messages set saved_by=array[$1::uuid] where user_a=$1',[A]),/permission denied/)
})
console.log('PASS a story expiry cannot be forged, and saved_by is not client-writable')

// --- Snap save consent ----------------------------------------------------
// The gate this replaces granted itself: SnapViewer allowed the export when
// `saved_by` contained the VIEWER, and `toggle_saved()` may be called by either
// party. Everything below is the part a client cannot be trusted with — that
// the flag means what the SENDER said, and that no other route reaches it.
const snapPath = `${A}/snaps/consent.jpg`
await db.query(`insert into storage.objects(bucket_id,name) values('media',$1)`,[snapPath])
await db.query(`insert into public.messages(user_a,user_b,sender_id,kind,media_path,media_type,view_seconds) values($1,$2,$1,'snap',$3,'image',10)`,[A,B,snapPath])
const consentSnap=(await query("select id from public.messages where media_path=$1",[snapPath]))[0].id
// Default false: applying this migration must not make anything already sent
// exportable.
assert.equal((await query('select allow_save from public.messages where id=$1',[consentSnap]))[0].allow_save,false)

await asUser(B,async()=>{
 // The recipient. Three routes at the flag, and all three are walls.
 // 1. Straight at the column through PostgREST — the mistake 202609090022 made
 //    with saved_by, where hardening the RPC closed only the client path.
 await assert.rejects(query('update public.messages set allow_save=true where id=$1',[consentSnap]),/permission denied/)
 // 2. The RPC itself, which is sender-only.
 await assert.rejects(query('select public.set_snap_save_consent($1,true)',[consentSnap]),/Message unavailable/)
 // 3. The audit log, which is operator-only (RLS on, no policy, grants revoked)
 //    like ops_metrics and bot_quotes.
 await assert.rejects(query('select * from public.save_consent_log'),/permission denied/)
})
await asUser(A,async()=>{
 // The sender, who is the only one who may answer.
 assert.equal((await query('select public.set_snap_save_consent($1,true) ok',[consentSnap]))[0].ok,true)
 // Not a snap is not a save permission.
 const chatId=(await query("select id from public.messages where kind='chat' limit 1"))[0].id
 await assert.rejects(query('select public.set_snap_save_consent($1,true)',[chatId]),/Only a snap/)
})
assert.equal((await query('select allow_save from public.messages where id=$1',[consentSnap]))[0].allow_save,true)
// The log records the transition, the actor and the timestamp — and NOTHING
// about the content. A log carrying a body or a media_path would undo the
// ephemerality it exists to police.
const logCols=(await query("select column_name from information_schema.columns where table_schema='public' and table_name='save_consent_log'")).map(r=>r.column_name)
assert.deepEqual(logCols.filter(c=>['body','media_path','thumb_path','caption','url'].includes(c)),[])
assert.deepEqual((await query('select was_allowed,now_allowed,actor_id from public.save_consent_log where message_id=$1',[consentSnap])),
 [{was_allowed:false,now_allowed:true,actor_id:A}])
// Re-tapping the same answer is not an event. Logging it would bury the ones
// that are.
await asUser(A,async()=>{ await query('select public.set_snap_save_consent($1,true)',[consentSnap]) })
assert.equal((await query('select count(*)::int n from public.save_consent_log where message_id=$1',[consentSnap]))[0].n,1)
await asUser(A,async()=>{ await query('select public.set_snap_save_consent($1,false)',[consentSnap]) })
assert.equal((await query('select count(*)::int n from public.save_consent_log where message_id=$1',[consentSnap]))[0].n,2)
// The log dies with the message it describes. Keeping it would leave a
// permanent record that a snap existed, in an app whose promise is that it
// does not.
await db.query('delete from public.messages where id=$1',[consentSnap])
assert.equal((await query('select count(*)::int n from public.save_consent_log where message_id=$1',[consentSnap]))[0].n,0)

// The per-contact default. Each side owns ONE half; a shared per-pair flag
// would be the same self-granted consent one level up.
await asUser(A,async()=>{
 await query('select public.set_snap_save_default($1,true)',[B])
 await assert.rejects(query('select public.set_snap_save_default($1,true)',[C]),/Friend unavailable/) // not friends
})
await asUser(B,async()=>{
 // B cannot write A's half, by any route: no UPDATE grant on the table, and the
 // RPC derives the column from auth.uid() rather than taking it as an argument.
 await assert.rejects(query('update public.snap_save_prefs set a_allows=false'),/permission denied/)
 await assert.rejects(query('insert into public.snap_save_prefs(user_a,user_b,a_allows) values($1,$2,true)',[A,B]),/permission denied/)
 // Reading is shared — both people are entitled to know what the pair agreed.
 assert.equal((await query('select a_allows,b_allows from public.snap_save_prefs'))[0].a_allows,true)
 await query('select public.set_snap_save_default($1,true)',[A])
})
const prefs=(await query('select * from public.snap_save_prefs where user_a=$1 and user_b=$2',[A,B]))[0]
assert.equal(prefs.a_allows,true); assert.equal(prefs.b_allows,true)
// One side switching off does not switch the other side off with it.
await asUser(A,async()=>{ await query('select public.set_snap_save_default($1,false)',[B]) })
const prefsAfter=(await query('select * from public.snap_save_prefs where user_a=$1 and user_b=$2',[A,B]))[0]
assert.equal(prefsAfter.a_allows,false); assert.equal(prefsAfter.b_allows,true)
await asUser(C,async()=>{
 // A stranger sees no row at all, so the pair's arrangement is not an oracle.
 assert.equal((await query('select count(*)::int n from public.snap_save_prefs'))[0].n,0)
})
// A standing permission does not outlive the friendship. Unfriending (and
// blocking, which deletes the same row) drops it, so adding each other again
// does not silently restore a permission granted to a different relationship.
await db.query('delete from public.friendships where user_a=$1 and user_b=$2',[A,B])
assert.equal((await query('select count(*)::int n from public.snap_save_prefs where user_a=$1 and user_b=$2',[A,B]))[0].n,0)
await db.query(`insert into public.friendships(user_a,user_b,requested_by,status) values($1,$2,$1,'accepted')`,[A,B])
console.log('PASS snap save consent is the sender\'s alone, by every route, and the log keeps no content')
console.log('PASS push endpoints, display names and blocks cannot be written around')
console.log('PASS every client write succeeds for a legitimate user')

// H1 (202609150050). `opened_at` was directly writable by either party, and
// guard_message_update only blocked CHANGING a non-null value — so null -> a
// PAST timestamp was allowed. message_visible then hides the row from BOTH
// phones and purge_expired hard-deletes it within 15 minutes. One PATCH
// destroyed a conversation for two people, forging read receipts on the way.
//
// Reading the policy could never have caught this: the policy was fine. Only
// performing the write finds it, which is why these are executed as a real
// authenticated user rather than asserted about.
// Autocommit, not a transaction: a refused statement aborts an open one, and
// asUser's `reset role` then fails on the poisoned transaction rather than on
// the thing under test.
const [h1Msg] = await asUser(A,()=>query(
  `insert into messages(user_a,user_b,sender_id,kind,body,client_id)
   values($1,$2,$1,'chat','h1 probe',gen_random_uuid()) returning id`,[A,B]))
for (const col of ['opened_at','replayed_at','cleared_at','screenshot_at']) {
  await asUser(B,()=>assert.rejects(
    query(`update messages set ${col}=now() - interval '2 days' where id=$1`,[h1Msg.id]),
    /permission denied/,
    `${col} is still directly writable — H1 is open`))
}
// mark_screenshot keeps the one legitimate door, with the rule a grant cannot
// express: the RECIPIENT only, and once — screenshot_at is a claim rendered to
// the other person, so it must not be movable after the fact.
await asUser(A,()=>query('select public.mark_screenshot($1)',[h1Msg.id]))
assert.equal((await query('select screenshot_at from messages where id=$1',[h1Msg.id]))[0].screenshot_at,null,
  'the SENDER was able to mark their own message screenshotted')
await asUser(B,()=>query('select public.mark_screenshot($1)',[h1Msg.id]))
const h1First=(await query('select screenshot_at from messages where id=$1',[h1Msg.id]))[0].screenshot_at
assert.ok(h1First,'the recipient could not mark a screenshot through the RPC')
await asUser(B,()=>query('select public.mark_screenshot($1)',[h1Msg.id]))
assert.deepEqual((await query('select screenshot_at from messages where id=$1',[h1Msg.id]))[0].screenshot_at,h1First,
  'screenshot_at was re-writable — the claim shown to the other person can be moved')
// M1: 202609090022 named react_to_message as a hole in its own comment and then
// hardened only toggle_saved. block_user() deletes the friendship, but this RPC
// never looked at one.
await asUser(B,()=>query('select public.block_user($1)',[A]))
await asUser(A,()=>query(`select public.react_to_message($1,'x')`,[h1Msg.id]))
assert.deepEqual((await query('select reactions from messages where id=$1',[h1Msg.id]))[0].reactions,{},
  'a blocked user could still react into the victim\'s thread')
// Undo it fully. block_user() also DELETES the friendship — deliberately, since
// stories, presence, calls and the push relay all gate on one — so unblocking
// alone leaves A with no friends and silently zeroes the egress projection
// several tests below. Restoring the row is part of the cleanup, not a detail.
await query('delete from public.blocks where blocker=$1 and blocked=$2',[B,A])
await query(`insert into public.friendships(user_a,user_b,requested_by,status)
             values($1,$2,$1,'accepted') on conflict (user_a,user_b)
             do update set status='accepted'`,[A,B])
await query('delete from messages where id=$1',[h1Msg.id])
console.log('PASS opened_at cannot be backdated to destroy a conversation, and a block stops reactions')

// Egress accounting. The projection is the only part worth testing — the raw
// totals are a sum, but the story multiplier is the thing that was making the
// bill inexplicable, and getting it wrong in either direction is silent.
await db.query("update storage.objects set metadata=jsonb_build_object('size',1000)")
const storyObject=`${A}/stories/egress.jpg`
await db.query("insert into storage.objects(bucket_id,name,metadata) values('media',$1,jsonb_build_object('size',500000))",[storyObject])
await asUser(A,()=>query("insert into stories(user_id,media_path,media_type) values($1,$2,'image')",[A,storyObject]))
const metrics=(await query('select * from record_ops_metrics()'))[0]
assert.equal(Number(metrics.story_bytes),500000)
// A is friends with B only, so one story of 500 kB is 500 kB out — not the
// 500 kB that a naive "bytes stored today" reading would report if the author
// had ten friends.
assert.equal(Number(metrics.projected_daily_egress)-Number(metrics.snap_bytes),500000)
await db.query(`insert into public.friendships(user_a,user_b,requested_by,status) values($1,$2,$1,'accepted')`,[A,C])
const wider=(await query('select * from record_ops_metrics()'))[0]
assert.equal(Number(wider.projected_daily_egress)-Number(wider.snap_bytes),1000000)
// Same day twice must overwrite, not accumulate: the cron retries, and a
// backfill is expected to be safe to repeat.
assert.equal((await query('select count(*)::int n from ops_metrics'))[0].n,1)
await asUser(B,()=>assert.rejects(query('select * from ops_metrics'),/permission denied/))
console.log('PASS egress projection counts a story once per friend, and is idempotent per day')
// The intimate games (202609090026). Long enough to live in its own file; it
// runs here, in this database, as these same three users.
await checkIntimateGames({ db, query, asUser, A, B, C })
// --- Scheduled messages ---------------------------------------------------
// chat_backup.sql lives OUTSIDE supabase/migrations/, so the enumerating
// harness has never once run it. It has to run here, because the one thing
// that cannot be checked by reading is whether the delivery path actually
// removes the backup copy the trigger makes — and a trigger that silently did
// nothing would make the exemption look like it worked.
await db.exec(fs.readFileSync('supabase/chat_backup.sql','utf8'))
const istDay=async(offset)=>(await query('select (public.ist_date() + $1::int)::text d',[offset]))[0].d
const tomorrow=await istDay(1)

// The happy path, as the client calls it: a wall clock, never an instant.
let scheduled
await asUser(A,async()=>{
 scheduled=(await query("select * from schedule_message($1,'good morning',$2,'09:00')",[B,tomorrow]))[0]
 assert.ok(scheduled.id)
 assert.equal(scheduled.sender_id,A)
 assert.equal(scheduled.user_a < scheduled.user_b,true)   // pair-ordered like every pair table
 // Resolved in IST server-side, not from the caller's clock.
 const at=(await query("select to_char($1::timestamptz at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') s",[scheduled.send_at]))[0].s
 assert.equal(at,`${tomorrow} 09:00`)
})
// SENDER-ONLY, and this is the assertion that says so: the recipient cannot
// see a surprise before it fires. Every other pair table here is pair-readable.
await asUser(B,async()=>{
 assert.equal((await query('select count(*)::int n from scheduled_messages'))[0].n,0)
 // Nor can they cancel it.
 const res=await db.query('delete from public.scheduled_messages where id=$1',[scheduled.id])
 assert.equal(res.affectedRows,0)
})
// The grant is the wall, the RPC is the door. A PATCH straight to PostgREST
// must not be able to forge a row at all — that is the 202609090032 lesson,
// where a hardened RPC left its column grant open and only closed the client.
await asUser(A,async()=>{
 await assert.rejects(query(
   "insert into scheduled_messages(user_a,user_b,sender_id,recipient_id,body,send_at) values($1,$2,$1,$2,'forged',now()+interval '1 hour')",
   [A,B]),/permission denied/)
 await assert.rejects(query('update scheduled_messages set send_at=now() where id=$1',[scheduled.id]),/permission denied/)
 // And the RPC refuses both edges of the horizon.
 await assert.rejects(query("select schedule_message($1,'too far',$2,'09:00')",[B,await istDay(8)]),/7 days/)
 await assert.rejects(query("select schedule_message($1,'too late',$2,'09:00')",[B,await istDay(-1)]),/already passed/)
 await assert.rejects(query("select schedule_message($1,'   ',$2,'09:00')",[B,tomorrow]),/write something/)
 await assert.rejects(query("select schedule_message($1,$2,$3,'09:00')",[B,'x'.repeat(2001),tomorrow]),/too long/)
})
// A stranger is not a friend — B and C have no friendship row at all.
await asUser(B,()=>assert.rejects(
 query("select schedule_message($1,'hello',$2,'09:00')",[C,tomorrow]),/only schedule a message to a friend/))
// The CHECK bites even for a writer that is past the grants entirely — the
// horizon is in the schema, not only in the picker and the RPC.
await assert.rejects(db.query(
 "insert into public.scheduled_messages(user_a,user_b,sender_id,recipient_id,body,send_at) values($1,$2,$1,$2,'forged',now()+interval '8 days')",
 [A,B]),/scheduled_horizon/)
await assert.rejects(db.query(
 "insert into public.scheduled_messages(user_a,user_b,sender_id,recipient_id,body,send_at) values($1,$2,$1,$2,'forged',now()-interval '1 minute')",
 [A,B]),/scheduled_horizon/)
// The pair columns and the named columns cannot disagree.
await assert.rejects(db.query(
 "insert into public.scheduled_messages(user_a,user_b,sender_id,recipient_id,body,send_at) values($1,$2,$1,$3,'mismatched',now()+interval '1 hour')",
 [A,B,C]),/scheduled_pair_matches/)
// Firing the queue early is exactly the surprise this protects.
await asUser(A,()=>assert.rejects(query('select deliver_scheduled_messages()'),/permission denied/))

// The cap. Filled past the grants so the test is about the counter, not the door.
await db.query(
 "insert into public.scheduled_messages(user_a,user_b,sender_id,recipient_id,body,send_at) select $1,$2,$1,$2,'filler '||n,now()+interval '1 hour' from generate_series(1,19) n",
 [A,B])
await asUser(A,()=>assert.rejects(query("select schedule_message($1,'one too many',$2,'09:00')",[B,tomorrow]),/cancel one first/))
await db.query("delete from public.scheduled_messages where body like 'filler %'")

// Delivery. The pending row is gone in the SAME transaction that inserts the
// message, so a retried cron sends nothing twice.
// created_at moves with it: the horizon CHECK is re-evaluated on UPDATE too, so
// even the table owner cannot backdate a row to fire early without rewriting
// the day it was written. Nothing in production ever updates these rows.
await db.query("update public.scheduled_messages set created_at=now()-interval '2 hours', send_at=now()-interval '1 minute' where id=$1",[scheduled.id])
assert.equal((await query('select public.deliver_scheduled_messages() n'))[0].n,1)
const delivered=(await query('select * from public.messages where client_id=$1',[scheduled.id]))[0]
assert.equal(delivered.kind,'chat')
assert.equal(delivered.body,'good morning')
assert.equal(delivered.sender_id,A)
assert.ok(delivered.delivered_at)
assert.equal((await query('select count(*)::int n from public.scheduled_messages where id=$1',[scheduled.id]))[0].n,0)
// No tombstone, and no second copy on a re-run.
assert.equal((await query('select public.deliver_scheduled_messages() n'))[0].n,0)
assert.equal((await query('select count(*)::int n from public.messages where client_id=$1',[scheduled.id]))[0].n,1)
// THE BACKUP EXEMPTION. An ordinary send is copied into private.message_backup
// and kept three days; a scheduled one has already spent up to a week in
// plaintext and must not buy three more. Both halves are asserted, because an
// exemption that "works" because the trigger is broken is not an exemption.
let ordinary
await asUser(A,async()=>{
 ordinary=(await query("insert into messages(user_a,user_b,sender_id,kind,body,client_id) values($1,$2,$1,'chat','an ordinary message',gen_random_uuid()) returning id",[A,B]))[0]
})
assert.equal((await query('select count(*)::int n from private.message_backup where message_id=$1',[ordinary.id]))[0].n,1)
assert.equal((await query('select count(*)::int n from private.message_backup where message_id=$1',[delivered.id]))[0].n,0)

// Constraint 6, both doors. An unfriend (removeFriend does a direct DELETE)...
await asUser(A,()=>query("select schedule_message($1,'see you tomorrow',$2,'09:00')",[C,tomorrow]))
assert.equal((await query('select count(*)::int n from public.scheduled_messages'))[0].n,1)
await db.query('delete from public.friendships where user_a=$1 and user_b=$2',[A,C])
assert.equal((await query('select count(*)::int n from public.scheduled_messages'))[0].n,0)
// ...and a block, on its own, with the friendship left in place — because the
// bug found twice this session was a cleanup that only ran inside block_user().
await db.query("insert into public.friendships(user_a,user_b,requested_by,status) values($1,$2,$1,'accepted')",[A,C])
await asUser(A,()=>query("select schedule_message($1,'see you tomorrow',$2,'09:00')",[C,tomorrow]))
await db.query('insert into public.blocks(blocker,blocked) values($1,$2)',[C,A])
assert.equal((await query('select count(*)::int n from public.scheduled_messages'))[0].n,0)
// And a blocked sender cannot start a new one, friendship row or not.
await asUser(A,()=>assert.rejects(
 query("select schedule_message($1,'let me back in',$2,'09:00')",[C,tomorrow]),
 /only schedule a message to a friend/))
await db.query('delete from public.blocks where blocker=$1 and blocked=$2',[C,A])

// The delivery backstop: a row that got past both triggers is DELETED, never
// delivered. deliver_scheduled_messages is the owner and so runs past
// messages_insert, which is what would otherwise have refused it.
await db.query('delete from public.friendships where user_a=$1 and user_b=$2',[A,C])
await db.query(
 "insert into public.scheduled_messages(user_a,user_b,sender_id,recipient_id,body,send_at,created_at) values($1,$2,$1,$2,'should never arrive',now()-interval '1 minute',now()-interval '2 hours')",
 [A,C])
assert.equal((await query('select public.deliver_scheduled_messages() n'))[0].n,0)
assert.equal((await query('select count(*)::int n from public.scheduled_messages'))[0].n,0)
assert.equal((await query("select count(*)::int n from public.messages where body='should never arrive'"))[0].n,0)
console.log('PASS a scheduled message is sender-only, bounded to 7 days, exempt from the backup, and dies with the friendship')

// --- Scheduled deletion (202609140037) -----------------------------------
// A grace period is only a grace period if the client cannot choose its own
// purge_after: a timestamp in the past is an instant delete with no
// confirmation step, and one a century out is a row that never fires. So the
// table takes no writes at all and the RPCs are the only way in.
await asUser(A,async()=>{
 const idle=(await query('select * from account_deletion_state()'))[0]
 assert.equal(idle.pending,false)
 assert.equal(idle.purge_after,null)
 assert.equal(idle.grace_days,7)
 await assert.rejects(query('insert into deletion_requests(user_id,purge_after) values($1,now())',[A]),/permission denied/)
 await assert.rejects(query('update deletion_requests set purge_after=now()'),/permission denied/)
 await assert.rejects(query('delete from deletion_requests'),/permission denied/)
 // And neither half of the purge is reachable from a signed-in caller —
 // purge_account(uuid) with somebody else's id would be a deletion oracle for
 // the whole project.
 assert.equal((await query("select has_function_privilege('authenticated','public.purge_account(uuid)','execute') ok"))[0].ok,false)
 assert.equal((await query("select has_function_privilege('authenticated','public.purge_due_accounts()','execute') ok"))[0].ok,false)
})
await db.exec('begin')
await asUser(A,async()=>{
 const asked=(await query('select * from request_account_deletion()'))[0]
 assert.equal(asked.pending,true)
 assert.ok(new Date(asked.purge_after)-new Date(asked.requested_at)>=6.9*86400000)
 // A second tap must return the clock that is already running. Extending it
 // silently would move a deadline somebody is relying on, and a do-update
 // would let a repeat SHORTEN one.
 const again=(await query('select * from request_account_deletion()'))[0]
 assert.equal(new Date(again.purge_after).getTime(),new Date(asked.purge_after).getTime())
 assert.equal((await query('select count(*)::int n from deletion_requests'))[0].n,1)
})
// Own row only. A pending deletion is nobody else's business — least of all
// the friend whose conversation it would take with it.
await asUser(B,async()=>{
 assert.equal((await query('select count(*)::int n from deletion_requests'))[0].n,0)
 assert.equal((await query('select pending from account_deletion_state()'))[0].pending,false)
})
await asUser(A,async()=>{
 assert.equal((await query('select pending from cancel_account_deletion()'))[0].pending,false)
})
assert.equal((await query('select count(*)::int n from deletion_requests'))[0].n,0)
await db.exec('rollback')
// The job half. Without it the row sits there forever while the screen shows a
// date in the past, so it is worth proving it actually takes the account.
await db.exec('begin')
await db.query("insert into public.deletion_requests(user_id,requested_at,purge_after) values($1,now()-interval '2 days',now()-interval '1 day')",[C])
await db.query("insert into public.deletion_requests(user_id,requested_at,purge_after) values($1,now(),now()+interval '7 days')",[B])
assert.equal((await query('select purge_due_accounts() n'))[0].n,1)
assert.equal((await query('select count(*)::int n from auth.users where id=$1',[C]))[0].n,0)
assert.equal((await query('select count(*)::int n from public.profiles where id=$1',[C]))[0].n,0)
// The one that is not due yet is untouched, and a purged account leaves no
// request behind for the next pass to trip over.
assert.equal((await query('select count(*)::int n from public.deletion_requests'))[0].n,1)
assert.equal((await query('select count(*)::int n from auth.users where id=$1',[B]))[0].n,1)
await db.exec('rollback')
console.log('PASS a deletion is scheduled, cannot be hand-dated, and the due sweep takes exactly the due account')
// The export's scope is a claim about other people's privacy, so the two rows
// that are unambiguously the caller's own writing had to stop being missing —
// without any of the other person's half arriving with them.
await db.query("insert into public.scrapbook_items(user_a,user_b,author,kind,body,on_date) values($1,$2,$1,'note','mine',current_date),($1,$2,$2,'note','theirs',current_date)",[A,B])
await asUser(A,async()=>{
 const dump=(await query('select export_my_data() d'))[0].d
 assert.ok(dump.scrapbook_items.length>0)
 assert.ok(dump.scrapbook_items.every((x)=>x.author===A))
 assert.ok(dump.scrapbook_items.some((x)=>x.body==='mine'))
 assert.ok(!dump.scrapbook_items.some((x)=>x.body==='theirs'))
 assert.ok(Array.isArray(dump.together_optin))
 // The deliberate exclusions, still excluded, and still stated in the file.
 assert.equal(dump.pair_questions,undefined)
 assert.ok(dump.messages_sent.every((m)=>m.sender_id===A))
 assert.ok(dump.notes.some((n)=>/Questions of the day are not included/.test(n)))
 assert.ok(dump.notes.some((n)=>/Messages other people sent you are not included/.test(n)))
})
console.log('PASS the export gains your own scrapbook entries and still holds nobody elses words')

// Operational telemetry. The thing worth testing is not that a count goes up —
// it is that the privacy filter is real. Every guarantee this feature makes is
// a server-side check, because the anon key is in the bundle and a client-side
// filter is a suggestion.
const evJson=(o)=>JSON.stringify([o])
await asUser(A,async()=>{
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[JSON.stringify([
   {kind:'upload_fail',code:'snaps_http_500',device:'android-chrome',n:1},
   {kind:'realtime_join',code:'join_signal',device:'android-chrome',n:20},
 ])]))[0].n,2)
 // A free-text code is how a message body ends up in a metrics table. Rejected
 // outright rather than truncated into something plausible.
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[evJson({kind:'upload_fail',code:'meet me at 8 tonight',device:'desktop'})]))[0].n,0)
 // Vocabulary, not free text — for kind and device class as well as code. A
 // user agent in the device column would make every row a fingerprint.
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[evJson({kind:'keystrokes',code:'ok',device:'desktop'})]))[0].n,0)
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[evJson({kind:'upload_fail',code:'snaps_other',device:'Mozilla/5.0 (Linux; Android 14)'})]))[0].n,0)
 // Nothing malformed may take the whole batch down with it, or one bad client
 // stops reporting the failures it is in the middle of having.
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[JSON.stringify([
   {kind:'upload_fail',code:'not a code',device:'desktop'},
   {kind:'upload_fail',code:'stories_other',device:'desktop'},
 ])]))[0].n,1)
 // An uncapped sampling denominator lets one event claim a million and move
 // every threshold on its own.
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[evJson({kind:'upload_fail',code:'voice_other',device:'desktop',n:9999999})]))[0].n,1)
 // A client can never read a row back, which also stops this table being a
 // side channel between two users.
 await assert.rejects(query('select * from public.ops_events'),/permission denied/)
 await assert.rejects(query("insert into public.ops_events(on_hour,source,kind,code,device) values(now(),'push','cleanup_run','ok','server')"),/permission denied/)
 for (const fn of ["public.record_ops_server_events('push','[]'::jsonb)","public.purge_ops_events()","public.ops_event_alerts()"]) {
  assert.equal((await query(`select has_function_privilege('authenticated','${fn.replace(/\(.*/,'')}(${fn.includes('server_events')?'text,jsonb':''})','execute') ok`))[0].ok,false)
 }
})
// The server sources are not a parameter a client can reach, so there is
// nothing to forge: everything a signed-in caller writes is 'client'.
assert.equal((await query("select count(*)::int n from public.ops_events where source<>'client'"))[0].n,0)
assert.equal(Number((await query("select estimated from public.ops_events where kind='realtime_join'"))[0].estimated),20)
assert.equal((await query("select count(distinct on_hour)::int n from public.ops_events"))[0].n,1)
assert.equal(Number((await query("select max(estimated) e from public.ops_events where code='voice_other'"))[0].e),1000)
// The budget is the only thing standing between an open write path and a table
// one account can fill faster than the purge empties it.
await asUser(C,async()=>{
 const flood=Array.from({length:130},(_,i)=>({kind:'upload_fail',code:`snaps_http_${400+(i%99)}`,device:'desktop'}))
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[JSON.stringify(flood)]))[0].n,120)
 assert.equal((await query('select public.record_ops_events($1::jsonb) n',[evJson({kind:'upload_fail',code:'snaps_other',device:'desktop'})]))[0].n,0)
})
// Retention, and the identifying half going first.
await db.query("update public.ops_events set on_hour=now()-interval '40 days' where code='voice_other'")
await db.query("update public.ops_event_budget set on_hour=now()-interval '5 days'")
assert.equal((await query('select public.purge_ops_events() n'))[0].n,1)
assert.equal((await query('select count(*)::int n from public.ops_event_budget'))[0].n,0)
console.log('PASS telemetry rejects free text, foreign vocabularies and forged sources, caps a flood, and is unreadable to clients')

// Alerts. A threshold computed off sampled counts without scaling them back up
// is worse than no alert — it is confidently wrong in a fixed direction — so
// the alert reads `estimated` and this proves the difference matters.
await db.query('delete from public.ops_events')
const bulk=(kind,code,observed,estimated)=>db.query(
 "insert into public.ops_events(on_hour,source,kind,code,device,observed,estimated) values(date_trunc('hour',now()),'client',$1,$2,'desktop',$3,$4)",[kind,code,observed,estimated])
// 5 observed joins at 1-in-20 are 100 real joins against 40 drops: healthy, and
// exactly the case an unscaled reading would report as 40 drops to 5 joins.
await bulk('realtime_join','join_signal',5,100)
await bulk('realtime_drop','channel_error_signal',40,40)
assert.equal((await query('select count(*)::int n from public.ops_event_alerts()'))[0].n,0)
await db.query("update public.ops_events set estimated=200 where kind='realtime_drop'")
assert.deepEqual((await query('select alert from public.ops_event_alerts()')).map(r=>r.alert),['realtime_drops_exceed_joins'])
console.log('PASS the drop-rate alert reads the sampling-scaled figure, not the raw sample')
// The drift check is only worth having if the version it reports is the real
// newest one and a client can actually ask for it.
const newest=fs.readdirSync('supabase/migrations').filter((f)=>f.endsWith('.sql')).sort().at(-1).replace(/\.sql$/,'')
await asUser(A,async()=>{
 assert.equal((await query('select public.schema_version() v'))[0].v,newest)
 // The list of what is applied is operator data; only the newest id is public.
 await assert.rejects(query('select * from schema_migrations'),/permission denied/)
})
console.log('PASS schema_version reports the newest applied migration to a signed-in client')
await db.close()
