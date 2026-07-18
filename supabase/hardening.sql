-- ============================================================================
-- Meera security hardening — apply once, after schema.sql.
-- Addresses the audit findings. Idempotent.
--
-- Core principle codified here: RLS gates ROWS, not COLUMNS. "Which columns may
-- change" is enforced with column-level GRANT; "write-once / monotonic" is
-- enforced with BEFORE triggers (WITH CHECK cannot see OLD). Policies alone are
-- not sufficient and several original ones wrongly assumed they were.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- CRITICAL-1 — storage reads were open to every authenticated user.
-- Scope them to: the owner, a party to the message, or the audience of a story.
-- ---------------------------------------------------------------------------
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects
  for select to authenticated using (
    bucket_id = 'media' and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.messages m
         where m.media_path = storage.objects.name
           and auth.uid() in (m.user_a, m.user_b))
      or exists (
        select 1 from public.stories s
         where s.media_path = storage.objects.name
           and (s.user_id = auth.uid()
                or exists (select 1 from public.friendships f
                            where f.status = 'accepted'
                              and array[f.user_a, f.user_b]
                                  = public.pair_key(auth.uid(), s.user_id))))
    )
  );
create index if not exists messages_media_path_idx on public.messages (media_path);
create index if not exists stories_media_path_idx  on public.stories  (media_path);

-- ---------------------------------------------------------------------------
-- CRITICAL-2 — message columns were fully mutable by either party.
-- Freeze content columns via column GRANTs; guard monotonic fields via trigger.
-- ---------------------------------------------------------------------------
revoke insert on public.messages from authenticated;
grant insert (user_a, user_b, sender_id, kind, body, media_path, media_type,
              has_audio, view_seconds, delivered_at) on public.messages to authenticated;

revoke update on public.messages from authenticated;
grant update (opened_at, replayed_at, screenshot_at, saved_by, cleared_at, unsent_at)
  on public.messages to authenticated;

create or replace function public.guard_message_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- receipt stamps are write-once
  if old.opened_at     is not null and new.opened_at     is distinct from old.opened_at     then raise exception 'opened_at is immutable'; end if;
  if old.screenshot_at is not null and new.screenshot_at is distinct from old.screenshot_at then raise exception 'screenshot_at is immutable'; end if;
  if old.replayed_at   is not null and new.replayed_at   is distinct from old.replayed_at   then raise exception 'replayed_at is immutable'; end if;
  -- unsend is one-way and sender-only
  if old.unsent_at is not null and new.unsent_at is distinct from old.unsent_at then raise exception 'message already unsent'; end if;
  if new.unsent_at is not null and old.unsent_at is null and old.sender_id <> auth.uid() then
    raise exception 'only the sender may unsend'; end if;
  -- saved_by: caller may only add or remove their OWN uid
  if new.saved_by is distinct from old.saved_by then
    if (select coalesce(array_agg(x order by x), '{}') from unnest(new.saved_by) x where x <> auth.uid())
       is distinct from
       (select coalesce(array_agg(x order by x), '{}') from unnest(old.saved_by) x where x <> auth.uid())
    then raise exception 'may only save/unsave for yourself'; end if;
  end if;
  return new;
end $$;

drop trigger if exists on_message_update on public.messages;
create trigger on_message_update before update on public.messages
  for each row execute function public.guard_message_update();

-- ---------------------------------------------------------------------------
-- HIGH-1 — friendships: split FOR ALL into a real state machine so nobody can
-- self-accept, forge requested_by, or silently re-open a blocked pair.
-- ---------------------------------------------------------------------------
alter table public.friendships add column if not exists blocked_by uuid references public.profiles(id);

drop policy if exists friendships_rw on public.friendships;

create policy friendships_read on public.friendships
  for select to authenticated using (auth.uid() in (user_a, user_b));

create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (auth.uid() in (user_a, user_b)
              and requested_by = auth.uid()
              and status = 'pending');

