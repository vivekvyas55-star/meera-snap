/* ==========================================================================
   decoyMarket.js — the invented world behind components/MarketDecoy.jsx.

   MarketDecoy is what the app shows INSTEAD of the passcode pad during a
   lockout: a dull equity-research app, so whoever is holding the phone
   concludes they opened the wrong thing rather than that there is something
   here worth getting into. Everything in this file exists to make that
   conclusion easy to reach.

   Three rules govern this file and none of them are style preferences:

   1. EVERY company, ticker, index and sector name here is INVENTED. Attaching
      fabricated prices to a real listed company is misrepresenting financial
      data about a real entity — that is the one thing that turns a blank wall
      into something harmful. Names that merely *sound* plausible are the point.
      The only real-world facts used are the trading HOURS of the two exchanges
      (public facts, no fabricated data attached), and they are referred to
      generically.
   2. Nothing leaves the device and nothing is ever asked for. There are no
      network calls in this module and there must never be. No login, no
      account number, not even a fake one — it is a blank wall, not a trap.
   3. Numbers are pseudo-random and DETERMINISTIC in their seed, so a re-render
      never reshuffles the screen. They drift only when the caller advances the
      tick, which is what makes it look alive without looking broken.
   ========================================================================== */

/* --------------------------------------------------------------------------
   Deterministic noise. hash() → 32-bit from a string, noise() → [0,1).
   Same seed, same number, forever: React is free to re-render at any moment
   and a screen whose prices jump on every render reads as broken, not busy.
   -------------------------------------------------------------------------- */
