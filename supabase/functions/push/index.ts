// Web Push sender. Delivers a notification to a friend's devices when the app
// is closed — the one thing Realtime cannot do, since Realtime needs an open
// page. Implemented against the raw specs with Web Crypto only, no npm deps:
//
//   RFC 8292 (VAPID)  — the Authorization header identifying this application
//   RFC 8291 (aes128gcm) — end-to-end encryption of the payload
//
// The payload is encrypted to a key only the recipient's browser holds, so the
// push service (Google/Apple/Mozilla) relays ciphertext it cannot read. Keep it
// that way: never move notification text into a header or query string.
//
// Deploy:  supabase functions deploy push
// Secrets: supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
import { createClient } from 'jsr:@supabase/supabase-js@2'

const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@meera.local'

const enc = new TextEncoder()

// --- base64url helpers -----------------------------------------------------
function b64uToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
function bytesToB64u(b: Uint8Array | ArrayBuffer): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const byte of u8) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// --- HKDF (RFC 5869), the one-block form the push spec uses -----------------
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data))
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const prk = await hmac(salt, ikm)
  const okm = await hmac(prk, concat(info, new Uint8Array([1])))
  return okm.slice(0, length)
}

// --- VAPID Authorization header (RFC 8292) ---------------------------------
async function vapidHeader(audience: string): Promise<string> {
  const pub = b64uToBytes(VAPID_PUBLIC)
  // Rebuild the JWK from the raw keys: the public point is 0x04 || X || Y.
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    d: VAPID_PRIVATE,
    ext: true,
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])

  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = bytesToB64u(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  })))
  const signed = `${header}.${body}`
  // Web Crypto emits the raw r||s pair ES256 wants — no DER unwrapping needed.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signed))
  return `vapid t=${signed}.${bytesToB64u(sig)}, k=${VAPID_PUBLIC}`
}

// --- Payload encryption (RFC 8291, aes128gcm) ------------------------------
async function encryptPayload(plaintext: string, p256dh: string, authSecret: string) {
  const uaPublic = b64uToBytes(p256dh)
  const auth = b64uToBytes(authSecret)

  // Ephemeral sender keypair, fresh per message.
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256)
  )

  // IKM binds the shared secret to BOTH public keys, so a swapped key can't
  // silently produce a valid-looking record.
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(auth, shared, keyInfo, 32)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  // 0x02 is the last-record delimiter; we always send exactly one record.
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
  )

  // Header: salt(16) || record size(4, BE) || key id length(1) || key id(65)
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext)
}

// --- notification text -----------------------------------------------------
// Composed HERE, from a fixed vocabulary, never from the request body. If the
// caller could supply the text, any friend could put arbitrary words on your
// lock screen ("Your account was compromised, tap here") with Meera's name and
// icon on it. The client picks a `kind`; the wording is ours.
//
// The sender's name is included — the payload is encrypted end to end, so the
// push service never sees it — but message CONTENT never is. A notification is
// a nudge; the app is where content lives. That keeps message bodies off the
// lock screen of a phone someone else might be holding, consistent with the
// reverse-privacy and ephemerality choices elsewhere in the app.
const KINDS: Record<string, { body: (who: string) => string; tag: string; urgent: boolean }> = {
  chat:    { body: (w) => `${w} sent you a message`,    tag: 'chat',  urgent: false },
  snap:    { body: (w) => `${w} sent you a snap`,       tag: 'chat',  urgent: false },
  voice:   { body: (w) => `${w} sent you a voice note`, tag: 'chat',  urgent: false },
  sticker: { body: (w) => `${w} sent you a sticker`,    tag: 'chat',  urgent: false },
  call:    { body: (w) => `${w} is calling…`,           tag: 'call',  urgent: true  },
  game:    { body: (w) => `${w} invited you to play`,   tag: 'game',  urgent: false },
  game_accept: { body: (w) => `${w} accepted your game invite`, tag: 'game', urgent: false },
}