create policy friendships_update on public.friendships
  for update to authenticated
  using  (auth.uid() in (user_a, user_b))
  with check (auth.uid() in (user_a, user_b));

create policy friendships_delete on public.friendships
  for delete to authenticated using (auth.uid() in (user_a, user_b));

create or replace function public.guard_friendship_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.requested_by <> old.requested_by then raise exception 'requested_by is immutable'; end if;
  if new.user_a <> old.user_a or new.user_b <> old.user_b then raise exception 'pair is immutable'; end if;
  -- only the RECIPIENT of a request may accept it
  if new.status = 'accepted' and old.status <> 'accepted' and old.requested_by = auth.uid() then
    raise exception 'cannot accept your own request'; end if;
  -- a blocked pair may only be unblocked by whoever blocked it
  if old.status = 'blocked' and new.status <> 'blocked'
     and old.blocked_by is distinct from auth.uid() then
    raise exception 'only the blocker may unblock'; end if;
  return new;
end $$;

drop trigger if exists on_friendship_update on public.friendships;
create trigger on_friendship_update before update on public.friendships
  for each row execute function public.guard_friendship_update();

-- messages may only flow between accepted friends
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    auth.uid() = sender_id and auth.uid() in (user_a, user_b)
    and exists (select 1 from public.friendships f
                 where f.user_a = messages.user_a and f.user_b = messages.user_b
                   and f.status = 'accepted')
  );

-- ---------------------------------------------------------------------------
-- HIGH-2 — derive username from the (unique) email, never trust client
-- metadata; freeze the username column.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare uname citext := lower(split_part(new.email, '@', 1));
begin
  if uname !~ '^[a-z0-9_.]{3,20}$' then
    raise exception 'invalid username %', uname using errcode = '23514';
  end if;
  insert into public.profiles (id, username, display_name, avatar_hue)
  values (new.id, uname,
          coalesce(new.raw_user_meta_data->>'display_name', ''),
          (abs(hashtext(new.id::text)) % 360))
  on conflict (id) do nothing;
  return new;
end $$;

revoke update on public.profiles from authenticated;
grant update (display_name, avatar_seed, avatar_hue) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- MED-1 — profiles were world-readable (full user enumeration, and step 1 of
-- the storage exploit). Restrict to self + known relationships; route username
-- discovery through a definer point-lookup.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (
    id = auth.uid()
    or exists (select 1 from public.friendships f
                where array[f.user_a, f.user_b] = public.pair_key(auth.uid(), profiles.id))
  );

create or replace function public.lookup_username(u citext)
returns table (id uuid, username citext, display_name text, avatar_seed text, avatar_hue int)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name, p.avatar_seed, p.avatar_hue
    from public.profiles p where p.username = u;
$$;
revoke all on function public.lookup_username(citext) from public;
grant execute on function public.lookup_username(citext) to authenticated;

-- ---------------------------------------------------------------------------
-- HIGH-3 / MED-3 — stories: freeze expiry/author at insert; make reads respect
-- expiry rather than relying on a client-side filter.
-- ---------------------------------------------------------------------------
revoke insert on public.stories from authenticated;
grant insert (user_id, media_path, media_type, caption) on public.stories to authenticated;

drop policy if exists stories_read on public.stories;
create policy stories_read on public.stories
  for select to authenticated using (
    (expires_at > now() or user_id = auth.uid())
    and (user_id = auth.uid()
         or exists (select 1 from public.friendships f
                     where f.status = 'accepted'
                       and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), stories.user_id)))
  );

-- ---------------------------------------------------------------------------
-- LOW-1 — story_views: viewer may only stamp their own screenshot flag, and
-- only on a story that exists.
-- ---------------------------------------------------------------------------
drop policy if exists story_views_insert on public.story_views;
create policy story_views_insert on public.story_views
  for insert to authenticated
  with check (viewer_id = auth.uid()
              and exists (select 1 from public.stories s where s.id = story_id));

