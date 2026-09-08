// Whether a call is live, readable from ABOVE the provider that owns it.
//
// App renders PinLock as an early return over the entire provider tree, so
// locking on `visibilitychange: hidden` unmounts CallProvider — and WebRTC takes
// no wake lock, so on a voice call where nobody touches the screen the display
// timing out is guaranteed, not incidental. The call died mid-sentence, the
// peer was told nothing, and no call log was written.
//
// A module-level flag rather than context, precisely because the reader sits
// above the writer in the tree.
let active = false

export const setCallActive = (v) => { active = !!v }
export const isCallActive = () => active
