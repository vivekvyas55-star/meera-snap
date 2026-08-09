-- ============================================================================
-- Second-round audit fixes: password-recovery session revocation, a decaying
-- guess-lockout window, and scoping the snap-score RPC to people you can
-- actually see. Supersedes the reset_password / get_snap_score definitions in
-- security_qa_hardening.sql and core_fixes.sql respectively (last applied wins).
--
-- 1. SESSION REVOCATION. reset_password changed auth.users.encrypted_password
--    but left auth.sessions / auth.refresh_tokens untouched. Recovery is the
--    flow you run precisely BECAUSE someone else may hold your account — and
--    an attacker's existing session kept refreshing indefinitely after the
--    "recovery" completed. GoTrue only checks the password at sign-in, never
--    on refresh, so changing it alone locks nobody out. Kill every session for
--    the user as part of the same transaction as the password change.
--
-- 2. LOCKOUT DoS. `attempts` never decayed: it counted wrong guesses for the
--    lifetime of the row. After 5 lifetime misses the counter stayed >= 5, so
--    every later wrong guess re-armed a fresh 15-minute lock. Since usernames
--    are enumerable (get_security_question is anon-callable by design, so the
--    reset screen can show the question), anyone could keep a stranger's
--    recovery permanently locked with one wrong guess every 15 minutes. Make
--    it a ROLLING window: misses older than the window don't count.
--
-- 3. SNAP SCORE SCOPE. get_snap_score(target) was granted to `authenticated`
--    with no relationship check, so any signed-in user could pull an activity
--    metric for an arbitrary uuid harvested from anywhere. The UI only ever
--    needs your own score and an accepted friend's. Enforce exactly that; a
--    stranger's score reads 0 rather than erroring, so the card just shows a
--    dash.
-- ============================================================================

alter table public.security_questions
  add column if not exists last_attempt_at timestamptz;

-- 1 + 2 ----------------------------------------------------------------------
create or replace function public.reset_password(uname text, answer text, new_password text)
returns boolean language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  uid uuid; stored text; locked timestamptz; tries int; last_try timestamptz;
  -- Wrong guesses stop counting once this much time has passed since the last
  -- one, so the lock is a rolling window rather than a permanent state.
  window_interval constant interval := interval '15 minutes';
begin
  if length(trim(coalesce(answer, ''))) = 0 then return false; end if;
  if length(new_password) < 6 then return false; end if;

  select p.id, sq.answer_hash, sq.locked_until, sq.attempts, sq.last_attempt_at
    into uid, stored, locked, tries, last_try
    from public.profiles p
    join public.security_questions sq on sq.user_id = p.id
   where p.username = lower(trim(uname));
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

-- 3 --------------------------------------------------------------------------
create or replace function public.get_snap_score(target uuid)
returns int language sql security definer set search_path = public as $$
  select case
    when target = auth.uid() or exists (
      select 1 from public.friendships f
       where f.status = 'accepted'
         and array[f.user_a, f.user_b] = public.pair_key(auth.uid(), target)
    )
    then (select count(*)::int from public.messages
           where kind = 'snap' and (user_a = target or user_b = target))
    else 0
  end;
$$;
revoke all on function public.get_snap_score(uuid) from public;
grant execute on function public.get_snap_score(uuid) to authenticated;

notify pgrst, 'reload schema';
select 'recovery: sessions revoked on reset, rolling lockout; snap score scoped' as status;
