-- Apply once on an existing Meera schema, before deploying the matching frontend.
-- No accounts or friendships are created/deleted by this migration.
begin;

alter table public.messages add column if not exists client_id uuid;
create unique index if not exists messages_sender_client_unique on public.messages(sender_id, client_id);
grant insert(client_id) on public.messages to authenticated;
create index if not exists messages_page_cursor on public.messages(user_a,user_b,created_at desc,id desc);

create or replace function public.message_visible(m public.messages, viewer uuid)
returns boolean language sql stable set search_path = public as $$
 select viewer in (m.user_a,m.user_b) and m.unsent_at is null and (
   m.kind = 'call' or cardinality(m.saved_by) > 0 or (
     not (viewer = any(coalesce(m.cleared_by,'{}'::uuid[]))) and
     case when m.kind = 'snap' then
       case when m.sender_id = viewer then m.created_at > now() - interval '31 days'
       else coalesce(m.open_count,0) < 6 and
         coalesce(m.opened_at + interval '24 hours',m.created_at + interval '31 days') > now() end
     else coalesce(m.opened_at + interval '24 hours',m.created_at + interval '31 days') > now() end
   )
 );
$$;
revoke all on function public.message_visible(public.messages,uuid) from public;
grant execute on function public.message_visible(public.messages,uuid) to authenticated;

create or replace function public.message_page(other uuid, before_time timestamptz default null, before_id uuid default null, page_size int default 200)
returns setof public.messages language sql stable set search_path=public as $$
 select m.* from public.messages m
 where array[m.user_a,m.user_b] = public.pair_key(auth.uid(),other)
 and public.message_visible(m,auth.uid())
 and (before_time is null or (m.created_at,m.id) < (before_time,before_id))
 order by m.created_at desc,m.id desc limit greatest(1,least(page_size,200));
$$;
revoke all on function public.message_page(uuid,timestamptz,uuid,int) from public;
grant execute on function public.message_page(uuid,timestamptz,uuid,int) to authenticated;
create or replace function public.latest_messages(per_pair int default 4)
returns setof public.messages language sql stable set search_path=public as $$
 select distinct on (m.user_a,m.user_b) m.* from public.messages m
 where public.message_visible(m,auth.uid())
 order by m.user_a,m.user_b,m.created_at desc,m.id desc;
$$;

