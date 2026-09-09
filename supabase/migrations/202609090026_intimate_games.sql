-- ---------------------------------------------------------------------------
-- Intimate games — five turn-based games for two consenting partners.
--
-- Five games, ONE pair of tables. Every one of them is "somebody poses, the
-- other responds, then it swaps", so modelling them separately would be five
-- copies of the same turn bug waiting to happen. The shape is:
--
--   truth_or_dare     prompt = a truth, option_b = a dare; the receiver PICKS
--   would_you_rather  prompt = scenario A, option_b = scenario B; picks + says why
--   true_or_made_up   prompt = a statement, secret_truth = whether it is real
--   guess_what        media_path = a close-up, OR prompt = the same thing in
--                     words; answer_key = what it actually is
--   fantasy_builder   prompt = the next line; closes on write, no response
--
-- The game ids are STABLE STRINGS and a live session row references one. They
-- are never display strings — renaming what a game is called on screen must
-- not orphan a session that is mid-play. src/lib/relationshipGames.js holds the
-- same ids and is the one place display names live.
--
-- THE TURN RULE IS ONE EXPRESSION and everything depends on it:
--
--     turn = the person who did NOT pose the most recent round
--
-- It is correct in both phases without a special case. While a round is open,
-- "not the poser" is the responder, who owes an answer. Once it is closed, "not
-- the poser" is whoever goes next. A pass — by either side — closes the round
-- the same way an answer does, so passing can never strand a turn. The client
-- mirrors this in src/lib/relationshipGames.js; if the two ever disagree the
-- screen will offer a move the database refuses.
--
-- CONSENT IS A STATE MACHINE IN THE SCHEMA, not a boolean and not only in the
-- UI:
--
--     invited ──join──> both_accepted ──first pose──> active
--        │                    │                          │
--        └────────────────────┴──────────end─────────────┴──> ended
--
--   * Nothing can be posed or answered before both_accepted
--     (`intimate_sessions_consent`, plus every writer's status check).
--   * `ended_reason` keeps "she never accepted" (declined) distinguishable
--     from "she accepted and then stopped" (left) and from a room that simply
--     ran out (expired). A single ended flag would flatten three different
--     things into one, and only one of them is about how the evening went.
--   * Either party may end it at any moment, from any state, and ending is
--     idempotent so a double-tap or a retry cannot fail.
--   * pass_intimate_turn() takes NO reason and writes no counter. There is
--     deliberately nowhere to record why someone passed and nothing that
--     accumulates when they do. A dare game whose "no" costs something is a
--     dare game that coerces.
--
-- CAMERA-OFF IS A MODE, NOT A REFUSAL. guess_what accepts a written clue in
-- place of a photo, and the shipped dares that imply a camera carry a
-- `camera_free` equivalent in the same row. A game that only works with a
-- camera is a game that pressures someone into using one.
--
-- EPHEMERALITY. A Guess What photo is single-view by construction rather than
-- by client politeness: intimate_rounds_of() NEVER returns media_path, so the
-- only route to the bytes is open_intimate_photo(), which stamps the row and
-- accelerates the existing media_cleanup queue. Two minutes later the storage
-- policy stops minting URLs for it and the cleanup worker deletes the object.
-- There is no replay path and no route into memories.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table if not exists public.intimate_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_a        uuid not null references auth.users(id) on delete cascade,
  user_b        uuid not null references auth.users(id) on delete cascade,
  game          text not null check (game in ('truth_or_dare','guess_what','true_or_made_up','would_you_rather','fantasy_builder')),
  opened_by     uuid not null references auth.users(id) on delete cascade,
  joined_by     uuid references auth.users(id) on delete cascade,
  status        text not null default 'invited' check (status in ('invited','both_accepted','active','ended')),
  ended_by      uuid references auth.users(id) on delete cascade,
  ended_reason  text check (ended_reason is null or ended_reason in ('declined','left','expired')),
  created_at    timestamptz not null default now(),
  joined_at     timestamptz,
  ended_at      timestamptz,
  -- Same 24h window as game_invites. Nothing here is meant to still be sitting
  -- in the database tomorrow.
  expires_at    timestamptz not null default now() + interval '24 hours',
  constraint intimate_sessions_ordered check (user_a < user_b),
  constraint intimate_sessions_opener_in_pair check (opened_by in (user_a, user_b)),
  constraint intimate_sessions_joiner check (joined_by is null or (joined_by in (user_a, user_b) and joined_by <> opened_by)),
  constraint intimate_sessions_ender check (ended_by is null or ended_by in (user_a, user_b)),
  -- The consent gate, stated as a constraint so no future writer can skip it.
  constraint intimate_sessions_consent check (status not in ('both_accepted','active') or joined_by is not null),
  constraint intimate_sessions_ended check ((status = 'ended') = (ended_at is not null))
);

