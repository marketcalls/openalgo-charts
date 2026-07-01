import React from 'react';
import Link from 'next/link';
import RunnableExample from './RunnableExample';

const HERO_DEMO = `// A candlestick chart with a 21-EMA overlay - rendered by the real library.
const chart = lib.createChart(el);
const bars = lib.generateBars(1700000000, 180, 3600);

chart.addSeries('candlestick').setData(bars);
chart.addSeries('line', { style: { color: '#f5a623', lineWidth: 2 } })
     .setData(lib.emaSeries(bars, 21));

// OpenAlgo brand watermark (drawn on the canvas, captured in screenshots).
chart.addPrimitive(new lib.LogoWatermark({ src: '/openalgo-charts/openalgo-logo.svg', height: 30, opacity: 0.9 }));

chart.timeScale.fitContent(bars.length);
return chart;`;

const STATS: Array<[string, string]> = [
  ['0', 'runtime dependencies'],
  ['< 30 KB', 'Brotli, full package'],
  ['25+', 'chart types'],
  ['225', 'tests, green'],
];

export function Hero() {
  return (
    <section className="oac-hero">
      <div className="oac-hero__grid">
        <div className="oac-hero__copy">
          <span className="oac-pill">Open source - Apache-2.0 - Zero dependencies</span>
          <h1 className="oac-hero__title">
            The charting engine built for <span className="oac-grad">OpenAlgo</span>.
          </h1>
          <p className="oac-hero__sub">
            A from-scratch, dependency-free HTML5-canvas charting library: candlesticks to
            Renko, indicators, depth-of-market, and full on-chart trading - fast, tiny, and
            yours to extend. No black box, no licensing strings.
          </p>
          <div className="oac-hero__cta">
            <Link className="oac-btn oac-btn--primary" href="/docs/getting-started">Get started</Link>
            <a className="oac-btn" href="https://github.com/marketcalls/openalgo-charts" target="_blank" rel="noreferrer">Star on GitHub</a>
            <Link className="oac-btn oac-btn--ghost" href="/examples">See live examples</Link>
          </div>
          <div className="oac-stats">
            {STATS.map(([n, l]) => (
              <div className="oac-stat" key={l}>
                <div className="oac-stat__n">{n}</div>
                <div className="oac-stat__l">{l}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="oac-hero__demo">
          <RunnableExample code={HERO_DEMO} hideCode height={340} />
        </div>
      </div>
    </section>
  );
}

interface Feature {
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  { title: 'Single-canvas pipeline', body: 'No SVG, no DOM-per-bar. One canvas per pane with an invalidation-aware render loop keeps it small and smooth at scale.' },
  { title: 'Gapless time axis', body: 'Weekends, holidays, and session breaks collapse automatically - x is a logical index, not a raw timestamp.' },
  { title: '25+ chart types', body: 'Candles, bars, line, area, baseline, columns, Heikin Ashi, Renko, Range, Line Break, Point & Figure, Kagi.' },
  { title: 'Tick & second timeframes', body: 'Sub-minute and tick/volume bars are first-class: build them live from a tick stream with the candle and tick aggregators.' },
  { title: 'On-chart trading', body: 'Order, position, and bracket lines with live P&L, one-click and drag-to-modify, OCO, validation, and a depth-of-market ladder.' },
  { title: 'Indicators & profiles', body: 'EMA, RSI, ATR, Supertrend (matching openalgo.ta), plus Volume Profile, Market Profile (TPO), and Footprint / order flow.' },
  { title: 'OpenAlgo-native data', body: 'REST history + WebSocket live + candle builder adapters speak the OpenAlgo protocol. Any broker fits behind a small DataFeed.' },
  { title: 'Loadable tiers', body: 'Ship only what you use - base, /trade, /transform, /profile are separate entry points, each independently sized.' },
  { title: 'Plugin / primitive API', body: 'The same API markers, trading, and profiles are built on is open to you: implement IPrimitive and draw anything on the chart.' },
];

export function Features() {
  return (
    <section className="oac-section">
      <h2 className="oac-section__title">Everything a trading chart needs, nothing it doesn&rsquo;t</h2>
      <div className="oac-features">
        {FEATURES.map((f) => (
          <div className="oac-feature" key={f.title}>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function WhyOpenSource() {
  return (
    <section className="oac-section oac-why">
      <h2 className="oac-section__title">Why contributors love it</h2>
      <div className="oac-why__grid">
        <div>
          <h3>Readable, original code</h3>
          <p>No reverse-engineering a minified vendor blob. The engine is a few thousand lines of clean, commented TypeScript with a documented architecture.</p>
        </div>
        <div>
          <h3>Add a doc in one line</h3>
          <p>This site is Nextra + MDX. Drop a <code>.mdx</code> file in <code>website/pages/docs</code>, add one line to <code>_meta.json</code>, and your page (with live demos) is in the sidebar.</p>
        </div>
        <div>
          <h3>Truly dependency-free</h3>
          <p>Nothing is excluded from the size budget - what you import is what ships. Easy to audit, easy to embed, friendly to every bundler.</p>
        </div>
        <div>
          <h3>Apache-2.0, forever</h3>
          <p>Permissive license, no attribution gymnastics, no &ldquo;non-commercial&rdquo; asterisks. Build products on it.</p>
        </div>
      </div>
      <div className="oac-hero__cta" style={{ marginTop: 28 }}>
        <Link className="oac-btn oac-btn--primary" href="/docs/getting-started">Read the docs</Link>
        <a className="oac-btn" href="https://github.com/marketcalls/openalgo-charts" target="_blank" rel="noreferrer">Contribute on GitHub</a>
      </div>
    </section>
  );
}
