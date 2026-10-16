-- TURN configuration is installed separately by the operator, never committed.
begin;
create table if not exists public.call_relay_config (
 id boolean primary key default true check(id),
 ice_servers jsonb not null,
 updated_at timestamptz not null default now()
);
alter table public.call_relay_config enable row level security;
revoke all on public.call_relay_config from public,anon,authenticated;
create or replace function public.get_call_ice(peer uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare config jsonb;
begin
 if not shared_play_allowed(peer) then raise exception 'Calls need an accepted, unblocked friendship.'; end if;
 select ice_servers into config from call_relay_config where id;
 if config is null then raise exception 'Call relay is not configured yet'; end if;
 return config;
end $$;
revoke all on function public.get_call_ice(uuid) from public,anon,authenticated;
grant execute on function public.get_call_ice(uuid) to authenticated;
insert into public.schema_migrations(id) values ('202610170130_call_relay') on conflict do nothing;
notify pgrst,'reload schema';
commit;
