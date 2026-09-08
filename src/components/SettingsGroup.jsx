// A titled group in the Privacy Centre.
//
// The screen went from a flat run of `.section` labels to six named groups.
// A group header has to look different in kind from the labels inside it or it
// groups nothing — hence the eyebrow over a light display heading, which is
// what the ABC reference does everywhere it separates one idea from the next.
//
// The <section> wrapper is what gives the header and its controls the SAME
// indent (they were 28px and 12px, so every heading hung left of the thing it
// named) and what lets one CSS rule draw the hairline between sections and own
// the vertical rhythm inside them. The icon is a scanning aid: six headings of
// identical weight are as hard to aim at as the flat list they replaced.
export default function SettingsGroup({ eyebrow, title, hint, icon, children }) {
  return (
    <section className="pc-section">
      <header className="pc-group">
        {icon ? <span className="pc-group-icon" aria-hidden="true">{icon}</span> : null}
        <div className="pc-group-text">
          <div className="pc-group-eyebrow">{eyebrow}</div>
          <h2 className="pc-group-title">{title}</h2>
          {hint ? <p className="pc-group-hint">{hint}</p> : null}
        </div>
      </header>
      <div className="pc-group-body">{children}</div>
    </section>
  )
}
