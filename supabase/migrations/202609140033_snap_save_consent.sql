-- ---------------------------------------------------------------------------
-- Sender intent on a disappearing snap: the recipient may put it in their
-- camera roll only if the SENDER said so.
--
-- What was there before was a gate that granted itself. SnapViewer allowed the
-- export when `saved_by` contained the viewer — and `saved_by` is written by
-- `toggle_saved()`, which EITHER party may call. So a recipient tapped "Save in
-- chat" on the snap, which put their own uid in the array, and the viewer then
-- offered them the download. The comment above it claimed "a recipient cannot
-- quietly turn an unsaved disappearing snap into a gallery file without the
-- sender's mutual-save signal". There was no sender signal in that condition at
-- all. A privacy claim the code did not back.
--
-- BE HONEST ABOUT WHAT THIS IS. Media lives in Storage behind a signed URL, and
-- the recipient must be able to fetch those bytes in order to look at the snap.
-- Once they have looked at it they have it: a screenshot, a screen recording,
-- the URL out of devtools, a second phone pointed at the first. This column
-- makes the sender's answer AUTHORITATIVE and UNFORGEABLE BY THE CLIENT — the
-- recipient cannot flip it, and no amount of PATCHing PostgREST gets them the
-- Save button. It does not, and cannot, stop a determined recipient keeping a
-- copy. Ephemerality here is a UI contract, not a security property, and this
-- is the same kind of contract. Nothing in the UI may promise more than that.
-- ---------------------------------------------------------------------------
begin;

-- Default FALSE, so nothing already sent becomes exportable when this applies.
-- Consent is an act; the absence of the act is a no, not an unknown.
alter table public.messages add column if not exists allow_save boolean not null default false;

-- `allow_save` is NOT `saved_by`. Saving pins a message against the ephemeral
-- purge (purge_expired and the 3-visit clear both require `saved_by = '{}'`);
-- consenting to an export changes nothing about how long the message lives.
-- Keep them apart — conflating them would let a permission grant quietly turn
-- a disappearing snap into a permanent one.

-- Grants gate writes before RLS: an un-granted column fails 42501 before a
-- policy is consulted. The sender writes this once, at INSERT, when they are by
-- definition the sender — so INSERT is granted and UPDATE deliberately is not.
grant insert (allow_save), select (allow_save) on public.messages to authenticated;

-- The RPC is a door; the grant is the wall. 202609090022 hardened toggle_saved()
-- and left `update (saved_by)` granted, so the client path closed and a direct
-- PATCH still worked — that took another migration to find. A new column added
-- after the baseline's table-wide revoke inherits no UPDATE privilege, so this
-- revoke changes nothing today. It is here so that the wall is stated next to
-- the door, and so a later `grant update on public.messages` that subsumed it
-- would be visibly contradicting this line.
revoke update (allow_save) on public.messages from authenticated, anon, public;

-- ---------------------------------------------------------------------------
-- Audit log. Operator-only, like ops_metrics and bot_quotes: RLS on, no policy,
-- grants revoked. No client reads it.
--
-- THE TRADEOFF, stated plainly. "Anonymized" and "useful" pull against each
-- other, and a log that identifies nobody answers nothing. What is anonymized
-- here is the CONTENT: never a body, a caption, a media_path or a signed URL —
-- the log knows that a permission changed, never what it was a permission for.
-- The actor and the message are stored in the clear, because the only question
-- this log exists to answer is "did the sender actually consent to this one?",
-- and a hashed actor cannot answer it. Hashing would also protect nothing: the
-- message row it points at already names both parties, and only an operator can
-- read either.
--
-- Rows die with the message (ON DELETE CASCADE). Keeping them afterwards would
-- mean a permanent record that user X sent a snap at time T, surviving in an app
-- whose entire promise is that the snap does not. The log lives exactly as long
-- as the thing it describes, which is also the only window a dispute about it
-- can fall in.
-- ---------------------------------------------------------------------------
create table if not exists public.save_consent_log (
  id          bigint generated always as identity primary key,
  message_id  uuid not null references public.messages(id) on delete cascade,
  actor_id    uuid not null references public.profiles(id) on delete cascade,
  was_allowed boolean not null,
  now_allowed boolean not null,
  at          timestamptz not null default now()
);
create index if not exists save_consent_log_message_idx on public.save_consent_log (message_id);

