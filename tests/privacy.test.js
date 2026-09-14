// @vitest-environment node
import { beforeAll, expect, test, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import fs from 'node:fs'

// lib/privacy.js and lib/devices.js both import the Supabase client, which
// builds a real one at module load and reaches for localStorage. Nothing here
// calls it — the pure helpers are the point, and the boundary is tested
// against Postgres directly.
vi.mock('../src/lib/supabase', () => ({ supabase: {} }))

import {
  DELETION_LOSES,
  LOCATION_DURATIONS,
  activeChoice,
  describeExpiry,
  describeDeletion,
  EXPORT_INCLUDES,
  EXPORT_EXCLUDES,
  formatBytes,
} from '../src/lib/privacy'
import { deviceLabel } from '../src/lib/devices'

// ===========================================================================
// Pure bits first — no database needed.
// ===========================================================================
test('a device label survives the user agents that lie about themselves', () => {
  // Edge claims Chrome AND Safari; Chrome claims Safari; Chrome on iOS is
  // CriOS. Test the most specific claim first or every browser is "Safari".
  expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Edg/120')).toBe('Windows · Edge')
  expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36')).toBe('Android · Chrome')
  expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 (KHTML, like Gecko) CriOS/120 Mobile/15E148 Safari/604')).toBe('iPhone · Chrome')
  expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
  expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 (KHTML, like Gecko) Version/17 Safari/605')).toBe('Mac · Safari')
  // Never blank, never longer than the column's check constraint.
  expect(deviceLabel('')).toBe('Unknown device')
  expect(deviceLabel('x'.repeat(500)).length).toBeLessThanOrEqual(60)
})

test('storage sizes read the way a phone reports them', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(999)).toBe('999 B')
  expect(formatBytes(1500)).toBe('1.5 kB')
  expect(formatBytes(250_000_000)).toBe('250 MB')
  expect(formatBytes(2_400_000_000)).toBe('2.4 GB')
  // A failed read is not zero bytes. Rendering "0 B" for "we don't know" is
  // the same class of lie as the fake session list this screen refuses to draw.
  expect(formatBytes(null)).toBe(null)
  expect(formatBytes(undefined)).toBe(null)
})

test('the sharing countdown never promises time that is gone', () => {
  const now = Date.parse('2026-09-08T12:00:00Z')
  expect(describeExpiry(null, now)).toBe('Until you turn it off')
  expect(describeExpiry('2026-09-08T11:59:00Z', now)).toBe('Sharing has stopped')
  expect(describeExpiry('2026-09-08T12:30:00Z', now)).toBe('Stops in 30 minutes')
  expect(describeExpiry('2026-09-08T13:00:00Z', now)).toBe('Stops in 1 hour')
  expect(describeExpiry('2026-09-08T19:45:00Z', now)).toBe('Stops in 7h 45m')
})

test('exactly one duration chip is lit at a time', () => {
  const now = Date.parse('2026-09-08T12:00:00Z')
  expect(activeChoice(null, now)).toBe(null)
  expect(activeChoice('2026-09-08T12:40:00Z', now)).toBe(1)
  // Half an 8-hour share still has under an hour left at the end; the smallest
  // matching window wins or two chips light at once.
  expect(activeChoice('2026-09-08T19:00:00Z', now)).toBe(8)
  expect(activeChoice('2026-09-08T11:00:00Z', now)).toBe(undefined)
  expect(LOCATION_DURATIONS.map((d) => d.hours)).toEqual([1, 8, null])
})

test('the deletion copy names the thing people do not expect', () => {
  // Messages are stored once per PAIR with ON DELETE CASCADE on both halves,
  // so deleting your account takes the conversation away from the other person
  // too. If that line ever disappears from the confirm step, this fails.
  expect(DELETION_LOSES.join(' ')).toMatch(/for the other person/i)
  expect(DELETION_LOSES.join(' ')).toMatch(/username becomes free/i)
})

// ===========================================================================
// The security boundary, against real Postgres.
//
// Blocking is only worth anything if the DATABASE refuses the write. A client
// that hides a blocked person is a client one devtools console away from not
// hiding them, so these run every policy as the actual role, through RLS.
// ===========================================================================
const A = '00000000-0000-4000-8000-0000000000a1' // blocker
const B = '00000000-0000-4000-8000-0000000000b2' // blocked
const C = '00000000-0000-4000-8000-0000000000c3' // uninvolved third party

let db
const query = async (sql, args = []) => (await db.query(sql, args)).rows

