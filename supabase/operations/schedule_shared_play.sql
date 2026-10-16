-- Run separately after the upgrade migration; verify cron.job_run_details.
select cron.schedule('meera-shared-play-purge','*/15 * * * *',
  'select public.purge_shared_play();');
