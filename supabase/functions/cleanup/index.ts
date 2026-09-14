import { createClient } from 'jsr:@supabase/supabase-js@2'

// Scheduled server-only worker. Use the same secret in the scheduler's Authorization header.
Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const authorization = req.headers.get('Authorization') || ''
  if (!authorization.startsWith('Bearer ') || authorization.length > 256) return new Response('Unauthorized', { status: 401 })
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: authorized, error: authError } = await admin.rpc('authorize_cleanup', { token: authorization.slice(7) })
  if (authError) return new Response('Authorization unavailable', { status: 503 })
  if (authorized !== true) return new Response('Unauthorized', { status: 401 })
  // Telemetry for this worker is the easy case for privacy: a cron pass belongs
  // to nobody, so there is no identity to omit. What it buys is real — this job
  // failing means storage fills with objects nothing will ever collect, and
  // storage is the egress bill. Until now a failing pass was a 503 into a
  // scheduler that nobody reads.
  const report = async (events: unknown[]) => {
    try { await admin.rpc('record_ops_server_events', { source: 'cleanup', events }) }
    catch { /* never let the accounting fail the work it is accounting for */ }
  }

  const { error: purgeError } = await admin.rpc('purge_expired')
  if (purgeError) {
    await report([{ kind: 'cleanup_run', code: 'purge_failed', count: 1 }])
    return Response.json({ error: purgeError.message }, { status: 500 })
  }
  const { data: pending, error } = await admin.from('media_cleanup').select('path').lte('due_at', new Date().toISOString()).order('due_at').limit(100)
  if (error) {
    await report([{ kind: 'cleanup_run', code: 'queue_unreadable', count: 1 }])
    return Response.json({ error: error.message }, { status: 500 })
  }
  let removed = 0, failed = 0
  for (const item of pending ?? []) {
    const { data: claimed, error: claimError } = await admin.rpc('claim_media_cleanup', { object_path: item.path })
    if (claimError) { failed++; continue }
    if (!claimed) continue
    const { error: deleteError } = await admin.storage.from('media').remove([item.path])
    if (deleteError) { failed++; continue } // keep the claim for a later retry
    const { error: doneError } = await admin.from('media_cleanup').delete().eq('path', item.path)
    if (doneError) { failed++; continue }
    removed++
  }
  // Counts, never paths. A media path's first segment is the owner's user id,
  // so the one thing that must not travel with this is the thing it is about.
  // `objects_removed` is reported as its own code so the dashboard can see the
  // collection RATE — a pass that succeeds while removing nothing for days is a
  // different failure from a pass that errors, and the 503 above cannot tell
  // them apart.
  await report([
    { kind: 'cleanup_run', code: failed ? (removed ? 'partial' : 'failed') : 'ok', count: 1, retries: Math.min(3, failed) },
    ...(removed ? [{ kind: 'cleanup_run', code: 'objects_removed', count: removed }] : []),
  ])
  return Response.json({ removed, failed }, { status: failed ? 503 : 200 })
})