alter table public.save_consent_log enable row level security;
-- Deliberately NO policy: with RLS on and no policy, every non-bypassing role
-- reads and writes nothing. The rows are written by a SECURITY DEFINER function
-- and read from the SQL editor.
revoke all on public.save_consent_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The only writer. Sender-only, snap-only, and it records the transition.
-- ---------------------------------------------------------------------------
create or replace function public.set_snap_save_consent(msg uuid, allow boolean)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare m public.messages; before boolean;
begin
  if allow is null then raise exception 'Save permission must be true or false'; end if;
  select * into m from public.messages where id = msg for update;
  -- One message for every refusal: a sender-only control that says *why* it
  -- refused is a control that tells a recipient which message ids exist.
  if not found or auth.uid() is null or auth.uid() <> m.sender_id then
    raise exception 'Message unavailable';
  end if;
  if m.kind <> 'snap' then
    raise exception 'Only a snap carries a save permission';
  end if;
  -- A block must never strand someone inside a permission they granted before
  -- it. Revoking always works; granting into a blocked pair does not.
  if allow and public.blocked_between(m.user_a, m.user_b) then
    raise exception 'Message unavailable';
  end if;
  before := m.allow_save;
  if before is distinct from allow then
    update public.messages set allow_save = allow where id = msg;
    -- Only transitions are logged. Re-tapping the same answer is not an event,
    -- and logging it would bury the ones that are.
    insert into public.save_consent_log(message_id, actor_id, was_allowed, now_allowed)
    values (msg, auth.uid(), before, allow);
  end if;
  return allow;
end $fn$;
revoke all on function public.set_snap_save_consent(uuid, boolean) from public, anon;
grant execute on function public.set_snap_save_consent(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Per-contact defaults, so nobody has to answer the same question every snap.
--
-- Pair-keyed like every other pair table (`user_a < user_b`, via pair_key), but
-- the two halves are SEPARATE and each user owns exactly one of them. That shape
-- is the whole point: a single shared per-pair flag is a flag the RECIPIENT can
-- set, which is the self-granted-consent bug this migration exists to remove,
-- rebuilt one level up. `a_allows` means "user_a lets user_b save user_a's
-- snaps". Neither column is writable by the other person at any level — there is
-- no UPDATE grant on this table at all, and the RPC below picks the column from
-- auth.uid() rather than from an argument.
--
-- MUTUAL: the default only takes effect when BOTH halves are true, the same
-- rule the Together layer uses (`together_status()`), and for the same reason —
-- a standing permission to keep someone's disappearing photos is a thing both
-- people should have agreed to, not something one of them is told about.
-- ---------------------------------------------------------------------------
create table if not exists public.snap_save_prefs (
  user_a     uuid not null references public.profiles(id) on delete cascade,
  user_b     uuid not null references public.profiles(id) on delete cascade,
  a_allows   boolean not null default false,
  b_allows   boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint ordered_pair_snap_save_prefs check (user_a < user_b)
);

alter table public.snap_save_prefs enable row level security;
drop policy if exists snap_save_prefs_read on public.snap_save_prefs;
create policy snap_save_prefs_read on public.snap_save_prefs
  for select to authenticated
  using (auth.uid() in (user_a, user_b));
-- SELECT only, and no write policy to go with it. Writes have no grant either,
-- so the RPC is the only way in: a write policy plus a grant would be a second
-- door into the same room, and `for all` would have been a third (see the
-- `locations_write` hole). Read is shared because both people are entitled to
-- know what the pair has agreed; write is what the ownership rule gates.
revoke all on public.snap_save_prefs from anon, authenticated;
grant select on public.snap_save_prefs to authenticated;

-- Sets the CALLER's own half. `allow` is the only thing the caller supplies;
-- which column it lands in is derived, never passed.
create or replace function public.set_snap_save_default(other uuid, allow boolean)
returns public.snap_save_prefs language plpgsql security definer set search_path = public as $fn$
declare pair uuid[]; row_out public.snap_save_prefs;
begin
  if allow is null then raise exception 'Save permission must be true or false'; end if;
  if auth.uid() is null or other is null or other = auth.uid() then
    raise exception 'Friend unavailable';
  end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted'
       and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), other)
  ) then
    raise exception 'Friend unavailable';
  end if;
  -- As with a single snap: revoking always works, granting into a block does not.
  if allow and public.blocked_between(auth.uid(), other) then
    raise exception 'Friend unavailable';
  end if;
  pair := public.pair_key(auth.uid(), other);
  insert into public.snap_save_prefs as p (user_a, user_b, a_allows, b_allows)
  values (pair[1], pair[2], auth.uid() = pair[1] and allow, auth.uid() = pair[2] and allow)
  on conflict (user_a, user_b) do update
    set a_allows = case when auth.uid() = p.user_a then allow else p.a_allows end,
        b_allows = case when auth.uid() = p.user_b then allow else p.b_allows end,
        updated_at = now()
  returning * into row_out;
  return row_out;
