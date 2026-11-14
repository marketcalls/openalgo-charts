import { IndicatorInputError } from 'openalgo-charts';
import type { IndicatorAttachContext, IndicatorCalcContext, IndicatorDescriptor, IndicatorSettings, IndicatorStore } from 'openalgo-charts';
import { createRequestedIndicator } from './requested-indicator';

type Select = (settings: Readonly<IndicatorSettings>, context?: IndicatorCalcContext) => string | null;

/**
 * A timeframe the chart's own bars cannot be folded to, though requested
 * history of it could be drawn: refused by the local fold alone.
 */
export class UnfoldableTimeframe extends IndicatorInputError {}

/** Share the requested lifecycle while retaining the original descriptor's rendering hooks. */
export function createTimeframeHistory(
  original: IndicatorDescriptor, folded: IndicatorDescriptor,
  historyBars: (settings: Readonly<IndicatorSettings>) => number | null, select: Select,
): IndicatorDescriptor {
  const contexts = new WeakMap<IndicatorStore, IndicatorAttachContext>();
  const reported = new WeakSet<IndicatorStore>();
  const deferred = new WeakSet<IndicatorStore>();
  const capable = (ctx: IndicatorAttachContext): boolean => {
    const state = ctx.requestState?.();
    return state?.supportsWarmup === true && state.supportsSnapshots === true;
  };
  const selected = (ctx: IndicatorAttachContext): boolean => {
    if (!capable(ctx) || historyBars(ctx.settings()) === null) return false;
    const interval = ctx.dataContext?.()?.interval;
    try { return select(ctx.settings(), { interval, barState: { isNew: false, isConfirmed: true, isRealtime: false, lastIndex: 0 } } as IndicatorCalcContext) !== null; }
    catch { return true; }
  };
  const requested = createRequestedIndicator({
    ...original,
    refreshOnSourceUpdate: false,
    request: ctx => {
      if (!ctx.requestState?.supportsWarmup || !ctx.requestState.supportsSnapshots) return null;
      const warmupBars = historyBars(ctx.settings), interval = ctx.dataContext?.interval;
      const timeframe = select(ctx.settings, { interval, barState: { isNew: false, isConfirmed: true, isRealtime: false, lastIndex: ctx.bars.length - 1 } } as IndicatorCalcContext);
      if (warmupBars === null || !timeframe || !ctx.dataContext?.symbol || !ctx.bars.length || Number(ctx.settings.offset ?? 0) < 0) return null;
      return { symbol: ctx.dataContext.symbol, interval: timeframe,
        ...(ctx.dataContext.exchange === undefined ? {} : { exchange: ctx.dataContext.exchange }),
        from: ctx.bars[0]!.time, to: ctx.bars[ctx.bars.length - 1]!.time + 1, warmupBars };
    },
    expression: (bars, settings, ctx) => {
      const { resolveSource: _unused, ...calculation } = ctx.calculation ?? {};
      const context = ctx.calculation ? { ...calculation, interval: String(settings.timeframe),
        barState: { ...ctx.calculation.barState, lastIndex: bars.length - 1 } } as IndicatorCalcContext : undefined;
      return original.calc(bars, settings, {}, context);
    },
  });
  const independent = (store: IndicatorStore, settings: Readonly<IndicatorSettings>, context?: IndicatorCalcContext): boolean => {
    const attached = contexts.get(store);
    return attached !== undefined && capable(attached) && historyBars(settings) !== null && select(settings, context) !== null;
  };
  const result: IndicatorDescriptor = { ...folded,
    calc: (bars, settings, store, context) => {
      if (independent(store, settings, context)) return requested.calc(bars, settings, store, context);
      try { return folded.calc(bars, settings, store, context); }
      catch (error) {
        // A chart calculates once before it attaches, when nothing yet says
        // whether its host can request the timeframe. Draw nothing until then.
        if (!(error instanceof UnfoldableTimeframe) || contexts.has(store)) throw error;
        deferred.add(store);
        return requested.calc(bars, settings, store, context);
      }
    },
    attach: ctx => {
      contexts.set(ctx.store, ctx);
      const cleanup = requested.attach!({ ...ctx,
        setDataStatus: status => {
          if (selected(ctx)) { reported.add(ctx.store); ctx.setDataStatus?.(status); }
          else if (reported.delete(ctx.store)) ctx.setDataStatus?.({ state: 'ready' });
        },
        setDataRetry: retry => { if (selected(ctx) || retry === null) ctx.setDataRetry?.(retry); },
      });
      // A host that cannot request it is left with the local fold, whose refusal now reports.
      if (deferred.delete(ctx.store) && !selected(ctx)) ctx.requestRecompute();
      return () => { if (contexts.get(ctx.store) === ctx) contexts.delete(ctx.store); if (typeof cleanup === 'function') cleanup(); };
    },
  };
  Object.defineProperty(result, 'calcTail', { enumerable: false, configurable: true, writable: true,
    value: (...args: Parameters<NonNullable<IndicatorDescriptor['calcTail']>>) => independent(args[4], args[1], args[5])
      ? null : folded.calcTail?.(...args) ?? null });
  return result;
}
