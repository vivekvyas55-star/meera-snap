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
console.log('PASS push endpoints, display names and blocks cannot be written around')
console.log('PASS every client write succeeds for a legitimate user')

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
