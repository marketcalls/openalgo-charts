import { fmt, UP, DOWN } from './ui.js';

let app;
export function initStatus(a) { app = a; }

// The venue a yfinance symbol trades on. It answers three questions at once:
// what the status line prints after the interval, what the ticker title mode
// prefixes the name with, and which session table says whether the market is
// open. A plain ticker is the US tape, which is yfinance's own default
// namespace; an index yfinance carries that is not one of the four below is
// 'INDEX', a venue this demo has no session hours for.
export function exchangeOf(sym) {
  const s = String(sym).toUpperCase();
  if (s.endsWith('.NS') || s === '^NSEI' || s === '^NSEBANK') return 'NSE';
  if (s.endsWith('.BO') || s === '^BSESN') return 'BSE';
  if (s.endsWith('-USD')) return 'CRYPTO';
  if (s === '^GSPC' || s === '^DJI' || s === '^IXIC' || s === '^RUT' || s === '^VIX') return 'US';
  if (s.startsWith('^')) return 'INDEX';
  return 'US';
}
export const nameOf = (sym) => sym.toUpperCase().replace(/\.(NS|BO)$/, '');

// ── status-line data ───────────────────────────────────────────────────
// The legend draws the row; these four fields are the ones it has no way to
// derive, so the Readout tab's switches for them are live only because the
// host feeds them. Anything the demo genuinely cannot supply is left absent
// here and its control is drawn disabled (see chartSettingUnavailable).

/**
 * Long names for the instruments this demo points at. `/api/history` returns
 * bars and nothing else, so a description is either in this table or the
 * demo does not have one: the "Description" title mode is disabled for a
 * symbol that is not here rather than silently drawing the ticker instead.
 */
export const LONG_NAMES = {
  AAPL: 'Apple Inc.', MSFT: 'Microsoft Corporation', GOOGL: 'Alphabet Inc.',
  AMZN: 'Amazon.com, Inc.', META: 'Meta Platforms, Inc.', TSLA: 'Tesla, Inc.',
  NVDA: 'NVIDIA Corporation', NFLX: 'Netflix, Inc.', AMD: 'Advanced Micro Devices, Inc.',
  'RELIANCE.NS': 'Reliance Industries Limited',
  'TCS.NS': 'Tata Consultancy Services Limited',
  'INFY.NS': 'Infosys Limited', 'HDFCBANK.NS': 'HDFC Bank Limited',
  'ICICIBANK.NS': 'ICICI Bank Limited', 'SBIN.NS': 'State Bank of India',
  'TATAMOTORS.NS': 'Tata Motors Limited', 'ITC.NS': 'ITC Limited',
  '^NSEI': 'NIFTY 50', '^NSEBANK': 'NIFTY Bank', '^BSESN': 'S&P BSE SENSEX',
  '^GSPC': 'S&P 500', '^DJI': 'Dow Jones Industrial Average', '^IXIC': 'NASDAQ Composite',
  'BTC-USD': 'Bitcoin / US Dollar', 'ETH-USD': 'Ethereum / US Dollar',
};
export const descriptionOf = (sym) => LONG_NAMES[String(sym).toUpperCase()] || null;

/**
 * Regular hours per venue, as an IANA zone and a local window in minutes
 * from midnight. Never a fixed UTC offset: New York is four hours off UTC
 * for part of the year and five for the rest, and a constant would be
 * silently wrong for half of it. `null` means the venue never closes; a
 * venue absent from the table has no hours here and says so.
 */
