import React, { useEffect, useRef, useState } from 'react';
import { highlight } from './highlight';

type Tier = 'trade' | 'transform' | 'profile';

interface Props {
  /**
   * The example source. It is executed as `fn(el, lib)` where `el` is the chart
   * container and `lib` is the merged library namespace. End with `return chart;`
   * so the demo can be torn down cleanly. This exact string is also displayed.
   */
  code: string;
  /** Extra tiers to load alongside the base bundle. */
  tiers?: Tier[];
  /** Chart area height in px. */
  height?: number;
  /** Hide the code panel (chart only). */
  hideCode?: boolean;
  /** Optional caption under the demo. */
  caption?: React.ReactNode;
}

// Merge so the BASE bundle always wins for shared symbols (createChart,
// generateBars, ...). Tier bundles contribute their specialty exports
// (runTransform, OrderEngine, computeVolumeProfile, ...).
async function loadLib(tiers: Tier[]): Promise<Record<string, unknown>> {
  const base = await import('../lib/oac/openalgo-charts.mjs');
  const merged: Record<string, unknown> = {};
  if (tiers.includes('transform')) Object.assign(merged, await import('../lib/oac/openalgo-charts.transform.mjs'));
  if (tiers.includes('trade')) Object.assign(merged, await import('../lib/oac/openalgo-charts.trade.mjs'));
  if (tiers.includes('profile')) Object.assign(merged, await import('../lib/oac/openalgo-charts.profile.mjs'));
  Object.assign(merged, base);
  return merged;
}

export default function RunnableExample({ code, tiers = [], height = 360, hideCode = false, caption }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let chart: { destroy?: () => void } | undefined;
    let cancelled = false;
    (async () => {
      try {
        const lib = await loadLib(tiers);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = '';
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('el', 'lib', code) as (el: HTMLElement, lib: unknown) => { destroy?: () => void };
        chart = fn(ref.current, lib);
        setReady(true);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      try { chart?.destroy?.(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, tiers.join(',')]);

  return (
    <div className="oac-example">
      {!hideCode && (
        <pre className="oac-example__code" aria-label="example source">
          <code dangerouslySetInnerHTML={{ __html: highlight(code) }} />
        </pre>
      )}
      <div className="oac-example__stage">
        <span className="oac-example__badge">live</span>
        <div className="oac-example__chart" ref={ref} style={{ height }} />
        {!ready && !err && <div className="oac-example__loading">Rendering live chart…</div>}
        {err && <div className="oac-example__err">Demo error: {err}</div>}
      </div>
      {caption && <div className="oac-example__caption">{caption}</div>}
    </div>
  );
}