// --- handler ---------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  const url = Deno.env.get('SUPABASE_URL')!

  // Identify the caller from their own JWT — never trust a sender id in the body.
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authErr } = await asUser.auth.getUser()
  if (authErr || !user) return json({ error: 'unauthorized' }, 401)

  const { to, kind } = await req.json().catch(() => ({}))
  if (!to || !KINDS[kind as string]) return json({ error: 'to and a known kind are required' }, 400)
  if (to === user.id) return json({ sent: 0, skipped: 'self' })

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Authorisation: you may only push to an ACCEPTED friend. Without this the
  // function is an open notification relay to any user id an attacker can name.
  const [a, b] = [user.id, to].sort()
  const { data: friendship } = await admin
    .from('friendships')
    .select('status')
    .eq('user_a', a).eq('user_b', b)
    .eq('status', 'accepted')
    .maybeSingle()
  if (!friendship) return json({ error: 'not friends' }, 403)

  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', to)
  if (!subs?.length) {
    // A real outcome, not an error: the friend has no subscribed device. It is
    // counted because "push never reaches anyone" and "nobody has enabled push"
    // are the same silence from the client's side and very different problems.
    try {
      await admin.rpc('record_ops_server_events', {
        source: 'push',
        events: [{ kind: 'push_outcome', code: 'no_subscription', count: 1 }],
      })
    } catch { /* never worth a failed response */ }
    return json({ sent: 0, reason: 'no subscriptions' })
  }

  const { data: sender } = await admin
    .from('profiles')
    .select('display_name, username')
    .eq('id', user.id)
    .maybeSingle()
  // M3: the VERB is composed server-side from KINDS, but the SUBJECT is the
  // sender's own display_name, which has no length or content limit in SQL —
  // the 40-char cap was only a React prop. Without this a friend can put
  // "Meera Security — verify at evil.tld" on your lock screen under Meera's
  // own name and icon. Collapse whitespace (newlines split a notification into
  // fake lines) and cut it short.
  const who = ((sender?.display_name?.trim() || sender?.username || 'Someone')
    .replace(/\s+/g, ' ')
    .slice(0, 32)) || 'Someone'

  const spec = KINDS[kind]
  const urgent = spec.urgent
  const payload = JSON.stringify({
    title: 'Meera',
    body: spec.body(who),
    tag: `${spec.tag}:${user.id}`, // per-sender, so two friends don't overwrite each other
    url: '/',
    urgent, // the SW keys ring behaviour off this, not off the tag string
  })

  // H1: `endpoint` is a user-writable column and the anon key is in the bundle,
  // so without this the function is an outbound HTTP client pointed wherever a
  // signed-in user likes — and worse, `vapidHeader(origin)` would mint a JWT
  // signed with VAPID_PRIVATE_KEY whose audience is the attacker's own host and
  // hand it straight to them. A database CHECK enforces the same list; this is
  // the second half, because a constraint added today does not clean rows
  // written yesterday.
  const PUSH_HOSTS = /^([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/

  // Delivery counting. This is the half of the telemetry with no privacy
  // question attached: the function already knows both parties, deliberately
  // records neither, and what goes to the sink is a tally of outcomes with no
  // endpoint, no user and no host in it. Push failing wholesale is otherwise
  // completely invisible — the sender sees a sent message and the recipient's
  // phone simply never rings, which is exactly what a DER-encoded VAPID
  // signature looks like from the outside.
  const outcomes = new Map<string, number>()
  const count = (code: string) => outcomes.set(code, (outcomes.get(code) ?? 0) + 1)

  let sent = 0
  const dead: string[] = []
  // Bounded. One user's device list should never be able to turn one send into
  // thousands of concurrent outbound requests.
  const targets = subs.slice(0, 20)
  const attempted = targets.length
  await Promise.all(targets.map(async (s) => {
    try {
      let origin: string
      try {
        const url = new URL(s.endpoint)
        // A row that fails the host allowlist is one written before the CHECK
        // constraint existed, or an attempt at using this function as an
        // outbound HTTP client. Either is worth seeing a count of; neither is
        // worth recording the host, which is the attacker-supplied half.
        if (url.protocol !== 'https:' || !PUSH_HOSTS.test(url.hostname)) { count('endpoint_refused'); return }
        origin = url.origin
      } catch {
        count('endpoint_invalid')
        return
      }
      const encrypted = await encryptPayload(payload, s.p256dh, s.auth)
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': await vapidHeader(origin),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          // A call ring is worthless if it arrives late; a chat can wait.
          'TTL': urgent ? '60' : '86400',
          'Urgency': urgent ? 'high' : 'normal',
        },
        body: encrypted,
      })
      if (res.ok) { sent++; count('delivered') }
      // 404/410 mean the browser threw this subscription away — so do we,
      // otherwise dead endpoints accumulate and every send retries them forever.
      else if (res.status === 404 || res.status === 410) { dead.push(s.id); count('endpoint_gone') }
      // The status is bucketed, never the body: a push service's error body can
      // echo the endpoint back at you.
      else count(res.status === 401 || res.status === 403 ? 'rejected_auth' : `rejected_http_${res.status}`)
    } catch { count('send_error') /* one bad endpoint must not fail the rest */ }
  }))

  if (dead.length) await admin.from('push_subscriptions').delete().in('id', dead)

  // Best-effort and last, after the real work: a telemetry problem must never
  // turn a delivered notification into a failed response. Nothing is awaited
  // that could change what the caller is told.
  try {
    const events: unknown[] = [{ kind: 'push_attempt', code: 'attempted', count: attempted }]
    for (const [code, n] of outcomes) {
      events.push({ kind: 'push_outcome', code: code.slice(0, 32), count: n })
    }
    await admin.rpc('record_ops_server_events', { source: 'push', events })
  } catch { /* observability is never worth a failed send */ }

  return json({ sent, pruned: dead.length })
})
