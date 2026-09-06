import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import type { MarketDepth } from '../../src/feed/types';
import type { LadderRow } from '../../src/trade/dom-ladder';

const TICK_SIZE = 0.05;
const UPDATE_MS = 750;

function makeDepth(frame: number, levels: number): MarketDepth {
  const centreTick = 2000 + Math.round(Math.sin(frame / 8) * 3);
  const side = (direction: number) => Array.from({ length: levels }, (_, index) => ({
    price: ((centreTick + direction * (index + 1)) * 5) / 100,
    qty: 20 + ((index * 37 + frame * 19 + (direction > 0 ? 43 : 0)) % 180)
      + (index % 11 === 0 ? 240 : 0),
  }));
  return { bids: side(-1), asks: side(1), ltp: (centreTick * 5) / 100 };
}

interface DemoRuntime {
  render: (depth: MarketDepth, frame: number, groupBy: number) => LadderRow[];
  destroy: () => void;
}

/** A simulated book using the same DomLadder and buildRows APIs as an application. */
export default function DepthLadderDemo() {
  const chartElement = useRef<HTMLDivElement>(null);
  const bookElement = useRef<HTMLDivElement>(null);
  const runtime = useRef<DemoRuntime | null>(null);
  const [frame, setFrame] = useState(0);
  const [levels, setLevels] = useState(20);
  const [groupBy, setGroupBy] = useState(1);
  const [running, setRunning] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<LadderRow[]>([]);
  const [selection, setSelection] = useState('Select a bid or ask quantity in the table to inspect a display price.');
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== 'light';
  const depth = useMemo(() => makeDepth(frame, levels), [frame, levels]);
  const latest = useRef({ depth, frame, groupBy });
  latest.current = { depth, frame, groupBy };

  useEffect(() => {
    let cancelled = false;
    let instance: DemoRuntime | null = null;
    setReady(false);
    setError(null);
    (async () => {
      try {
        const [lib, trade] = await Promise.all([
          import('../lib/oac/openalgo-charts.mjs'),
          import('../lib/oac/openalgo-charts.trade.mjs'),
        ]);
        if (cancelled || !chartElement.current) return;
        const chart = lib.createChart(chartElement.current, {
          theme: dark ? lib.darkTheme : lib.lightTheme,
          priceAxisWidth: 60,
          timeAxisHeight: 26,
        });
        // Keep cleanup available even if setup fails after allocating the chart.
        instance = { render: () => [], destroy: () => chart.destroy() };
        const series = chart.addSeries('line', {
          priceFormat: { type: 'price', minMove: TICK_SIZE },
          style: { color: dark ? '#7dafff' : '#2f6df6', lineWidth: 2 },
        });
        const history = Array.from({ length: 80 }, (_, index) => ({
          time: 1700000000 + index,
          value: 100 + Math.sin(index / 9) * 0.14,
        }));
        series.setData(history);
        chart.fitContent();
        chart.timeScale.setRightOffset(128 / chart.timeScale.barSpacing);
        let currentGroup = latest.current.groupBy;
        const createLadder = () => new trade.DomLadder({
          tickSize: TICK_SIZE, groupBy: currentGroup, width: 112, maxRows: 24, rowHeight: 16,
        });
        let ladder = createLadder();
        chart.addPrimitive(ladder);
        instance.render = (book, sequence, nextGroup) => {
          if (nextGroup !== currentGroup) {
            // Options are constructor-only in 2.1.0; replace the attached primitive.
            chart.removePrimitive(ladder);
            currentGroup = nextGroup;
            ladder = createLadder();
            chart.addPrimitive(ladder);
          }
          series.update({ time: 1700000080 + sequence, value: book.ltp });
          const points = series.getData();
          if (points.length > 240) series.setData(points.slice(-160));
          // Match the displayed price span to the row step so quantities stay legible.
          const step = TICK_SIZE * currentGroup;
          const centre = Math.round(book.ltp / step) * step;
          const radius = step * 10;
          const scale = series.priceScale();
          scale.setAutoScale(false);
          scale.setPriceRange({ min: centre - radius, max: centre + radius });
          ladder.setDepth(book);
          return trade.buildRows(book, TICK_SIZE, currentGroup);
        };
        runtime.current = instance;
        const current = latest.current;
        setRows(instance.render(current.depth, current.frame, current.groupBy));
        setReady(true);
      } catch (cause) {
        instance?.destroy();
        instance = null;
        runtime.current = null;
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
      if (runtime.current === instance) runtime.current = null;
      instance?.destroy();
    };
  }, [dark]);

  useEffect(() => {
    if (!ready || !running) return;
    const timer = window.setInterval(() => setFrame(value => value + 1), UPDATE_MS);
    return () => window.clearInterval(timer);
  }, [ready, running]);

  useEffect(() => {
    if (runtime.current) setRows(runtime.current.render(depth, frame, groupBy));
  }, [depth, frame, groupBy]);

  // Centre the scrollable table when its row structure changes; retain the user's
  // scroll position while quantities refresh.
  useEffect(() => {
    const element = bookElement.current;
    if (element) element.scrollTop = Math.max(0, (element.scrollHeight - element.clientHeight) / 2);
  }, [rows.length]);

  function inspect(side: 'bid' | 'ask', price: number) {
    setSelection(`${side === 'bid' ? 'Bid' : 'Ask'} at ${price.toFixed(2)} · simulation only; no order sent.`);
  }

  const maxQty = Math.max(1, ...rows.map(row => Math.max(row.bidQty, row.askQty)));
  const totalBid = depth.bids.reduce((sum, level) => sum + level.qty, 0);
  const totalAsk = depth.asks.reduce((sum, level) => sum + level.qty, 0);
  const qty = (value: number) => value.toLocaleString('en-US');

  return (
    <section className="depth-demo" role="region" aria-label="Simulated depth of market">
      <div className="depth-toolbar">
        <div className="depth-title">
          <strong>Depth of market</strong>
          <span className="depth-status">Simulated · {running ? 'updating' : 'paused'}</span>
        </div>
        <div className="depth-controls">
          <label>Depth levels per side
            <select value={levels} onChange={event => setLevels(Number(event.target.value))} disabled={!ready}>
              <option value={5}>5 levels</option>
              <option value={20}>20 levels</option>
              <option value={200}>200 levels</option>
            </select>
          </label>
          <label>Display row size
            <select value={(TICK_SIZE * groupBy).toFixed(2)} onChange={event => setGroupBy(Math.round(Number(event.target.value) / TICK_SIZE))} disabled={!ready}>
              <option value="0.05">0.05 · 1 tick</option>
              <option value="0.25">0.25 · 5 ticks</option>
              <option value="0.50">0.50 · 10 ticks</option>
              <option value="1.00">1.00 · 20 ticks</option>
            </select>
          </label>
          <button className="depth-pause" type="button" disabled={!ready} onClick={() => setRunning(value => !value)}>
            {running ? 'Pause updates' : 'Resume updates'}
          </button>
        </div>
      </div>
      <div className="depth-quotes">
        <span>Best bid <strong className="depth-bid">{depth.bids[0].price.toFixed(2)}</strong></span>
        <span>Best ask <strong className="depth-ask">{depth.asks[0].price.toFixed(2)}</strong></span>
        <span>Source tick <strong>0.05</strong></span>
        <span>Snapshot <strong aria-label="Snapshot number">{frame}</strong></span>
      </div>
      <div className="depth-panels">
        <div className="depth-chart-panel">
          <div className="depth-panel-label">Simulated price · bid / ask ladder at right</div>
          <div className="depth-chart" ref={chartElement} role="img" aria-label="Simulated price chart with price-aligned depth quantities" />
          {!ready && !error && <p className="depth-loading">Loading depth chart…</p>}
          {error && <p className="depth-error" role="alert">Demo error: {error}</p>}
        </div>
        <div className="depth-book-panel">
          <div className="depth-panel-label">{rows.length} display rows · scroll to explore</div>
          <div className="depth-book" ref={bookElement} tabIndex={0} aria-label="Scrollable depth rows">
            <table aria-label="Aggregated depth quantities">
              <thead><tr><th scope="col">Bid qty</th><th scope="col">Price</th><th scope="col">Ask qty</th></tr></thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.price}>
                    <td className="depth-bid" style={{ background: `linear-gradient(to left, ${dark ? '#26a69a30' : '#26a69a22'} ${(row.bidQty / maxQty) * 100}%, transparent 0)` }}>
                      {row.bidQty ? <button type="button" aria-label={`Inspect bid at ${row.price.toFixed(2)}`} onClick={() => inspect('bid', row.price)}>{qty(row.bidQty)}</button> : '—'}
                    </td>
                    <th scope="row">{row.price.toFixed(2)}</th>
                    <td className="depth-ask" style={{ background: `linear-gradient(to right, ${dark ? '#ef535030' : '#ef535022'} ${(row.askQty / maxQty) * 100}%, transparent 0)` }}>
                      {row.askQty ? <button type="button" aria-label={`Inspect ask at ${row.price.toFixed(2)}`} onClick={() => inspect('ask', row.price)}>{qty(row.askQty)}</button> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="depth-footer">
        <span>Supplied book totals: <strong className="depth-bid">{qty(totalBid)} bid</strong> · <strong className="depth-ask">{qty(totalAsk)} ask</strong></span>
        <span>Updates every 750 ms. All prices and quantities are simulated.</span>
        <span>Row prices are rounded display buckets. Grouping can place both sides in one row.</span>
        <p role="status" aria-live="polite">{selection}</p>
      </div>
      <style jsx>{`
        .depth-demo { margin: 1.5rem 0; min-width: 0; border: 1px solid var(--oac-card-border); border-radius: 12px; background: var(--oac-card); overflow: hidden; font-size: 13px; }
        .depth-toolbar { padding: 16px; border-bottom: 1px solid var(--oac-card-border); }
        .depth-title { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 14px; }
        .depth-title strong { font-size: 16px; }
        .depth-status { color: var(--oac-muted); font-size: 12px; }
        .depth-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
        .depth-controls label { display: grid; gap: 5px; font-size: 12px; color: var(--oac-muted); }
        .depth-controls select, .depth-pause { min-height: 36px; border: 1px solid var(--oac-card-border); border-radius: 6px; padding: 6px 10px; color: inherit; background: var(--oac-card); font-size: 13px; }
        .depth-pause { color: var(--oac-accent); cursor: pointer; }
        button:disabled, select:disabled { opacity: .5; cursor: wait; }
        button:focus-visible, select:focus-visible, .depth-book:focus-visible { outline: 2px solid var(--oac-accent); outline-offset: -2px; }
        .depth-quotes { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 10px 16px; border-bottom: 1px solid var(--oac-card-border); font-size: 12px; font-variant-numeric: tabular-nums; }
        .depth-quotes span { white-space: nowrap; }
        .depth-quotes strong { margin-left: 4px; }
        .depth-panels { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 36%); }
        .depth-chart-panel { position: relative; min-width: 0; }
        .depth-panel-label { height: 38px; padding: 10px 12px; color: var(--oac-muted); font-size: 11px; border-bottom: 1px solid var(--oac-card-border); }
        .depth-chart { height: 380px; width: 100%; }
        .depth-loading, .depth-error { position: absolute; top: 45%; left: 16px; right: 16px; text-align: center; }
        .depth-error { color: #ef5350; }
        .depth-book-panel { border-left: 1px solid var(--oac-card-border); min-width: 0; }
        .depth-book { height: 380px; overflow: auto; overscroll-behavior: contain; }
        .depth-book table { display: table; width: 100%; margin: 0; border-collapse: separate; border-spacing: 0; font-size: 12px; font-variant-numeric: tabular-nums; }
        .depth-book th, .depth-book td { width: 33.333%; height: 27px; text-align: center; padding: 0 3px; border: 0; border-bottom: 1px solid var(--oac-card-border); white-space: nowrap; }
        .depth-book thead th { position: sticky; top: 0; z-index: 1; height: 30px; background: var(--oac-card); color: var(--oac-muted); font-size: 11px; }
        .depth-book tbody th { font-weight: 500; }
        .depth-book tr { background: transparent; }
        .depth-book button { width: 100%; min-height: 26px; font: inherit; color: inherit; cursor: pointer; border-radius: 3px; }
        .depth-book button:hover { background: color-mix(in srgb, var(--oac-accent) 12%, transparent); }
        .depth-bid { color: ${dark ? '#66d8bb' : '#08765c'}; }
        .depth-ask { color: ${dark ? '#ff9b9b' : '#bc3339'}; }
        .depth-footer { display: grid; gap: 5px; padding: 12px 16px; border-top: 1px solid var(--oac-card-border); color: var(--oac-muted); font-size: 11px; }
        .depth-footer p { margin: 4px 0 0; }
        @media (max-width: 760px) {
          .depth-panels { grid-template-columns: minmax(0, 1fr); }
          .depth-book-panel { border-left: 0; border-top: 1px solid var(--oac-card-border); }
          .depth-book { height: 300px; }
          .depth-chart { height: 320px; }
          .depth-controls { gap: 10px; }
          .depth-quotes { gap: 8px 14px; }
        }
      `}</style>
    </section>
  );
}