export const SESSIONS = {
  NSE: { zone: 'Asia/Kolkata', open: 9 * 60 + 15, close: 15 * 60 + 30 },
  BSE: { zone: 'Asia/Kolkata', open: 9 * 60 + 15, close: 15 * 60 + 30 },
  US: { zone: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
  CRYPTO: null,
};
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday and minute-of-day for an instant, in an IANA zone. */
const zoneParts = (() => {
  const fmts = new Map();
  return (ms, zone) => {
    let f = fmts.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      fmts.set(zone, f);
    }
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    // hour12:false gives 24 for midnight in some engines, hence the modulo.
    return { day: WEEKDAY[p.weekday], minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  };
})();

/**
 * Whether the venue is trading right now. Regular hours only: there is no
 * holiday calendar behind this, so it says "market closed" on Republic Day
 * for the same reason it does on a Sunday.
 */
export function marketStatusReading() {
  const venue = exchangeOf(app.req.symbol || '');
  if (!(venue in SESSIONS)) return undefined;    // no hours for this venue
  if (SESSIONS[venue] === null) return { text: 'Open 24x7', color: UP };
  return venueLive(app.req.symbol) ? { text: 'Market open', color: UP } : { text: 'Market closed' };
}

/**
 * Can this venue still be producing bars right now? The same table and the
 * same missing holiday calendar as the status line above, so it says "live"
 * on Republic Day for the same reason it does not say "closed" on one. Read
 * by `barsRequest` to decide how far ahead it is worth asking for data.
 */
export function venueLive(symbol) {
  const s = SESSIONS[exchangeOf(symbol)];
  if (s === undefined || s === null) return true;   // unknown hours, or 24x7
  const { day, minutes } = zoneParts(Date.now(), s.zone);
  return day >= 1 && day <= 5 && minutes >= s.open && minutes < s.close;
}

/** A bar's local calendar day, for spotting a session boundary. */
const dayKey = (() => {
  const fmts = new Map();
  return (timeSec, zone) => {
    let f = fmts.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
      fmts.set(zone, f);
    }
    return f.format(new Date(timeSec * 1000));
  };
})();

/**
 * Close of the session before the last bar's, in the chart's own zone. Null
 * when the loaded range holds a single session, which is the case the
 * "change since previous close" switch is disabled for: there is no previous
 * close, and drawing a zero would be an invention.
 *
 * Memoised on the bar array and the zone, because the status line asks for
 * it on every frame and a five-day one-minute chart is a few hundred
 * `Intl.format` calls per answer.
 */
let prevCloseMemo = { bars: null, zone: null, value: null };
export function previousSessionClose() {
  if (prevCloseMemo.bars === app.currentBars && prevCloseMemo.zone === app.chartTimezone) return prevCloseMemo.value;
  let value = null;
  if (app.currentBars.length >= 2) {
    const last = dayKey(app.currentBars[app.currentBars.length - 1].time, app.chartTimezone);
    for (let i = app.currentBars.length - 2; i >= 0; i--) {
      if (dayKey(app.currentBars[i].time, app.chartTimezone) !== last) { value = app.currentBars[i].close; break; }
    }
  }
  prevCloseMemo = { bars: app.currentBars, zone: app.chartTimezone, value };
  return value;
}

export function dayChangeReading() {
  const prev = previousSessionClose();
  if (prev == null || !app.currentBars.length) return undefined;
  const d = app.currentBars[app.currentBars.length - 1].close - prev;
  const sign = d >= 0 ? '+' : '';
  const pct = prev ? (d / prev) * 100 : 0;
  return { label: '1D', text: `${sign}${fmt(d)} (${sign}${pct.toFixed(2)}%)`, color: d >= 0 ? UP : DOWN };
}

/**
 * A monogram tile for the symbol. The demo has no brand artwork and the feed
 * returns none, so the mark is drawn from the ticker: one letter over a hue
 * derived from the name, which is a real per-symbol mark rather than one
 * placeholder repeated for every instrument.
 */
const logoCache = new Map();
export function symbolLogo(sym) {
  const name = nameOf(sym || '').replace(/^\^/, '');
  if (!name) return undefined;
  const hit = logoCache.get(name);
  if (hit) return hit;
  const side = 36;      // drawn at 3x the 12px the legend paints it at
  const c = document.createElement('canvas');
  c.width = side; c.height = side;
  const g = c.getContext('2d');
  let hue = 0;
  for (let i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
  const r = 8;
  g.fillStyle = `hsl(${hue} 40% 34%)`;
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(side, 0, side, side, r); g.arcTo(side, side, 0, side, r);
  g.arcTo(0, side, 0, 0, r); g.arcTo(0, 0, side, 0, r);
  g.closePath(); g.fill();
  g.fillStyle = '#eef1f7';
  g.font = '700 22px ui-sans-serif, system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name[0], side / 2, side / 2 + 1);
  logoCache.set(name, c);
  return c;
}

/**
 * Handed to the legend as a getter, not a snapshot: the session state is a
 * time of day, so it has to be right on the frame it is drawn rather than on
 * the frame the demo last patched options.
 */
export function symbolStatus() {
  const sym = app.req.symbol || '';
  if (!sym) return null;
  return {
    logo: symbolLogo(sym),
    description: descriptionOf(sym) || undefined,
    ticker: exchangeOf(sym) + ':' + nameOf(sym),
    marketStatus: marketStatusReading(),
    lastDayChange: dayChangeReading(),
  };
}
