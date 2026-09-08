// Android's hardware Back (and the browser's back gesture) against a UI made of
// state rather than routes.
//
// The rule is one history entry per open layer, and Back closes the innermost
// one. This used to be hand-rolled in App.jsx for exactly one level, so Back
// from Memories or Play closed the whole Profile behind it, and Back from a
// chat sheet left the conversation. Every layer now registers here instead, so
// nesting is handled in one place rather than eight.

const layers = []

// history.back() is ASYNCHRONOUS, so a popstate we asked for can land after the
// user has already opened the next screen — and closing "the top layer" then
// closes the wrong one. Tapping Back and then a chat row in quick succession
// made the chat flash open and shut. This counts the acknowledgements still
// owed to us so a traversal we caused is never mistaken for a press.
let owed = 0
let listening = false

// Two synchronous history.back() calls do NOT go back two steps — the second is
// applied against a stack the first has not moved yet, so it is lost. Measured
// in jsdom and specified the same way in browsers. Closing a parent while a
// child is open drops two layers in one tick, so the steps are batched into a
// single history.go(-n).
let owedSteps = 0
let scheduled = false

function flush() {
  scheduled = false
  const steps = owedSteps
  owedSteps = 0
  if (steps <= 0) return
  // A multi-step traversal fires exactly ONE popstate however many entries it
  // spends, so exactly one acknowledgement comes back.
  owed += 1
  window.history.go(-steps)
}

function onPop() {
  if (owed > 0) {
    owed -= 1
    return
  }
  layers.pop()?.close()
}

export function pushLayer(token, close) {
  if (!listening) {
    window.addEventListener('popstate', onPop)
    listening = true
  }
  layers.push({ token, close })
  window.history.pushState({ meeraLayer: true }, '')
}

// Called when a layer closes from inside the app, and when one unmounts while
// still open (sign-out, a relock, an account switch). Without the latter the
// entry outlives the component that pushed it and every cycle leaves a dead
// step on the stack — Back then appears to do nothing.
//
// A layer already taken by a popstate is gone from `layers`, and its entry went
// with it, so finding nothing here means there is nothing to spend. That array
// is the accounting, not history.state.
export function dropLayer(token) {
  const i = layers.findIndex((l) => l.token === token)
  if (i === -1) return
  layers.splice(i, 1)
  owedSteps += 1
  if (!scheduled) {
    scheduled = true
    queueMicrotask(flush)
  }
}

// Tests only: the stack and the counters are module state that would leak
// between cases.
export function resetBackStack() {
  layers.length = 0
  owed = 0
  owedSteps = 0
  scheduled = false
}
