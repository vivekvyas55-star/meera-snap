import { LockIcon } from './Icons'
import { TOGETHER_PRIVACY_LABEL } from '../lib/togetherState'

// One badge, one phrase, everywhere in the Together layer. PlayTogether already
// puts "Private to you both" over a private pair surface as an .eyebrow; this
// is that same eyebrow with the line icon in front of it, so a user meets the
// identical promise on the timeline, the scrapbook, the capsules, the add form
// and the photo viewer rather than five slightly different reassurances.
//
// The icon is a line glyph, not a 🔒 — emoji are content in this app, never
// chrome.
export default function PrivateBadge({ note = null, tone = '' }) {
  return (
    <p className={`tg-private eyebrow ${tone}`.trim()}>
      <LockIcon width={13} height={13} aria-hidden="true" />
      <span>{TOGETHER_PRIVACY_LABEL}</span>
      {note ? <em>{note}</em> : null}
    </p>
  )
}
