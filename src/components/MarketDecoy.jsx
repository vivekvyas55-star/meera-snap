import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MARKETS,
  dataFor,
  marketById,
  money,
  groupDigits,
  noise,
  quote,
  sessionFor,
  sparkPoints,
  swing,
} from '../lib/decoyMarket'
import '../styles/decoy.css'

// Shown INSTEAD of the passcode screen while the app is locked out after too
// many wrong PIN attempts. Someone who picks up the phone and guesses at the
// lock ends up looking at a dull equity-research app rather than a "locked"
// screen — which would confirm there is something here worth getting into.
//
// Four constraints, all of them load-bearing (see CLAUDE.md, "PIN lockout and
// the decoy screen"):
//
//  - Every company, ticker, index and sector name is INVENTED (lib/decoyMarket.js).
//    Fabricated prices attached to a real company would be misrepresenting
//    financial data about a real entity.
//  - It NEVER asks for anything. No login, no password, no account number, not
//    even a fake one, and no form controls at all — it is a blank wall, not a
//    trap. Nothing leaves the device; there are no network calls here.
//  - It does not imitate a specific real broker, and it shares nothing with
//    Meera's own visual language (see styles/decoy.css). Both would be tells.
//  - No countdown, no hint that a passcode exists, no bypass gesture. The pad
//    comes back by itself when the timer expires.
//
// Like the passcode itself, this is deterrence against a casual snoop, NOT
// security. Anyone technical can read the bundle. Don't oversell it.

const TABS = ['Portfolio', 'Watchlist', 'Research', 'Orders', 'Funds']

function Sparkline({ seed, up }) {
  const pts = useMemo(() => sparkPoints(seed, up), [seed, up])
  return (
    <svg className="mk-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? '#12a150' : '#e5484d'} strokeWidth="1.6" />
    </svg>
  )
}

function Pct({ value }) {
  const up = value >= 0
  return (
    <span className={`mk-pct ${up ? 'up' : 'down'}`}>
      {up ? '+' : ''}
      {value.toFixed(2)}%
    </span>
  )
}

/* Market status runs off the real wall clock — trading hours are public facts
   and an indicator that agrees with the clock is most of what makes this read
   as a live app rather than a screenshot. */
