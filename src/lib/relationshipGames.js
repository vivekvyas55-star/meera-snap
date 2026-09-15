// The five intimate games — catalogue, turn rule, consent state machine, and
// every sentence this surface says about what it does and does not guarantee.
//
// Pure on purpose: no supabase import, no React. Everything here is a function
// of a session row, its rounds and who is looking, which is what makes the two
// things most likely to go wrong — whose turn it is, and what the photo copy
// claims — testable without a database or a browser.
//
// The calls live in lib/intimate.js, the way lib/together.js sits beside
// lib/togetherState.js and lib/games.js beside lib/gameState.js.

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------
// The ids are the STABLE STRINGS in
// supabase/migrations/202609090026_intimate_games.sql — a live session row
// references one, so renaming what a game is called on screen must never
// orphan a game that is mid-play. `title` is the only display string, and this
// is the one place it lives.
//
// `pose` and `respond` name the SHAPE of each half of a round, and they are
// what stops the screen offering a move the database will refuse:
// pose_intimate_round() and respond_intimate_round() branch on exactly these
// cases, and poseProblem()/respondProblem() below mirror those branches.
export const RELATIONSHIP_GAMES = {
  truth_or_dare: {
    id: 'truth_or_dare',
    title: 'Truth or Dare',
    blurb: 'Write one of each. They choose which to take — or pass, which costs nothing.',
    tint: 'var(--lavender)',
    pose: 'two-options',
    respond: 'pick-and-say',
    promptLabel: 'The truth',
    promptHint: 'A question you would like answered.',
    optionLabel: 'The dare',
    optionHint: 'Something to do. It does not have to involve a camera.',
    picks: [
      { value: 'truth', label: 'Truth' },
      { value: 'dare', label: 'Dare' },
    ],
    responseLabel: 'How it went',
  },
  would_you_rather: {
    id: 'would_you_rather',
    title: 'Would You Rather',
    blurb: 'Two ways an evening could go. They pick one and say why.',
    tint: 'var(--lime)',
    pose: 'two-options',
    respond: 'pick-and-say',
    promptLabel: 'This',
    promptHint: 'The first of the two.',
    optionLabel: 'Or this',
    optionHint: 'The second. Make them both tempting.',
    picks: [
      { value: 'a', label: 'The first' },
      { value: 'b', label: 'The second' },
    ],
    responseLabel: 'Why',
  },
  true_or_made_up: {
    id: 'true_or_made_up',
    title: 'True or Made Up',
    blurb: 'Say something about yourself. They guess whether it really happened.',
    tint: 'var(--coral)',
    pose: 'statement',
    respond: 'pick',
    promptLabel: 'The statement',
    promptHint: 'One line, true or invented.',
    picks: [
      { value: 'real', label: 'Really happened' },
      { value: 'made_up', label: 'Made up' },
    ],
  },
  guess_what: {
    id: 'guess_what',
    title: 'Guess What',
    blurb: 'A close-up, or the same thing in words. Either way is the real game.',
    tint: 'var(--lavender)',
    pose: 'photo-or-words',
    respond: 'guess',
    promptLabel: 'In words',
    promptHint: 'Describe it without naming it.',
    responseLabel: 'Your guess',
  },
  fantasy_builder: {
    id: 'fantasy_builder',
    title: 'One Line Each',
    blurb: 'You write a line, they write the next. Nothing to answer, nothing to win.',
    tint: 'var(--lime)',
    pose: 'line',
    // No responder at all: a line is complete the moment it is written and the
    // turn swaps under the same rule. The database writes these rounds as
    // 'answered' on insert.
    respond: null,
    promptLabel: 'The next line',
    promptHint: 'Pick it up wherever they left it.',
  },
}

export const RELATIONSHIP_GAME_IDS = Object.keys(RELATIONSHIP_GAMES)

export const gameOf = (id) => RELATIONSHIP_GAMES[id] ?? null
// A row always carries a game the database accepted, but a title is rendered
// before the first sync lands. Never guess a different game's title for it —
// that is how the board games ended up flashing a 3x3 grid over a checkers room.
export const titleOf = (id) => RELATIONSHIP_GAMES[id]?.title ?? 'Just us'

// The column limits, restated so a field can stop a paste before the database
// has to reject one. These ARE the CHECK constraints in 0026.
export const PROMPT_MAX = 400
export const OPTION_MAX = 400
export const ANSWER_KEY_MAX = 120
export const RESPONSE_MAX = 600

