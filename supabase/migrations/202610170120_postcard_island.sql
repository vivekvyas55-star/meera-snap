-- Original live co-op game. Positions and deliveries are server-authoritative.
begin;
create or replace function public.island_walkable(x integer,y integer,bridge boolean) returns boolean
language sql immutable set search_path=public as $$
 select x between 1 and 9 and y between 1 and 9
 and (y<>4 or x in (3,7)) and (y>2 or bridge);
$$;
revoke all on function public.island_walkable(integer,integer,boolean) from public,anon,authenticated;

create or replace function public.island_act(activity uuid,sequence integer,command text) returns jsonb
language plpgsql volatile security definer set search_path=public as $$
declare s public.shared_play; peer uuid; slot text; peer_slot text; p jsonb; d jsonb;
 x int; y int; nx int; ny int; bag int; candidate int; targets jsonb:='[[2,7],[8,7],[2,3],[8,3],[5,1]]';
begin
 select * into s from shared_play where id=activity for update;
 if not found or auth.uid() is null or auth.uid() not in (s.user_a,s.user_b) or s.kind<>'island' then raise exception 'Island unavailable'; end if;
 peer:=case when auth.uid()=s.user_a then s.user_b else s.user_a end;
 if not shared_play_allowed(peer) or s.expires_at<=now() then raise exception 'Island unavailable'; end if;
 slot:=case when auth.uid()=s.user_a then 'a' else 'b' end;
 peer_slot:=case when slot='a' then 'b' else 'a' end;
 p:=s.data->slot; d:=s.data;
 if sequence is null or command is null or command not in ('up','down','left','right','interact') then raise exception 'Invalid control'; end if;
 if sequence=(p->>'seq')::int then return to_jsonb(s)-'secret'-'last_request'; end if;
 if s.status<>'active' then raise exception 'Join the island first'; end if;
 if sequence<>(p->>'seq')::int+1 then raise exception 'Island changed. Reconnect and try again.'; end if;
 if coalesce((p->>'at')::timestamptz,'epoch')>clock_timestamp()-interval '120 milliseconds' then raise exception 'Slow down a moment'; end if;
 x:=(p->>'x')::int; y:=(p->>'y')::int; nx:=x; ny:=y; bag:=(p->>'bag')::int;
 if command='up' then ny:=y-1; elsif command='down' then ny:=y+1;
 elsif command='left' then nx:=x-1; elsif command='right' then nx:=x+1;
 else
   if bag=-1 and abs(x-5)+abs(y-8)<=1 then
     for candidate in 0..4 loop
       if not (d->'delivered') @> to_jsonb(candidate) and (d->peer_slot->>'bag')::int<>candidate then bag:=candidate; exit; end if;
     end loop;
   elsif bag>=0 and abs(x-(targets->bag->>0)::int)+abs(y-(targets->bag->>1)::int)<=1 then
     d:=jsonb_set(d,'{delivered}',(d->'delivered')||to_jsonb(bag)); bag:=-1;
   end if;
 end if;
 if not island_walkable(nx,ny,(d->>'bridge')::boolean) then nx:=x; ny:=y; end if;
 p:=p||jsonb_build_object('x',nx,'y',ny,'bag',bag,'seq',sequence,'at',clock_timestamp());
 d:=jsonb_set(d,array[slot],p);
 if ((d->'a'->>'x')::int=3 and (d->'b'->>'x')::int=7 or (d->'a'->>'x')::int=7 and (d->'b'->>'x')::int=3)
 and (d->'a'->>'y')::int=5 and (d->'b'->>'y')::int=5 then d:=jsonb_set(d,'{bridge}','true'); end if;
 update shared_play set data=d, revision=revision+1,status=case when jsonb_array_length(d->'delivered')=5 then 'done' else 'active' end
 where id=activity returning * into s;
 return to_jsonb(s)-'secret'-'last_request';
end $$;
revoke all on function public.island_act(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.island_act(uuid,integer,text) to authenticated;
insert into public.schema_migrations(id) values ('202610170120_postcard_island') on conflict do nothing;
notify pgrst,'reload schema';
commit;