export function hash(seed) {
  let h = 2166136261
  const s = String(seed)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function noise(seed) {
  let t = hash(seed) + 0x6d2b79f5
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Signed noise in [-spread, +spread]. */
export function swing(seed, spread) {
  return (noise(seed) - 0.5) * 2 * spread
}

/* --------------------------------------------------------------------------
   Money formatting.

   Indian grouping is 2,75,684.29 — last three digits, then pairs — and Western
   grouping is 275,684.29. Getting this wrong is the single most visible tell
   in a screen full of Indian equities, so it is done by hand rather than left
   to whatever ICU data the runtime happens to ship.
   -------------------------------------------------------------------------- */
export function groupDigits(value, style = 'western') {
  const n = Number.isFinite(value) ? value : 0
  const negative = n < 0
  const [int, dec] = Math.abs(n).toFixed(2).split('.')
  let grouped
  if (style === 'indian' && int.length > 3) {
    const last3 = int.slice(-3)
    const rest = int.slice(0, -3)
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
  } else {
    grouped = style === 'indian' ? int : int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }
  return `${negative ? '-' : ''}${grouped}.${dec}`
}

/* --------------------------------------------------------------------------
   The two markets. `exchange` names only the trading SESSION, generically —
   the hours are a public fact; no fabricated data is attached to the exchange.
   -------------------------------------------------------------------------- */
export const MARKETS = [
  {
    id: 'IN',
    tab: 'India',
    currency: '₹',
    grouping: 'indian',
    exchange: 'India · NSE hours',
    tz: 'Asia/Kolkata',
    tzLabel: 'IST',
    openMin: 9 * 60 + 15,
    closeMin: 15 * 60 + 30,
    hours: '09:15–15:30 IST',
  },
  {
    id: 'US',
    tab: 'US',
    currency: '$',
    grouping: 'western',
    exchange: 'US · NYSE hours',
    tz: 'America/New_York',
    tzLabel: 'ET',
    openMin: 9 * 60 + 30,
    closeMin: 16 * 60,
    hours: '09:30–16:00 ET',
  },
]

export const marketById = (id) => MARKETS.find((m) => m.id === id) ?? MARKETS[0]

export function money(value, market) {
  return `${market.currency}${groupDigits(value, market.grouping)}`
}

/* --------------------------------------------------------------------------
   Market status, from the real clock.

   Real trading hours are public facts and an indicator that agrees with the
   wall clock is most of what makes this feel alive. Intl does the timezone
   work; nothing here needs the network.
   -------------------------------------------------------------------------- */
const WEEKEND = new Set(['Sat', 'Sun'])
const PRE_OPEN_MIN = 60

export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? ''
  // Some runtimes render midnight as "24" under hour12:false.
  const hour = Number(pick('hour')) % 24
  const minute = Number(pick('minute'))
  return { weekday: pick('weekday'), minutes: hour * 60 + minute, clock: `${String(hour).padStart(2, '0')}:${pick('minute')}` }
}

/**
 * @returns {{open: boolean, phase: 'open'|'weekend'|'pre'|'post', label: string, clock: string}}
 */
export function sessionFor(market, date = new Date()) {
  const { weekday, minutes, clock } = zonedParts(date, market.tz)
  if (WEEKEND.has(weekday)) return { open: false, phase: 'weekend', label: 'Closed · weekend', clock }
  if (minutes < market.openMin) {
    // "Pre-open" only means anything in the hour or so before the bell. At
    // 01:00 local it would read as a mistake, which is the opposite of dull.
    const soon = minutes >= market.openMin - PRE_OPEN_MIN
    return { open: false, phase: 'pre', label: soon ? 'Pre-open' : 'Closed', clock }
  }
  if (minutes >= market.closeMin) return { open: false, phase: 'post', label: 'Closed', clock }
  return { open: true, phase: 'open', label: 'Open', clock }
}

/* --------------------------------------------------------------------------
   Invented instruments. Read the header before adding to these lists.
   -------------------------------------------------------------------------- */
const DATA = {
  IN: {
    holdings: [
      { sym: 'ZENTRA', name: 'Zentra Industries', sector: 'Heavy Fabrication', base: 1284.5, qty: 40, avg: 1198.2 },
      { sym: 'ORVIX', name: 'Orvix Materials', sector: 'Specialty Polymers', base: 642.15, qty: 75, avg: 674.4 },
      { sym: 'KALPAN', name: 'Kalpan Motors', sector: 'Mobility Assembly', base: 2170.0, qty: 12, avg: 1902.65 },
      { sym: 'VYNTRA', name: 'Vyntra Systems', sector: 'Edge Compute', base: 388.9, qty: 150, avg: 351.05 },
      { sym: 'AURVIN', name: 'Aurvin Power', sector: 'Grid & Storage', base: 96.35, qty: 500, avg: 88.7 },
      { sym: 'TRIVAL', name: 'Trivalya Foods', sector: 'Ag-Processing', base: 1547.75, qty: 25, avg: 1610.3 },
    ],
    watchlist: [
      { sym: 'SUVIRA', name: 'Suvira Housing Finance', sector: 'Digital Lending', base: 812.4 },
      { sym: 'TESKAR', name: 'Teskar Chemicals', sector: 'Specialty Polymers', base: 1436.85 },
      { sym: 'AMRAVI', name: 'Amravi Biosciences', sector: 'Clinical Robotics', base: 2894.1 },
      { sym: 'DHARVI', name: 'Dharvi Cement', sector: 'Bulk Aggregates', base: 458.6 },
      { sym: 'TARNIK', name: 'Tarnika Logistics', sector: 'Freight Rail Tech', base: 267.35 },
      { sym: 'GRIVAN', name: 'Grivan Telecom', sector: 'Backhaul Networks', base: 1093.75 },
      { sym: 'ESHANA', name: 'Eshana Retail', sector: 'Format Retail', base: 704.2 },
    ],
    sectors: [
      { name: 'Grid & Storage', seed: 'in-grid' },
      { name: 'Edge Compute', seed: 'in-edge' },
      { name: 'Specialty Polymers', seed: 'in-poly' },
      { name: 'Digital Lending', seed: 'in-lend' },
      { name: 'Ag-Processing', seed: 'in-agri' },
      { name: 'Freight Rail Tech', seed: 'in-rail' },
    ],
    research: [
      {
        sym: 'ZENTRA',
        name: 'Zentra Industries',
        sector: 'Heavy Fabrication',
        rating: 'Buy',
        target: 1495,
        horizon: '12m',
        analyst: 'R. Menon',
        date: '04 Sep',
        thesis: 'Order book at 2.4x revenue and the Pune line comes off commissioning this quarter.',
      },
      {
        sym: 'VYNTRA',
        name: 'Vyntra Systems',
        sector: 'Edge Compute',
        rating: 'Buy',
        target: 442,
        horizon: '12m',
        analyst: 'S. Iyer',
        date: '02 Sep',
        thesis: 'Renewal cohort holding above 108% net retention with no discounting in the mid-market.',
      },
      {
        sym: 'AURVIN',
        name: 'Aurvin Power',
        sector: 'Grid & Storage',
        rating: 'Hold',
        target: 101,
        horizon: '12m',
        analyst: 'R. Menon',
        date: '29 Aug',
        thesis: 'Storage tenders are margin-thin; we would wait for the tariff order before adding.',
      },
      {
        sym: 'ORVIX',
        name: 'Orvix Materials',
        sector: 'Specialty Polymers',
        rating: 'Reduce',
        target: 560,
        horizon: '12m',
        analyst: 'P. Kulkarni',
        date: '27 Aug',
        thesis: 'Feedstock pass-through has lagged two quarters running and inventory days keep climbing.',
      },
      {
        sym: 'KALPAN',
        name: 'Kalpan Motors',
        sector: 'Mobility Assembly',
        rating: 'Hold',
        target: 2240,
        horizon: '12m',
        analyst: 'S. Iyer',
        date: '25 Aug',
        thesis: 'Volume beat is real but the mix is skewing to the entry trim, which caps realisation.',
      },
      {
        sym: 'SUVIRA',
        name: 'Suvira Housing Finance',
        sector: 'Digital Lending',
        rating: 'Buy',
        target: 940,
        horizon: '12m',
        analyst: 'A. Sharma',
        date: '22 Aug',
        thesis: 'Cost of funds down 40bps and the affordable book is compounding without stage-2 slippage.',
      },
    ],
    orders: [
      { id: 'IN-40812', sym: 'VYNTRA', side: 'BUY', qty: 50, price: 386.4, type: 'LIMIT', status: 'Executed', at: 'Today 10:14' },
      { id: 'IN-40809', sym: 'AURVIN', side: 'BUY', qty: 200, price: 95.8, type: 'MARKET', status: 'Executed', at: 'Today 09:51' },
      { id: 'IN-40807', sym: 'TRIVAL', side: 'SELL', qty: 10, price: 1562.0, type: 'LIMIT', status: 'Pending', at: 'Today 09:33' },
      { id: 'IN-40788', sym: 'ORVIX', side: 'SELL', qty: 25, price: 655.0, type: 'SL-M', status: 'Cancelled', at: 'Yest 15:02' },
      { id: 'IN-40771', sym: 'ZENTRA', side: 'BUY', qty: 15, price: 1271.35, type: 'LIMIT', status: 'Executed', at: 'Yest 11:47' },
      { id: 'IN-40756', sym: 'KALPAN', side: 'BUY', qty: 4, price: 2088.9, type: 'MARKET', status: 'Executed', at: '05 Sep 13:20' },
    ],
    funds: {
      available: 184320.55,
      margin: 96140.0,
      payin: 250000.0,
      ledger: [
        { at: '08 Sep', note: 'Equity payin', amount: 50000 },
        { at: '05 Sep', note: 'Settlement credit', amount: 18422.4 },
        { at: '04 Sep', note: 'Brokerage & charges', amount: -1284.65 },
        { at: '02 Sep', note: 'Delivery debit', amount: -61050 },
        { at: '29 Aug', note: 'Dividend credit', amount: 3120 },
      ],
    },
  },
  US: {
    holdings: [
      { sym: 'NRVX', name: 'Norvex Robotics', sector: 'Clinical Robotics', base: 214.62, qty: 30, avg: 188.4 },
      { sym: 'CLDQ', name: 'Cloudquay Systems', sector: 'Edge Compute', base: 88.14, qty: 120, avg: 94.2 },
      { sym: 'BRXL', name: 'Braxel Therapeutics', sector: 'Clinical Robotics', base: 41.9, qty: 250, avg: 36.75 },
      { sym: 'HLVR', name: 'Helvara Grid', sector: 'Grid & Storage', base: 63.28, qty: 180, avg: 59.1 },
      { sym: 'ATMR', name: 'Altmere Foods', sector: 'Ag-Processing', base: 127.45, qty: 45, avg: 133.8 },
      { sym: 'QDSL', name: 'Quadrisel Semiconductor', sector: 'Wafer Tooling', base: 306.7, qty: 22, avg: 241.05 },
    ],
    watchlist: [
      { sym: 'FNTRA', name: 'Fintara Holdings', sector: 'Digital Lending', base: 74.36 },
      { sym: 'OKVIA', name: 'Okvia Health', sector: 'Care Networks', base: 152.9 },
      { sym: 'PLRIX', name: 'Polarix Energy', sector: 'Grid & Storage', base: 39.55 },
      { sym: 'SVLTA', name: 'Svelta Retail', sector: 'Format Retail', base: 61.2 },
      { sym: 'KESTR', name: 'Kestro Freightways', sector: 'Freight Rail Tech', base: 118.74 },
      { sym: 'DRAVN', name: 'Dravon Aerostructures', sector: 'Heavy Fabrication', base: 245.18 },
    ],
    sectors: [
      { name: 'Wafer Tooling', seed: 'us-wafer' },
      { name: 'Edge Compute', seed: 'us-edge' },
      { name: 'Clinical Robotics', seed: 'us-clin' },
      { name: 'Grid & Storage', seed: 'us-grid' },
      { name: 'Care Networks', seed: 'us-care' },
      { name: 'Format Retail', seed: 'us-retail' },
    ],
    research: [
      {
        sym: 'QDSL',
        name: 'Quadrisel Semiconductor',
        sector: 'Wafer Tooling',
        rating: 'Buy',
        target: 355,
        horizon: '12m',
        analyst: 'J. Whitmore',
        date: '05 Sep',
        thesis: 'Tool backlog extends through the next two quarters and spares mix keeps gross margin above 52%.',
      },
      {
        sym: 'NRVX',
        name: 'Norvex Robotics',
        sector: 'Clinical Robotics',
        rating: 'Buy',
        target: 248,
        horizon: '12m',
        analyst: 'D. Alvarez',
        date: '03 Sep',
        thesis: 'Placements are slowing but per-console consumables revenue is now the larger half of the model.',
      },
      {
        sym: 'CLDQ',
        name: 'Cloudquay Systems',
        sector: 'Edge Compute',
        rating: 'Hold',
        target: 92,
        horizon: '12m',
        analyst: 'J. Whitmore',
        date: '01 Sep',
        thesis: 'Fair on FY27 numbers; migration revenue is one-off and the subscription base is only mid-teens growth.',
      },
      {
        sym: 'ATMR',
        name: 'Altmere Foods',
        sector: 'Ag-Processing',
        rating: 'Reduce',
        target: 108,
        horizon: '12m',
        analyst: 'M. Reyes',
        date: '28 Aug',
        thesis: 'Private-label share gains are structural and the promo spend needed to hold shelf keeps rising.',
      },
      {
        sym: 'HLVR',
        name: 'Helvara Grid',
        sector: 'Grid & Storage',
        rating: 'Hold',
        target: 66,
        horizon: '12m',
        analyst: 'D. Alvarez',
        date: '26 Aug',
        thesis: 'Rate case outcome is the whole story; interconnect queue relief is already in the price.',
      },
      {
        sym: 'PLRIX',
        name: 'Polarix Energy',
        sector: 'Grid & Storage',
        rating: 'Buy',
        target: 47,
        horizon: '12m',
        analyst: 'M. Reyes',
        date: '21 Aug',
        thesis: 'Contracted capacity covers 80% of FY27 output, so the earnings floor is higher than the beta implies.',
      },
    ],
    orders: [
      { id: 'US-77420', sym: 'QDSL', side: 'BUY', qty: 6, price: 298.4, type: 'LIMIT', status: 'Executed', at: 'Today 09:42' },
      { id: 'US-77418', sym: 'BRXL', side: 'BUY', qty: 100, price: 41.15, type: 'MARKET', status: 'Executed', at: 'Today 09:35' },
      { id: 'US-77415', sym: 'CLDQ', side: 'SELL', qty: 40, price: 91.0, type: 'LIMIT', status: 'Pending', at: 'Today 09:31' },
      { id: 'US-77399', sym: 'ATMR', side: 'SELL', qty: 15, price: 131.5, type: 'STOP', status: 'Cancelled', at: 'Yest 15:58' },
      { id: 'US-77381', sym: 'HLVR', side: 'BUY', qty: 60, price: 61.9, type: 'LIMIT', status: 'Executed', at: 'Yest 11:06' },
      { id: 'US-77364', sym: 'NRVX', side: 'BUY', qty: 10, price: 201.2, type: 'MARKET', status: 'Executed', at: '04 Sep 14:12' },
    ],
    funds: {
      available: 12480.32,
      margin: 6215.0,
      payin: 20000.0,
      ledger: [
        { at: '08 Sep', note: 'Cash transfer in', amount: 4000 },
        { at: '05 Sep', note: 'Trade settlement', amount: 1874.1 },
        { at: '03 Sep', note: 'Commission', amount: -42.5 },
        { at: '02 Sep', note: 'Purchase debit', amount: -5960 },
        { at: '28 Aug', note: 'Dividend credit', amount: 118.4 },
      ],
    },
  },
}

export const dataFor = (id) => DATA[id] ?? DATA.IN

/**
 * A holding / watchlist row with its drifting last-traded price. Deterministic
 * in (symbol, tick): the same tick always renders the same number.
 */
export function quote(row, tick) {
  const pct = swing(`${row.sym}:${tick}`, 2.6)
  return { ...row, pct, price: row.base * (1 + pct / 100), up: pct >= 0 }
}

/** 28 points of pseudo-random walk for an inline sparkline. */
export function sparkPoints(seed, up) {
  let y = 20
  const pts = []
  for (let i = 0; i < 28; i += 1) {
    y += (noise(`${seed}:${i}`) - (up ? 0.42 : 0.58)) * 6
    y = Math.max(3, Math.min(37, y))
    pts.push(`${((i / 27) * 100).toFixed(1)},${y.toFixed(1)}`)
  }
  return pts.join(' ')
}
