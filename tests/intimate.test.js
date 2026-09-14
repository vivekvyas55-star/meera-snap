import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  PHOTO_MIN_TTL_S, PHOTO_PROMISE, PHOTO_PROMISE_SHORT, PHOTO_WINDOW_MS,
  RELATIONSHIP_GAMES, RELATIONSHIP_GAME_IDS,
  chipLabel, endedLine, formatCountdown, partnerLabel, photoMsLeft, photoUrlTtl,
  poseProblem, respondProblem, revealLine, sessionPhase, sessionView, statusLine,
  turnHolder,
} from '../src/lib/relationshipGames'

const MIGRATION = readFileSync('supabase/migrations/202609090026_intimate_games.sql', 'utf8')
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const soon = () => new Date(Date.now() + 3600_000).toISOString()

const session = (over = {}) => ({
  id: 's1', user_a: A, user_b: B, game: 'truth_or_dare',
  opened_by: A, joined_by: B, status: 'active',
  ended_at: null, ended_by: null, ended_reason: null,
  expires_at: soon(), ...over,
})
const round = (seq, poser, over = {}) => ({
  id: `r${seq}`, seq, poser, prompt: 'p', option_b: 'o', status: 'answered',
  has_photo: false, photo_opened_at: null, pick: null, response: null,
  passed_by: null, answer_key: null, secret_truth: null, ...over,
})

