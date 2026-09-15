// The catalogue of two-player games, and the calls the new ones need.
//
// Every game in Play uses the SAME room: one game_invites row carrying the
// board, the revision, the round, the presence stamps and the series score. So
// the invitation flow, acceptance, rematch, scoreboard, presence and the Play
// chip in the conversation work for a new game the moment it appears here —
// none of them ask which game it is. What differs between games is only the
// shape of the board and what counts as a move, which is what this file names.
//
// `board` is always a flat text[] and a result is always 'X' (the inviter),
// 'O' (the recipient) or 'draw', because the score columns and gameState.js
// already speak that language.

import { supabase } from './supabase'
import { createGameInvite as createTicTacToeInvite, playGameMove } from './db'
import { emptyBoard as emptyC4 } from './connectFour'
import { initialBoard as initialCheckers } from './checkers'
// One source for the titles. lib/threadEvent.js needs them too (the invitation
// line in a conversation names the game) and must stay free of the rule
// engines, so the names live there and this file reads them.
import { GAME_TITLES } from './threadEvent'

export const GAMES = {
  ttt: {
    id: 'ttt',
    title: GAME_TITLES.ttt,
    glyph: '✕◯',
    blurb: 'Take turns, chat, and pick up where you left off. Rooms expire after 24 hours.',
    tint: 'var(--lavender)',
    // A move is one square index, sent through play_game_move.
    move: 'cell',
    initialBoard: () => Array(9).fill(''),
  },
  c4: {
    id: 'c4',
    title: GAME_TITLES.c4,
    glyph: '●●●●',
    blurb: 'Drop a disc, four in a row wins. Gravity does half the work.',
    tint: 'var(--lime)',
    // A move is a COLUMN, not a cell — gravity decides the rest. Still
    // play_game_move; the database derives the landing square itself.
    move: 'column',
    initialBoard: emptyC4,
  },
  checkers: {
    id: 'checkers',
    title: GAME_TITLES.checkers,
    glyph: '⛃⛀',
    blurb: 'Captures are forced, jumps chain, and a man that reaches the far row is crowned.',
    tint: 'var(--coral)',
    // A move is a whole path — [from, ...landings] — because a multi-jump is
    // one turn. It goes through play_game_path, which re-validates every hop.
    move: 'path',
    initialBoard: initialCheckers,
  },
}

export const GAME_IDS = Object.keys(GAMES)

// A row from a database that predates this change has game='ttt' already, but a
// resume handed across in sessionStorage carries no game at all — the room row
// is the authority, and this is the fallback until it arrives.
export const gameOf = (id) => GAMES[id] ?? GAMES.ttt

export const titleOf = (id) => gameOf(id).title

// `gameOf` falls back to Tic-Tac-Toe for an unknown id, which is right for
// rendering a room but wrong for deciding whether a broadcast is ours. The
// invite banner needs the strict question.
export const isKnownGame = (id) => Object.prototype.hasOwnProperty.call(GAMES, id)

// Start a game. db.js's createGameInvite is the existing, tested entry point
// for Tic-Tac-Toe and is left carrying it, so widening the catalogue does not
// add a second way to open the game that already worked. Both call the one RPC.
export async function createInvite(otherId, room, game) {
  if (game === 'ttt') return createTicTacToeInvite(otherId, room)
  if (!GAMES[game]) throw new Error('Unknown game')
  const { data, error } = await supabase.rpc('create_game_invite', {
    other: otherId,
    game_code: game,
    room_code: room,
  })
  if (error) throw error
  return data
}

// One turn of ANY game in the catalogue. This is the reason the room screen
// has no `if (game === 'checkers')` in it: it holds a move — whatever a move is
// for this game — and hands it to the entry point the catalogue names.
export function playTurn(game, invite, move, expectedRevision) {
  return gameOf(game).move === 'path'
    ? playGamePath(invite, move, expectedRevision)
    : playGameMove(invite, move, expectedRevision)
}

// A whole turn for a path game. The database validates the sequence, derives
// whose turn it is, and decides the result; this only carries it.
export async function playGamePath(invite, path, expectedRevision) {
  const { data, error } = await supabase.rpc('play_game_path', {
    invite,
    path,
    expected_revision: expectedRevision,
  })
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}
