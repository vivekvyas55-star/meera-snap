-- Keep the scheduler token inside Vault; never copy it into a client or CLI log.
begin;
create extension if not exists pg_net with schema extensions;
do $$ begin
 if not exists(select 1 from vault.secrets where name='meera_cleanup_token') then
  perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'meera_cleanup_token','Server-only scheduled media cleanup');
 end if;
end $$;
create or replace function public.authorize_cleanup(token text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(length(token)=64 and exists(
  select 1 from vault.decrypted_secrets s where s.name='meera_cleanup_token'
  and extensions.digest(token,'sha256')=extensions.digest(s.decrypted_secret,'sha256')
 ),false);
$$;
revoke all on function public.authorize_cleanup(text) from public,anon,authenticated;
grant execute on function public.authorize_cleanup(text) to service_role;
notify pgrst,'reload schema';
commit;
