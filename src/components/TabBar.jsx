import { badgePhrase, badgeText } from '../lib/navBadges'
import '../styles/nav.css'

// The bar. It owns no state and reads nothing: the tabs, which one is lit and
// what each is badged with all arrive as props, so this file can be rendered in
// a test without the provider tree, and the ordering rules live in lib/nav.js
// next to the reasons for them.
//
// `tabs` is lib/nav.js's TABS with an `Icon` attached — the icons are JSX and
// belong with the components, the ordering is a fact about the app and belongs
// with the logic.
export default function TabBar({ tabs, activeKey, badges = {}, onSelect }) {
  return (
    <nav className="tabbar" aria-label="Main navigation">
      {tabs.map((tab) => {
        const active = tab.key === activeKey
        const badge = badges[tab.key]
        const phrase = badgePhrase(badge)
        const text = badgeText(badge)
        return (
          <button
            key={tab.key}
            type="button"
            className={active ? 'active' : ''}
            onClick={() => onSelect(tab)}
            aria-current={active ? 'page' : undefined}
            // A badge that is only a colour is not announced. With one, the
            // slot's accessible name says what is waiting ("Chats, 2 unread");
            // without one it is left off entirely so the visible label is used
            // and the two can never drift apart.
            aria-label={phrase ? `${tab.label}, ${phrase}` : undefined}
          >
            <span className="glyph nav-glyph">
              <tab.Icon />
              {badge && (
                // aria-hidden because the aria-label above already says it —
                // otherwise a screen reader reads the number twice, once
                // without its noun.
                <span className={`nav-badge${badge.count === null ? ' is-dot' : ''}`} aria-hidden="true">
                  {text}
                </span>
              )}
            </span>
            <span className="nav-tab-label">{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