// ---------------------------------------------------------------------------
// The catalogue must not drift from the ids a live session row can hold
// ---------------------------------------------------------------------------
describe('the client catalogue and the schema agree', () => {
  test('the five game ids are exactly the ones the check constraint allows', () => {
    // The constraint is written out three times in the migration; take the
    // first and require the client to name the same set.
    const m = MIGRATION.match(/game\s+text not null check \(game in \(([^)]+)\)\)/)
    expect(m, 'the game check constraint moved').toBeTruthy()
    const sqlIds = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    expect(RELATIONSHIP_GAME_IDS.slice().sort()).toEqual(sqlIds)
  })

  test('every game has exactly one display title, and no id is used as one', () => {
    for (const id of RELATIONSHIP_GAME_IDS) {
      const spec = RELATIONSHIP_GAMES[id]
      expect(spec.title).toBeTruthy()
      expect(spec.title).not.toBe(id)
      expect(spec.blurb).toBeTruthy()
    }
  })

  // The migration's own rule, enforced client-side as its header asks: a
  // shipped starter that implies a camera MUST carry a text-only equivalent,
  // because a game that only works with a camera pressures someone into using
  // one. Guess What is a photo game by construction, so every one of its rows
  // needs one whether or not its wording says "photo".
  test('every camera-implying starter ships a camera-free equivalent', () => {
    const block = MIGRATION.slice(
      MIGRATION.indexOf('insert into public.intimate_prompts'),
      MIGRATION.indexOf('on conflict (game, body) do nothing')
    )
    const rows = [...block.matchAll(/\(\s*'([a-z_]+)',\s*'((?:[^']|'')*)',\s*(?:'((?:[^']|'')*)'|null),\s*(?:'((?:[^']|'')*)'|null)\)/g)]
      .map(([, game, body, optionB, cameraFree]) => ({ game, body, optionB, cameraFree }))
    expect(rows.length, 'no starter rows parsed — the insert shape changed').toBeGreaterThan(20)

    const implied = /\b(photo|photograph|picture|video|voice note|camera|close-?up|cropped|selfie|lens)\b/i
    const missing = rows.filter(
      (r) => (r.game === 'guess_what' || implied.test(`${r.body} ${r.optionB ?? ''}`)) && !r.cameraFree
    )
    expect(missing.map((r) => r.body), 'starters that assume a camera with no text-only way to play').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The turn rule
// ---------------------------------------------------------------------------
describe('turn = the person who did NOT pose the most recent round', () => {
  test('nobody has moved: whoever opened it starts', () => {
    expect(turnHolder(session({ opened_by: B }), [])).toBe(B)
  })

  test('an OPEN round puts the turn on the responder', () => {
    expect(turnHolder(session(), [round(1, A, { status: 'open' })])).toBe(B)
  })

  test('a CLOSED round puts the turn on the same person — no special case', () => {
    expect(turnHolder(session(), [round(1, A)])).toBe(B)
  })

  test('a pass closes a round exactly like an answer, so it can never strand a turn', () => {
    const passedByResponder = [round(1, A, { status: 'passed', passed_by: B })]
    expect(turnHolder(session(), passedByResponder)).toBe(B)
    // Passing on your turn to ASK is recorded as an empty round you posed, so
    // the same one expression carries it across.
    const passedOnAsking = [round(1, A), round(2, B, { status: 'passed', passed_by: B, prompt: null, option_b: null })]
    expect(turnHolder(session(), passedOnAsking)).toBe(A)
  })

  test('it reads the highest seq, not the array order', () => {
    const shuffled = [round(3, B), round(1, A), round(2, A)]
    expect(turnHolder(session(), shuffled)).toBe(A)
  })

  test('with rounds not loaded it falls back to the server’s own answer, never a guess', () => {
    expect(turnHolder(session({ turn: B }), undefined)).toBe(B)
    expect(turnHolder(session(), undefined)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------
describe('consent is a state machine and the UI must not get ahead of it', () => {
  test('phases', () => {
    expect(sessionPhase(undefined)).toBe('unknown')
    expect(sessionPhase(null)).toBe('none')
    expect(sessionPhase(session({ status: 'invited' }))).toBe('invited')
    expect(sessionPhase(session({ status: 'both_accepted' }))).toBe('ready')
    expect(sessionPhase(session())).toBe('active')
    expect(sessionPhase(session({ status: 'ended', ended_at: new Date().toISOString() }))).toBe('ended')
    expect(sessionPhase(session({ expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe('expired')
  })

  test('NOTHING can be posed or answered before both sides have joined', () => {
    const invited = sessionView(session({ status: 'invited', joined_by: null }), [], A)
    expect(invited.canPose).toBe(false)
    expect(invited.canRespond).toBe(false)
    expect(invited.canPass).toBe(false)
  })

  test('only the person who did not open it can join', () => {
    const inv = session({ status: 'invited', joined_by: null, opened_by: A })
    expect(sessionView(inv, [], B).canJoin).toBe(true)
    expect(sessionView(inv, [], A).canJoin).toBe(false)
    expect(sessionView(inv, [], A).awaitingThem).toBe(true)
  })

  test('once both are in, the compose affordance follows the turn and nothing else', () => {
    const live = session({ status: 'both_accepted' })
    expect(sessionView(live, [], A).canPose).toBe(true)
    expect(sessionView(live, [], B).canPose).toBe(false)
    const open = [round(1, A, { status: 'open' })]
    expect(sessionView(session(), open, B).canRespond).toBe(true)
    expect(sessionView(session(), open, B).canPose).toBe(false)
    expect(sessionView(session(), open, A).canRespond).toBe(false)
  })

  test('rounds not loaded offers nothing — an empty list would be an answer', () => {
    const v = sessionView(session(), undefined, A)
    expect(v.canPose).toBe(false)
    expect(v.canRespond).toBe(false)
    expect(v.canPass).toBe(false)
    expect(v.owe).toBe(null)
  })

  test('ending is offered from every state it can work in, and from neither of the two it cannot', () => {
    expect(sessionView(session({ status: 'invited', joined_by: null }), [], A).canEnd).toBe(true)
    expect(sessionView(session({ status: 'both_accepted' }), [], A).canEnd).toBe(true)
    expect(sessionView(session(), [], A).canEnd).toBe(true)
    expect(sessionView(null, undefined, A).canEnd).toBe(false)
    expect(sessionView(session({ status: 'ended', ended_at: soon() }), [], A).canEnd).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Passing costs nothing — the single most important rule in the feature
// ---------------------------------------------------------------------------
describe('passing costs nothing, anywhere', () => {
  test('pass is offered on both kinds of turn', () => {
    expect(sessionView(session(), [round(1, A, { status: 'open' })], B).canPass).toBe(true)
    expect(sessionView(session(), [round(1, A)], B).canPass).toBe(true)
  })

  test('the client never sends a reason and the database never takes one', () => {
    const sig = MIGRATION.match(/function public\.pass_intimate_turn\(([^)]*)\)/)
    expect(sig[1].trim()).toBe('sess uuid')
    const client = readFileSync('src/lib/intimate.js', 'utf8')
    expect(client).toMatch(/export async function passTurn\(sessionId\)/)
  })

  // A counter is the thing this rule exists to prevent, and it would arrive as
  // a word before it arrived as a behaviour. Nothing on this surface may keep
  // score of a "no".
  test('no surface in the feature counts, scores or tallies a pass', () => {
    const sources = [
      'src/lib/relationshipGames.js',
      'src/lib/intimate.js',
      'src/components/IntimateSession.jsx',
      'src/components/IntimateChip.jsx',
      'src/hooks/useIntimateSession.js',
      'src/styles/intimate.css',
    ].map((f) => readFileSync(f, 'utf8')).join('\n')
    // Deliberately blunt. Any of these appearing near the feature is a signal
    // to re-read the rule, not a lint nit.
    for (const word of [/passCount/i, /passes_used/i, /passStreak/i, /pass.?tally/i, /timesPassed/i]) {
      expect(sources, `found engagement bookkeeping: ${word}`).not.toMatch(word)
    }
    // And the copy must never frame it as the lesser outcome.
    expect(sources.toLowerCase()).not.toContain('only passed')
    expect(sources.toLowerCase()).not.toContain('chickened')
  })
})

// ---------------------------------------------------------------------------
// The three ways it can end are three different things
// ---------------------------------------------------------------------------
describe('ended_reason is never collapsed', () => {
  test('declined, left and expired each read differently', () => {
    const decl = endedLine({ ended_reason: 'declined', ended_by: B }, A, 'S5')
    const left = endedLine({ ended_reason: 'left', ended_by: B }, A, 'S5')
    const exp = endedLine({ ended_reason: 'expired', ended_by: null }, A, 'S5')
    expect(new Set([decl, left, exp]).size).toBe(3)
    expect(decl).toContain('S5')
    expect(left).toContain('S5')
    // Only "left" and "declined" are about a person; expiry is about a clock.
    expect(exp).not.toContain('S5')
  })

  test('who did it is stated from the right side', () => {
    expect(endedLine({ ended_reason: 'left', ended_by: A }, A, 'S5')).toContain('You')
    expect(endedLine({ ended_reason: 'declined', ended_by: A }, A, 'S5')).toContain('You')
  })

  test('a reason we could not learn says so instead of picking one', () => {
    const unknown = endedLine({ ended_reason: null, ended_by: null }, A, 'S5')
    expect(unknown).toBe('This session is no longer open.')
    expect(unknown).not.toMatch(/ended this|did not take|ran out/)
  })
})

// ---------------------------------------------------------------------------
// The photo, and the copy about it
// ---------------------------------------------------------------------------
describe('the single-view photo promises only what is true', () => {
  test('the URL is minted for what is left of the window, never the app default hour', () => {
    expect(photoUrlTtl({ photo_opened_at: null })).toBe(120)
    const now = Date.now()
    const opened = new Date(now - 90_000).toISOString()
    expect(photoUrlTtl({ photo_opened_at: opened }, now)).toBe(30)
    // Never zero or negative: a token that expires between the mint and the
    // first paint is a photo lost to nothing at all.
    const stale = new Date(now - 10 * 60_000).toISOString()
    expect(photoUrlTtl({ photo_opened_at: stale }, now)).toBe(PHOTO_MIN_TTL_S)
  })

  test('the countdown and the window agree', () => {
    expect(photoMsLeft(null)).toBe(PHOTO_WINDOW_MS)
    expect(formatCountdown(PHOTO_WINDOW_MS)).toBe('2:00')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5000)).toBe('0:00')
  })

  // The audit finding this feature was built against: the database stops
  // MINTING at two minutes, but it cannot expire a URL already handed out, and
  // the object survives until the cleanup worker's next quarter-hour run. The
  // copy must not say the photo is gone at two minutes, because it is not.
  test('the copy never claims the photo itself is destroyed on a two-minute timer', () => {
    for (const copy of [PHOTO_PROMISE, PHOTO_PROMISE_SHORT]) {
      const lower = copy.toLowerCase()
      expect(lower).not.toMatch(/photo (is |will be )?(gone|deleted|destroyed) (in|after) two minutes/)
      expect(lower).not.toMatch(/disappears forever/)
      expect(lower).not.toMatch(/\bsecure\b|\bencrypted\b|\bcannot be saved\b/)
    }
    // And it must say the two things that ARE true and are easy to leave out.
    expect(PHOTO_PROMISE.toLowerCase()).toContain('link')
    expect(PHOTO_PROMISE.toLowerCase()).toContain('screenshot')
    expect(PHOTO_PROMISE_SHORT.toLowerCase()).toContain('screenshot')
  })

  test('the ephemeral url helper never touches the shared signed-url cache', () => {
    const db = readFileSync('src/lib/db.js', 'utf8')
    const fn = db.slice(db.indexOf('export async function ephemeralSignedUrl'))
      .slice(0, db.slice(db.indexOf('export async function ephemeralSignedUrl')).indexOf('\n}\n') + 2)
    expect(fn).not.toMatch(/urlCache/)
  })
})

// ---------------------------------------------------------------------------
// Camera-off is a mode, not a refusal
// ---------------------------------------------------------------------------
describe('Guess What accepts either way of playing', () => {
  test('a written clue alone is a complete round', () => {
    expect(poseProblem('guess_what', { prompt: 'Small and blue', answerKey: 'a mug' })).toBe(null)
  })
  test('a photo alone is a complete round', () => {
    expect(poseProblem('guess_what', { mediaPath: 'x', answerKey: 'a mug' })).toBe(null)
  })
  test('neither is not', () => {
    expect(poseProblem('guess_what', { answerKey: 'a mug' })).toBe('Add a photo, or describe it in words')
  })
  test('the answer key is required either way, exactly as the SQL requires it', () => {
    expect(poseProblem('guess_what', { prompt: 'x' })).toMatch(/Say what it is/)
    expect(poseProblem('guess_what', { mediaPath: 'x' })).toMatch(/Say what it is/)
  })
})

// ---------------------------------------------------------------------------
// Validation mirrors the writers, so the screen never offers a refused move
// ---------------------------------------------------------------------------
describe('pose and respond validation mirror the RPCs', () => {
  test('two-option games need both', () => {
    expect(poseProblem('truth_or_dare', { prompt: 'a' })).toBe('Both options are needed')
    expect(poseProblem('would_you_rather', { prompt: 'a', optionB: 'b' })).toBe(null)
  })
  test('true or made up needs the secret marked, and false is a valid mark', () => {
    expect(poseProblem('true_or_made_up', { prompt: 'a' })).toBe('Mark whether it is real')
    expect(poseProblem('true_or_made_up', { prompt: 'a', secretTruth: false })).toBe(null)
    expect(poseProblem('true_or_made_up', { prompt: 'a', secretTruth: true })).toBe(null)
  })
  test('one line each needs a line', () => {
    expect(poseProblem('fantasy_builder', {})).toBe('Write the next line first')
    expect(poseProblem('fantasy_builder', { prompt: 'It is raining.' })).toBe(null)
  })
  test('lengths are capped where the columns are', () => {
    expect(poseProblem('fantasy_builder', { prompt: 'x'.repeat(401) })).toMatch(/400/)
    expect(poseProblem('guess_what', { prompt: 'x', answerKey: 'y'.repeat(121) })).toMatch(/120/)
    expect(respondProblem('guess_what', { response: 'x'.repeat(601) })).toMatch(/600/)
  })
  test('responses only accept the picks that game defines', () => {
    expect(respondProblem('truth_or_dare', { pick: 'a', response: 'x' })).toBe('Pick truth or dare')
    expect(respondProblem('truth_or_dare', { pick: 'dare', response: 'x' })).toBe(null)
    expect(respondProblem('truth_or_dare', { pick: 'dare' })).toBe('Say how it went')
    expect(respondProblem('would_you_rather', { pick: 'b', response: 'x' })).toBe(null)
    expect(respondProblem('true_or_made_up', { pick: 'real' })).toBe(null)
    // One Line Each has no responder at all.
    expect(respondProblem('fantasy_builder', { response: 'x' })).toBe('That round is already finished')
  })
})

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
describe('the partner is an alias, never a name', () => {
  test('the alias is used when it can be derived', () => {
    expect(partnerLabel({ id: 'x', display_name: 'Sneha' }, () => 'S5')).toBe('S5')
  })
  test('an underivable alias falls back to the handle, NOT the display name', () => {
    const p = { id: 'x', display_name: 'Sneha', username: 'sneha' }
    expect(partnerLabel(p, () => '?')).toBe('@sneha')
    expect(partnerLabel(p, null)).toBe('@sneha')
    expect(partnerLabel({ id: 'x', display_name: 'Sneha' }, () => null)).toBe('them')
  })
})

// ---------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------
describe('the chip says a state and nothing else', () => {
  test('it is silent when there is nothing waiting and when nothing has been asked', () => {
    expect(chipLabel(sessionView(undefined, undefined, A))).toBe(null)
    expect(chipLabel(sessionView(null, undefined, A))).toBe(null)
    expect(chipLabel(sessionView(session({ status: 'ended', ended_at: soon() }), [], A))).toBe(null)
  })
  test('it never names a game, a prompt or a person', () => {
    const labels = [
      chipLabel(sessionView(session({ status: 'invited', joined_by: null }), [], B)),
      chipLabel(sessionView(session({ status: 'invited', joined_by: null }), [], A)),
      chipLabel(sessionView(session(), [round(1, B)], A)),
      chipLabel(sessionView(session(), [round(1, A)], A)),
    ].filter(Boolean)
    expect(labels.length).toBe(4)
    for (const l of labels) {
      expect(l).toContain('Just us')
      for (const spec of Object.values(RELATIONSHIP_GAMES)) expect(l).not.toContain(spec.title)
    }
  })
})

describe('status lines', () => {
  test('nothing is claimed before the answer is in hand', () => {
    expect(statusLine(sessionView(undefined, undefined, A), 'S5')).toBe(null)
    expect(statusLine(sessionView(session({ status: 'both_accepted' }), undefined, A), 'S5')).toBe('Both of you are in.')
  })
  test('the reveal is only rendered once the round is closed', () => {
    expect(revealLine('true_or_made_up', round(1, A, { status: 'open', secret_truth: true }))).toBe(null)
    expect(revealLine('true_or_made_up', round(1, A, { secret_truth: true, pick: 'real' }))).toMatch(/real — guessed right/)
    expect(revealLine('true_or_made_up', round(1, A, { secret_truth: false, pick: 'real' }))).toMatch(/made up — guessed wrong/)
    // A closed round whose secret simply did not come back invents nothing.
    expect(revealLine('true_or_made_up', round(1, A, { secret_truth: null }))).toBe(null)
  })
})