end $fn$;
revoke all on function public.set_snap_save_default(uuid, boolean) from public, anon;
grant execute on function public.set_snap_save_default(uuid, boolean) to authenticated;

-- A standing permission must not outlive the relationship it was given inside.
-- `removeFriend` and `block_user()` both DELETE the friendships row (the block
-- has to: stories, presence, calls and push all gate on one), and without this
-- the pair's default would sit there and quietly come back into force the day
-- they added each other again — consent granted to a friend, applied to a
-- stranger. Deleting the row and making them decide again is the honest
-- default; per-message `allow_save` is untouched, because those snaps were
-- already sent under a permission that was real at the time.
create or replace function public.drop_snap_save_prefs_on_unfriend()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  delete from public.snap_save_prefs
   where user_a = old.user_a and user_b = old.user_b;
  return old;
end $fn$;
drop trigger if exists on_friendship_deleted_snap_prefs on public.friendships;
create trigger on_friendship_deleted_snap_prefs after delete on public.friendships
  for each row execute function public.drop_snap_save_prefs_on_unfriend();

-- No `v_effective_snap_consent` view. It was considered and is not here: the
-- answer a viewer needs is already a column on the row it is rendering
-- (`messages.allow_save`), so a view would add a second definition of the same
-- fact and a second thing to keep in step. A view also defaults to the OWNER's
-- privileges and would have silently bypassed the RLS that is the real boundary
-- here unless created `with (security_invoker = true)` — a trap this feature has
-- no reason to walk into. The pair default SEEDS `messages.allow_save` at send
-- and is never consulted again; the row is the authority. That is also what
-- stops a default switched on next week from retroactively unlocking snaps sent
-- last week.

-- ---------------------------------------------------------------------------
-- Defence in depth, below the grant. `guard_message_update` is redefined across
-- migrations under last-applied-wins, so this restates the whole live version
-- (202609060000's third definition) and adds one clause. Dropping a clause here
-- would silently un-freeze a column.
--
-- Why a trigger as well as a missing grant: the grant is what stops the write
-- today, but grants have been re-widened by later migrations twice in this
-- repo. This clause holds even if one is.
-- ---------------------------------------------------------------------------
create or replace function public.guard_message_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.opened_at     is not null and new.opened_at     is distinct from old.opened_at     then raise exception 'opened_at is immutable'; end if;
  if old.screenshot_at is not null and new.screenshot_at is distinct from old.screenshot_at then raise exception 'screenshot_at is immutable'; end if;
  if old.replayed_at   is not null and new.replayed_at   is distinct from old.replayed_at   then raise exception 'replayed_at is immutable'; end if;
  if old.unsent_at is not null and new.unsent_at is distinct from old.unsent_at then raise exception 'message already unsent'; end if;
  if new.unsent_at is not null and old.unsent_at is null and old.sender_id <> auth.uid() then raise exception 'only the sender may unsend'; end if;
  if new.open_count <> old.open_count then
    if new.open_count < old.open_count then raise exception 'open_count cannot decrease'; end if;
    if auth.uid() = old.sender_id then raise exception 'sender cannot open own snap'; end if;
  end if;
  if new.saved_by is distinct from old.saved_by then
    if (select coalesce(array_agg(x order by x),'{}') from unnest(new.saved_by) x where x <> auth.uid())
       is distinct from (select coalesce(array_agg(x order by x),'{}') from unnest(old.saved_by) x where x <> auth.uid())
    then raise exception 'may only save/unsave for yourself'; end if;
  end if;
  if new.cleared_by is distinct from old.cleared_by then
    if (select coalesce(array_agg(x order by x),'{}') from unnest(new.cleared_by) x where x <> auth.uid())
       is distinct from (select coalesce(array_agg(x order by x),'{}') from unnest(old.cleared_by) x where x <> auth.uid())
    then raise exception 'may only clear for yourself'; end if;
  end if;
  -- Only the sender decides whether their own snap may leave the app.
  if new.allow_save is distinct from old.allow_save and auth.uid() is distinct from old.sender_id then
    raise exception 'only the sender may change the save permission';
  end if;
  return new;
end $$;
drop trigger if exists on_message_update on public.messages;
create trigger on_message_update before update on public.messages
  for each row execute function public.guard_message_update();

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609140033_snap_save_consent') on conflict (id) do nothing;