// ---------------------------------------------------------------------------
// The turn rule
// ---------------------------------------------------------------------------
// ONE expression, and it mirrors public.intimate_turn() exactly:
//
//     turn = the person who did NOT pose the most recent round
//
// It is correct in both phases with no special case. While a round is open,
// "not the poser" is the responder, who owes an answer. Once it is closed,
// "not the poser" is whoever goes next. A pass closes a round the same way an
// answer does, so passing can never strand a turn.
//
// This is the same relationship pieceToMove() has to public.game_turn(): if the
// two drift, the screen offers a move the database refuses, and it reads to the
// user as a board that will not accept the tap it just invited.
export function latestRound(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return null
  return rounds.reduce((best, r) => (best === null || r.seq > best.seq ? r : best), null)
}

export function turnHolder(session, rounds) {
  if (!session) return null
  // Rounds not loaded yet. `turn` is the server's own answer to this exact
  // question (intimate_session_with computes it with intimate_turn), so it is
  // the right thing to fall back to — but only as a fallback: once rounds are
  // in hand the local computation is what keeps the affordances consistent
  // with the list the user is actually looking at.
  if (!Array.isArray(rounds)) return session.turn ?? null
  const last = latestRound(rounds)
  if (!last) return session.opened_by
  return last.poser === session.user_a ? session.user_b : session.user_a
}

// The one round still waiting on an answer. pose_intimate_round() refuses a new
// round while this exists, so there is at most one.
export function openRoundOf(rounds) {
  if (!Array.isArray(rounds)) return null
  return rounds.find((r) => r.status === 'open') ?? null
}

// ---------------------------------------------------------------------------
// The consent state machine
// ---------------------------------------------------------------------------
//   invited -> both_accepted -> active -> ended
//
// Nothing can be posed or answered before both_accepted, and that is a CHECK
// constraint plus a status test in every writer — not a UI convention. So the
// UI must not render a compose affordance in a state the database will refuse.
export function sessionPhase(session, now = Date.now()) {
  if (session === undefined) return 'unknown' // not asked yet
  if (session === null) return 'none' // asked, and there is no live session
  if (session.ended_at || session.status === 'ended') return 'ended'
  if (session.expires_at && Date.parse(session.expires_at) <= now) return 'expired'
  if (session.status === 'invited') return 'invited'
  return session.status === 'both_accepted' ? 'ready' : 'active'
}

// Everything the screen is allowed to offer, in one place.
//
// `rounds` may legitimately be undefined (not loaded). It must never be []
// standing in for a failed load — an empty round list is an ANSWER here ("this
// game has not started"), and the seven bugs CLAUDE.md lists are all a failure
// rendered as one.
export function sessionView(session, rounds, me, now = Date.now()) {
  const phase = sessionPhase(session, now)
  const live = phase === 'ready' || phase === 'active'
  const loaded = Array.isArray(rounds)
  const turn = live ? turnHolder(session, rounds) : null
  const open = live && loaded ? openRoundOf(rounds) : null
  const myTurn = Boolean(turn) && turn === me
  const mine = Boolean(session) && (session.opened_by === me)

  return {
    phase,
    live,
    turn,
    myTurn,
    openRound: open,
    // What this person owes, if anything. Null is a real answer here: it is
    // their move, not yours.
    owe: !live || !loaded || !myTurn ? null : open ? 'answer' : 'prompt',
    canJoin: phase === 'invited' && !mine,
    // I opened it and it is still only an invitation.
    awaitingThem: phase === 'invited' && mine,
    canPose: live && loaded && myTurn && !open,
    canRespond: live && loaded && myTurn && Boolean(open) && open.poser !== me,
    // Passing works on every turn of every game — whether you owe an answer or
    // owe a prompt. It takes no reason and records no count.
    canPass: live && loaded && myTurn,
    // Either party, at any moment, from any state. The control is reachable
    // everywhere because an exit you have to go looking for is not an exit.
    canEnd: phase === 'invited' || live,
    partnerId: session ? (session.user_a === me ? session.user_b : session.user_a) : null,
  }
}

// ---------------------------------------------------------------------------
// What it says on screen
// ---------------------------------------------------------------------------
// `partner` is ALWAYS a rotating alias (see partnerLabel below). This surface
// is the one where a glance at the screen costs the most, so a real name never
// reaches it.
export function statusLine(view, partner) {
  switch (view.phase) {
    case 'unknown':
      return null // not asked yet — say nothing rather than guess
    case 'none':
      return null
    case 'invited':
      return view.awaitingThem ? `Waiting for ${partner} to join.` : `${partner} opened this. It starts when you join.`
    case 'ready':
      // Between joining and the first sync the rounds are not in hand, so the
      // turn can genuinely be unknown for a moment. Saying "they go first" on
      // a guess would be a claim; "both in" is true either way.
      if (!view.turn) return 'Both of you are in.'
      return view.myTurn ? 'Both in. Your move first.' : `Both in. ${partner} goes first.`
    case 'active':
      if (!view.turn) return null
      if (view.owe === 'answer') return 'Your turn to answer.'
      if (view.owe === 'prompt') return 'Your turn to ask.'
      return `Waiting on ${partner}.`
    case 'expired':
      return 'This one ran out. A session stays open for 24 hours.'
    default:
      return null
  }
}