async function asUser(id, fn) {
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [id])
  await db.exec('set role authenticated')
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { citext, pgcrypto } })
  // The same managed-platform stubs tests/database.mjs uses. Duplicated rather
  // than imported because that harness is a script, not a module, and is owned
  // elsewhere.
  await db.exec(`
   create role anon; create role authenticated; create role service_role bypassrls;
   create schema auth; create schema storage; create schema realtime;
   create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', encrypted_password text, updated_at timestamptz);
   create table auth.sessions(id uuid primary key, user_id uuid);
   create table auth.refresh_tokens(user_id text);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema auth to authenticated,anon;
   create table storage.buckets(id text primary key,name text,public boolean);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
   alter table storage.objects enable row level security;
   create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
   create table realtime.messages(topic text,extension text);
   alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
   create publication supabase_realtime;
   create schema if not exists extensions;
   create schema if not exists vault;
   create schema if not exists net;
   create table vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
   create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
   create function vault.create_secret(secret text, name text default null, description text default '') returns uuid
     language sql as $$ insert into vault.secrets(name,secret,description) values(name,secret,description) returning id $$;
   create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `)
  // The baseline installs real citext/pgcrypto and must keep its CREATE
  // EXTENSION lines; the follow-up chain has pg_net, which PGlite does not
  // have, and the rest of that file still has to run. Same split as
  // tests/database.mjs.
  const BASE = new Set(['202609060000_baseline.sql', '202609060001_audit_fixes.sql'])
  for (const file of fs.readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8')
    await db.exec(BASE.has(file) ? sql : sql.replace(/create extension[^;]*;/gi, ''))
  }
  await db.query(
    `insert into auth.users(id,email) values($1,'anna@meera.local'),($2,'bruno@meera.local'),($3,'cara@meera.local')`,
    [A, B, C]
  )
  await db.query(
    `insert into public.friendships(user_a,user_b,requested_by,status)
     select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$1,'accepted'`,
    [A, B]
  )
}, 120_000)

test('a blocked account cannot send a message, and the block is refused by the database', async () => {
  // Baseline: while they are friends, B can write to the pair.
  await asUser(B, async () => {
    await query(
      `insert into public.messages(user_a,user_b,sender_id,kind,body)
       select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$2,'chat','before the block'`,
      [A, B]
    )
  })

  await asUser(A, () => query('select public.block_user($1)', [B]))

  // Blocking drops the friendship, because stories, presence, the private call
  // signaling topics and the push relay all gate on an accepted friendship —
  // a block that left the row would stop the texts and let the phone ring.
  expect((await query('select count(*)::int n from public.friendships'))[0].n).toBe(0)

  await asUser(B, async () => {
    await expect(
      query(
        `insert into public.messages(user_a,user_b,sender_id,kind,body)
         select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$2,'chat','after the block'`,
        [A, B]
      )
    ).rejects.toThrow()
  })

  // And the blocker cannot message them either — a block is a wall, not a mute.
  await asUser(A, async () => {
    await expect(
      query(
        `insert into public.messages(user_a,user_b,sender_id,kind,body)
         select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$1,'chat','still blocked'`,
        [A, B]
      )
    ).rejects.toThrow()
  })
})

test('a blocked account cannot get back in through a friend request', async () => {
  await asUser(B, async () => {
    await expect(
      query(
        `insert into public.friendships(user_a,user_b,requested_by,status)
         select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$2,'pending'`,
        [A, B]
      )
    ).rejects.toThrow()
  })
  // Symmetric on purpose: the blocker cannot accidentally re-add them either.
  // Unblocking is the deliberate act that reopens the door.
  await asUser(A, async () => {
    await expect(
      query(
        `insert into public.friendships(user_a,user_b,requested_by,status)
         select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$1,'pending'`,
        [A, B]
      )
    ).rejects.toThrow()
  })
})

test('a block list is private, and blocked_between is not an oracle', async () => {
  // B must not be able to read A's block row...
  await asUser(B, async () => {
    expect((await query('select count(*)::int n from public.blocks'))[0].n).toBe(0)
  })
  // ...and C, who is not part of the pair, gets false rather than an answer
  // about two other people's relationship.
  await asUser(C, async () => {
    expect((await query('select public.blocked_between($1,$2) v', [A, B]))[0].v).toBe(false)
  })
  await asUser(A, async () => {
    expect((await query('select public.blocked_between($1,$2) v', [A, B]))[0].v).toBe(true)
    expect((await query('select count(*)::int n from public.list_my_blocks()'))[0].n).toBe(1)
  })
})

