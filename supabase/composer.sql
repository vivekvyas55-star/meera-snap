-- ============================================================================
-- Allow voice-note and sticker messages in chat.
--   kind 'voice'   -> media_path is an audio clip (media_type 'audio')
--   kind 'sticker' -> body holds a single emoji, rendered large
-- Both are ephemeral like chats (isVisibleTo treats non-snap as chat rules).
-- ============================================================================

alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('chat', 'snap', 'voice', 'sticker'));

alter table public.messages drop constraint if exists messages_media_type_check;
alter table public.messages add constraint messages_media_type_check
  check (media_type is null or media_type in ('image', 'video', 'audio'));

-- A voice note must carry media, just like a snap.
alter table public.messages drop constraint if exists snap_has_media;
alter table public.messages add constraint snap_has_media
  check (kind not in ('snap', 'voice') or media_path is not null);

select 'composer kinds enabled' as status;
