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
  const { error: purgeError } = await admin.rpc('purge_expired')
  if (purgeError) return Response.json({ error: purgeError.message }, { status: 500 })
  const { data: pending, error } = await admin.from('media_cleanup').select('path').lte('due_at', new Date().toISOString()).order('due_at').limit(100)
  if (error) return Response.json({ error: error.message }, { status: 500 })
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
  return Response.json({ removed, failed }, { status: failed ? 503 : 200 })
})
