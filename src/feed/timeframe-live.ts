import type { Bar } from '../model/bar';
import type { BarsRequest, BarSubscriptionOptions, DataFeed, LiveBarMeta } from './types';
import { aggregateTimeframeBars } from './timeframe-bars';
import { timeframeBucketAt, type TimeframePlan } from './timeframe-plan';
import { withHistoryDeadline } from './request-pool';

/** Active-bucket contributions only; late corrections wait for the next authoritative refresh. */
export function subscribeTimeframe(
  feed: DataFeed, req: BarsRequest, plan: TimeframePlan,
  onBar: (bar: Bar, meta?: LiveBarMeta) => void,
  options: BarSubscriptionOptions, now: number,
): () => void {
  const controller = new AbortController(), contributions = new Map<number, Bar>();
  let active = timeframeBucketAt(plan, now), ready = false, closed = false, loading = active !== null;
  const provisional = new Set<number>();
  const pending = new Map<number, Bar>();
  const emit = (): void => {
    const bars = aggregateTimeframeBars(Array.from(contributions.values()), plan), bar = bars[bars.length - 1];
    if (bar) onBar(bar, { provisional: !ready || provisional.size > 0 });
  };
  const accept = (bar: Bar, meta?: LiveBarMeta): void => {
    if (closed) return;
    const bounds = plan.source.bounds(bar.time);
    const bucket = bounds && timeframeBucketAt(plan, bounds.from);
    // A frame outside every session or before the active bucket is dropped, as
    // the native stream drops a bar older than its tail. A quiet contract's
    // quotes repeat the time of its last trade, and asking history again for
    // each one refetched and resubscribed on every frame.
    if (!bucket || (active && bucket.time < active.time)) return;
    if (!active || bucket.time > active.time) {
      active = bucket;
      loading = false;
      contributions.clear();
      provisional.clear();
      pending.clear();
      ready = bounds!.from === bucket.from;
    }
    contributions.set(bar.time, { ...bar });
    if (meta?.provisional) provisional.add(bar.time);
    else provisional.delete(bar.time);
    if (contributions.size > 100_000) { contributions.clear(); ready = false; options.onResync?.(); return; }
    emit();
  };
  const off = feed.subscribeBars!({ ...req, interval: plan.source.interval, signal: controller.signal }, (bar, meta) => {
    if (closed) return;
    accept(bar, meta);
    if (loading) pending.set(bar.time, bar);
  }, { onResync: () => { ready = false; loading = false; pending.clear(); options.onResync?.(); } });
  if (active) {
    const initial = active;
    void withHistoryDeadline({ ...req, signal: controller.signal }, signal => feed.getBars({ ...req, interval: plan.source.interval, from: initial.from, to: initial.to, noCache: true, signal })).then(bars => {
      loading = false;
      if (closed || active?.time !== initial.time) return;
      contributions.clear();
      for (const bar of [...bars, ...pending.values()]) {
        const source = plan.source.bounds(bar.time);
        if (source && source.from >= initial.from && source.to <= initial.to) contributions.set(bar.time, bar);
      }
      pending.clear();
      ready = true;
      emit();
    }).catch(() => { loading = false; if (!closed) { pending.clear(); options.onResync?.(); } });
  }
  return () => { if (closed) return; closed = true; controller.abort(); off(); contributions.clear(); pending.clear(); };
}
