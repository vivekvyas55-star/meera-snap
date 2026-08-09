-- ============================================================================
-- Hardening for security-question recovery (audit findings 2 & 3).
--
-- 2. TAKEOVER FIX: an empty / whitespace-only answer hashed the empty string,
--    and the anon-callable reset_password would then match a blank guess →
--    unauthenticated account takeover. Reject empty answers in BOTH RPCs (the
--    client guards too, but the RPCs are directly callable with the anon key,
--    so the authoritative check must be server-side).
--
-- 3. Rate-limit answer guessing (lock the account's reset after 5 wrong tries
--    for 15 min) and raise the bcrypt cost so grinding a low-entropy answer is
--    slow. attempts/locked_until live on the row the client cannot SELECT.
-- ============================================================================
alter table public.security_questions
  add column if not exists attempts     int         not null default 0,
  add column if not exists locked_until  timestamptz;

-- Set/replace your own Q+A: reject empty answer, cost-10 hash, clear any lock.
create or replace function public.set_security_question(question text, answer text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(trim(coalesce(answer, ''))) = 0 then
    raise exception 'answer must not be empty';
  end if;
  insert into public.security_questions (user_id, question, answer_hash, attempts, locked_until, updated_at)
  values (auth.uid(), question,
          extensions.crypt(lower(trim(answer)), extensions.gen_salt('bf', 10)), 0, null, now())
  on conflict (user_id) do update
    set question = excluded.question, answer_hash = excluded.answer_hash,
        attempts = 0, locked_until = null, updated_at = now();
end $$;
revoke all on function public.set_security_question(text, text) from public;
grant execute on function public.set_security_question(text, text) to authenticated;

-- Verify the answer (rate-limited) and set a new login password.
create or replace function public.reset_password(uname text, answer text, new_password text)
returns boolean language plpgsql security definer set search_path = public, extensions, auth as $$
declare uid uuid; stored text; locked timestamptz; tries int;
begin
  if length(trim(coalesce(answer, ''))) = 0 then return false; end if;  -- (2) no blank answers
  if length(new_password) < 6 then return false; end if;
  select p.id, sq.answer_hash, sq.locked_until, sq.attempts
    into uid, stored, locked, tries
    from public.profiles p
    join public.security_questions sq on sq.user_id = p.id
   where p.username = lower(trim(uname));
  if uid is null or stored is null then return false; end if;
  if locked is not null and locked > now() then return false; end if;  -- (3) locked out
  if extensions.crypt(lower(trim(answer)), stored) <> stored then
    -- wrong answer: count it; lock the reset after 5 tries for 15 minutes
    update public.security_questions
       set attempts = attempts + 1,
           locked_until = case when attempts + 1 >= 5 then now() + interval '15 minutes'
                               else locked_until end
     where user_id = uid;
    return false;
  end if;
  -- correct: change the password (cost-10, matching GoTrue) and clear the counter
  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = uid;
  update public.security_questions set attempts = 0, locked_until = null where user_id = uid;
  return true;
end $$;
revoke all on function public.reset_password(text, text, text) from public;
grant execute on function public.reset_password(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
select 'security-question hardening applied' as status;