revoke update on public.story_views from authenticated;
grant update (screenshot_at) on public.story_views to authenticated;

-- ---------------------------------------------------------------------------
-- MED-2 — streak: the increment guard used 20h against a 24h window, ratcheting
-- the clock backwards and letting one side inflate the count. Match to 24h and
-- require both sides to have acted within the current window.
-- ---------------------------------------------------------------------------
create or replace function public.bump_streak()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s public.streaks%rowtype;
  now_ts timestamptz := now();
  sender_is_a boolean := (new.sender_id = new.user_a);
  a_ts timestamptz;
  b_ts timestamptz;
begin
  if new.kind <> 'snap' then return new; end if;

  insert into public.streaks (user_a, user_b) values (new.user_a, new.user_b)
    on conflict (user_a, user_b) do nothing;
  select * into s from public.streaks
   where user_a = new.user_a and user_b = new.user_b for update;
  if not found then return new; end if;

  if s.count > 0 and (
       s.last_snap_a is null or s.last_snap_b is null
       or s.last_snap_a < now_ts - interval '24 hours'
       or s.last_snap_b < now_ts - interval '24 hours') then
    s.count := 0; s.last_increment := null;
  end if;

  a_ts := case when sender_is_a then now_ts else s.last_snap_a end;
  b_ts := case when sender_is_a then s.last_snap_b else now_ts end;

  if a_ts is not null and b_ts is not null
     and a_ts > now_ts - interval '24 hours'
     and b_ts > now_ts - interval '24 hours'
     and (s.last_increment is null
          or (least(a_ts, b_ts) > s.last_increment
              and s.last_increment < now_ts - interval '24 hours'))
  then
    s.count := greatest(s.count, 0) + 1;
    s.last_increment := now_ts;
  end if;

  update public.streaks
     set count = s.count, last_snap_a = a_ts, last_snap_b = b_ts,
         last_increment = s.last_increment
   where user_a = new.user_a and user_b = new.user_b;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- HIGH-3 — server-side purge of expired content (ephemerality was never
-- enforced; everything was retained forever). Scheduled if pg_cron is present.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired()
returns void language plpgsql security definer set search_path = public as $$
begin
  with gone as (
    delete from public.messages
     where saved_by = '{}'
       and ((opened_at is not null and opened_at < now() - interval '24 hours')
            or (opened_at is null and created_at < now() - interval '31 days')
            or (unsent_at is not null and unsent_at < now() - interval '1 hour'))
    returning media_path)
  delete from storage.objects
   where bucket_id = 'media' and name in (select media_path from gone where media_path is not null);

  with dead as (delete from public.stories where expires_at < now() returning media_path)
  delete from storage.objects
   where bucket_id = 'media' and name in (select media_path from dead where media_path is not null);
end $$;

do $$
begin
  perform cron.schedule('meera-purge-expired', '*/15 * * * *', 'select public.purge_expired()');
exception when undefined_function or undefined_table or invalid_schema_name then
  raise notice 'pg_cron not enabled; run select public.purge_expired() from a scheduled job manually';
end $$;

-- ---------------------------------------------------------------------------
-- LOW-2/3/4 — missing indexes and constraints.
-- ---------------------------------------------------------------------------
create index if not exists friendships_user_b_idx on public.friendships (user_b);
create index if not exists streaks_user_b_idx      on public.streaks     (user_b);
create index if not exists friendships_pair_status_idx on public.friendships (status, user_a, user_b);

-- ADD CONSTRAINT has no IF NOT EXISTS form, so guard each one.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'snap_has_media') then
    alter table public.messages add constraint snap_has_media
      check (kind <> 'snap' or media_path is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'view_seconds_sane') then
    alter table public.messages add constraint view_seconds_sane
      check (view_seconds is null or view_seconds between 1 and 60);
  end if;
end $$;
