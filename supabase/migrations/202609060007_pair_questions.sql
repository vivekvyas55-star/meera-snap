-- Questions you write to each other, as opposed to the app's shared daily
-- prompt. Either person may ask up to 3 a day; the other one answers. Cards
-- from both people interleave in the order they were asked.
--
-- This is a separate table rather than a new messages.kind. Questions are not
-- ephemeral — they must not be swept by clear_viewed_chats, they carry an
-- answer written by the OTHER person (which the messages update-guard trigger
-- is not shaped for), and they need a per-day cap the messages hot path should
-- not have to know about.
begin;

create table if not exists public.pair_questions (
  id          uuid primary key default gen_random_uuid(),
  user_a      uuid not null references auth.users(id) on delete cascade,
  user_b      uuid not null references auth.users(id) on delete cascade,
  asker       uuid not null references auth.users(id) on delete cascade,
  body        text not null,
  answer      text,
  on_date     date not null,
  created_at  timestamptz not null default now(),
  answered_at timestamptz,
  constraint pair_questions_ordered check (user_a < user_b),
  constraint pair_questions_asker_in_pair check (asker in (user_a, user_b)),
  constraint pair_questions_body_len check (length(btrim(body)) between 1 and 300),
  constraint pair_questions_answer_len check (answer is null or length(btrim(answer)) between 1 and 500)
);

create index if not exists pair_questions_pair_idx
  on public.pair_questions (user_a, user_b, created_at desc);

alter table public.pair_questions enable row level security;

-- Both people in the pair can read every question and answer. Unlike the daily
-- prompt there is no simultaneous-reveal rule here: one person asks openly and
-- the other answers, so there is nothing to hide until both have written.
drop policy if exists pair_questions_read on public.pair_questions;
create policy pair_questions_read on public.pair_questions for select to authenticated
  using (auth.uid() in (user_a, user_b));

-- All writes go through the RPCs, so the per-day cap and "only the other person
-- answers" rule cannot be bypassed by writing the table directly.
revoke all on public.pair_questions from public, anon, authenticated;
grant select on public.pair_questions to authenticated;

create or replace function public.ask_question(other uuid, body text)
returns public.pair_questions
language plpgsql volatile security definer set search_path = public as $fn$
declare pk uuid[]; d date; used int; row public.pair_questions;
begin
  if auth.uid() is null or other is null or other = auth.uid() then
    raise exception 'not allowed';
  end if;
  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted' and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), other)
  ) then
    raise exception 'not allowed';
  end if;
  if body is null or length(btrim(body)) = 0 then
    raise exception 'Write a question first';
  end if;

  pk := public.pair_key(auth.uid(), other);
  d  := public.ist_date();

  select count(*) into used from public.pair_questions q
  where q.user_a = pk[1] and q.user_b = pk[2] and q.asker = auth.uid() and q.on_date = d;
  if used >= 3 then
    raise exception 'That is your three questions for today';
  end if;

  insert into public.pair_questions (user_a, user_b, asker, body, on_date)
  values (pk[1], pk[2], auth.uid(), btrim(body), d)
  returning * into row;
  return row;
end $fn$;
revoke all on function public.ask_question(uuid, text) from public, anon;
grant execute on function public.ask_question(uuid, text) to authenticated;

-- Only the person who was asked can answer, and only once. An editable answer
-- would let you rewrite it after the fact, which is the same reasoning that
-- keeps prompt_answers free of an UPDATE grant.
create or replace function public.answer_question(question uuid, body text)
returns public.pair_questions
language plpgsql volatile security definer set search_path = public as $fn$
declare row public.pair_questions;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  if body is null or length(btrim(body)) = 0 then
    raise exception 'Write an answer first';
  end if;

  update public.pair_questions q
     set answer = btrim(body), answered_at = now()
   where q.id = question
     and auth.uid() in (q.user_a, q.user_b)
     and q.asker <> auth.uid()
     and q.answer is null
  returning * into row;

  if row.id is null then
    raise exception 'That question is not yours to answer, or it is already answered';
  end if;
  return row;
end $fn$;
revoke all on function public.answer_question(uuid, text) from public, anon;
grant execute on function public.answer_question(uuid, text) to authenticated;

-- Today's cards for one pair, plus how many asks the caller has left.
create or replace function public.pair_questions_today(other uuid)
returns table (
  id uuid, asker uuid, body text, answer text,
  created_at timestamptz, answered_at timestamptz, asks_left int
)
language sql stable security definer set search_path = public as $fn$
  with pk as (select public.pair_key(auth.uid(), other) as k), d as (select public.ist_date() as v)
  select q.id, q.asker, q.body, q.answer, q.created_at, q.answered_at,
         greatest(0, 3 - (
           select count(*) from public.pair_questions x, pk, d
           where x.user_a = pk.k[1] and x.user_b = pk.k[2]
             and x.asker = auth.uid() and x.on_date = d.v
         ))::int as asks_left
  from public.pair_questions q, pk, d
  where q.user_a = pk.k[1] and q.user_b = pk.k[2] and q.on_date = d.v
    and auth.uid() in (q.user_a, q.user_b)
  order by q.created_at;
$fn$;
revoke all on function public.pair_questions_today(uuid) from public, anon;
grant execute on function public.pair_questions_today(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
