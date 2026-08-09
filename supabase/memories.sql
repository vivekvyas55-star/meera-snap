-- ============================================================================
-- Memories: a private gallery of your own saved snaps. Owner-only — nobody
-- else can read another person's Memories. Media lives in the existing `media`
-- bucket under <uid>/memories/, so the media_upload (own-uid prefix) and
-- media_read (owner) storage policies already cover it.
-- ============================================================================

create table if not exists public.memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  media_path  text not null,
  media_type  text not null default 'image' check (media_type in ('image','video')),
  caption     text,
  created_at  timestamptz not null default now()
);
create index if not exists memories_user_idx on public.memories (user_id, created_at desc);

alter table public.memories enable row level security;

drop policy if exists memories_own on public.memories;
create policy memories_own on public.memories
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Owner-only: read/add/remove your own. No UPDATE (memories are immutable).
grant select, insert, delete on public.memories to authenticated;

notify pgrst, 'reload schema';
select 'memories table created (private owner-only gallery)' as status;
