// Razorpay webhook → subscription state.
//
// The only trustworthy signal that someone paid is a webhook the payment
// provider signed. A client saying "I subscribed" is worth nothing, so this is
// the ONLY thing that writes an active subscription. It runs as service_role,
// which bypasses RLS; the tables grant the client select and nothing else.
//
// Deploy with --no-verify-jwt (Razorpay does not send a Supabase JWT) and set:
//   supabase secrets set RAZORPAY_WEBHOOK_SECRET=...
//
// Signature: HMAC-SHA256 of the RAW body with the webhook secret, hex, in
// X-Razorpay-Signature. It must be compared in constant time and the body must
// be the exact bytes received — re-serialising parsed JSON changes the digest.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? ''

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function signatureOf(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Razorpay's subscription states mapped onto ours. Anything unrecognised is
// ignored rather than guessed — a wrong guess either bills a user who should be
// free or frees a user who should be billed.
const STATUS: Record<string, string> = {
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.resumed': 'active',
  'subscription.pending': 'past_due',
  'subscription.halted': 'past_due',
  'subscription.cancelled': 'canceled',
  'subscription.completed': 'canceled',
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!SECRET) return new Response('not configured', { status: 500 })

  const raw = await req.text()
  const sent = req.headers.get('x-razorpay-signature') ?? ''
  if (!timingSafeEqual(sent, await signatureOf(raw))) {
    return new Response('bad signature', { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
  } catch {
    return new Response('bad payload', { status: 400 })
  }

  const event = String(payload.event ?? '')
  const status = STATUS[event]
  if (!status) return new Response(JSON.stringify({ ignored: event }), { status: 200 })

  const sub = (payload as any)?.payload?.subscription?.entity
  // notes is where we put our own user id when creating the subscription — the
  // provider's customer id is not something the app should have to map.
  const userId = sub?.notes?.meera_user_id
  if (!userId) return new Response('no user reference', { status: 400 })

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  )

  // Never downgrade a grandfathered account from a payment event.
  const { data: existing } = await db
    .from('subscriptions')
    .select('status')
    .eq('user_id', userId)
    .maybeSingle()
  if (existing?.status === 'grandfathered') {
    return new Response(JSON.stringify({ skipped: 'grandfathered' }), { status: 200 })
  }

  const { error } = await db.from('subscriptions').upsert(
    {
      user_id: userId,
      status,
      plan: sub?.notes?.meera_plan ?? null,
      current_period_end: sub?.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
      provider: 'razorpay',
      provider_ref: sub?.id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (error) return new Response(error.message, { status: 500 })

  return new Response(JSON.stringify({ ok: true, status }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
