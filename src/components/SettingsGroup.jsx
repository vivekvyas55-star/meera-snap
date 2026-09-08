// A titled group in the Privacy Centre.
//
// The screen went from a flat run of `.section` labels to six named groups.
// A group header has to look different in kind from the labels inside it or it
// groups nothing — hence the eyebrow over a light display heading, which is
// what the ABC reference does everywhere it separates one idea from the next.
export default function SettingsGroup({ eyebrow, title, hint, children }) {
  return (
    <>
      <header className="pc-group">
        <div className="pc-group-eyebrow">{eyebrow}</div>
        <h2 className="pc-group-title">{title}</h2>
        {hint ? <p className="pc-group-hint">{hint}</p> : null}
      </header>
      {children}
    </>
  )
}
