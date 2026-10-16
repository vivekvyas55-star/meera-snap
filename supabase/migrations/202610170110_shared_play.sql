-- Shared asynchronous activities. No direct table access: all reads project
-- secret answers and all writes check friendship, membership and revision.
begin;
create table if not exists public.shared_play (
 id uuid primary key default gen_random_uuid(),
 user_a uuid not null references auth.users(id) on delete cascade,
 user_b uuid not null references auth.users(id) on delete cascade,
 creator uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('pick','emoji','word','story','date','island')),
 status text not null default 'pending' check(status in ('pending','active','done','dismissed')),
 turn uuid not null,
 revision integer not null default 0,
 data jsonb not null default '{}',
 secret text,
 last_request uuid,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now() + interval '7 days'),
 check(user_a < user_b)
);
alter table public.shared_play enable row level security;
revoke all on public.shared_play from public,anon,authenticated;
create index if not exists shared_play_pair on public.shared_play(user_a,user_b,expires_at);

create or replace function public.shared_play_allowed(other uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and other is not null and other <> auth.uid()
 and exists(select 1 from friendships f where array[f.user_a,f.user_b]=pair_key(auth.uid(),other) and f.status='accepted')
 and not exists(select 1 from blocks b where (b.blocker=auth.uid() and b.blocked=other) or (b.blocker=other and b.blocked=auth.uid()));
$$;
revoke all on function public.shared_play_allowed(uuid) from public,anon,authenticated;

create or replace function public.shared_play_list(other uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
 if not shared_play_allowed(other) then raise exception 'This activity needs an accepted, unblocked friendship.'; end if;
 return coalesce((select jsonb_agg((to_jsonb(s)-'secret'-'last_request') order by created_at desc)
 from shared_play s where array[s.user_a,s.user_b]=pair_key(auth.uid(),other) and expires_at>now()),'[]'::jsonb);
end $$;

create or replace function public.shared_play_create(other uuid, game text, body jsonb, request_id uuid) returns uuid
language plpgsql volatile security definer set search_path=public as $$
declare pk uuid[]; hidden text; initial jsonb; existing public.shared_play; count_live int;
begin
 if not shared_play_allowed(other) then raise exception 'This activity needs an accepted, unblocked friendship.'; end if;
 if request_id is null or game is null or game not in ('pick','emoji','word','story','date','island') or body is null then raise exception 'Invalid activity'; end if;
 pk:=pair_key(auth.uid(),other);
 perform pg_advisory_xact_lock(hashtextextended(pk::text,0));
 select * into existing from shared_play where id=request_id;
 if found then
   if existing.creator=auth.uid() and existing.user_a=pk[1] and existing.user_b=pk[2] then return existing.id; end if;
   raise exception 'Request already used';
 end if;
 select count(*) into count_live from shared_play where user_a=pk[1] and user_b=pk[2] and expires_at>now();
 if count_live>=40 then raise exception 'This space has 40 activities. Remove an old activity first.'; end if;
 if game='island' then
   initial:='{"a":{"x":4,"y":8,"seq":0,"bag":-1},"b":{"x":6,"y":8,"seq":0,"bag":-1},"delivered":[],"bridge":false}'::jsonb;
 elsif game in ('pick','emoji') then
   if length(trim(coalesce(body->>'prompt',''))) not between 1 and 160 then raise exception 'Add a clue or question (up to 160 characters).'; end if;
   hidden:=lower(trim(coalesce(body->>'answer','')));
   if length(hidden) not between 1 and 80 then raise exception 'Add a secret answer (up to 80 characters).'; end if;
   initial:=jsonb_build_object('prompt',trim(body->>'prompt'));
   if game='pick' then
     if length(trim(coalesce(body->>'a',''))) not between 1 and 60 or length(trim(coalesce(body->>'b',''))) not between 1 and 60 or hidden not in ('a','b') then raise exception 'Add two options and choose your secret pick.'; end if;
     initial:=initial||jsonb_build_object('a',trim(body->>'a'),'b',trim(body->>'b'));
   end if;
 elsif game='word' then
   if coalesce(body->>'text','') !~ '^[a-zA-Z]{2,24}$' then raise exception 'Start with one English word, 2–24 letters.'; end if;
   initial:=jsonb_build_object('entries',jsonb_build_array(jsonb_build_object('by',auth.uid(),'text',lower(body->>'text'))));
 elsif game='story' then
   if length(trim(coalesce(body->>'text',''))) not between 1 and 240 then raise exception 'Start with a sentence, up to 240 characters.'; end if;
   initial:=jsonb_build_object('entries',jsonb_build_array(jsonb_build_object('by',auth.uid(),'text',trim(body->>'text'))));
 else
   if length(trim(coalesce(body->>'text',''))) not between 1 and 160 then raise exception 'Add a date idea, up to 160 characters.'; end if;
   initial:=jsonb_build_object('text',trim(body->>'text'),'likes',jsonb_build_array(auth.uid()));
 end if;
 insert into shared_play(id,user_a,user_b,creator,kind,turn,data,secret,expires_at)
 values(request_id,pk[1],pk[2],auth.uid(),game,other,initial,hidden,now()+case when game='date' then interval '30 days' else interval '7 days' end);
 return request_id;
end $$;

create or replace function public.shared_play_act(activity uuid, expected_revision integer, action text, value text, request_id uuid) returns void
language plpgsql volatile security definer set search_path=public as $$
declare s public.shared_play; other uuid; n int; word text; likes jsonb;
begin
 select * into s from shared_play where id=activity for update;
 if not found or auth.uid() is null or auth.uid() not in (s.user_a,s.user_b) then raise exception 'Activity unavailable'; end if;
 other:=case when auth.uid()=s.user_a then s.user_b else s.user_a end;
 if not shared_play_allowed(other) or s.expires_at<=now() then raise exception 'Activity unavailable'; end if;
 if request_id is null then raise exception 'Missing request identity'; end if;
 if action is null or action not in ('remove','dismiss','interest','accept','move') then raise exception 'Unknown action'; end if;
 if s.last_request=request_id then return; end if;
 if expected_revision is null or expected_revision<>s.revision then raise exception 'This activity changed. Refresh and try again.'; end if;
 if action='remove' then delete from shared_play where id=activity; return; end if;
 if action='dismiss' then
   update shared_play set status='dismissed',secret=null,revision=revision+1,last_request=request_id where id=activity; return;
 end if;
 if s.status in ('done','dismissed') then raise exception 'This activity has ended'; end if;
 if s.kind='date' then
   if action<>'interest' then raise exception 'Unknown action'; end if;
   likes:=s.data->'likes';
   if not likes @> jsonb_build_array(auth.uid()) then likes:=likes||jsonb_build_array(auth.uid()); end if;
   update shared_play set data=jsonb_set(data,'{likes}',likes),status=case when jsonb_array_length(likes)=2 then 'done' else 'pending' end,revision=revision+1,last_request=request_id where id=activity;
   return;
 end if;
 if action='accept' then
   if s.status<>'pending' or s.creator=auth.uid() then raise exception 'Only the invited person can join'; end if;
   update shared_play set status='active',revision=revision+1,last_request=request_id where id=activity; return;
 end if;
 if s.status<>'active' or s.turn<>auth.uid() then raise exception 'Wait for your turn'; end if;
 if action<>'move' then raise exception 'Unknown action'; end if;
 if s.kind='island' then raise exception 'Use island controls'; end if;
 if s.kind in ('pick','emoji') then
   word:=lower(trim(coalesce(value,'')));
   if length(word) not between 1 and 80 or (s.kind='pick' and word not in ('a','b')) then raise exception 'Enter a valid guess'; end if;
   update shared_play set data=data||jsonb_build_object('guess',word,'answer',secret,'correct',word=secret),secret=null,status='done',revision=revision+1,last_request=request_id where id=activity;
 else
   n:=jsonb_array_length(s.data->'entries');
   word:=trim(coalesce(value,''));
   if s.kind='word' then
     word:=lower(word);
     if word !~ '^[a-z]{2,24}$' or left(word,1)<>right(s.data->'entries'->(n-1)->>'text',1) then raise exception 'Use the last letter to start a word (2–24 English letters).'; end if;
     if exists(select 1 from jsonb_array_elements(s.data->'entries') e where e->>'text'=word) then raise exception 'That word has already been used.'; end if;
   elsif length(word) not between 1 and 240 then raise exception 'Add a sentence, up to 240 characters.';
   end if;
   update shared_play set data=jsonb_set(data,'{entries}',(data->'entries')||jsonb_build_array(jsonb_build_object('by',auth.uid(),'text',word))),
     turn=other,status=case when n+1 >= case when s.kind='word' then 12 else 8 end then 'done' else 'active' end,
     revision=revision+1,last_request=request_id where id=activity;
 end if;
end $$;

create or replace function public.purge_shared_play() returns void
language sql volatile security definer set search_path=public as $$
 delete from shared_play s where expires_at<=now()
 or not exists(select 1 from friendships f where f.user_a=s.user_a and f.user_b=s.user_b and f.status='accepted')
 or exists(select 1 from blocks b where (b.blocker=s.user_a and b.blocked=s.user_b) or (b.blocker=s.user_b and b.blocked=s.user_a));
$$;
revoke all on function public.shared_play_list(uuid),public.shared_play_create(uuid,text,jsonb,uuid),public.shared_play_act(uuid,integer,text,text,uuid),public.purge_shared_play() from public,anon,authenticated;
grant execute on function public.shared_play_list(uuid),public.shared_play_create(uuid,text,jsonb,uuid),public.shared_play_act(uuid,integer,text,text,uuid) to authenticated;
grant execute on function public.purge_shared_play() to service_role;

create or replace function public.shared_play_friendship_removed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if tg_op='DELETE' then
   delete from shared_play where user_a=old.user_a and user_b=old.user_b;
 elsif new.status<>'accepted' then
   delete from shared_play where user_a=new.user_a and user_b=new.user_b;
 end if;
 return null;
end $$;
revoke all on function public.shared_play_friendship_removed() from public,anon,authenticated;
drop trigger if exists shared_play_friendship_removed on public.friendships;
create trigger shared_play_friendship_removed after delete or update of status on public.friendships
 for each row execute function public.shared_play_friendship_removed();
insert into public.schema_migrations(id) values ('202610170110_shared_play') on conflict do nothing;
notify pgrst, 'reload schema';
commit;
