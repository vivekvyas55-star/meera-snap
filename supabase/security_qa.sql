-- ============================================================================
-- Security-question password recovery (no email needed). The answer is
-- bcrypt-hashed; the reset RPC verifies it and updates the login password
-- directly in auth.users (GoTrue and pgcrypto both use bcrypt, so the new
-- password works on the next login). SECURITY DEFINER so the reset works
-- pre-auth. The answer hash is never readable by the client.
-- ============================================================================
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.security_questions (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  question    text not null,
  answer_hash text not null,
  updated_at  timestamptz not null default now()
);
alter table public.security_questions enable row level security;

-- Users may write their own row; NOBODY can read answer hashes from the client.
drop policy if exists secq_write on public.security_questions;
create policy secq_write on public.security_questions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
revoke select on public.security_questions from authenticated, anon;
grant insert, update, delete on public.security_questions to authenticated;

-- Set/replace your own Q+A (answer hashed server-side).
create or replace function public.set_security_question(question text, answer text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.security_questions (user_id, question, answer_hash, updated_at)
  values (auth.uid(), question, extensions.crypt(lower(trim(answer)), extensions.gen_salt('bf')), now())
  on conflict (user_id) do update
    set question = excluded.question, answer_hash = excluded.answer_hash, updated_at = now();
end $$;
revoke all on function public.set_security_question(text, text) from public;
grant execute on function public.set_security_question(text, text) to authenticated;

-- The security question for a username (to show on the reset screen). Pre-auth.
create or replace function public.get_security_question(uname text)
returns text language sql security definer set search_path = public as $$
  select sq.question
    from public.profiles p
    join public.security_questions sq on sq.user_id = p.id
   where p.username = lower(trim(uname));
$$;
revoke all on function public.get_security_question(text) from public;
grant execute on function public.get_security_question(text) to anon, authenticated;

-- Verify the answer and set a new login password. Returns true on success.
create or replace function public.reset_password(uname text, answer text, new_password text)
returns boolean language plpgsql security definer set search_path = public, extensions, auth as $$
declare uid uuid; stored text;
begin
  if length(new_password) < 6 then return false; end if;
  select p.id, sq.answer_hash into uid, stored
    from public.profiles p
    join public.security_questions sq on sq.user_id = p.id
   where p.username = lower(trim(uname));
  if uid is null or stored is null then return false; end if;
  if extensions.crypt(lower(trim(answer)), stored) <> stored then return false; end if;
  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = uid;
  return true;
end $$;
revoke all on function public.reset_password(text, text, text) from public;
grant execute on function public.reset_password(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
select 'security-question password recovery enabled' as status;