-- One live room per pair. Two half-finished games between the same two people
-- is not a feature, it is a way to answer the wrong prompt.
create unique index if not exists intimate_sessions_one_live
  on public.intimate_sessions (user_a, user_b) where ended_at is null;

alter table public.intimate_sessions enable row level security;

-- Readable by the two people in it, and only while it is live — an expired
-- session is invisible the moment it expires rather than when a purge runs
-- (the same reason status_notes puts expires_at in its read policy).
drop policy if exists intimate_sessions_read on public.intimate_sessions;
create policy intimate_sessions_read on public.intimate_sessions for select to authenticated
  using (
    auth.uid() in (user_a, user_b)
    and expires_at > now()
    and exists (
      select 1 from public.friendships f
       where f.status = 'accepted'
         and array[f.user_a, f.user_b] = public.pair_key(user_a, user_b)
    )
  );

-- Grants gate writes before RLS, so the absence of insert/update/delete grants
-- is what actually forces every mutation through the RPCs below.
revoke all on public.intimate_sessions from public, anon, authenticated;
grant select on public.intimate_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- rounds
-- ---------------------------------------------------------------------------
create table if not exists public.intimate_rounds (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.intimate_sessions(id) on delete cascade,
  seq             int not null,
  poser           uuid not null references auth.users(id) on delete cascade,
  prompt          text,
  option_b        text,
  media_path      text,
  -- The two columns the responder must not see early. They are why this whole
  -- table is unreadable from the client (see the revoke below): a reveal rule
  -- cannot be expressed as a row policy, because it hides COLUMNS of a row you
  -- are otherwise entitled to.
  answer_key      text,
  secret_truth    boolean,
  pick            text check (pick is null or pick in ('truth','dare','a','b','real','made_up')),
  response        text,
  status          text not null default 'open' check (status in ('open','answered','passed')),
  passed_by       uuid references auth.users(id) on delete cascade,
  photo_opened_at timestamptz,
  created_at      timestamptz not null default now(),
  responded_at    timestamptz,
  constraint intimate_rounds_seq unique (session_id, seq),
  constraint intimate_rounds_prompt_len   check (prompt     is null or length(btrim(prompt))     between 1 and 400),
  constraint intimate_rounds_option_len   check (option_b   is null or length(btrim(option_b))   between 1 and 400),
  constraint intimate_rounds_key_len      check (answer_key is null or length(btrim(answer_key)) between 1 and 120),
  constraint intimate_rounds_response_len check (response   is null or length(btrim(response))   between 1 and 600),
  constraint intimate_rounds_media_len    check (media_path is null or length(media_path) between 1 and 300),
  constraint intimate_rounds_passed check (status <> 'passed' or passed_by is not null)
);

create index if not exists intimate_rounds_session_idx on public.intimate_rounds (session_id, seq);
-- The storage policy below matches on this column on every signed-URL mint.
create index if not exists intimate_rounds_media_idx on public.intimate_rounds (media_path);

