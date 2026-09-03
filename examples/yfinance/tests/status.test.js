import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initStatus, exchangeOf, nameOf, descriptionOf, venueLive, marketStatusReading,
  previousSessionClose, dayChangeReading,
} from '../src/status.js';
import { UP, DOWN } from '../src/ui.js';
import { flatBar } from './helpers.js';

// Wednesday 3 January 2024, 10:00 in Kolkata: NSE is trading, New York is
// asleep (23:30 the previous evening).
const KOLKATA_MORNING = Date.UTC(2024, 0, 3, 4, 30);
// Saturday 6 January 2024, midday UTC: every venue with hours is shut.
const SATURDAY = Date.UTC(2024, 0, 6, 12);

describe('symbol classification', () => {
  it('reads the venue off the yfinance suffix', () => {
    expect(exchangeOf('RELIANCE.NS')).toBe('NSE');
    expect(exchangeOf('^NSEI')).toBe('NSE');
    expect(exchangeOf('tcs.bo')).toBe('BSE');
    expect(exchangeOf('BTC-USD')).toBe('CRYPTO');
    expect(exchangeOf('^GSPC')).toBe('US');
    expect(exchangeOf('^FTSE')).toBe('INDEX');
    expect(exchangeOf('aapl')).toBe('US');
  });

  it('strips the suffix for the legend name', () => {
    expect(nameOf('reliance.ns')).toBe('RELIANCE');
    expect(nameOf('AAPL')).toBe('AAPL');
  });

  it('has a long name only for the symbols in its table', () => {
    expect(descriptionOf('aapl')).toBe('Apple Inc.');
    expect(descriptionOf('ZZZZ')).toBeNull();
  });
});

describe('session hours', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('says which venues are trading right now, in their own zone', () => {
    vi.useFakeTimers({ now: KOLKATA_MORNING });
    expect(venueLive('RELIANCE.NS')).toBe(true);
    expect(venueLive('AAPL')).toBe(false);
    expect(venueLive('BTC-USD')).toBe(true);
    // No hours in the table means "could be live", so the feed keeps asking.
    expect(venueLive('^FTSE')).toBe(true);
  });

  it('is shut everywhere with hours on a weekend', () => {
    vi.useFakeTimers({ now: SATURDAY });
    expect(venueLive('RELIANCE.NS')).toBe(false);
    expect(venueLive('AAPL')).toBe(false);
    expect(venueLive('BTC-USD')).toBe(true);
  });
});

describe('status-line readings', () => {
  let app;
  beforeEach(() => {
    app = { req: {}, currentBars: [], chartTimezone: 'Asia/Kolkata' };
    initStatus(app);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reports the market state, or nothing for a venue without hours', () => {
    vi.useFakeTimers({ now: KOLKATA_MORNING });
    app.req = { symbol: 'RELIANCE.NS' };
    expect(marketStatusReading()).toEqual({ text: 'Market open', color: UP });
    app.req = { symbol: 'AAPL' };
    expect(marketStatusReading()).toEqual({ text: 'Market closed' });
    app.req = { symbol: 'BTC-USD' };
    expect(marketStatusReading()).toEqual({ text: 'Open 24x7', color: UP });
    app.req = { symbol: '^FTSE' };
    expect(marketStatusReading()).toBeUndefined();
  });

  it('finds the close of the previous session in the chart zone', () => {
    // Two Kolkata sessions of hourly bars: 2 and 3 January 2024.
    const day1 = Date.UTC(2024, 0, 2, 4) / 1000;
    const day2 = Date.UTC(2024, 0, 3, 4) / 1000;
    app.currentBars = [flatBar(day1, 100), flatBar(day1 + 3600, 101), flatBar(day2, 102), flatBar(day2 + 3600, 103)];
    expect(previousSessionClose()).toBe(101);
    expect(dayChangeReading()).toEqual({ label: '1D', text: '+2.00 (+1.98%)', color: UP });
  });

  it('colours a fall and has no reading for a single session', () => {
    const day1 = Date.UTC(2024, 0, 2, 4) / 1000;
    const day2 = Date.UTC(2024, 0, 3, 4) / 1000;
    app.currentBars = [flatBar(day1, 100), flatBar(day2, 95)];
    expect(dayChangeReading()).toEqual({ label: '1D', text: '-5.00 (-5.00%)', color: DOWN });

    app.currentBars = [flatBar(day2, 102), flatBar(day2 + 3600, 103)];
    expect(previousSessionClose()).toBeNull();
    expect(dayChangeReading()).toBeUndefined();
  });

  it('memoises on the bar array and the zone, not on their contents', () => {
    const day1 = Date.UTC(2024, 0, 2, 4) / 1000;
    const day2 = Date.UTC(2024, 0, 3, 4) / 1000;
    const bars = [flatBar(day1, 100), flatBar(day2, 102)];
    app.currentBars = bars;
    expect(previousSessionClose()).toBe(100);
    bars[0].close = 50;                       // same array: the memo still answers
    expect(previousSessionClose()).toBe(100);
    app.currentBars = bars.slice();           // a new array is a new answer
    expect(previousSessionClose()).toBe(50);
  });
});