// ended_reason distinguishes three genuinely different things and the UI must
// not flatten them: only one of the three is about how the evening went.
export function endedLine(session, me, partner) {
  if (!session) return null
  // The row could not be read at all — the RLS window had closed by the time we
  // looked, or the request failed. We know it is not open; we do not know which
  // of the three ways it closed, and there is no likeliest one worth pretending
  // to. This is deliberately a DIFFERENT sentence from the one below: "no
  // longer open" is something the row told us, this is something we could not
  // find out.
  if (session.lookup_failed) return 'That session is over. We could not check how it ended.'
  const byMe = session.ended_by === me
  switch (session.ended_reason) {
    case 'declined':
      return byMe ? 'You closed the invitation.' : `${partner} did not take this one up.`
    case 'left':
      return byMe ? 'You ended this.' : `${partner} ended this.`
    case 'expired':
      return 'This one ran out on its own. A session stays open for 24 hours.'
    default:
      // Ended, but we could not learn why. Say that, rather than picking one.
      return 'This session is no longer open.'
  }
}

// The chip under the chat header. Deliberately says nothing about which game,
// what was asked, or who: the whole feature is behind a tap and a passcode, and
// a game's name on the conversation screen is the tell the alias system exists
// to prevent. Null means render nothing.
export function chipLabel(view) {
  if (!view || view.phase === 'unknown' || view.phase === 'none') return null
  if (view.canJoin) return 'Just us · Waiting for you'
  if (view.awaitingThem) return 'Just us · Invited'
  if (view.myTurn && view.live) return 'Just us · Your turn'
  if (view.live) return 'Just us · In play'
  return null
}

// The partner's name, everywhere on this surface.
//
// The rotating alias, never display_name. `alias` is the function from
// useAlias() — it is memoised on the 30-minute bucket, so it is safe in a
// dependency array and must be passed through rather than re-derived.
//
// The fallback is the stable @handle, which is the convention the send/add
// sheets already use for "which person is this". It is NOT a fallback to the
// real name: falling back to the thing the feature exists to hide is the
// failure mode here. There is no pick-a-partner step in this feature — it is
// always opened from inside one conversation — so in practice the handle is
// only ever reached if a profile arrives without a usable name at all.
export function partnerLabel(profile, alias) {
  const a = typeof alias === 'function' ? alias(profile) : null
  if (a && a !== '?') return a
  if (profile?.username) return `@${profile.username}`
  return 'them'
}

// ---------------------------------------------------------------------------
// The photo, and exactly what is promised about it
// ---------------------------------------------------------------------------
// The two-minute window belongs to the DATABASE: intimate_media_readable()
// stops the storage policy minting a URL for the object two minutes after it is
// first opened, and end_intimate_session()/open_intimate_photo() pull the
// object's media_cleanup entry forward so the worker destroys it.
//
// What the database CANNOT do is expire a URL that was already minted. A signed
// URL is a bearer token with its own `exp`; storage does not re-check the
// policy on GET. So a URL minted at second 0 with the app's default one-hour
// TTL would keep serving the bytes long after the promise says it is gone —
// right up until the cleanup worker actually deletes the object, which is up to
// a quarter of an hour later because that is how often it runs.
//
// The client closes the half it owns: mint for exactly the remainder of the
// window and no longer, never put it in the signed-URL cache (which holds a url
// for an hour by design — correct for a snap, actively wrong here), and drop it
// the moment the viewer closes.
//
// What it cannot close is stated in the copy below rather than glossed. This is
// a UI contract, not a security property, and saying otherwise about THIS
// content would be worse than saying it about a snap.
export const PHOTO_WINDOW_MS = 2 * 60 * 1000
// Supabase rejects a zero or negative expiry, and a URL that expires between
// the mint and the first paint is a photo lost to nothing.
export const PHOTO_MIN_TTL_S = 10

// Seconds to mint for: what is left of the two minutes, floored at
// PHOTO_MIN_TTL_S. A round that has never been opened gets the whole window.
export function photoUrlTtl(round, now = Date.now()) {
  const opened = round?.photo_opened_at ? Date.parse(round.photo_opened_at) : null
  if (!opened || Number.isNaN(opened)) return PHOTO_WINDOW_MS / 1000
  const left = PHOTO_WINDOW_MS - (now - opened)
  return Math.max(PHOTO_MIN_TTL_S, Math.round(left / 1000))
}