-- RLS on with NO policy and no grants — locked exactly like prompts and
-- bot_quotes. Reads go through intimate_rounds_of(), which is the only place
-- the reveal rule lives.
alter table public.intimate_rounds enable row level security;
revoke all on public.intimate_rounds from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- starter prompts
--
-- Locked the same way, and for the same reason bot_quotes is: an unlocked
-- prompt table is a way for any signed-in account to put words into another
-- couple's game. Read only through intimate_prompt_ideas().
--
-- These are STARTERS, not the feature. The custom path is primary everywhere in
-- the client; a shipped list cannot know a particular couple or where their
-- line is. So the set is small and stays suggestive rather than explicit — it
-- sets a scene and hands the couple the pen.
--
-- `camera_free` is the text-only equivalent of a starter that assumes a camera,
-- offered as a second way to play rather than as a fallback. Every row whose
-- body or option_b implies a photo, video or voice note MUST carry one; the
-- catalogue test in tests/intimate.test.js enforces the same rule client-side.
-- ---------------------------------------------------------------------------
create table if not exists public.intimate_prompts (
  id          int generated always as identity primary key,
  game        text not null check (game in ('truth_or_dare','guess_what','true_or_made_up','would_you_rather','fantasy_builder')),
  body        text not null,
  option_b    text,
  camera_free text,
  constraint intimate_prompts_body_len   check (length(btrim(body)) between 1 and 400),
  constraint intimate_prompts_option_len check (option_b    is null or length(btrim(option_b))    between 1 and 400),
  constraint intimate_prompts_free_len   check (camera_free is null or length(btrim(camera_free)) between 1 and 400),
  constraint intimate_prompts_unique unique (game, body)
);
alter table public.intimate_prompts enable row level security;
revoke all on public.intimate_prompts from public, anon, authenticated;

insert into public.intimate_prompts (game, body, option_b, camera_free) values
  -- truth_or_dare: body is the truth, option_b is the dare, camera_free is the
  -- same dare with nothing to point a lens at.
  ('truth_or_dare', 'What was the first thing you noticed about me?',
     'Send a voice note saying the thing you were too shy to say today.',
     'Write out the thing you were too shy to say today, exactly as you would say it.'),
  ('truth_or_dare', 'When did you last think about me and not tell me?',
     'Describe my hands as if you were writing about them.', null),
  ('truth_or_dare', 'What do I do that you find hardest to resist?',
     'Send a photo of where you are right now, no tidying up first.',
     'Describe where you are right now in three lines, no tidying up first.'),
  ('truth_or_dare', 'What is something you want more of from me?',
     'Pick a time tonight and tell me to be free.', null),
  ('truth_or_dare', 'What compliment have you been saving up?',
     'Say the last thought you had about me, unedited.', null),
  ('truth_or_dare', 'Where is the boldest place you have wanted to kiss me?',
     'Write me one line you would want me to read at work.', null),
  -- guess_what: a suggestion for what to photograph, close up — or, with the
  -- camera off, to describe in a handful of words.
  ('guess_what', 'A close-up of something you are wearing right now.', null,
     'Describe something you are wearing right now in five words.'),
  ('guess_what', 'Something in this room that reminds you of me.', null,
     'Describe something in this room that reminds you of me, without naming it.'),
  ('guess_what', 'The smallest detail of where you are, cropped tight.', null,
     'Describe the smallest detail of where you are, and nothing around it.'),
  ('guess_what', 'Something on your bedside table.', null,
     'Describe one thing on your bedside table as if it were a riddle.'),
  ('guess_what', 'A part of your day you never show anyone.', null,
     'Describe a part of your day you never talk about.'),
  ('guess_what', 'Something you would want me to reach for.', null,
     'Describe something you would want me to reach for, without naming it.'),
  -- true_or_made_up: a statement. The writer marks whether it is real.
  ('true_or_made_up', 'I have imagined an evening exactly like this one before.', null, null),
  ('true_or_made_up', 'There is a song I cannot hear without thinking of you.', null, null),
  ('true_or_made_up', 'I nearly sent you something last week and deleted it.', null, null),
  ('true_or_made_up', 'I have kept something of yours on purpose.', null, null),
  ('true_or_made_up', 'I rehearsed the first thing I ever said to you.', null, null),
  ('true_or_made_up', 'I have had a dream about you I never told you about.', null, null),
  -- would_you_rather: two scenarios, and you say why.
  ('would_you_rather', 'A whole day in bed with nothing planned', 'A night out where I cannot take my eyes off you', null),
  ('would_you_rather', 'Slow, and drawn out', 'Impatient, and all at once', null),
  ('would_you_rather', 'Being told exactly what I want', 'Being surprised by it', null),
  ('would_you_rather', 'A weekend away with our phones off', 'A quiet week at home with the door locked', null),
  ('would_you_rather', 'Me whispering it', 'Me writing it down for you', null),
  ('would_you_rather', 'Dancing in the kitchen', 'Reading in the same bed', null),
  -- fantasy_builder: an opening line for the two of you to continue.
  ('fantasy_builder', 'It is raining, and neither of us wants to leave.', null, null),
  ('fantasy_builder', 'We have the whole place to ourselves for one night.', null, null),
  ('fantasy_builder', 'You meet me somewhere I have never been.', null, null),
  ('fantasy_builder', 'The power goes out and we stop pretending to be busy.', null, null),
  ('fantasy_builder', 'A late train, a hotel room, and no plans at all.', null, null),
  ('fantasy_builder', 'You send me one line and I drop everything.', null, null)