test('unblocking is a delete, and lets a friendship be offered again', async () => {
  await asUser(A, () => query('select public.unblock_user($1)', [B]))
  await asUser(A, async () => {
    expect((await query('select count(*)::int n from public.blocks'))[0].n).toBe(0)
    await query(
      `insert into public.friendships(user_a,user_b,requested_by,status)
       select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$1,'pending'`,
      [A, B]
    )
  })
  // Only the RECIPIENT may accept — guard_friendship_update raises otherwise —
  // so the acceptance runs as B, the way it does in the app.
  await asUser(B, () => query(`update public.friendships set status='accepted'`))
})

test('an elapsed location share is invisible to the friend AND to its owner', async () => {
  await asUser(A, () =>
    query('insert into public.locations(user_id,lat,lng,sharing) values($1,12.9,77.6,true)', [A])
  )
  await asUser(B, async () => {
    expect((await query('select count(*)::int n from public.locations'))[0].n).toBe(1)
  })

  await asUser(A, async () => {
    const until = (await query('select public.set_location_expiry($1) t', [1]))[0].t
    expect(until).toBeTruthy()
  })
  // Time travel. The rule has to be in the POLICY — a client-side filter is a
  // promise kept by the app, which is the wrong party to be keeping it.
  await db.query(`update public.locations set expires_at = now() - interval '1 minute'`)

  await asUser(B, async () => {
    expect((await query('select count(*)::int n from public.locations'))[0].n).toBe(0)
  })
  await asUser(A, async () => {
    expect((await query('select count(*)::int n from public.locations'))[0].n).toBe(0)
    // The definer state function is how the owner can still be told; it deletes
    // the spent row on the way past, so no coordinates linger.
    expect((await query('select count(*)::int n from public.location_sharing_state()'))[0].n).toBe(0)
  })
  expect((await query('select count(*)::int n from public.locations'))[0].n).toBe(0)
})

test('re-sharing after an expiry does not leave you invisible with the switch on', async () => {
  // The trap: Snap Map's Share upserts lat/lng/sharing and never touches
  // expires_at, so a stale timestamp would survive the re-share and the user
  // would be hidden while the app said they were sharing.
  await asUser(A, () =>
    query(
      `insert into public.locations(user_id,lat,lng,sharing,expires_at)
       values($1,12.9,77.6,true, now() - interval '1 hour')`,
      [A]
    )
  )
  expect((await query('select expires_at from public.locations where user_id=$1', [A]))[0].expires_at).toBe(null)
  await asUser(B, async () => {
    expect((await query('select count(*)::int n from public.locations'))[0].n).toBe(1)
  })

  // locations_write was FOR ALL and is now three separate policies. Snap Map's
  // Share button sends an UPSERT — supabase-js turns that into ON CONFLICT DO
  // UPDATE, which needs the insert AND update policies to agree even on a
  // conflicting row. Asserting the exact shape, because "the policy looks
  // right" has already shipped a broken write in this project once.
  await asUser(A, () =>
    query(
      `insert into public.locations(user_id,lat,lng,sharing,updated_at) values($1,13.0,77.7,true,now())
       on conflict (user_id) do update
       set lat=excluded.lat, lng=excluded.lng, sharing=excluded.sharing, updated_at=excluded.updated_at`,
      [A]
    )
  )
  expect(Number((await query('select lat from public.locations where user_id=$1', [A]))[0].lat)).toBe(13)
})

test('storage usage is scoped to the caller and cannot be pointed at anyone else', async () => {
  await db.query(
    `insert into storage.objects(bucket_id,name,metadata) values
      ('media',$1,jsonb_build_object('size',1000)),
      ('media',$2,jsonb_build_object('size',3000)),
      ('media',$3,jsonb_build_object('size',9999999))`,
    [`${A}/snaps/one.jpg`, `${A}/stories/two.jpg`, `${B}/snaps/theirs.jpg`]
  )
  await asUser(A, async () => {
    const row = (await query('select * from public.my_storage_usage()'))[0]
    expect(Number(row.bytes)).toBe(4000)
    expect(row.objects).toBe(2)
    expect(Number(row.snap_bytes)).toBe(1000)
    expect(Number(row.story_bytes)).toBe(3000)
  })
  // No argument means no way to ask about someone else. That is the whole
  // design of the function, so it is worth asserting the signature.
  await asUser(A, async () => {
    await expect(query('select * from public.my_storage_usage($1)', [B])).rejects.toThrow()
  })
})

test('devices are own-rows-only', async () => {
  await asUser(A, () =>
    query(`insert into public.user_devices(user_id,device_key,label) values($1,'k1','iPhone · Safari')`, [A])
  )
  await asUser(B, async () => {
    expect((await query('select count(*)::int n from public.user_devices'))[0].n).toBe(0)
    // Nor can B plant a row against A's account.
    await expect(
      query(`insert into public.user_devices(user_id,device_key,label) values($1,'k2','x')`, [A])
    ).rejects.toThrow()
  })
})

