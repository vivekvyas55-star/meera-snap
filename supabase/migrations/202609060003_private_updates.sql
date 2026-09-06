-- Database-change subscriptions must also join private channels.
begin;
create or replace function public.realtime_allowed(topic text, writing boolean)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare parts text[]:=string_to_array(topic,':'); owner uuid; recipient uuid;
begin
 if auth.uid() is null then return false; end if;
 if parts[1]='updates' and cardinality(parts)=3 then
  return not writing and parts[2]::uuid=auth.uid();
 elsif parts[1]='online' and cardinality(parts)=2 then
  owner:=parts[2]::uuid;
  if writing then return owner=auth.uid(); end if;
  return owner=auth.uid() or exists(select 1 from public.friendships f where f.status='accepted' and array[f.user_a,f.user_b]=public.pair_key(owner,auth.uid()));
 elsif parts[1] in ('signal','typing') and cardinality(parts)=3 then
  recipient:=parts[2]::uuid; owner:=parts[3]::uuid;
  return (case when writing then owner=auth.uid() else recipient=auth.uid() end)
   and exists(select 1 from public.friendships f where f.status='accepted' and array[f.user_a,f.user_b]=public.pair_key(owner,recipient));
 end if;
 return false;
exception when invalid_text_representation then return false;
end $$;
revoke all on function public.realtime_allowed(text,boolean) from public;
grant execute on function public.realtime_allowed(text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
