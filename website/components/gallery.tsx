import React, { useEffect, useRef, useState } from 'react';

/* eslint-disable @typescript-eslint/no-explicit-any */

const LOGO_SRC = '/openalgo-charts/openalgo-logo.svg';

async function loadLib(): Promise<any> {
  return import('../lib/oac/openalgo-charts.all.mjs');
}

/** Deterministic random-walk bars (line/area read `close`; O/H/L mirror it). */
function walk(seed: number, n: number, startTime: number, intervalSec: number, start = 100, vol = 1): any[] {
  let s = seed >>> 0;
  let p = start;
  const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    p = Math.max(1, p + (rnd() - 0.5) * 2 * vol);
    const v = Math.round(p * 100) / 100;
    out.push({ time: startTime + i * intervalSec, open: v, high: v, low: v, close: v, volume: Math.round(1000 + rnd() * 9000) });
  }
  return out;
}

interface Tab { label: string; key: string; }
type BuildFn = (el: HTMLElement, lib: any, tab: string) => any;

function InteractiveChart({ title, tabs, build, height = 320 }: { title: string; tabs?: Tab[]; build: BuildFn; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState(tabs?.[0]?.key ?? '');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let chart: any;
    let cancelled = false;
    (async () => {
      try {
        const lib = await loadLib();
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = '';
        chart = build(ref.current, lib, tab);
        if (chart?.addPrimitive && lib.LogoWatermark) {
          chart.addPrimitive(new lib.LogoWatermark({ src: LOGO_SRC, height: 22, opacity: 0.75, position: 'bottom-left' }));
        }
      } catch (e: any) {
        setErr(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; try { chart?.destroy?.(); } catch { /* ignore */ } };
  }, [tab, build]);

  return (
    <div className="oac-card">
      <h3>{title}</h3>
      {tabs && (
        <div className="oac-tabs">
          {tabs.map((t) => (
            <button key={t.key} className={t.key === tab ? 'oac-tab oac-tab--on' : 'oac-tab'} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      )}
      <div className="oac-card__chart" ref={ref} style={{ height }} />
      {err && <div className="oac-example__err" style={{ position: 'static', padding: '8px 0' }}>Demo error: {err}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Range switcher                                                             */
const RANGES: Record<string, { n: number; iv: number }> = {
  '1D': { n: 78, iv: 300 }, '1W': { n: 120, iv: 3600 }, '1M': { n: 160, iv: 14400 }, '1Y': { n: 300, iv: 86400 },
};
const buildRange: BuildFn = (el, lib, tab) => {
  const chart = lib.createChart(el);
  const cfg = RANGES[tab] ?? RANGES['1D'];
  const bars = walk(7, cfg.n, 1700000000, cfg.iv, 26, 0.12);
  chart.addSeries('area', { style: { color: '#4f8cff', lineWidth: 2, areaTopColor: 'rgba(79,140,255,0.45)', areaBottomColor: 'rgba(79,140,255,0)' } }).setData(bars);
  chart.timeScale.fitContent(bars.length);
  return chart;
};
export const RangeSwitcherCard = () => (
  <InteractiveChart title="Range switcher" build={buildRange}
    tabs={[{ label: '1D', key: '1D' }, { label: '1W', key: '1W' }, { label: '1M', key: '1M' }, { label: '1Y', key: '1Y' }]} />
);

/* -------------------------------------------------------------------------- */
/* Legend                                                                     */
const buildLegend: BuildFn = (el, lib, tab) => {
  const chart = lib.createChart(el);
  const bars = walk(11, 170, 1700000000, 86400, 80, 1.1);
  chart.addSeries('area', { style: { color: '#22c1a4', lineWidth: 2, areaTopColor: 'rgba(34,193,164,0.4)', areaBottomColor: 'rgba(34,193,164,0)' } }).setData(bars);
  el.style.position = 'relative';
  const legend = document.createElement('div');
  legend.className = 'oac-legend';
  el.appendChild(legend);
  const fmt = (t: number): string => { const d = new Date(t * 1000); return d.getUTCFullYear() + ' - ' + (d.getUTCMonth() + 1) + ' - ' + d.getUTCDate(); };
  const render = (b: any): void => {
    if (!b) { legend.innerHTML = ''; return; }
    if (tab === '3') {
      legend.innerHTML = '<div class="oac-legend__title">AEROSPACE</div><div class="oac-legend__big">' + b.close.toFixed(2) + '</div><div class="oac-legend__sub">' + fmt(b.time) + '</div>';
    } else {
      legend.innerHTML = '<span class="oac-legend__title">AEROSPACE</span> &nbsp; <span class="oac-legend__big" style="font-size:1.1rem">' + b.close.toFixed(2) + '</span>';
    }
  };
  render(bars[bars.length - 1]);
  chart.subscribeCrosshairMove((e: any) => render(e.bar ?? bars[bars.length - 1]));
  chart.timeScale.fitContent(bars.length);
  return chart;
};
export const LegendCard = () => (
  <InteractiveChart title="Legend" build={buildLegend}
    tabs={[{ label: '1-line legend', key: '1' }, { label: '3-line legend', key: '3' }]} />
);

/* -------------------------------------------------------------------------- */
/* Series compare                                                             */
const COMPARE_COLORS = ['#4f8cff', '#ec407a', '#26a69a', '#f5a623', '#ab47bc'];
const buildCompare: BuildFn = (el, lib, tab) => {
  const n = parseInt(tab, 10) || 2;
  const chart = lib.createChart(el);
  el.style.position = 'relative';
  const legend = document.createElement('div');
  legend.className = 'oac-legend oac-legend--multi';
  el.appendChild(legend);
  let html = '';
  for (let i = 0; i < n; i++) {
    const bars = walk(3 + i * 29, 120, 1700000000, 86400, 25 + i * 12, 1.6);
    chart.addSeries('line', { style: { color: COMPARE_COLORS[i], lineWidth: 2 } }).setData(bars);
    html += '<div><span class="oac-dot" style="background:' + COMPARE_COLORS[i] + '"></span>Series ' + (i + 1) + ' <b>' + bars[bars.length - 1].close.toFixed(2) + '</b></div>';
  }
  legend.innerHTML = html;
  chart.timeScale.fitContent(120);
  return chart;
};
export const SeriesCompareCard = () => (
  <InteractiveChart title="Series compare" build={buildCompare}
    tabs={[{ label: '1 series', key: '1' }, { label: '2 series', key: '2' }, { label: '3 series', key: '3' }, { label: '4 series', key: '4' }, { label: '5 series', key: '5' }]} />
);

/* -------------------------------------------------------------------------- */
/* Indicators & markers                                                       */
const buildIndicators: BuildFn = (el, lib, tab) => {
  const chart = lib.createChart(el);
  const bars = lib.generateBars(1700000000, 140, 86400);
  const price = chart.addSeries('candlestick');
  price.setData(bars);
  if (tab === 'volume') {
    chart.addSeries('histogram', { paneIndex: 1, style: { color: '#3b5168' } })
      .setData(bars.map((b: any) => ({ time: b.time, value: b.volume, close: b.volume })));
  } else if (tab === 'markers') {
    const m = price.createMarkers();
    m.setMarkers([
      { time: bars[34].time, position: 'belowBar', shape: 'arrowUp', size: 'medium', color: '#26a69a', text: 'BUY' },
      { time: bars[96].time, position: 'aboveBar', shape: 'arrowDown', size: 'medium', color: '#ef5350', text: 'SELL' },
    ]);
  } else {
    chart.addSeries('line', { style: { color: '#f5a623', lineWidth: 2 } }).setData(lib.emaSeries(bars, 21));
  }
  chart.timeScale.fitContent(bars.length);
  return chart;
};
export const IndicatorsCard = () => (
  <InteractiveChart title="Indicators & markers" build={buildIndicators}
    tabs={[{ label: 'Volume', key: 'volume' }, { label: 'Series markers', key: 'markers' }, { label: 'Moving average', key: 'ma' }]} />
);
