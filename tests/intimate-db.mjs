import assert from 'node:assert/strict'
// The client's own turn mirror, checked against the SQL below rather than by
// inspection — the same differential habit the checkers rules are held to.
import { turnHolder } from '../src/lib/relationshipGames.js'

// Intimate games (202609090026). The migration is deliberately shelved from
// production, so this harness is the ONLY thing that has ever executed it —
// and the invariants below are exactly the ones a client can silently
// contradict while every screen still looks right.
//
// Split out of database.mjs only for length; it runs inside the same PGlite
// instance, as the same three real users, in the same order.
export async function checkIntimateGames({ db, query, asUser, A, B, C }) {
  const turnOf = async (sess) => (await query('select public.intimate_turn($1) t', [sess]))[0].t
  const roundsOf = async (sess) => query('select * from public.intimate_rounds_of($1)', [sess])
  const liveWith = async (other) => (await query('select * from public.intimate_session_with($1)', [other]))[0]

  // The SAME function the screen uses. If these two ever disagree the UI offers
  // a move the database refuses, which reads to the user as a screen that will
  // not accept the tap it just invited — what pieceToMove() exists to prevent
  // for the board games, for the same reason.
  const agree = async (sess, row, rounds, where) => {
    const sql = await turnOf(sess)
    assert.equal(turnHolder(row, rounds), sql, `client and SQL disagree about whose turn it is: ${where}`)
    return sql
  }

  let sess
  await asUser(A, async () => {
    sess = (await query("select id from public.start_intimate_session($1,'truth_or_dare')", [B]))[0].id
    // Idempotent: a double tap hands back the same room, never a second one.
    assert.equal((await query("select id from public.start_intimate_session($1,'truth_or_dare')", [B]))[0].id, sess)
    // CONSENT IS A GATE, not a rendering. Nothing before both_accepted.
    await assert.rejects(query("select public.pose_intimate_round($1,'a','b')", [sess]), /Both of you have to join/)
    await assert.rejects(query('select public.pass_intimate_turn($1)', [sess]), /Both of you have to join/)
    // Only the invitee can give the second opt-in — that is what makes "both
    // of you opted in" a fact rather than something the screen claims.
    await assert.rejects(query('select public.join_intimate_session($1)', [sess]), /You opened this one/)
  })

  // A stranger gets nothing, through any door — including the table's own SELECT.
  await asUser(C, async () => {
    await assert.rejects(query('select public.join_intimate_session($1)', [sess]), /not open to you/)
    await assert.rejects(query('select public.pose_intimate_round($1)', [sess]), /not open to you/)
    await assert.rejects(query('select public.end_intimate_session($1)', [sess]), /not open to you/)
    assert.equal((await query('select count(*)::int n from public.intimate_sessions where id=$1', [sess]))[0].n, 0)
  })

  await asUser(B, () => query('select public.join_intimate_session($1)', [sess]))

  // The turn rule — "the person who did NOT pose the most recent round" —
  // checked against the client mirror at every step, including both passes.
  await asUser(A, async () => {
    assert.equal(await agree(sess, await liveWith(B), await roundsOf(sess), 'nobody has moved'), A)
    await assert.rejects(query("select public.pose_intimate_round($1,'a')", [sess]), /Both options are needed/)
    await query("select public.pose_intimate_round($1,'A truth','A dare')", [sess])
    assert.equal((await liveWith(B)).status, 'active') // first move: both_accepted -> active
    const rounds = await roundsOf(sess)
    assert.equal(await agree(sess, await liveWith(B), rounds, 'an open round'), B)
    // The turn check comes first, so posing twice is refused as "not your
    // turn" — the open-round guard is what the RESPONDER runs into (below).
    await assert.rejects(query("select public.pose_intimate_round($1,'x','y')", [sess]), /not your turn/)
    await assert.rejects(query("select public.respond_intimate_round($1,'truth','mine')", [rounds[0].id]), /theirs to answer/)
  })

  await asUser(B, async () => {
    const rounds = await roundsOf(sess)
    // B holds the turn and owes an answer, so this gets past the turn check and
    // onto the one that stops two questions being open at once.
    await assert.rejects(query("select public.pose_intimate_round($1,'x','y')", [sess]), /still a round waiting/)
    await assert.rejects(query("select public.respond_intimate_round($1,'a','x')", [rounds[0].id]), /Pick truth or dare/)
    await query("select public.respond_intimate_round($1,'dare','Did it')", [rounds[0].id])
    // A CLOSED round leaves the turn in the same place — no special case.
    assert.equal(await agree(sess, await liveWith(A), await roundsOf(sess), 'a closed round'), B)
    await query("select public.pose_intimate_round($1,'Theirs','Or theirs')", [sess])
    assert.equal(await agree(sess, await liveWith(A), await roundsOf(sess), 'B asked'), A)
  })

  // Passing, on both kinds of turn. Neither costs anything and neither can
  // strand a turn.
  await asUser(A, async () => {
    await query('select public.pass_intimate_turn($1)', [sess])
    const rounds = await roundsOf(sess)
    assert.equal(rounds.at(-1).status, 'passed')
    assert.equal(await agree(sess, await liveWith(B), rounds, 'A passed on answering'), A)
    // Passing on the turn to ASK writes an empty round, so the one expression
    // carries it across with no special case there either.
    await query('select public.pass_intimate_turn($1)', [sess])
    const after = await roundsOf(sess)
    assert.equal(after.at(-1).poser, A)
    assert.equal(after.at(-1).prompt, null)
    assert.equal(await agree(sess, await liveWith(B), after, 'A passed on asking'), B)
  })

  // Nothing anywhere counts a pass: the columns simply do not exist, and a
  // counter would have to arrive as one before it could arrive as a behaviour.
  const cols = (await query(
    "select column_name from information_schema.columns where table_name in ('intimate_sessions','intimate_rounds')"
  )).map((r) => r.column_name)
  assert.ok(
    !cols.some((c) => /pass(es)?_(count|used|left)|streak|score|tally/.test(c)),
    'a pass counter appeared in the schema'
  )

  // Ending: reachable from a live game, derives its own reason, repeats safely.
  await asUser(B, async () => {
    const ended = (await query('select * from public.end_intimate_session($1)', [sess]))[0]
    assert.equal(ended.ended_reason, 'left')
    assert.equal(ended.ended_by, B)
    const again = (await query('select * from public.end_intimate_session($1)', [sess]))[0]
    assert.equal(String(again.ended_at), String(ended.ended_at))
    // It leaves intimate_session_with(), but the ROW stays readable — which is
    // the only way a screen can say WHICH of declined/left/expired happened
    // rather than the session simply vanishing under the person in it.
    assert.equal((await query('select * from public.intimate_session_with($1)', [A])).length, 0)
    assert.equal((await query('select ended_reason from public.intimate_sessions where id=$1', [sess]))[0].ended_reason, 'left')
    // The RPCs are the only way in: the table carries no write grant at all.
    await assert.rejects(query("update public.intimate_sessions set status='active' where id=$1", [sess]), /permission denied/)
    await assert.rejects(
      query("insert into public.intimate_sessions(user_a,user_b,game,opened_by) values($1,$2,'guess_what',$2)", [A, B]),
      /permission denied/
    )
  })

  // 'declined' must stay distinguishable from 'left'. Only one of the three
  // ways a session ends is about how the evening went.
  await asUser(A, () => query("select public.start_intimate_session($1,'true_or_made_up')", [B]))
  await asUser(B, async () => {
    const s2 = await liveWith(A)
    assert.equal((await query('select ended_reason from public.end_intimate_session($1)', [s2.id]))[0].ended_reason, 'declined')
  })

  // The reveal rule hides COLUMNS of a row you are otherwise entitled to,
  // which is why intimate_rounds has no policy and reads go through a function.
  let s3
  await asUser(A, async () => {
    s3 = (await query("select id from public.start_intimate_session($1,'true_or_made_up')", [B]))[0].id
  })
  await asUser(B, () => query('select public.join_intimate_session($1)', [s3]))
  await asUser(A, async () => {
    await assert.rejects(query("select public.pose_intimate_round($1,'I kept something of yours')", [s3]), /Mark whether it is real/)
    await query("select public.pose_intimate_round($1,'I kept something of yours',null,null,null,true)", [s3])
    assert.equal((await roundsOf(s3))[0].secret_truth, true) // the writer always sees their own
  })
  await asUser(B, async () => {
    assert.equal((await roundsOf(s3))[0].secret_truth, null) // the guesser does not, while it is open
    await query("select public.respond_intimate_round($1,'made_up')", [(await roundsOf(s3))[0].id])
    assert.equal((await roundsOf(s3))[0].secret_truth, true) // ...and does once it is closed
  })
  await asUser(A, () => query('select public.end_intimate_session($1)', [s3]))
  console.log('PASS intimate games: consent gates, the turn rule mirrored by the client, and a pass that costs nothing')

  // -------------------------------------------------------------------------
  // The single-view photo, and camera-off as an equal way to play
  // -------------------------------------------------------------------------
  const intimatePath = `${A}/intimate/close-up.jpg`
  let s4
  let photoRound
  await asUser(A, async () => {
    s4 = (await query("select id from public.start_intimate_session($1,'guess_what')", [B]))[0].id
    // The prefix allowlist is the whole reason 202609090031 exists: without it
    // this raises, and the obvious workaround — uploading under snaps/ — gets
    // the object collected out from under a live session 24 hours later.
    await query('select public.queue_media_cleanup($1)', [intimatePath])
  })
  await db.query("insert into storage.objects(bucket_id,name) values('media',$1)", [intimatePath])
  await asUser(B, () => query('select public.join_intimate_session($1)', [s4]))

  await asUser(A, async () => {
    // A written clue alone is a complete round. The camera-free route is a
    // first-class way to play this game, not a degraded one.
    await assert.rejects(query("select public.pose_intimate_round($1,'Small and blue')", [s4]), /Say what it is/)
    // A round cannot name somebody else's object — checked while it is still
    // A's turn, since the turn guard runs before the media guard.
    await assert.rejects(
      query("select public.pose_intimate_round($1,null,null,$2,'a mug')", [s4, `${B}/intimate/theirs.jpg`]),
      /must belong to the sender/
    )
    // Nor one of the caller's own DURABLE objects: without the shape check a
    // round could drag a memories/ or stories/ file onto this surface's
    // two-minute accelerated expiry.
    await assert.rejects(
      query("select public.pose_intimate_round($1,null,null,$2,'a mug')", [s4, `${A}/memories/keep.jpg`]),
      /must belong to the sender/
    )
    await query("select public.pose_intimate_round($1,'Small and blue',null,null,'a mug')", [s4])
  })
  await asUser(B, async () => {
    await query("select public.respond_intimate_round($1,null,'your mug')", [(await roundsOf(s4)).at(-1).id])
    // Answering hands B the turn to ask; passing it back is what puts A in a
    // position to send the photo, and costs nothing to do.
    await query('select public.pass_intimate_turn($1)', [s4])
  })
  await asUser(A, async () => {
    await query("select public.pose_intimate_round($1,null,null,$2,'the lamp')", [s4, intimatePath])
    const last = (await roundsOf(s4)).at(-1)
    photoRound = last.id
    // intimate_rounds_of NEVER returns media_path — single-view is structural,
    // not client politeness — and the poser is refused the one route that does.
    assert.ok(!Object.keys(last).includes('media_path'))
    assert.equal(last.has_photo, true)
    await assert.rejects(query('select public.open_intimate_photo($1)', [photoRound]), /opens once, for them/)
  })
  await asUser(B, async () => {
    assert.equal((await query('select public.intimate_media_readable($1) ok', [intimatePath]))[0].ok, true)
    assert.equal((await query('select public.open_intimate_photo($1) p', [photoRound]))[0].p, intimatePath)
    // A repeat inside the window is a dropped response or a rotated screen, not
    // a second viewing.
    assert.equal((await query('select public.open_intimate_photo($1) p', [photoRound]))[0].p, intimatePath)
  })

  // Opening brings the object's cleanup forward to two minutes, not the 24h default.
  const due = (await query('select due_at from public.media_cleanup where path=$1', [intimatePath]))[0].due_at
  const ahead = new Date(due).getTime() - Date.now()
  assert.ok(ahead > 60_000 && ahead < 180_000, `expected the photo due in ~2 minutes, got ${Math.round(ahead / 1000)}s`)
  // While it is still readable the worker must NOT take it.
  assert.equal((await query('select public.claim_media_cleanup($1) c', [intimatePath]))[0].c, false)

  // Past the window: unreadable, un-mintable AND collectable. Those two have to
  // flip at the same moment, or the object outlives the promise made about it.
  await db.query("update public.intimate_rounds set photo_opened_at=now()-interval '3 minutes' where id=$1", [photoRound])
  await asUser(B, async () => {
    assert.equal((await query('select public.intimate_media_readable($1) ok', [intimatePath]))[0].ok, false)
    await assert.rejects(query('select public.open_intimate_photo($1)', [photoRound]), /already been seen/)
  })
  await db.query("update public.media_cleanup set due_at=now()-interval '1 second' where path=$1", [intimatePath])
  assert.equal((await query('select public.claim_media_cleanup($1) c', [intimatePath]))[0].c, true)
  await asUser(B, () => query('select public.end_intimate_session($1)', [s4]))
  console.log('PASS intimate photos open once, then stop being readable and become collectable at the same moment')
}
