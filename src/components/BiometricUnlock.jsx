import { useCallback, useEffect, useState } from 'react'
import SaveState from './SaveState'
import { ArrowIcon, FaceIdIcon, FingerprintIcon } from './Icons'
import {
  BIOMETRIC,
  biometricGlyph,
  biometricName,
  clearBiometric,
  enrollBiometric,
  isBiometricEnrolled,
  probeBiometric,
} from '../lib/biometric'
import { useSaveState } from '../lib/useSaveState'

// "Require Face ID / Touch ID at launch, if supported" — the second half of the
// owner's request. The first half, "lock this device", already exists as the
// Lock app row above: the passcode is MANDATORY and there is deliberately no
// control here that turns it off.
//
// So this control adds a route, it never removes one. The copy has to say that
// out loud, because "biometric unlock" in most apps means "instead of the
// code", and somebody who believes that will be surprised by the pad — or,
// worse, will assume turning this on has made Meera harder to get into than it
// actually is.
//
// Three things it must not do, all of them load-bearing:
//   • It must not read as security. There is no server verifying anything
//     (lib/biometric.js explains at length); this is deterrence of exactly the
//     same class as the passcode, and the hint says so in words.
//   • It must not claim the device cannot do this when the probe merely failed.
//     'unknown' keeps the button, because the cost of being wrong that way is
//     one dismissed prompt and the cost of the confident version is telling
//     someone their phone lacks a feature it has.
//   • Enrollment must run straight off the tap. Safari rejects a WebAuthn
//     ceremony with no user activation, same rule enablePush() follows.
export default function BiometricUnlock() {
  // undefined = we have not asked the platform yet. Never rendered as an
  // answer; the screen shows nothing at all until the probe returns.
  const [kind, setKind] = useState(undefined)
  const [on, setOn] = useState(isBiometricEnrolled)
  const save = useSaveState()
  const name = biometricName()
  const Glyph = biometricGlyph() === 'face' ? FaceIdIcon : FingerprintIcon

  const probe = useCallback(() => {
    let live = true
    probeBiometric().then((k) => { if (live) setKind(k) })
    return () => { live = false }
  }, [])
  useEffect(probe, [probe])

  // The button is offered whenever we cannot prove it is pointless. 'none' —
  // the platform answered and said there is no face or finger enrolled on this
  // device — is the one case where an attempt genuinely cannot succeed, so it
  // gets instructions instead of a control that will fail identically forever.
  // That is the same trade useCamera makes with `blocked`.
  const offer = kind === BIOMETRIC.AVAILABLE || kind === BIOMETRIC.UNKNOWN

  const turnOn = async () => {
    // No await before enrollBiometric(): useSaveState.run() calls its argument
    // in the same synchronous turn as the tap, which is what keeps the user
    // activation WebAuthn needs.
    const ok = await save.run(async () => {
      await enrollBiometric()
      return true
    })
    if (!ok) return
    setOn(true)
    // A successful enrollment is also an answer to the probe, and a better one
    // than the probe gave us if it had thrown.
    setKind(BIOMETRIC.AVAILABLE)
  }

  const turnOff = async () => {
    await save.run(async () => {
      clearBiometric()
      return true
    })
    setOn(false)
  }

  return (
    <>
      <div className="pc-label-row">
        <div className="pc-label">{name}</div>
        {kind !== undefined ? <span className={`pc-chip${on ? ' on' : ''}`}>{on ? 'On' : 'Off'}</span> : null}
      </div>

      <p className="field-hint">
        An extra way past the passcode pad — never a replacement for it. Your passcode
        always works, and it is the only way back in if {name} stops recognising you,
        you use another device, or you dismiss the prompt. Meera cannot turn the
        passcode off.
      </p>
      {/* Said plainly, in the same voice as the default-passcode warning above:
          this deters the person holding your phone. It is not a boundary. */}
      <p className="field-hint">
        Nothing is sent anywhere — your face and fingerprint never leave the device,
        and Meera never sees them. Like the passcode, this deters someone who has
        picked up your phone. It is not encryption, and your account password plus
        the server's own rules are what actually protect your messages.
      </p>

      {kind === BIOMETRIC.UNSUPPORTED && (
        <div className="pc-empty">
          <strong>This browser can’t use {name}.</strong>
          It needs a browser with passkey support, opened over https. On iPhone, add
          Meera to your Home Screen and open it from there.
        </div>
      )}

      {kind === BIOMETRIC.NONE && (
        <div className="pc-empty">
          <strong>Nothing is set up on this device yet.</strong>
          Add {name} in your device settings, then come back — Meera can only use a
          biometric the phone already knows.
        </div>
      )}

      {/* The honest third state. It would be very easy to write "not supported"
          here, and it would be wrong: we asked and got no answer. Seven bugs in
          this codebase have been exactly this mistake (CLAUDE.md, "Failures
          must not render as answers"), and two of them were on privacy
          controls, where a confident wrong answer is one the user acts on. */}
      {kind === BIOMETRIC.UNKNOWN && !on && (
        <div className="pc-empty">
          <strong>We couldn’t check whether this device can do it.</strong>
          That is not the same as no. Try turning it on — if the device refuses, the
          passcode is exactly as it was.
        </div>
      )}

      {kind !== undefined && (on || offer) && (
        <button className="pc-nav" type="button" disabled={save.busy} onClick={on ? turnOff : turnOn}>
          <span className="pc-nav-icon" aria-hidden="true">
            <Glyph width={19} height={19} />
          </span>
          <span className="pc-nav-title">
            {on ? `Turn off ${name}` : `Turn on ${name}`}
          </span>
          <span className="pc-nav-go" aria-hidden="true">
            <ArrowIcon width={17} height={17} />
          </span>
        </button>
      )}

      <SaveState
        state={save.state}
        error={save.error}
        savingLabel={on ? 'Turning off…' : `Waiting for ${name}…`}
        savedLabel={on ? `${name} is on for this device` : `${name} is off`}
      />
    </>
  )
}
