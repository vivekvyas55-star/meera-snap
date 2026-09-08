-- ---------------------------------------------------------------------------
-- Production bug: answering a pair question failed with
--   column reference "body" is ambiguous
-- so the Question of the Day could be ASKED but never ANSWERED.
--
-- The parameter is named `body` and `pair_questions` has a `body` column. In an
-- UPDATE the target table's columns are in scope unqualified — the alias `q`
-- adds a qualified name, it does not remove the bare one — so `btrim(body)`
-- could mean either. ask_question has the same parameter name and works fine,
-- because in an INSERT the VALUES list has no table columns in scope at all.
-- That is exactly why this survived: the half of the feature that was exercised
-- was the half that could not break.
--
-- The parameter NAME is kept. PostgREST dispatches on argument names, so
-- renaming it would need the client changed in the same breath, and a rename is
-- not the fix — reading a value into a local before the table is in scope is.
-- ---------------------------------------------------------------------------
create or replace function public.answer_question(question uuid, body text)
returns public.pair_questions
language plpgsql volatile security definer set search_path = public as $fn$
declare row public.pair_questions; new_answer text;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  -- Evaluated before any table is in scope, so `body` can only be the argument.
  new_answer := btrim(body);
  if new_answer is null or length(new_answer) = 0 then
    raise exception 'Write an answer first';
  end if;

  update public.pair_questions q
     set answer = new_answer, answered_at = now()
   where q.id = question
     and auth.uid() in (q.user_a, q.user_b)
     and q.asker <> auth.uid()
     and q.answer is null
  returning * into row;

  if row.id is null then
    raise exception 'That question is not yours to answer, or it is already answered';
  end if;
  return row;
end $fn$;
revoke all on function public.answer_question(uuid, text) from public, anon;
grant execute on function public.answer_question(uuid, text) to authenticated;

notify pgrst, 'reload schema';

insert into public.schema_migrations(id) values ('202609090021_answer_question_fix') on conflict (id) do nothing;
