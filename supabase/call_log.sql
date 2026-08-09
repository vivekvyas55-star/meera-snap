-- ============================================================================
-- Call-log messages: a record in the conversation of a placed / missed / ended
-- call (like WhatsApp's call rows). kind='call', with the type+status encoded
-- in body ("video|missed", "voice|ended") and the duration in view_seconds.
-- No media_path needed (the snap_has_media check exempts non-snap/voice kinds).
-- ============================================================================
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('chat', 'snap', 'voice', 'sticker', 'call'));

notify pgrst, 'reload schema';
select 'call-log kind enabled' as status;
