-- Meera production only. Apply after cleanup is deployed and verified.
select cron.schedule('meera-media-cleanup','*/15 * * * *',$job$
 select net.http_post(
  url:='https://mqxfggwncoazgmcswedi.supabase.co/functions/v1/cleanup',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='meera_cleanup_token')),
  body:='{}'::jsonb,
  timeout_milliseconds:=60000
 );
$job$);
