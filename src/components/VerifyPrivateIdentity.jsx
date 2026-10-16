import { useState } from 'react'
import { requireVault, peerIdentity, verifyPeer } from '../lib/privacyVault'
import { fingerprint } from '../lib/privacyCrypto'
import { privateContentEnabled } from '../lib/privateMessages'
import Portal from './Portal'
import Sheet from './Sheet'
export default function VerifyPrivateIdentity({ other, onVerified }) {
  const [details, setDetails] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  if (!privateContentEnabled()) return null
  const inspect = async () => {
    setBusy(true); setError('')
    try { const own = requireVault(), peer = await peerIdentity(other); setDetails({ peer, own: await fingerprint(own.publicJwk), theirs: await fingerprint(peer) }) }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const confirm = async () => {
    setBusy(true)
    try { await verifyPeer(other, details.peer); setDetails(null); onVerified?.() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const format = value => value.match(/.{1,4}/g).join(' ')
  return <><button type="button" className="pill-btn" onClick={inspect} disabled={busy}>Verify encryption identity</button>{error && <p role="alert">{error}</p>}{details && <Portal><Sheet onClose={() => setDetails(null)} label="Verify encryption identity"><h2>Compare with each other</h2><p>Compare these full codes in person or over a trusted channel. Do not confirm from an unverified message in this chat.</p><h3>Your code</h3><code className="privacy-code">{format(details.own)}</code><h3>Their code</h3><code className="privacy-code">{format(details.theirs)}</code><p>They should see your code as “Their code”, and vice versa. A changed identity blocks sending until you verify again.</p><button className="btn-dark" disabled={busy} onClick={confirm}>We compared and both codes match</button></Sheet></Portal>}</>
}