on conflict (game, body) do nothing;

create or replace function public.intimate_prompt_ideas(game_code text, wanted int default 3)
returns table (body text, option_b text, camera_free text)
language sql stable security definer set search_path = public as $fn$
  select p.body, p.option_b, p.camera_free
    from public.intimate_prompts p
   where auth.uid() is not null and p.game = game_code
   order by random()
   limit greatest(1, least(coalesce(wanted, 3), 10));
$fn$;
revoke all on function public.intimate_prompt_ideas(text, int) from public, anon;
grant execute on function public.intimate_prompt_ideas(text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- turn logic
-- ---------------------------------------------------------------------------
-- Whose move it is. Mirrored by turnHolder() in src/lib/relationshipGames.js.
create or replace function public.intimate_turn(sess uuid)
returns uuid
language sql stable security definer set search_path = public as $fn$
  select coalesce(
    (select case when r.poser = s.user_a then s.user_b else s.user_a end
       from public.intimate_rounds r
      where r.session_id = s.id
      order by r.seq desc
      limit 1),
    -- Nobody has moved: whoever opened the room picked the game, so they start.
    s.opened_by)
    from public.intimate_sessions s
   where s.id = sess
    -- Every other function on this surface builds the pair from auth.uid();
    -- this one took the session id on trust and handed a stranger back a
    -- participant's user id. The id is a v4 uuid that never leaves the pair, so
    -- there is nothing to enumerate — but an oracle on a table whose entire
    -- design is invisibility should not exist at all.
    and auth.uid() in (s.user_a, s.user_b);
$fn$;
revoke all on function public.intimate_turn(uuid) from public, anon;
grant execute on function public.intimate_turn(uuid) to authenticated;

-- The room, locked for update. Every writer goes through this so two devices
-- posing at the same instant serialise instead of both winning.
create or replace function public.intimate_room(sess uuid, require_consent boolean default true)
returns public.intimate_sessions
language plpgsql volatile security definer set search_path = public as $fn$
declare s public.intimate_sessions;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  select * into s from public.intimate_sessions where id = sess for update;
  if not found or auth.uid() not in (s.user_a, s.user_b) then
    raise exception 'That game is not open to you';
  end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted' and array[f.user_a, f.user_b] = public.pair_key(s.user_a, s.user_b)
  ) then
    raise exception 'That game is not open to you';
  end if;
  if require_consent then
    if s.ended_at is not null then raise exception 'This session has ended'; end if;
    if s.expires_at <= now() then raise exception 'This session has expired'; end if;
    if s.status not in ('both_accepted','active') then
      raise exception 'Both of you have to join before this starts';
    end if;
  end if;
  return s;
end $fn$;
revoke all on function public.intimate_room(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- the consent state machine: invited -> both_accepted -> active -> ended
-- ---------------------------------------------------------------------------
create or replace function public.start_intimate_session(other uuid, game_code text)
returns public.intimate_sessions
language plpgsql volatile security definer set search_path = public as $fn$
declare pk uuid[]; s public.intimate_sessions;
begin
  if auth.uid() is null or other is null or other = auth.uid() then
    raise exception 'not allowed';
  end if;
  if game_code is null or game_code not in ('truth_or_dare','guess_what','true_or_made_up','would_you_rather','fantasy_builder') then
    raise exception 'Unknown game';
  end if;
  if not exists (
    select 1 from public.friendships f
     where f.status = 'accepted' and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), other)
  ) then
    raise exception 'not allowed';
  end if;

  pk := public.pair_key(auth.uid(), other);

  -- Sessions expire on their own; closing the pair's expired ones here means a
  -- database with no scheduled purge still never blocks a new game.
  update public.intimate_sessions
     set ended_at = now(), status = 'ended', ended_reason = coalesce(ended_reason, 'expired')
   where user_a = pk[1] and user_b = pk[2] and ended_at is null and expires_at <= now();

  -- A live room already exists: hand it back rather than opening a second one.
  -- This is what makes "start" idempotent under a double tap, and it is also
  -- how the person who was invited lands on the room they need to join.
  select * into s from public.intimate_sessions
   where user_a = pk[1] and user_b = pk[2] and ended_at is null;
  if found then return s; end if;

  insert into public.intimate_sessions (user_a, user_b, game, opened_by, status)
  values (pk[1], pk[2], game_code, auth.uid(), 'invited')
  returning * into s;
  return s;
