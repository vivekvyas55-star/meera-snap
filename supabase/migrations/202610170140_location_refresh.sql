-- Automatic fixes may update an existing live share, never resurrect one.
begin;
create or replace function public.refresh_live_location(latitude double precision, longitude double precision)
returns boolean language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 if latitude is null or longitude is null or not(latitude between -90 and 90) or not(longitude between -180 and 180) then raise exception 'Invalid coordinates'; end if;
 update public.locations set lat=latitude,lng=longitude,updated_at=now()
 where user_id=auth.uid() and sharing and (expires_at is null or expires_at>now());
 get diagnostics changed = row_count;
 return changed=1;
end $$;
revoke all on function public.refresh_live_location(double precision,double precision) from public,anon;
grant execute on function public.refresh_live_location(double precision,double precision) to authenticated;
insert into public.schema_migrations(id) values ('202610170140_location_refresh') on conflict do nothing;
notify pgrst,'reload schema';
commit;
