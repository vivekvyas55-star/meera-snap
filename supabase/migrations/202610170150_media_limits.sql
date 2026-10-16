begin;
-- No HTML/SVG/script uploads; existing files are not removed or rewritten.
update storage.buckets set public=false,
 file_size_limit=52428800,
 allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','audio/*','video/*']
where id='media';
insert into public.schema_migrations(id) values ('202610170150_media_limits') on conflict do nothing;
commit;