end $fn$;
revoke all on function public.start_intimate_session(uuid, text) from public, anon;
grant execute on function public.start_intimate_session(uuid, text) to authenticated;

-- The second opt-in. Only the person who did NOT open it can give it, which is
-- what makes "both partners opted in" true rather than merely displayed.
create or replace function public.join_intimate_session(sess uuid)
returns public.intimate_sessions
language plpgsql volatile security definer set search_path = public as $fn$
declare s public.intimate_sessions;
begin
  s := public.intimate_room(sess, false);
  if s.ended_at is not null then raise exception 'This session has ended'; end if;
  if s.expires_at <= now() then raise exception 'This session has expired'; end if;
  if auth.uid() = s.opened_by then raise exception 'You opened this one — it is waiting on them'; end if;
  if s.status in ('both_accepted','active') then return s; end if;
  update public.intimate_sessions
     set joined_by = auth.uid(), joined_at = now(), status = 'both_accepted'
   where id = sess
  returning * into s;
  return s;
end $fn$;
revoke all on function public.join_intimate_session(uuid) from public, anon;
grant execute on function public.join_intimate_session(uuid) to authenticated;

-- Either person, at any point, from any state. Idempotent on purpose: an exit
-- that can fail is an exit you cannot rely on.
--
-- The reason is DERIVED, never passed in: an invitation the other person closed
-- without joining is 'declined', anything after that is 'left'. Letting the
-- client name it would make the distinction a claim rather than a fact.
create or replace function public.end_intimate_session(sess uuid)
returns public.intimate_sessions
language plpgsql volatile security definer set search_path = public as $fn$
declare s public.intimate_sessions; why text;
begin
  s := public.intimate_room(sess, false);
  if s.ended_at is not null then return s; end if;
  why := case when s.status = 'invited' and auth.uid() <> s.opened_by then 'declined' else 'left' end;
  -- Queue every photo still sitting in this room for immediate deletion; a
  -- session that is over must not leave bytes behind waiting on a timer.
  update public.media_cleanup c
     set due_at = now()
    from public.intimate_rounds r
   where r.session_id = sess and r.media_path is not null
     and c.path = r.media_path and not c.deleting;
  update public.intimate_sessions
     set ended_at = now(), ended_by = auth.uid(), ended_reason = why, status = 'ended'
   where id = sess
  returning * into s;
  return s;
end $fn$;
revoke all on function public.end_intimate_session(uuid) from public, anon;
grant execute on function public.end_intimate_session(uuid) to authenticated;

-- The live room for one pair, if there is one, plus whose turn it is.
create or replace function public.intimate_session_with(other uuid)
returns table (
  id uuid, user_a uuid, user_b uuid, game text, opened_by uuid, joined_by uuid,
  status text, ended_by uuid, ended_reason text, created_at timestamptz,
  joined_at timestamptz, expires_at timestamptz, turn uuid
)
language sql stable security definer set search_path = public as $fn$
  select s.id, s.user_a, s.user_b, s.game, s.opened_by, s.joined_by,
         s.status, s.ended_by, s.ended_reason, s.created_at, s.joined_at,
         s.expires_at, public.intimate_turn(s.id)
    from public.intimate_sessions s
   where auth.uid() is not null
     and array[s.user_a, s.user_b] = public.pair_key(auth.uid(), other)
     and s.ended_at is null and s.expires_at > now()
   order by s.created_at desc
   limit 1;
