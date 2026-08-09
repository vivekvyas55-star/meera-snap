import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import Avatar from './Avatar'

// A user's Snapcode is a QR of a deep link to the app with ?add=<username>.
// A friend scans it with their phone's normal camera, which opens Meera and
// sends the friend request — no in-app scanner needed.
export const snapcodeUrl = (username) =>
  `${location.origin}/?add=${encodeURIComponent(username)}`

export default function Snapcode({ profile }) {
  const [dataUrl, setDataUrl] = useState(null)

  useEffect(() => {
    let alive = true
    QRCode.toDataURL(snapcodeUrl(profile.username), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 360,
      color: { dark: '#16161a', light: '#ffffff' },
    })
      .then((u) => alive && setDataUrl(u))
      .catch(() => alive && setDataUrl(null))
    return () => {
      alive = false
    }
  }, [profile.username])

  const share = async () => {
    const url = snapcodeUrl(profile.username)
    try {
      if (navigator.share) await navigator.share({ title: 'Add me on Meera', url })
      else await navigator.clipboard?.writeText(url)
    } catch {
      /* user dismissed the share sheet — no-op */
    }
  }

  return (
    <div className="snapcode">
      <Avatar profile={profile} />
      <div className="snapcode-tile">
        {dataUrl ? (
          <img src={dataUrl} alt={`Snapcode for @${profile.username}`} />
        ) : (
          <div className="snapcode-loading">…</div>
        )}
      </div>
      <div className="snapcode-name">@{profile.username}</div>
      <div className="snapcode-hint">Have a friend scan this with their camera to add you</div>
      <button type="button" className="btn-dark snapcode-share" onClick={share}>
        Share my code
      </button>
    </div>
  )
}
