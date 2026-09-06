import { useEffect, useState } from 'react'
import DinoRun from '../components/DinoRun'
import { BackIcon } from '../components/Icons'

// Small games, built in-house. The runner is solo and needs no network, so it
// works offline and costs nothing to serve — the point is something to do
// together in the app rather than leaving it.
const BEST_KEY = 'meera:dino-best'

export default function PlayTogether({ onBack }) {
  const [best, setBest] = useState(0)
  const [open, setOpen] = useState(null)

  useEffect(() => {
    try {
      setBest(Number(localStorage.getItem(BEST_KEY) || 0))
    } catch { /* private mode: a best score is not worth failing over */ }
  }, [])

  const record = (score) => {
    if (score <= best) return
    setBest(score)
    try { localStorage.setItem(BEST_KEY, String(score)) } catch { /* ignore */ }
  }

  return (
    <div className="app" style={{ display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div className="header">
        <button className="circle filled" onClick={onBack} aria-label="Back">
          <BackIcon />
        </button>
        <h1>Play</h1>
      </div>

      <div className="list profile-list">
        {open === 'run' ? (
          <>
            <button className="pill-btn" style={{ marginTop: 0 }} onClick={() => setOpen(null)}>
              All games
            </button>
            <div style={{ marginTop: 12 }}>
              <DinoRun best={best} onScore={record} />
            </div>
          </>
        ) : (
          <div className="play-grid">
            <button
              className="play-card"
              style={{ background: 'var(--lavender)' }}
              onClick={() => setOpen('run')}
            >
              <span className="fp-row-icon">🦕</span>
              <span className="fp-row-text">
                <span className="play-title">Runner</span>
                <span className="play-sub">
                  One tap to jump. {best > 0 ? `Your best is ${best}.` : 'Beat your own best.'}
                </span>
              </span>
            </button>

            <div className="play-card" style={{ background: 'var(--card)' }}>
              <span className="fp-row-icon">🎲</span>
              <span className="fp-row-text">
                <span className="play-title">Ludo</span>
                <span className="play-sub">Two-player, live. Being built.</span>
              </span>
              <span className="chip play-soon">Soon</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
