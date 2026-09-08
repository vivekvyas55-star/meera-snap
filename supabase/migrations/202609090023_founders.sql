-- ---------------------------------------------------------------------------
-- Founding users keep permanent access. Owner's decision, recorded here.
--
-- `202609070010_billing.sql` marked every account that existed at the time
-- `grandfathered`, and `202609070011_credits.sql` then set them all back to
-- 'none' — deliberately, with a comment, so the credit meter would apply to
-- everyone. The consequence was not intended: `Plans.jsx` offers a one-shot
-- 3-day trial to anyone whose status is 'none', so every founding user was
-- being shown a trial they had no need of, and one of them had already spent
-- it. `start_trial()` guards on `status='none' and trial_ends_at is null`, so
-- a spent trial can never be re-armed.
--
-- More seriously: with `billing_settings.enforced` still false nobody noticed,
-- but the day it is flipped NOBODY would have been grandfathered, and access
-- for every existing account would have become purely credit-driven.
--
-- entitlement() and post_monthly_credits() already handle `grandfathered`
-- correctly — allowed unconditionally, and skipped by the monthly charge — so
-- this restores data, not behaviour.
-- ---------------------------------------------------------------------------
begin;

-- Everyone who is already here. New signups keep the 'none' default, so this
-- draws the founding line at the moment it runs and cannot capture anyone
-- afterwards.
update public.subscriptions s
   set status = 'grandfathered',
       -- Give back the trial the bug consumed. It bought them nothing —
       -- enforcement is off — and a founder should not be left holding a spent
       -- one-shot if they ever cease to be grandfathered.
       trial_ends_at = null,
       updated_at = now()
 where s.status in ('none', 'trialing');

-- Any account without a row at all (there are none today, but a signup racing
-- this migration would have one created by the trigger a moment later).
insert into public.subscriptions (user_id, status)
select u.id, 'grandfathered' from auth.users u
 where not exists (select 1 from public.subscriptions s where s.user_id = u.id)
on conflict (user_id) do nothing;

notify pgrst, 'reload schema';
commit;

insert into public.schema_migrations(id) values ('202609090023_founders') on conflict (id) do nothing;