function StatusStrip({ now }) {
  return (
    <div className="mk-status">
      {MARKETS.map((m) => {
        const s = sessionFor(m, now)
        return (
          <div className="mk-status-cell" key={m.id}>
            <span className={`mk-dot ${s.open ? 'on' : 'off'}`} aria-hidden="true" />
            <span className="mk-status-ex">{m.exchange}</span>
            <span className={`mk-status-state ${s.open ? 'on' : 'off'}`}>{s.label}</span>
            <span className="mk-status-time">
              {s.clock} · {m.hours}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SectorStrip({ market, tick }) {
  const rows = dataFor(market.id).sectors.map((s) => ({
    ...s,
    pct: swing(`${s.seed}:${tick}`, 1.9),
  }))
  return (
    <div className="mk-sectors">
      <div className="mk-sub-head">Sector performance · today</div>
      {rows.map((s) => {
        const up = s.pct >= 0
        const width = Math.min(100, (Math.abs(s.pct) / 1.9) * 100)
        return (
          <div className="mk-sector" key={s.name}>
            <span className="mk-sector-name">{s.name}</span>
            <span className="mk-heat" aria-hidden="true">
              <span className={`mk-heat-fill ${up ? 'up' : 'down'}`} style={{ width: `${width}%` }} />
            </span>
            <Pct value={s.pct} />
          </div>
        )
      })}
    </div>
  )
}

function Portfolio({ market, tick }) {
  const rows = dataFor(market.id).holdings.map((h) => quote(h, tick))
  const invested = rows.reduce((s, r) => s + r.avg * r.qty, 0)
  const current = rows.reduce((s, r) => s + r.price * r.qty, 0)
  const pnl = current - invested
  const pnlPct = (pnl / invested) * 100
  const up = pnl >= 0

  return (
    <>
      <div className="mk-hero">
        <div className="mk-hero-label">Current value</div>
        <div className="mk-hero-value">{money(current, market)}</div>
        <div className={`mk-hero-delta ${up ? 'up' : 'down'}`}>
          {up ? '▲' : '▼'} {money(Math.abs(pnl), market)} ({pnlPct.toFixed(2)}%)
        </div>
        <div className="mk-hero-sub">
          Invested {money(invested, market)} · {market.exchange}
        </div>
      </div>

      <div className="mk-list-head">
        <span>Holdings ({rows.length})</span>
        <span>LTP · Day</span>
      </div>

      <div className="mk-list">
        {rows.map((r) => (
          <div className="mk-row" key={r.sym}>
            <div className="mk-row-main">
              <div className="mk-sym">{r.sym}</div>
              <div className="mk-name">
                {r.qty} qty · avg {money(r.avg, market)}
              </div>
            </div>
            <Sparkline seed={`${r.sym}:${tick}`} up={r.up} />
            <div className="mk-row-right">
              <div className="mk-ltp">{money(r.price, market)}</div>
              <Pct value={r.pct} />
            </div>
          </div>
        ))}
      </div>

      <SectorStrip market={market} tick={tick} />
    </>
  )
}

function Watchlist({ market, tick }) {
  const rows = dataFor(market.id).watchlist.map((w) => quote(w, tick))
  return (
    <>
      <div className="mk-list-head">
        <span>Watchlist ({rows.length})</span>
        <span>LTP · Day</span>
      </div>
      <div className="mk-list">
        {rows.map((r) => (
          <div className="mk-row" key={r.sym}>
            <div className="mk-row-main">
              <div className="mk-sym">{r.sym}</div>
              <div className="mk-name">{r.name}</div>
            </div>
            <Sparkline seed={`w:${r.sym}:${tick}`} up={r.up} />
            <div className="mk-row-right">
              <div className="mk-ltp">{money(r.price, market)}</div>
              <Pct value={r.pct} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

/* The research notes are where the credibility comes from — a ratings page is
   what makes this a research desk rather than a price ticker. Every issuer,
   analyst and thesis below is invented. */
function Research({ market, tick }) {
  const notes = dataFor(market.id).research
  const holdings = dataFor(market.id)
  const priceOf = (sym) => {
    const row =
      holdings.holdings.find((h) => h.sym === sym) ?? holdings.watchlist.find((w) => w.sym === sym)
    return row ? quote(row, tick).price : null
  }
  const counts = notes.reduce((acc, n) => ({ ...acc, [n.rating]: (acc[n.rating] ?? 0) + 1 }), {})

  return (
    <>
      <div className="mk-research-head">
        <div className="mk-sub-head">Coverage · {notes.length} names</div>
        <div className="mk-coverage">
          {['Buy', 'Hold', 'Reduce'].map((r) => (
            <span className={`mk-tagline r-${r.toLowerCase()}`} key={r}>
              {r} {counts[r] ?? 0}
            </span>
          ))}
        </div>
      </div>
      <div className="mk-list">
        {notes.map((n) => {
          const price = priceOf(n.sym)
          const upside = price ? ((n.target - price) / price) * 100 : null
          return (
            <div className="mk-note" key={n.sym}>
              <div className="mk-note-top">
                <div className="mk-row-main">
                  <div className="mk-sym">
                    {n.sym} <span className="mk-note-name">{n.name}</span>
                  </div>
                  <div className="mk-name">
                    {n.sector} · {n.analyst} · {n.date}
                  </div>
                </div>
                <span className={`mk-rating r-${n.rating.toLowerCase()}`}>{n.rating}</span>
              </div>
              <div className="mk-thesis">{n.thesis}</div>
              <div className="mk-note-foot">
                <span>
                  Target {money(n.target, market)} · {n.horizon}
                </span>
                {upside === null ? null : (
                  <span>
                    Upside <Pct value={upside} />
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function Orders({ market }) {
  const orders = dataFor(market.id).orders
  const open = orders.filter((o) => o.status === 'Pending').length
  return (
    <>
      <div className="mk-list-head">
        <span>Orders ({orders.length})</span>
        <span>{open} pending</span>
      </div>
      <div className="mk-list">
        {orders.map((o) => (
          <div className="mk-order" key={o.id}>
            <div className="mk-row-main">
              <div className="mk-sym">
                <span className={`mk-side ${o.side === 'BUY' ? 'buy' : 'sell'}`}>{o.side}</span>
                {o.sym}
              </div>
              <div className="mk-name">
                {o.qty} qty @ {money(o.price, market)} · {o.type}
              </div>
              <div className="mk-order-id">
                {o.id} · {o.at}
              </div>
            </div>
            <span className={`mk-state s-${o.status.toLowerCase()}`}>{o.status}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function Funds({ market }) {
  const f = dataFor(market.id).funds
  return (
    <>
      <div className="mk-hero">
        <div className="mk-hero-label">Available to trade</div>
        <div className="mk-hero-value">{money(f.available, market)}</div>
        <div className="mk-hero-sub">
          Margin used {money(f.margin, market)} · Payin {money(f.payin, market)}
        </div>
      </div>
      <div className="mk-fund-grid">
        <div className="mk-fund-cell">
          <span className="mk-fund-k">Opening balance</span>
          <span className="mk-fund-v">{money(f.available + f.margin, market)}</span>
        </div>
        <div className="mk-fund-cell">
          <span className="mk-fund-k">Utilised</span>
          <span className="mk-fund-v">{money(f.margin, market)}</span>
        </div>
        <div className="mk-fund-cell">
          <span className="mk-fund-k">Collateral</span>
          <span className="mk-fund-v">{money(f.payin * 0.4, market)}</span>
        </div>
        <div className="mk-fund-cell">
          <span className="mk-fund-k">Unsettled</span>
          <span className="mk-fund-v">{money(f.payin * 0.06, market)}</span>
        </div>
      </div>
      <div className="mk-list-head">
        <span>Ledger</span>
        <span>Amount</span>
      </div>
      <div className="mk-list">
        {f.ledger.map((l) => (
          <div className="mk-ledger" key={`${l.at}-${l.note}`}>
            <div className="mk-row-main">
              <div className="mk-sym">{l.note}</div>
              <div className="mk-name">{l.at}</div>
            </div>
            <span className={`mk-amt ${l.amount >= 0 ? 'up' : 'down'}`}>
              {l.amount >= 0 ? '+' : '−'}
              {market.currency}
              {groupDigits(Math.abs(l.amount), market.grouping)}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

export default function MarketDecoy() {
  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const [marketId, setMarketId] = useState('IN')
  const [tab, setTab] = useState('Portfolio')
  const prevTitle = useRef(document.title)

  // Prices drift on a slow tick; every number is a pure function of that tick,
  // so a re-render in between never reshuffles the screen.
  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1)
      setNow(new Date())
    }, 2600)
    return () => clearInterval(t)
  }, [])

  // The tab / app-switcher label would otherwise still read "Meera".
  useEffect(() => {
    const original = prevTitle.current
    document.title = 'Markets'
    return () => {
      document.title = original
    }
  }, [])

  const market = marketById(marketId)
  // A stable per-market "as of" seed, so the timestamp line doesn't jitter.
  const asOf = `${String(Math.floor(noise(`asof:${marketId}`) * 40) + 5)}s`

  return (
    <div className="mk">
      <div className="mk-top">
        <div>
          <div className="mk-brand">Markets</div>
          <div className="mk-brand-sub">Equity research desk</div>
        </div>
        <div className="mk-avatar" aria-hidden="true" />
      </div>

      <div className="mk-markets">
        {MARKETS.map((m) => (
          <button
            type="button"
            key={m.id}
            className={`mk-mkt ${m.id === marketId ? 'on' : ''}`}
            onClick={() => setMarketId(m.id)}
          >
            {m.tab}
          </button>
        ))}
        <span className="mk-asof">Delayed · updated {asOf} ago</span>
      </div>

      <StatusStrip now={now} />

      <div className="mk-tabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t}
            className={`mk-tab ${t === tab ? 'on' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Portfolio' && <Portfolio market={market} tick={tick} />}
      {tab === 'Watchlist' && <Watchlist market={market} tick={tick} />}
      {tab === 'Research' && <Research market={market} tick={tick} />}
      {tab === 'Orders' && <Orders market={market} />}
      {tab === 'Funds' && <Funds market={market} />}

      {/* Stays on every tab. It is what keeps this honest: none of these
          instruments exist and none of these numbers are real. */}
      <div className="mk-foot">
        Illustrative data. Not investment advice. For illustration only.
      </div>
    </div>
  )
}