$fn$;
revoke all on function public.intimate_session_with(uuid) from public, anon;
grant execute on function public.intimate_session_with(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- reading rounds — the reveal rule
-- ---------------------------------------------------------------------------
-- answer_key and secret_truth come back only to the person who wrote them, or
-- to anyone once the round is closed. media_path NEVER comes back: the only
-- route to a photo is open_intimate_photo(), once.
create or replace function public.intimate_rounds_of(sess uuid)
returns table (
  id uuid, seq int, poser uuid, prompt text, option_b text,
  has_photo boolean, photo_opened_at timestamptz,
  answer_key text, secret_truth boolean,
  pick text, response text, status text, passed_by uuid,
  created_at timestamptz, responded_at timestamptz
)
language sql stable security definer set search_path = public as $fn$
  select r.id, r.seq, r.poser, r.prompt, r.option_b,
         r.media_path is not null, r.photo_opened_at,
         case when auth.uid() = r.poser or r.status <> 'open' then r.answer_key end,
         case when auth.uid() = r.poser or r.status <> 'open' then r.secret_truth end,
         r.pick, r.response, r.status, r.passed_by,
         r.created_at, r.responded_at
    from public.intimate_rounds r
    join public.intimate_sessions s on s.id = r.session_id
   where s.id = sess
     and auth.uid() is not null and auth.uid() in (s.user_a, s.user_b)
     and s.ended_at is null and s.expires_at > now()
   order by r.seq;
$fn$;
revoke all on function public.intimate_rounds_of(uuid) from public, anon;
grant execute on function public.intimate_rounds_of(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- posing, responding, passing
-- ---------------------------------------------------------------------------
create or replace function public.pose_intimate_round(
  sess uuid, prompt text default null, option_b text default null,
  media_path text default null, answer_key text default null, secret_truth boolean default null)
returns uuid
language plpgsql volatile security definer set search_path = public as $fn$
declare s public.intimate_sessions; next_seq int; new_id uuid; deleting_now boolean;
begin
  s := public.intimate_room(sess);
  if public.intimate_turn(sess) <> auth.uid() then raise exception 'It is not your turn'; end if;
  if exists (select 1 from public.intimate_rounds r where r.session_id = sess and r.status = 'open') then
    raise exception 'There is still a round waiting on an answer';
  end if;

  prompt     := nullif(btrim(coalesce(prompt, '')), '');
  option_b   := nullif(btrim(coalesce(option_b, '')), '');
  answer_key := nullif(btrim(coalesce(answer_key, '')), '');

  if s.game in ('truth_or_dare','would_you_rather') then
    if prompt is null or option_b is null then raise exception 'Both options are needed'; end if;
    media_path := null; answer_key := null; secret_truth := null;
  elsif s.game = 'true_or_made_up' then
    if prompt is null then raise exception 'Write a statement first'; end if;
    if secret_truth is null then raise exception 'Mark whether it is real'; end if;
    media_path := null; option_b := null; answer_key := null;
  elsif s.game = 'fantasy_builder' then
    if prompt is null then raise exception 'Write the next line first'; end if;
    media_path := null; option_b := null; answer_key := null; secret_truth := null;
  elsif s.game = 'guess_what' then
    -- A photo OR a written clue. The camera-off route is a first-class way to
    -- play this game, not a degraded one, so the database accepts either.
    if media_path is null and prompt is null then
      raise exception 'Add a photo, or describe it in words';
    end if;
    if answer_key is null then raise exception 'Say what it is, so they can be told after they guess'; end if;
    option_b := null; secret_truth := null;
  end if;

  -- Media ownership, checked the way guard_media_reference checks it for
  -- messages: the path must sit under the sender's own uid prefix, the object
  -- must actually exist, and it must not already be on its way out.
  if media_path is not null then
    -- The SHAPE too, not just the owner. Without it a round can name the caller's
  -- own memories/ or stories/ object and drag a durable file onto this
  -- surface's two-minute accelerated expiry.
  if media_path !~ '^[0-9a-f-]+/intimate/[0-9a-zA-Z_.-]+$'
     or split_part(media_path, '/', 1) is distinct from auth.uid()::text then
      raise exception 'Media must belong to the sender';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = media_path) then
      raise exception 'Media file is unavailable';
    end if;
    select c.deleting into deleting_now from public.media_cleanup c where c.path = media_path for update;
    if deleting_now then raise exception 'Media upload expired; please upload again'; end if;
  end if;

  select coalesce(max(r.seq), 0) + 1 into next_seq from public.intimate_rounds r where r.session_id = sess;

  insert into public.intimate_rounds (
    session_id, seq, poser, prompt, option_b, media_path, answer_key, secret_truth, status, responded_at)
  values (
    sess, next_seq, auth.uid(), prompt, option_b, media_path, answer_key, secret_truth,
    -- Fantasy Builder has no responder: a line is complete when it is written,
    -- and the turn swaps straight away under the same rule.
    case when s.game = 'fantasy_builder' then 'answered' else 'open' end,
    case when s.game = 'fantasy_builder' then now() end)
  returning id into new_id;

  -- First move: both_accepted -> active.
  if s.status = 'both_accepted' then
    update public.intimate_sessions set status = 'active' where id = sess;
  end if;
  return new_id;
end $fn$;
revoke all on function public.pose_intimate_round(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.pose_intimate_round(uuid, text, text, text, text, boolean) to authenticated;

create or replace function public.respond_intimate_round(round_id uuid, pick text default null, response text default null)
returns uuid
language plpgsql volatile security definer set search_path = public as $fn$
declare r public.intimate_rounds; s public.intimate_sessions; new_pick text; new_response text;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  select * into r from public.intimate_rounds where id = round_id for update;
  if not found then raise exception 'That round is gone'; end if;
  s := public.intimate_room(r.session_id);
  if r.poser = auth.uid() then raise exception 'That one is theirs to answer'; end if;
  if r.status <> 'open' then raise exception 'That round is already finished'; end if;

  new_pick     := nullif(btrim(coalesce(pick, '')), '');
  new_response := nullif(btrim(coalesce(response, '')), '');

  if s.game = 'truth_or_dare' then
    if new_pick is null or new_pick not in ('truth','dare') then raise exception 'Pick truth or dare'; end if;
    if new_response is null then raise exception 'Say how it went'; end if;
  elsif s.game = 'would_you_rather' then
    if new_pick is null or new_pick not in ('a','b') then raise exception 'Pick one of the two'; end if;
    if new_response is null then raise exception 'Say why'; end if;
  elsif s.game = 'true_or_made_up' then
    if new_pick is null or new_pick not in ('real','made_up') then raise exception 'Guess real or made up'; end if;
  elsif s.game = 'guess_what' then
    if new_response is null then raise exception 'Write your guess'; end if;
    new_pick := null;
  else
    raise exception 'That round is already finished';
  end if;

  update public.intimate_rounds
     set pick = new_pick, response = new_response, status = 'answered', responded_at = now()
   where id = round_id;
  return round_id;
end $fn$;
revoke all on function public.respond_intimate_round(uuid, text, text) from public, anon;
grant execute on function public.respond_intimate_round(uuid, text, text) to authenticated;

-- Pass. Takes no reason, records no count, costs nothing, and works on every
-- turn of every game — whether you owe an answer or owe a prompt. Passing
-- closes the current round under the same rule an answer does, so the turn
-- moves on and nobody is left waiting on a "no".
create or replace function public.pass_intimate_turn(sess uuid)
returns uuid
language plpgsql volatile security definer set search_path = public as $fn$
declare s public.intimate_sessions; r public.intimate_rounds; next_seq int; new_id uuid;
begin
  s := public.intimate_room(sess);
  if public.intimate_turn(sess) <> auth.uid() then raise exception 'It is not your turn'; end if;

  select * into r from public.intimate_rounds
   where session_id = sess and status = 'open' order by seq desc limit 1 for update;

  if found then
    -- Passing on something you were asked.
    update public.intimate_rounds
       set status = 'passed', passed_by = auth.uid(), responded_at = now()
     where id = r.id;
    if s.status = 'both_accepted' then
      update public.intimate_sessions set status = 'active' where id = sess;
    end if;
    return r.id;
  end if;

  -- Passing on your turn to ask. Recorded as an empty round so the turn rule —
  -- "not whoever posed last" — carries it across without a special case.
  select coalesce(max(x.seq), 0) + 1 into next_seq from public.intimate_rounds x where x.session_id = sess;
  insert into public.intimate_rounds (session_id, seq, poser, status, passed_by, responded_at)
  values (sess, next_seq, auth.uid(), 'passed', auth.uid(), now())
  returning id into new_id;
  if s.status = 'both_accepted' then
    update public.intimate_sessions set status = 'active' where id = sess;
  end if;
  return new_id;
end $fn$;
revoke all on function public.pass_intimate_turn(uuid) from public, anon;
grant execute on function public.pass_intimate_turn(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- the single view
-- ---------------------------------------------------------------------------
-- The ONLY way to the bytes. Stamps the row on the first call and brings the
-- object's existing media_cleanup entry forward to two minutes from now, so
-- the file is destroyed right after it is seen rather than at the 24h default.
--
-- A repeat call inside those same two minutes returns the path again — that is
-- a dropped response or a rotated screen, not a second viewing, and losing the
-- photo to a flaky network would be a worse failure than the grace window.
-- After it, there is nothing to return and nothing left to return it from.
create or replace function public.open_intimate_photo(round_id uuid)
returns text
language plpgsql volatile security definer set search_path = public as $fn$
declare r public.intimate_rounds;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  select * into r from public.intimate_rounds where id = round_id for update;
  if not found then raise exception 'That round is gone'; end if;
  perform public.intimate_room(r.session_id);
  if r.media_path is null then raise exception 'There is no photo here'; end if;
  if r.poser = auth.uid() then raise exception 'This one opens once, for them'; end if;
  if r.photo_opened_at is not null and r.photo_opened_at <= now() - interval '2 minutes' then
    raise exception 'That photo has already been seen';
  end if;

  if r.photo_opened_at is null then
    update public.intimate_rounds set photo_opened_at = now() where id = round_id;
    update public.media_cleanup c set due_at = now() + interval '2 minutes'
     where c.path = r.media_path and not c.deleting;
  end if;
  return r.media_path;
end $fn$;
revoke all on function public.open_intimate_photo(uuid) from public, anon;
grant execute on function public.open_intimate_photo(uuid) to authenticated;

-- Signed-URL minting for a game photo.
--
-- This has to be a SECURITY DEFINER helper rather than an inline EXISTS in the
-- policy: intimate_rounds has RLS on and no policy, so a subquery evaluated as
-- the calling user sees nothing at all and the partner could never load the
-- image. Same reason has_answered() is a definer function for prompt_answers.
create or replace function public.intimate_media_readable(object_name text)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1
      from public.intimate_rounds r
      join public.intimate_sessions s on s.id = r.session_id
     where r.media_path = object_name
       and auth.uid() is not null and auth.uid() in (s.user_a, s.user_b)
       and s.ended_at is null and s.expires_at > now()
       and (r.photo_opened_at is null or r.photo_opened_at > now() - interval '2 minutes')
  );
$fn$;
revoke all on function public.intimate_media_readable(text) from public, anon;
grant execute on function public.intimate_media_readable(text) to authenticated;

-- ADDITIVE. media_read is deliberately left alone — permissive policies for the
-- same command are OR'd, so a second policy adds this case without this
-- migration having to restate (and risk dropping) the messages/stories rules.
drop policy if exists media_read_intimate on storage.objects;
create policy media_read_intimate on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.intimate_media_readable(name));

-- ---------------------------------------------------------------------------
-- purge
-- ---------------------------------------------------------------------------
-- For the scheduled cleanup worker. Not required for correctness — the read
-- policy hides an expired session immediately, start_intimate_session() closes
-- the pair's expired rooms, and an abandoned photo dies at media_cleanup's own
-- 24h default because nothing in claim_media_cleanup()'s reference check knows
-- about these tables. This just stops the rows accumulating.
create or replace function public.purge_intimate_sessions()
returns void
language plpgsql volatile security definer set search_path = public as $fn$
begin
  update public.media_cleanup c
     set due_at = now()
    from public.intimate_rounds r
    join public.intimate_sessions s on s.id = r.session_id
   where c.path = r.media_path and not c.deleting
     and (s.expires_at <= now() or s.ended_at is not null);
  delete from public.intimate_sessions
   where expires_at <= now()
      or (ended_at is not null and ended_at < now() - interval '1 hour');
end $fn$;
revoke all on function public.purge_intimate_sessions() from public, anon, authenticated;
grant execute on function public.purge_intimate_sessions() to service_role;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090026_intimate_games') on conflict (id) do nothing;