// Milliseconds left in the window, for the viewer's countdown. Never negative.
export function photoMsLeft(openedAt, now = Date.now()) {
  const opened = openedAt ? Date.parse(openedAt) : null
  if (!opened || Number.isNaN(opened)) return PHOTO_WINDOW_MS
  return Math.max(0, PHOTO_WINDOW_MS - (now - opened))
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// THE COPY IS THE PROMISE, and it has to be exactly true.
//
// It does not say the photo is gone in two minutes, because that is not what
// the system does. It says what each half actually guarantees: the link this
// app hands out stops working, the file is removed on the cleanup worker's own
// schedule, and neither of those is a defence against a screenshot.
export const PHOTO_PROMISE =
  'They can open it once. The link their app is given stops working two minutes ' +
  'later, and the file is deleted from the server by a cleanup job that runs ' +
  'every fifteen minutes. Neither of those stops a screenshot — this is a ' +
  'promise between the two of you, not a lock.'

export const PHOTO_PROMISE_SHORT =
  'One view. This link stops working in two minutes; the file is deleted from ' +
  'the server within about fifteen. A screenshot is still possible.'

// ---------------------------------------------------------------------------
// Mirrors of what the writers will accept
// ---------------------------------------------------------------------------
// pose_intimate_round() branches per game and raises a specific message for
// each missing piece. These return the SAME condition so the button is disabled
// rather than the round being refused after the fact — and so the reason is on
// screen before the tap, not after it.
const trimmed = (v) => String(v ?? '').trim()

export function poseProblem(gameId, draft = {}) {
  const spec = gameOf(gameId)
  if (!spec) return 'Unknown game'
  const prompt = trimmed(draft.prompt)
  const optionB = trimmed(draft.optionB)
  const answerKey = trimmed(draft.answerKey)

  if (prompt.length > PROMPT_MAX) return `Keep it under ${PROMPT_MAX} characters.`
  if (optionB.length > OPTION_MAX) return `Keep it under ${OPTION_MAX} characters.`
  if (answerKey.length > ANSWER_KEY_MAX) return `Keep that under ${ANSWER_KEY_MAX} characters.`

  switch (spec.pose) {
    case 'two-options':
      return prompt && optionB ? null : 'Both options are needed'
    case 'statement':
      if (!prompt) return 'Write a statement first'
      return draft.secretTruth === true || draft.secretTruth === false ? null : 'Mark whether it is real'
    case 'line':
      return prompt ? null : 'Write the next line first'
    case 'photo-or-words':
      // A photo OR a written clue — the database accepts either, and the
      // camera-off route is a first-class way to play, not a degraded one.
      if (!draft.mediaPath && !prompt) return 'Add a photo, or describe it in words'
      return answerKey ? null : 'Say what it is, so they can be told after they guess'
    default:
      return 'Unknown game'
  }
}

export function respondProblem(gameId, draft = {}) {
  const spec = gameOf(gameId)
  if (!spec) return 'Unknown game'
  const pick = trimmed(draft.pick)
  const response = trimmed(draft.response)
  if (response.length > RESPONSE_MAX) return `Keep it under ${RESPONSE_MAX} characters.`

  switch (spec.respond) {
    case 'pick-and-say':
      if (!spec.picks.some((p) => p.value === pick)) {
        return gameId === 'truth_or_dare' ? 'Pick truth or dare' : 'Pick one of the two'
      }
      return response ? null : gameId === 'truth_or_dare' ? 'Say how it went' : 'Say why'
    case 'pick':
      return spec.picks.some((p) => p.value === pick) ? null : 'Guess real or made up'
    case 'guess':
      return response ? null : 'Write your guess'
    default:
      return 'That round is already finished'
  }
}

// How a closed round reads back in the list. `secret_truth` and `answer_key`
// only arrive from intimate_rounds_of() once the round is closed (or to the
// person who wrote it), so this never has to hide anything itself — but it must
// not invent a reveal when the field is simply absent.
export function pickLabel(gameId, pick) {
  const spec = gameOf(gameId)
  return spec?.picks?.find((p) => p.value === pick)?.label ?? null
}

export function revealLine(gameId, round) {
  if (!round || round.status !== 'answered') return null
  if (gameId === 'true_or_made_up') {
    if (round.secret_truth === null || round.secret_truth === undefined) return null
    const truth = round.secret_truth ? 'real' : 'made up'
    const right = (round.pick === 'real') === round.secret_truth
    return `It was ${truth} — ${right ? 'guessed right' : 'guessed wrong'}.`
  }
  if (gameId === 'guess_what' && round.answer_key) return `It was ${round.answer_key}.`
  return null
}