test('an export carries what you wrote and not what was written to you', async () => {
  await asUser(A, () =>
    query(
      `insert into public.messages(user_a,user_b,sender_id,kind,body)
       select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$1,'chat','from anna'`,
      [A, B]
    )
  )
  await asUser(B, () =>
    query(
      `insert into public.messages(user_a,user_b,sender_id,kind,body)
       select (public.pair_key($1,$2))[1],(public.pair_key($1,$2))[2],$2,'chat','from bruno'`,
      [A, B]
    )
  )
  const dump = await asUser(A, async () => (await query('select public.export_my_data() d'))[0].d)
  const bodies = dump.messages_sent.map((m) => m.body)
  expect(bodies).toContain('from anna')
  // Ephemerality is a promise made on the SENDER's behalf. Putting their
  // messages into a permanent file the recipient can show anyone would undo it
  // quietly, which is the worst way to undo something.
  expect(bodies).not.toContain('from bruno')
  expect(dump.account.username).toBe('anna')
  expect(JSON.stringify(dump)).not.toMatch(/answer_hash/)
  expect(dump.notes.join(' ')).toMatch(/not included/i)
})

test('deleting an account takes the rows with it', async () => {
  await asUser(A, () => query('select public.delete_my_account()'))
  expect((await query('select count(*)::int n from public.profiles where id=$1', [A]))[0].n).toBe(0)
  expect((await query('select count(*)::int n from auth.users where id=$1', [A]))[0].n).toBe(0)
  // Messages are pair-keyed with ON DELETE CASCADE on both halves, so the
  // conversation goes for the other person too — which is exactly why the
  // confirm step has to say so out loud.
  expect((await query('select count(*)::int n from public.messages'))[0].n).toBe(0)
  expect((await query('select count(*)::int n from public.user_devices'))[0].n).toBe(0)
  // The bucket objects are queued for the cleanup worker rather than orphaned:
  // deleting the storage.objects row would leave the file in the bucket.
  expect(
    (await query(`select count(*)::int n from public.media_cleanup where path like $1`, [`${A}/%`]))[0].n
  ).toBe(2)
})

test('a scheduled deletion is described by its date, and an overdue one says so', () => {
  const now = Date.parse('2026-09-14T12:00:00Z')
  expect(describeDeletion(null, now)).toBe(null)
  expect(describeDeletion('not a date', now)).toBe(null)

  // The date is what a person can act on. It is read off the server rather
  // than counted down locally, so a phone with a wrong clock cannot invent a
  // deadline of its own.
  expect(describeDeletion('2026-09-21T12:00:00Z', now)).toMatch(/^Your account is deleted in 7 days, on /)
  expect(describeDeletion('2026-09-15T12:00:00Z', now)).toMatch(/^Your account is deleted tomorrow, on /)
  expect(describeDeletion('2026-09-14T18:00:00Z', now)).toMatch(/^Your account is deleted today, on /)

  // Calendar days, not elapsed milliseconds: a seven-day grace period must not
  // read as "in 6 days" one millisecond after it starts, and "tomorrow" must
  // never sit next to a date that says today.
  expect(describeDeletion(now + 7 * 86400000 - 1, now)).toMatch(/in 7 days/)
  const soon = describeDeletion(now + 13 * 3600000, now)
  expect(soon).toMatch(/tomorrow/)
  expect(soon).toMatch(/15 September 2026|September 15, 2026/)

  // A purge date in the past means the scheduled job has not run — see
  // operations/schedule_account_purge.sql. It must not render as a date in the
  // future and it must not claim the account is gone, because it is not.
  expect(describeDeletion('2026-09-13T12:00:00Z', now)).toMatch(/overdue/i)
})

test('the export names its exclusions, and they are the ones the SQL actually makes', () => {
  // These lists are a claim about other people's privacy as much as the
  // user's own. Keeping them beside the RPC wrapper is what stops the screen
  // and the SQL drifting apart.
  expect(EXPORT_EXCLUDES.join(' ')).toMatch(/Messages anyone sent you/i)
  expect(EXPORT_EXCLUDES.join(' ')).toMatch(/photos, videos and voice recordings themselves/i)
  expect(EXPORT_EXCLUDES.join(' ')).toMatch(/Questions of the day/i)
  expect(EXPORT_INCLUDES.join(' ')).toMatch(/Every message you sent/i)
  // Nothing may appear in both halves; an item that does is a contradiction
  // the reader has to resolve on a privacy screen.
  for (const line of EXPORT_INCLUDES) expect(EXPORT_EXCLUDES).not.toContain(line)
})
