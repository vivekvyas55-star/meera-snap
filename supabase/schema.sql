-- ============================================================================
-- Meera schema
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: everything is idempotent.
-- ============================================================================

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      citext unique not null check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name  text not null default '',
  avatar_seed   text not null default 'default',
  avatar_hue    int  not null default 45,
  created_at    timestamptz not null default now()
);

-- Auth uses username@meera.local synthetic emails; this trigger mirrors the
-- chosen username (passed as user metadata) into a real profile row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, avatar_hue)
  values (
    new.id,
    lower(coalesce(new.raw_user_meta_data->>'username', 'user' || substr(new.id::text, 1, 8))),
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    (abs(hashtext(new.id::text)) % 360)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- friendships  (one row per pair, user_a < user_b enforced)
-- ---------------------------------------------------------------------------
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  user_a       uuid not null references public.profiles(id) on delete cascade,
  user_b       uuid not null references public.profiles(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at   timestamptz not null default now(),
  constraint ordered_pair check (user_a < user_b),
  unique (user_a, user_b)
);

-- Canonical pair helper so callers never worry about ordering.
create or replace function public.pair_key(u1 uuid, u2 uuid)
returns uuid[] language sql immutable as $$
  select case when u1 < u2 then array[u1, u2] else array[u2, u1] end;
$$;

-- ---------------------------------------------------------------------------
-- messages  (chats and snaps share one table; `kind` distinguishes them)
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  user_a          uuid not null references public.profiles(id) on delete cascade,
  user_b          uuid not null references public.profiles(id) on delete cascade,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  kind            text not null check (kind in ('chat','snap')),
  body            text,
  media_path      text,
  media_type      text check (media_type in ('image','video')),
  has_audio       boolean not null default false,
  view_seconds    int,                       -- null = infinity ("no limit")
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  opened_at       timestamptz,
  replayed_at     timestamptz,
  screenshot_at   timestamptz,
  saved_by        uuid[] not null default '{}',
  cleared_at      timestamptz,               -- ephemeral deletion (viewed / 24h)
  unsent_at       timestamptz,               -- sender pressed "unsend"
  constraint ordered_pair_msg check (user_a < user_b)
);

create index if not exists messages_pair_idx on public.messages (user_a, user_b, created_at desc);
create index if not exists messages_sender_idx on public.messages (sender_id);

-- ---------------------------------------------------------------------------
-- streaks  (one row per friend pair)
-- ---------------------------------------------------------------------------
create table if not exists public.streaks (
  user_a          uuid not null references public.profiles(id) on delete cascade,
  user_b          uuid not null references public.profiles(id) on delete cascade,
  count           int  not null default 0,
  -- last snap sent by each side; a streak day requires BOTH within 24h
  last_snap_a     timestamptz,
  last_snap_b     timestamptz,
  last_increment  timestamptz,
  primary key (user_a, user_b),
  constraint ordered_pair_streak check (user_a < user_b)
);

-- ---------------------------------------------------------------------------
-- stories  (48h / 2-day expiry)
-- ---------------------------------------------------------------------------
create table if not exists public.stories (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  media_path   text not null,
  media_type   text not null default 'image' check (media_type in ('image','video')),
  caption      text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '48 hours'
);
create index if not exists stories_user_idx on public.stories (user_id, created_at desc);
create index if not exists stories_expiry_idx on public.stories (expires_at);

create table if not exists public.story_views (
  story_id      uuid not null references public.stories(id) on delete cascade,
  viewer_id     uuid not null references public.profiles(id) on delete cascade,
  viewed_at     timestamptz not null default now(),
  screenshot_at timestamptz,
  primary key (story_id, viewer_id)
);

-- ============================================================================
-- Streak logic
-- ============================================================================
-- Snapchat rule: a streak needs BOTH friends to send a snap (not a chat) to
-- each other within each 24-hour window. Sending twice in a row does not
-- advance it. The streak dies when either side lets 24h lapse.
create or replace function public.bump_streak()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  s public.streaks%rowtype;
  now_ts timestamptz := now();
  sender_is_a boolean := (new.sender_id = new.user_a);
  a_ts timestamptz;
  b_ts timestamptz;
