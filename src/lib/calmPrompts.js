// One calming prompt a day — the last thing on the solo screen, and the only
// one of the five that asks nothing of you.
//
// Same rotation as everything else daily here (lib/dayCycle.js, epoch
// 2024-01-01): a cycle indexed by the IST day number plus a per-user phase, so
// it is different for two people on the same day and every line is seen before
// any repeats.
//
// The rules the copy has to obey, because this is the surface where a wellness
// app usually starts nagging:
//   - it is never a task, a target or a thing to complete;
//   - nothing records whether it was read, so nothing can ever say you missed
//     one or broke anything;
//   - no instruction that implies the reader is doing something wrong.

import { pickForDay } from './dayCycle'

export const PROMPTS = [
  { id: 'window', line: 'Look out of the nearest window and find one thing that is moving.' },
  { id: 'shoulders', line: 'Let your shoulders drop. They have probably been up near your ears for hours.' },
  { id: 'breath', line: 'Breathe in while you count to four. Out while you count to six. Twice is enough.' },
  { id: 'hands', line: 'Put your phone down for the length of one slow breath. It will still be here.' },
  { id: 'sound', line: 'Name the furthest away sound you can hear right now.' },
  { id: 'water', line: 'Have some water. That is the whole prompt.' },
  { id: 'tomorrow', line: 'Whatever you were about to worry about, it can be tomorrow you’s.' },
  { id: 'smallgood', line: 'Think of one small thing that went right today. It counts even if it was tiny.' },
  { id: 'stretch', line: 'Stand up and reach for the ceiling once. Nobody is watching.' },
  { id: 'jaw', line: 'Unclench your jaw. Yes, that one.' },
  { id: 'colour', line: 'Find three things near you that are the same colour.' },
  { id: 'feet', line: 'Notice your feet on the floor for a moment. That is the whole exercise.' },
  { id: 'message', line: 'Somebody would be glad to hear from you. No rush — just a thought.' },
  { id: 'enough', line: 'You have done enough for now. The rest keeps.' },
]

/** Today's line, or null when the day is unknown. `isoDate` is 'YYYY-MM-DD'. */
export function calmForDay(isoDate, seed = '') {
  return pickForDay(PROMPTS, isoDate, seed)
}
