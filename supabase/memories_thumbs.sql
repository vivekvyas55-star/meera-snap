-- ============================================================================
-- Memories thumbnails (egress fix).
--
-- The Memories grid rendered one tile per memory from the FULL-SIZE original —
-- so opening the screen once downloaded every original at full resolution, just
-- to fill ~120px cells, every time. `saveToMemory` now writes a small JPEG
-- alongside the original and records it here; the grid uses it and falls back
-- to media_path for rows saved before this column existed.
--
-- Nullable, so old rows stay valid. memories carries table-wide
-- (not column-scoped) grants — see memories.sql — so the new column is already
-- covered by the existing `grant select, insert, delete`, and no extra grant is
-- needed. Verify anyway: on this schema a missing grant fails with 42501 BEFORE
-- RLS is evaluated.
-- ============================================================================
alter table public.memories
  add column if not exists thumb_path text;

notify pgrst, 'reload schema';
select 'memories.thumb_path added' as status;