begin
  if new.kind <> 'snap' then
    return new;
  end if;

  insert into public.streaks (user_a, user_b)
  values (new.user_a, new.user_b)
  on conflict (user_a, user_b) do nothing;

  select * into s from public.streaks
   where user_a = new.user_a and user_b = new.user_b for update;

  -- If either side has gone silent for more than 24h, the streak is already dead.
  if s.count > 0 and (
       s.last_snap_a is null or s.last_snap_b is null
       or s.last_snap_a < now_ts - interval '24 hours'
       or s.last_snap_b < now_ts - interval '24 hours') then
    s.count := 0;
    s.last_increment := null;
  end if;

  a_ts := case when sender_is_a then now_ts else s.last_snap_a end;
  b_ts := case when sender_is_a then s.last_snap_b else now_ts end;

  -- Both sides active within 24h, and we haven't already counted this window.
  if a_ts is not null and b_ts is not null
     and a_ts > now_ts - interval '24 hours'
     and b_ts > now_ts - interval '24 hours'
     and (s.last_increment is null or s.last_increment < now_ts - interval '20 hours')
  then
    s.count := greatest(s.count, 0) + 1;
    s.last_increment := now_ts;
  end if;

  update public.streaks
     set count = s.count,
         last_snap_a = a_ts,
         last_snap_b = b_ts,
         last_increment = s.last_increment
   where user_a = new.user_a and user_b = new.user_b;

  return new;
end;
$$;

drop trigger if exists on_message_streak on public.messages;
create trigger on_message_streak
  after insert on public.messages
  for each row execute function public.bump_streak();

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.profiles    enable row level security;
alter table public.friendships enable row level security;
alter table public.messages    enable row level security;
alter table public.streaks     enable row level security;
alter table public.stories     enable row level security;
alter table public.story_views enable row level security;

-- profiles: everyone signed in can look up profiles (needed to add by username)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- friendships: only the two parties can see or touch the row
drop policy if exists friendships_rw on public.friendships;
create policy friendships_rw on public.friendships
  for all to authenticated
  using (auth.uid() in (user_a, user_b))
  with check (auth.uid() in (user_a, user_b));

-- messages: only the two parties; only the sender may create as themselves
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select to authenticated using (auth.uid() in (user_a, user_b));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (auth.uid() = sender_id and auth.uid() in (user_a, user_b));

-- Both parties may update (recipient marks opened/screenshot, sender unsends).
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages
  for update to authenticated using (auth.uid() in (user_a, user_b));

drop policy if exists streaks_read on public.streaks;
create policy streaks_read on public.streaks
  for select to authenticated using (auth.uid() in (user_a, user_b));

-- stories: readable by accepted friends, writable only by the author
drop policy if exists stories_read on public.stories;
create policy stories_read on public.stories
  for select to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from public.friendships f
       where f.status = 'accepted'
         and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), stories.user_id)
    )
  );

drop policy if exists stories_write on public.stories;
create policy stories_write on public.stories
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists stories_delete on public.stories;
create policy stories_delete on public.stories
  for delete to authenticated using (user_id = auth.uid());

-- story_views: viewer writes their own; author reads all views of their story
drop policy if exists story_views_insert on public.story_views;
create policy story_views_insert on public.story_views
  for insert to authenticated with check (viewer_id = auth.uid());

drop policy if exists story_views_update on public.story_views;
create policy story_views_update on public.story_views
  for update to authenticated using (viewer_id = auth.uid());

drop policy if exists story_views_read on public.story_views;
create policy story_views_read on public.story_views
  for select to authenticated using (
    viewer_id = auth.uid()
    or exists (select 1 from public.stories s
                where s.id = story_views.story_id and s.user_id = auth.uid())
  );

-- ============================================================================
-- Table privileges
-- ============================================================================
-- RLS decides WHICH ROWS a role may touch. It does not grant access to the
-- table itself — that is a separate, older Postgres mechanism. Without these
-- GRANTs every query fails with "42501: permission denied", no matter how
-- permissive the policies are.
--
-- Granting broadly to `authenticated` is safe here precisely because every
-- table above has RLS enabled: the policies remain the real gate, and the
-- grants are only what lets the policies get evaluated at all. Privileges are
-- still kept to what each table's policies actually allow.
grant usage on schema public to anon, authenticated;

grant select, update            on public.profiles    to authenticated;
grant select, insert, update, delete on public.friendships to authenticated;
grant select, insert, update    on public.messages    to authenticated;
grant select                    on public.streaks     to authenticated;
grant select, insert, delete    on public.stories     to authenticated;
grant select, insert, update    on public.story_views to authenticated;

-- ============================================================================
-- Realtime
-- ============================================================================
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.friendships;
alter publication supabase_realtime add table public.stories;
alter publication supabase_realtime add table public.streaks;

-- ============================================================================
-- Storage bucket for snap + story media
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- Any authenticated user may upload under their own uid prefix: media/<uid>/<file>
drop policy if exists media_upload on storage.objects;
create policy media_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

-- Reads are brokered by signed URLs generated server-side by the client SDK;
-- allow authenticated reads within the bucket.
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects
  for select to authenticated using (bucket_id = 'media');

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