-- Receipt and leave operations are limited to the concrete IDs displayed in one visit.
create table if not exists public.message_visits (
 user_id uuid not null references public.profiles(id) on delete cascade,
 message_id uuid not null references public.messages(id) on delete cascade,
 visit_id uuid not null, left_at timestamptz, created_at timestamptz not null default now(),
 primary key(user_id,message_id,visit_id)
);
alter table public.message_visits enable row level security;
revoke all on public.message_visits from anon,authenticated;
create or replace function public.mark_messages_seen(other uuid, ids uuid[], visit uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
 insert into public.message_visits(user_id,message_id,visit_id)
 select auth.uid(),m.id,visit from public.messages m
 where m.id=any(ids) and array[m.user_a,m.user_b]=public.pair_key(auth.uid(),other)
 and public.message_visible(m,auth.uid()) and m.kind in ('chat','sticker','voice','snap')
 on conflict do nothing;
 update public.messages m set opened_at=coalesce(opened_at,now())
 where m.id=any(ids) and array[m.user_a,m.user_b]=public.pair_key(auth.uid(),other)
 and sender_id<>auth.uid() and kind in ('chat','voice','sticker') and opened_at is null;
end $$;
create or replace function public.leave_seen_messages(other uuid, ids uuid[], visit uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
 with newly_left as (
 update public.message_visits set left_at=now()
 where user_id=auth.uid() and visit_id=visit and message_id=any(ids) and left_at is null returning message_id
 )
 update public.messages m set
 view_leaves=jsonb_set(m.view_leaves,array[auth.uid()::text],to_jsonb(coalesce((m.view_leaves->>auth.uid()::text)::int,0)+1)),
 cleared_by=case when coalesce((m.view_leaves->>auth.uid()::text)::int,0)+1>=3 then array_append(m.cleared_by,auth.uid()) else m.cleared_by end
 where m.id in (select message_id from newly_left)
 and array[m.user_a,m.user_b]=public.pair_key(auth.uid(),other)
 and m.opened_at is not null and m.saved_by='{}' and not(auth.uid()=any(m.cleared_by))
 and (m.kind in ('chat','voice','sticker') or (m.kind='snap' and m.sender_id=auth.uid()));
end $$;
revoke all on function public.mark_messages_seen(uuid,uuid[],uuid), public.leave_seen_messages(uuid,uuid[],uuid) from public;
grant execute on function public.mark_messages_seen(uuid,uuid[],uuid), public.leave_seen_messages(uuid,uuid[],uuid) to authenticated;
-- Retire broad receipt RPCs: old clients must update before writing receipts.
revoke execute on function public.mark_chats_opened(uuid),public.clear_viewed_chats(uuid) from public,anon,authenticated;

-- New media is tracked before upload. Cleanup uses the Storage API, not metadata deletion.
create table if not exists public.media_cleanup (
 path text primary key, due_at timestamptz not null default now()+interval '24 hours'
);
alter table public.media_cleanup enable row level security;
revoke all on public.media_cleanup from anon,authenticated;
grant all on public.media_cleanup to service_role;
create or replace function public.queue_media_cleanup(object_path text)
returns void language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or split_part(object_path,'/',1)<>auth.uid()::text or object_path !~ '^[0-9a-f-]+/(snaps|voice|stories|memories)/[0-9a-z_.-]+$' then raise exception 'invalid media owner'; end if;
 insert into public.media_cleanup(path) values(object_path)
 on conflict(path) do update set due_at=now()+interval '24 hours' where not media_cleanup.deleting;
 if not found then raise exception 'Media upload expired; use a new upload'; end if;
end $$;
revoke all on function public.queue_media_cleanup(text) from public;
grant execute on function public.queue_media_cleanup(text) to authenticated;

create or replace function public.purge_expired()
returns void language plpgsql security definer set search_path=public as $$
begin
 with gone as (
 delete from public.messages where kind <> 'call' and saved_by='{}' and (
 (opened_at is not null and opened_at<now()-interval '24 hours') or
 (opened_at is null and created_at<now()-interval '31 days') or
 (unsent_at is not null and unsent_at<now()-interval '1 hour') or cardinality(cleared_by)>=2
 ) returning media_path)
 insert into public.media_cleanup(path,due_at) select distinct media_path,now() from gone where media_path is not null
 on conflict(path) do update set due_at=excluded.due_at;
 with gone as (delete from public.stories where expires_at<now() returning media_path)
 insert into public.media_cleanup(path,due_at) select distinct media_path,now() from gone where media_path is not null
 on conflict(path) do update set due_at=excluded.due_at;
 delete from public.message_visits where created_at<now()-interval '7 days';
end $$;
revoke all on function public.purge_expired() from public,anon,authenticated;
grant execute on function public.purge_expired() to service_role;

-- Lock media deletion against late metadata commits. Failed API deletes remain retryable.
alter table public.media_cleanup add column if not exists deleting boolean not null default false;
create or replace function public.guard_media_reference()
returns trigger language plpgsql security definer set search_path=public as $$
declare deleting_now boolean; file_path text; owner_id uuid;
begin
 owner_id:=coalesce((to_jsonb(new)->>'sender_id')::uuid,(to_jsonb(new)->>'user_id')::uuid);
 foreach file_path in array array[new.media_path,to_jsonb(new)->>'thumb_path'] loop
 if file_path is not null then
  if split_part(file_path,'/',1) is distinct from owner_id::text then raise exception 'Media must belong to the sender'; end if;
  if not exists(select 1 from storage.objects where bucket_id='media' and name=file_path) then raise exception 'Media file is unavailable'; end if;
  select deleting into deleting_now from public.media_cleanup where media_cleanup.path=file_path for update;
  if deleting_now then raise exception 'Media upload expired; please upload again'; end if;
 end if;
 end loop;
 return new;
end $$;
drop trigger if exists guard_media_reference on public.messages;
create trigger guard_media_reference before insert on public.messages for each row execute function public.guard_media_reference();
drop trigger if exists guard_media_reference on public.stories;
create trigger guard_media_reference before insert on public.stories for each row execute function public.guard_media_reference();
drop trigger if exists guard_media_reference on public.memories;
create trigger guard_media_reference before insert on public.memories for each row execute function public.guard_media_reference();
create or replace function public.claim_media_cleanup(object_path text)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 perform 1 from public.media_cleanup where path=object_path and due_at<=now() for update;
 if not found then return false; end if;
 if exists(select 1 from public.messages where media_path=object_path) or exists(select 1 from public.stories where media_path=object_path) or exists(select 1 from public.memories where media_path=object_path or thumb_path=object_path) then
  delete from public.media_cleanup where path=object_path;
  return false;
 end if;
 update public.media_cleanup set deleting=true where path=object_path;
 return true;
end $$;
revoke all on function public.claim_media_cleanup(text) from public,anon,authenticated;
grant execute on function public.claim_media_cleanup(text) to service_role;

-- Durable idempotency for scheduled bot delivery.
create table if not exists public.bot_deliveries (
 user_id uuid references public.profiles(id) on delete cascade,
 on_date date not null, primary key(user_id,on_date)
);
alter table public.bot_deliveries enable row level security;
revoke all on public.bot_deliveries from anon,authenticated;
create or replace function public.send_morning_quotes()
returns int language plpgsql security definer set search_path=public as $$
declare ru record; bot_id uuid; quote text; sent int:=0; claimed uuid;
begin
 for ru in select id from public.profiles where not is_bot loop
  select b.id into bot_id from public.profiles b where b.is_bot and exists(
   select 1 from public.friendships f where f.status='accepted' and array[f.user_a,f.user_b]=public.pair_key(b.id,ru.id))
   order by md5(b.id::text||ru.id::text||public.ist_date()::text) limit 1;
  select text into quote from public.bot_quotes order by md5(id::text||ru.id::text||public.ist_date()::text) limit 1;
  if bot_id is null or quote is null then continue; end if;
  claimed:=null;
  insert into public.bot_deliveries values(ru.id,public.ist_date()) on conflict do nothing returning user_id into claimed;
  if claimed is null then continue; end if;
  insert into public.messages(user_a,user_b,sender_id,kind,body,delivered_at)
  values(least(bot_id,ru.id),greatest(bot_id,ru.id),bot_id,'chat',quote,now());
  sent:=sent+1;
 end loop;
 return sent;
end $$;
revoke all on function public.send_morning_quotes() from public,anon,authenticated;
grant execute on function public.send_morning_quotes() to service_role;

-- Each private topic has exactly one writer, identified by the topic (not payload).
create or replace function public.realtime_allowed(topic text, writing boolean)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare parts text[]:=string_to_array(topic,':'); owner uuid; recipient uuid;
begin
 if auth.uid() is null then return false; end if;
 if parts[1]='online' and cardinality(parts)=2 then
  owner:=parts[2]::uuid;
  if writing then return owner=auth.uid(); end if;
  return owner=auth.uid() or exists(select 1 from public.friendships f where f.status='accepted' and array[f.user_a,f.user_b]=public.pair_key(owner,auth.uid()));
 elsif parts[1] in ('signal','typing') and cardinality(parts)=3 then
  recipient:=parts[2]::uuid; owner:=parts[3]::uuid;
  return (case when writing then owner=auth.uid() else recipient=auth.uid() end)
   and exists(select 1 from public.friendships f where f.status='accepted' and array[f.user_a,f.user_b]=public.pair_key(owner,recipient));
 end if;
 return false;
exception when invalid_text_representation then return false;
end $$;
revoke all on function public.realtime_allowed(text,boolean) from public;
grant execute on function public.realtime_allowed(text,boolean) to authenticated;
-- Restrictive guards prevent a pre-existing permissive policy from granting broader access.
drop policy if exists meera_private_read on realtime.messages;
drop policy if exists meera_private_write on realtime.messages;
drop policy if exists meera_private_read_guard on realtime.messages;
drop policy if exists meera_private_write_guard on realtime.messages;
create policy meera_private_read on realtime.messages for select to authenticated using(public.realtime_allowed(realtime.topic(),false));
create policy meera_private_write on realtime.messages for insert to authenticated with check(public.realtime_allowed(realtime.topic(),true));
create policy meera_private_read_guard on realtime.messages as restrictive for select to authenticated using(public.realtime_allowed(realtime.topic(),false));
create policy meera_private_write_guard on realtime.messages as restrictive for insert to authenticated with check(public.realtime_allowed(realtime.topic(),true));

-- A date and prompt are a single invariant; validate both at commit time.
drop function if exists public.todays_prompt();
create function public.todays_prompt()
returns table(id int,body text,on_date date) language sql stable security definer set search_path=public as $$
 select p.id,p.body,public.ist_date() from public.prompts p
 order by p.id offset ((extract(epoch from public.ist_date())::bigint/86400) % greatest(1,(select count(*) from public.prompts))) limit 1;
$$;
revoke all on function public.todays_prompt() from public;
grant execute on function public.todays_prompt() to authenticated;
revoke insert on public.prompt_answers from authenticated;
create or replace function public.answer_daily_prompt(other uuid,prompt int,answer text,expected_day date)
returns void language plpgsql security definer set search_path=public as $$
declare today_prompt int;
begin
 if auth.uid() is null or not exists(select 1 from public.friendships f where f.status='accepted' and array[f.user_a,f.user_b]=public.pair_key(auth.uid(),other)) then raise exception 'accepted friendship required'; end if;
 select id into today_prompt from public.todays_prompt();
 if expected_day is distinct from public.ist_date() or prompt is distinct from today_prompt then raise exception 'The daily question has changed. Review today’s question and try again.'; end if;
 insert into public.prompt_answers(user_a,user_b,responder,on_date,prompt_id,body)
 values(least(auth.uid(),other),greatest(auth.uid(),other),auth.uid(),expected_day,prompt,btrim(answer));
end $$;
revoke all on function public.answer_daily_prompt(uuid,int,text,date) from public;
grant execute on function public.answer_daily_prompt(uuid,int,text,date) to authenticated;

-- Harden profile data even though the renderer now uses textContent.
alter table public.profiles drop constraint if exists profile_avatar_safe;
alter table public.profiles add constraint profile_avatar_safe check(avatar_emoji is null or (length(avatar_emoji)<=32 and avatar_emoji !~ '[<>]')) not valid;
revoke insert,update,delete on public.security_questions from authenticated,anon;

create or replace function public.reset_password(uname text, answer text, new_password text)
returns boolean language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  uid uuid; stored text; locked timestamptz; tries int; last_try timestamptz;
  -- Wrong guesses stop counting once this much time has passed since the last
  -- one, so the lock is a rolling window rather than a permanent state.
  window_interval constant interval := interval '15 minutes';
begin
  if length(trim(coalesce(answer, ''))) = 0 then return false; end if;
  if length(coalesce(new_password,'')) < 6 then return false; end if;

  select p.id, sq.answer_hash, sq.locked_until, sq.attempts, sq.last_attempt_at
    into uid, stored, locked, tries, last_try
    from public.profiles p
    join public.security_questions sq on sq.user_id = p.id
   where p.username = lower(trim(uname)) for update of sq;
  if uid is null or stored is null then return false; end if;
  if locked is not null and locked > now() then return false; end if;

  -- (2) decay: a miss outside the window starts the count over.
  if last_try is null or last_try < now() - window_interval then
    tries := 0;
  end if;

  if extensions.crypt(lower(trim(answer)), stored) <> stored then
    update public.security_questions
       set attempts = tries + 1,
           last_attempt_at = now(),
           locked_until = case when tries + 1 >= 5 then now() + window_interval
                               else locked_until end
     where user_id = uid;
    return false;
  end if;

  -- Correct answer: change the password (cost-10, matching GoTrue)...
  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = uid;

  -- (1) ...and cut every existing session dead, so a session opened with the OLD
  -- password cannot outlive the reset. refresh_tokens.session_id cascades from
  -- auth.sessions; the second delete sweeps pre-session-table stragglers, whose
  -- user_id column is text in GoTrue, hence the cast. Guarded on its own so an
  -- unexpected shape there can never roll back the password change above.
  delete from auth.sessions where user_id = uid;
  begin
    delete from auth.refresh_tokens where user_id = uid::text;
  exception when others then null;
  end;

  update public.security_questions
     set attempts = 0, locked_until = null, last_attempt_at = null
   where user_id = uid;
  return true;
end $$;
revoke all on function public.reset_password(text, text, text) from public;
grant execute on function public.reset_password(text, text, text) to anon, authenticated;


-- Scrub metadata BEFORE INSERT/RETURNING so the auth session cannot persist the answer.
create schema if not exists private;
create table if not exists private.signup_recovery(user_id uuid primary key,question text not null,answer_hash text not null);
alter table private.signup_recovery enable row level security;
revoke all on private.signup_recovery from public,anon,authenticated;
create or replace function private.capture_signup_recovery()
returns trigger language plpgsql security definer set search_path=public,extensions as $$
declare question text:=new.raw_user_meta_data->>'recovery_question'; answer text:=new.raw_user_meta_data->>'recovery_answer';
begin
 if question is not null or answer is not null then
  if length(btrim(coalesce(question,'')))=0 or length(btrim(coalesce(answer,'')))=0 then raise exception 'Recovery question and answer are required'; end if;
  insert into private.signup_recovery(user_id,question,answer_hash)
  values(new.id,question,extensions.crypt(lower(btrim(answer)),extensions.gen_salt('bf',10)));
 end if;
 new.raw_user_meta_data:=new.raw_user_meta_data-'recovery_question'-'recovery_answer';
 return new;
end $$;
drop trigger if exists meera_capture_recovery on auth.users;
create trigger meera_capture_recovery before insert on auth.users for each row execute function private.capture_signup_recovery();
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public,extensions as $$
declare uname citext:=lower(split_part(new.email,'@',1));
begin
 if uname !~ '^[a-z0-9_.]{3,20}$' then raise exception 'invalid username'; end if;
 insert into public.profiles(id,username,display_name,avatar_hue)
 values(new.id,uname,coalesce(new.raw_user_meta_data->>'display_name',''),mod(abs(hashtext(new.id::text)::bigint),360)) on conflict(id) do nothing;
 with pending as (delete from private.signup_recovery where user_id=new.id returning *)
 insert into public.security_questions(user_id,question,answer_hash) select user_id,question,answer_hash from pending;
 return new;
end $$;
notify pgrst,'reload schema';
commit;
