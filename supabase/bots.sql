-- ============================================================================
-- Motivation bots.
-- Keep vivek + sneha (real) and 5 bot accounts. Each morning every real user
-- receives a motivational quote from a bot friend. Fully automated (pg_cron),
-- and defensive so one bad row never stops the batch.
-- ============================================================================

-- Account deletion belongs in explicit administrative operations, never migrations.

-- 2. Mark the 5 bots.
alter table public.profiles add column if not exists is_bot boolean not null default false;
update public.profiles set is_bot = true
 where username in ('aarav','isha','priya','karan','nisha');
update public.profiles set is_bot = false
 where username in ('vivek','sneha');

-- 3. Every real user must be an accepted friend of every bot (so the quote lands
--    in their chat list). Backfill existing pairs...
insert into public.friendships (user_a, user_b, requested_by, status)
select least(r.id, b.id), greatest(r.id, b.id), b.id, 'accepted'
  from public.profiles r
  join public.profiles b on b.is_bot and not r.is_bot
 on conflict (user_a, user_b) do nothing;

-- ...and auto-friend any FUTURE real user with all bots on signup.
create or replace function public.autofriend_bots()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_bot then return new; end if;
  insert into public.friendships (user_a, user_b, requested_by, status)
  select least(new.id, b.id), greatest(new.id, b.id), b.id, 'accepted'
    from public.profiles b where b.is_bot
  on conflict (user_a, user_b) do nothing;
  return new;
exception when others then
  return new; -- never block a signup on this
end $$;

drop trigger if exists on_profile_autofriend on public.profiles;
create trigger on_profile_autofriend after insert on public.profiles
  for each row execute function public.autofriend_bots();

-- 4. Quotes.
create table if not exists public.bot_quotes (id serial primary key, text text not null);
insert into public.bot_quotes (text)
select v.text from (values
  ('Good morning! Today is a fresh start — make it count. 🌅'),
  ('Small steps every day add up to big results. Keep going. 💪'),
  ('You are capable of amazing things. Believe it this morning. ✨'),
  ('Energy flows where attention goes. Focus on what matters today. ⚡'),
  ('Discipline is choosing what you want most over what you want now. 🔥'),
  ('Rise and shine — the world needs your energy today. ☀️'),
  ('Every morning is a chance to be better than yesterday. 🚀'),
  ('Your only limit is the one you set in your mind. Break it. 🧠'),
  ('Great things never come from comfort zones. Step out today. 🌱'),
  ('Start where you are. Use what you have. Do what you can. 🙌'),
  ('The secret of getting ahead is getting started. Begin now. 🏁'),
  ('Wake up with determination, go to bed with satisfaction. 🌟'),
  ('Push yourself, because no one else is going to do it for you. 💥'),
  ('A little progress each day adds up to big results. 📈'),
  ('Dream big, start small, act now. Your morning is calling. 🎯'),
  ('You did not wake up today to be mediocre. Give it your all. 🦁'),
  ('Fuel your day with positivity and watch what unfolds. 🌈'),
  ('Hard work beats talent when talent does not work hard. 🛠️'),
  ('Be the energy you want to attract today. 🔋'),
  ('One day or day one — you decide. Make it day one. 💫')
) v(text)
where not exists (select 1 from public.bot_quotes);

-- 5. The morning send. SECURITY DEFINER so it runs as owner (bypasses RLS) and
--    each recipient is wrapped so a single failure can't halt the batch.
create or replace function public.send_morning_quotes()
returns int language plpgsql security definer set search_path = public as $$
declare
  ru record; bot_id uuid; q text; sent int := 0;
begin
  for ru in select id from public.profiles where not is_bot loop
    begin
      -- a bot friend, rotating per user per day
      select b.id into bot_id from public.profiles b
       where b.is_bot
       order by md5(b.id::text || ru.id::text || current_date::text)
       limit 1;
      -- a quote, rotating per user per day
      select text into q from public.bot_quotes
       order by md5(id::text || ru.id::text || current_date::text)
       limit 1;
      if bot_id is null or q is null then continue; end if;
      insert into public.messages (user_a, user_b, sender_id, kind, body, delivered_at)
      values (least(bot_id, ru.id), greatest(bot_id, ru.id), bot_id, 'chat', q, now());
      sent := sent + 1;
    exception when others then
      -- swallow and continue with the next user
      null;
    end;
  end loop;
  return sent;
end $$;

-- 6. Send one round now so it's verifiable immediately. (Daily scheduling via
--    pg_cron is applied separately — see supabase/cron.sql — because enabling
--    the extension can abort a batched transaction on some projects.)
-- Scheduled delivery only; migration replay must not send messages.
